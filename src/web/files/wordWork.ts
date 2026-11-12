import type { DiffLine } from "../../shared/types";
import type { Mark } from "../code/Invisibles";
import type { DiffRow } from "./whitespace";
import { hunkPairs } from "./wordBlocks";
import { wordMarks } from "./wordDiff";

/**
 * Where a hunk's word marks are computed (CAR-135). The exact token diff is
 * O(N·D): two unrelated lines just under the cut (WORD_DIFF_MAX) cost about
 * 8–14 ms of CPU a pair, so a rewritten block of 200 of them would block the
 * page for seconds if marked during render. A render marks pairs only while
 * its task's budget (`SYNC_BUDGET_MS`) lasts, so the common, cheap pairs are
 * marked on first paint; the rest are marked off the render path (a Web
 * Worker, else in short slices of the main thread) and shown when done.
 * The same `wordMarks` either way: the marks never depend on where they
 * were computed. Done pairs are kept (by their two lines), so a view or
 * whitespace toggle marks nothing it marked before.
 */

/** A pair's marks: its removed line's (`old`) and its added line's (`new`). */
export interface PairMarks {
	old: Mark[];
	new: Mark[];
}

/** Marks pairs of texts (removed, added), in order, off the render path. */
export type Runner = (
	pairs: readonly (readonly [string, string])[],
) => Promise<PairMarks[]>;

/**
 * Each pair's marks, in order: what the worker runs. Exactly `wordMarks`,
 * pair by pair.
 */
export const markPairs = (
	pairs: readonly (readonly [string, string])[],
): PairMarks[] => pairs.map(([a, b]) => wordMarks(a, b));

/**
 * Milliseconds of marking a task may spend in render: half a frame. A
 * small hunk's pairs take a fraction of a millisecond, so they show marked
 * on first paint; a pair already started finishes (the most one costs:
 * ~14 ms on a dev machine), so a render blocks at most about 20 ms more.
 */
export const SYNC_BUDGET_MS = 8;

/** Milliseconds a main-thread slice marks for, when there is no worker. */
const SLICE_MS = 8;

/** Done pairs: by removed line, then by added line. */
let done = new WeakMap<DiffLine, WeakMap<DiffLine, PairMarks>>();
/** Pairs being marked off the render path, and when they will be done. */
let inFlight = new WeakMap<DiffLine, WeakMap<DiffLine, Promise<void>>>();

const lookup = <T>(
	map: WeakMap<DiffLine, WeakMap<DiffLine, T>>,
	del: DiffLine,
	add: DiffLine,
): T | undefined => map.get(del)?.get(add);

function store<T>(
	map: WeakMap<DiffLine, WeakMap<DiffLine, T>>,
	del: DiffLine,
	add: DiffLine,
	value: T,
) {
	let inner = map.get(del);
	if (!inner) {
		inner = new WeakMap();
		map.set(del, inner);
	}
	inner.set(add, value);
}

/** Milliseconds this task has spent marking in render; null between tasks. */
let spent: number | null = null;
let budgetMs = SYNC_BUDGET_MS;

/**
 * A pair's marks in render, when this task's budget isn't spent; undefined
 * once it is. The budget is per task (reset in a microtask, once the stack
 * that renders has returned), shared by every hunk the task renders, and
 * counts only the time spent marking: rendering between two hunks doesn't
 * use it up.
 */
function markNow(del: DiffLine, add: DiffLine): PairMarks | undefined {
	if (spent === null) {
		spent = 0;
		queueMicrotask(() => {
			spent = null;
		});
	}
	if (spent >= budgetMs) return undefined;
	const start = performance.now();
	const pair = wordMarks(del.text, add.text);
	spent += performance.now() - start;
	return pair;
}

/** Marks in short main-thread slices, a macrotask between: no worker here. */
export const slicedRunner: Runner = (pairs) =>
	new Promise((resolve) => {
		const out: PairMarks[] = [];
		const step = () => {
			const start = performance.now();
			while (out.length < pairs.length) {
				const [a, b] = pairs[out.length] as readonly [string, string];
				out.push(wordMarks(a, b));
				if (performance.now() - start >= SLICE_MS) break;
			}
			if (out.length < pairs.length) setTimeout(step, 0);
			else resolve(out);
		};
		setTimeout(step, 0);
	});

/**
 * A Web Worker running `markPairs` (wordWorker.ts), one job at a time in
 * the order sent; null where there is none (tests, an old browser). A
 * worker that fails rejects its jobs, and every later one, so they are
 * marked on the main thread instead.
 */
