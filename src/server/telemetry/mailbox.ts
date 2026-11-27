import {
	appendFile,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { setImmediate as yieldNow } from "node:timers/promises";
import { writeFileAtomic } from "../atomicFile.js";
import type { CrbConfig, TelemetryConfig } from "../config.js";
import { runGit, runGitFull } from "../git.js";
import { cacheDir, stateDir } from "../paths.js";
import { isServiceFile } from "../trace.js";
import { collectState, knownSecrets, scrubText } from "./collect.js";

/*
 * The telemetry mailbox (docs/telemetry-mailbox.md, CAR-323): crb pushes
 * its traces, logs and a snapshot of its state to a git remote the
 * reviewer names, on the branch `device/<device>`, with the reviewer's own
 * git credentials. No carbonless server in the middle (principle 4), and
 * nothing to do with the review clones or refs/crb/* (principle 3): the
 * mailbox is its own repo in the state dir.
 *
 * Every push is ONE parentless commit, a full snapshot, force-pushed (with
 * a lease) over the last. The snapshot carries the trace files of the last
 * RETAIN_DAYS (up to RETAIN_BYTES), so the branch holds a rolling window
 * without history: a file pushed once stays in every later snapshot as the
 * same blob (already on the remote: no transfer) until it ages out. What a
 * push adds is capped separately (NEW_BYTES_PER_PUSH): on a backlog the
 * newest go first and older ones follow on later pushes, never a newer one
 * skipped for an older. The state's history rides inside it
 * (state-history.jsonl). Git sends only what changed: the remote's last
 * snapshot is the base of the push's thin pack.
 *
 * Copies are incremental: trace files only grow, so only the bytes added
 * since the last push are read and scrubbed (in chunks, yielding between
 * them), never the whole file again.
 */

const MiB = 1024 * 1024;
/** The most new data one push adds (traces and logs); the rest waits. */
const NEW_BYTES_PER_PUSH = 50 * MiB;
/** Trace files stay in the mailbox this long… */
const RETAIN_DAYS = 7;
/** …while the window's files total at most this (oldest go first). */
const RETAIN_BYTES = 300 * MiB;
/** A log is sent as its last this many bytes. */
const LOG_TAIL_BYTES = 5 * MiB;
/** Read and scrubbed this much at a time, the event loop let go between. */
const CHUNK_BYTES = 4 * MiB;
/** state-history.jsonl keeps this many days. */
const HISTORY_DAYS = 7;
/** A lock older than this is a crashed push's. */
const STALE_LOCK_MS = 30 * 60_000;
const PUSH_TIMEOUT_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 2 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export const telemetryDir = (): string => join(stateDir(), "telemetry");
const repoDir = () => join(telemetryDir(), "mailbox.git");
const outboxDir = () => join(telemetryDir(), "outbox");
const statusFile = () => join(telemetryDir(), "status.json");
const historyFile = () => join(telemetryDir(), "state-history.jsonl");
const manifestFile = () => join(telemetryDir(), "outbox.json");
const lockFile = () => join(telemetryDir(), "push.lock");
/** An empty file and directory: the user's global ignores, attributes and hooks never apply. */
const emptyFile = () => join(telemetryDir(), "empty");
const emptyDir = () => join(telemetryDir(), "no-hooks");

export const deviceBranch = (device: string): string => `device/${device}`;

/** Bytes scrubbed by this process (a test's measure of incremental copies). */
export const scrubbed = { bytes: 0 };

/** What the last push did (status.json). */
export interface MailboxStatus {
	/** When it was tried. */
	at: string;
	ok: boolean;
	/** Why it failed (git's words, secrets removed). */
	error?: string;
	device: string;
	/** The remote, userinfo removed. */
	mailbox: string;
	commit?: string;
	/** What the snapshot holds. */
	bytes?: number;
	files?: number;
	/** What this push added. */
	newBytes?: number;
	/** Trace files not sent yet: over this push's new-data cap (newest went first). */
	tracesWaiting?: number;
	/** Trace files of the window over its total cap (the oldest): not sent. */
	tracesOverCap?: number;
	/**
	 * The device branch had moved since this device's last push (another
	 * crb with the same device name, or a reinstall): taken over.
	 */
	tookOver?: boolean;
	/** The last push that worked. */
	lastOkAt?: string;
	by: "serve" | "cli";
}

export async function readStatus(): Promise<MailboxStatus | null> {
	try {
		return JSON.parse(await readFile(statusFile(), "utf8")) as MailboxStatus;
	} catch {
		return null;
	}
}

/** The remote as shown and stored: no userinfo, no tokens. */
export const shownRemote = (url: string): string => scrubText(url, []);

async function statOf(path: string) {
	return stat(path).then(
		(s) => (s.isFile() ? s : null),
		() => null,
	);
}

/** How much of a source file the outbox copy holds (outbox.json). */
interface Copied {
	/** The source's identity: a new file under the same name starts over. */
	ino: number;
	/** Bytes of the source consumed (whole lines). */
	offset: number;
	/** The source's size and mtime when copied: unchanged means nothing to read. */
	size: number;
	mtimeMs: number;
	/** Where the copy started (a log's tail). */
	from: number;
}

type Manifest = Record<string, Copied>;

/**
 * Appends `src` from `from` to its last whole line onto `dest`, scrubbed,
 * CHUNK_BYTES at a time with the event loop let go between. `skipPartial`:
 * `from` may be mid-line (a tail): the copy starts at the next line.
 * Returns the offset consumed.
 */
async function appendScrubbed(
	src: string,
	dest: string,
	from: number,
	size: number,
	secrets: string[],
	skipPartial: boolean,
): Promise<number> {
	const handle = await open(src, "r");
	let offset = from;
	try {
		let carry = Buffer.alloc(0);
		let pos = from;
		let skipping = skipPartial && from > 0;
		while (pos < size) {
			const want = Math.min(CHUNK_BYTES, size - pos);
			const buf = Buffer.alloc(want);
			const { bytesRead } = await handle.read(buf, 0, want, pos);
			if (bytesRead === 0) break;
			pos += bytesRead;
			let data = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
			let base = pos - data.length;
			if (skipping) {
				const nl = data.indexOf(10);
				if (nl < 0) {
					carry = Buffer.alloc(0);
					offset = pos;
					continue;
				}
				data = data.subarray(nl + 1);
				base += nl + 1;
				offset = base;
				skipping = false;
			}
			const last = data.lastIndexOf(10);
			if (last < 0) {
				carry = data;
				continue;
			}
			const whole = data.subarray(0, last + 1);
			carry = data.subarray(last + 1);
			scrubbed.bytes += whole.length;
			await appendFile(dest, scrubText(whole.toString("utf8"), secrets));
			offset = base + last + 1;
			await yieldNow();
		}
	} finally {
		await handle.close();
	}
	return offset;
}

/**
 * Brings the outbox copy of `src` up to date: only the bytes added since
 * the last copy, or a new copy when the source is another file, shrank, or
 * (a log) the copy would outgrow its tail.
 */
async function syncCopy(
	src: string,
	dest: string,
	st: { ino: number; size: number; mtimeMs: number },
	prev: Copied | undefined,
	secrets: string[],
	tailBytes?: number,
): Promise<Copied> {
	const destSize = (await statOf(dest))?.size;
	const continues =
		prev !== undefined &&
		destSize !== undefined &&
		prev.ino === st.ino &&
		st.size >= prev.offset &&
		(tailBytes === undefined || st.size - prev.from <= tailBytes);
	if (continues && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
		return prev;
	}
	await mkdir(dirname(dest), { recursive: true });
	let from = 0;
	let start = 0;
	if (continues) {
		from = prev.from;
		start = prev.offset;
	} else {
		await writeFile(dest, "");
		from = tailBytes ? Math.max(0, st.size - tailBytes) : 0;
		start = from;
	}
	const offset = await appendScrubbed(
		src,
		dest,
		start,
		st.size,
		secrets,
		!continues && from > 0,
	);
	return { ino: st.ino, offset, size: st.size, mtimeMs: st.mtimeMs, from };
}

/** A source not yet sent in full: what a copy would add. */
const newBytesOf = (
	st: { ino: number; size: number; mtimeMs: number },
	prev: Copied | undefined,
	inOutbox: boolean,
) => {
	if (!prev || !inOutbox || prev.ino !== st.ino || st.size < prev.offset) {
		return st.size;
	}
	return st.size - prev.offset;
};

/** Every file under `dir`, as paths relative to it (forward slashes). */
async function walk(dir: string, base = dir): Promise<string[]> {
	const out: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const e of entries) {
		const path = join(dir, e.name);
		if (e.isDirectory()) out.push(...(await walk(path, base)));
		else out.push(relative(base, path).split(sep).join("/"));
	}
	return out;
}

