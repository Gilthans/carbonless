// Plain ESM so test/fake-gh/gh (a Node script) and the TypeScript test
// helpers share one implementation; atomic.d.mts types it.
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { threadId } from "node:worker_threads";

let count = 0;

/**
 * Writes `data` to `path` so that no reader ever sees it half-written: the
 * whole file goes to a temp name in the same directory (unique per process,
 * thread and write, so two gh processes, or the test and the fake gh server's
 * thread, saving at once don't clash), then is
 * renamed over `path`. A reader gets the old file or the new one, never a
 * truncated one; a failed write leaves the old file and no temp file.
 */
export function writeFileAtomic(path, data) {
	const tmp = `${path}.${process.pid}.${threadId}.${count++}.tmp`;
	try {
		writeFileSync(tmp, data);
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}
