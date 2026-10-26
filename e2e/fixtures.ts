import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
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

export interface Crb {
	url: string;
	output(): string;
	/** SIGTERMs crb; rejects unless it exits promptly with 0. */
	stop(): Promise<CrbExit | null>;
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

/** How long crb may take to exit after SIGTERM before the harness kills it. */
const STOP_GRACE_MS = 3_000;

export interface CrbExit {
	code: number | null;
	/** Milliseconds from SIGTERM to exit. */
	ms: number;
}

/**
 * Sends SIGTERM and waits for the exit. Rejects (failing the test) when crb
 * needed a SIGKILL or exited with anything but 0: Ctrl-C must stop it even
 * while a browser tab holds connections open.
 */
function stopChild(child: ChildProcess): Promise<CrbExit | null> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve(null);
	}
	return new Promise((done, fail) => {
		const started = Date.now();
		let killed = false;
		const force = setTimeout(() => {
			killed = true;
			child.kill("SIGKILL");
		}, STOP_GRACE_MS);
		child.once("exit", (code) => {
			clearTimeout(force);
			const ms = Date.now() - started;
			if (killed) {
				fail(new Error(`crb ignored SIGTERM for ${STOP_GRACE_MS} ms`));
			} else if (code !== 0) {
				fail(new Error(`crb exited with ${code} after SIGTERM`));
			} else {
				done({ code, ms });
			}
		});
		child.kill("SIGTERM");
	});
}

export const test = base.extend<{
	workdir: string;
	pr: (opts?: PrOptions) => Promise<Pr>;
	startCrb: (arg?: string, extraArgs?: string[]) => Promise<Crb>;
	/**
	 * Auto fixture: fails the test on browser console errors and uncaught page
	 * errors, except those matching a pattern declared with
	 * `expectConsoleError(/409/)` (Chromium logs "Failed to load resource"
	 * for every non-2xx fetch).
	 */
	expectConsoleError: (pattern: RegExp) => void;
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
				{
					message: "base",
					files: { "a.txt": `${BASE_FILE.join("\n")}\n`, ...opts.base },
					date: opts.baseDate,
				},
				...(opts.files ?? DEFAULT_COMMITS),
			]);
			repos.push(repo);
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
		});
		for (const repo of repos) repo.cleanup();
	},

	startCrb: async ({ workdir, context }, use) => {
		const children: ChildProcess[] = [];
		await use(async (arg = `${OWNER_REPO}#${PR_NUMBER}`, extraArgs = []) => {
			const child = spawn(
				process.execPath,
				[CLI, arg, "--no-open", ...extraArgs],
				{
					cwd: workdir,
					stdio: ["ignore", "pipe", "pipe"],
					env: testGitEnv({
						PATH: `${FAKE_GH_DIR}:${process.env.PATH ?? ""}`,
						CRB_FAKE_GH: join(workdir, "fake-gh-scenario.json"),
						XDG_CACHE_HOME: join(workdir, "cache"),
					}),
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
				child.once("error", (error) => {
					clearTimeout(timer);
					fail(new Error(`could not start crb: ${error.message}`));
				});
			});
			return { url, output: () => output, stop: () => stopChild(child) };
		});
		// Pages would keep polling the stopped server and log connection errors.
		await Promise.all(
			context.pages().map((p) => p.goto("about:blank").catch(() => {})),
		);
		await Promise.all(children.map(stopChild));
	},

	expectConsoleError: [
		async ({ page }, use) => {
			const watch = watchConsoleErrors(page);
			await use(watch.expect);
			expect(watch.unexpected(), "unexpected browser console errors").toEqual(
				[],
			);
		},
		{ auto: true },
	],
});

export interface ConsoleErrorWatch {
	/** Declares errors matching `pattern` as expected. */
	expect: (pattern: RegExp) => void;
	/** Console and uncaught page errors seen so far, minus the expected ones. */
	unexpected: () => string[];
}

/** Collects `page`'s console errors and uncaught errors (see expectConsoleError). */
export function watchConsoleErrors(page: Page): ConsoleErrorWatch {
	const errors: string[] = [];
	const expected: RegExp[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	page.on("pageerror", (error) => errors.push(error.message));
	return {
		expect: (pattern) => {
			expected.push(pattern);
		},
		unexpected: () =>
			errors.filter((text) => !expected.some((pattern) => pattern.test(text))),
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

export { expect };
