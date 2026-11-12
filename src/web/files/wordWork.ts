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
 * marked on first paint; the rest are marked off the render path, in
 * chunks of `CHUNK` pairs one after another (a Web Worker, else short
 * slices of the main thread), each shown when done. Which pairs make the
 * first paint depends on the machine's load; the marks never do: the same
 * `wordMarks` either way. Done pairs are kept (by their two lines), so a
 * view or whitespace toggle marks nothing it marked before. A chunk nobody
 * waits for any more (its file closed) is dropped. A pair whose marking
 * fails is failed for good: its lines say so, never pending forever, never
 * plain.
 */

/** A pair's marks: its removed line's (`old`) and its added line's (`new`). */
export interface PairMarks {
	old: Mark[];
	new: Mark[];
}

/**
 * Marks pairs of texts (removed, added), in order, off the render path.
 * `wanted` says whether anyone still waits for them: a runner that can
 * stop between pairs rejects with `Dropped` once it says no.
 */
export type Runner = (
	pairs: readonly (readonly [string, string])[],
	wanted: () => boolean,
) => Promise<PairMarks[]>;

/** A runner stopped: nobody waits for its pairs any more. */
export class Dropped extends Error {
	constructor() {
		super("word marks no longer wanted");
	}
}

/** Marking the pairs failed in the worker itself (not the worker failing). */
class JobFailed extends Error {}

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

/** Pairs a job sends at a time: a 200-pair hunk fills in ten steps. */
export const CHUNK = 20;

/** Milliseconds a main-thread slice marks for, when there is no worker. */
const SLICE_MS = 8;

/** A pair whose marking failed. */
const FAILED = { failed: true } as const;
type Outcome = PairMarks | typeof FAILED;

/** Pairs off the render path, sent (or to be sent) together. */
interface Chunk {
	pairs: [DiffLine, DiffLine][];
	/** Who waits for it, each called once it's done. */
	wanted: Set<() => void>;
}

/** Done pairs (marked or failed): by removed line, then by added line. */
let done = new WeakMap<DiffLine, WeakMap<DiffLine, Outcome>>();
/** Pairs queued or being marked, and their chunk. */
let waiting = new WeakMap<DiffLine, WeakMap<DiffLine, Chunk>>();
/** Chunks not started, oldest first; one runs at a time. */
let queue: Chunk[] = [];
let running = false;
/** Bumped by `resetWordWork`: a job from before it is ignored. */
let generation = 0;

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
const realNow = () => performance.now();
/** The clock the render budget reads (tests: a fake one). */
let now: () => number = realNow;

/**
 * A pair's marks in render, when this task's budget isn't spent; undefined
 * once it is. The budget is per task (reset in a microtask, once the stack
 * that renders has returned), shared by every hunk the task renders, and
 * counts only the time spent marking: rendering between two hunks doesn't
 * use it up. A pair that throws is failed.
 */
function markNow(del: DiffLine, add: DiffLine): Outcome | undefined {
	if (spent === null) {
		spent = 0;
		queueMicrotask(() => {
			spent = null;
		});
	}
	if (spent >= budgetMs) return undefined;
	const start = now();
	try {
		return wordMarks(del.text, add.text);
	} catch {
		return FAILED;
	} finally {
		spent += now() - start;
	}
}

/**
 * Marks in short main-thread slices, a macrotask between: no worker here.
 * Stops (`Dropped`) when the pairs are no longer wanted; a pair that throws
 * rejects the whole run.
 */
export const slicedRunner: Runner = (pairs, wanted) =>
	new Promise((resolve, reject) => {
		const out: PairMarks[] = [];
		const step = () => {
			try {
				if (!wanted()) {
					reject(new Dropped());
					return;
				}
				const start = performance.now();
				while (out.length < pairs.length) {
					const [a, b] = pairs[out.length] as readonly [string, string];
					out.push(wordMarks(a, b));
					if (performance.now() - start >= SLICE_MS) break;
				}
				if (out.length < pairs.length) setTimeout(step, 0);
				else resolve(out);
			} catch (error) {
				reject(error);
			}
		};
		setTimeout(step, 0);
	});

