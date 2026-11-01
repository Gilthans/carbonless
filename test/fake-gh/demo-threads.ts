import { execFileSync } from "node:child_process";
import type { PrOptions } from "../../e2e/pr-setup";
import { testGitEnv } from "../git-fixture";
import {
	type CommentNode,
	reviewThread,
	suggestionHtml,
	type ThreadNode,
	threadComment,
	timelineCommit,
} from "./scenario";
import {
	lineOf,
	SHOWCASE_BASE,
	SHOWCASE_BASE_BINARY,
	SHOWCASE_COMMITS,
} from "./showcase";

/*
 * The showcase PR (test/fake-gh/showcase.ts) with review threads as they
 * usually go, for the threads demo (scripts/demo-threads.ts) and the e2e
 * tests that check how people are told apart (avatars, tints): mostly two
 * people ping-ponging over two or three replies, a few with a third, one
 * longer back-and-forth; one of every shape (a line, a range, a deleted
 * line, a file, resolved, outdated). The gallery's `showcase` case posts
 * the same threads on GitHub. A small cast: the viewer (Octo_Cat), the PR
 * author (octo-author), two reviewers and a bot. Synthetic people and
 * text; some avatars are real public GitHub ones, dima and the bot have
 * none (the fallback).
 */

/** A public GitHub avatar at 40px. */
const avatar = (id: number) =>
	`https://avatars.githubusercontent.com/u/${id}?s=40`;

/** Who speaks: login, avatar (none for some), bot. */
export const DEMO_PEOPLE = {
	badyan: { login: "badyan", avatarUrl: avatar(1) },
	dima: { login: "dima" },
	/** Requests changes (the Final Verdict demo); speaks in no thread. */
	ravi: { login: "ravi", avatarUrl: avatar(3) },
	author: { login: "octo-author", avatarUrl: avatar(2) },
	viewer: { login: "Octo_Cat", avatarUrl: avatar(583231) },
	bot: { login: "renovate", bot: true },
} as const;

type Person = (typeof DEMO_PEOPLE)[keyof typeof DEMO_PEOPLE];

/** The demo PR: the showcase's base, its three commits and their timeline. */
export const DEMO_PR = {
	base: SHOWCASE_BASE,
	baseBinary: SHOWCASE_BASE_BINARY,
	baseDate: "2026-01-01T00:00:00Z",
	files: SHOWCASE_COMMITS,
	overview: {
		title: "Retry the client, cache for a minute, drop the XML servers",
	},
	bodyHTML:
		'<p dir="auto">Retries 5xx with backoff, caches widgets for a minute, drops the XML servers; renames the utils and moves <code class="notranslate">formatPrice</code>.</p>',
	scenario: {
		user: {
			login: DEMO_PEOPLE.viewer.login,
			avatarUrl: DEMO_PEOPLE.viewer.avatarUrl,
		},
	},
} satisfies PrOptions;

/** The timeline's commits, once the repo (base first) has its SHAs. */
export function demoTimeline(shas: string[]): unknown[] {
	return SHOWCASE_COMMITS.map((c, i) =>
		timelineCommit({
			login: DEMO_PEOPLE.author.login,
			at: c.date ?? "2026-01-02T00:00:00Z",
			oid: shas[i + 1] ?? "",
			headline: c.message,
		}),
	);
}

/**
 * What blocks the demo PR from merging (the Final Verdict tab), as fields
 * of its `view` and its `reviews` nodes, once the head is known: a
 * required check failing, one running, three passing; changes requested
 * by ravi (GitHub's decision with it); a code-owner request to a team; the
 * base branch's rule unreadable (no `rule`: protected, hidden).
 */
export function demoVerdict(head: string): {
	view: Record<string, unknown>;
	reviews: unknown[];
} {
	const run = (
		name: string,
		status: string,
		conclusion: string | null,
		required = false,
	) => ({
		__typename: "CheckRun",
		name,
		status,
		conclusion,
		detailsUrl: `https://ci.example/acme/widget/runs/${name.replaceAll(" ", "-")}`,
		startedAt: "2026-01-04T10:00:00Z",
		completedAt: status === "COMPLETED" ? "2026-01-04T10:05:00Z" : null,
		required,
	});
	return {
		view: {
			mergeStateStatus: "BLOCKED",
			reviewDecision: "CHANGES_REQUESTED",
			mergeable: "MERGEABLE",
			reviewRequests: [
				{ __typename: "User", login: DEMO_PEOPLE.dima.login },
				{
					__typename: "Team",
					name: "acme/platform",
					slug: "platform",
					asCodeOwner: true,
				},
			],
			statusCheckRollup: [
				{
					__typename: "StatusContext",
					context: "jira / jira_status_check",
					state: "FAILURE",
					targetUrl: "https://jira.example/browse/WID-42",
					createdAt: "2026-01-04T10:00:00Z",
					required: true,
				},
				run("e2e (phone)", "IN_PROGRESS", null),
				run("build", "COMPLETED", "SUCCESS", true),
				run("lint", "COMPLETED", "SUCCESS"),
				run("unit", "COMPLETED", "SUCCESS"),
			],
		},
		reviews: [
			{
				author: { login: DEMO_PEOPLE.badyan.login, __typename: "User" },
				state: "COMMENTED",
				submittedAt: "2026-01-04T11:00:00Z",
				body: "",
				commit: { oid: head },
			},
			{
				author: { login: DEMO_PEOPLE.ravi.login, __typename: "User" },
				state: "CHANGES_REQUESTED",
				submittedAt: "2026-01-04T12:00:00Z",
				body: "The retry needs a cap on the total wait.",
				commit: { oid: head },
			},
		],
	};
}

