import { afterEach, describe, expect, it, vi } from "vitest";
import { cpuOf } from "../../../test/cpu";
import type { DiffLine } from "../../shared/types";
import type { Mark } from "../code/Invisibles";
import type { DiffRow } from "./whitespace";
import { hunkWordMarks } from "./wordBlocks";
import { tokenize, wordMarks } from "./wordDiff";
import {
	configureWordWork,
	hunkWords,
	markLater,
	markPairs,
	type PairMarks,
	type Runner,
	resetWordWork,
	slicedRunner,
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

/** A runner that waits for `release`, counting what it was sent. */
function heldRunner() {
	const sent: (readonly [string, string])[][] = [];
	let open: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	const runner: Runner = async (pairs) => {
		sent.push([...pairs]);
		await gate;
		return markPairs(pairs);
	};
	return { runner, sent, release: () => open() };
}

afterEach(() => {
	resetWordWork();
	vi.unstubAllGlobals();
});

describe("hunkWords", () => {
	// CAR-135: 200 rewritten pairs of unrelated ~1,000-character lines take
	// 1.6–2.8 s of CPU to mark (8–14 ms a pair). Marked in render
	// (hunkWordMarks, before), all of it blocked the page; now the render
	// marks only while its task's budget lasts (8 ms, then the pair under
	// way finishes), and the rest goes off the render path. The yardstick
	// is the same pairs marked in full in this test: hunkWordMarks in its
	// place measures 1.0x. Load only lowers the synchronous share (the
	// budget is the wall-clock time spent marking; CPU time is at most that).
	it("marks a rewritten block of 200 unrelated 1,000-character pairs in under a tenth of its CPU, the rest later", async () => {
		const { line } = minified(29);
		const pairs = Array.from(
			{ length: 200 },
			() => [line(1000), line(1000)] as const,
		);
		const hunk = block(pairs);
		// The yardstick: every pair marked (new lines, nothing kept).
		let fullMarks: ReturnType<typeof hunkWordMarks> = new Map();
		const full = cpuOf(() => {
			fullMarks = hunkWordMarks(block(pairs));
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
		expect(now?.pending.size).toBe((now?.later.length ?? 0) * 2);
		await markLater(now?.later ?? []);
		const after = hunkWords(hunk);
		expect(after.later).toEqual([]);
		expect(after.pending.size).toBe(0);
		expect(plain(after.marks)).toEqual(plain(fullMarks));
	}, 60_000);

	it("marks cheap pairs in render: nothing pending, nothing sent", async () => {
		const { runner, sent } = heldRunner();
		configureWordWork({ runner });
		const hunk = block([
			["const userCount = 1;", "const memberCount = 1;"],
			["a = 1", "a = 2"],
		]);
		const words = hunkWords(hunk);
		expect(words.later).toEqual([]);
		expect(words.pending.size).toBe(0);
		expect(plain(words.marks)).toEqual(plain(hunkWordMarks(hunk)));
		expect(sent).toEqual([]);
	});

	it("marks later exactly what it would mark in render, for any pair (300 seeded pairs)", async () => {
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
		await markLater(before.later);
		expect(plain(hunkWords(hunk).marks)).toEqual(plain(hunkWordMarks(hunk)));
		// The worker's function is wordMarks, pair by pair.
		expect(markPairs(pairs)).toEqual(pairs.map(([a, b]) => wordMarks(a, b)));
	});

	it("keeps done pairs: the hunk's rows again (a toggle) mark nothing anew", async () => {
		configureWordWork({ budgetMs: 0 });
		const d = del("let a = 1;");
		const a = add("let a = 2;");
		const first = hunkWords(rows(d, a));
		expect([...first.pending]).toEqual([d, a]);
		const { runner, sent, release } = heldRunner();
		configureWordWork({ runner });
		const done = markLater(first.later);
		// A toggle while it's on its way: the pair isn't sent twice.
		const again = markLater(hunkWords(rows(ctx("x"), d, a)).later);
		expect(sent).toHaveLength(1);
		release();
		await Promise.all([done, again]);
		// The same lines in new rows: done, without the runner.
		const next = hunkWords(rows(ctx("x"), d, a, ctx("y")));
		expect(next.pending.size).toBe(0);
		expect(next.later).toEqual([]);
		expect(next.marks.get(d)).toEqual([[8, 9]]);
		expect(sent).toHaveLength(1);
	});
});

describe("the runners", () => {
	const pairs = [
		["const userCount = 1;", "const memberCount = 1;"],
		["a\tb", "a  b"],
	] as const;

	it("marks in main-thread slices when there is no worker", async () => {
		expect(await slicedRunner(pairs)).toEqual(markPairs(pairs));
	});

	/** A stand-in Worker: runs the worker's message protocol in this thread. */
	class FakeWorker {
		static made = 0;
		onmessage: ((event: { data: unknown }) => void) | null = null;
		onerror: ((event: unknown) => void) | null = null;
		onmessageerror: ((event: unknown) => void) | null = null;
		constructor(
			readonly url: URL,
			readonly options: { type: string },
		) {
			FakeWorker.made++;
		}
		postMessage(data: { id: number; pairs: [string, string][] }) {
			setTimeout(() =>
				this.onmessage?.({
					data: { id: data.id, marks: markPairs(data.pairs) },
				}),
			);
		}
		terminate() {}
	}

	it("sends the pairs to one worker, as a module, and takes its marks", async () => {
		FakeWorker.made = 0;
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
		await markLater(hunkWords(hunk).later);
		await markLater(hunkWords(block([["x = 1", "x = 2"]])).later);
		expect(made).toHaveLength(1);
		expect(made[0]?.url.pathname).toMatch(/wordWorker\.ts$/);
		expect(made[0]?.options).toEqual({ type: "module" });
		expect(plain(hunkWords(hunk).marks)).toEqual(plain(hunkWordMarks(hunk)));
	});

	it("marks on the main thread when the worker fails", async () => {
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
		await markLater(hunkWords(hunk).later);
		expect(plain(hunkWords(hunk).marks)).toEqual(plain(hunkWordMarks(hunk)));
		// A later job doesn't wait on the failed worker.
		const next = block([["x = 1", "x = 2"]]);
		await markLater(hunkWords(next).later);
		expect(plain(hunkWords(next).marks)).toEqual(plain(hunkWordMarks(next)));
	});

	it("a job that fails isn't kept as on its way", async () => {
		let calls = 0;
		const failing: Runner = async () => {
			calls++;
			throw new Error("no");
		};
		configureWordWork({ budgetMs: 0, runner: failing });
		const hunk = block(pairs);
		await expect(markLater(hunkWords(hunk).later)).rejects.toThrow("no");
		configureWordWork({
			runner: async (ps): Promise<PairMarks[]> => markPairs(ps),
		});
		await markLater(hunkWords(hunk).later);
		expect(calls).toBe(1);
		expect(hunkWords(hunk).pending.size).toBe(0);
	});
});
