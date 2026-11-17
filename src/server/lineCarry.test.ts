import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prView } from "../../test/fake-gh/scenario";
import { GIT_TEST_TIMEOUTS, testGitEnv } from "../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import { type SincePiece, toggleChange } from "../shared/pieces";
import type { ClusterView, ReviewView, StateChange } from "../shared/types";
import { Session } from "./session";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

/*
 * CAR-195: a cluster reviewed in PS1 that PS2 grows. The base has a
 * constant and a blank line; PS1 adds a comment and a set after them, and
 * git's diff takes PS1's *second* blank as the added one (comment, set,
 * blank). PS2 adds a second constant above the blank and changes the
 * comment and the set: its diff takes the *first* blank as added (const,
 * blank, comment, set). The since view shows the const and the changed
 * lines; the blank is unchanged since PS1, where it was the base's blank,
 * the twin of the reviewed added blank (the same diff, slid by a line).
 * Ticking every piece must leave the cluster reviewed.
 */
const lines = (...body: string[]) =>
	`${[
		"class Kinds",
		"{",
		'    private const string Name = "kinds";',
		...body,
		"",
		"    public static bool IsPlain(string kind)",
		"    {",
		'        return kind == "a";',
		"    }",
		"}",
	].join("\n")}\n`;
const BASE = lines();
const PS1 = lines(
	"",
	"    // The plain kinds, any case.",
	'    private static readonly HashSet<string> Plain = new(["a", "b"]);',
);
const PS2_ADDED = [
	'    private const string Extra = "c";',
	"",
	"    // The plain kinds and the extra one, any case.",
	'    private static readonly HashSet<string> Plain = new(["a", "b", Extra]);',
];
const PS2 = lines(...PS2_ADDED);
const PATH = "Kinds.cs";

describe("line carry from the compared patch set (CAR-195)", () => {
	let pr: PrFixture;
	beforeEach(() => {
		pr = createPrFixture();
	});
	afterEach(() => pr.cleanup());

	const repoGit = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: pr.repo.path,
			encoding: "utf8",
			env: testGitEnv(),
		}).trim();
	/** A commit on `parent` with these files (a worktree of the GitHub-side repo). */
	const commitOn = (parent: string, files: Record<string, string>) => {
		const dir = mkdtempSync(join(tmpdir(), "crb-carry-"));
		repoGit("worktree", "add", "--quiet", "--detach", dir, parent);
		const w = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: dir,
				encoding: "utf8",
				env: testGitEnv(),
			}).trim();
		for (const [name, content] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, name)), { recursive: true });
			writeFileSync(join(dir, name), content);
		}
		w("add", "--all");
		w("commit", "--quiet", "-m", "change");
		const sha = w("rev-parse", "HEAD");
		repoGit("worktree", "remove", "--force", dir);
		rmSync(dir, { recursive: true, force: true });
		return sha;
	};
	/** The PR's head is `head` (GitHub's ref and the fake gh's view). */
	const push = (head: string) => {
		repoGit("update-ref", "refs/pull/12/head", head);
		pr.scenario({
			prs: {
				12: { view: prView({ headRefOid: head, baseRefName: "main" }) },
			},
		});
		return head;
	};
	const settled = async (s: Session, head: string) => {
		for (;;) {
			const answer = await s.rereview(1, { head });
			if (!("pending" in answer)) return answer;
			await new Promise((r) => setTimeout(r, 20));
		}
	};
	const fileOf = (view: ReviewView, path = PATH) => {
		const f = view.files.find((f) => f.path === path);
		if (!f) throw new Error(`no ${path}`);
		return f;
	};
	/** The cluster PS2 grew: its added lines are PS2_ADDED. */
	const grown = (view: ReviewView): ClusterView => {
		const c = fileOf(view).clusters.find((c) => c.added[0] === PS2_ADDED[0]);
		if (!c) throw new Error("no grown cluster");
		return c;
	};

	/**
	 * Main gets the base, PS1 is pushed and marked (`mark` says how, from
	 * its review), then PS2 (`ps2` builds it) is viewed since PS1.
	 */
	async function toPs2(
		mark: (view: ReviewView) => StateChange[],
		ps2: (base: string, ps1: string) => string = (_, ps1) =>
			commitOn(ps1, { [PATH]: PS2 }),
		extra: Record<string, string> = {},
	) {
		const base = commitOn(pr.mergeBase, { [PATH]: BASE });
		pr.moveMain(base);
		const ps1 = push(commitOn(base, { [PATH]: PS1, ...extra }));
		const s = await Session.open(pr.arg, process.cwd());
		const first = await s.review();
		await s.setStates(first.revision, mark(first));
		const head = push(ps2(base, ps1));
		await s.checkHead();
		const answer = await settled(s, head);
		expect(answer.interdiff).toBe("available");
		const view = await s.viewHead(head);
		const since = await s.interdiffHunks(1, view.revision, fileOf(view).index);
		return { s, view, since, answer };
	}

	/** Ticks every since-view piece of the grown cluster, as the page does. */
	async function tickEveryPiece(
		s: Session,
		start: ReviewView,
		pieces: readonly SincePiece[],
	): Promise<ReviewView> {
		let view = start;
		const key = grown(view).key;
		const owned = pieces.filter((p) => p.key === key && p.owns);
		expect(owned.length).toBeGreaterThan(1);
		for (const p of owned) {
			view = await s.setStates(view.revision, [
				toggleChange(grown(view), p.owns ?? []),
			]);
		}
		return view;
	}

	const wholeFile = (view: ReviewView): StateChange[] =>
		fileOf(view).clusters.map((c) => ({ key: c.key, state: "reviewed" }));

	it("reproduces: every piece ticked, the grown cluster is reviewed (its unchanged blank was reviewed in PS1)", async () => {
		const { s, view, since } = await toPs2(wholeFile);
		expect(grown(view).added).toEqual(PS2_ADDED);
		const after = await tickEveryPiece(s, view, since.pieces ?? []);
		const { state, reviewedLines } = grown(after);
		expect({ state, reviewedLines }).toEqual({
			state: "reviewed",
			reviewedLines: undefined,
		});
		expect(after.progress.clusters.reviewed).toBe(
			after.progress.clusters.total,
		);
		// A fresh open reads the same.
		const again = await Session.open(pr.arg, process.cwd());
		expect(grown(await again.review()).state).toBe("reviewed");
	});
});
