import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestSpecification } from "vitest/node";
import {
	checkRefresh,
	fileDurations,
	mergeDurations,
	writeDurations,
} from "./durations";
import type { Span } from "./load";
import {
	compareFiles,
	DURATIONS_FILE,
	readDurations,
	repoPath,
	SlowFirstSequencer,
} from "./sequencer.mjs";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A tree of test files (path → size in bytes) with a hint list. */
function tree(files: Record<string, number>, hints?: unknown): string {
	const root = mkdtempSync(join(tmpdir(), "crb-sequencer-test-"));
	dirs.push(root);
	for (const [file, size] of Object.entries(files)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), "x".repeat(size));
	}
	if (hints !== undefined) {
		mkdirSync(dirname(join(root, DURATIONS_FILE)), { recursive: true });
		writeFileSync(
			join(root, DURATIONS_FILE),
			typeof hints === "string" ? hints : JSON.stringify(hints),
		);
	}
	return root;
}

type Cached = { duration: number; failed: boolean };

/** The sequencer's order of `files` in `root`, with Vitest's cache. */
async function order(
	root: string,
	files: string[],
	cache: Record<string, Cached> = {},
): Promise<string[]> {
	const project = {
		name: "",
		config: { sequence: { groupOrder: 0 }, isolate: true },
	};
	const specs = files.map((f) => ({ moduleId: join(root, f), project }));
	const ctx = {
		config: { root },
		cache: {
			getTestSpecificationResult: (spec: { moduleId: string }) =>
				cache[spec.moduleId.slice(root.length + 1)],
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: a stand-in for Vitest's context.
	const sequencer = new SlowFirstSequencer(ctx as any);
	const sorted = await sequencer.sort(specs as unknown as TestSpecification[]);
	return sorted.map((s) => s.moduleId.slice(root.length + 1));
}

describe("SlowFirstSequencer", () => {
	it("starts a slow small file before big fast ones without a cache (the methodology stubs)", async () => {
		const root = tree(
			{ "big.test.ts": 9000, "mid.test.ts": 5000, "stub.test.ts": 80 },
			{ "big.test.ts": 900, "mid.test.ts": 2000, "stub.test.ts": 20000 },
		);
		expect(
			await order(root, ["big.test.ts", "mid.test.ts", "stub.test.ts"]),
		).toEqual(["stub.test.ts", "mid.test.ts", "big.test.ts"]);
	});

	it("prefers the cache's duration to the hint", async () => {
		const root = tree(
			{ "a.test.ts": 10, "b.test.ts": 10 },
			{ "a.test.ts": 100, "b.test.ts": 5000 },
		);
		const cache = {
			"a.test.ts": { duration: 9000, failed: false },
			"b.test.ts": { duration: 50, failed: false },
		};
		expect(await order(root, ["b.test.ts", "a.test.ts"], cache)).toEqual([
			"a.test.ts",
			"b.test.ts",
		]);
	});

	it("starts a file that failed last time first", async () => {
		const root = tree(
			{ "slow.test.ts": 10, "failed.test.ts": 10 },
			{ "slow.test.ts": 9000 },
		);
		const cache = { "failed.test.ts": { duration: 10, failed: true } };
		expect(
			await order(root, ["slow.test.ts", "failed.test.ts"], cache),
		).toEqual(["failed.test.ts", "slow.test.ts"]);
	});

	it("mixes cached and hinted durations, then sizes for unlisted files", async () => {
		const root = tree(
			{
				"cached.test.ts": 10,
				"hinted.test.ts": 10,
				"new-big.test.ts": 8000,
				"new-small.test.ts": 100,
			},
			{ "hinted.test.ts": 3000 },
		);
		const cache = { "cached.test.ts": { duration: 2000, failed: false } };
		expect(
			await order(
				root,
				[
					"new-small.test.ts",
					"cached.test.ts",
					"new-big.test.ts",
					"hinted.test.ts",
				],
				cache,
			),
		).toEqual([
			"hinted.test.ts",
			"cached.test.ts",
			"new-big.test.ts",
			"new-small.test.ts",
		]);
	});

	it("falls back to size, largest first, with no list or a broken one", async () => {
		for (const hints of [undefined, "{not json", { "a.test.ts": "slow" }]) {
			const root = tree({ "a.test.ts": 10, "b.test.ts": 500 }, hints);
			expect(await order(root, ["a.test.ts", "b.test.ts"])).toEqual([
				"b.test.ts",
				"a.test.ts",
			]);
		}
	});

	it("keeps sharding: each file in exactly one shard", async () => {
		const root = tree({});
		const project = {
			name: "",
			config: { sequence: { groupOrder: 0 }, isolate: true },
		};
		const specs = Array.from({ length: 7 }, (_, i) => ({
			moduleId: join(root, `f${i}.test.ts`),
			project,
		}));
		const seen: string[] = [];
		for (const index of [1, 2, 3]) {
			const ctx = { config: { root, shard: { index, count: 3 } } };
			// biome-ignore lint/suspicious/noExplicitAny: a stand-in for Vitest's context.
			const sequencer = new SlowFirstSequencer(ctx as any);
			const shard = await sequencer.shard(
				specs as unknown as TestSpecification[],
			);
			seen.push(...shard.map((s) => s.moduleId));
		}
		expect(seen.sort()).toEqual(specs.map((s) => s.moduleId).sort());
	});
});

describe("repoPath", () => {
	it("keys a nested file with forward slashes on Windows too", () => {
		expect(
			repoPath("C:\\repo", "C:\\repo\\src\\server\\a.test.ts", path.win32),
		).toBe("src/server/a.test.ts");
		expect(repoPath("/repo", "/repo/src/server/a.test.ts", path.posix)).toBe(
			"src/server/a.test.ts",
		);
	});
});

describe("compareFiles", () => {
	it("puts known durations before unknown ones, whatever the size", () => {
		expect(compareFiles({ hint: 100 }, { size: 1e6 })).toBeLessThan(0);
		expect(compareFiles({ size: 1e6 }, { hint: 100 })).toBeGreaterThan(0);
	});
});

describe("the duration list", () => {
	const span = (file: string, ms: number, service = "vitest"): Span => ({
		traceId: "t",
		spanId: file,
		parent: null,
		name: `file: ${file}`,
		service,
		startMs: 1000,
		endMs: 1000 + ms,
		attrs: { "crb.kind": "file", "test.file": file },
		error: false,
	});

	it("keys a Windows run's backslash paths with forward slashes", () => {
		expect(fileDurations([span("src\\server\\a.test.ts", 2000)])).toEqual({
			"src/server/a.test.ts": 2000,
		});
	});

	it("reads each unit file's span, rounded, the longest when run twice", () => {
		expect(
			fileDurations([
				span("b.test.ts", 1234),
				span("a.test.ts", 20),
				span("b.test.ts", 4567),
				span("e2e.spec.ts", 9999, "e2e"),
			]),
		).toEqual({ "a.test.ts": 100, "b.test.ts": 4600 });
	});

	it("merges a partial run: updates what ran, keeps the rest, drops deleted files", () => {
		const merged = mergeDurations(
			{ "kept.test.ts": 300, "gone.test.ts": 400, "ran.test.ts": 500 },
			{ "ran.test.ts": 900, "added.test.ts": 200 },
			(f) => f !== "gone.test.ts",
		);
		expect(merged).toEqual({
			"added.test.ts": 200,
			"kept.test.ts": 300,
			"ran.test.ts": 900,
		});
		expect(Object.keys(merged)).toEqual([
			"added.test.ts",
			"kept.test.ts",
			"ran.test.ts",
		]);
	});

	it("reads the checked-in list's numbers only", () => {
		const root = tree({}, { "a.test.ts": 100, "b.test.ts": "x" });
		expect(readDurations(root)).toEqual({ "a.test.ts": 100 });
	});
});

describe("refreshing the list", () => {
	const listed = Object.fromEntries(
		Array.from({ length: 20 }, (_, i) => [`f${i}.test.ts`, 3000]),
	);
	const all = () => true;

	it("accepts a full run whose times moved within load noise", () => {
		const run = Object.fromEntries(
			Object.keys(listed).map((f, i) => [f, i % 2 ? 1500 : 6000]),
		);
		expect(checkRefresh(listed, run, all).problems).toEqual([]);
	});

	it("refuses a run of a few files (pnpm test <file>, flake-check)", () => {
		const { problems } = checkRefresh(
			listed,
			{ "f0.test.ts": 3000, "f1.test.ts": 3100 },
			all,
		);
		expect(problems).toEqual(["the run covers 2 of the 20 listed files"]);
	});

	it("counts only listed files still in the tree", () => {
		const gone = (f: string) => Number(f.slice(1, -8)) < 2;
		expect(
			checkRefresh(listed, { "f0.test.ts": 3000, "f1.test.ts": 3000 }, gone)
				.problems,
		).toEqual([]);
	});

	it("refuses a filtered (-t) run: every file, most times far down", () => {
		const run = Object.fromEntries(Object.keys(listed).map((f) => [f, 200]));
		expect(checkRefresh(listed, run, all).problems).toEqual([
			"20 of 20 files took under a third of their listed time",
		]);
	});

	it("lists the biggest changes first", () => {
		const run = { ...listed, "f3.test.ts": 9000, "f4.test.ts": 2000 };
		expect(checkRefresh(listed, run, all).changes.slice(0, 2)).toEqual([
			["f3.test.ts", 3000, 9000],
			["f4.test.ts", 3000, 2000],
		]);
	});

	const spanOf = (file: string, ms: number): Span => ({
		traceId: "t",
		spanId: file,
		parent: null,
		name: `file: ${file}`,
		service: "vitest",
		startMs: 0,
		endMs: ms,
		attrs: { "crb.kind": "file", "test.file": file },
		error: false,
	});

	it("writes nothing for a partial run unless forced", () => {
		const files = Object.fromEntries(Object.keys(listed).map((f) => [f, 10]));
		const root = tree(files, listed);
		expect(() => writeDurations(root, [spanOf("f0.test.ts", 9000)])).toThrow(
			/not refreshing .*covers 1 of the 20 listed files[\s\S]*3\.0s → 9\.0s {2}f0\.test\.ts/,
		);
		expect(readDurations(root)).toEqual(listed);
		writeDurations(root, [spanOf("f0.test.ts", 9000)], true);
		expect(readDurations(root)).toEqual({ ...listed, "f0.test.ts": 9000 });
	});
});
