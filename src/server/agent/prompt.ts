import {
	type AgentAnchor,
	type AgentSpanAnchor,
	type AgentView,
	SUGGEST_RESOLVE,
} from "../../shared/agent.js";
import { openedOn } from "../../shared/rereview/openedOn.js";
import type { ThreadPlacement } from "../../shared/rereview/placement.js";

/**
 * What a question tells the agent (`next`): the thread as a JSON envelope
 * (data, never instructions), the anchored file and the diff hunk around
 * the anchor. See the spec's "Prompting".
 */

export interface PromptReview {
	repo: string;
	pr: number;
	url: string;
	base: { ref: string; commit: string };
	head: { ref: string; commit: string };
	mergeBase: string;
}

export interface PromptMessage {
	author: {
		login?: string;
		role: "reviewer" | "pr_author" | "other" | "agent";
	};
	at: string;
	text: string;
	/**
	 * An agent message from `open`: the reviewer's request it came from
	 * (that message's text), so the agent knows why it opened this.
	 */
	re?: string;
}

export type CommentRole = "reviewer" | "pr_author" | "other";

/** One of the reviewer's patch sets, as the envelope lists them. */
export interface PromptPatchset {
	number: number;
	head: string;
	mergeBase: string;
	/** ISO time. */
	startedAt: string;
}

/** The GitHub thread in the envelope (kind `github_thread_conversation`). */
export interface PromptGithub {
	/** The thread's first comment on GitHub. */
	url: string;
	path: string;
	startLine: number | null;
	line: number | null;
	/** The span inside the lines, from the crb marker: both or neither. */
	startCol?: number;
	endCol?: number;
	/** The commit the thread was opened on ("" = unknown). */
	openedOn: string;
	/** The patch set `openedOn` falls in, by when the thread was opened. */
	openedOnPatchset?: number;
	outdated: boolean;
	resolved: boolean;
	comments: {
		author: { login: string; role: CommentRole };
		at: string;
		body: string;
	}[];
}

/** A span or GitHub thread conversation's envelope: the review and the code. */
export interface PromptCodeEnvelope {
	kind: "agent_thread" | "github_thread_conversation";
	review: PromptReview;
	thread: { id: string; anchor: AgentAnchor };
	/** Thread kind only; absent when GitHub couldn't be read or the thread is gone (`notice` says). */
	github?: PromptGithub;
	/** Thread kind only: the comparison the turn answers in. */
	view?: AgentView & { targetPatchset?: number; fromPatchset?: number };
	/** Thread kind only: the PR's newest head on GitHub. */
	current?: string;
	patchsets?: PromptPatchset[];
	/** Thread kind only: the thread's placement on the viewed comparison. */
	placement?: ThreadPlacement;
	messages: PromptMessage[];
	notice?: string;
	pr?: { title: string; body: string; files: string[] };
}

/**
 * The review conversation's envelope: only its own messages, no review
 * data (owner, 2026-11-15); the agent reads the review through crb's tools.
 */
export interface PromptReviewEnvelope {
	kind: "review_conversation";
	thread: { id: string; anchor: { subject: "review" } };
	messages: PromptMessage[];
	/** Not about the review: e.g. why the agent's last tool call was refused. */
	notice?: string;
}

export type PromptEnvelope = PromptCodeEnvelope | PromptReviewEnvelope;

/**
 * GitHub's thread as the runner reads it for a turn (RunnerFacts.github):
 * the session's current read, comment roles named, its placement on the
 * viewed comparison and the code window at `openedOn` as diff text.
 */
export interface GithubThreadFacts {
	url: string;
	path: string;
	startLine: number | null;
	line: number | null;
	startCol?: number | null;
	endCol?: number | null;
	openedOn: string;
	/** When the thread was opened (published), ISO. */
	createdAt: string;
	outdated: boolean;
	resolved: boolean;
	comments: { login: string; role: CommentRole; at: string; body: string }[];
	placement?: ThreadPlacement;
	/** The code the thread was opened on, as diff text; null when unknown. */
	code?: string | null;
}

/** A relative path inside a tree: no leading `/`, no `..` segment, no NUL. */
export function isSafePath(path: string): boolean {
	return (
		path.length > 0 &&
		!path.startsWith("/") &&
		!path.includes("\0") &&
		!path.split(/[/\\]/).includes("..")
	);
}

