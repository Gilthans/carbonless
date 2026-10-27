import type { FixtureCommit } from "../git-fixture";
import {
	type CommentNode,
	reviewThread,
	suggestionHtml,
	type ThreadNode,
	threadComment,
} from "./scenario";

/*
 * A PR with long, many-party review threads, for the threads demo
 * (scripts/demo-threads.ts) and the e2e tests that check how people are
 * told apart (avatars, tints). Synthetic people and text; the avatars of
 * some are real public GitHub ones, the rest have none (the fallback).
 * The viewer is Octo_Cat, the PR author octo-author.
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
	lena: { login: "lena" },
	sam: { login: "sam-k", avatarUrl: avatar(9919) },
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
			...(i === 0 ? { commit: head, diffHunk: hunk(path, line) } : {}),
		}),
	);
	return reviewThread({ path, line, subjectType: "LINE", ...more }, comments);
}

const { badyan, dima, author, viewer, lena, sam, bot } = DEMO_PEOPLE;

const LONG = [
	"I went through every caller of the client to see what a retry would do to them, and I think we need to be careful here.",
	"The upload path is not idempotent: a 502 after the server accepted the body means a retry uploads it twice. The sync path is fine, it sends a revision and the server refuses a stale one. The search path doesn't care.",
	"So either the retry learns which calls are safe (a flag per call, defaulting to no), or the upload path gets an idempotency key first. I'd rather do the key: it fixes the double upload we already see when people double-click, too.",
	"Either way, not in this PR. I'll open an issue and we keep retries off for uploads until then.",
].join("\n\n");

/**
 * The demo's threads on the PR whose head is `head`, most recent first as
 * GitHub would list any order: four long ones with three to five people
 * (one resolved; a bot; the viewer's reply; Markdown and code; a long
 * comment; one waiting on the viewer) and three short ones.
 */
export function demoThreads(head: string): ThreadNode[] {
	return [
		// Waits on the viewer: dima answered them last. Markdown and code.
		thread(head, "src/cache.ts", 12, "2026-01-03T08:00:00Z", [
			{ who: badyan, text: "Is a minute the right default TTL?" },
			{
				who: dima,
				text: "For widgets, yes. Prices change faster though.",
			},
			{
				who: author,
				text: "Prices don't go through this cache. Only widget metadata.",
			},
			{
				who: lena,
				text: "Then can we name it for that? WidgetCache, or a ttl per use.",
				html: '<p dir="auto">Then can we name it for that? <code class="notranslate">WidgetCache</code>, or a ttl per use.</p>',
				body: "Then can we name it for that? `WidgetCache`, or a ttl per use.",
			},
			{
				who: viewer,
				text: "A ttl per use: new Cache<Widget>(5 * 60_000) reads fine.",
				html: '<p dir="auto">A ttl per use:</p>\n<div class="highlight highlight-source-ts notranslate position-relative overflow-auto" dir="auto"><pre><span class="pl-k">const</span> <span class="pl-s1">widgets</span> <span class="pl-c1">=</span> <span class="pl-k">new</span> <span class="pl-smi">Cache</span><span class="pl-kos">&lt;</span><span class="pl-smi">Widget</span><span class="pl-kos">&gt;</span><span class="pl-kos">(</span><span class="pl-c1">5</span> <span class="pl-c1">*</span> <span class="pl-c1">60_000</span><span class="pl-kos">)</span><span class="pl-kos">;</span></pre></div>\n<p dir="auto">reads fine.</p>',
				body: "A ttl per use:\n\n```ts\nconst widgets = new Cache<Widget>(5 * 60_000);\n```\n\nreads fine.",
			},
			{ who: badyan, text: "Agreed, and keep 60s as the default." },
			{ who: author, text: "Done in the next push." },
			{ who: lena, text: "Thanks!" },
			{
				who: dima,
				text: "One more: should clear() also reset the hit counters?",
			},
			{
				who: dima,
				text: "@Octo_Cat you added the counters, what do you think?",
				html: `<p dir="auto"><a class="user-mention notranslate" href="https://github.com/Octo_Cat">@Octo_Cat</a> ${esc("you added the counters, what do you think?")}</p>`,
			},
		]),
		// Resolved, with a long comment and a bot.
		thread(
			head,
			"src/api/client.ts",
			20,
			"2026-01-02T10:00:00Z",
			[
				{ who: sam, text: "Should a 5xx here be retried?" },
				{ who: author, text: "Yes, through retry() below." },
				{
					who: badyan,
					text: LONG,
					html: LONG.split("\n\n")
						.map((p) => `<p dir="auto">${esc(p)}</p>`)
						.join("\n"),
				},
				{ who: bot, text: "This branch is 3 commits behind main." },
				{ who: author, text: "Fair. Uploads opt out for now." },
				{ who: sam, text: "Works for me." },
				{ who: badyan, text: "Issue filed: #812." },
				{ who: author, text: "Linked it in the code." },
			],
			{ isResolved: true },
		),
		// The viewer answered last: not their turn.
		thread(head, "src/util/retry.ts", 8, "2026-01-02T14:00:00Z", [
			{ who: dima, text: "Backoff without jitter will stampede." },
			{ who: author, text: "Good point. Full jitter?" },
			{ who: viewer, text: "Full jitter, capped at 30s." },
			{ who: dima, text: "Capped at 30s is plenty." },
			{ who: author, text: "Pushed." },
			{ who: viewer, text: "Looks right now, thanks." },
		]),
		// Five people, a suggested change.
		thread(head, "src/api/client.ts", 34, "2026-01-04T09:00:00Z", [
			{ who: lena, text: "429 should be retryable too." },
			{ who: badyan, text: "With Retry-After respected, yes." },
			{ who: dima, text: "Only if the header is there; else the backoff." },
			{
				who: sam,
				text: "Suggested change",
				html: `<p dir="auto">Something like:</p>\n${suggestionHtml(
					["\tif (res.status >= 500) throw new RetryableError(res.status);"],
					[
						"\tif (res.status >= 500 || res.status === 429) {",
						'\t\tthrow new RetryableError(res.status, res.headers.get("retry-after"));',
						"\t}",
					],
				)}`,
				body: '```suggestion\n\tif (res.status >= 500 || res.status === 429) {\n\t\tthrow new RetryableError(res.status, res.headers.get("retry-after"));\n\t}\n```',
			},
			{ who: author, text: "Taking it." },
			{ who: lena, text: "And a test for the header?" },
			{ who: author, text: "Added one with and one without." },
			{ who: badyan, text: "What about a Retry-After in the past?" },
			{ who: dima, text: "Treat it as zero." },
			{ who: sam, text: "+1, zero." },
			{ who: author, text: "Zero it is." },
			{ who: lena, text: "Great, thanks all." },
		]),
		// Short ones.
		thread(head, "src/cache.ts", 30, "2026-01-02T09:00:00Z", [
			{ who: bot, text: "clear() is not covered by tests." },
		]),
		thread(
			head,
			"src/util/retry.ts",
			3,
			"2026-01-02T11:00:00Z",
			[
				{ who: badyan, text: "Why 5?" },
				{ who: author, text: "GitHub's own client uses 5." },
			],
			{ isResolved: true },
		),
		thread(head, "src/cache.ts", 2, "2026-01-04T12:00:00Z", [
			{ who: sam, text: "A Map keeps insertion order: LRU for free?" },
		]),
	];
}
