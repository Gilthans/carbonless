// Plain ESM so test/fake-gh/gh (a Node script) and the TypeScript test
// helpers share one implementation; atomic.d.mts types it.
import { renameSync, writeFileSync } from "node:fs";

let count = 0;

/**
 * Writes `data` to `path` so that no reader ever sees it half-written: the
 * whole file goes to a temp name in the same directory (unique per process
 * and write, so two gh processes saving at once don't clash), then is
 * renamed over `path`. A reader gets the old file or the new one, never a
 * truncated one.
 */
export function writeFileAtomic(path, data) {
	const tmp = `${path}.${process.pid}.${count++}.tmp`;
	writeFileSync(tmp, data);
	renameSync(tmp, path);
}
