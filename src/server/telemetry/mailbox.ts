import {
	mkdir,
	open,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
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
 * Bounded: every push is ONE parentless commit, a full snapshot, force-
 * pushed (with a lease) over the last. Each snapshot already holds every
 * trace file kept (14 days, capped per push), so history would only copy
 * them again; the branch stays one snapshot's size, whatever the uptime.
 * The state's history lives in the snapshot instead (state-history.jsonl,
 * 7 days). Git still sends only what changed: the remote's last snapshot
 * is the base of the push's thin pack (same blobs, the growing trace file
 * as a delta).
 */

const MiB = 1024 * 1024;
/** The most one push carries; the oldest traces are left out first. */
const MAX_PUSH_BYTES = 50 * MiB;
/** A log is sent as its last this many bytes. */
const LOG_TAIL_BYTES = 5 * MiB;
/** state-history.jsonl keeps this many days. */
const HISTORY_DAYS = 7;
/** A lock older than this is a crashed push's. */
const STALE_LOCK_MS = 30 * 60_000;
const PUSH_TIMEOUT_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 2 * 60_000;

export const telemetryDir = (): string => join(stateDir(), "telemetry");
const repoDir = () => join(telemetryDir(), "mailbox.git");
const outboxDir = () => join(telemetryDir(), "outbox");
const statusFile = () => join(telemetryDir(), "status.json");
const historyFile = () => join(telemetryDir(), "state-history.jsonl");
const manifestFile = () => join(telemetryDir(), "outbox.json");
const lockFile = () => join(telemetryDir(), "push.lock");

export const deviceBranch = (device: string): string => `device/${device}`;

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
	/** Trace files left out to stay under MAX_PUSH_BYTES. */
	tracesLeftOut?: number;
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

/** One file of the snapshot, under devices/<device>/. */
interface Wanted {
	/** Its path in the snapshot (forward slashes). */
	dest: string;
	/** Written as is. */
	text?: string;
	/** Copied (scrubbed) from here, … */
	src?: string;
	/** …only its last this many bytes. */
	tailBytes?: number;
	/** …cut at its last newline (a trace file still being written). */
	wholeLines?: boolean;
	/** Its source's size and mtime, to copy only what changed. */
	stamp?: string;
}

async function statOf(path: string) {
	return stat(path).then(
		(s) => (s.isFile() ? s : null),
		() => null,
	);
}

/** The trace files to send: crb serve's, newest first, within `budget`. */
async function traceFiles(
	dir: string | null,
	budget: number,
): Promise<{ files: Wanted[]; bytes: number; leftOut: number }> {
	const files: Wanted[] = [];
	if (!dir) return { files, bytes: 0, leftOut: 0 };
	const names = await readdir(dir).catch(() => [] as string[]);
	const found: { name: string; size: number; mtimeMs: number }[] = [];
	for (const name of names) {
		if (!isServiceFile("crb", name)) continue;
		const st = await statOf(join(dir, name));
		if (st) found.push({ name, size: st.size, mtimeMs: st.mtimeMs });
	}
	found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
	let bytes = 0;
	let leftOut = 0;
	for (const f of found) {
		if (bytes + f.size > budget) {
			leftOut++;
			continue;
		}
		bytes += f.size;
		files.push({
			dest: `traces/${f.name}`,
			src: join(dir, f.name),
			wholeLines: true,
			stamp: `${f.size}:${f.mtimeMs}`,
		});
	}
	return { files, bytes, leftOut };
}

/** crb's logs: serve.log (+ .1) and the updater's, as tails. */
async function logFiles(): Promise<Wanted[]> {
	const out: Wanted[] = [];
	const logs: [string, string][] = [
		["serve.log", join(stateDir(), "serve.log")],
		["serve.log.1", join(stateDir(), "serve.log.1")],
		["update.log", join(cacheDir(), "update.log")],
	];
	for (const [name, src] of logs) {
		const st = await statOf(src);
		if (!st) continue;
		out.push({
			dest: `logs/${name}`,
			src,
			tailBytes: LOG_TAIL_BYTES,
			stamp: `${st.size}:${st.mtimeMs}`,
		});
	}
	return out;
}

