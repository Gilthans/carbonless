import { createHash, randomBytes } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { cacheDir } from "../paths.js";

/*
 * A clone's "crb refs changed" stamp (CAR-326): a file crb owns, outside
 * git, that RefStore rewrites after every ref update it makes (every write
 * of refs/crb goes through RefStore.transaction, in the server and the crb
 * CLI alike). Home lists a clone's refs with a `git for-each-ref` only when
 * the stamp differs from the one it saw at its last listing, so a Home load
 * starts no git per clone while nothing was written; refs are still only
 * ever read through git. Not a cache of git data: it only says "list
 * again".
 *
 * Kept under the cache's `ref-stamps/`, one file per clone, named by a
 * hash of the clone's real path (the server and the CLI may reach the same
 * cache by different paths). The clone directory's identity (inode, birth
 * time) is part of the stamp, so a clone removed and made again never
 * matches a stamp seen before.
 */

const stampsDir = () => join(cacheDir(), "ref-stamps");

/**
 * This process's own writes, per clone: bumped before any file work, and
 * part of every stamp it reads, so the server's own ref writes show on its
 * next Home scan even when the stamp file can't be written (a Windows
 * scanner holding it). Only another process's writes rely on the file.
 */
const generations = new Map<string, number>();

async function fileOf(repo: string): Promise<string> {
	const real = await realpath(repo).catch(() => resolve(repo));
	const name = createHash("sha256").update(real).digest("hex").slice(0, 32);
	return join(stampsDir(), name);
}

const token = () =>
	`${Date.now().toString(36)}-${process.pid}-${randomBytes(6).toString("hex")}`;

/** Codes a file another program holds for a moment fails with (Windows). */
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
/** Backoffs between tries of a stamp write, as graceful-fs retries. */
const RETRY_MS = [10, 50, 200];

/** Removes files in `dir` not modified for `maxAgeMs` (crb's own small files). */
export async function pruneOlderThan(
	dir: string,
	maxAgeMs: number,
	now = Date.now(),
): Promise<void> {
	const names = await readdir(dir).catch(() => [] as string[]);
	for (const name of names) {
		const path = join(dir, name);
		try {
			const s = await stat(path);
			if (s.isFile() && now - s.mtimeMs > maxAgeMs)
				await rm(path, { force: true });
		} catch {
			// Gone meanwhile, or not ours to judge.
		}
	}
}

/** Stamps (and stray temporary files) untouched this long are dropped. */
export const STAMP_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
let pruned = false;

/**
 * Says the clone's crb refs (may have) changed: this process's generation
 * first, then a new stamp file, written whole (a temporary file renamed
 * over it), tried again while another program holds it. Never fails: a
 * stamp file it couldn't write is logged, and leaves other processes'
 * Home listings as stale as TRUST_MS (home/started.ts) allows.
 */
export async function refsChanged(repo: string): Promise<void> {
	const key = resolve(repo);
	generations.set(key, (generations.get(key) ?? 0) + 1);
	if (!pruned) {
		pruned = true;
		void pruneOlderThan(stampsDir(), STAMP_MAX_AGE_MS);
	}
	let tmp: string | undefined;
	try {
		const file = await fileOf(repo);
		await mkdir(stampsDir(), { recursive: true });
		for (let attempt = 0; ; attempt++) {
			try {
				tmp = `${file}.${token()}.tmp`;
				await writeFile(tmp, token());
				await rename(tmp, file);
				return;
			} catch (error) {
				if (tmp) await rm(tmp, { force: true }).catch(() => {});
				const code = (error as NodeJS.ErrnoException).code ?? "";
				const wait = RETRY_MS[attempt];
				if (!TRANSIENT.has(code) || wait === undefined) throw error;
				await new Promise((r) => setTimeout(r, wait));
			}
		}
	} catch (error) {
		console.error(
			`crb: couldn't stamp ${repo}'s refs (other crb processes see the change within minutes): ${String(error)}`,
		);
	}
}

/**
 * The clone's current stamp, made when it has none; null when it can't be
 * read or made (the caller lists the refs, as with a changed stamp). Read
 * before the listing it vouches for: a write landing after the read stamps
 * after its update, so the next read differs.
 */
export async function refStamp(repo: string): Promise<string | null> {
	try {
		const generation = generations.get(resolve(repo)) ?? 0;
		const file = await fileOf(repo);
		const dir = await stat(repo, { bigint: true });
		const identity = `${dir.ino}:${dir.birthtimeNs}`;
		const read = () => readFile(file, "utf8");
		let value: string;
		try {
			value = await read();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
			await mkdir(stampsDir(), { recursive: true });
			// Made only if still missing: a writer's stamp is never replaced.
			await writeFile(file, token(), { flag: "wx" }).catch((e) => {
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			});
			value = await read();
		}
		return `${identity}:${generation}:${value}`;
	} catch {
		return null;
	}
}
