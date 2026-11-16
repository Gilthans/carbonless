/**
 * Links that open one agent conversation (CAR-80): the agent's citations
 * in a reply (`crb:c/<thread id>`), "Go to your request" and the list of
 * the conversations a request started. crb builds every link from a
 * conversation it found among this review's agent threads, never from an
 * href the agent wrote (as codeLinks.ts does for `path:line`).
 *
 * A link goes to Files changed (a conversation on code: its lines at the
 * comparison it is anchored on, as code links do) or to the Overview (one
 * on a GitHub thread: that thread's card). The page then asks for the
 * conversation to open (requestConversationOpen, through threadFocus as
 * the Threads tab's rows do): its card opens (Files changed) or its
 * thread's panel slides in (Overview), and the message named, if any, is
 * outlined for a moment.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useSyncExternalStore } from "react";
import type { AgentMessage, AgentThread } from "../../shared/agent";
import type { ThreadsView } from "../../shared/types";
import { reviewQuery, sessionQuery } from "../api";
import type { FilesSearch } from "../files/landing";
import { threadFocus, usePendingFocus } from "../files/threadFocus";
import type { OverviewSearch } from "../overview/threadLink";
import { codeLinkSearch } from "./codeLinks";
import { openReviewDrawer } from "./drawerStore";

/** An agent thread or message id: a lowercase ULID. */
export const ULID = /^[0-9a-hjkmnp-tv-z]{26}$/;

/** A citation the agent writes in a reply: `crb:c/<thread id>`. */
export const CITATION = /crb:c\/([0-9a-hjkmnp-tv-z]{26})(?![0-9a-z])/g;

/** Where a conversation is, in a few words: `path:start–end`, `path`, or "Thread · <author>". */
export function conversationLabel(
	thread: AgentThread,
	authorOf?: (githubThread: string) => string | undefined,
): string {
	const a = thread.anchor;
	if (a.subject === "review") return "Review";
	if (a.subject === "thread" && !thread.orphaned) {
		return `Thread · ${authorOf?.(a.thread) ?? a.path}`;
	}
	if (a.subject === "file" || a.line === undefined) return a.path;
	const start = a.startLine ?? a.line;
	return start === a.line
		? `${a.path}:${a.line}`
		: `${a.path}:${start}–${a.line}`;
}

/** A link's target: the route and its search. */
export type ConversationTarget =
	| { to: "/r/$id/files"; search: FilesSearch }
	| { to: "/r/$id"; search: OverviewSearch };

/**
 * Where a link to conversation `thread` (landing on `message`, if given)
 * goes: a live GitHub thread's conversation to the Overview's card; one on
 * code (an orphan's last known lines too) to Files changed at its lines, in
 * the comparison its anchor names (the patch set holding its commit, else
 * that commit). Null when its file isn't one of this review's, and for
 * the review conversation (no place in a page).
 */
export function conversationSearch(
	thread: AgentThread,
	files: ReadonlySet<string>,
	patchsets: readonly { number: number; head: string }[],
	message?: string,
): ConversationTarget | null {
	const land = {
		conversation: thread.id,
		...(message !== undefined && ULID.test(message) ? { message } : {}),
	};
	const a = thread.anchor;
	// The review conversation has no place in a page: its drawer shows it.
	if (a.subject === "review") return null;
	if (a.subject === "thread" && !thread.orphaned) {
		return { to: "/r/$id", search: { thread: a.thread, ...land } };
	}
	const line = a.subject === "file" ? undefined : a.line;
	const start = a.subject === "file" ? 1 : (a.startLine ?? a.line ?? 1);
	const found = codeLinkSearch(
		{ path: a.path, start, end: line ?? start },
		a.commit,
		files,
		patchsets,
	);
	if (!found) return null;
	// The range's first line is where it lands; a file's has no line.
	const { line: _l, side: _s, ...where } = found;
	const side = a.subject === "file" ? undefined : a.side;
	return {
		to: "/r/$id/files",
		search: {
			...where,
			...(line !== undefined ? { line: start, side: side ?? "RIGHT" } : {}),
			...land,
		},
	};
}

// --- Opening a conversation on arrival -------------------------------------

/** A conversation to open, and the message to outline; `seq` is new per request. */
export interface ConversationLanding {
	conversation: string;
	message?: string;
	seq: number;
}

/**
 * A page landed on a conversation link: the conversation opens where it
 * shows, through the same request a Threads tab row makes (threadFocus):
 * its card (`card`: its review thread's, for a conversation on one; else
 * its own), with the message outlined. One no card takes (not placed in
 * this comparison) is dropped on the next move to another page, so it
 * never opens a card later, out of the blue. It waits as long as the page
 * takes to place it (placements, GitHub's threads), however slow: no timer.
 */
export function requestConversationOpen(
	conversation: string,
	message?: string,
	card?: string,
): void {
	if (!ULID.test(conversation)) return;
	threadFocus.request({
		id: card ?? conversation,
		conversation,
		...(message !== undefined && ULID.test(message) ? { message } : {}),
	});
}

/** The conversation landing pending on the page showing, whichever it names. */
export function usePendingLanding(): ConversationLanding | null {
	const focus = usePendingFocus();
	return focus?.conversation
		? {
				conversation: focus.conversation,
				...(focus.message ? { message: focus.message } : {}),
				seq: focus.seq,
			}
		: null;
}

/** Forgets a pending landing (tests). */
export function resetConversationLanding(): void {
	threadFocus.reset();
}