/** Reads `w.src` as the snapshot wants it: tail, whole lines, scrubbed. */
async function contentOf(w: Wanted, secrets: string[]): Promise<string> {
	const handle = await open(w.src as string, "r");
	let buf: Buffer;
	try {
		const { size } = await handle.stat();
		const from = w.tailBytes ? Math.max(0, size - w.tailBytes) : 0;
		buf = Buffer.alloc(size - from);
		await handle.read(buf, 0, buf.length, from);
	} finally {
		await handle.close();
	}
	let text = buf.toString("utf8");
	if (w.tailBytes && buf.length === w.tailBytes) {
		// A tail starts at the next whole line.
		const nl = text.indexOf("\n");
		if (nl >= 0) text = text.slice(nl + 1);
	}
	if (w.wholeLines) text = text.slice(0, text.lastIndexOf("\n") + 1);
	return scrubText(text, secrets);
}

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
		serverUptimeSeconds: s.server?.uptimeSeconds ?? null,
		traceBytes: s.traces?.bytes ?? null,
		clones: (s.clones ?? []).map((c) => ({
			repo: c.repo,
			bytes: c.bytes,
			crbRefs: c.crbRefs,
			reviews: c.reviews,
		})),
	});
	const cutoff = now.getTime() - HISTORY_DAYS * 24 * 60 * 60_000;
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

/**
 * Makes outbox/devices/<device>/ hold the snapshot: copies what changed,
 * writes the state, deletes what's no longer sent (and other devices').
 */
async function fillOutbox(
	device: string,
	wanted: Wanted[],
	secrets: string[],
): Promise<{ bytes: number; files: number }> {
	const root = join(outboxDir(), "devices", device);
	const manifest: Record<string, string> = JSON.parse(
		await readFile(manifestFile(), "utf8").catch(() => "{}"),
	);
	const next: Record<string, string> = {};
	const keep = new Set<string>();
	for (const w of wanted) {
		const path = join(root, ...w.dest.split("/"));
		const rel = `devices/${device}/${w.dest}`;
		keep.add(rel);
		if (w.text !== undefined) {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, w.text);
			continue;
		}
		if (w.stamp && manifest[rel] === w.stamp && (await statOf(path))) {
			next[rel] = w.stamp;
			continue;
		}
		let text: string;
		try {
			text = await contentOf(w, secrets);
		} catch {
			// Gone or locked meanwhile (Windows): the next push has it.
			keep.delete(rel);
			continue;
		}
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, text);
		if (w.stamp) next[rel] = w.stamp;
	}
	let bytes = 0;
	let files = 0;
	for (const rel of await walk(outboxDir())) {
		const path = join(outboxDir(), ...rel.split("/"));
		if (!keep.has(rel)) {
			await rm(path, { force: true });
			continue;
		}
		files++;
		bytes += (await statOf(path))?.size ?? 0;
	}
	await writeFileAtomic(manifestFile(), JSON.stringify(next));
	return { bytes, files };
}

