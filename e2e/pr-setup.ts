import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "../test/fake-gh/atomic.mjs";
import {
	FIXTURE_BODY_HTML,
	fakeGhEnv,
	prView,
	type reviewThread,
	type Scenario,
	timelineFact,
	writeScenario,
} from "../test/fake-gh/scenario";
import {
	createGitFixture,
	type FixtureCommit,
	type GitFixture,
	testGitEnv,
} from "../test/git-fixture";
import { fixtureGit } from "../test/trace-run";

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
	/** Binary files in that base commit. */
	baseBinary?: Record<string, Uint8Array>;
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
	/** Its repository on the fake GitHub (owner/repo). */
	ownerRepo: string;
	number: number;
	/** Pushes a commit (its files and deletions) onto the PR and points the fake gh at it; returns its SHA. */
	moveHead: (commit: FixtureCommit) => string;
	/**
	 * Force-pushes: commits `commit` on top of `onto` (the merge base by
	 * default), so the new head does not descend from the old one, points
	 * the fake gh at it and adds the force-push to the PR's timeline;
	 * returns its SHA.
	 */
	forceHead: (commit: FixtureCommit, onto?: string) => string;
	/** Force-pushes the PR back to `sha` (an earlier head), with the timeline event. */
	rewindHead: (sha: string) => void;
	/** The PR's head as the fake gh reports it now. */
	head: () => string;
	/** The PR's merge base (its base branch's commit). */
	mergeBase: string;
	/** Edits the fake gh's scenario in place (lost on the next moveHead). */
	editScenario: (edit: (s: Scenario) => void) => void;
	/** Every fake gh call so far, a line each (its args), in the order they started. */
	ghLog: () => string;
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

/**
 * The environment crb runs in: the fake gh first on PATH; cache, state
 * (server.json, key) and config in `workdir`, never the reviewer's. The
 * rest is this process's env: NODE_COMPILE_CACHE among it, the run's one
 * compile cache (e2e/global-setup.ts), which a per-test XDG_CACHE_HOME
 * would leave empty for every crb.
 */
export function crbEnv(workdir: string): NodeJS.ProcessEnv {
	return testGitEnv({
		...fakeGhEnv(),
		CRB_FAKE_GH: join(workdir, "fake-gh-scenario.json"),
		CRB_FAKE_GH_LOG: join(workdir, "fake-gh.log"),
		XDG_CACHE_HOME: join(workdir, "cache"),
		XDG_STATE_HOME: join(workdir, "state"),
		XDG_CONFIG_HOME: join(workdir, "config"),
	});
}

/** Which PR a fixture is on GitHub: `acme/widget#7` unless a test is given another. */
export interface PrAt {
	ownerRepo: string;
	number: number;
}

/**
 * A git repo with `main` and the PR's commits (the head only under
 * refs/pull/<n>/head, like on GitHub) and the fake gh's scenario for it in
 * `workdir`, as PR `at` (a test on a shared crb serve has a repo and number
 * of its own: e2e/shared-server.ts). The caller cleans `repo` up.
 */
export function createPr(
	workdir: string,
	opts: PrOptions = {},
	at: PrAt = { ownerRepo: OWNER_REPO, number: PR_NUMBER },
): Pr {
	const { ownerRepo, number } = at;
	const repo = createGitFixture([
		{
			message: "base",
			files: { "a.txt": `${BASE_FILE.join("\n")}\n`, ...opts.base },
			...(opts.baseBinary ? { binary: opts.baseBinary } : {}),
			date: opts.baseDate,
		},
		...(opts.files ?? DEFAULT_COMMITS),
	]);
	const git = (...args: string[]) =>
		fixtureGit(args, () =>
			execFileSync("git", args, {
				cwd: repo.path,
				encoding: "utf8",
				env: testGitEnv(),
			}).trim(),
		);
	const mergeBase = repo.shas[0] ?? "";
	let head = repo.shas.at(-1) ?? "";
	// The timeline the fake gh serves: the force-pushes are appended to it.
	const timeline: unknown[] = [...(opts.timeline ?? [])];
	// The PR head lives only under refs/pull/<n>/head, like on GitHub.
	git("update-ref", `refs/pull/${number}/head`, head);
	git("reset", "--quiet", "--hard", mergeBase);

	const write = () =>
		writeScenario(workdir, {
			repoPath: repo.path,
			user: { login: "Octo_Cat" },
			nameWithOwner: ownerRepo,
			prs: {
				[number]: {
					view: prView({
						number,
						url: `https://github.com/${ownerRepo}/pull/${number}`,
						baseRefName: "main",
						...opts.overview,
						headRefOid: head,
					}),
					graphql: {
						bodyHTML: opts.bodyHTML ?? FIXTURE_BODY_HTML,
						reviewThreads: opts.threads ?? [],
						reviews: opts.reviews ?? [],
						comments: opts.comments ?? [],
						timelineItems: timeline,
					},
				},
			},
			...opts.scenario,
		});
	const scenarioPath = write();

	const commitOn = (base: string, commit: FixtureCommit) => {
		const work = join(workdir, "work");
		git("worktree", "add", "--quiet", "--detach", work, base);
		try {
			return commitInWorktree(work, commit);
		} finally {
			git("worktree", "remove", "--force", work);
		}
	};
	const forcePushed = (before: string, after: string) => {
		timeline.push(
			timelineFact("HeadRefForcePushedEvent", {
				login: "octo-author",
				at: new Date().toISOString(),
				beforeCommit: { oid: before },
				afterCommit: { oid: after },
			}),
		);
	};

	return {
		repo,
		scenarioPath,
		ownerRepo,
		number,
		mergeBase,
		head: () => head,
		moveHead: (commit) => {
			head = commitOn(head, commit);
			git("update-ref", `refs/pull/${number}/head`, head);
			write();
			return head;
		},
		forceHead: (commit, onto = mergeBase) => {
			const before = head;
			head = commitOn(onto, commit);
			git("update-ref", `refs/pull/${number}/head`, head);
			forcePushed(before, head);
			write();
			return head;
		},
		rewindHead: (sha) => {
			const before = head;
			head = sha;
			git("update-ref", `refs/pull/${number}/head`, head);
			forcePushed(before, head);
			write();
		},
		editScenario: (edit) => {
			const s = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;
			edit(s);
			writeFileAtomic(scenarioPath, JSON.stringify(s, null, "\t"));
		},
		ghLog: () => {
			const log = join(workdir, "fake-gh.log");
			return existsSync(log) ? readFileSync(log, "utf8") : "";
		},
	};
}

/**
 * Writes `commit` (files and deletions) into the worktree at `dir`, commits
 * it and returns the SHA. The worktree shares the fixture repo's git config.
 */
function commitInWorktree(dir: string, commit: FixtureCommit): string {
	const git = (...args: string[]) =>
		fixtureGit(args, () =>
			execFileSync("git", args, {
				cwd: dir,
				encoding: "utf8",
				env: testGitEnv(),
			}).trim(),
		);
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
