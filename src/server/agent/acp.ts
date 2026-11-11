import { type ChildProcess, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { basename, dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import type {
	ActiveSession,
	ClientConnection,
	ContentBlock,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionUpdate,
} from "@agentclientprotocol/sdk";
import spawn from "cross-spawn";
import type {
	AgentCheck,
	AgentConfig,
	AgentIdentity,
	AgentStop,
} from "../../shared/agent.js";
import { inheritedEnv } from "../git.js";
import { BUILD } from "../version.js";

type Sdk = typeof import("@agentclientprotocol/sdk");
let sdk: Promise<Sdk> | undefined;
/**
 * The ACP SDK, loaded on first use (an agent started or checked): it costs
 * ~140 ms of CPU, which every crb serve start would pay (CAR-105).
 */
const loadSdk = (): Promise<Sdk> => {
	sdk ??= import("@agentclientprotocol/sdk");
	return sdk;
};

/** How long spawn + initialize + session/new may take. */
export const AGENT_START_MS = 60_000;
/** How long close() waits after SIGTERM before SIGKILL. */
const KILL_AFTER_MS = 5_000;
/** How long close() waits for session/close before signalling. */
const SESSION_CLOSE_MS = 1_000;
/** The stderr tail an error carries. */
const STDERR_TAIL = 2048;
/** A failed turn's reason, as stored on its reply and shown in the status. */
export const MAX_TURN_ERROR = 300;

const WINDOWS = process.platform === "win32";

/**
 * Names never passed to the agent: secrets of the server's environment
 * (GH_TOKEN, GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, ANTHROPIC_API_KEY, …).
 * The agent's harness uses its own login, which lives under HOME.
 */
export const SECRET_ENV = /TOKEN|SECRET|PASSWORD|KEY$/i;

/**
 * The agent's environment: the server's (without the GIT_* variables that
 * redirect git, inheritedEnv) minus secrets, HOME and PATH as they are, and
 * the config's `env` on top.
 */
export function agentEnv(
	extra: Record<string, string>,
): Record<string, string> {
	// Windows names are case-insensitive: the config's PATH replaces Path,
	// never sits beside it for the child to pick one of.
	const fold = (key: string) => (WINDOWS ? key.toUpperCase() : key);
	const replaced = new Set(Object.keys(extra).map(fold));
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(inheritedEnv())) {
		if (value === undefined || replaced.has(fold(key))) continue;
		if (SECRET_ENV.test(key) && key !== "HOME" && key !== "PATH") continue;
		env[key] = value;
	}
	return { ...env, ...extra };
}

export class AgentStartError extends Error {
	constructor(
		message: string,
		readonly reason: "not-found" | "exited" | "protocol" | "timeout",
		readonly stderr: string,
	) {
		super(message);
	}
}

export interface AcpSpawn {
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
	stderrFile: string;
	onUpdate(update: SessionUpdate): void;
	onPermission(req: RequestPermissionRequest): RequestPermissionResponse;
	onExit(code: number | null, signal: string | null): void;
	/** Stops a start under way (the session closing): killed, AgentStartError "exited". */
	signal?: AbortSignal;
}

/** Live agents' process groups: killed when crb exits. */
const live = new Set<ChildProcess>();
let killOnExit = false;
function track(child: ChildProcess): void {
	live.add(child);
	child.on("close", () => live.delete(child));
	if (!killOnExit) {
		killOnExit = true;
		process.on("exit", () => {
			for (const c of live) signalGroup(c, "SIGKILL");
		});
	}
}

/** Signals the child's process group (its own tools too), else the child. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (WINDOWS) {
		// No process groups or signals: the tree goes at once, else killing
		// a .cmd shim's cmd.exe would orphan the agent under it.
		if (child.pid === undefined || child.exitCode !== null) return;
		const kill = spawnSync(
			"taskkill",
			["/pid", String(child.pid), "/t", "/f"],
			{ stdio: "ignore", windowsHide: true },
		);
		if (kill.error) child.kill(signal);
		return;
	}
	try {
		if (child.pid === undefined) throw new Error("not started");
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

const STOPS: readonly string[] = [
	"end_turn",
	"max_tokens",
	"max_turn_requests",
	"refusal",
	"cancelled",
] satisfies AgentStop[];

/**
 * A command the spawn takes as given (no shell, but on Windows cross-spawn
 * runs a .cmd/.bat shim through cmd.exe with its args escaped): a non-empty
 * string without NUL.
 */
function checkCommand(command: string, args: string[]): void {
	if (!command || command.includes("\0") || args.some((a) => a.includes("\0")))
		throw new AgentStartError(
			"The agent command is empty or invalid",
			"not-found",
			"",
		);
}

interface Started {
	methods: Sdk["methods"];
	child: ChildProcess;
	conn: ClientConnection;
	info: AgentIdentity;
	exited: Promise<{ code: number | null; signal: string | null }>;
	stderr: () => string;
}

/**
 * Spawns `opts.command` in its own process group and runs `initialize`; an
 * AgentStartError when it isn't found, exits, answers wrongly or takes
 * longer than `timeoutMs` (then it is killed).
 */
async function start(
	opts: Omit<AcpSpawn, "stderrFile" | "onExit"> & { stderrFile?: string },
	timeoutMs: number,
	then: (s: Started) => Promise<void>,
): Promise<Started> {
	checkCommand(opts.command, opts.args);
	const { client, methods, ndJsonStream } = await loadSdk();
	// Stopped (the session closing, crb exiting) while the SDK loaded: no
	// process to start, and none to kill.
	if (opts.signal?.aborted)
		throw new AgentStartError("Stopped while starting", "exited", "");
	let file: WriteStream | null = null;
	if (opts.stderrFile) {
		mkdirSync(dirname(opts.stderrFile), { recursive: true });
		const stream = createWriteStream(opts.stderrFile, { flags: "a" });
		// A log that can't be written is dropped, never the server.
		stream.on("error", () => {
			if (file === stream) file = null;
		});
		file = stream;
	}
	let tail = "";
	const stderr = () => tail;
	const child = spawn(opts.command, opts.args, {
		cwd: opts.cwd,
		env: opts.env,
		stdio: ["pipe", "pipe", "pipe"],
		// On Windows `detached` means a console window of its own, not a group.
		detached: !WINDOWS,
		windowsHide: true,
	});
	track(child);
	child.stderr?.on("data", (chunk: Buffer) => {
		file?.write(chunk);
		tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL);
	});
	child.stdin?.on("error", () => {});
	const exited = new Promise<{ code: number | null; signal: string | null }>(
		(resolve) => {
			child.on("close", (code, signal) => {
				file?.end();
				resolve({ code, signal });
			});
		},
	);
	const failed = new Promise<never>((_, reject) => {
		child.on("error", (error: NodeJS.ErrnoException) => {
			file?.end();
			reject(
				error.code === "ENOENT"
					? new AgentStartError(
							`${opts.command} was not found on PATH`,
							"not-found",
							"",
						)
					: new AgentStartError(error.message, "exited", stderr()),
			);
		});
		void exited.then(({ code, signal }) =>
			reject(
				new AgentStartError(
					`${opts.command} exited ${signal ? `on ${signal}` : `with code ${code}`} while starting`,
					"exited",
					stderr(),
				),
			),
		);
	});
	failed.catch(() => {});
	let timer: NodeJS.Timeout | undefined;
	const stopped = new Promise<never>((_, reject) => {
		const stop = () =>
			reject(new AgentStartError("Stopped while starting", "exited", stderr()));
		if (opts.signal?.aborted) stop();
		else opts.signal?.addEventListener("abort", stop, { once: true });
	});
	stopped.catch(() => {});
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new AgentStartError(
						`${opts.command} did not start within ${Math.round(timeoutMs / 1000)} s`,
						"timeout",
						stderr(),
					),
				),
			timeoutMs,
		);
	});
	timeout.catch(() => {});
	const app = client({ name: "carbonless" }).onRequest(
		methods.client.session.requestPermission,
		(cx) => opts.onPermission(cx.params),
	);
	const stdin = child.stdin;
	const stdout = child.stdout;
	if (!stdin || !stdout) throw new Error("agent stdio missing");
	const conn = app.connect(
		ndJsonStream(
			Writable.toWeb(stdin) as WritableStream<Uint8Array>,
			Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
		),
	);
	try {
		const handshake = (async () => {
			const init = await conn.agent
				.request(methods.agent.initialize, {
					protocolVersion: 1,
					clientInfo: { name: "carbonless", version: BUILD.version },
					clientCapabilities: {
						fs: { readTextFile: false, writeTextFile: false },
						terminal: false,
					},
				})
				.catch((error: unknown) => afterBreak(conn, error, stderr));
			// A nameless agent goes by its command's name (a stored reply
			// must name its agent).
			const named = init.agentInfo?.name;
			const info: AgentIdentity = {
				name:
					typeof named === "string" && named.trim()
						? named
						: basename(opts.command) || opts.command,
				version: String(init.agentInfo?.version ?? ""),
			};
			const started: Started = {
				methods,
				child,
				conn,
				info,
				exited,
				stderr,
			};
			await then(started);
			return started;
		})();
		return await Promise.race([handshake, failed, timeout, stopped]);
	} catch (error) {
		conn.close();
		signalGroup(child, "SIGKILL");
		// Gone (reaped) before the caller goes on.
		await Promise.race([exited, wait(KILL_AFTER_MS)]);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * A failed request: a protocol error, unless the connection broke (the
 * process exiting): then never settles, so the exit (or the timeout) says
 * what happened, with the stderr it left.
 */
function afterBreak(
	conn: ClientConnection,
	error: unknown,
	stderr: () => string,
): Promise<never> {
	if (conn.signal.aborted) return new Promise<never>(() => {});
	return Promise.reject(protocolError(error, stderr));
}

function protocolError(error: unknown, stderr: () => string): AgentStartError {
	const message = error instanceof Error ? error.message : String(error);
	return new AgentStartError(
		`The agent answered with an error: ${message}`,
		"protocol",
		stderr(),
	);
}

/**
 * The reviewer's agent over ACP (stdio JSON-RPC): one process, one session.
 * See docs/superpowers/specs/2026-11-04-review-buddy-design.md ("The runner").
 */
export class AcpAgent {
	#closing: Promise<void> | null = null;

	private constructor(
		private readonly started: Started,
		private readonly session: ActiveSession,
		private readonly onUpdate: (update: SessionUpdate) => void,
	) {}

	/**
	 * Spawns the agent (PATH lookup), `initialize` and `session/new` with
	 * `cwd`; AgentStartError on failure ("not-found", "exited" with the
	 * stderr tail, "protocol", "timeout" after AGENT_START_MS).
	 */
	static async spawn(
		opts: AcpSpawn,
		timeoutMs = AGENT_START_MS,
	): Promise<AcpAgent> {
		let session: ActiveSession | null = null;
		const started = await start(opts, timeoutMs, async (s) => {
			session = await s.conn.agent
				.buildSession({ cwd: opts.cwd, mcpServers: [] })
				.start()
				.catch((error: unknown) => afterBreak(s.conn, error, s.stderr));
		});
		if (!session) throw new Error("no session");
		const agent = new AcpAgent(started, session, opts.onUpdate);
		void started.exited.then(({ code, signal }) => {
			started.conn.close(new Error("The agent exited"));
			opts.onExit(code, signal);
		});
		return agent;
	}

	/** From initialize's agentInfo, else the command's name. */
	get info(): AgentIdentity {
		return this.started.info;
	}

	/** Whether its process runs and the connection holds. */
	get alive(): boolean {
		const { child, conn } = this.started;
		return (
			!conn.signal.aborted &&
			child.exitCode === null &&
			child.signalCode === null
		);
	}

	/** The last 2 KiB the agent wrote to stderr. */
	stderrTail(): string {
		return this.started.stderr();
	}

	/**
	 * One turn: the agent_message_chunk text until the stop; every update
	 * goes to onUpdate. A broken connection or an exit mid-turn resolves
	 * with stop "error" and the text so far: it never rejects. A turn the
	 * agent fails (rate limit, overload, expired login) also carries its
	 * reason (`error`, one line, at most MAX_TURN_ERROR characters).
	 */
	async prompt(
		blocks: ContentBlock[],
	): Promise<{ text: string; stop: AgentStop; error?: string }> {
		let text = "";
		try {
			void this.session.prompt(blocks).catch(() => {});
			for (;;) {
				const m = await this.session.nextUpdate();
				if (m.kind === "stop") {
					const stop = STOPS.includes(m.stopReason)
						? (m.stopReason as AgentStop)
						: "error";
					return { text, stop };
				}
				const u = m.update;
				if (
					u.sessionUpdate === "agent_message_chunk" &&
					u.content.type === "text"
				) {
					text += u.content.text;
				}
				try {
					this.onUpdate(u);
				} catch {
					// The listener's trouble is not the turn's.
				}
			}
		} catch (error) {
			// The connection broke (an exit): the exit says why.
			if (this.started.conn.signal.aborted) return { text, stop: "error" };
			const reason = turnError(error);
			return reason
				? { text, stop: "error", error: reason }
				: { text, stop: "error" };
		}
	}

	/** Asks the agent to stop the current turn (session/cancel). */
	async cancel(): Promise<void> {
		const { conn, methods } = this.started;
		await conn.agent
			.notify(methods.agent.session.cancel, {
				sessionId: this.session.sessionId,
			})
			.catch(() => {});
	}

	/** session/close (errors ignored), then SIGTERM, then SIGKILL after 5 s. */
	close(): Promise<void> {
		this.#closing ??= (async () => {
			const { child, conn, exited, methods } = this.started;
			const gone = exited.then(() => true);
			if (child.exitCode === null && child.signalCode === null) {
				await Promise.race([
					conn.agent
						.request(methods.agent.session.close, {
							sessionId: this.session.sessionId,
						})
						.catch(() => {}),
					gone,
					wait(SESSION_CLOSE_MS),
				]);
			}
			this.session.dispose();
			conn.close();
			signalGroup(child, "SIGTERM");
			if (!(await Promise.race([gone, wait(KILL_AFTER_MS).then(() => false)])))
				signalGroup(child, "SIGKILL");
			await exited;
		})();
		return this.#closing;
	}
}