/** Git config for every mailbox git: the remote, LF kept, no prompts in serve. */
function gitEnv(mailbox: string, interactive: boolean): Record<string, string> {
	const config: [string, string][] = [
		// The URL goes in the environment, never argv: it may carry a
		// token, and argv lands in traces and process lists.
		["remote.mailbox.url", mailbox],
		["core.autocrlf", "false"],
		["core.safecrlf", "false"],
		["core.fsmonitor", "false"],
		["gc.auto", "0"],
		["commit.gpgSign", "false"],
	];
	const env: Record<string, string> = {
		GIT_CONFIG_COUNT: String(config.length),
		GIT_AUTHOR_NAME: "crb telemetry",
		GIT_AUTHOR_EMAIL: "telemetry@carbonless.invalid",
		GIT_COMMITTER_NAME: "crb telemetry",
		GIT_COMMITTER_EMAIL: "telemetry@carbonless.invalid",
	};
	config.forEach(([k, v], i) => {
		env[`GIT_CONFIG_KEY_${i}`] = k;
		env[`GIT_CONFIG_VALUE_${i}`] = v;
	});
	if (!interactive) env.GIT_TERMINAL_PROMPT = "0";
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
			const st = await statOf(lockFile());
			const pid = Number(
				(await readFile(lockFile(), "utf8").catch(() => "")).trim(),
			);
			const dead =
				!st ||
				Date.now() - st.mtimeMs > STALE_LOCK_MS ||
				!(pid > 0 && pidAlive(pid));
			if (!dead) return null;
			await rm(lockFile(), { force: true });
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
	/** The cap on one push (default MAX_PUSH_BYTES; tests). */
	maxBytes?: number;
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
		status = { ...base, error: gitError((error as Error).message, secrets) };
	} finally {
		await release();
	}
	await writeFileAtomic(
		statusFile(),
		`${JSON.stringify(status, null, "\t")}\n`,
	);
	return { status };
}

async function push(
	opts: PushOptions,
	now: Date,
	secrets: string[],
	base: MailboxStatus,
): Promise<MailboxStatus> {
	const { device, mailbox } = opts.telemetry;
	const env = gitEnv(mailbox, opts.by === "cli");
	const repo = repoDir();
	const git = (args: string[], timeoutMs = GIT_TIMEOUT_MS) =>
		runGitFull(outboxDir(), [`--git-dir=${repo}`, "--work-tree=.", ...args], {
			env,
			timeoutMs,
			allowFailure: true,
		});
	const must = async (args: string[]) => {
		const r = await git(args);
		if (r.code !== 0) throw new Error(r.stderr || `git ${args[0]} failed`);
		return r.stdout.toString("utf8").trim();
	};

	await mkdir(outboxDir(), { recursive: true });
	if (!(await statOf(join(repo, "HEAD")))) {
		await runGit(telemetryDir(), ["init", "--quiet", "--bare", repo], {
			env,
			timeoutMs: GIT_TIMEOUT_MS,
		});
	}

	const state = await collectState({
		config: opts.config,
		traceDir: opts.traceDir,
		by: opts.by,
		secrets,
		now,
	});
	const stateText = `${JSON.stringify(state, null, "\t")}\n`;
	const historyText = await history(state, now);
	const logs = await logFiles();
	let fixed = Buffer.byteLength(stateText) + Buffer.byteLength(historyText);
	for (const l of logs) fixed += Math.min(LOG_TAIL_BYTES, sizeOf(l));
	const traces = await traceFiles(
		opts.traceDir,
		Math.max(0, (opts.maxBytes ?? MAX_PUSH_BYTES) - fixed),
	);
	const { bytes, files } = await fillOutbox(
		device,
		[
			{ dest: "state.json", text: stateText },
			{ dest: "state-history.jsonl", text: historyText },
			...logs,
			...traces.files,
		],
		secrets,
	);

	await must(["add", "--all", "."]);
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
	if (
		result.code !== 0 &&
		/stale info|fetch first|already exists/i.test(result.stderr)
	) {
		// The branch isn't what this device last pushed: a reinstall (state
		// dir wiped) or another crb with the same device name. Its own
		// branch, so this device takes it over, still with a lease.
		const remote = await git(["ls-remote", "mailbox", branch], PUSH_TIMEOUT_MS);
		if (remote.code === 0) {
			const tip = remote.stdout.toString("utf8").split(/\s/)[0] ?? "";
			result = await pushTo(tip);
		}
	}
	const outcome: MailboxStatus = {
		...base,
		commit,
		bytes,
		files,
		...(traces.leftOut ? { tracesLeftOut: traces.leftOut } : {}),
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

function sizeOf(w: Wanted): number {
	return Number(w.stamp?.split(":")[0] ?? 0);
}
