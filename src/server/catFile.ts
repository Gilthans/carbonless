import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { beginCall } from "./activity.js";
import { GitError, runGitBuffer, spawnLongGit } from "./git.js";
import { tracer } from "./trace.js";

/*
 * Object reads through one `git cat-file --batch` per clone that stays up
 * between reads (CAR-320). Starting a process costs ~90 ms on Windows, and
 * a page reads files by the dozen (hunks, thread placements, threads'
 * code), so each read starting its own `git cat-file` was what made opening
 * a review there slow.
 *
 * Bounded: one process per clone, at most MAX_PROCESSES (the least
 * recently used idle one closes for a new one), closed after IDLE_MS
 * without a read, on a reset (closeCatFiles) and when crb exits
 * (spawnLongGit). A process that
 * fails or exits fails the reads it had (a GitError: the caller's own
 * failure path, never an empty answer) and the next read starts a new one.
 *
 * Only names that start with a full OID (`<oid>`, `<oid>:<path>`) go
 * through it: what they name never changes, so a process started before a
 * fetch or a ref update can't answer from a stale view (git rereads its
 * packs when an object isn't found). Anything else, a name with a newline
 * (git echoes a missing name back, and the answer would be read wrong),
 * and a relative path (`<oid>:./x`, which git refuses in a bare clone by
 * exiting, failing every read queued beside it) is read by a `cat-file`
 * of its own.
 */

/** A read object: its OID, type (`blob`, `commit`, ...) and bytes. */
export interface GitObject {
	oid: string;
	type: string;
	content: Buffer;
}

/** How long a clone's process stays up after its last read. */
export const IDLE_MS = 30_000;

/** Clones with a process up at once (a Home pass reads many). */
export const MAX_PROCESSES = 16;

const BY_OID = /^[0-9a-f]{40}([0-9a-f]{24})?(:|$)/;
/** A path part git takes as relative to a work tree: `.`, `..`, `./…`, `../…`. */
const RELATIVE = /^[0-9a-f]+:\.\.?(\/|$)/;

/** Spans of each read, when $CRB_TRACE_DIR is set (trace.ts). */
const traced = tracer();
const HEADER = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\S+) (\d+)$/;

interface Pending {
	name: string;
	resolve: (o: GitObject | null) => void;
	reject: (e: Error) => void;
	/** Its answer is read and dropped (the reader stopped waiting). */
	dropped: boolean;
	end: () => void;
}

/** One clone's long-running `git cat-file -z --batch`. */
class CatFile {
	readonly #child: ChildProcess;
	readonly #queue: Pending[] = [];
	#chunks: Buffer[] = [];
	#size = 0;
	/** Bytes the answer under way needs before it can be read (a big blob's). */
	#need = 0;
	#stderr = "";
	#dead = false;
	#idle: ReturnType<typeof setTimeout> | undefined;
	/** Settles once its process has exited (Windows holds its directory till then). */
	readonly exited: Promise<void>;
	/** Its lifetime's span (tracing on), each read's under none: steps say those. */
	readonly #span: ReturnType<typeof traced.start> | null;
	/** Reads answered, for its span. */
	#reads = 0;

