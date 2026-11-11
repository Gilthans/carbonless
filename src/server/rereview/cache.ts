import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomicFile.js";
import { cacheDir } from "../paths.js";

/**
 * The engine's results by key (`<from snapshot id>:<to snapshot id>:<versions>`),
 * in memory and on disk under `$XDG_CACHE_HOME/carbonless/rereview/`, so a
 * restart doesn't compute a comparison again. Values are JSON; a file that
 * can't be read or parsed is a miss. Keys are hashed into the file name,
 * so nothing of them reaches the file system.
 */
export class RereviewCache<T> {
	readonly #memory = new Map<string, T>();

	constructor(private readonly dir: string = join(cacheDir(), "rereview")) {}

	#path(key: string): string {
		return join(
			this.dir,
			`${createHash("sha256").update(key).digest("hex")}.json`,
		);
	}

	async get(key: string): Promise<T | null> {
		const kept = this.#memory.get(key);
		if (kept !== undefined) return kept;
		let text: string;
		try {
			text = await readFile(this.#path(key), "utf8");
		} catch {
			return null;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return null;
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			(parsed as { key?: unknown }).key !== key ||
			!("value" in parsed)
		) {
			return null;
		}
		const value = (parsed as { value: T }).value;
		this.#memory.set(key, value);
		return value;
	}

	/** Keeps `value` in memory and on disk (a disk failure keeps the memory copy). */
	async set(key: string, value: T): Promise<void> {
		this.#memory.set(key, value);
		await writeFileAtomic(this.#path(key), JSON.stringify({ key, value }));
	}
}