/** Why marking fell back to the main thread; null while it hasn't. */
let fallback: string | null = null;

/** Tests: why marks are computed on the main thread, null when they aren't. */
export const wordWorkFallback = () => fallback;

/**
 * Marks fall back to the main thread: said on the console and on the
 * page's root (`data-word-marks-fallback`), so a test can tell the worker
 * never ran.
 */
function fellBack(reason: string) {
	if (fallback !== null) return;
	fallback = reason;
	console.debug(`word marks: main-thread fallback (${reason})`);
	if (typeof document !== "undefined") {
		document.documentElement.dataset.wordMarksFallback = reason;
	}
}

/**
 * A Web Worker running `markPairs` (wordWorker.ts), one job at a time in
 * the order sent; null where there is none (tests, an old browser). A job
 * the worker answers with an error rejects with `JobFailed`; a worker that
 * fails (its script missing, refused or broken) rejects its jobs, and every
 * later one, so they are marked on the main thread instead.
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
	const jobs = new Map<
		number,
		{ resolve: (marks: PairMarks[]) => void; reject: (e: unknown) => void }
	>();
	const fail = (error: unknown) => {
		broken = true;
		for (const job of jobs.values()) job.reject(error);
		jobs.clear();
		worker.terminate();
	};
	worker.onmessage = (
		event: MessageEvent<{ id: number; marks?: PairMarks[]; error?: string }>,
	) => {
		const { id, marks, error } = event.data;
		const job = jobs.get(id);
		jobs.delete(id);
		if (marks) job?.resolve(marks);
		else job?.reject(new JobFailed(error));
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
			jobs.set(id, { resolve, reject });
			worker.postMessage({ id, pairs });
		});
}

let runner: Runner | null = null;
/** The worker, made on first use; the main thread when it can't be. */
function run(
	pairs: readonly (readonly [string, string])[],
	wanted: () => boolean,
) {
	if (!runner) {
		const worker = workerRunner();
		if (!worker) fellBack("no worker");
		runner = worker
			? (ps, w) =>
					worker(ps, w).catch((error: unknown) => {
						if (error instanceof JobFailed) throw error;
						fellBack("worker failed");
						return slicedRunner(ps, w);
					})
			: slicedRunner;
	}
	return runner(pairs, wanted);
}

/** Forgets a chunk's pairs as waiting (done, failed or dropped). */
function forget(chunk: Chunk) {
	for (const [del, add] of chunk.pairs) {
		if (lookup(waiting, del, add) === chunk) waiting.get(del)?.delete(add);
	}
}

/**
 * Fails a pair, unless it's done: marked meanwhile (in render, while its
 * chunk was out), a failure never takes its marks away.
 */
function failIfNotDone(del: DiffLine, add: DiffLine) {
	if (!lookup(done, del, add)) store(done, del, add, FAILED);
}

/** Runs the oldest chunk still wanted, when none runs. */
function pump() {
	if (running) return;
	let chunk = queue.shift();
	while (chunk && chunk.wanted.size === 0) {
		forget(chunk);
		chunk = queue.shift();
	}
	if (!chunk) return;
	const job = chunk;
	const gen = generation;
	running = true;
	let attempt: Promise<PairMarks[]>;
	try {
		attempt = run(
			job.pairs.map(([d, a]) => [d.text, a.text] as const),
			() => job.wanted.size > 0,
		);
	} catch (error) {
		attempt = Promise.reject(error);
	}
	void attempt
		.then(
			(marks) => {
				if (gen !== generation) return;
				job.pairs.forEach(([del, add], i) => {
					// A missing answer is a failure, never a pair left plain.
					const pair = marks[i];
					if (pair) store(done, del, add, pair);
					else failIfNotDone(del, add);
				});
			},
			(error: unknown) => {
				if (gen !== generation || error instanceof Dropped) return;
				for (const [del, add] of job.pairs) failIfNotDone(del, add);
			},
		)
		.finally(() => {
			if (gen !== generation) return;
			forget(job);
			running = false;
			for (const notify of job.wanted) notify();
			pump();
		});
}