const esc = (t: string) =>
	t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** One comment: plain text, or Markdown (`body`) with its HTML. */
export interface Said {
	who: Person;
	text: string;
	html?: string;
	body?: string;
	/** Edited this long after it was written (ms). */
	editedAfter?: number;
}

/** Where a thread is, as GitHub's REST takes it. */
export interface Place {
	path: string;
	/** The commit it's written on: 1–3 (the head is 3). */
	commit: number;
	/** None: a file comment. */
	line?: number;
	startLine?: number;
	side?: "LEFT" | "RIGHT";
}

/** A thread of the showcase: where, when, who said what. */
export interface DemoThread {
	place: Place;
	/** The opener's time (ISO); the replies follow an hour apart. */
	start: string;
	said: Said[];
	resolved?: boolean;
	/** A later commit changed its line. */
	outdated?: boolean;
}

const { badyan, dima, author, viewer, bot } = DEMO_PEOPLE;

const LONG = [
	"I went through every caller of the client to see what a retry would do to them, and I think we need to be careful here.",
	"The upload path is not idempotent: a 502 after the server accepted the body means a retry uploads it twice. The sync path is fine, it sends a revision and the server refuses a stale one. The search path doesn't care.",
	"So either the retry learns which calls are safe (a flag per call, defaulting to no), or the upload path gets an idempotency key first. I'd rather do the key: it fixes the double upload we already see when people double-click, too.",
].join("\n\n");

const HEAD = SHOWCASE_COMMITS.length;
const CACHE = "src/cache.ts";
const CLIENT = "src/api/client.ts";
const RETRY = "src/util/retry.ts";

/**
 * The showcase's threads:
 * - the longer one (7 comments): the viewer and the author back and
 *   forth, badyan joining; Markdown and code, a comment of each of them
 *   edited; it waits on the viewer;
 * - resolved, dima and the author, with a long comment;
 * - outdated: the viewer and the author, fixed by the last commit;
 * - badyan's suggested change, taken;
 * - on three lines: dima and the author, badyan joining;
 * - on a deleted line: badyan and the author;
 * - a bot's, on the file; and a short resolved one.
 */
