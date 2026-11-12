import { afterEach, describe, expect, it, vi } from "vitest";
import { cpuOf } from "../../../test/cpu";
import type { DiffLine } from "../../shared/types";
import type { Mark } from "../code/Invisibles";
import type { DiffRow } from "./whitespace";
import { hunkWordMarks } from "./wordBlocks";
import { tokenize, wordMarks } from "./wordDiff";
import {
	CHUNK,
	configureWordWork,
	Dropped,
	hunkWords,
	markPairs,
	type Runner,
	requestMarks,
	resetWordWork,
	slicedRunner,
	wordWorkFallback,
} from "./wordWork";

const del = (text: string): DiffLine => ({
	kind: "del",
	text,
	clusterKey: "k",
});
const add = (text: string): DiffLine => ({
	kind: "add",
	text,
	clusterKey: "k",
});
const ctx = (text: string): DiffLine => ({ kind: "context", text });
const rows = (...lines: DiffLine[]): DiffRow[] =>
	lines.map((line) => ({ kind: "line", line }));
/** A block: every removed line, then every added one (pairs i-th with i-th). */
const block = (pairs: readonly (readonly [string, string])[]): DiffRow[] =>
	rows(
		ctx("before"),
		...pairs.map(([a]) => del(a)),
		...pairs.map(([, b]) => add(b)),
		ctx("after"),
	);

/** A small seeded PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Minified-code-like lines (wordDiff.test.ts): short identifiers and
 * punctuation with hardly a space, about 700 tokens in 1,000 characters.
 * Two unrelated ones are the exact diff's worst case under the cut.
 */
function minified(seed: number) {
	const random = rng(seed);
	const pick = <T>(xs: readonly T[]): T =>
		xs[Math.floor(random() * xs.length)] as T;
	const letters = [..."abcdefghijklmnopqrstuvwxyz"];
	const words = letters
		.concat(letters.map((c) => `${c}e`))
		.concat(["Object", "length", "push", "call", "function", "return"]);
	const seps = [..."().,=;{}?:![]+ "].concat(["&&", "||", "===", "=>"]);
	const line = (length: number) => {
		let s = "";
		while (s.length < length) s += pick(words) + pick(seps);
		return s.slice(0, length);
	};
	/** The line with about one token in ten changed. */
	const edit = (text: string) =>
		tokenize(text)
			.map((t) => (random() < 0.1 ? pick(words) : t))
			.join("");
	return { line, edit, random };
}

/** Everything `hunkWords` has for a hunk, as plain data to compare. */
const plain = (marks: ReadonlyMap<DiffLine, readonly Mark[]>) =>
	[...marks].map(([line, m]) => [line.kind, line.text, m]);

/**
 * The hunk's words once nothing is pending: asks for what's left, chunk by
 * chunk, until nothing is.
 */
async function settled(hunk: readonly DiffRow[]) {
	for (;;) {
		const words = hunkWords(hunk);
		if (words.later.length === 0) return words;
		await new Promise<void>((resolve) => {
			const cancel = requestMarks(words.later, () => {
				cancel();
				resolve();
			});
		});
	}
}

/** A runner whose every job waits for its own `release`, kept in `jobs`. */
function heldRunner() {
	const jobs: {
		pairs: (readonly [string, string])[];
		wanted: () => boolean;
		release: () => void;
		fail: (error: unknown) => void;
	}[] = [];
	const runner: Runner = (pairs, wanted) =>
		new Promise((resolve, reject) => {
			jobs.push({
				pairs: [...pairs],
				wanted,
				release: () => resolve(markPairs(pairs)),
				fail: reject,
			});
		});
	return { runner, jobs };
}

/** Lets promise callbacks run (a job's answer reaching the queue). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A clock for the render budget that moves `step` ms over each pair marked
 * in render (it is read once before and once after a pair).
 */
const pairClock = (step: number) => {
	let t = 0;
	let reads = 0;
	return () => {
		reads++;
		if (reads % 2 === 0) t += step;
		return t;
	};
};

/**
 * The wall-clock timeout of the tests that mark hundreds of long pairs
 * (seconds of CPU): a machine loaded with a busy loop per core and other
 * suites stretches that tenfold and more. They gate CPU time or results,
 * never wall time.
 */
const LOADED = 120_000;