/** A hunk's word marks as far as they are done. */
export interface HunkWords {
	/** Each paired line's marks; lines without a mark are left out. */
	marks: Map<DiffLine, readonly Mark[]>;
	/** The lines of the pairs not marked yet. */
	pending: ReadonlySet<DiffLine>;
	/** The lines of the pairs whose marking failed. */
	failed: ReadonlySet<DiffLine>;
	/** The pending pairs, for `requestMarks`. */
	later: [del: DiffLine, add: DiffLine][];
}

const NONE: ReadonlySet<DiffLine> = new Set();

/**
 * The hunk's word marks (hunkPairs): every pair done before, and new ones
 * while the task's render budget lasts; the rest are `later`, for
 * `requestMarks`.
 */
export function hunkWords(rows: readonly DiffRow[]): HunkWords {
	const marks = new Map<DiffLine, readonly Mark[]>();
	const pending = new Set<DiffLine>();
	const failed = new Set<DiffLine>();
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
		} else if ("failed" in pair) {
			failed.add(del);
			failed.add(add);
		} else {
			if (pair.old.length > 0) marks.set(del, pair.old);
			if (pair.new.length > 0) marks.set(add, pair.new);
		}
	}
	return {
		marks,
		pending: pending.size > 0 ? pending : NONE,
		failed: failed.size > 0 ? failed : NONE,
		later,
	};
}

/**
 * Marks `pairs` off the render path, in chunks of `CHUNK`; `progress` is
 * called as each chunk holding some of them is done (marked or failed:
 * `hunkWords` then has them), and once, in a microtask, when some were
 * done already (so a caller that saw them pending always hears). A pair already on its way isn't sent again.
 * Returns the cancel: the caller no longer waits, and a chunk nobody waits
 * for is dropped before it runs (or, on the main thread, between slices).
 */
export function requestMarks(
	pairs: readonly (readonly [DiffLine, DiffLine])[],
	progress: () => void,
): () => void {
	// Its own identity: one caller can ask twice.
	let live = true;
	const listener = () => {
		if (live) progress();
	};
	const mine = new Set<Chunk>();
	let fresh: Chunk | undefined;
	// Some are done already (their chunk answered after the caller saw them
	// pending, before it asked): it hears so, as from a chunk.
	let doneAlready = false;
	for (const [del, add] of pairs) {
		if (lookup(done, del, add)) {
			doneAlready = true;
			continue;
		}
		const chunk = lookup(waiting, del, add);
		if (chunk) {
			chunk.wanted.add(listener);
			mine.add(chunk);
			continue;
		}
		if (!fresh || fresh.pairs.length >= CHUNK) {
			fresh = { pairs: [], wanted: new Set([listener]) };
			queue.push(fresh);
			mine.add(fresh);
		}
		fresh.pairs.push([del, add]);
		store(waiting, del, add, fresh);
	}
	pump();
	if (doneAlready) queueMicrotask(listener);
	return () => {
		live = false;
		for (const chunk of mine) chunk.wanted.delete(listener);
	};
}

/** Tests: the render budget, its clock, and the runner (null: the default). */
export function configureWordWork(options: {
	budgetMs?: number;
	now?: () => number;
	runner?: Runner | null;
}) {
	if (options.budgetMs !== undefined) budgetMs = options.budgetMs;
	if (options.now !== undefined) now = options.now;
	if (options.runner !== undefined) runner = options.runner;
}

/** Tests: forget every pair, job and setting. */
export function resetWordWork() {
	generation++;
	done = new WeakMap();
	waiting = new WeakMap();
	queue = [];
	running = false;
	budgetMs = SYNC_BUDGET_MS;
	now = realNow;
	runner = null;
	spent = null;
	fallback = null;
	if (typeof document !== "undefined") {
		delete document.documentElement.dataset.wordMarksFallback;
	}
}
