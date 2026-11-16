import type { AgentThread } from "../../shared/agent";
import type { ReviewThread } from "../../shared/types";
import type { AgentPlaceable } from "../agent/placeable";

/** Who spoke last in a conversation: a person on GitHub, or the reviewer or the agent. */
export type LastSpeaker =
	| { kind: "person"; login: string; avatarUrl: string; bot: boolean }
	| { kind: "agent"; by: "human" | "ai" };

/** One conversation's row in the Threads panel. */
export interface PanelRow {
	/** "gh:<id>" or "ai:<id>": unique across both regions. */
	key: string;
	id: string;
	/** Where it shows in the viewed snapshot (where it was made when it shows nowhere). */
	path: string;
	/** Its line there; null on a file, or where no line is known. */
	line: number | null;
	/** Its last activity (ISO). */
	at: string;
	resolved: boolean;
	last: LastSpeaker;
	/** A GitHub thread that waits on the viewer. */
	yourTurn: boolean;
	/** GitHub says its line is outdated. */
	outdated: boolean;
	/** An agent message the reviewer hasn't seen. */
	unread: boolean;
	/** A reviewer's message no answer has seen yet. */
	waiting: boolean;
	/**
	 * The card the row shows (threadFocus): a review thread's, or an agent
	 * thread's; a conversation on a review thread is that thread's card
	 * with the conversation open.
	 */
	focus: { id: string; conversation?: string };
	/** What it's about: the start of its first comment, as plain text. */
	blurb: Blurb;
}

/**
 * A row's second line: the start of its first comment; still loading (a
 * skeleton, never a blank); or why there is none (GitHub's words).
 */
export type Blurb =
	| { kind: "text"; text: string }
	| { kind: "loading" }
	/** Its text was to come from a read that failed. */
	| { kind: "failed" }
	| { kind: "unavailable"; text: string };

/**
 * Markdown as plain words for a one-line blurb: code fences, images and
 * HTML tags out, links to their text, emphasis, heading, quote and list
 * marks dropped, whitespace collapsed. Text only (React escapes it); not a
 * renderer.
 */
export function plainText(markdown: string): string {
	return (
		markdown
			.replace(/```[^\n]*\n?/g, " ")
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/<[^>]+>/g, " ")
			.replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, "")
			.replace(/~~|`/g, "")
			// Emphasis marks at a word's edge (snake_case keeps its own).
			.replace(/(^|[\s(])[*_]+(?=\S)/g, "$1")
			.replace(/(?<=\S)[*_]+(?=$|[\s.,;:!?)])/g, "")
			.replace(/\s+/g, " ")
			.trim()
	);
}

/** A GitHub thread's blurb: its excerpt once read, else loading (or failed) or why not. */
function githubBlurb(t: ReviewThread, contentFailed: boolean): Blurb {
	if (t.unavailable === "deleted")
		return { kind: "unavailable", text: "Deleted on GitHub" };
	if (t.unavailable === "unreadable")
		return { kind: "unavailable", text: "Couldn't be read from GitHub" };
	if (!t.loaded)
		return contentFailed ? { kind: "failed" } : { kind: "loading" };
	return { kind: "text", text: t.excerpt };
}

/**
 * An agent thread's blurb: the reviewer's first question; one the agent
 * opened, the reviewer's request it came from (`origin`, a message of
 * another of `all`), else its first message.
 */
export function agentBlurb(
	t: AgentThread,
	all: readonly AgentThread[] = [],
): Blurb {
	const request = (): string | undefined => {
		const origin = t.messages.find((m) => m.origin)?.origin;
		if (!origin) return undefined;
		return all
			.find((o) => o.id === origin.thread)
			?.messages.find((m) => m.id === origin.message)?.text;
	};
	const source =
		t.openedBy === "ai"
			? (request() ?? t.messages[0]?.text ?? "")
			: (t.messages.find((m) => m.by === "human")?.text ??
				t.messages[0]?.text ??
				"");
	return { kind: "text", text: plainText(source) };
}

/** A shown thread's line: its last line; none on a file, or none known. */
const lineOf = (
	subject: "line" | "file",
	anchor: { line: number } | null,
): number | null => (subject === "file" || !anchor ? null : anchor.line);

/**
 * Where a GitHub thread is: where it shows in the viewed snapshot
 * (`shown`, by id: shownThreads), else where it was made.
 */
function githubPlace(
	t: ReviewThread,
	shown: ReadonlyMap<string, ReviewThread>,
): { path: string; line: number | null } {
	const s = shown.get(t.id);
	if (s) return { path: s.path, line: lineOf(s.subject, s.anchor) };
	return { path: t.path, line: t.line };
}

