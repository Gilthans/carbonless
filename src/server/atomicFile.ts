import { randomUUID } from "node:crypto";
import { mkdir, rename as renameFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Codes a rename over a file fails with on Windows while another process
 * (Defender, an indexer, an editor, another crb) has it open for a moment:
 * Windows can't replace a file that has open handles. Elsewhere these are
 * real permission errors, and fail at once.
 */
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Waits before each retry of a busy rename on Windows, in ms: about 3.3 s
 * in all. The same as test/fake-gh/atomic.mjs's (a test keeps them equal:
 * that helper is plain .mjs and can't import TypeScript from src).
 */
export const RENAME_BACKOFF: readonly number[] = Object.freeze([
	5, 10, 20, 40, 80, 160, 320, 640, 1000, 1000,
]);

/** For tests: the rename, the wait between tries, and the platform. */
export interface RenameOptions {
	rename?: (from: string, to: string) => Promise<void>;
	sleep?: (ms: number) => Promise<unknown>;
	platform?: NodeJS.Platform | string;
}

/**
 * Renames `from` over `to`; on Windows, retries while the file is busy
 * (BUSY), awaiting RENAME_BACKOFF between tries (a timer, never blocking
 * the event loop), then throws the last error.
 */
async function renameRetrying(
	from: string,
	to: string,
	{
		rename = renameFile,
		sleep = delay,
		platform = process.platform,
	}: RenameOptions = {},
): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | null)?.code;
			const wait = RENAME_BACKOFF[attempt];
			if (
				platform !== "win32" ||
				!code ||
				!BUSY.has(code) ||
				wait === undefined
			)
				throw error;
			await sleep(wait);
		}
	}
}

/**
 * Writes `data` to `path` so no reader ever sees it half-written: to a temp
 * file in the same directory (created with `mode`), then renamed over it
 * (on Windows, retrying while another process has the file open). A failed
 * write keeps the old file and removes the temp file. Concurrent writers
 * to one path: the last rename wins, which a retry can make an older
 * write; callers that care serialize their writes. `options` are for
 * tests.
 */
export async function writeFileAtomic(
	path: string,
	data: string,
	mode = 0o644,
	options?: RenameOptions,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(tmp, data, { mode, flag: "wx" });
		await renameRetrying(tmp, path, options);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}