/**
 * The anchor as the envelope gives it: `commit` the commit its side is
 * on: the merge base (the diff's left side) for a LEFT anchor. A thread
 * anchor's commit is the one its comment was made on: on the LEFT, the
 * merge base of the patch set with that head, else the review's, as for
 * a line anchor. The review conversation's anchor has no commit: as is.
 */
export function anchorFor(
	anchor: AgentSpanAnchor,
	review: PromptReview,
	patchsets?: readonly { head: string; mergeBase: string }[],
): AgentSpanAnchor;
export function anchorFor(
	anchor: AgentAnchor,
	review: PromptReview,
	patchsets?: readonly { head: string; mergeBase: string }[],
): AgentAnchor;
export function anchorFor(
	anchor: AgentAnchor,
	review: PromptReview,
	patchsets: readonly { head: string; mergeBase: string }[] = [],
): AgentAnchor {
	if (anchor.subject === "review") return { subject: "review" };
	if (anchor.subject === "file" || anchor.side !== "LEFT") {
		return { ...anchor };
	}
	const commit =
		anchor.subject === "thread"
			? (patchsets.find((p) => p.head === anchor.commit)?.mergeBase ??
				review.mergeBase)
			: review.mergeBase;
	return { ...anchor, commit };
}

/**
 * A thread conversation's envelope (kind `github_thread_conversation`),
 * not yet sanitised: `github` only when GitHub's thread was read (never a
 * made-up `resolved`), the view with its patch set numbers, `current`, the
 * patch sets and the placement.
 */
export function threadEnvelope(input: {
	review: PromptReview;
	thread: { id: string; anchor: AgentAnchor };
	github: GithubThreadFacts | null;
	view: AgentView;
	current: string;
	patchsets: readonly PromptPatchset[];
	messages: PromptMessage[];
	notice?: string;
	pr?: PromptCodeEnvelope["pr"];
}): PromptCodeEnvelope {
	const { review, thread, github: g, view, patchsets } = input;
	const numberOf = (head: string) =>
		patchsets.find((p) => p.head === head)?.number;
	const targetPatchset =
		"patchset" in view.target ? view.target.patchset : numberOf(view.right);
	const fromPatchset =
		"patchset" in view.from ? view.from.patchset : numberOf(view.left);
	let github: PromptGithub | undefined;
	if (g) {
		const opened = openedOn(
			g.createdAt,
			patchsets.map((p) => ({
				number: p.number,
				startedAt: Date.parse(p.startedAt),
			})),
		);
		const cols =
			typeof g.startCol === "number" && typeof g.endCol === "number"
				? { startCol: g.startCol, endCol: g.endCol }
				: {};
		github = {
			url: g.url,
			path: g.path,
			startLine: g.startLine,
			line: g.line,
			...cols,
			openedOn: g.openedOn,
			...(opened !== null && g.openedOn !== ""
				? { openedOnPatchset: opened }
				: {}),
			outdated: g.outdated,
			resolved: g.resolved,
			comments: g.comments.map((c) => ({
				author: { login: c.login, role: c.role },
				at: c.at,
				body: c.body,
			})),
		};
	}
	return {
		kind: "github_thread_conversation",
		review,
		thread: {
			id: thread.id,
			anchor: anchorFor(thread.anchor, review, patchsets),
		},
		...(github ? { github } : {}),
		view: {
			...view,
			...(targetPatchset !== undefined ? { targetPatchset } : {}),
			...(fromPatchset !== undefined ? { fromPatchset } : {}),
		},
		current: input.current,
		patchsets: patchsets.map((p) => ({ ...p })),
		...(g?.placement ? { placement: g.placement } : {}),
		messages: input.messages,
		...(input.notice ? { notice: input.notice } : {}),
		...(input.pr ? { pr: input.pr } : {}),
	};
}

/**
 * The answer's text without a final `[suggest-resolve]` line, and whether
 * it had one: the last non-blank line holding exactly the marker (spaces
 * around it aside). A marker anywhere else is plain text.
 */
export function takeSuggestion(text: string): {
	text: string;
	suggests: boolean;
} {
	const lines = text.split("\n");
	let last = lines.length - 1;
	while (last >= 0 && (lines[last] ?? "").trim() === "") last--;
	if (last < 0 || (lines[last] ?? "").trim() !== SUGGEST_RESOLVE) {
		return { text, suggests: false };
	}
	return { text: lines.slice(0, last).join("\n").trimEnd(), suggests: true };
}

