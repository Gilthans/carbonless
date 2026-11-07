import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	prView,
	type Scenario,
	timelineCommit,
	timelineFact,
	timelineReview,
} from "./fake-gh/scenario";
import { testGitEnv } from "./git-fixture";

/**
 * Git-methodology matrix (docs/git-methodology.md): one PR history for each
 * way a team keeps a PR branch current and lands it. carbonless must behave
 * the same for every one of them.
 */

/** How the PR branch is kept current while the base moves on. */
export const UPDATES = [
	"none",
	"rebase",
	"merge-base-in",
	"rebase-amend",
	"merge-base-in-conflict",
	"stacked-squash",
] as const;
export type Update = (typeof UPDATES)[number];

/** Updates that force-push the branch (GitHub's timeline shows the push). */
export const forcePushed = (update: Update): boolean =>
	update === "rebase" ||
	update === "rebase-amend" ||
	update === "stacked-squash";
/** Updates that merge the base into the branch (a merge commit joins the PR's). */
export const mergesBase = (update: Update): boolean =>
	update === "merge-base-in" || update === "merge-base-in-conflict";

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

/** All 24 permutations. */
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
	/** The push of the update, just after its commits were made. */
	pushed: "2026-01-04T00:00:30Z",
	baseMoved: "2026-01-03T00:00:00Z",
	/** A stacked parent lands (by squash) after the base moved, before the update. */
	parentLanded: "2026-01-03T12:00:00Z",
	updated: "2026-01-04T00:00:00Z",
	baseMovedAgain: "2026-01-05T00:00:00Z",
	landed: "2026-01-06T00:00:00Z",
} as const;

/**
 * As-of cutoffs: the "opened" stage before and after rev1's review (before
 * it, only the commit dates can tell the head), and the "updated" stage.
 */
export const BEFORE_REVIEW = "2026-01-02T06:00:00Z";
export const BEFORE_UPDATE = "2026-01-03T12:00:00Z";
export const BEFORE_LANDING = "2026-01-05T12:00:00Z";

/**
 * Points in the PR's life, each with GitHub's refs and PR facts of then:
 * - opened: the PR's first head, the base moved once (X) since it branched;
 * - updated: the PR updated per `update`, the base moved again (Y);
 * - landed: the PR landed per `landing` (for "open", same as updated).
 */
export type Stage = "opened" | "updated" | "landed";

/** The PR's intended change as one comparison in the repo, and its paths in diff order. */
export interface Reference {
	base: string;
	head: string;
	paths: string[];
}

