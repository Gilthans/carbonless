import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	FAKE_GH_DIR,
	FIXTURE_BODY_HTML,
	prView,
	type reviewThread,
	type Scenario,
	writeScenario,
} from "../test/fake-gh/scenario";
import {
	createGitFixture,
	type FixtureCommit,
	type GitFixture,
	testGitEnv,
} from "../test/git-fixture";

/*
 * A throwaway PR for the built CLI to review against the fake gh, without
 * Playwright: the e2e fixtures (fixtures.ts) and the threads demo
 * (scripts/demo-threads.ts) both build theirs here.
 */

/** Fields of a `gh pr view --json` object (see test/fixtures/gh/pr-view.json). */
export type ViewJson = Record<string, unknown>;
/** A GraphQL reviewThreads node (see test/fixtures/gh/review-threads.json). */
export type ThreadJson = ReturnType<typeof reviewThread>;

export const OWNER_REPO = "acme/widget";
export const PR_NUMBER = 7;

export interface PrOptions {
	/** Extra files in `main`'s base commit, next to `a.txt`. */
	base?: Record<string, string>;
	/** The base commit's date (ISO); now by default. */
	baseDate?: string;
	/** Commits on the PR branch, on top of `main`'s single base commit. */
	files?: FixtureCommit[];
	/** `gh pr view` fields; `headRefOid` is always the fixture's PR head. */
	overview?: Partial<ViewJson>;
	/** The description as GitHub renders it; defaults to the fixture body's. */
	bodyHTML?: string;
	threads?: ThreadJson[];
	/** Other scenario fields (loggedOut, comments, reviews, ...). */
	scenario?: Partial<Scenario>;
	reviews?: unknown[];
	comments?: unknown[];
	/** The PR's timeline items (scenario.ts timelineCommit etc.). */
	timeline?: unknown[];
}

export interface Pr {
	repo: GitFixture;
	scenarioPath: string;
	number: typeof PR_NUMBER;
	/** Pushes a commit (its files and deletions) onto the PR and points the fake gh at it; returns its SHA. */
	moveHead: (commit: FixtureCommit) => string;
	/** Edits the fake gh's scenario in place (lost on the next moveHead). */
	editScenario: (edit: (s: Scenario) => void) => void;
}

const BASE_FILE = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
const DEFAULT_COMMITS: FixtureCommit[] = [
	{
		message: "PR change",
		files: {
			"a.txt": `${BASE_FILE.map((l, i) => (i === 1 ? "line 2 changed" : l)).join("\n")}\n`,
			"new.txt": "new\n",
		},
	},
];

/** The built CLI. */
export const CLI = resolve(import.meta.dirname, "../dist/cli.js");

/** The environment crb runs in: the fake gh first on PATH, caches in `workdir`. */
export function crbEnv(workdir: string): NodeJS.ProcessEnv {
	return testGitEnv({
		PATH: `${FAKE_GH_DIR}:${process.env.PATH ?? ""}`,
		CRB_FAKE_GH: join(workdir, "fake-gh-scenario.json"),
		XDG_CACHE_HOME: join(workdir, "cache"),
	});
}

/**
 * A git repo with `main` and the PR's commits (the head only under
 * refs/pull/<n>/head, like on GitHub) and the fake gh's scenario for it in
 * `workdir`. The caller cleans `repo` up.
 */
export function createPr(workdir: string, opts: PrOptions = {}): Pr {
	const repo = createGitFixture([
		{
			message: "base",
			files: { "a.txt": `${BASE_FILE.join("\n")}\n`, ...opts.base },
			date: opts.baseDate,
		},
		...(opts.files ?? DEFAULT_COMMITS),
	]);
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: repo.path,
			encoding: "utf8",
			env: testGitEnv(),
		}).trim();
	const mergeBase = repo.shas[0] ?? "";
	let head = repo.shas.at(-1) ?? "";
	// The PR head lives only under refs/pull/<n>/head, like on GitHub.
	git("update-ref", `refs/pull/${PR_NUMBER}/head`, head);
	git("reset", "--quiet", "--hard", mergeBase);

	const write = () =>
		writeScenario(workdir, {
			repoPath: repo.path,
			user: { login: "Octo_Cat" },
			nameWithOwner: OWNER_REPO,
			prs: {
				[PR_NUMBER]: {
					view: prView({
						number: PR_NUMBER,
						url: `https://github.com/${OWNER_REPO}/pull/${PR_NUMBER}`,
						baseRefName: "main",
						...opts.overview,
						headRefOid: head,
					}),
					graphql: {
						bodyHTML: opts.bodyHTML ?? FIXTURE_BODY_HTML,
						reviewThreads: opts.threads ?? [],
						reviews: opts.reviews ?? [],
						comments: opts.comments ?? [],
						timelineItems: opts.timeline ?? [],
					},
				},
			},
			...opts.scenario,
		});
	const scenarioPath = write();

	return {
		repo,
		scenarioPath,
		number: PR_NUMBER,
		moveHead: (commit) => {
			const work = join(workdir, "work");
			git("worktree", "add", "--quiet", "--detach", work, head);
			try {
				head = commitInWorktree(work, commit);
			} finally {
				git("worktree", "remove", "--force", work);
			}
			git("update-ref", `refs/pull/${PR_NUMBER}/head`, head);
			write();
			return head;
		},
		editScenario: (edit) => {
			const s = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;
			edit(s);
			writeFileSync(scenarioPath, JSON.stringify(s, null, "\t"));
		},
	};
}

/**
 * Writes `commit` (files and deletions) into the worktree at `dir`, commits
 * it and returns the SHA. The worktree shares the fixture repo's git config.
 */
function commitInWorktree(dir: string, commit: FixtureCommit): string {
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: dir,
			encoding: "utf8",
			env: testGitEnv(),
		}).trim();
	for (const name of commit.delete ?? []) {
		rmSync(join(dir, name), { force: true });
	}
	for (const [name, content] of Object.entries(commit.files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	git("add", "--all");
	git("commit", "--quiet", "--allow-empty", "-m", commit.message);
	return git("rev-parse", "HEAD");
}
