import { spawn } from "node:child_process";
import {
	mkdir,
	open as openFile,
	readFile,
	rename,
	stat,
} from "node:fs/promises";
import { join } from "node:path";
import { parseAsOf } from "./server/asOf.js";
import { withRepoLock } from "./server/clone.js";
import { parsePrArg, resolvePrRef } from "./server/gh.js";
import { stateDir } from "./server/paths.js";
import { parseHead } from "./server/pinnedHead.js";
import {
	accessKey,
	readLiveServerState,
	type ServerState,
} from "./server/serverState.js";
import {
	BUILD,
	type BuildInfo,
	mismatchMessage,
	sameBuild,
	VERSION_HEADER,
} from "./server/version.js";

/**
 * `crb <pr>`, the thin client: finds this machine's `crb serve` through
 * server.json (starting one when there's none), asks it for the PR's
 * review and prints the review's URL, the only line on stdout.
 */

/** Why the client gave up: printed as `crb: <message>`, exit 1. */
export class ClientError extends Error {}

export interface ClientRequest {
	pr: string;
	cwd: string;
	head?: string;
	asOf?: string;
	viewer?: string;
	/** Open the review in the browser (`--open`). */
	open?: boolean;
}

/** A started `crb serve`: when it exits, if it does. */
export interface SpawnedServer {
	exited: Promise<number | null>;
}

export interface ClientDeps {
	out?: (line: string) => void;
	openUrl?: (url: string) => Promise<unknown>;
	/** Starts `crb serve` in the background (default: detached, logging to serve.log). */
	spawnServer?: () => SpawnedServer;
	/** This crb's build (tests pretend to be another). */
	build?: BuildInfo;
	/** How long to wait for a started server (ms). */
	startTimeoutMs?: number;
}

const START_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 3_000;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

const serveLog = () => join(stateDir(), "serve.log");

/** The cookie that carries the key to a server beyond loopback (access.ts). */
async function authHeaders(s: ServerState): Promise<Record<string, string>> {
	if (LOOPBACK.has(s.host)) return {};
	return { cookie: `crb_key_${s.port}=${await accessKey()}` };
}

/**
 * The server server.json names, if it is one: its pid is alive and it
 * answers as crb (a reused pid, or a server that hung, doesn't).
 */
export async function findServer(): Promise<ServerState | null> {
	const s = await readLiveServerState();
	if (!s) return null;
	try {
		const res = await fetch(`${s.url}/api/version`, {
			headers: await authHeaders(s),
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		const body = (await res.json()) as Partial<BuildInfo>;
		return res.ok && typeof body.version === "string" ? s : null;
	} catch {
		return null;
	}
}

/** `crb serve`, detached, its output to serve.log. */
async function spawnDetached(): Promise<SpawnedServer> {
	await mkdir(stateDir(), { recursive: true });
	await trimLog();
	const log = await openFile(serveLog(), "a", 0o600);
	try {
		const script = process.argv[1];
		if (!script) throw new ClientError("Can't tell how crb was started");
		const child = spawn(
			process.execPath,
			[...process.execArgv, script, "serve"],
			// Not the caller's cwd: the server outlives it (a removed worktree).
			{ detached: true, stdio: ["ignore", log.fd, log.fd], cwd: stateDir() },
		);
		const exited = new Promise<number | null>((done) => {
			child.once("exit", (code) => done(code));
			child.once("error", () => done(-1));
		});
		child.unref();
		return { exited };
	} finally {
		await log.close();
	}
}

/** serve.log grows with every start: past 1 MB it moves to serve.log.1. */
const LOG_LIMIT = 1024 * 1024;
export async function trimLog(limit = LOG_LIMIT): Promise<void> {
	const size = await stat(serveLog()).then(
		(s) => s.size,
		() => 0,
	);
	if (size > limit) await rename(serveLog(), `${serveLog()}.1`);
}

async function logTail(): Promise<string> {
	const text = await readFile(serveLog(), "utf8").catch(() => "");
	return text.trim().split("\n").slice(-5).join("\n");
}

/**
 * The running server; none running (no server.json, a dead pid, no crb
 * there) starts one and waits for it. A lock in the state dir makes two
 * clients starting at once end up with one server.
 */
export async function ensureServer(
	deps: ClientDeps = {},
): Promise<ServerState> {
	const running = await findServer();
	if (running) return running;
	const timeoutMs = deps.startTimeoutMs ?? START_TIMEOUT_MS;
	return withRepoLock(
		join(stateDir(), "serve"),
		async () => {
			const again = await findServer();
			if (again) return again;
			const { exited } = deps.spawnServer
				? deps.spawnServer()
				: await spawnDetached();
			let exitCode: number | null | undefined;
			void exited.then((code) => {
				exitCode = code;
			});
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const started = await findServer();
				if (started) return started;
				if (exitCode !== undefined) {
					throw new ClientError(
						`crb serve exited (${exitCode}); ${serveLog()} says:\n${await logTail()}`,
					);
				}
				if (Date.now() > deadline) {
					throw new ClientError(
						`crb serve did not start in ${timeoutMs / 1000} s; see ${serveLog()}`,
					);
				}
				await new Promise((r) => setTimeout(r, 100));
			}
		},
		{ timeoutMs: timeoutMs + 10_000 },
	);
}

/** The request's PR as the server takes it: a URL or owner/repo#n. */
async function prForServer(pr: string, cwd: string): Promise<string> {
	const parsed = parsePrArg(pr);
	if ("owner" in parsed) return pr;
	const ref = await resolvePrRef(pr, cwd);
	return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/** `crb <pr>`: prints the review's URL; ClientError when it can't. */
export async function runClient(
	req: ClientRequest,
	deps: ClientDeps = {},
): Promise<string> {
	// Checked here, so a typo fails before any server starts.
	const head = req.head;
	if (head !== undefined) parseHead(head);
	const asOf = req.asOf === undefined ? undefined : parseAsOf(req.asOf);
	if (head && asOf)
		throw new ClientError("--head can't be combined with --as-of");
	const pr = await prForServer(req.pr, req.cwd);

	const server = await ensureServer(deps);
	const build = deps.build ?? BUILD;
	// Its build, from server.json: a mismatch fails before any request (the
	// request's header is checked by the server too).
	if (!sameBuild(server.version, build)) {
		throw new ClientError(mismatchMessage(server.version, build));
	}
	let res: Response;
	try {
		res = await fetch(`${server.url}/api/reviews`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[VERSION_HEADER]: JSON.stringify(build),
				...(await authHeaders(server)),
			},
			body: JSON.stringify({
				pr,
				...(head !== undefined ? { head } : {}),
				...(asOf !== undefined ? { asOf } : {}),
				...(req.viewer !== undefined ? { viewer: req.viewer } : {}),
			}),
		});
	} catch (error) {
		throw new ClientError(
			`Could not reach crb serve at ${server.url}: ${(error as Error).message}`,
		);
	}
	const body = (await res.json().catch(() => ({}))) as {
		url?: unknown;
		error?: unknown;
	};
	if (!res.ok || typeof body.url !== "string") {
		throw new ClientError(
			typeof body.error === "string"
				? body.error
				: `crb serve answered ${res.status}`,
		);
	}
	const url = body.url;
	(deps.out ?? ((line) => process.stdout.write(`${line}\n`)))(url);
	if (req.open) {
		const openUrl =
			deps.openUrl ?? (async (u: string) => (await import("open")).default(u));
		await openUrl(url).catch((error: unknown) => {
			console.error(`crb: could not open the browser: ${String(error)}`);
		});
	}
	return url;
}
