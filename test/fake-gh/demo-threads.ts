import type { FixtureCommit } from "../git-fixture";
import {
	type CommentNode,
	reviewThread,
	suggestionHtml,
	type ThreadNode,
	threadComment,
} from "./scenario";

/*
 * A PR with review threads as they usually go, for the threads demo
 * (scripts/demo-threads.ts) and the e2e tests that check how people are
 * told apart (avatars, tints): mostly two people ping-ponging over two or
 * three replies, a few with a third, one longer back-and-forth. A small
 * cast: the viewer (Octo_Cat), the PR author (octo-author), two reviewers
 * and a bot. Synthetic people and text; some avatars are real public
 * GitHub ones, dima and the bot have none (the fallback).
 */

/** A public GitHub avatar at 40px. */
const avatar = (id: number) =>
	`https://avatars.githubusercontent.com/u/${id}?s=40`;

/** Who speaks: login, avatar (none for some), bot. */
export const DEMO_PEOPLE = {
	badyan: { login: "badyan", avatarUrl: avatar(1) },
	dima: { login: "dima" },
	author: { login: "octo-author", avatarUrl: avatar(2) },
	viewer: { login: "Octo_Cat", avatarUrl: avatar(583231) },
	bot: { login: "renovate", bot: true },
} as const;

type Person = (typeof DEMO_PEOPLE)[keyof typeof DEMO_PEOPLE];

const lines = (n: number, f: (i: number) => string) =>
	`${Array.from({ length: n }, (_, i) => f(i + 1)).join("\n")}\n`;

const CACHE = lines(
	40,
	(i) =>
		({
			1: "export class Cache<T> {",
			2: "\tprivate entries = new Map<string, { value: T; at: number }>();",
			12: "\tconstructor(private ttlMs = 60_000) {}",
			20: "\tget(key: string): T | undefined {",
			30: "\tclear(): void { this.entries.clear(); }",
			40: "}",
		})[i] ?? `\t// cache line ${i}`,
);
const CLIENT = lines(
	50,
	(i) =>
		({
			1: 'import { Cache } from "../cache";',
			20: "\tconst res = await fetch(url, { signal });",
			34: "\tif (res.status >= 500) throw new RetryableError(res.status);",
		})[i] ?? `// client line ${i}`,
);
const RETRY = lines(
	20,
	(i) =>
		({
			3: "export const MAX_ATTEMPTS = 5;",
			8: "export async function retry<T>(f: () => Promise<T>): Promise<T> {",
		})[i] ?? `// retry line ${i}`,
);

/** The PR's one commit: three new files the threads are on. */
export const DEMO_FILES: FixtureCommit[] = [
	{
		message: "Cache widgets, retry the client",
		files: {
			"src/cache.ts": CACHE,
			"src/api/client.ts": CLIENT,
			"src/util/retry.ts": RETRY,
		},
		date: "2026-01-02T00:00:00Z",
	},
];

const FILES: Record<string, string> = {
	"src/cache.ts": CACHE,
	"src/api/client.ts": CLIENT,
	"src/util/retry.ts": RETRY,
};

/** GitHub's hunk of a new file, down to the commented line. */
function hunk(path: string, line: number): string {
	const text = (FILES[path] ?? "").split("\n").slice(0, line);
	const total = (FILES[path] ?? "").split("\n").length - 1;
	return [`@@ -0,0 +1,${total} @@`, ...text.map((l) => `+${l}`)].join("\n");
}

const esc = (t: string) =>
	t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** One comment: plain text, or Markdown with its HTML. */
interface Said {
	who: Person;
	text: string;
	html?: string;
	body?: string;
	/** Edited this long after it was written (ms). */
	editedAfter?: number;
}

/**
 * A thread on `path:line` made on `head`, its comments an hour apart from
 * `start` (ISO), opener first.
 */
function thread(
	head: string,
	path: string,
	line: number,
	start: string,
	said: Said[],
	more: Partial<Omit<ThreadNode, "first" | "comments">> = {},
): ThreadNode {
	const t0 = Date.parse(start);
	const comments: CommentNode[] = said.map((s, i) =>
		threadComment({
			login: s.who.login,
			bot: "bot" in s.who ? s.who.bot : false,
			...("avatarUrl" in s.who ? { avatarUrl: s.who.avatarUrl } : {}),
			text: s.text,
			...(s.html ? { html: s.html } : {}),
			...(s.body ? { body: s.body } : {}),
			createdAt: new Date(t0 + i * 3_600_000).toISOString(),
			...(s.editedAfter === undefined
				? {}
				: {
						editedAt: new Date(
							t0 + i * 3_600_000 + s.editedAfter,
						).toISOString(),
					}),
			...(i === 0 ? { commit: head, diffHunk: hunk(path, line) } : {}),
		}),
	);
	return reviewThread({ path, line, subjectType: "LINE", ...more }, comments);
}

const { badyan, dima, author, viewer, bot } = DEMO_PEOPLE;

const LONG = [
	"I went through every caller of the client to see what a retry would do to them, and I think we need to be careful here.",
	"The upload path is not idempotent: a 502 after the server accepted the body means a retry uploads it twice. The sync path is fine, it sends a revision and the server refuses a stale one. The search path doesn't care.",
	"So either the retry learns which calls are safe (a flag per call, defaulting to no), or the upload path gets an idempotency key first. I'd rather do the key: it fixes the double upload we already see when people double-click, too.",
].join("\n\n");