/** state-history.jsonl: one compact line per push, the last HISTORY_DAYS. */
async function history(state: unknown, now: Date): Promise<string> {
	const s = state as {
		crb?: unknown;
		machine?: { hostname?: string };
		server?: { uptimeSeconds?: number } | null;
		traces?: { bytes?: number } | null;
		clones?: {
			repo: string;
			bytes: number;
			crbRefs: number;
			reviews: number;
		}[];
	};
	const line = JSON.stringify({
		at: now.toISOString(),
		crb: s.crb,
		hostname: s.machine?.hostname ?? null,
		serverUptimeSeconds: s.server?.uptimeSeconds ?? null,
		traceBytes: s.traces?.bytes ?? null,
		clones: (s.clones ?? []).map((c) => ({
			repo: c.repo,
			bytes: c.bytes,
			crbRefs: c.crbRefs,
			reviews: c.reviews,
		})),
	});
	const cutoff = now.getTime() - HISTORY_DAYS * DAY_MS;
	const old = (await readFile(historyFile(), "utf8").catch(() => ""))
		.split("\n")
		.filter((l) => {
			if (!l.trim()) return false;
			try {
				return Date.parse((JSON.parse(l) as { at: string }).at) >= cutoff;
			} catch {
				return false;
			}
		});
	const text = `${[...old, line].join("\n")}\n`;
	await writeFileAtomic(historyFile(), text);
	return text;
}