const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const PICTURE = /<picture\b[\s\S]*?(?:<\/picture\s*>|$)/gi;
const IMG = /<img\b[^>]*>?/gi;
const ZERO_WIDTH = /[\u200B\u200C\u200E\u200F\u2060-\u2064\uFEFF]/g;
/** A zero-width joiner not inside an emoji sequence (an emoji ZWJ sequence keeps its own). */
const LONE_ZWJ =
	/\u{200D}(?!\p{Extended_Pictographic})|(?<!\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u{FE0F})\u{200D}/gu;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are what it strips
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: C0 controls are what it strips
const C0 = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** Unicode tag characters (invisible ASCII look-alikes). */
const TAGS = /[\u{E0000}-\u{E007F}]/gu;

/**
 * Third-party text (a PR's title and body) as it may enter an envelope:
 * without HTML comments, <picture>, <img>, zero-width (a joiner inside an
 * emoji sequence stays) and bidi characters,
 * ANSI CSI sequences, C0 controls (tab, newline and return stay) and
 * Unicode tag characters (U+E0000–U+E007F).
 */
export function sanitizeThirdParty(text: string): string {
	return text
		.replace(HTML_COMMENT, "")
		.replace(PICTURE, "")
		.replace(IMG, "")
		.replace(ZERO_WIDTH, "")
		.replace(LONE_ZWJ, "")
		.replace(BIDI, "")
		.replace(ANSI_CSI, "")
		.replace(C0, "")
		.replace(TAGS, "");
}

/**
 * A one-line label from a third party (a joined session's name, machine,
 * harness): sanitised, every run of whitespace, line separators and NEL
 * one space, C1 controls gone, trimmed, at most `max` code points (a
 * surrogate pair is never split).
 */
export function oneLine(text: string, max: number): string {
	const flat = sanitizeThirdParty(text)
		.replace(/[\s\u0085]+/g, " ")
		.replace(/[\u0080-\u009f]/g, "")
		.trim();
	return Array.from(flat).slice(0, max).join("").trim();
}

/**
 * `env` with every text from the PR sanitised (sanitizeThirdParty): the
 * base and head ref names, the anchor's path, the PR's
 * title, body and file paths, the GitHub thread's url, path, comment
 * logins and bodies, the placement's paths, and the notice (it may name a
 * path or an error from GitHub). The reviewer's and the agent's messages stay.
 */
export function sanitizeEnvelope<E extends PromptEnvelope>(env: E): E;
export function sanitizeEnvelope(env: PromptEnvelope): PromptEnvelope {
	const s = sanitizeThirdParty;
	if (env.kind === "review_conversation") {
		// Its own messages as written, like every envelope's; nothing else.
		return {
			kind: env.kind,
			thread: { id: env.thread.id, anchor: { subject: "review" } },
			messages: env.messages,
			...(env.notice !== undefined ? { notice: s(env.notice) } : {}),
		};
	}
	const { review, thread, pr, github, placement, notice } = env;
	return {
		...env,
		review: {
			...review,
			base: { ...review.base, ref: s(review.base.ref) },
			head: { ...review.head, ref: s(review.head.ref) },
		},
		thread: {
			...thread,
			anchor:
				thread.anchor.subject === "review"
					? { subject: "review" }
					: { ...thread.anchor, path: s(thread.anchor.path) },
		},
		...(pr
			? {
					pr: {
						title: s(pr.title),
						body: s(pr.body),
						files: pr.files.map(s),
					},
				}
			: {}),
		...(github
			? {
					github: {
						...github,
						url: s(github.url),
						path: s(github.path),
						comments: github.comments.map((c) => ({
							...c,
							author: { ...c.author, login: s(c.author.login) },
							body: s(c.body),
						})),
					},
				}
			: {}),
		...(placement ? { placement: sanitizePlacement(placement) } : {}),
		...(notice !== undefined ? { notice: s(notice) } : {}),
	};
}

/** A placement's paths sanitised; its code text is code, like the hunk. */
function sanitizePlacement(p: ThreadPlacement): ThreadPlacement {
	const s = sanitizeThirdParty;
	switch (p.kind) {
		case "placed":
		case "changed":
			return { ...p, anchor: { ...p.anchor, path: s(p.anchor.path) } };
		case "unplaced":
			return {
				...p,
				path: s(p.path),
				...(p.movedTo !== undefined ? { movedTo: s(p.movedTo) } : {}),
			};
		case "file":
		case "outside":
			return { ...p, path: s(p.path) };
	}
}