/**
 * The demo's threads on the PR whose head is `head`:
 * - the longer one (7 comments): the viewer and the author back and
 *   forth, badyan joining; Markdown and code, a comment of each of them
 *   edited; it waits on the viewer;
 * - resolved, dima and the author, with a long comment;
 * - the viewer and the author, the viewer answering last;
 * - badyan's suggested change, taken;
 * - dima and the author, badyan joining;
 * - a bot's, and a short resolved one.
 */
export function demoThreads(head: string): ThreadNode[] {
	return [
		// Waits on the viewer: badyan asked them last.
		thread(head, "src/cache.ts", 12, "2026-01-03T08:00:00Z", [
			{ who: viewer, text: "Is a minute the right default TTL?" },
			{
				who: author,
				text: "For widget metadata, yes. Prices don't go through it.",
			},
			{
				who: viewer,
				text: "Then a ttl per use: new Cache<Widget>(5 * 60_000) reads fine.",
				html: '<p dir="auto">Then a ttl per use:</p>\n<div class="highlight highlight-source-ts notranslate position-relative overflow-auto" dir="auto"><pre><span class="pl-k">const</span> <span class="pl-s1">widgets</span> <span class="pl-c1">=</span> <span class="pl-k">new</span> <span class="pl-smi">Cache</span><span class="pl-kos">&lt;</span><span class="pl-smi">Widget</span><span class="pl-kos">&gt;</span><span class="pl-kos">(</span><span class="pl-c1">5</span> <span class="pl-c1">*</span> <span class="pl-c1">60_000</span><span class="pl-kos">)</span><span class="pl-kos">;</span></pre></div>',
				body: "Then a ttl per use:\n\n```ts\nconst widgets = new Cache<Widget>(5 * 60_000);\n```",
				editedAfter: 10 * 60_000,
			},
			{
				who: author,
				text: "Works for me, keeping 60s as the default.",
				html: '<p dir="auto">Works for me, keeping <code class="notranslate">60_000</code> as the default.</p>',
				body: "Works for me, keeping `60_000` as the default.",
				editedAfter: 2 * 60_000,
			},
			{ who: viewer, text: "Thanks." },
			{
				who: badyan,
				text: "Should clear() also reset the hit counters?",
			},
			{
				who: badyan,
				text: "@Octo_Cat you added the counters, what do you think?",
				html: `<p dir="auto"><a class="user-mention notranslate" href="https://github.com/Octo_Cat">@Octo_Cat</a> ${esc("you added the counters, what do you think?")}</p>`,
			},
		]),
		// Resolved, with a long comment.
		thread(
			head,
			"src/api/client.ts",
			20,
			"2026-01-02T10:00:00Z",
			[
				{ who: dima, text: "Should a 5xx here be retried?" },
				{ who: author, text: "Yes, through retry() below." },
				{
					who: dima,
					text: LONG,
					html: LONG.split("\n\n")
						.map((p) => `<p dir="auto">${esc(p)}</p>`)
						.join("\n"),
				},
				{ who: author, text: "Fair. Uploads opt out until the key lands." },
			],
			{ isResolved: true },
		),
		// The viewer answered last: not their turn.
		thread(head, "src/util/retry.ts", 8, "2026-01-02T14:00:00Z", [
			{ who: viewer, text: "Backoff without jitter will stampede." },
			{ who: author, text: "Full jitter, capped at 30s?" },
			{ who: viewer, text: "Yes, that's plenty." },
		]),
		// A suggested change, taken.
		thread(head, "src/api/client.ts", 34, "2026-01-04T09:00:00Z", [
			{
				who: badyan,
				text: "429 should be retryable too.",
				html: `<p dir="auto">429 should be retryable too:</p>\n${suggestionHtml(
					["\tif (res.status >= 500) throw new RetryableError(res.status);"],
					[
						"\tif (res.status >= 500 || res.status === 429) {",
						"\t\tthrow new RetryableError(res.status);",
						"\t}",
					],
				)}`,
				body: "429 should be retryable too:\n\n```suggestion\n\tif (res.status >= 500 || res.status === 429) {\n\t\tthrow new RetryableError(res.status);\n\t}\n```",
			},
			{ who: author, text: "Taking it." },
		]),
		// Two ping-ponging, a third joining.
		thread(head, "src/cache.ts", 2, "2026-01-04T12:00:00Z", [
			{ who: dima, text: "A Map keeps insertion order: LRU for free?" },
			{ who: author, text: "Only if get() re-inserts. Worth it?" },
			{ who: badyan, text: "Not yet: nothing evicts by size." },
		]),
		// A bot's.
		thread(head, "src/cache.ts", 30, "2026-01-02T09:00:00Z", [
			{ who: bot, text: "clear() is not covered by tests." },
		]),
		// Short and resolved.
		thread(
			head,
			"src/util/retry.ts",
			3,
			"2026-01-02T11:00:00Z",
			[
				{ who: dima, text: "Why 5?" },
				{ who: author, text: "GitHub's own client uses 5." },
			],
			{ isResolved: true },
		),
	];
}
