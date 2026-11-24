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

/** A step as a load shows it. */
export interface LoadingStep {
	/** The label ("GitHub: pr view"). */
	label: string;
	/** Whole seconds on it, once past one; else null. */
	seconds: number | null;
	/** The label with its seconds ("GitHub: pr view · 4s"). */
	text: string;
}

/** One hook of an ask loop: what it matches, what it shows. */
interface User {
	match: (request: OutRequest) => boolean;
	step: ActivityStep | null;
	/** Asks in a row that found none of its requests out. */
	empties: number;
	notify: () => void;
}

/** One ask loop, shared by every hook of the same key. */
interface Poll {
	/** Its hooks, the first active one first. */
	users: Set<User>;
	stop: AbortController;
	timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * A hook whose requests are all gone for this many asks in a row shows
 * nothing: a gap between two asks (a Home repo's next one not yet sent)
 * keeps the line, a load whose requests ended clears it.
 */
const EMPTY_ASKS_CLEAR = 2;

const polls = new Map<string, Poll>();

/** Ask loops running now (tests). */
export const activePolls = (): number => polls.size;

function startPoll(): Poll {
	const poll: Poll = {
		users: new Set(),
		stop: new AbortController(),
		timer: undefined,
	};
	const ask = async () => {
		const users = [...poll.users];
		// The requests out now, any hook's: one ask for all of them.
		const wanted = [...out]
			.filter(([, request]) => users.some((u) => u.match(request)))
			.slice(0, MAX_ACTIVITY_IDS);
		let steps: ActivityAnswer["steps"] | null = {};
		if (wanted.length > 0) {
			try {
				const res = await fetch(activityPathOf(wanted.map(([id]) => id)), {
					signal: poll.stop.signal,
				});
				steps = res.ok
					? (((await res.json()) as ActivityAnswer).steps ?? {})
					: null;
			} catch {
				// Stopped, or the server is busy: the load says the rest.
				steps = null;
			}
		}
		if (poll.stop.signal.aborted) return;
		for (const user of users) {
			const mine = wanted.filter(([, request]) => user.match(request));
			if (mine.length === 0) {
				user.empties++;
				if (user.empties >= EMPTY_ASKS_CLEAR) user.step = null;
			} else if (steps) {
				user.empties = 0;
				// The oldest of its requests with a step.
				user.step = mine.map(([id]) => steps?.[id]).find((s) => s) ?? null;
			}
			user.notify();
		}
		poll.timer = setTimeout(ask, LOADING_STEP_EVERY_MS);
	};
	poll.timer = setTimeout(ask, LOADING_STEP_AFTER_MS);
	return poll;
}

/**
 * While `active` (a load pending) and past LOADING_STEP_AFTER_MS: the
 * step its requests (those `match` picks, the oldest with a step first)
 * wait on (`step`; else null), and whether this hook's line is the one
 * read out (`live`: the first active hook of its key, so many panes of
 * one wait make one live region). Hooks of the same `key` share one ask loop (one
 * request for all of theirs: every pane of a threads read, every Home
 * repo), from the first one active to the last; each shows its own
 * requests' step. A failed ask shows nothing new; a hook whose requests
 * are gone for EMPTY_ASKS_CLEAR asks shows nothing.
 */
export function useLoadingStep(
	key: string,
	match: (request: OutRequest) => boolean,
	active: boolean,
): { step: LoadingStep | null; live: boolean } {
	const matchRef = useRef(match);
	matchRef.current = match;
	const [shown, setShown] = useState<{
		step: ActivityStep | null;
		live: boolean;
	}>({ step: null, live: false });
	useEffect(() => {
		if (!active) return;
		let poll = polls.get(key);
		if (!poll) {
			poll = startPoll();
			polls.set(key, poll);
		}
		const mine = poll;
		const user: User = {
			match: (r) => matchRef.current(r),
			step: null,
			empties: 0,
			notify: () =>
				setShown({
					step: user.step,
					live: mine.users.values().next().value === user,
				}),
		};
		mine.users.add(user);
		user.notify();
		return () => {
			const wasFirst = mine.users.values().next().value === user;
			mine.users.delete(user);
			if (mine.users.size === 0) {
				mine.stop.abort();
				clearTimeout(mine.timer);
				if (polls.get(key) === mine) polls.delete(key);
			} else if (wasFirst) {
				// The next one is read out now.
				mine.users.values().next().value?.notify();
			}
			setShown({ step: null, live: false });
		};
	}, [key, active]);
	if (!active || !shown.step) return { step: null, live: active && shown.live };
	const s = Math.floor(shown.step.ms / 1000);
	return {
		step: {
			label: shown.step.label,
			seconds: s >= 1 ? s : null,
			text: stepText(shown.step),
		},
		live: shown.live,
	};
}

/**
 * A step's line: the label read out (aria-live), the seconds beside it
 * not (they change every second; only a new step is news).
 */
export function StepText({ step }: { step: LoadingStep }) {
	return (
		<>
			{step.label}
			{step.seconds !== null && (
				<span aria-hidden="true"> · {step.seconds}s</span>
			)}
		</>
	);
}
