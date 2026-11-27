import type { HunkItems, LineGroup } from "../../shared/hunkPairs";
import type { DiffLine } from "../../shared/types";
import type { Mark } from "../code/Invisibles";
import type { LinePair } from "./wordBlocks";
import { type GroupMarkJob, groupMarks, wordMarks } from "./wordDiff";

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
 * view or whitespace toggle marks nothing it marked before. A group (a
 * line split into several, or several joined into one; CAR-130) is one job
 * like a pair, counted as one toward `CHUNK`, kept by its one line and the
 * first and last of its run; every one of its lines is pending or failed
 * together. A chunk nobody
 * waits for any more (its file closed) is dropped. A pair whose marking
 * fails is failed for good: its lines say so, never pending forever, never
 * plain.
 */

/** A pair's marks: its removed line's (`old`) and its added line's (`new`). */
export interface PairMarks {
	old: Mark[];
	new: Mark[];
}

/** A group's marks: its one line's, and each line of its run's. */
export interface GroupJobMarks {
	one: Mark[];
	run: Mark[][];
}

/** A job: a pair of texts (removed, added), or a group to mark. */
export type MarkJob = readonly [string, string] | GroupMarkJob;
export type JobMarks = PairMarks | GroupJobMarks;

/**
 * Marks jobs, in order, off the render path. `wanted` says whether anyone
 * still waits for them: a runner that can stop between jobs rejects with
 * `Dropped` once it says no.
 */
export type Runner = (
	jobs: readonly MarkJob[],
	wanted: () => boolean,
) => Promise<JobMarks[]>;

/** A runner stopped: nobody waits for its pairs any more. */
export class Dropped extends Error {
	constructor() {
		super("word marks no longer wanted");
	}
}

/** Marking the pairs failed in the worker itself (not the worker failing). */
class JobFailed extends Error {}

const markJob = (job: MarkJob): JobMarks =>
	"one" in job ? groupMarks(job) : wordMarks(job[0], job[1]);

/**
 * Each job's marks, in order: what the worker runs. Exactly `wordMarks`
 * (a pair) or `groupMarks` (a group), job by job.
 */
export const markJobs = (jobs: readonly MarkJob[]): JobMarks[] =>
	jobs.map(markJob);

/**
 * Milliseconds of marking a task may spend in render: half a frame. A
 * small hunk's pairs take a fraction of a millisecond, so they show marked
 * on first paint; a pair already started finishes (the most one costs:
 * ~14 ms on a dev machine), so a render blocks at most about 20 ms more.
 */
export const SYNC_BUDGET_MS = 8;

/** Pairs or groups a job sends at a time: a 200-pair hunk fills in ten steps. */
export const CHUNK = 20;

/** Milliseconds a main-thread slice marks for, when there is no worker. */
const SLICE_MS = 8;

/** A pair or group whose marking failed. */
const FAILED = { failed: true } as const;
type Outcome = PairMarks | typeof FAILED;
type GroupOutcome = GroupJobMarks | typeof FAILED;

/** A pair, or a group (CAR-130), to mark. */
export type Later = LinePair | LineGroup;
const isGroup = (item: Later): item is LineGroup => "run" in item;

/** What a chunk marks: an item, and whether its file is Markdown. */
interface Entry {
	item: Later;
	markdown: boolean;
}

/** Pairs and groups off the render path, sent (or to be sent) together. */
interface Chunk {
	entries: Entry[];
	/** Who waits for it, each called once it's done. */
	wanted: Set<() => void>;
}

/** A group's key lines: its one line, and its run's first and last. */
const keyOf = (g: LineGroup) =>
	[g.one, g.run[0], g.run[g.run.length - 1]] as readonly DiffLine[];

/** Done pairs (marked or failed): by removed line, then by added line. */
let done = new WeakMap<DiffLine, WeakMap<DiffLine, Outcome>>();
/** Pairs queued or being marked, and their chunk. */
let waiting = new WeakMap<DiffLine, WeakMap<DiffLine, Chunk>>();
/** The same for groups, by (one, run[0], run[last]). */
let groupDone = new WeakMap<
	DiffLine,
	WeakMap<DiffLine, WeakMap<DiffLine, GroupOutcome>>
>();
let groupWaiting = new WeakMap<
	DiffLine,
	WeakMap<DiffLine, WeakMap<DiffLine, Chunk>>
>();

