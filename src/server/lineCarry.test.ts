import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prView } from "../../test/fake-gh/scenario";
import { GIT_TEST_TIMEOUTS, testGitEnv } from "../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import {
	type SincePiece,
	sinceOnlyPieces,
	sinceToggleChange,
	sinceUnits,
	toggleChange,
} from "../shared/pieces";
import type {
	ClusterView,
	RereviewAnswer,
	ReviewView,
	StateChange,
} from "../shared/types";
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

	/**
	 * Ticks every since-view piece of the file, as the page does: the grown
	 * cluster's pieces on its lines, the rest (PS1's lines PS2 changed) on
	 * the file's since mark.
	 */
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
		const keys = new Set(fileOf(view).clusters.map((c) => c.key));
		for (const p of sinceOnlyPieces(pieces, keys)) {
			view = await s.setStates(view.revision, [
				sinceToggleChange(view.sinceMarks, 1, PATH, p),
			]);
		}
		return view;
	}

	const wholeFile = (view: ReviewView): StateChange[] =>
		fileOf(view).clusters.map((c) => ({ key: c.key, state: "reviewed" }));
	/** The since view's units of the file still to read (what its counts and "done" go by). */
	const openUnits = (answer: RereviewAnswer, view: ReviewView) =>
		sinceUnits(
			answer.files,
			1,
			(i) => view.files.find((f) => f.index === i)?.clusters ?? [],
			view.sinceMarks,
		).filter((u) => u.path === PATH && u.open > 0);

	it("reproduces: every piece ticked, the grown cluster is reviewed (its unchanged blank was reviewed in PS1)", async () => {
		const { s, view, since, answer } = await toPs2(wholeFile);
		expect(grown(view).added).toEqual(PS2_ADDED);
		const after = await tickEveryPiece(s, view, since.pieces ?? []);
		expect(openUnits(answer, after)).toEqual([]);
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

	it("a line not reviewed in PS1 stays unreviewed: the since view leaves it to read, the full diff marks it", async () => {
		// PS1 marks only another file: nothing of the cluster was reviewed.
		const { s, view, since, answer } = await toPs2(
			(v) =>
				fileOf(v, "other.txt").clusters.map((c) => ({
					key: c.key,
					state: "reviewed",
				})),
			undefined,
			{ "other.txt": "other\n" },
		);
		const after = await tickEveryPiece(s, view, since.pieces ?? []);
		// The blank's twin was never reviewed: it is in no piece.
		expect(grown(after)).toMatchObject({
			state: "unreviewed",
			reviewedLines: [
				[0, 1],
				[2, 4],
			],
		});
		// The since view doesn't read done: the rest of the cluster is to read.
		expect(openUnits(answer, after)).toEqual([
			expect.objectContaining({ rest: true, lines: 1, open: 1 }),
		]);
		// The full diff marks it.
		const done = await s.setStates(after.revision, [
			{ key: grown(after).key, state: "reviewed" },
		]);
		expect(grown(done).state).toBe("reviewed");
		expect(openUnits(answer, done)).toEqual([]);
	});

	/** PS1's one cluster: comment (0), set (1), blank (2), marked line by line. */
	const ps1Lines =
		(reviewedLines: [number, number][], crossedLines: [number, number][]) =>
		(v: ReviewView): StateChange[] => [
			{
				key: (fileOf(v).clusters[0] as ClusterView).key,
				state: "unreviewed",
				reviewedLines,
				crossedLines,
			},
		];

	it("carries line by line: the blank reviewed in a mark of part of PS1's cluster carries", async () => {
		const { s, view, since } = await toPs2(ps1Lines([[1, 3]], [[0, 1]]));
		const after = await tickEveryPiece(s, view, since.pieces ?? []);
		expect(grown(after).state).toBe("reviewed");
	});

	it("a line crossed off in PS1 never carries as reviewed: the blank's twin stays to read", async () => {
		const { s, view, since, answer } = await toPs2(
			ps1Lines([[0, 2]], [[2, 3]]),
		);
		const after = await tickEveryPiece(s, view, since.pieces ?? []);
		expect(grown(after)).toMatchObject({
			state: "unreviewed",
			reviewedLines: [
				[0, 1],
				[2, 4],
			],
		});
		expect(openUnits(answer, after)).toHaveLength(1);
	});

	it("carries across a rebase: the base moved on between PS1 and PS2", async () => {
		const later = (text: string) => text.replace('kind == "a"', 'kind == "b"');
		const { s, view, since, answer } = await toPs2(wholeFile, (base) => {
			const moved = commitOn(base, { [PATH]: later(BASE) });
			pr.moveMain(moved);
			return commitOn(moved, { [PATH]: later(PS2) });
		});
		expect(answer.shape.code).not.toBe("S1");
		expect(grown(view).added).toEqual(PS2_ADDED);
		const after = await tickEveryPiece(s, view, since.pieces ?? []);
		expect(grown(after).state).toBe("reviewed");
		expect(openUnits(answer, after)).toEqual([]);
	});
});