	constructor(
		repo: string,
		private readonly onExit: () => void,
	) {
		this.#child = spawnLongGit(repo, ["cat-file", "-z", "--batch"]);
		this.#span = traced.enabled
			? traced.start("git cat-file", { batch: "process" }, { kind: "client" })
			: null;
		this.exited = new Promise((resolve) => {
			this.#child.on("close", () => resolve());
			// Never started: no exit to wait for.
			this.#child.on("error", () => resolve());
		});
		this.#child.stdout?.on("data", (chunk: Buffer) => {
			this.#chunks.push(chunk);
			this.#size += chunk.length;
			this.#parse();
		});
		this.#child.stderr?.on("data", (chunk: Buffer) => {
			this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-2000);
		});
		this.#child.stdin?.on("error", () => {});
		this.#child.on("error", (error) => this.#fail(error.message));
		this.#child.on("close", (code) =>
			this.#fail(
				this.#stderr.trim() || `git cat-file exited with code ${code}`,
			),
		);
		this.#hold(false);
	}

	get dead(): boolean {
		return this.#dead;
	}

	/** No read out. */
	get idle(): boolean {
		return this.#queue.length === 0;
	}

	read(name: string, signal?: AbortSignal): Promise<GitObject | null> {
		return new Promise((resolve, reject) => {
			if (this.#dead) {
				reject(new GitError("git cat-file stopped"));
				return;
			}
			const pending: Pending = {
				name,
				resolve,
				reject,
				dropped: false,
				end: beginCall("git cat-file"),
			};
			if (signal) {
				if (signal.aborted) {
					pending.end();
					reject(new GitError("git was stopped"));
					return;
				}
				const onAbort = () => {
					if (pending.dropped) return;
					pending.dropped = true;
					pending.end();
					reject(new GitError("git was stopped"));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				// Answered or failed: the signal (a session's, long-lived)
				// keeps no listener per read.
				const end = pending.end;
				pending.end = () => {
					signal.removeEventListener("abort", onAbort);
					end();
				};
			}
			this.#queue.push(pending);
			clearTimeout(this.#idle);
			this.#hold(true);
			this.#child.stdin?.write(`${name}\0`);
		});
	}

	/** Ends it (stdin closed: git exits); reads still out fail. */
	close(): void {
		if (this.#dead) return;
		this.#child.stdin?.end();
		this.#fail("git cat-file closed");
	}

	/** Keeps crb alive while a read is out; never while idle. */
	#hold(busy: boolean): void {
		const streams = [
			this.#child.stdin,
			this.#child.stdout,
			this.#child.stderr,
		] as unknown as (Socket | null)[];
		for (const s of streams) {
			if (busy) s?.ref?.();
			else s?.unref?.();
		}
		if (busy) this.#child.ref();
		else this.#child.unref();
	}

	#fail(message: string): void {
		if (this.#dead) return;
		this.#dead = true;
		this.#span?.end({ reads: this.#reads });
		ending.add(this.exited);
		void this.exited.then(() => ending.delete(this.exited));
		clearTimeout(this.#idle);
		this.onExit();
		if (!this.#child.killed && this.#child.exitCode === null) {
			this.#child.kill("SIGKILL");
		}
		for (const p of this.#queue.splice(0)) {
			if (p.dropped) continue;
			p.dropped = true;
			p.end();
			p.reject(new GitError(message));
		}
		this.#hold(false);
	}

	/** Index of the first LF in what's buffered, or -1. */
	#lineEnd(): number {
		let offset = 0;
		for (const chunk of this.#chunks) {
			const i = chunk.indexOf(0x0a);
			if (i !== -1) return offset + i;
			offset += chunk.length;
		}
		return -1;
	}

	/** Takes `n` bytes off the front of what's buffered. */
	#take(n: number): Buffer {
		const all =
			this.#chunks.length === 1
				? (this.#chunks[0] as Buffer)
				: Buffer.concat(this.#chunks, this.#size);
		const out = Buffer.allocUnsafeSlow(n);
		all.copy(out, 0, 0, n);
		const rest = all.subarray(n);
		this.#chunks = rest.length > 0 ? [rest] : [];
		this.#size = rest.length;
		return out;
	}

	#parse(): void {
		for (;;) {
			const head = this.#queue[0];
			if (!head) {
				if (this.#size > 0) this.#fail("git cat-file said more than asked");
				return;
			}
			if (this.#size < this.#need) return;
			const eol = this.#lineEnd();
			if (eol === -1) return;
			const peek =
				this.#chunks.length === 1
					? (this.#chunks[0] as Buffer)
					: Buffer.concat(this.#chunks, this.#size);
			const header = peek.toString("utf8", 0, eol);
			const match = HEADER.exec(header);
			let answer: GitObject | null;
			if (match) {
				const size = Number(match[3]);
				// The header, its LF, the bytes and their LF.
				if (this.#size < eol + 1 + size + 1) {
					this.#need = eol + 1 + size + 1;
					return;
				}
				this.#need = 0;
				// One copy of the bytes out of what's buffered (`peek`, the
				// chunks joined once), the rest kept as it is.
				const start = eol + 1;
				const content = Buffer.allocUnsafeSlow(size);
				peek.copy(content, 0, start, start + size);
				const rest = peek.subarray(start + size + 1);
				this.#chunks = rest.length > 0 ? [rest] : [];
				this.#size = rest.length;
				answer = {
					oid: match[1] as string,
					type: match[2] as string,
					content,
				};
			} else if (header === `${head.name} missing`) {
				this.#take(eol + 1);
				answer = null;
			} else {
				// "ambiguous", "dangling", a symlink's answer: not one we read.
				this.#fail(`git cat-file: ${header.slice(0, 200)}`);
				return;
			}
			this.#queue.shift();
			this.#reads++;
			if (!head.dropped) {
				head.dropped = true;
				head.end();
				head.resolve(answer);
			}
			if (this.#queue.length === 0) {
				this.#hold(false);
				clearTimeout(this.#idle);
				this.#idle = setTimeout(() => this.close(), IDLE_MS);
				this.#idle.unref?.();
			}
		}
	}
}

const processes = new Map<string, CatFile>();
/** Processes ended (idle, failed, closed) that haven't exited yet. */
const ending = new Set<Promise<void>>();

/**
 * The clone's process, started if none runs; most recently used last. A
 * new one past MAX_PROCESSES closes the least recently used idle one (none
 * idle: it goes over for now, the idle timeout brings it back).
 */
function processOf(repo: string): CatFile {
	const known = processes.get(repo);
	if (known && !known.dead) {
		processes.delete(repo);
		processes.set(repo, known);
		return known;
	}
	if (processes.size >= MAX_PROCESSES) {
		for (const [key, p] of processes) {
			if (!p.idle) continue;
			processes.delete(key);
			p.close();
			break;
		}
	}
	const made: CatFile = new CatFile(repo, () => {
		if (processes.get(repo) === made) processes.delete(repo);
	});
	processes.set(repo, made);
	return made;
}

/** A name's object read by a `cat-file` of its own (names the batch can't take). */
async function readAlone(
	repo: string,
	name: string,
	signal?: AbortSignal,
): Promise<GitObject | null> {
	const out = await runGitBuffer(repo, ["cat-file", "-z", "--batch"], {
		input: `${name}\0`,
		signal,
	});
	const eol = out.indexOf(0x0a);
	const header = out.toString("utf8", 0, eol < 0 ? out.length : eol);
	const match = HEADER.exec(header);
	if (!match) {
		// The one name asked, echoed back (a newline in it and all).
		if (out.toString("utf8").startsWith(`${name} missing`)) return null;
		throw new GitError(`git cat-file: ${header.slice(0, 200)}`);
	}
	const size = Number(match[3]);
	if (out.length < eol + 1 + size) {
		throw new GitError("git cat-file: output cut short");
	}
	const content = Buffer.allocUnsafeSlow(size);
	out.copy(content, 0, eol + 1, eol + 1 + size);
	return { oid: match[1] as string, type: match[2] as string, content };
}

/**
 * The object `name` names (`<oid>` or `<oid>:<path>`); null when the clone
 * hasn't it (or the path isn't there). A git failure rejects (GitError).
 */
export async function readObject(
	repo: string,
	name: string,
	signal?: AbortSignal,
): Promise<GitObject | null> {
	if (
		!BY_OID.test(name) ||
		RELATIVE.test(name) ||
		name.includes("\n") ||
		name.includes("\0")
	) {
		return readAlone(repo, name, signal);
	}
	// Paused (clone maintenance): no process held open beside a repack.
	if (paused.has(repo)) return readAlone(repo, name, signal);
	return processOf(repo).read(name, signal);
}

/**
 * The bytes of the blob `name` names, as `git cat-file blob <name>` gives
 * them: a GitError when it's missing or not a blob.
 */
export async function readBlob(
	repo: string,
	name: string,
	signal?: AbortSignal,
): Promise<Buffer> {
	const object = await readObject(repo, name, signal);
	if (!object) throw new GitError(`Not a valid object name ${name}`);
	if (object.type !== "blob") {
		throw new GitError(`${name} is a ${object.type}, not a blob`);
	}
	return object.content;
}

/**
 * Ends every clone's process (a reset, tests); the next read starts one.
 * Settles once they have exited: on Windows a running process keeps its
 * clone's directory from being removed.
 */
export async function closeCatFiles(): Promise<void> {
	const all = [...processes.values()];
	processes.clear();
	for (const p of all) p.close();
	await Promise.all([...ending]);
}

/** Clones whose reads each run a `cat-file` of their own for now, and by how many pausers. */
const paused = new Map<string, number>();

/** Longest a pause waits for the reads out to be answered before closing. */
const DRAIN_MS = 10_000;

/**
 * Keeps `repo` without a long-running process until the returned resume is
 * called (clone maintenance: on Windows an open reader keeps a repack from
 * deleting the packs it rolled up). Reads meanwhile each run a `cat-file`
 * of their own; the process up now gets its reads out answered (up to
 * DRAIN_MS), then closes, and this settles once it has exited.
 */
export async function pauseCatFile(repo: string): Promise<() => void> {
	paused.set(repo, (paused.get(repo) ?? 0) + 1);
	let resumed = false;
	const resume = () => {
		if (resumed) return;
		resumed = true;
		const left = (paused.get(repo) ?? 1) - 1;
		if (left > 0) paused.set(repo, left);
		else paused.delete(repo);
	};
	const up = processes.get(repo);
	if (up) {
		processes.delete(repo);
		const deadline = Date.now() + DRAIN_MS;
		while (!up.dead && !up.idle && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 10));
		}
		up.close();
		await up.exited;
	}
	return resume;
}

/** How many clones have a process up (tests). */
export const catFileCount = (): number => processes.size;
