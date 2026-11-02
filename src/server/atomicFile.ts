import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Writes `data` to `path` so no reader ever sees it half-written: to a temp
 * file in the same directory (created with `mode`), then renamed over it.
 */
export async function writeFileAtomic(
	path: string,
	data: string,
	mode = 0o644,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(tmp, data, { mode, flag: "wx" });
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}
