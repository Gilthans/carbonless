import { useEffect, useRef, useState } from "react";
import {
	type ActivityAnswer,
	type ActivityStep,
	activityPathOf,
	MAX_ACTIVITY_IDS,
	REQUEST_ID_HEADER,
	stepText,
} from "../shared/activity";

/*
 * What a slow load waits on (CAR-296): every API request of the page
 * carries an id (REQUEST_ID_HEADER, tagFetch), kept here while it is out;
 * a spinner that has spun for LOADING_STEP_AFTER_MS asks the server what
 * its requests wait on (useLoadingStep), every LOADING_STEP_EVERY_MS, and
 * shows it as one muted line. A fast load never asks.
 */

/** A pending load asks what it waits on only after this long (ms). */
export const LOADING_STEP_AFTER_MS = 1_500;
/** …then again this often while it is still pending (ms). */
export const LOADING_STEP_EVERY_MS = 1_000;

/** A request still out: its path (with the query) and method. */
export interface OutRequest {
	path: string;
	method: string;
}

/** Requests out now, by id, oldest first. */
const out = new Map<string, OutRequest>();

/** Requests out now (tests). */
export const outRequests = (): ReadonlyMap<string, OutRequest> => out;

/** A fresh request id (crypto.getRandomValues: also on plain http). */
function newRequestId(): string {
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** The same-origin `/api/` path of a request (its query kept); null for any other. */
function apiRequest(
	input: RequestInfo | URL,
	init?: RequestInit,
): OutRequest | null {
	try {
		const raw =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		const url = new URL(raw, window.location.href);
		if (url.origin !== window.location.origin) return null;
		if (!url.pathname.startsWith("/api/")) return null;
		// The ask itself, and the page's spans, aren't loads.
		if (url.pathname === "/api/activity" || url.pathname === "/api/trace") {
			return null;
		}
		const method = (
			init?.method ??
			(typeof input === "object" && "method" in input ? input.method : "GET")
		).toUpperCase();
		return { path: url.pathname + url.search, method };
	} catch {
		return null;
	}
}

/** A fetch that tags each API request with an id, kept in `out` while it is out. */
export function tagFetch(inner: typeof fetch): typeof fetch {
	return async (input, init) => {
		const request = apiRequest(input, init);
		if (!request) return inner(input, init);
		const id = newRequestId();
		const headers = new Headers(
			init?.headers ??
				(typeof input === "object" && "headers" in input
					? input.headers
					: undefined),
		);
		headers.set(REQUEST_ID_HEADER, id);
		out.set(id, request);
		try {
			return await inner(input, { ...init, headers });
		} finally {
			out.delete(id);
		}
	};
}

const INSTALLED = Symbol.for("carbonless.requestIds");

/** Tags the page's API requests from now on (main.tsx; once). */
export function installRequestIds(): void {
	const w = window as unknown as { [INSTALLED]?: boolean };
	if (w[INSTALLED]) return;
	w[INSTALLED] = true;
	window.fetch = tagFetch(window.fetch.bind(window));
}

/** One ask loop, shared by every hook of the same key. */
interface Poll {
	match: (request: OutRequest) => boolean;
	users: number;
	step: ActivityStep | null;
	listeners: Set<() => void>;
	stop: AbortController;
	timer: ReturnType<typeof setTimeout> | undefined;
}

const polls = new Map<string, Poll>();

/** Ask loops running now (tests). */
export const activePolls = (): number => polls.size;

function startPoll(match: Poll["match"]): Poll {
	const poll: Poll = {
		match,
		users: 0,
		step: null,
		listeners: new Set(),
		stop: new AbortController(),
		timer: undefined,
	};
	const set = (step: ActivityStep | null) => {
		poll.step = step;
		for (const listener of poll.listeners) listener();
	};
	const ask = async () => {
		const ids = [...out]
			.filter(([, request]) => poll.match(request))
			.map(([id]) => id)
			.slice(0, MAX_ACTIVITY_IDS);
		// None out for a moment (a Home repo's next ask not yet sent): the
		// last step stays until the next one says.
		if (ids.length > 0) {
			try {
				const res = await fetch(activityPathOf(ids), {
					signal: poll.stop.signal,
				});
				if (res.ok) {
					const { steps } = (await res.json()) as ActivityAnswer;
					if (poll.stop.signal.aborted) return;
					set(ids.map((id) => steps?.[id]).find((s) => s) ?? null);
				}
			} catch {
				// Stopped, or the server is busy: the load says the rest.
			}
		}
		if (!poll.stop.signal.aborted) {
			poll.timer = setTimeout(ask, LOADING_STEP_EVERY_MS);
		}
	};
	poll.timer = setTimeout(ask, LOADING_STEP_AFTER_MS);
	return poll;
}

/**
 * While `active` (a load pending) and past LOADING_STEP_AFTER_MS: the
 * step its requests (those `match` picks, the oldest with a step first)
 * wait on, as the line to show ("GitHub: pr view · 4s"); else null. Hooks
 * of the same `key` (the same requests: every pane of one threads read)
 * share one ask loop, from the first one active to the last. A failed ask
 * shows nothing new.
 */
export function useLoadingStep(
	key: string,
	match: (request: OutRequest) => boolean,
	active: boolean,
): string | null {
	const matchRef = useRef(match);
	matchRef.current = match;
	const [step, setStep] = useState<ActivityStep | null>(null);
	useEffect(() => {
		if (!active) return;
		let poll = polls.get(key);
		if (!poll) {
			poll = startPoll((r) => matchRef.current(r));
			polls.set(key, poll);
		}
		const mine = poll;
		mine.users++;
		const listener = () => setStep(mine.step);
		mine.listeners.add(listener);
		listener();
		return () => {
			mine.listeners.delete(listener);
			if (--mine.users === 0) {
				mine.stop.abort();
				clearTimeout(mine.timer);
				if (polls.get(key) === mine) polls.delete(key);
			}
			setStep(null);
		};
	}, [key, active]);
	return active && step ? stepText(step) : null;
}
