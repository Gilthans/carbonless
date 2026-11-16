import { useSyncExternalStore } from "react";

/**
 * Agent conversations a posted comment didn't take (the server's
 * `agentLinkProblem`): conversation id → why, shown on its card for the
 * page's life. The conversation stays where it was; GitHub has the thread.
 */
let problems: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

export function setLinkProblem(thread: string, reason: string): void {
	problems = new Map(problems).set(thread, reason);
	for (const l of listeners) l();
}

/** The conversation is linking again (Comment pressed): the old reason goes. */
export function clearLinkProblem(thread: string): void {
	if (!problems.has(thread)) return;
	const next = new Map(problems);
	next.delete(thread);
	problems = next;
	for (const l of listeners) l();
}

/** Forgets every reason (tests). */
export function resetLinkProblems(): void {
	problems = new Map();
	for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
};

export function useLinkProblem(thread: string): string | undefined {
	return useSyncExternalStore(
		subscribe,
		() => problems.get(thread),
		() => problems.get(thread),
	);
}

export const linkProblemOf = (thread: string): string | undefined =>
	problems.get(thread);
