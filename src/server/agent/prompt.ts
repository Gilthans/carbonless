import { join } from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { type AgentAnchor, PREAMBLE } from "../../shared/agent.js";
import type { RunnerFacts } from "./runner.js";
import type { AgentThreadFold } from "./store.js";

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
	/** The ACP buddy's checkout; none for a joined session (it has its own copy, if any). */
	tree?: string;
}

export interface PromptMessage {
	author: {
		login?: string;
		role: "reviewer" | "pr_author" | "other" | "agent";
	};
	at: string;
	text: string;
}

export interface PromptEnvelope {
	kind: "agent_thread";
	review: PromptReview;
	thread: { id: string; anchor: AgentAnchor & { file?: string } };
	messages: PromptMessage[];
	notice?: string;
	pr?: { title: string; body: string; files: string[] };
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
 * whose file in the tree is the head's version.
 */
export function anchorFor(
	anchor: AgentAnchor,
	review: PromptReview,
): AgentAnchor & { file: string } {
	const tree = review.tree ?? "";
	const file = isSafePath(anchor.path) ? join(tree, anchor.path) : tree;
	const left = anchor.subject === "line" && anchor.side === "LEFT";
	return { ...anchor, ...(left ? { commit: review.mergeBase } : {}), file };
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
 * base and head ref names, the anchor's path (and so its file), the PR's
 * title, body and file paths. The reviewer's and the agent's messages stay.
 */
export function sanitizeEnvelope(env: PromptEnvelope): PromptEnvelope {
	const s = sanitizeThirdParty;
	const { review, thread, pr } = env;
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
				...(thread.anchor.file === undefined
					? {}
					: { file: s(thread.anchor.file) }),
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
	};
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
 * The prompt's blocks: the preamble with the tree's path and the envelope
 * as JSON; the anchored file as a resource; the diff hunk around the anchor.
 */
export function buildPrompt(
	env: PromptEnvelope,
	anchored: { uri: string; mimeType: string; text: string } | null,
	hunk: string | null,
): ContentBlock[] {
	const preamble = PREAMBLE.replace("<tree>", env.review.tree ?? "");
	const blocks: ContentBlock[] = [
		{ type: "text", text: `${preamble}\n\n${JSON.stringify(env)}` },
	];
	if (anchored) blocks.push({ type: "resource", resource: { ...anchored } });
	if (hunk !== null) {
		blocks.push({
			type: "text",
			text: `Diff hunk around the anchor:\n${fenced(hunk, "diff")}`,
		});
	}
	return blocks;
}

/**
 * A thread as the agent gets it, sanitised (sanitizeEnvelope): the review,
 * the anchor, the messages (the reviewer named by `viewer`), a `notice`,
 * and the PR's title, body and files when `withPr`. `tree: false` (a
 * joined session): no checkout path, in the review or on the anchor.
 */
export async function threadEnvelope(
	facts: Pick<RunnerFacts, "review" | "prFacts" | "authorOf">,
	thread: AgentThreadFold,
	opts: { viewer?: string; withPr: boolean; notice?: string; tree: boolean },
): Promise<PromptEnvelope> {
	const full = facts.review();
	const { tree: _, ...bare } = full;
	const review: PromptReview = opts.tree ? full : bare;
	const anchored = anchorFor(thread.anchor, full);
	const { file: __, ...noFile } = anchored;
	let pr: PromptEnvelope["pr"];
	if (opts.withPr) {
		pr = await facts.prFacts().then(
			(p) => ({ title: p.title, body: p.body, files: p.files }),
			() => undefined,
		);
	}
	const { viewer, notice } = opts;
	return sanitizeEnvelope({
		kind: "agent_thread",
		review,
		thread: { id: thread.id, anchor: opts.tree ? anchored : noFile },
		messages: thread.messages.map(
			(m): PromptMessage =>
				m.by === "ai"
					? { author: { role: "agent" }, at: m.at, text: m.text }
					: {
							author: viewer
								? { login: viewer, role: facts.authorOf(viewer) }
								: { role: "reviewer" },
							at: m.at,
							text: m.text,
						},
		),
		...(notice ? { notice } : {}),
		...(pr ? { pr } : {}),
	});
}
