import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prView, type Scenario } from "./fake-gh/scenario";
import { testGitEnv } from "./git-fixture";

/**
 * Git-methodology matrix (docs/git-methodology.md): one PR history for each
 * way a team keeps a PR branch current and lands it. carbonless must behave
 * the same for every one of them.
 */

/** How the PR branch is kept current while the base moves on. */
export const UPDATES = ["none", "rebase", "merge-base-in"] as const;
export type Update = (typeof UPDATES)[number];

/** How the PR is landed (or not). */
export const LANDINGS = [
	"open",
	"merge-commit",
	"squash",
	"rebase-merge",
] as const;
export type Landing = (typeof LANDINGS)[number];

export interface Methodology {
	update: Update;
	landing: Landing;
	/** "rebase / squash", for test titles. */
	name: string;
}

/** All 12 permutations. */
export const METHODOLOGIES: Methodology[] = UPDATES.flatMap((update) =>
	LANDINGS.map((landing) => ({
		update,
		landing,
		name: `${update} / ${landing}`,
	})),
);

/**
 * Moments of the history. The PR opens on B0; the base moves (X), the PR is
 * updated, the base moves again (Y), the PR lands.
 */
export const TIMES = {
	base: "2026-01-01T00:00:00Z",
	pr: "2026-01-02T00:00:00Z",
	/** rev1 reviews the PR's first head (so as-of finds it after a force-push). */
	review: "2026-01-02T12:00:00Z",
	baseMoved: "2026-01-03T00:00:00Z",
	updated: "2026-01-04T00:00:00Z",
	/** The rebased PR's last commit. */
	updatedLast: "2026-01-04T00:00:01Z",
	baseMovedAgain: "2026-01-05T00:00:00Z",
	landed: "2026-01-06T00:00:00Z",
} as const;

/** As-of cutoffs: the "opened" and "updated" stages as they were. */
export const BEFORE_UPDATE = "2026-01-03T12:00:00Z";
export const BEFORE_LANDING = "2026-01-05T12:00:00Z";

/**
 * Points in the PR's life, each with GitHub's refs and PR facts of then:
 * - opened: the PR's first head, the base moved once (X) since it branched;
 * - updated: the PR updated per `update`, the base moved again (Y);
 * - landed: the PR landed per `landing` (for "open", same as updated).
 */
export type Stage = "opened" | "updated" | "landed";

export interface MethodologyRepo {
	methodology: Methodology;
	/** The GitHub-side repository (main and refs/pull/<n>/head only). */
	path: string;
	/** The PR's head at the opened and the updated stage. */
	heads: { opened: string; updated: string };
	/**
	 * The PR's intended change as one comparison in `path`: base B0 → the PR's
	 * first head. Every stage's comparison must show exactly these changes.
	 */
	reference: { base: string; head: string };
	/** Paths the PR changes, in diff order. */
	prPaths: string[];
	/** Moves main and refs/pull/<n>/head to where GitHub had them at `stage`. */
	setStage: (stage: Stage) => void;
	/** The fake gh's PR entry at `stage` (pr view fields and GraphQL lists). */
	prEntry: (stage: Stage) => Scenario["prs"][string];
	cleanup: () => void;
}

const LINES = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
/** a.txt with these 1-based lines replaced. */
const aTxt = (changes: Record<number, string>) =>
	`${LINES.map((l, i) => changes[i + 1] ?? l).join("\n")}\n`;

/**
 * Builds the history for `m`. The PR changes a.txt lines 2 and 30 (in two
 * commits) and adds new.txt; the base's own commits change a.txt lines 15
 * and 22 and add base-x.txt and base-y.txt, so any base commit leaking into
 * the comparison shows up as an extra cluster or file.
 */
