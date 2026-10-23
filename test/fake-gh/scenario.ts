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

/** A reviewThreads node shaped like the synthetic fixture's first thread. */
export function reviewThread(partial: Partial<ThreadNode> = {}): ThreadNode {
	const base = threadsFixture[0];
	if (!base) throw new Error("review-threads.json is empty");
	return { ...base, ...partial };
}