function workerRunner(): Runner | null {
	if (typeof Worker === "undefined") return null;
	let worker: Worker;
	try {
		worker = new Worker(new URL("./wordWorker.ts", import.meta.url), {
			type: "module",
		});
	} catch {
		return null;
	}
	let broken = false;
	let next = 0;
	const waiting = new Map<
		number,
		{ resolve: (marks: PairMarks[]) => void; reject: (e: unknown) => void }
	>();
	const fail = (error: unknown) => {
		broken = true;
		for (const job of waiting.values()) job.reject(error);
		waiting.clear();
		worker.terminate();
	};
	worker.onmessage = (
		event: MessageEvent<{ id: number; marks: PairMarks[] }>,
	) => {
		const { id, marks } = event.data;
		waiting.get(id)?.resolve(marks);
		waiting.delete(id);
	};
	worker.onerror = fail;
	worker.onmessageerror = fail;
	return (pairs) =>
		new Promise((resolve, reject) => {
			if (broken) {
				reject(new Error("word worker failed"));
				return;
			}
			const id = next++;
			waiting.set(id, { resolve, reject });
			worker.postMessage({ id, pairs });
		});
}

let runner: Runner | null = null;
/** The worker, made on first use; the main thread when it can't be. */
function run(pairs: readonly (readonly [string, string])[]) {
	if (!runner) {
		const worker = workerRunner();
		runner = worker
			? (ps) => worker(ps).catch(() => slicedRunner(ps))
			: slicedRunner;
	}
	return runner(pairs);
}

/** A hunk's word marks as far as they are done. */
export interface HunkWords {
	/** Each paired line's marks; lines without a mark are left out. */
	marks: Map<DiffLine, readonly Mark[]>;
	/** The lines of the pairs not marked yet. */
	pending: ReadonlySet<DiffLine>;
	/** Those pairs, for `markLater`. */
	later: [del: DiffLine, add: DiffLine][];
}

const NONE: ReadonlySet<DiffLine> = new Set();

/**
 * The hunk's word marks (hunkPairs): every pair done before, and new ones
 * while the task's render budget lasts; the rest are `later`, for
 * `markLater`.
 */
export function hunkWords(rows: readonly DiffRow[]): HunkWords {
	const marks = new Map<DiffLine, readonly Mark[]>();
	const pending = new Set<DiffLine>();
	const later: [DiffLine, DiffLine][] = [];
	for (const [del, add] of hunkPairs(rows)) {
		let pair = lookup(done, del, add);
		if (!pair) {
			pair = markNow(del, add);
			if (pair) store(done, del, add, pair);
		}
		if (!pair) {
			pending.add(del);
			pending.add(add);
			later.push([del, add]);
			continue;
		}
		if (pair.old.length > 0) marks.set(del, pair.old);
		if (pair.new.length > 0) marks.set(add, pair.new);
	}
	return { marks, pending: pending.size > 0 ? pending : NONE, later };
}

/**
 * Marks `pairs` off the render path; resolves once every one is done (then
 * `hunkWords` has them all). A pair already on its way isn't sent again.
 */
export function markLater(
	pairs: readonly (readonly [DiffLine, DiffLine])[],
): Promise<void> {
	const waits: Promise<void>[] = [];
	const send: (readonly [DiffLine, DiffLine])[] = [];
	for (const [del, add] of pairs) {
		if (lookup(done, del, add)) continue;
		const wait = lookup(inFlight, del, add);
		if (wait) waits.push(wait);
		else send.push([del, add]);
	}
	if (send.length > 0) {
		const flights = inFlight;
		const job = run(send.map(([d, a]) => [d.text, a.text] as const)).then(
			(marks) => {
				send.forEach(([del, add], i) => {
					store(done, del, add, marks[i] as PairMarks);
				});
			},
		);
		// Done or not, the pairs are no longer on their way.
		const settled = job.finally(() => {
			for (const [del, add] of send) flights.get(del)?.delete(add);
		});
		for (const [del, add] of send) store(flights, del, add, settled);
		waits.push(settled);
	}
	return Promise.all(waits).then(() => undefined);
}

/** Tests: the render budget and the runner (null: the default). */
export function configureWordWork(options: {
	budgetMs?: number;
	runner?: Runner | null;
}) {
	if (options.budgetMs !== undefined) budgetMs = options.budgetMs;
	if (options.runner !== undefined) runner = options.runner;
}

/** Tests: forget every done pair and the settings. */
export function resetWordWork() {
	done = new WeakMap();
	inFlight = new WeakMap();
	budgetMs = SYNC_BUDGET_MS;
	runner = null;
	spent = null;
}