export const DEMO_THREADS: DemoThread[] = [
	// Waits on the viewer: badyan asked them last.
	{
		place: {
			path: CACHE,
			commit: HEAD,
			line: lineOf(CACHE, HEAD, "private ttlMs = 60_000"),
		},
		start: "2026-01-03T08:00:00Z",
		said: [
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
			{ who: badyan, text: "Should clear() also reset the hit counters?" },
			{
				who: badyan,
				text: "@Octo_Cat you added the counters, what do you think?",
				html: `<p dir="auto"><a class="user-mention notranslate" href="https://github.com/Octo_Cat">@Octo_Cat</a> ${esc("you added the counters, what do you think?")}</p>`,
			},
		],
	},
	// Resolved, with a long comment.
	{
		place: {
			path: CLIENT,
			commit: HEAD,
			line: lineOf(CLIENT, HEAD, "await retry(() => this.fetchWidget(id))"),
		},
		start: "2026-01-02T10:00:00Z",
		said: [
			{ who: dima, text: "Is every call safe to retry?" },
			{ who: author, text: "Yes, they're all reads here." },
			{
				who: dima,
				text: LONG,
				html: LONG.split("\n\n")
					.map((p) => `<p dir="auto">${esc(p)}</p>`)
					.join("\n"),
				body: LONG,
			},
			{ who: author, text: "Fair. Uploads opt out until the key lands." },
		],
		resolved: true,
	},
	// Outdated: the last commit adds the jitter. The viewer answered last.
	{
		place: {
			path: RETRY,
			commit: 2,
			line: lineOf(RETRY, 2, "const delay = 2 ** attempt * 100;"),
		},
		start: "2026-01-02T05:00:00Z",
		said: [
			{ who: viewer, text: "Backoff without jitter will stampede." },
			{ who: author, text: "Full jitter, capped at 30s?" },
			{ who: viewer, text: "Yes, that's plenty." },
		],
		outdated: true,
	},
	// A suggested change, taken.
	{
		place: {
			path: CLIENT,
			commit: HEAD,
			line: lineOf(CLIENT, HEAD, "if (res.status >= 500)"),
		},
		start: "2026-01-04T09:00:00Z",
		said: [
			{
				who: badyan,
				text: "429 should be retryable too.",
				html: `<p dir="auto">429 should be retryable too:</p>\n${suggestionHtml(
					["\t\tif (res.status >= 500) throw new RetryableError(res.status);"],
					[
						"\t\tif (res.status >= 500 || res.status === 429) {",
						"\t\t\tthrow new RetryableError(res.status);",
						"\t\t}",
					],
				)}`,
				body: "429 should be retryable too:\n\n```suggestion\n\t\tif (res.status >= 500 || res.status === 429) {\n\t\t\tthrow new RetryableError(res.status);\n\t\t}\n```",
			},
			{ who: author, text: "Taking it." },
		],
	},
	// On three lines: two ping-ponging, a third joining.
	{
		place: {
			path: CACHE,
			commit: HEAD,
			startLine: lineOf(CACHE, HEAD, "private entries = new Map"),
			line: lineOf(CACHE, HEAD, "private misses = 0;"),
		},
		start: "2026-01-04T12:00:00Z",
		said: [
			{ who: dima, text: "A Map keeps insertion order: LRU for free?" },
			{ who: author, text: "Only if get() re-inserts. Worth it?" },
			{ who: badyan, text: "Not yet: nothing evicts by size." },
		],
	},
	// On a deleted line.
	{
		place: {
			path: CLIENT,
			commit: HEAD,
			line: lineOf(CLIENT, 0, "legacyXml?: boolean;"),
			side: "LEFT",
		},
		start: "2026-01-02T15:00:00Z",
		said: [
			{
				who: badyan,
				text: "Does anyone still run a pre-2.0 server? This breaks them.",
			},
			{ who: author, text: "Support says the last one upgraded in March." },
		],
	},
	// A bot's, on the whole file.
	{
		place: { path: CACHE, commit: HEAD },
		start: "2026-01-02T09:00:00Z",
		said: [
			{
				who: bot,
				text: "Coverage of this file: 64% (−18%). clear() and has() are not covered.",
				html: '<p dir="auto">Coverage of this file: 64% (−18%). <code class="notranslate">clear()</code> and <code class="notranslate">has()</code> are not covered.</p>',
				body: "Coverage of this file: 64% (−18%). `clear()` and `has()` are not covered.",
			},
		],
	},
	// Short and resolved.
	{
		place: {
			path: RETRY,
			commit: HEAD,
			line: lineOf(RETRY, HEAD, "export const MAX_ATTEMPTS = 5;"),
		},
		start: "2026-01-02T11:00:00Z",
		said: [
			{ who: dima, text: "Why 5?" },
			{ who: author, text: "GitHub's own client uses 5." },
		],
		resolved: true,
	},
];

/**
 * GitHub's diff hunk for a comment on `side` `line` of `path` at `commit`
 * (merge base `base`): the hunk's header and its rows down to that line.
 */
function diffHunk(
	repo: string,
	base: string,
	commit: string,
	path: string,
	line: number,
	side: "LEFT" | "RIGHT",
): string {
	const diff = execFileSync(
		"git",
		["diff", "-M", "-U3", base, commit, "--", path],
		{ cwd: repo, encoding: "utf8", env: testGitEnv() },
	);
	let rows: string[] = [];
	let oldNo = 0;
	let newNo = 0;
	for (const l of diff.split("\n")) {
		const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
		if (h) {
			rows = [l];
			oldNo = Number(h[1]);
			newNo = Number(h[2]);
			continue;
		}
		if (rows.length === 0 || l === "" || l.startsWith("\\")) continue;
		const oldLine = l.startsWith("+") ? null : oldNo++;
		const newLine = l.startsWith("-") ? null : newNo++;
		rows.push(l);
		if ((side === "LEFT" ? oldLine : newLine) === line) return rows.join("\n");
	}
	throw new Error(`${path}:${line} (${side}) is not in the diff at ${commit}`);
}

/**
 * The demo's threads as GitHub's GraphQL lists them, on the repo at `path`
 * whose commits are `shas` (the base, then the showcase's three).
 */
export function demoThreads(repo: {
	path: string;
	shas: string[];
}): ThreadNode[] {
	const base = repo.shas[0] ?? "";
	return DEMO_THREADS.map(({ place, start, said, resolved, outdated }) => {
		const commit = repo.shas[place.commit] ?? "";
		const side = place.side ?? "RIGHT";
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
				...(i === 0
					? {
							commit,
							diffHunk:
								place.line === undefined
									? ""
									: diffHunk(
											repo.path,
											base,
											commit,
											place.path,
											place.line,
											side,
										),
						}
					: {}),
			}),
		);
		const line = place.line ?? 1;
		return reviewThread(
			{
				path: place.path,
				subjectType: place.line === undefined ? "FILE" : "LINE",
				isResolved: resolved ?? false,
				isOutdated: outdated ?? false,
				line: outdated ? null : line,
				originalLine: line,
				diffSide: side,
				...(place.startLine === undefined
					? {}
					: {
							startLine: place.startLine,
							originalStartLine: place.startLine,
							startDiffSide: side,
						}),
			},
			comments,
		);
	});
}
