import { join } from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import {
	type AgentAnchor,
	type AgentView,
	PREAMBLE,
	SUGGEST_RESOLVE,
	THREAD_PREAMBLE,
} from "../../shared/agent.js";
import { openedOn } from "../../shared/rereview/openedOn.js";
import type { ThreadPlacement } from "../../shared/rereview/placement.js";

/**
 * What every prompt tells the agent: the fixed PREAMBLE, then the thread as
 * a JSON envelope (data, never instructions), the anchored file and the
 * diff hunk around the anchor. See the spec's "Prompting".
 */

export interface PromptReview {
	repo: string;
	pr: number;
	url: string;
	base: { ref: string; commit: string };
	head: { ref: string; commit: string };
	mergeBase: string;
	tree: string;
}

export interface PromptMessage {
	author: {
		login?: string;
		role: "reviewer" | "pr_author" | "other" | "agent";
	};
	at: string;
	text: string;
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

export interface PromptEnvelope {
	kind: "agent_thread" | "github_thread_conversation";
	review: PromptReview;
	thread: { id: string; anchor: AgentAnchor & { file: string } };
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
 * The anchor as the envelope gives it: `file` its absolute path in the tree
 * (the tree itself for a path that isn't safe), and `commit` the commit its
 * side is on: the merge base (the diff's left side) for a LEFT anchor,
 * whose file in the tree is the head's version. A thread anchor's commit
 * is the one its comment was made on: on the LEFT, the merge base of the
 * patch set with that head, else the review's, as for a line anchor.
 */
export function anchorFor(
	anchor: AgentAnchor,
	review: PromptReview,
	patchsets: readonly { head: string; mergeBase: string }[] = [],
): AgentAnchor & { file: string } {
	const file = isSafePath(anchor.path)
		? join(review.tree, anchor.path)
		: review.tree;
	if (anchor.subject === "file" || anchor.side !== "LEFT") {
		return { ...anchor, file };
	}
	const commit =
		anchor.subject === "thread"
			? (patchsets.find((p) => p.head === anchor.commit)?.mergeBase ??
				review.mergeBase)
			: review.mergeBase;
	return { ...anchor, commit, file };
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
	pr?: PromptEnvelope["pr"];
}): PromptEnvelope {
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

const MIME: Record<string, string> = {
	ts: "text/x-typescript",
	tsx: "text/x-typescript",
	mts: "text/x-typescript",
	cts: "text/x-typescript",
	js: "text/javascript",
	jsx: "text/javascript",
	mjs: "text/javascript",
	cjs: "text/javascript",
	json: "application/json",
	md: "text/markdown",
	py: "text/x-python",
	go: "text/x-go",
	rs: "text/x-rust",
	java: "text/x-java",
	kt: "text/x-kotlin",
	c: "text/x-c",
	h: "text/x-c",
	cc: "text/x-c++",
	cpp: "text/x-c++",
	hpp: "text/x-c++",
	cs: "text/x-csharp",
	rb: "text/x-ruby",
	php: "text/x-php",
	sh: "text/x-shellscript",
	ps1: "text/x-powershell",
	yml: "text/yaml",
	yaml: "text/yaml",
	toml: "text/x-toml",
	html: "text/html",
	css: "text/css",
	sql: "text/x-sql",
	xml: "text/xml",
};

/** The file's text type by its extension, else text/plain. */
export function mimeTypeOf(path: string): string {
	const name = path.split("/").at(-1) ?? "";
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return "text/plain";
	return MIME[name.slice(dot + 1).toLowerCase()] ?? "text/plain";
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
 * `env` with every text from the PR sanitised (sanitizeThirdParty): the
 * base and head ref names, the anchor's path (and so its file), the PR's
 * title, body and file paths, and the GitHub thread's url, path, comment
 * logins and bodies and the placement's paths. The reviewer's and the
 * agent's messages stay.
 */
export function sanitizeEnvelope(env: PromptEnvelope): PromptEnvelope {
	const s = sanitizeThirdParty;
	const { review, thread, pr, github, placement } = env;
	return {
		...env,
		review: {
			...review,
			base: { ...review.base, ref: s(review.base.ref) },
			head: { ...review.head, ref: s(review.head.ref) },
		},
		thread: {
			...thread,
			anchor: {
				...thread.anchor,
				path: s(thread.anchor.path),
				file: s(thread.anchor.file),
			},
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

/**
 * Third-party text in a code fence, by the CommonMark rule: the fence is one
 * backtick longer than the longest run of backticks in the text (at least 3),
 * so nothing inside can close it early. The text itself is unchanged.
 */
export function fenced(text: string, info = ""): string {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? [])
		longest = Math.max(longest, run.length);
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${info}\n${text}\n${fence}`;
}

/**
 * The prompt's blocks: the preamble with the tree's path (and the thread
 * preamble for a thread conversation) and the envelope as JSON; the
 * anchored file as a resource; the diff hunk around the anchor (for a
 * thread conversation, the code it was opened on).
 */
export function buildPrompt(
	env: PromptEnvelope,
	anchored: { uri: string; mimeType: string; text: string } | null,
	hunk: string | null,
): ContentBlock[] {
	const base = PREAMBLE.replace("<tree>", env.review.tree);
	const preamble =
		env.kind === "github_thread_conversation"
			? `${base} ${THREAD_PREAMBLE}`
			: base;
	const blocks: ContentBlock[] = [
		{ type: "text", text: `${preamble}\n\n${JSON.stringify(env)}` },
	];
	if (anchored) blocks.push({ type: "resource", resource: { ...anchored } });
	if (hunk !== null) {
		blocks.push({
			type: "text",
			text: `${env.kind === "github_thread_conversation" ? "The code the thread was opened on" : "Diff hunk around the anchor"}:\n${fenced(hunk, "diff")}`,
		});
	}
	return blocks;
}