/** The PR's review threads as rows, every one (resolved too), unsorted. */
export function githubRows(
	threads: readonly ReviewThread[],
	shown: ReadonlyMap<string, ReviewThread>,
	/** The read that brings the threads' text failed. */
	opts: { contentFailed?: boolean } = {},
): PanelRow[] {
	return threads.map((t) => ({
		key: `gh:${t.id}`,
		id: t.id,
		...githubPlace(t, shown),
		focus: { id: t.id },
		blurb: githubBlurb(t, opts.contentFailed === true),
		at: t.lastActivityAt,
		resolved: t.resolved,
		last: {
			kind: "person",
			login: t.lastAuthor.login,
			avatarUrl: t.lastAuthor.avatarUrl,
			bot: t.lastAuthor.bot,
		},
		yourTurn: t.yourTurn && !t.resolved,
		outdated: t.outdated,
		unread: false,
		waiting: false,
	}));
}

/** Where an agent thread was asked. */
function askedPlace(t: AgentThread): { path: string; line: number | null } {
	const a = t.anchor;
	return {
		path: a.path,
		line: a.subject === "file" || a.line === undefined ? null : a.line,
	};
}

/**
 * The reviewer's agent conversations as rows, every one (resolved too),
 * unsorted. One on a GitHub thread goes where that thread shows; a span
 * question where Files changed shows it (`shown`, by id:
 * shownAgentPlaceables); else where it was asked.
 */
export function agentRows(
	threads: readonly AgentThread[],
	shown: ReadonlyMap<string, AgentPlaceable>,
	githubShown: ReadonlyMap<string, ReviewThread>,
): PanelRow[] {
	return threads.map((t) => {
		const lastMessage = t.messages.at(-1);
		const a = t.anchor;
		const onGithub =
			a.subject === "thread" ? githubShown.get(a.thread) : undefined;
		const p = shown.get(t.id);
		const place = onGithub
			? githubPlace(onGithub, new Map([[onGithub.id, onGithub]]))
			: p
				? { path: p.path, line: lineOf(p.subject, p.anchor) }
				: askedPlace(t);
		// On a GitHub thread: that thread's card, its conversation open.
		const focus =
			a.subject === "thread" && !t.orphaned
				? { id: a.thread, conversation: t.id }
				: { id: t.id };
		return {
			key: `ai:${t.id}`,
			id: t.id,
			...place,
			focus,
			blurb: agentBlurb(t, threads),
			at: lastMessage?.at ?? t.at,
			resolved: t.resolved,
			last: { kind: "agent", by: lastMessage?.by ?? t.openedBy },
			yourTurn: false,
			outdated: false,
			unread: t.unread,
			waiting: t.waiting,
		};
	});
}

const timeOf = (iso: string) => {
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

/**
 * The rows a region lists: newest activity first (an undated one last),
 * resolved ones only when `showResolved`. Nothing else is left out.
 */
export function listedRows(
	rows: readonly PanelRow[],
	showResolved: boolean,
): PanelRow[] {
	return rows
		.filter((r) => showResolved || !r.resolved)
		.map((r, i) => ({ r, i, ms: timeOf(r.at) }))
		.sort((x, y) => y.ms - x.ms || x.i - y.i)
		.map(({ r }) => r);
}

/** What the page knows of where conversations' cards are (FilesPage). */
export interface FocusWorld {
	/** The diff's file at `path` (old paths too), by index; undefined: none. */
	fileOf: (path: string) => number | undefined;
	/** The "needs eyes" filter hides file `index`. */
	hidden: (index: number) => boolean;
	/** Review threads whose cards are listed after the files (not in the comparison, unplaced on a failure). */
	githubAfter: ReadonlySet<string>;
	/** Agent threads whose cards are listed after the files. */
	agentAfter: ReadonlySet<string>;
	/** The placements are still on their way: a card may yet show anywhere. */
	pending: boolean;
}

/**
 * What a row's pick does: the file to open (null: none), whether "needs
 * eyes" must let that file show again, and the card to ask for (null: no
 * card can show it in this view; nothing is left pending).
 */
export interface FocusPlan {
	open: number | null;
	unhide: boolean;
	request: PanelRow["focus"] | null;
}

export function focusPlan(row: PanelRow, w: FocusWorld): FocusPlan {
	const none = { open: null, unhide: false, request: null };
	const onGithub = row.key.startsWith("gh:") || !!row.focus.conversation;
	const after = onGithub ? w.githubAfter : w.agentAfter;
	if (after.has(row.focus.id)) return { ...none, request: row.focus };
	const file = w.fileOf(row.path);
	if (file !== undefined) {
		return { open: file, unhide: w.hidden(file), request: row.focus };
	}
	return w.pending ? { ...none, request: row.focus } : none;
}

/**
 * The agent conversations this view lists: one on a review thread only
 * while that thread is listed here (an earlier patch set leaves out those
 * published after it; one deleted here is gone), as its card is where the
 * conversation shows. Span questions (orphans too) always.
 */
export function listedConversations(
	threads: readonly AgentThread[],
	githubListed: ReadonlySet<string>,
): AgentThread[] {
	return threads.filter(
		(t) =>
			t.anchor.subject !== "thread" ||
			t.orphaned === true ||
			githubListed.has(t.anchor.thread),
	);
}
