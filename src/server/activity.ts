import { AsyncLocalStorage } from "node:async_hooks";
import {
	type ActivityStep,
	isPhase,
	REQUEST_ID,
	type StepAttrs,
	stepLabel,
} from "../shared/activity.js";
import { type Attrs, tracer } from "./trace.js";

/*
 * What each in-flight request is waiting on, always on (CAR-296; tracing
 * is opt-in, this is not). A request tagged with an id (x-crb-req) gets an
 * Activity, current for its handler through an AsyncLocalStorage of its
 * own; every gh and git call (gh.ts, git.ts) and a few named phases
 * (`phase`) add a step to the current Activity while they run.
 * `/api/activity` answers a request's innermost step (Activity.current).
 *
 * Shared work (one in-flight promise many requests await: an open, a
 * read, a commit batch, a Home repo read, the repo lock) runs in an
 * Activity of its own (`shared`, `runIn`); a request awaiting it adds a
 * wait step that reads through to that work's current step (`join`,
 * `waitOn`), so it says what it really waits on. A wait whose work shows
 * nothing reads "Working…", never another step.
 *
 * Cost: a step is a Set add and delete; a request a Map set, an enterWith
 * and a delete. Without an Activity (an untagged request, a test) a step
 * is one getStore().
 */

type Kind = "call" | "phase" | "wait";

interface Step {
	kind: Kind;
	name: string;
	label: string;
	startMs: number;
	/** A wait's: the work it waits on, read when asked. */
	on?: () => Activity | null | undefined;
}

/** How deep a wait reads through waits (a cycle stops here). */
const MAX_DEPTH = 6;

const WORKING = "crb: working";

/** What one request, or one piece of shared work, is doing now. */
export class Activity {
	readonly #steps = new Set<Step>();

	/** @internal */
	add(step: Step): () => void {
		this.#steps.add(step);
		return () => {
			this.#steps.delete(step);
		};
	}

	/**
	 * The step to show: the newest phase or wait (a wait read through to
	 * its work's step), else the newest call; null when it does nothing.
	 */
	current(nowMs = Date.now(), depth = 0): ActivityStep | null {
		let named: Step | undefined;
		let call: Step | undefined;
		for (const step of this.#steps) {
			if (step.kind === "call") call = step;
			else named = step;
		}
		const shown = named ?? call;
		if (!shown) return null;
		if (shown.kind === "wait") {
			const on = depth < MAX_DEPTH ? shown.on?.() : null;
			const through = on && on !== this ? on.current(nowMs, depth + 1) : null;
			if (through) return through;
			return answer(shown.name, shown.label, shown.startMs, nowMs);
		}
		return answer(shown.name, shown.label, shown.startMs, nowMs);
	}

	/** How many steps it is in (tests). */
	get size(): number {
		return this.#steps.size;
	}
}

const answer = (
	name: string,
	label: string,
	startMs: number,
	nowMs: number,
): ActivityStep => ({
	name,
	label,
	ms: Math.max(0, nowMs - startMs),
	since: new Date(startMs).toISOString(),
});

const store = new AsyncLocalStorage<Activity>();

/** The Activity of the code running now, if any. */
export const currentActivity = (): Activity | undefined => store.getStore();

/** Runs `fn` with `activity` current (its async continuations too). */
export const runIn = <T>(activity: Activity, fn: () => T): T =>
	store.run(activity, fn);

/** Makes `activity` current for the rest of this async context (a request hook). */
export const enterActivity = (activity: Activity): void =>
	store.enterWith(activity);

const NOOP = () => {};

/**
 * Starts a step of the current Activity; the function returned ends it
 * (once is enough; again does nothing). Nothing without an Activity.
 */
export function beginStep(
	kind: Kind,
	name: string,
	attrs?: StepAttrs,
	on?: () => Activity | null | undefined,
): () => void {
	const activity = store.getStore();
	if (!activity) return NOOP;
	return activity.add({
		kind,
		name,
		label: stepLabel(name, attrs),
		startMs: Date.now(),
		on,
	});
}

/** A gh or git call's step, named as its span (`gh pr view`, `git fetch`). */
export const beginCall = (name: string): (() => void) =>
	beginStep("call", name);

/**
 * Runs `fn` as named phase `name` (stepLabel's map): a step while it
 * runs, and a span of that name when tracing, the calls under it nested.
 */
export async function phase<T>(
	name: string,
	attrs: StepAttrs,
	fn: () => Promise<T>,
): Promise<T> {
	if (!isPhase(name)) throw new Error(`Not a phase: ${name}`);
	const end = beginStep("phase", name, attrs);
	const traced = tracer();
	try {
		if (!traced.enabled) return await fn();
		const spanAttrs: Attrs = { ...attrs };
		const span = traced.start(name, spanAttrs);
		try {
			return await traced.run(span, fn);
		} catch (error) {
			span.end(undefined, (error as Error)?.message);
			throw error;
		} finally {
			span.end();
		}
	} finally {
		end();
	}
}

/**
 * Awaits `promise` as a wait on `on()`'s work: while it is pending, the
 * current request's step is that work's (else `fallback`'s label).
 */
export async function waitOn<T>(
	promise: Promise<T>,
	on: () => Activity | null | undefined,
	fallback = WORKING,
): Promise<T> {
	const end = beginStep("wait", fallback, undefined, on);
	try {
		return await promise;
	} finally {
		end();
	}
}

/** Shared promises, by the Activity of the work behind them. */
const work = new WeakMap<Promise<unknown>, Activity>();

/**
 * Starts `make` as shared work, in an Activity of its own; awaiters
 * `join` the promise returned (the one to keep in a cache) to show its
 * steps.
 */
export function shared<T>(make: () => Promise<T>): Promise<T> {
	const activity = new Activity();
	const promise = runIn(activity, make);
	work.set(promise, activity);
	return promise;
}

/** The Activity of shared work's promise (from `shared`), if it is one. */
export const workOf = (promise: Promise<unknown>): Activity | undefined =>
	work.get(promise);

/**
 * Awaits `promise`, showing its work's step meanwhile when it came from
 * `shared` (else just the promise).
 */
export function join<T>(promise: Promise<T>): Promise<T> {
	const activity = work.get(promise);
	if (!activity) return promise;
	return waitOn(promise, () => activity);
}

/** Requests tracked at most: the oldest goes first beyond (a leak can't grow). */
export const MAX_REQUESTS = 1000;

const requests = new Map<string, Activity>();

/**
 * Tracks request `id` (already checked against REQUEST_ID); returns its
 * Activity and the function that stops tracking it (at its end, aborted
 * or not). An id seen again replaces the last one's entry.
 */
export function trackRequest(id: string): {
	activity: Activity;
	done: () => void;
} {
	const activity = new Activity();
	requests.delete(id);
	requests.set(id, activity);
	if (requests.size > MAX_REQUESTS) {
		const oldest = requests.keys().next().value;
		if (oldest !== undefined) requests.delete(oldest);
	}
	return {
		activity,
		done: () => {
			if (requests.get(id) === activity) requests.delete(id);
		},
	};
}

/** Requests tracked now (tests, the leak check). */
export const trackedRequests = (): number => requests.size;

/** Each id's current step: null for an unknown id or one doing nothing. */
export function activityOf(
	ids: readonly string[],
	nowMs = Date.now(),
): Record<string, ActivityStep | null> {
	// fromEntries: own properties, whatever the id ("__proto__" too).
	return Object.fromEntries(
		ids
			.filter((id) => REQUEST_ID.test(id))
			.map((id) => [id, requests.get(id)?.current(nowMs) ?? null]),
	);
}
