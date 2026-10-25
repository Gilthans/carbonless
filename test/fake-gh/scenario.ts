import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import prViewFixture from "../fixtures/gh/pr-view.json" with { type: "json" };
import threadsFixture from "../fixtures/gh/review-threads.json" with {
	type: "json",
};

/** Directory holding the fake `gh`; put it first on PATH. */
export const FAKE_GH_DIR = resolve(import.meta.dirname);

/** What the fake `gh` (test/fake-gh/gh) answers, read from `$CRB_FAKE_GH`. */
export interface Scenario {
	/** Local repository that `gh repo clone` clones from. */
	repoPath: string;
	user: { login: string };
	/** Answer to `gh repo view --json nameWithOwner`; absent = not a GitHub repo. */
	nameWithOwner?: string;
	/** Every `gh` call fails as if no account were logged in. */
	loggedOut?: boolean;
	/** `gh repo clone` fails with this as git's last stderr line. */
	cloneError?: string;
	/** `gh pr view` answers only after this many milliseconds. */
	prViewDelayMs?: number;
	/** Nodes per GraphQL page (default 100, like gh.ts asks for). */
	pageSize?: number;
	prs: Record<
		string,
		{
			/** `gh pr view --json` object; only the requested fields are printed. */
			view: Record<string, unknown>;
			/** Full node lists of each PR connection; the fake pages them. */
			graphql?: {
				/** The description as GitHub renders it (`pullRequest { bodyHTML }`). */
				bodyHTML?: string;
				reviewThreads?: unknown[];
				comments?: unknown[];
				reviews?: unknown[];
			};
		}
	>;
}

/** Writes the scenario as JSON into `dir` and returns its path for `$CRB_FAKE_GH`. */
export function writeScenario(dir: string, s: Scenario): string {
	const path = join(dir, "fake-gh-scenario.json");
	writeFileSync(path, JSON.stringify(s, null, "\t"));
	return path;
}

/** A `gh pr view` object: the synthetic fixture plus what fetchPrMeta reads. */
export function prView(
	partial: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		...prViewFixture,
		headRefOid: "0".repeat(40),
		headRepository: { name: "widget" },
		headRepositoryOwner: { login: "acme" },
		...partial,
	};
}

type ThreadNode = (typeof threadsFixture)[number];

/** A review comment with its text, as the aliased `first` query returns it. */
export interface CommentNode {
	author: { login: string; __typename: string };
	bodyText: string;
	bodyHTML: string;
	createdAt: string;
}

/**
 * A reviewThreads node shaped like the synthetic fixture's first thread.
 * `comments` (opener first) fills both the aliased `first` comment and the
 * authors-only list.
 */
export function reviewThread(
	partial: Partial<Omit<ThreadNode, "first" | "comments">> = {},
	comments?: CommentNode[],
): ThreadNode {
	const base = threadsFixture[0];
	if (!base) throw new Error("review-threads.json is empty");
	const opener = comments?.[0];
	return {
		...base,
		...partial,
		...(comments && opener
			? {
					first: { nodes: [opener] },
					comments: {
						totalCount: comments.length,
						nodes: comments.map((c) => ({ author: c.author })),
					},
				}
			: {}),
	};
}

/** GitHub's rendering of the synthetic fixture's description. */
export const FIXTURE_BODY_HTML =
	'<p dir="auto">Caches widgets.</p>\n<p dir="auto">Fixes a slow path.</p>';

/**
 * A review comment node: `text` is the plain text, `html` GitHub's rendering
 * (defaults to `text` in one paragraph).
 */
export function threadComment(c: {
	login: string;
	bot?: boolean;
	text: string;
	html?: string;
	createdAt?: string;
}): CommentNode {
	const escaped = c.text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
	return {
		author: { login: c.login, __typename: c.bot ? "Bot" : "User" },
		bodyText: c.text,
		bodyHTML: c.html ?? `<p dir="auto">${escaped}</p>`,
		createdAt: c.createdAt ?? "2026-01-03T09:00:00Z",
	};
}
