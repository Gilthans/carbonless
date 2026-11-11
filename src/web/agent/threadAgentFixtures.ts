/** Test data for the thread agent's component tests. */
import { vi } from "vitest";
import type { AgentThread } from "../../shared/agent";
import type { ReviewThread } from "../../shared/types";

/**
 * An IntersectionObserver (jsdom has none) that reports each observed
 * element in view (`true`), out of view (`false`), or never (`null`).
 * Undone by vi.unstubAllGlobals.
 */
export function stubIntersection(inView: boolean | null) {
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(readonly callback: IntersectionObserverCallback) {}
			observe(target: Element) {
				if (inView === null) return;
				this.callback(
					[{ target, isIntersecting: inView }] as IntersectionObserverEntry[],
					this as unknown as IntersectionObserver,
				);
			}
			unobserve() {}
			disconnect() {}
			takeRecords() {
				return [];
			}
		},
	);
}

export const reviewThread = (
	more: Partial<ReviewThread> = {},
): ReviewThread => ({
	id: "RT1",
	path: "src/cache.ts",
	line: 4,
	currentLine: 4,
	loaded: true,
	excerpt: "First",
	html: "<p>First</p>",
	body: "First",
	createdAt: "2026-01-03T09:00:00Z",
	lastActivityAt: "2026-01-03T11:00:00Z",
	author: "rev1",
	bot: false,
	avatarUrl: "",
	participants: [],
	commentCount: 3,
	hasReply: true,
	outdated: false,
	resolved: false,
	code: null,
	anchor: null,
	attention: [],
	yourTurn: false,
	viewerCan: { reply: true, resolve: true, unresolve: true },
	commit: "c0",
	subject: "line",
	...more,
});

export const conversation = (more: Partial<AgentThread> = {}): AgentThread => ({
	id: "A1",
	anchor: {
		subject: "thread",
		thread: "RT1",
		path: "src/cache.ts",
		commit: "c0",
		side: "RIGHT",
		line: 4,
		startSide: "RIGHT",
		startLine: 4,
	},
	openedBy: "human",
	at: "2026-11-11T10:00:00Z",
	messages: [
		{ id: "m1", by: "human", at: "2026-11-11T10:00:00Z", text: "Fixed?" },
		{ id: "m2", by: "ai", at: "2026-11-11T10:01:00Z", text: "Yes." },
		{ id: "m3", by: "human", at: "2026-11-11T10:02:00Z", text: "Everywhere?" },
		{ id: "m4", by: "ai", at: "2026-11-11T10:03:00Z", text: "Only here." },
	],
	resolved: false,
	waiting: false,
	unread: false,
	seenUpTo: "m4",
	...more,
});