export function createMethodologyRepo(
	m: Methodology,
	number: number,
): MethodologyRepo {
	const path = mkdtempSync(join(tmpdir(), "crb-methodology-"));
	const run = (args: string[], at?: string) =>
		execFileSync("git", args, {
			cwd: path,
			encoding: "utf8",
			// Piped, so merge chatter stays out of the test output.
			stdio: "pipe",
			env: testGitEnv(
				at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {},
			),
		}).trim();
	const git = (...args: string[]) => run(args);
	/** Commits `files` on top of the checked out commit at `at`. */
	const commit = (
		message: string,
		files: Record<string, string>,
		at: string,
	) => {
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(path, name), content);
		}
		git("add", "--all");
		run(["commit", "--quiet", "-m", message], at);
		return git("rev-parse", "HEAD");
	};
	const checkout = (sha: string) => git("checkout", "--quiet", "--detach", sha);
	const head = () => git("rev-parse", "HEAD");

	git("init", "--quiet", "--initial-branch=main");
	git("config", "user.name", "Fixture Author");
	git("config", "user.email", "fixture@example.com");
	git("config", "commit.gpgsign", "false");
	// Like GitHub: a commit a force-push dropped can still be fetched by OID.
	git("config", "uploadpack.allowAnySHA1InWant", "true");

	const b0 = commit("base", { "a.txt": aTxt({}) }, TIMES.base);
	checkout(b0);
	const p1a = commit(
		"PR: line 2 and new.txt",
		{ "a.txt": aTxt({ 2: "line 2 changed" }), "new.txt": "new\n" },
		TIMES.pr,
	);
	const p1b = commit(
		"PR: line 30",
		{ "a.txt": aTxt({ 2: "line 2 changed", 30: "line 30 changed" }) },
		TIMES.pr,
	);
	checkout(b0);
	const b1 = commit(
		"base: line 15",
		{ "a.txt": aTxt({ 15: "line 15 base" }), "base-x.txt": "x\n" },
		TIMES.baseMoved,
	);

	// The PR update.
	let updated = p1b;
	let updatedCommits: { oid: string; at: string }[] = [
		{ oid: p1a, at: TIMES.pr },
		{ oid: p1b, at: TIMES.pr },
	];
	if (m.update === "rebase") {
		// One second apart: as-of breaks a tie between commits by list order
		// (see docs/git-methodology.md).
		checkout(b1);
		run(["cherry-pick", p1a], TIMES.updated);
		const p1aRebased = head();
		run(["cherry-pick", p1b], TIMES.updatedLast);
		updated = head();
		updatedCommits = [
			{ oid: p1aRebased, at: TIMES.updated },
			{ oid: updated, at: TIMES.updatedLast },
		];
	} else if (m.update === "merge-base-in") {
		checkout(p1b);
		run(["merge", "--quiet", "--no-ff", "-m", "Merge main", b1], TIMES.updated);
		updated = head();
		updatedCommits = [...updatedCommits, { oid: updated, at: TIMES.updated }];
	}

	checkout(b1);
	const b2 = commit(
		"base: line 22",
		{
			"a.txt": aTxt({ 15: "line 15 base", 22: "line 22 base" }),
			"base-y.txt": "y\n",
		},
		TIMES.baseMovedAgain,
	);

	// The landing, on top of the base as it is then.
	let landed = b2;
	if (m.landing === "merge-commit") {
		checkout(b2);
		run(
			["merge", "--quiet", "--no-ff", "-m", "Merge PR", updated],
			TIMES.landed,
		);
		landed = head();
	} else if (m.landing === "squash") {
		checkout(b2);
		run(["merge", "--quiet", "--squash", updated], TIMES.landed);
		run(["commit", "--quiet", "-m", "PR (squashed)"], TIMES.landed);
		landed = head();
	} else if (m.landing === "rebase-merge") {
		// GitHub replays the PR's own non-merge commits onto the base.
		const own = git("rev-list", "--reverse", "--no-merges", `${b2}..${updated}`)
			.split("\n")
			.filter(Boolean);
		checkout(b2);
		run(["cherry-pick", "--allow-empty", ...own], TIMES.landed);
		landed = head();
	}

	const pullRef = `refs/pull/${number}/head`;
	const setStage = (stage: Stage) => {
		const [main, pr] =
			stage === "opened"
				? [b1, p1b]
				: stage === "updated"
					? [b2, updated]
					: [landed, updated];
		git("update-ref", "refs/heads/main", main);
		git("update-ref", pullRef, pr);
	};
	// Only main and the pull ref exist, as on GitHub: no branch keeps a
	// force-pushed head reachable in a clone.
	git("checkout", "--quiet", "main");
	setStage("opened");

	const prEntry = (stage: Stage): Scenario["prs"][string] => {
		const commits =
			stage === "opened"
				? [
						{ oid: p1a, at: TIMES.pr },
						{ oid: p1b, at: TIMES.pr },
					]
				: updatedCommits;
		const merged = stage === "landed" && m.landing !== "open";
		return {
			view: prView({
				number,
				url: `https://github.com/acme/widget/pull/${number}`,
				baseRefName: "main",
				headRefOid: stage === "opened" ? p1b : updated,
				state: merged ? "MERGED" : "OPEN",
				mergeable: merged ? "UNKNOWN" : "MERGEABLE",
			}),
			graphql: {
				bodyHTML: "<p>Methodology PR.</p>",
				reviewThreads: [],
				comments: [],
				reviews: [
					{
						author: { login: "rev1", __typename: "User" },
						state: "COMMENTED",
						submittedAt: TIMES.review,
						commit: { oid: p1b },
					},
				],
				commits: commits.map(({ oid, at }) => ({
					commit: { oid, committedDate: at },
				})),
			},
		};
	};

	return {
		methodology: m,
		path,
		heads: { opened: p1b, updated },
		reference: { base: b0, head: p1b },
		prPaths: ["a.txt", "new.txt"],
		setStage,
		prEntry,
		cleanup: () => rmSync(path, { recursive: true, force: true }),
	};
}