export interface MethodologyRepo {
	methodology: Methodology;
	/** The GitHub-side repository (main and refs/pull/<n>/head only). */
	path: string;
	/** The PR's head at the opened and the updated stage. */
	heads: { opened: string; updated: string };
	/**
	 * What every comparison at that stage must show exactly: the PR's own
	 * change (B0 → the PR's first head; for an update that changes the
	 * content or drops a stacked parent's, the content of then on B0).
	 */
	references: { opened: Reference; updated: Reference };
	/** `references.opened`, the name the first tests used. */
	reference: { base: string; head: string };
	/** Paths the PR changes at the updated stage, in diff order. */
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
 * the comparison shows up as an extra cluster or file. A conflicting base
 * also changes line 30; a stacked parent changes line 10 and adds
 * parent.txt under the PR, and lands by squash before the update.
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
	const write = (files: Record<string, string>) => {
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(path, name), content);
		}
	};
	/** Commits `files` on top of the checked out commit at `at`. */
	const commit = (
		message: string,
		files: Record<string, string>,
		at: string,
	) => {
		write(files);
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

	const stacked = m.update === "stacked-squash";
	const conflicting = m.update === "merge-base-in-conflict";
	/** The parent PR's change, under the PR's own while it hasn't landed. */
	const parentLines: Record<number, string> = stacked
		? { 10: "line 10 parent" }
		: {};
	const conflictLines: Record<number, string> = conflicting
		? { 30: "line 30 base" }
		: {};

	const b0 = commit("base", { "a.txt": aTxt({}) }, TIMES.base);
	/** The PR's two commits on `on`, with `lines` under them. */
	const prCommits = (on: string, lines: Record<number, string>) => {
		checkout(on);
		const a = commit(
			"PR: line 2 and new.txt",
			{ "a.txt": aTxt({ ...lines, 2: "line 2 changed" }), "new.txt": "new\n" },
			TIMES.pr,
		);
		const b = commit(
			"PR: line 30",
			{
				"a.txt": aTxt({ ...lines, 2: "line 2 changed", 30: "line 30 changed" }),
			},
			TIMES.pr,
		);
		return [a, b] as const;
	};
	// The plain PR on B0: the PR itself, or (stacked) the reference of its own change.
	const [plainA, plainB] = prCommits(b0, {});
	let parent = b0;
	let p1a = plainA;
	let p1b = plainB;
	if (stacked) {
		checkout(b0);
		parent = commit(
			"parent: line 10 and parent.txt",
			{ "a.txt": aTxt(parentLines), "parent.txt": "parent\n" },
			TIMES.pr,
		);
		[p1a, p1b] = prCommits(parent, parentLines);
	}
	checkout(b0);
	const b1 = commit(
		"base: line 15",
		{
			"a.txt": aTxt({ 15: "line 15 base", ...conflictLines }),
			"base-x.txt": "x\n",
		},
		TIMES.baseMoved,
	);
	// The stacked parent lands by squash onto the moved base.
	let b1Plus = b1;
	if (stacked) {
		checkout(b1);
		run(["merge", "--quiet", "--squash", parent], TIMES.parentLanded);
		run(["commit", "--quiet", "-m", "parent (squashed)"], TIMES.parentLanded);
		b1Plus = head();
	}

	// The PR update.
	let updated = p1b;
	let updatedCommits: { oid: string; at: string }[] = [
		{ oid: p1a, at: TIMES.pr },
		{ oid: p1b, at: TIMES.pr },
	];
	if (m.update === "rebase" || m.update === "stacked-squash") {
		// Both in one second, as a rebase usually makes them: as-of takes the
		// later one in GitHub's list.
		checkout(b1Plus);
		run(["cherry-pick", p1a], TIMES.updated);
		const p1aRebased = head();
		run(["cherry-pick", p1b], TIMES.updated);
		updated = head();
		updatedCommits = [
			{ oid: p1aRebased, at: TIMES.updated },
			{ oid: updated, at: TIMES.updated },
		];
	} else if (m.update === "rebase-amend") {
		checkout(b1);
		run(["cherry-pick", p1a], TIMES.updated);
		const p1aRebased = head();
		updated = commit(
			"PR: line 30 (amended)",
			{
				"a.txt": aTxt({
					2: "line 2 changed",
					15: "line 15 base",
					30: "line 30 amended",
				}),
			},
			TIMES.updated,
		);
		updatedCommits = [
			{ oid: p1aRebased, at: TIMES.updated },
			{ oid: updated, at: TIMES.updated },
		];
	} else if (m.update === "merge-base-in") {
		checkout(p1b);
		run(["merge", "--quiet", "--no-ff", "-m", "Merge main", b1], TIMES.updated);
		updated = head();
		updatedCommits = [...updatedCommits, { oid: updated, at: TIMES.updated }];
	} else if (m.update === "merge-base-in-conflict") {
		checkout(p1b);
		// The merge stops on a.txt (line 30 both sides); the author resolves
		// it with something that is neither.
		try {
			run(["merge", "--quiet", "--no-ff", "--no-commit", b1], TIMES.updated);
		} catch {
			// Expected: the conflict.
		}
		write({
			"a.txt": aTxt({
				2: "line 2 changed",
				15: "line 15 base",
				30: "line 30 resolved",
			}),
		});
		git("add", "--all");
		run(["commit", "--quiet", "-m", "Merge main"], TIMES.updated);
		updated = head();
		updatedCommits = [...updatedCommits, { oid: updated, at: TIMES.updated }];
	}

	checkout(b1Plus);
	const b2 = commit(
		"base: line 22",
		{
			"a.txt": aTxt({
				...parentLines,
				15: "line 15 base",
				22: "line 22 base",
				...conflictLines,
			}),
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
		// GitHub replays the PR's own non-merge commits onto the base (a
		// commit that conflicts with the base takes the PR's side, as the
		// author's resolution would).
		const own = git("rev-list", "--reverse", "--no-merges", `${b2}..${updated}`)
			.split("\n")
			.filter(Boolean);
		checkout(b2);
		run(
			["cherry-pick", "--allow-empty", "--strategy-option=theirs", ...own],
			TIMES.landed,
		);
		landed = head();
	}

	// The references: what each stage's comparison must show.
	const opened: Reference = {
		base: b0,
		head: p1b,
		paths: stacked ? ["a.txt", "new.txt", "parent.txt"] : ["a.txt", "new.txt"],
	};
	let updatedRef: Reference = {
		base: b0,
		head: plainB,
		paths: ["a.txt", "new.txt"],
	};
	if (m.update === "rebase-amend") {
		checkout(b0);
		commit(
			"reference: line 2 and new.txt",
			{ "a.txt": aTxt({ 2: "line 2 changed" }), "new.txt": "new\n" },
			TIMES.pr,
		);
		const amendedRef = commit(
			"reference: line 30 amended",
			{ "a.txt": aTxt({ 2: "line 2 changed", 30: "line 30 amended" }) },
			TIMES.pr,
		);
		updatedRef = { base: b0, head: amendedRef, paths: ["a.txt", "new.txt"] };
	} else if (conflicting) {
		checkout(b0);
		const refBase = commit(
			"reference base: line 30",
			{ "a.txt": aTxt({ 30: "line 30 base" }) },
			TIMES.base,
		);
		const refHead = commit(
			"reference: resolved",
			{
				"a.txt": aTxt({ 2: "line 2 changed", 30: "line 30 resolved" }),
				"new.txt": "new\n",
			},
			TIMES.pr,
		);
		updatedRef = { base: refBase, head: refHead, paths: ["a.txt", "new.txt"] };
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
		// GitHub's timeline: the PR's commits as they are now (a rebase
		// replaces them), rev1's review, the force-push of a rebase, the merge.
		const timelineItems = [
			...commits.map(({ oid, at }) =>
				timelineCommit({ login: "dev", at, oid }),
			),
			timelineReview({ login: "rev1", at: TIMES.review, text: "Looks fine" }),
			...(stage !== "opened" && forcePushed(m.update)
				? [
						timelineFact("HeadRefForcePushedEvent", {
							login: "dev",
							at: TIMES.pushed,
							beforeCommit: { oid: p1b },
							afterCommit: { oid: updated },
						}),
					]
				: []),
			...(merged
				? [
						timelineFact("MergedEvent", {
							login: "maintainer",
							at: TIMES.landed,
							commit: { oid: landed },
						}),
						timelineFact("ClosedEvent", {
							login: "maintainer",
							at: TIMES.landed,
						}),
					]
				: []),
		];
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
						body: "Looks fine",
						commit: { oid: p1b },
					},
				],
				commits: commits.map(({ oid, at }) => ({
					commit: { oid, committedDate: at },
				})),
				timelineItems,
			},
		};
	};

	return {
		methodology: m,
		path,
		heads: { opened: p1b, updated },
		references: { opened, updated: updatedRef },
		reference: { base: opened.base, head: opened.head },
		prPaths: updatedRef.paths,
		setStage,
		prEntry,
		cleanup: () => rmSync(path, { recursive: true, force: true }),
	};
}
