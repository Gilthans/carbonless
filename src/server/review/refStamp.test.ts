import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheDir } from "../paths";
import { pruneOlderThan, refStamp, refsChanged } from "./refStamp";

// Pass-through spy, so a test can make the stamp's rename fail.
vi.mock("node:fs/promises", async (importOriginal) => {
	const fsp = await importOriginal<typeof import("node:fs/promises")>();
	return { ...fsp, rename: vi.fn(fsp.rename) };
});
const renames = vi.mocked(rename);

const held = () =>
	Object.assign(new Error("EPERM: operation not permitted, rename"), {
		code: "EPERM",
	});

describe("refStamp (CAR-326)", () => {
	let repo: string;
	let real: typeof rename;
	beforeEach(async () => {
		repo = mkdtempSync(join(tmpdir(), "crb-stamp-"));
		real = (
			await vi.importActual<typeof import("node:fs/promises")>(
				"node:fs/promises",
			)
		).rename;
		renames.mockReset();
		renames.mockImplementation(real);
	});
	afterEach(() => {
		renames.mockReset();
		renames.mockImplementation(real);
		rmSync(repo, { recursive: true, force: true });
	});

	it("a rename another program holds for a moment is tried again", async () => {
		const before = await refStamp(repo);
		renames
			.mockRejectedValueOnce(held())
			.mockRejectedValueOnce(held())
			.mockImplementation(real);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await refsChanged(repo);
			expect(renames).toHaveBeenCalledTimes(3);
			expect(errors).not.toHaveBeenCalled();
		} finally {
			errors.mockRestore();
		}
		expect(await refStamp(repo)).not.toBe(before);
		// No temporary file left behind.
		const left = await readdir(join(cacheDir(), "ref-stamps"));
		expect(left.filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});

	it("a stamp file that can't be written is logged, and this process's own write still changes the stamp", async () => {
		const before = await refStamp(repo);
		renames.mockRejectedValue(held());
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await refsChanged(repo);
			expect(errors).toHaveBeenCalledTimes(1);
			expect(String(errors.mock.calls[0]?.[0])).toContain("couldn't stamp");
		} finally {
			errors.mockRestore();
		}
		const after = await refStamp(repo);
		expect(after).not.toBeNull();
		expect(after).not.toBe(before);
	});

	it("drops crb's own files untouched for the age given, and only those", async () => {
		const dir = join(repo, "files");
		mkdirSync(dir);
		const now = Date.now();
		for (const [name, ageDays] of [
			["old", 31],
			["old.tmp", 40],
			["new", 1],
		] as const) {
			writeFileSync(join(dir, name), "x");
			const t = (now - ageDays * 86_400_000) / 1000;
			utimesSync(join(dir, name), t, t);
		}
		mkdirSync(join(dir, "sub"));
		await pruneOlderThan(dir, 30 * 86_400_000, now);
		expect((await readdir(dir)).sort()).toEqual(["new", "sub"]);
	});
});