interface Filled {
	bytes: number;
	files: number;
	newBytes: number;
	tracesWaiting: number;
	tracesOverCap: number;
}

/**
 * Makes outbox/devices/<device>/ the snapshot: the state, the logs' tails,
 * and the window's trace files (new bytes capped), copied incrementally;
 * deletes what's no longer sent (and other devices').
 */
async function fillOutbox(opts: {
	device: string;
	texts: Record<string, string>;
	traceDir: string | null;
	secrets: string[];
	now: number;
	newCap: number;
	signal?: AbortSignal;
}): Promise<Filled> {
	const root = join(outboxDir(), "devices", opts.device);
	const rel = (dest: string) => `devices/${opts.device}/${dest}`;
	const pathOf = (dest: string) => join(root, ...dest.split("/"));
	let manifest: Manifest = {};
	try {
		manifest = JSON.parse(await readFile(manifestFile(), "utf8")) as Manifest;
	} catch {
		// First push, or unreadable: copies start over.
	}
	const next: Manifest = {};
	const keep = new Set<string>();
	let newBytes = 0;

	for (const [dest, text] of Object.entries(opts.texts)) {
		await mkdir(dirname(pathOf(dest)), { recursive: true });
		await writeFile(pathOf(dest), text);
		keep.add(rel(dest));
		newBytes += Buffer.byteLength(text);
	}

	const sync = async (
		dest: string,
		src: string,
		st: { ino: number; size: number; mtimeMs: number },
		tailBytes?: number,
	) => {
		opts.signal?.throwIfAborted();
		try {
			next[rel(dest)] = await syncCopy(
				src,
				pathOf(dest),
				st,
				manifest[rel(dest)],
				opts.secrets,
				tailBytes,
			);
			keep.add(rel(dest));
		} catch (error) {
			if (opts.signal?.aborted) throw error;
			// Gone or locked meanwhile (Windows): the next push has it.
		}
	};

	// Logs first: small, and the freshest account of what happened.
	const logs: [string, string][] = [
		["serve.log", join(stateDir(), "serve.log")],
		["serve.log.1", join(stateDir(), "serve.log.1")],
		["update.log", join(cacheDir(), "update.log")],
	];
	for (const [name, src] of logs) {
		const st = await statOf(src);
		if (!st) continue;
		const dest = `logs/${name}`;
		const prev = manifest[rel(dest)];
		newBytes += Math.min(
			LOG_TAIL_BYTES,
			newBytesOf(st, prev, (await statOf(pathOf(dest))) !== null),
		);
		await sync(dest, src, st, LOG_TAIL_BYTES);
	}

	// Traces: the window's, newest first.
	let tracesWaiting = 0;
	let tracesOverCap = 0;
	if (opts.traceDir) {
		const dir = opts.traceDir;
		const names = await readdir(dir).catch(() => [] as string[]);
		const found: {
			name: string;
			st: { ino: number; size: number; mtimeMs: number };
		}[] = [];
		const cutoff = opts.now - RETAIN_DAYS * DAY_MS;
		for (const name of names) {
			if (!isServiceFile("crb", name)) continue;
			const st = await statOf(join(dir, name));
			if (st && st.mtimeMs >= cutoff) found.push({ name, st });
		}
		found.sort(
			(a, b) => b.st.mtimeMs - a.st.mtimeMs || (a.name < b.name ? 1 : -1),
		);
		let total = 0;
		let traceNew = 0;
		let full = false;
		for (const [i, f] of found.entries()) {
			if (total + f.st.size > RETAIN_BYTES) {
				tracesOverCap = found.length - i;
				break;
			}
			const dest = `traces/${f.name}`;
			const prev = manifest[rel(dest)];
			const inOutbox = (await statOf(pathOf(dest))) !== null;
			const adds = newBytesOf(f.st, prev, inOutbox);
			const fits =
				!full &&
				// The first one always goes: a file over the cap must not
				// hold back every older one forever.
				(traceNew === 0 || newBytes + traceNew + adds <= opts.newCap);
			if (adds > 0 && !fits) {
				full = true;
				if (prev && inOutbox && prev.ino === f.st.ino) {
					// Sent before and grown since: the sent part stays.
					next[rel(dest)] = prev;
					keep.add(rel(dest));
					total += f.st.size;
				} else tracesWaiting++;
				continue;
			}
			await sync(dest, join(dir, f.name), f.st);
			traceNew += adds;
			total += f.st.size;
		}
		newBytes += traceNew;
	}

	let bytes = 0;
	let files = 0;
	for (const r of await walk(outboxDir())) {
		const path = join(outboxDir(), ...r.split("/"));
		if (!keep.has(r)) {
			await rm(path, { force: true });
			continue;
		}
		files++;
		bytes += (await statOf(path))?.size ?? 0;
	}
	await writeFileAtomic(manifestFile(), JSON.stringify(next));
	return { bytes, files, newBytes, tracesWaiting, tracesOverCap };
}