afterEach(() => {
	resetWordWork();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("hunkWords", () => {
	// CAR-135: 200 rewritten pairs of unrelated ~1,000-character lines take
	// 1.6–2.9 s of CPU to mark (8–14 ms a pair). Marked in render
	// (hunkWordMarks, before), all of it blocked the page; now the render
	// marks only while its task's budget lasts (8 ms, then the pair under
	// way finishes), and the rest goes off the render path. The yardstick
	// is the same pairs marked in full in this test: hunkWordMarks in its
	// place measures 1.0x. The real clock on purpose: load only lowers the
	// synchronous share (the budget is the wall-clock time spent marking;
	// CPU time is at most that).
	it(
		"marks a rewritten block of 200 unrelated 1,000-character pairs in under a tenth of its CPU, the rest later",
		async () => {
			const { line } = minified(29);
			const pairs = Array.from(
				{ length: 200 },
				() => [line(1000), line(1000)] as const,
			);
			const hunk = block(pairs);
			// The yardstick: every pair marked (new lines, nothing kept).
			const full = cpuOf(() => {
				hunkWordMarks(block(pairs));
			});
			let now: ReturnType<typeof hunkWords> | undefined;
			const sync = cpuOf(() => {
				now = hunkWords(hunk);
			});
			console.info(
				`hunkWords: ${sync} µs CPU in render of ${full} µs in full (${((sync / full) * 100).toFixed(1)}%), ${now?.later.length} pairs later`,
			);
			expect(sync / full).toBeLessThan(0.1);
			expect(now?.later.length).toBeGreaterThan(150);
			// Every line of a pair still to mark says so.
			// (What they end with: the 300-pair test below.)
			expect(now?.pending.size).toBe((now?.later.length ?? 0) * 2);
		},
		LOADED,
	);

	it("marks in render until the task's budget is spent, by the clock it reads", async () => {
		const { runner, jobs } = heldRunner();
		// 5 ms a pair against 8: the first two pairs, then none.
		configureWordWork({ runner, now: pairClock(5) });
		const pairs = Array.from(
			{ length: 6 },
			(_, i) => [`a = ${i}`, `a = ${i + 1}`] as const,
		);
		const hunk = block(pairs);
		const words = hunkWords(hunk);
		expect(words.later.map(([d]) => d.text)).toEqual(
			pairs.slice(2).map(([a]) => a),
		);
		// The same task's next hunk gets nothing more.
		expect(hunkWords(block([["b = 1", "b = 2"]])).later).toHaveLength(1);
		// A new task, a new budget.
		await flush();
		expect(hunkWords(block([["c = 1", "c = 2"]])).later).toEqual([]);
		expect(jobs).toEqual([]);
	});

	it("marks cheap pairs in render: nothing pending, nothing sent", () => {
		const { runner, jobs } = heldRunner();
		// 0.05 ms a pair: 100 pairs in half the budget.
		configureWordWork({ runner, now: pairClock(0.05) });
		const pairs = Array.from(
			{ length: 100 },
			(_, i) =>
				[`const userCount${i} = 1;`, `const memberCount${i} = 1;`] as const,
		);
		const hunk = block(pairs);
		const words = hunkWords(hunk);
		expect(words.later).toEqual([]);
		expect(words.pending.size).toBe(0);
		expect(plain(words.marks)).toEqual(plain(hunkWordMarks(hunk)));
		expect(jobs).toEqual([]);
	});

	it(
		"marks later exactly what it would mark in render, for any pair (300 seeded pairs)",
		async () => {
			const { line, edit, random } = minified(31);
			const blanks = [" ", "\t", "  ", ""];
			const pairs: (readonly [string, string])[] = [];
			for (let i = 0; i < 300; i++) {
				const length = [5, 40, 120, 600, 1023, 1024, 1500][i % 7] as number;
				const a = line(length);
				const kind = Math.floor(random() * 5);
				const b =
					kind === 0
						? line(length)
						: kind === 1
							? edit(a)
							: kind === 2
								? `${blanks[i % 4]}${a}${blanks[(i + 1) % 4]}`
								: kind === 3
									? `${edit(a)}\r`
									: a;
				pairs.push([a, b]);
			}
			// Nothing in render: every pair goes the other way.
			configureWordWork({ budgetMs: 0 });
			const hunk = block(pairs);
			const before = hunkWords(hunk);
			expect(before.marks.size).toBe(0);
			expect(before.later).toHaveLength(300);
			const after = await settled(hunk);
			expect(after.failed.size).toBe(0);
			expect(plain(after.marks)).toEqual(plain(hunkWordMarks(hunk)));
			// The worker's function is wordMarks, pair by pair.
			expect(markPairs(pairs)).toEqual(pairs.map(([a, b]) => wordMarks(a, b)));
		},
		LOADED,
	);

	it("keeps done pairs: the hunk's rows again (a toggle) mark nothing anew, and a pair on its way isn't sent twice", async () => {
		const { runner, jobs } = heldRunner();
		configureWordWork({ budgetMs: 0, runner });
		const d = del("let a = 1;");
		const a = add("let a = 2;");
		const first = hunkWords(rows(d, a));
		expect([...first.pending]).toEqual([d, a]);
		const progress = vi.fn();
		requestMarks(first.later, progress);
		// A toggle while it's on its way: the pair isn't sent twice.
		const again = vi.fn();
		requestMarks(hunkWords(rows(ctx("x"), d, a)).later, again);
		expect(jobs).toHaveLength(1);
		jobs[0]?.release();
		await flush();
		expect(progress).toHaveBeenCalledTimes(1);
		expect(again).toHaveBeenCalledTimes(1);
		// The same lines in new rows: done, without the runner.
		const next = hunkWords(rows(ctx("x"), d, a, ctx("y")));
		expect(next.pending.size).toBe(0);
		expect(next.later).toEqual([]);
		expect(next.marks.get(d)).toEqual([[8, 9]]);
		expect(jobs).toHaveLength(1);
	});

	it(`sends ${CHUNK} pairs at a time, one job after another, each shown when done`, async () => {
		const { runner, jobs } = heldRunner();
		configureWordWork({ budgetMs: 0, runner });
		const pairs = Array.from(
			{ length: 2 * CHUNK + 5 },
			(_, i) => [`x = ${i}`, `x = ${i + 1}`] as const,
		);
		const hunk = block(pairs);
		const progress = vi.fn();
		requestMarks(hunkWords(hunk).later, progress);
		// One at a time.
		expect(jobs.map((j) => j.pairs.length)).toEqual([CHUNK]);
		jobs[0]?.release();
		await flush();
		expect(progress).toHaveBeenCalledTimes(1);
		// The first chunk's pairs are in, the rest still pending.
		expect(hunkWords(hunk).later).toHaveLength(CHUNK + 5);
		expect(jobs.map((j) => j.pairs.length)).toEqual([CHUNK, CHUNK]);
		jobs[1]?.release();
		await flush();
		jobs[2]?.release();
		await flush();
		expect(jobs.map((j) => j.pairs.length)).toEqual([CHUNK, CHUNK, 5]);
		expect(progress).toHaveBeenCalledTimes(3);
		expect(hunkWords(hunk).pending.size).toBe(0);
	});

	it("drops the chunks nobody waits for (a file closed) and sends them again when asked", async () => {
		const { runner, jobs } = heldRunner();
		configureWordWork({ budgetMs: 0, runner });
		const pairs = Array.from(
			{ length: 3 * CHUNK },
			(_, i) => [`y = ${i}`, `y = ${i + 1}`] as const,
		);
		const closed = block(pairs);
		const cancel = requestMarks(hunkWords(closed).later, () => {});
		// The open file's hunk, asked after.
		const open = block([["z = 1", "z = 2"]]);
		const shown = vi.fn();
		requestMarks(hunkWords(open).later, shown);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.wanted()).toBe(true);
		cancel();
		// The running job is told; the queued two are skipped.
		expect(jobs[0]?.wanted()).toBe(false);
		jobs[0]?.release();
		await flush();
		expect(jobs.map((j) => j.pairs)).toEqual([
			pairs.slice(0, CHUNK),
			[["z = 1", "z = 2"]],
		]);
		jobs[1]?.release();
		await flush();
		expect(shown).toHaveBeenCalledTimes(1);
		// Back to the closed file: what wasn't marked is asked for again.
		const back = hunkWords(closed);
		expect(back.later).toHaveLength(2 * CHUNK);
		requestMarks(back.later, () => {});
		expect(jobs.map((j) => j.pairs.length)).toEqual([CHUNK, 1, CHUNK]);
	});
});

describe("a caller always hears", () => {
	it("says so when pairs it saw pending were done before it asked (a hunk remounted while its chunk was out)", async () => {
		const { runner, jobs } = heldRunner();
		configureWordWork({ budgetMs: 0, runner });
		const hunk = block([["a = 1", "a = 2"]]);
		// Mounted: asks, then unmounts while the chunk is out.
		const cancel = requestMarks(hunkWords(hunk).later, () => {});
		cancel();
		// Remounted: sees the pair pending...
		const words = hunkWords(hunk);
		expect(words.later).toHaveLength(1);
		// ...and the chunk answers before it asks.
		jobs[0]?.release();
		await flush();
		const progress = vi.fn();
		requestMarks(words.later, progress);
		await flush();
		expect(progress).toHaveBeenCalledTimes(1);
		expect(hunkWords(hunk).pending.size).toBe(0);
		expect(jobs).toHaveLength(1);
	});

	it("not after the caller cancelled", async () => {
		configureWordWork({ budgetMs: Number.POSITIVE_INFINITY });
		const d = del("a = 1");
		const a = add("a = 2");
		expect(hunkWords(rows(d, a)).marks.size).toBe(2);
		const progress = vi.fn();
		// Done already, asked for anyway, then cancelled at once.
		requestMarks([[d, a]], progress)();
		await flush();
		expect(progress).not.toHaveBeenCalled();
	});
});

describe("failures settle", () => {
	it("a failure never takes away marks a pair got meanwhile (in render)", async () => {
		for (const how of ["rejected", "missing"] as const) {
			resetWordWork();
			const { runner, jobs } = heldRunner();
			configureWordWork({
				budgetMs: 0,
				runner: how === "rejected" ? runner : async () => [] as never,
			});
			const hunk = block([["a = 1", "a = 2"]]);
			const progress = vi.fn();
			requestMarks(hunkWords(hunk).later, progress);
			// The same pair marked in render while its chunk is out.
			configureWordWork({ budgetMs: Number.POSITIVE_INFINITY });
			expect(hunkWords(hunk).marks.size).toBe(2);
			if (how === "rejected") jobs[0]?.fail(new Error("no"));
			await flush();
			expect(progress).toHaveBeenCalled();
			const after = hunkWords(hunk);
			expect(after.failed.size, how).toBe(0);
			expect(after.marks.size, how).toBe(2);
		}
	});

	const pairs = [
		["const userCount = 1;", "const memberCount = 1;"],
		["a\tb", "a  b"],
	] as const;

	it("a failed job fails its pairs for good: warned, never pending, never plain", async () => {
		const { runner, jobs } = heldRunner();
		configureWordWork({ budgetMs: 0, runner });
		const hunk = block(pairs);
		const progress = vi.fn();
		requestMarks(hunkWords(hunk).later, progress);
		jobs[0]?.fail(new Error("no"));
		await flush();
		expect(progress).toHaveBeenCalledTimes(1);
		const words = hunkWords(hunk);
		expect(words.later).toEqual([]);
		expect(words.pending.size).toBe(0);
		expect(words.failed.size).toBe(4);
		expect(words.marks.size).toBe(0);
		// Not sent again.
		requestMarks(words.later, () => {});
		expect(jobs).toHaveLength(1);
	});

	it("a pair missing from a job's answer is failed, not plain", async () => {
		configureWordWork({
			budgetMs: 0,
			runner: async (ps) => markPairs(ps).slice(0, 1),
		});
		const hunk = block(pairs);
		const words = await settled(hunk);
		expect(words.failed.size).toBe(2);
		expect(words.marks.size).toBe(2);
	});

	it("on the main thread, a pair that throws rejects the run (it settles)", async () => {
		const bad = [null as unknown as string, "x"] as const;
		await expect(slicedRunner([pairs[0], bad], () => true)).rejects.toThrow();
	});

	it("a pair that throws in render is failed", () => {
		const hunk = rows(
			{ kind: "del", text: null as unknown as string, clusterKey: "k" },
			add("x"),
		);
		expect(hunkWords(hunk).failed.size).toBe(2);
	});
});

describe("the runners", () => {
	const pairs = [
		["const userCount = 1;", "const memberCount = 1;"],
		["a\tb", "a  b"],
	] as const;

	it("marks in main-thread slices when there is no worker", async () => {
		expect(await slicedRunner(pairs, () => true)).toEqual(markPairs(pairs));
	});

	it("stops between slices once nobody waits", async () => {
		await expect(slicedRunner(pairs, () => false)).rejects.toBeInstanceOf(
			Dropped,
		);
	});

	it("says when it falls back to the main thread for want of a worker", async () => {
		const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
		configureWordWork({ budgetMs: 0 });
		expect(wordWorkFallback()).toBeNull();
		await settled(block(pairs));
		expect(wordWorkFallback()).toBe("no worker");
		expect(debug).toHaveBeenCalledWith(
			"word marks: main-thread fallback (no worker)",
		);
	});

	/** A stand-in Worker: runs the worker's message protocol in this thread. */
	class FakeWorker {
		onmessage: ((event: { data: unknown }) => void) | null = null;
		onerror: ((event: unknown) => void) | null = null;
		onmessageerror: ((event: unknown) => void) | null = null;
		constructor(
			readonly url: URL,
			readonly options: { type: string },
		) {}
		postMessage(data: { id: number; pairs: [string, string][] }) {
			setTimeout(() => {
				let answer: object;
				try {
					answer = { id: data.id, marks: markPairs(data.pairs) };
				} catch (error) {
					answer = { id: data.id, error: String(error) };
				}
				this.onmessage?.({ data: answer });
			});
		}
		terminate() {}
	}

	it("sends the pairs to one worker, as a module, and takes its marks", async () => {
		const made: FakeWorker[] = [];
		vi.stubGlobal(
			"Worker",
			class extends FakeWorker {
				constructor(url: URL, options: { type: string }) {
					super(url, options);
					made.push(this);
				}
			},
		);
		configureWordWork({ budgetMs: 0 });
		const hunk = block(pairs);
		await settled(hunk);
		await settled(block([["x = 1", "x = 2"]]));
		expect(made).toHaveLength(1);
		expect(made[0]?.url.pathname).toMatch(/wordWorker\.ts$/);
		expect(made[0]?.options).toEqual({ type: "module" });
		expect(plain(hunkWords(hunk).marks)).toEqual(plain(hunkWordMarks(hunk)));
		expect(wordWorkFallback()).toBeNull();
	});

	it("a job that fails in the worker fails its pairs, and the worker stays", async () => {
		vi.stubGlobal("Worker", FakeWorker);
		configureWordWork({ budgetMs: 0 });
		const bad = rows(
			{ kind: "del", text: null as unknown as string, clusterKey: "k" },
			add("x"),
		);
		expect((await settled(bad)).failed.size).toBe(2);
		expect(wordWorkFallback()).toBeNull();
		const hunk = block(pairs);
		expect(plain((await settled(hunk)).marks)).toEqual(
			plain(hunkWordMarks(hunk)),
		);
	});

	it("marks on the main thread when the worker fails, and says so", async () => {
		const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
		vi.stubGlobal(
			"Worker",
			class extends FakeWorker {
				override postMessage() {
					setTimeout(() => this.onerror?.(new Error("boom")));
				}
			},
		);
		configureWordWork({ budgetMs: 0 });
		const hunk = block(pairs);
		const words = await settled(hunk);
		expect(words.failed.size).toBe(0);
		expect(plain(words.marks)).toEqual(plain(hunkWordMarks(hunk)));
		expect(wordWorkFallback()).toBe("worker failed");
		expect(debug).toHaveBeenCalledWith(
			"word marks: main-thread fallback (worker failed)",
		);
		// A later job doesn't wait on the failed worker.
		const next = block([["x = 1", "x = 2"]]);
		expect(plain((await settled(next)).marks)).toEqual(
			plain(hunkWordMarks(next)),
		);
	});

	it("a runner that rejects outright fails its pairs (no pending forever)", async () => {
		const failing: Runner = async () => {
			throw new Error("no");
		};
		configureWordWork({ budgetMs: 0, runner: failing });
		const words = await settled(block(pairs));
		expect(words.failed.size).toBe(4);
		expect(words.pending.size).toBe(0);
	});

	it("a runner that throws (not even a promise) fails its pairs", async () => {
		const throwing = (() => {
			throw new Error("sync");
		}) as unknown as Runner;
		configureWordWork({ budgetMs: 0, runner: throwing });
		const words = await settled(block(pairs));
		expect(words.failed.size).toBe(4);
	});
});
