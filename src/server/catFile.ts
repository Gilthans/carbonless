import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { beginCall } from "./activity.js";
import { GitError, runGitBuffer, spawnLongGit } from "./git.js";

/*
 * Object reads through one `git cat-file --batch` per clone that stays up
 * between reads (CAR-320). Starting a process costs ~90 ms on Windows, and
 * a page reads files by the dozen (hunks, thread placements, threads'
 * code), so each read starting its own `git cat-file` was what made opening
 * a review there slow.
 *
 * Bounded: one process per clone, closed after IDLE_MS without a read, on
 * a reset (closeCatFiles) and when crb exits (spawnLongGit). A process that
 * fails or exits fails the reads it had (a GitError: the caller's own
 * failure path, never an empty answer) and the next read starts a new one.
 *
 * Only names that start with a full OID (`<oid>`, `<oid>:<path>`) go
 * through it: what they name never changes, so a process started before a
 * fetch or a ref update can't answer from a stale view (git rereads its
 * packs when an object isn't found). Anything else, and a name with a
 * newline (git echoes a missing name back, and the answer would be read
 * wrong), is read by a `cat-file` of its own.
 */

/** A read object: its OID, type (`blob`, `commit`, ...) and bytes. */
export interface GitObject {
	oid: string;
	type: string;
	content: Buffer;
}

/** How long a clone's process stays up after its last read. */
export const IDLE_MS = 30_000;

const BY_OID = /^[0-9a-f]{40}([0-9a-f]{24})?(:|$)/;
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

	constructor(
		repo: string,
		private readonly onExit: () => void,
	) {
		this.#child = spawnLongGit(repo, ["cat-file", "-z", "--batch"]);
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
				signal.addEventListener(
					"abort",
					() => {
						if (pending.dropped) return;
						pending.dropped = true;
						pending.end();
						reject(new GitError("git was stopped"));
					},
					{ once: true },
				);
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
				this.#take(eol + 1);
				const content = this.#take(size);
				this.#take(1);
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

/** The clone's process, started if none runs. */
function processOf(repo: string): CatFile {
	const known = processes.get(repo);
	if (known && !known.dead) return known;
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
		if (header.endsWith(" missing")) return null;
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
export function readObject(
	repo: string,
	name: string,
	signal?: AbortSignal,
): Promise<GitObject | null> {
	if (!BY_OID.test(name) || name.includes("\n") || name.includes("\0")) {
		return readAlone(repo, name, signal);
	}
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

/** Ends every clone's process (a reset, tests); the next read starts one. */
export function closeCatFiles(): void {
	for (const p of [...processes.values()]) p.close();
	processes.clear();
}

/** How many clones have a process up (tests). */
export const catFileCount = (): number => processes.size;