/**
 * A JSON-RPC error's message (with its `data.details` or `data.message`)
 * on one line: control characters out, whitespace collapsed, cut at
 * MAX_TURN_ERROR. The agent's text, never trusted: shown as plain text.
 */
export function turnError(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const data = (error as { data?: unknown }).data;
	const extra =
		data && typeof data === "object"
			? [
					(data as Record<string, unknown>).details,
					(data as Record<string, unknown>).message,
				].find((v): v is string => typeof v === "string" && v.trim() !== "")
			: typeof data === "string"
				? data
				: undefined;
	const raw = [error.message, extra].filter(Boolean).join(": ");
	const line = raw
		.replace(/\p{Cc}+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!line) return undefined;
	return line.length > MAX_TURN_ERROR
		? `${line.slice(0, MAX_TURN_ERROR - 1)}…`
		: line;
}

const wait = (ms: number) =>
	new Promise<void>((r) => {
		const t = setTimeout(r, ms);
		t.unref();
	});

/**
 * Runs `cfg`'s command once through `initialize` (the setup modal's Check),
 * then stops it.
 */
export async function checkAgent(
	cfg: AgentConfig,
	cwd: string,
	timeoutMs = AGENT_START_MS,
): Promise<AgentCheck> {
	try {
		mkdirSync(cwd, { recursive: true });
		const s = await start(
			{
				command: cfg.command,
				args: cfg.args,
				env: agentEnv(cfg.env),
				cwd,
				onUpdate: () => {},
				onPermission: () => ({ outcome: { outcome: "cancelled" } }),
			},
			timeoutMs,
			async () => {},
		);
		s.conn.close();
		signalGroup(s.child, "SIGTERM");
		const gone = await Promise.race([
			s.exited.then(() => true),
			wait(KILL_AFTER_MS).then(() => false),
		]);
		if (!gone) signalGroup(s.child, "SIGKILL");
		return { ok: true, agent: s.info };
	} catch (error) {
		if (error instanceof AgentStartError) {
			return { ok: false, error: error.message, stderr: error.stderr };
		}
		return { ok: false, error: (error as Error).message, stderr: "" };
	}
}
