import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RENAME_BACKOFF as HELPER_BACKOFF } from "../../test/fake-gh/atomic.mjs";
import { RENAME_BACKOFF, writeFileAtomic } from "./atomicFile.js";

describe("writeFileAtomic", () => {
	let dir: string;
	let path: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-atomic-file-"));
		path = join(dir, "config.json");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * A rename that fails with `code` the first `times` calls, then renames,
	 * on the given platform, with the waits recorded, not slept.
	 */
	const busyRename = (code: string, times: number, platform = "win32") => {
		const calls: string[] = [];
		const waits: number[] = [];
		return {
			calls,
			waits,
			options: {
				platform,
				sleep: async (ms: number) => {
					waits.push(ms);
				},
				rename: async (from: string, to: string) => {
					calls.push(from);
					if (calls.length <= times)
						throw Object.assign(new Error(`${code}: rename`), { code });
					await rename(from, to);
				},
			},
		};
	};

	const read = () => JSON.parse(readFileSync(path, "utf8"));

	it("writes the file and leaves nothing else behind", async () => {
		await writeFileAtomic(path, '{"n":1}');
		await writeFileAtomic(path, '{"n":2}');
		expect(read()).toEqual({ n: 2 });
		expect(readdirSync(dir)).toEqual(["config.json"]);
	});

	// Windows can't rename over a file another process (Defender, an
	// indexer, an editor, another crb) has open for a moment.
	it.each(["EPERM", "EACCES", "EBUSY"])(
		"on Windows, a rename that fails with %s while the file is busy is tried again",
		async (code) => {
			await writeFileAtomic(path, '{"n":1}');
			const busy = busyRename(code, 2);
			await writeFileAtomic(path, '{"n":2}', undefined, busy.options);
			expect(busy.calls).toHaveLength(3);
			expect(busy.waits).toEqual(RENAME_BACKOFF.slice(0, 2));
			expect(read()).toEqual({ n: 2 });
			expect(readdirSync(dir)).toEqual(["config.json"]);
		},
	);

	it("on Windows, a rename that stays busy fails after the backoff, keeping the old file and removing the temp file", async () => {
		await writeFileAtomic(path, '{"n":1}');
		const busy = busyRename("EPERM", Number.POSITIVE_INFINITY);
		await expect(
			writeFileAtomic(path, '{"n":2}', undefined, busy.options),
		).rejects.toThrow(/EPERM/);
		expect(busy.calls).toHaveLength(RENAME_BACKOFF.length + 1);
		expect(busy.waits).toEqual(RENAME_BACKOFF);
		expect(read()).toEqual({ n: 1 });
		expect(readdirSync(dir)).toEqual(["config.json"]);
	});

	it("any other rename error fails at once, on Windows too", async () => {
		const busy = busyRename("ENOENT", 1);
		await expect(
			writeFileAtomic(path, "{}", undefined, busy.options),
		).rejects.toThrow(/ENOENT/);
		expect(busy.calls).toHaveLength(1);
		expect(busy.waits).toEqual([]);
		expect(readdirSync(dir)).toEqual([]);
	});

	it.each(["linux", "darwin"])(
		"on %s, EPERM, EACCES and EBUSY are real errors and fail at once",
		async (platform) => {
			for (const code of ["EPERM", "EACCES", "EBUSY"]) {
				const busy = busyRename(code, 1, platform);
				await expect(
					writeFileAtomic(path, "{}", undefined, busy.options),
				).rejects.toThrow(code);
				expect(busy.calls).toHaveLength(1);
				expect(busy.waits).toEqual([]);
			}
			expect(readdirSync(dir)).toEqual([]);
		},
	);

	it.skipIf(process.platform === "win32")("keeps the file's mode", async () => {
		await writeFileAtomic(path, "{}", 0o600);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	// The test helper (test/fake-gh/atomic.mjs) can't import TypeScript from
	// src, and the server can't ship test/: two copies, kept the same here.
	it("waits as long as the test helper's rename retry", () => {
		expect(RENAME_BACKOFF).toEqual(HELPER_BACKOFF);
	});
});
