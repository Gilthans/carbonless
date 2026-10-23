import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test as base, expect } from "@playwright/test";
import {
	FAKE_GH_DIR,
	prView,
	type reviewThread,
	type Scenario,
	writeScenario,
} from "../test/fake-gh/scenario";
import {
	createGitFixture,
	type FixtureCommit,
	type GitFixture,
} from "../test/git-fixture";

/** Fields of a `gh pr view --json` object (see test/fixtures/gh/pr-view.json). */
export type ViewJson = Record<string, unknown>;
/** A GraphQL reviewThreads node (see test/fixtures/gh/review-threads.json). */
export type ThreadJson = ReturnType<typeof reviewThread>;

export const OWNER_REPO = "acme/widget";
export const PR_NUMBER = 7;

export interface PrOptions {
	/** Commits on the PR branch, on top of `main`'s single base commit. */
	files?: FixtureCommit[];
	overview?: Partial<ViewJson>;
	threads?: ThreadJson[];
	/** Other scenario fields (loggedOut, comments, reviews, ...). */
	scenario?: Partial<Scenario>;
	reviews?: unknown[];
	comments?: unknown[];
}

export interface Pr {
	repo: GitFixture;
	scenarioPath: string;
	number: typeof PR_NUMBER;
	/** Pushes a commit (its files and deletions) onto the PR and points the fake gh at it. */
	moveHead: (commit: FixtureCommit) => void;
}

export interface Crb {
	url: string;
	output(): string;
	stop(): Promise<void>;
}

/** startCrb's rejection when the CLI exits before printing its URL. */
export class CrbExitError extends Error {
	constructor(
		readonly code: number | null,
		readonly output: string,
	) {
		super(`crb exited with ${code}:\n${output}`);
	}
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

const CLI = resolve(import.meta.dirname, "../dist/cli.js");
const START_TIMEOUT_MS = 20_000;

function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve();
	}
	return new Promise((done) => {
		const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
		child.once("exit", () => {
			clearTimeout(force);
			done();
		});
		child.kill("SIGTERM");
	});
}

export const test = base.extend<{
	workdir: string;
	pr: (opts?: PrOptions) => Promise<Pr>;
	startCrb: (arg?: string, extraArgs?: string[]) => Promise<Crb>;
	/** Fails the test on browser console errors and uncaught page errors. */
	consoleErrors: undefined;
}>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern.
	workdir: async ({}, use) => {
		const dir = mkdtempSync(join(tmpdir(), "crb-e2e-"));
		await use(dir);
		rmSync(dir, { recursive: true, force: true });
	},

	pr: async ({ workdir }, use) => {
		const repos: GitFixture[] = [];
		await use(async (opts = {}) => {
			const repo = createGitFixture([
				{ message: "base", files: { "a.txt": `${BASE_FILE.join("\n")}\n` } },
				...(opts.files ?? DEFAULT_COMMITS),
			]);
			repos.push(repo);
			const git = (...args: string[]) =>
				execFileSync("git", args, { cwd: repo.path, encoding: "utf8" }).trim();
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
								reviewThreads: opts.threads ?? [],
								reviews: opts.reviews ?? [],
								comments: opts.comments ?? [],
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
					const created = commitInWorktree(work, commit);
					git("worktree", "remove", "--force", work);
					head = created;
					git("update-ref", `refs/pull/${PR_NUMBER}/head`, head);
					write();
				},
			};
		});
		for (const repo of repos) repo.cleanup();
	},

	startCrb: async ({ workdir }, use) => {
		const children: ChildProcess[] = [];
		await use(async (arg = `${OWNER_REPO}#${PR_NUMBER}`, extraArgs = []) => {
			const child = spawn(
				process.execPath,
				[CLI, arg, "--no-open", ...extraArgs],
				{
					cwd: workdir,
					stdio: ["ignore", "pipe", "pipe"],
					env: {
						...process.env,
						PATH: `${FAKE_GH_DIR}:${process.env.PATH ?? ""}`,
						CRB_FAKE_GH: join(workdir, "fake-gh-scenario.json"),
						XDG_CACHE_HOME: join(workdir, "cache"),
					},
				},
			);
			children.push(child);
			let output = "";
			const url = await new Promise<string>((done, fail) => {
				const timer = setTimeout(
					() => fail(new Error(`crb printed no URL in time:\n${output}`)),
					START_TIMEOUT_MS,
				);
				const onData = (chunk: Buffer) => {
					output += chunk.toString();
					const match = output.match(/carbonless listening on (http:\/\/\S+)/);
					if (match?.[1]) {
						clearTimeout(timer);
						done(match[1]);
					}
				};
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				child.once("exit", (code) => {
					clearTimeout(timer);
					fail(new CrbExitError(code, output));
				});
			});
			return { url, output: () => output, stop: () => stopChild(child) };
		});
		await Promise.all(children.map(stopChild));
	},

	consoleErrors: [
		async ({ page }, use) => {
			const errors: string[] = [];
			page.on("console", (message) => {
				if (message.type() === "error") errors.push(message.text());
			});
			page.on("pageerror", (error) => errors.push(error.message));
			await use(undefined);
			expect(errors, "browser console errors").toEqual([]);
		},
		{ auto: true },
	],
});

/**
 * Writes `commit` (files and deletions) into the worktree at `dir`, commits
 * it and returns the SHA. The worktree shares the fixture repo's git config.
 */
function commitInWorktree(dir: string, commit: FixtureCommit): string {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
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

export { expect };
