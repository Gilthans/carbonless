import { createHash, randomBytes } from "node:crypto";
import {
	mkdir,
	readFile,
	realpath,
	rename,
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

async function fileOf(repo: string): Promise<string> {
	const real = await realpath(repo).catch(() => resolve(repo));
	const name = createHash("sha256").update(real).digest("hex").slice(0, 32);
	return join(stampsDir(), name);
}

const token = () =>
	`${Date.now().toString(36)}-${process.pid}-${randomBytes(6).toString("hex")}`;

/**
 * Says the clone's crb refs (may have) changed: a new stamp, written whole
 * (a temporary file renamed over it). Never fails: a stamp it couldn't
 * write leaves Home's listing as stale as TRUST_MS (home/started.ts) allows.
 */
export async function refsChanged(repo: string): Promise<void> {
	try {
		const file = await fileOf(repo);
		await mkdir(stampsDir(), { recursive: true });
		const tmp = `${file}.${token()}.tmp`;
		await writeFile(tmp, token());
		await rename(tmp, file);
	} catch {
		// See above.
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
		return `${identity}:${value}`;
	} catch {
		return null;
	}
}