/** Whether an ssh command's program is OpenSSH's (takes `-o BatchMode=yes`). */
const isOpenSsh = (command: string): boolean => {
	const m = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
	const program = m?.[1] ?? m?.[2] ?? m?.[3] ?? "";
	return /^ssh(\.exe)?$/i.test(basename(program.replaceAll("\\", "/")));
};

/**
 * The environment of every mailbox git: the remote (never in argv: it may
 * carry a token, and argv lands in traces and process lists), files kept
 * byte for byte whatever the user's global config (no autocrlf, no global
 * ignores, attributes or hooks), no signing, no ext:: transport.
 *
 * Not `interactive` (crb serve's background pushes): nothing may prompt.
 * No terminal prompt, no askpass program (git's GIT_ASKPASS, core.askPass
 * and SSH_ASKPASS: a path that doesn't exist fails the prompt), no
 * credential manager UI (GCM_INTERACTIVE, credential.interactive), ssh in
 * batch mode (appended to the user's ssh command when it is OpenSSH's; a
 * $GIT_SSH program, or another client, is left as is: its options are its
 * own). `crb telemetry on|send` stays interactive: run in a terminal, it's
 * the reviewer's own action, and a prompt there is how they log in.
 */
export function gitEnv(opts: {
	mailbox: string;
	interactive: boolean;
	/** The user's core.sshCommand, if any. */
	sshCommand?: string;
	env?: NodeJS.ProcessEnv;
}): Record<string, string> {
	const parent = opts.env ?? process.env;
	const config: [string, string][] = [
		["remote.mailbox.url", opts.mailbox],
		// A global remote.mailbox.pushurl must not redirect it.
		["remote.mailbox.pushurl", opts.mailbox],
		["core.autocrlf", "false"],
		["core.safecrlf", "false"],
		["core.fsmonitor", "false"],
		["core.excludesFile", emptyFile()],
		["core.attributesFile", emptyFile()],
		["core.hooksPath", emptyDir()],
		["gc.auto", "0"],
		["commit.gpgSign", "false"],
		["push.gpgSign", "false"],
		["protocol.ext.allow", "never"],
	];
	const env: Record<string, string> = {
		GIT_AUTHOR_NAME: "crb telemetry",
		GIT_AUTHOR_EMAIL: "telemetry@carbonless.invalid",
		GIT_COMMITTER_NAME: "crb telemetry",
		GIT_COMMITTER_EMAIL: "telemetry@carbonless.invalid",
	};
	if (!opts.interactive) {
		const noAskpass = join(telemetryDir(), "no-askpass");
		env.GIT_TERMINAL_PROMPT = "0";
		env.GIT_ASKPASS = noAskpass;
		env.SSH_ASKPASS = noAskpass;
		env.SSH_ASKPASS_REQUIRE = "never";
		env.GCM_INTERACTIVE = "never";
		config.push(["credential.interactive", "false"]);
		if (!parent.GIT_SSH || parent.GIT_SSH_COMMAND) {
			const ssh = parent.GIT_SSH_COMMAND || opts.sshCommand || "ssh";
			if (isOpenSsh(ssh)) env.GIT_SSH_COMMAND = `${ssh} -o BatchMode=yes`;
		}
	}
	env.GIT_CONFIG_COUNT = String(config.length);
	config.forEach(([k, v], i) => {
		env[`GIT_CONFIG_KEY_${i}`] = k;
		env[`GIT_CONFIG_VALUE_${i}`] = v;
	});
	return env;
}