function lookup3<T>(
	map: WeakMap<DiffLine, WeakMap<DiffLine, WeakMap<DiffLine, T>>>,
	[a, b, c]: readonly DiffLine[],
): T | undefined {
	return map
		.get(a as DiffLine)
		?.get(b as DiffLine)
		?.get(c as DiffLine);
}

function store3<T>(
	map: WeakMap<DiffLine, WeakMap<DiffLine, WeakMap<DiffLine, T>>>,
	[a, b, c]: readonly DiffLine[],
	value: T,
) {
	let second = map.get(a as DiffLine);
	if (!second) {
		second = new WeakMap();
		map.set(a as DiffLine, second);
	}
	let third = second.get(b as DiffLine);
	if (!third) {
		third = new WeakMap();
		second.set(b as DiffLine, third);
	}
	third.set(c as DiffLine, value);
}
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

/** The job that marks a group. */
const groupJob = (g: LineGroup, markdown: boolean): GroupMarkJob => ({
	one: g.one.text,
	run: g.run.map((l) => l.text),
	oneIsOld: g.one.kind === "del",
	markdown,
});

/**
 * A pair's or group's marks in render, when this task's budget isn't
 * spent; undefined once it is. The budget is per task (reset in a
 * microtask, once the stack that renders has returned), shared by every
 * hunk the task renders, and counts only the time spent marking: rendering
 * between two hunks doesn't use it up. One that throws is failed.
 */
