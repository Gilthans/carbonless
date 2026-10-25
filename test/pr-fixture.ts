import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Session } from "../src/server/session";
import {
	FAKE_GH_DIR,
	prView,
	type Scenario,
	writeScenario,
} from "./fake-gh/scenario";
import { createGitFixture, type GitFixture, testGitEnv } from "./git-fixture";

export interface PrFixture {
	/** What to pass to Session.open / crb. */
	arg: string;
	/** The GitHub-side repository the fake gh clones from. */
	repo: GitFixture;
	/** Where main stood when the PR branched off. */
	mergeBase: string;
	/** The PR's current head. */
	head: () => string;
	/** Pushes a commit onto the PR and points the fake gh at it. */
	moveHead: (files: Record<string, string>) => string;
	/** Moves main to `sha`, by default the PR head (as merging it would). */
	moveMain: (sha?: string) => void;
	/** Every gh call so far, one per line. */
	ghLog: () => string;
	/** Rewrites the fake gh scenario with these overrides. */
	scenario: (over?: Partial<Scenario>) => void;
	/** Closes every session first (Session.closeAll), then restores the env. */
	cleanup: () => Promise<void>;
}

const OWNER_REPO = "acme/widget";
const NUMBER = 12;

/**
 * A PR acme/widget#12 served by the fake gh (test/fake-gh): main has a.txt,
 * the PR changes two separate places in it and adds new.txt. PATH,
 * CRB_FAKE_GH and XDG_CACHE_HOME point at throwaway locations until cleanup.
 */
export function createPrFixture(): PrFixture {
	const tmp = mkdtempSync(join(tmpdir(), "crb-pr-"));
	const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
	const changed = [...lines];
	changed[1] = "line 2 changed";
	changed[25] = "line 26 changed";
	const repo = createGitFixture([
		{ message: "base", files: { "a.txt": `${lines.join("\n")}\n` } },
		{
			message: "PR change",
			files: { "a.txt": `${changed.join("\n")}\n`, "new.txt": "new\n" },
		},
	]);
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: repo.path,
			encoding: "utf8",
			env: testGitEnv(),
		}).trim();
	const [mergeBase = "", first = ""] = repo.shas;
	// The PR head lives only under refs/pull/<n>/head, like on GitHub.
	git("update-ref", `refs/pull/${NUMBER}/head`, first);
	git("reset", "--quiet", "--hard", mergeBase);
	let head = first;

	const saved: Record<string, string | undefined> = {};
	const setEnv = (vars: Record<string, string>) => {
		for (const [k, v] of Object.entries(vars)) {
			if (!(k in saved)) saved[k] = process.env[k];
			process.env[k] = v;
		}
	};
	const scenario = (over: Partial<Scenario> = {}) => {
		const path = writeScenario(tmp, {
			repoPath: repo.path,
			user: { login: "Octo_Cat" },
			nameWithOwner: OWNER_REPO,
			prs: {
				[NUMBER]: {
					view: prView({ headRefOid: head, baseRefName: "main" }),
				},
			},
			...over,
		});
		setEnv({ CRB_FAKE_GH: path });
	};
	setEnv({
		PATH: `${FAKE_GH_DIR}:${process.env.PATH ?? ""}`,
		XDG_CACHE_HOME: join(tmp, "cache"),
		CRB_FAKE_GH_LOG: join(tmp, "gh.log"),
	});
	scenario();

	return {
		arg: `${OWNER_REPO}#${NUMBER}`,
		repo,
		mergeBase,
		head: () => head,
		moveHead: (files) => {
			const work = join(tmp, "work");
			rmSync(work, { recursive: true, force: true });
			execFileSync(
				"git",
				["worktree", "add", "--quiet", "--detach", work, head],
				{
					cwd: repo.path,
					env: testGitEnv(),
				},
			);
			for (const [name, content] of Object.entries(files)) {
				mkdirSync(dirname(join(work, name)), { recursive: true });
				writeFileSync(join(work, name), content);
			}
			const w = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: work,
					encoding: "utf8",
					env: testGitEnv(),
				}).trim();
			w("add", "--all");
			w("commit", "--quiet", "-m", "PR update");
			head = w("rev-parse", "HEAD");
			git("worktree", "remove", "--force", work);
			git("update-ref", `refs/pull/${NUMBER}/head`, head);
			scenario();
			return head;
		},
		moveMain: (sha = head) => {
			git("reset", "--quiet", "--hard", sha);
		},
		ghLog: () => {
			const log = join(tmp, "gh.log");
			return existsSync(log) ? readFileSync(log, "utf8") : "";
		},
		scenario,
		cleanup: async () => {
			// Sessions' background reads stop before the fake gh and the
			// throwaway cache go: none may reach the real gh.
			await Session.closeAll();
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			repo.cleanup();
			rmSync(tmp, { recursive: true, force: true });
		},
	};
}