/** git's last lines, secrets removed, short. */
function gitError(stderr: string, secrets: string[]): string {
	const lines = stderr.trim().split("\n").filter(Boolean).slice(-4);
	const text = scrubText(lines.join(" / "), secrets);
	return (text || "git failed").slice(0, 500);
}

/** One push at a time across processes (crb serve and crb telemetry send). */
async function lock(): Promise<(() => Promise<void>) | null> {
	await mkdir(telemetryDir(), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const h = await open(lockFile(), "wx");
			await h.writeFile(`${process.pid}\n`);
			await h.close();
			return () => rm(lockFile(), { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const seen = (await readFile(lockFile(), "utf8").catch(() => "")).trim();
			const st = await statOf(lockFile());
			const pid = Number(seen);
			const dead =
				!st ||
				Date.now() - st.mtimeMs > STALE_LOCK_MS ||
				!(pid > 0 && pidAlive(pid));
			if (!dead) return null;
			// Moved aside, not deleted: of two processes that both found it
			// dead, one moves it; the other finds it gone and retries. A lock
			// moved that isn't the dead one seen (taken meanwhile) goes back.
			const aside = `${lockFile()}.${process.pid}.stale`;
			try {
				await rename(lockFile(), aside);
			} catch {
				continue;
			}
			const moved = (await readFile(aside, "utf8").catch(() => "")).trim();
			if (moved !== seen) {
				await rename(aside, lockFile()).catch(() => {});
				return null;
			}
			await rm(aside, { force: true });
		}
	}
	return null;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface PushOptions {
	telemetry: TelemetryConfig;
	config: CrbConfig;
	/** The trace directory to send from; null: none. */
	traceDir: string | null;
	by: "serve" | "cli";
	now?: Date;
	/** New bytes one push may add (default NEW_BYTES_PER_PUSH; tests). */
	newCap?: number;
	/** Stops the push (crb serve closing): its gits are killed, no status written. */
	signal?: AbortSignal;
}

export type PushResult =
	| { status: MailboxStatus }
	| { busy: true; status?: undefined };

/**
 * Collects the snapshot and pushes it to the mailbox's device branch.
 * Never throws for git or the remote: the outcome is in status.json (and
 * returned). `busy` when another process is pushing.
 */
export async function pushMailbox(opts: PushOptions): Promise<PushResult> {
	const release = await lock();
	if (!release) return { busy: true };
	try {
		const now = opts.now ?? new Date();
		const { device, mailbox } = opts.telemetry;
		const previous = await readStatus();
		const secrets = await knownSecrets();
		const base: MailboxStatus = {
			at: now.toISOString(),
			ok: false,
			device,
			mailbox: shownRemote(mailbox),
			by: opts.by,
			...(previous?.lastOkAt ? { lastOkAt: previous.lastOkAt } : {}),
		};
		let status: MailboxStatus;
		try {
			status = await push(opts, now, secrets, base);
		} catch (error) {
			if (opts.signal?.aborted) throw error;
			status = { ...base, error: gitError((error as Error).message, secrets) };
		}
		// Written while still locked: a push after this one never has its
		// status overwritten by this older one.
		await writeFileAtomic(
			statusFile(),
			`${JSON.stringify(status, null, "\t")}\n`,
		);
		return { status };
	} finally {
		await release();
	}
}

async function push(
	opts: PushOptions,
	now: Date,
	secrets: string[],
	base: MailboxStatus,
): Promise<MailboxStatus> {
	const { device, mailbox } = opts.telemetry;
	const interactive = opts.by === "cli";
	await mkdir(outboxDir(), { recursive: true });
	await mkdir(emptyDir(), { recursive: true });
	await writeFile(emptyFile(), "");
	const sshCommand = interactive
		? undefined
		: (
				await runGit(telemetryDir(), ["config", "--get", "core.sshCommand"], {
					allowFailure: true,
					timeoutMs: GIT_TIMEOUT_MS,
				})
			).trim() || undefined;
	const env = gitEnv({ mailbox, interactive, sshCommand });
	const repo = repoDir();
	const git = (args: string[], timeoutMs = GIT_TIMEOUT_MS) =>
		runGitFull(outboxDir(), [`--git-dir=${repo}`, "--work-tree=.", ...args], {
			env,
			timeoutMs,
			allowFailure: true,
			signal: opts.signal,
		});
	const must = async (args: string[]) => {
		const r = await git(args);
		opts.signal?.throwIfAborted();
		if (r.code !== 0) throw new Error(r.stderr || `git ${args[0]} failed`);
		return r.stdout.toString("utf8").trim();
	};

	if (!(await statOf(join(repo, "HEAD")))) {
		await runGit(telemetryDir(), ["init", "--quiet", "--bare", repo], {
			env,
			timeoutMs: GIT_TIMEOUT_MS,
			signal: opts.signal,
		});
	}

	const state = await collectState({
		config: opts.config,
		traceDir: opts.traceDir,
		by: opts.by,
		secrets,
		now,
	});
	opts.signal?.throwIfAborted();
	const filled = await fillOutbox({
		device,
		texts: {
			"state.json": `${JSON.stringify(state, null, "\t")}\n`,
			"state-history.jsonl": await history(state, now),
		},
		traceDir: opts.traceDir,
		secrets,
		now: now.getTime(),
		newCap: opts.newCap ?? NEW_BYTES_PER_PUSH,
		signal: opts.signal,
	});

	// --force: a global ignore (*.log is common) must not drop a file.
	await must(["add", "--all", "--force", "."]);
	const tree = await must(["write-tree"]);
	const commit = await must([
		"commit-tree",
		tree,
		"-m",
		`crb telemetry: ${device} at ${now.toISOString()}`,
	]);

	const branch = `refs/heads/${deviceBranch(device)}`;
	const pushed = (
		await git(["rev-parse", "--verify", "--quiet", "refs/mailbox/pushed"])
	).stdout
		.toString("utf8")
		.trim();
	const pushTo = (expected: string) =>
		git(
			[
				"push",
				"--quiet",
				"--no-verify",
				`--force-with-lease=${branch}:${expected}`,
				"mailbox",
				`${commit}:${branch}`,
			],
			PUSH_TIMEOUT_MS,
		);
	let result = await pushTo(pushed);
	let tookOver = false;
	if (
		result.code !== 0 &&
		/stale info|fetch first|already exists/i.test(result.stderr)
	) {
		// The branch isn't what this device last pushed: a reinstall (state
		// dir wiped) or another crb with the same device name. Its own
		// branch, so this device takes it over, still with a lease, and
		// says so (status, serve.log once, crb telemetry status).
		const remote = await git(["ls-remote", "mailbox", branch], PUSH_TIMEOUT_MS);
		if (remote.code === 0) {
			const tip = remote.stdout.toString("utf8").split(/\s/)[0] ?? "";
			result = await pushTo(tip);
			tookOver = result.code === 0;
		}
	}
	opts.signal?.throwIfAborted();
	const outcome: MailboxStatus = {
		...base,
		commit,
		bytes: filled.bytes,
		files: filled.files,
		newBytes: filled.newBytes,
		...(filled.tracesWaiting ? { tracesWaiting: filled.tracesWaiting } : {}),
		...(filled.tracesOverCap ? { tracesOverCap: filled.tracesOverCap } : {}),
		...(tookOver ? { tookOver } : {}),
	};
	if (result.code === 0) {
		await must(["update-ref", "refs/mailbox/pushed", commit]);
		outcome.ok = true;
		outcome.lastOkAt = base.at;
	} else {
		outcome.error = gitError(result.stderr, secrets);
	}
	// Loose objects of earlier snapshots: kept are the last pushed one
	// (the next push's base) and the index's.
	await git(["prune", "--expire=now"]);
	return outcome;
}