// --- In the page ---------------------------------------------------------------

/** The review's files and patch sets, as a link to a conversation needs them. */
export interface LinkFacts {
	files: ReadonlySet<string>;
	patchsets: readonly { number: number; head: string }[];
	/** The review's files are in: until then a code conversation's place is unknown, not "none". */
	ready: boolean;
	/** The review's files couldn't be read: an error, neither loading nor "not in the files". */
	failed: boolean;
}

export function useLinkFacts(): LinkFacts {
	const reviewRead = useQuery({ ...reviewQuery(), enabled: false });
	const review = reviewRead.data;
	const session = useQuery({ ...sessionQuery, enabled: false }).data;
	return {
		files: new Set(review?.files.map((f) => f.path) ?? []),
		patchsets: session?.patchsets ?? [],
		ready: review !== undefined,
		failed: review === undefined && reviewRead.isError,
	};
}

/** What a link to a conversation says while its place is unknown. */
export const LINK_ERROR = "Couldn't read the review's files";

/**
 * A link's target as the page knows it now: `loading` while a code
 * conversation waits for the review's files (never "not in this review's
 * files" before they are in), `error` when they couldn't be read, `none`
 * once they are in and it isn't there.
 */
export type LinkState =
	| { state: "ready"; target: ConversationTarget }
	| { state: "loading" }
	| { state: "error" }
	| { state: "none" };

export function linkState(
	thread: AgentThread,
	facts: LinkFacts,
	message?: string,
): LinkState {
	const target = conversationSearch(
		thread,
		facts.files,
		facts.patchsets,
		message,
	);
	if (target) return { state: "ready", target };
	if (facts.ready) return { state: "none" };
	return facts.failed ? { state: "error" } : { state: "loading" };
}

/**
 * The GitHub threads' first authors, from the threads the page has read.
 * The function changes when a threads read lands, so a label made with it
 * is made again then ("Thread · <path>" becomes "Thread · <author>").
 */
export function useGithubAuthors(): (id: string) => string | undefined {
	const client = useQueryClient();
	const cache = client.getQueryCache();
	const reads = useSyncExternalStore(
		useCallback(
			(changed: () => void) =>
				cache.subscribe((e) => {
					if (e.query.queryKey[0] === "threads") changed();
				}),
			[cache],
		),
		() =>
			cache
				.findAll({ queryKey: ["threads"] })
				.reduce((n, q) => n + q.state.dataUpdatedAt, 0),
	);
	// `reads` is what re-makes it when a threads read lands.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above.
	return useCallback(
		(id: string) => {
			for (const [, data] of client.getQueriesData<ThreadsView>({
				queryKey: ["threads"],
			})) {
				const found = data?.threads?.find((t) => t.id === id);
				if (found?.author) return found.author;
			}
			return undefined;
		},
		[client, reads],
	);
}

/**
 * Opens conversation `thread` (landing on `message`): navigates to its
 * page with its search, which asks for it to open there. False when it
 * can't be placed (its file isn't this review's). The review conversation
 * opens its drawer instead, on whatever page shows.
 */
export function useOpenConversation(): (
	thread: AgentThread,
	message?: AgentMessage["id"],
) => boolean {
	const router = useRouter({ warn: false });
	const { files, patchsets } = useLinkFacts();
	return useCallback(
		(thread: AgentThread, message?: string) => {
			// The review conversation's place is its drawer, over any page.
			if (thread.anchor.subject === "review") {
				openReviewDrawer();
				requestConversationOpen(thread.id, message);
				return true;
			}
			const target = conversationSearch(thread, files, patchsets, message);
			if (!target || !router) return false;
			const id = router.state.matches
				.map((m) => (m.params as { id?: string }).id)
				.find((x) => x);
			if (!id) return false;
			void router.navigate({
				to: target.to,
				params: { id },
				search: target.search,
			} as never);
			return true;
		},
		[router, files, patchsets],
	);
}

/**
 * Wraps the citations in rendered (already sanitised) prose in links made
 * by `make` (null: leave it as text): in bare text and whole inline code.
 * Text in existing links and `pre` is left alone.
 */
export function linkCitations(
	root: HTMLElement,
	make: (thread: string, label: Node) => HTMLElement | null,
): void {
	const doc = root.ownerDocument;
	for (const code of root.querySelectorAll("code")) {
		if (code.parentElement?.closest("a, pre, [data-cite]")) continue;
		const text = code.textContent ?? "";
		const m = /^crb:c\/([0-9a-hjkmnp-tv-z]{26})$/.exec(text);
		if (!m) continue;
		const link = make(m[1] as string, code);
		if (!link) continue;
		code.replaceWith(link);
	}
	const texts: Text[] = [];
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (!n.parentElement?.closest("a, pre, code, [data-cite]")) {
			texts.push(n as Text);
		}
	}
	for (const text of texts) {
		const pieces: Node[] = [];
		let at = 0;
		for (const m of text.data.matchAll(CITATION)) {
			const link = make(m[1] as string, doc.createTextNode(m[0]));
			if (!link) continue;
			if (m.index > at) {
				pieces.push(doc.createTextNode(text.data.slice(at, m.index)));
			}
			pieces.push(link);
			at = m.index + m[0].length;
		}
		if (!pieces.length) continue;
		if (at < text.data.length) {
			pieces.push(doc.createTextNode(text.data.slice(at)));
		}
		text.replaceWith(...pieces);
	}
}