function markNow<T extends JobMarks>(
	make: () => T,
): T | typeof FAILED | undefined {
	if (spent === null) {
		spent = 0;
		queueMicrotask(() => {
			spent = null;
		});
	}
	if (spent >= budgetMs) return undefined;
	const start = now();
	try {
		return make();
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
		const out: JobMarks[] = [];
		const step = () => {
			try {
				if (!wanted()) {
					reject(new Dropped());
					return;
				}
				const start = performance.now();
				while (out.length < pairs.length) {
					out.push(markJob(pairs[out.length] as MarkJob));
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
 * A Web Worker running `markJobs` (wordWorker.ts), one job at a time in
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
		{ resolve: (marks: JobMarks[]) => void; reject: (e: unknown) => void }
	>();
	const fail = (error: unknown) => {
		broken = true;
		for (const job of jobs.values()) job.reject(error);
		jobs.clear();
		worker.terminate();
	};
	worker.onmessage = (
		event: MessageEvent<{ id: number; marks?: JobMarks[]; error?: string }>,
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
			worker.postMessage({ id, jobs: pairs });
		});
}

let runner: Runner | null = null;
/** The worker, made on first use; the main thread when it can't be. */
function run(pairs: readonly MarkJob[], wanted: () => boolean) {
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

/** Forgets a chunk's items as waiting (done, failed or dropped). */
function forget(chunk: Chunk) {
	for (const { item } of chunk.entries) {
		if (isGroup(item)) {
			if (lookup3(groupWaiting, keyOf(item)) === chunk) {
				const [one, first, last] = keyOf(item) as [
					DiffLine,
					DiffLine,
					DiffLine,
				];
				groupWaiting.get(one)?.get(first)?.delete(last);
			}
		} else if (lookup(waiting, item[0], item[1]) === chunk) {
			waiting.get(item[0])?.delete(item[1]);
		}
	}
}

/**
 * Fails an item, unless it's done: marked meanwhile (in render, while its
 * chunk was out), a failure never takes its marks away.
 */
function failIfNotDone(item: Later) {
	if (isGroup(item)) {
		if (!lookup3(groupDone, keyOf(item)))
			store3(groupDone, keyOf(item), FAILED);
	} else if (!lookup(done, item[0], item[1])) {
		store(done, item[0], item[1], FAILED);
	}
}

/** Keeps an answer for an item; a wrong-shaped or missing one is a failure. */
function keep(item: Later, marks: JobMarks | undefined) {
	if (isGroup(item)) {
		if (
			marks &&
			"run" in marks &&
			Array.isArray(marks.one) &&
			Array.isArray(marks.run) &&
			marks.run.length === item.run.length
		) {
			store3(groupDone, keyOf(item), marks);
		} else failIfNotDone(item);
	} else if (
		marks &&
		"old" in marks &&
		Array.isArray(marks.old) &&
		Array.isArray(marks.new)
	) {
		store(done, item[0], item[1], marks);
	} else failIfNotDone(item);
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
	let attempt: Promise<JobMarks[]>;
	try {
		attempt = run(
			job.entries.map(
				({ item, markdown }): MarkJob =>
					isGroup(item)
						? groupJob(item, markdown)
						: ([item[0].text, item[1].text] as const),
			),
			() => job.wanted.size > 0,
		);
	} catch (error) {
		attempt = Promise.reject(error);
	}
	void attempt
		.then(
			(marks) => {
				if (gen !== generation) return;
				// A missing answer is a failure, never an item left plain.
				job.entries.forEach(({ item }, i) => {
					keep(item, marks[i]);
				});
			},
			(error: unknown) => {
				if (gen !== generation || error instanceof Dropped) return;
				for (const { item } of job.entries) failIfNotDone(item);
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
	/** Each paired or grouped line's marks; lines without a mark are left out. */
	marks: Map<DiffLine, readonly Mark[]>;
	/** The lines of the pairs and groups not marked yet. */
	pending: ReadonlySet<DiffLine>;
	/** The lines of the pairs and groups whose marking failed. */
	failed: ReadonlySet<DiffLine>;
	/** The pending pairs and groups, for `requestMarks`. */
	later: Later[];
}

const NONE: ReadonlySet<DiffLine> = new Set();

/**
 * The word marks of a hunk's pairs and groups (hunkView's): every one done
 * before, and new ones while the task's render budget lasts; the rest are
 * `later`, for `requestMarks`. `markdown`: the file is Markdown (a comment
 * leader is no part of a group's break).
 */
export function hunkWords(items: HunkItems, markdown: boolean): HunkWords {
	const marks = new Map<DiffLine, readonly Mark[]>();
	const pending = new Set<DiffLine>();
	const failed = new Set<DiffLine>();
	const later: Later[] = [];
	for (const pairItem of items.pairs) {
		const [del, add] = pairItem;
		let pair = lookup(done, del, add);
		if (!pair) {
			pair = markNow(() => wordMarks(del.text, add.text));
			if (pair) store(done, del, add, pair);
		}
		if (!pair) {
			pending.add(del);
			pending.add(add);
			later.push(pairItem);
		} else if ("failed" in pair) {
			failed.add(del);
			failed.add(add);
		} else {
			if (pair.old.length > 0) marks.set(del, pair.old);
			if (pair.new.length > 0) marks.set(add, pair.new);
		}
	}
	for (const group of items.groups) {
		const lines = [group.one, ...group.run];
		let result = lookup3(groupDone, keyOf(group));
		if (!result) {
			result = markNow(() => groupMarks(groupJob(group, markdown)));
			if (result) store3(groupDone, keyOf(group), result);
		}
		if (!result) {
			for (const l of lines) pending.add(l);
			later.push(group);
		} else if ("failed" in result) {
			for (const l of lines) failed.add(l);
		} else {
			if (result.one.length > 0) marks.set(group.one, result.one);
			group.run.forEach((l, i) => {
				const m = result.run[i];
				if (m && m.length > 0) marks.set(l, m);
			});
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
 * Marks `later` off the render path, in chunks of `CHUNK` (a group counts
 * as one); `progress` is called as each chunk holding some of them is done
 * (marked or failed: `hunkWords` then has them), and once, in a microtask,
 * when some were done already (so a caller that saw them pending always
 * hears). One already on its way isn't sent again. Returns the cancel: the
 * caller no longer waits, and a chunk nobody waits for is dropped before it
 * runs (or, on the main thread, between slices).
 */
export function requestMarks(
	later: readonly Later[],
	markdown: boolean,
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
	for (const item of later) {
		const group = isGroup(item);
		if (
			group ? lookup3(groupDone, keyOf(item)) : lookup(done, item[0], item[1])
		) {
			doneAlready = true;
			continue;
		}
		const chunk = isGroup(item)
			? lookup3(groupWaiting, keyOf(item))
			: lookup(waiting, item[0], item[1]);
		if (chunk) {
			chunk.wanted.add(listener);
			mine.add(chunk);
			continue;
		}
		if (!fresh || fresh.entries.length >= CHUNK) {
			fresh = { entries: [], wanted: new Set([listener]) };
			queue.push(fresh);
			mine.add(fresh);
		}
		fresh.entries.push({ item, markdown });
		if (isGroup(item)) store3(groupWaiting, keyOf(item), fresh);
		else store(waiting, item[0], item[1], fresh);
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
	groupDone = new WeakMap();
	groupWaiting = new WeakMap();
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
