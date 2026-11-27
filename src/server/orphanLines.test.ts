import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prView } from "../../test/fake-gh/scenario";
import { GIT_TEST_TIMEOUTS, testGitEnv } from "../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import {
	pieceState,
	type SincePiece,
	sinceOnlyPieces,
	sinceOnlyState,
	sinceToggleChange,
	sinceUnits,
	toggleChange,
} from "../shared/pieces";
import type { FileHunks, RereviewAnswer, ReviewView } from "../shared/types";
import { countedUnits } from "../web/files/since";
import { Session } from "./session";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

/*
 * CAR-216: a changed line of the viewed snapshot (against the base) that
 * no since-view piece shows and nothing carries: unchanged since PS1, but
 * not a change there (git aligned the base's identical lines another way).
 * It gets a piece of its own, so ticking every box finishes the file.
 *
 * The added case (gallery #58): the base's blank after `count: int` is
 * PS1's line 6 (context). PS2 inserts `Totals`, which starts like the old
 * `Result`; git matches the base's blank to PS2's line 3, so PS2's line 10
 * (PS1's line 6, unchanged since) is an added line.
 */
const file = (...body: string[]) => `${body.join("\n")}\n`;
const BASE = file(
	"class Result:",
	"    count: int",
	"",
	"    def total(self):",
	"        return self.count",
);
const PS1 = file(
	"class Result(Base):",
	"    count: int = 0",
	"",
	"    def add(self):",
	"        return 2",
	"",
	"    def total(self):",
	"        return self.count",
);
const PS2 = file(
	"class Totals:",
	"    count: int",
	"",
	"",
	"class Result(Base):",
	"    count: int = 0",
	"",
	"    def add(self):",
	"        return 3",
	"",
	"    def total(self):",
	"        return self.count",
);
const PATH = "src/result.py";
/** The same three files the other way round: a base line removed, not added. */
const REMOVED = { base: PS2, ps1: PS1, ps2: BASE };
/*
 * A whitespace-only cluster: the base's blank (line 1) is PS1's line 2
 * (context) and PS2's line 3 (unchanged since), but PS2's diff pairs it
 * with PS2's whitespace-only line 1: a whitespace-only cluster whose
 * added line carries (PS1 added it) and whose removed one is an orphan.
 */
const WHITESPACE = {
	base: file("", "b = 2", "b = 2"),
	ps1: file("  ", "", "a = 1", "b = 2"),
	ps2: file("  ", "b = 2", "", "a = 1", "b = 2"),
};

describe("lines no since piece shows and nothing carries (CAR-216)", () => {
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
		const dir = mkdtempSync(join(tmpdir(), "crb-orphan-"));
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
	const fileOf = (view: ReviewView) => {
		const f = view.files.find((f) => f.path === PATH);
		if (!f) throw new Error(`no ${PATH}`);
		return f;
	};

	/**
	 * Main gets `base`, PS1 (`ps1`) is pushed and reviewed whole, then PS2
	 * (`ps2`, built on PS1 unless `rebase` moves main first) is viewed since PS1.
	 */
	async function toPs2(
		texts: { base: string; ps1: string; ps2: string },
		rebase?: (text: string) => string,
	) {
		const base = commitOn(pr.mergeBase, { [PATH]: texts.base });
		pr.moveMain(base);
		const ps1 = push(commitOn(base, { [PATH]: texts.ps1 }));
		const s = await Session.open(pr.arg, process.cwd());
		const first = await s.review();
		await s.setStates(
			first.revision,
			first.files.flatMap((f) =>
				f.clusters.map((c) => ({ key: c.key, state: "reviewed" as const })),
			),
		);
		let parent = ps1;
		let ps2Text = texts.ps2;
		if (rebase) {
			const moved = commitOn(base, { [PATH]: rebase(texts.base) });
			pr.moveMain(moved);
			parent = moved;
			ps2Text = rebase(texts.ps2);
		}
		const head = push(commitOn(parent, { [PATH]: ps2Text }));
		await s.checkHead();
		const answer = await settled(s, head);
		expect(answer.interdiff).toBe("available");
		const view = await s.viewHead(head);
		const since = await s.interdiffHunks(1, view.revision, fileOf(view).index);
		return { s, view, since, answer };
	}

	/** Ticks every since-view piece of the file, as the page does. */
	async function tickEveryPiece(
		s: Session,
		start: ReviewView,
		pieces: readonly SincePiece[],
	): Promise<ReviewView> {
		let view = start;
		const clusterOf = (key: string | undefined) =>
			fileOf(view).clusters.find((c) => c.key === key);
		for (const p of pieces) {
			const cluster = clusterOf(p.key);
			if (!cluster || !p.owns) continue;
			if (pieceState(cluster, p.owns) !== "unreviewed") continue;
			view = await s.setStates(view.revision, [toggleChange(cluster, p.owns)]);
		}
		const keys = new Set(fileOf(view).clusters.map((c) => c.key));
		for (const p of sinceOnlyPieces(pieces, keys)) {
			if (sinceOnlyState(view.sinceMarks, 1, PATH, p) !== "unreviewed") {
				continue;
			}
			view = await s.setStates(view.revision, [
				sinceToggleChange(view.sinceMarks, 1, PATH, p),
			]);
		}
		return view;
	}

	/** The since view's units of the file still to read. */
	const openUnits = (answer: RereviewAnswer, view: ReviewView) =>
		sinceUnits(
			answer.files,
			1,
			(i) => view.files.find((f) => f.index === i)?.clusters ?? [],
			view.sinceMarks,
		).filter((u) => u.path === PATH && u.open > 0);

	/** The rows of the since view's hunks that are orphans (CAR-216), as text. */
	const orphanRows = (since: FileHunks) =>
		since.hunks.flatMap((h) =>
			h.lines
				.filter((l) => l.orphan)
				.map((l) => `${l.kind} ${l.newNo ?? l.baseNo ?? ""}: ${l.text}`),
		);

	it("reproduces: PS2's line 10 (unchanged since PS1, context there) gets a box of its own; ticking every box finishes the file", async () => {
		const { s, view, since, answer } = await toPs2({
			base: BASE,
			ps1: PS1,
			ps2: PS2,
		});
		const cluster = fileOf(view).clusters.find((c) => c.newStart === 4);
		expect(cluster?.added).toHaveLength(7);
		// One orphan piece owns line 10, the cluster's last line (index 6).
		const orphans = (since.pieces ?? []).filter((p) => p.orphan);
		expect(orphans).toEqual([
			expect.objectContaining({
				key: cluster?.key,
				owns: [[6, 7]],
				new: [[10, 11]],
			}),
		]);
		expect(orphanRows(since)).toEqual(["add 10: "]);
		// The answer's pieces are the hunks' (the counts go by them).
		expect(answer.files.find((f) => f.path === PATH)?.pieces).toEqual(
			since.pieces,
		);
		const after = await tickEveryPiece(s, view, since.pieces ?? []);
		expect(openUnits(answer, after)).toEqual([]);
		expect(fileOf(after).clusters.every((c) => c.state === "reviewed")).toBe(
			true,
		);
		expect(after.progress.lines.reviewed).toBe(after.progress.lines.total);
	});

	it("ticking the orphan's box marks that line alone, and unticking it takes it back", async () => {
		const { s, view, since } = await toPs2({ base: BASE, ps1: PS1, ps2: PS2 });
		const orphan = (since.pieces ?? []).find((p) => p.orphan);
		const cluster = fileOf(view).clusters.find((c) => c.key === orphan?.key);
		if (!orphan?.owns || !cluster) throw new Error("no orphan piece");
		// PS1's reviewed lines carried (CAR-195): new lines 5-8.
		expect(cluster.reviewedLines).toEqual([[1, 5]]);
		const ticked = await s.setStates(view.revision, [
			toggleChange(cluster, orphan.owns),
		]);
		const after = fileOf(ticked).clusters.find((c) => c.key === cluster.key);
		expect(after?.reviewedLines).toEqual([
			[1, 5],
			[6, 7],
		]);
		if (!after) throw new Error("no cluster");
		const unticked = await s.setStates(ticked.revision, [
			toggleChange(after, orphan.owns),
		]);
		expect(
			fileOf(unticked).clusters.find((c) => c.key === cluster.key)
				?.reviewedLines,
		).toEqual([[1, 5]]);
	});

	it("a removed base line: shown as removed at its place, its box marks it, ticking every box finishes the file", async () => {
		const { s, view, since, answer } = await toPs2(REMOVED);
		// PS2's diff removes base lines 4-10; the last, a blank, is PS1's
		// line 6 (context there) and unchanged since.
		const cluster = fileOf(view).clusters.find((c) => c.oldStart === 4);
		expect(cluster?.removed).toHaveLength(7);
		expect(orphanRows(since)).toEqual(["del 10: "]);
		const row = since.hunks.flatMap((h) => h.lines).findIndex((l) => l.orphan);
		// At its place: after new line 3, the line its cluster removes before.
		const rows = since.hunks.flatMap((h) => h.lines);
		expect(rows[row - 1]?.newNo).toBe(3);
		expect(rows[row]?.oldNo).toBeUndefined();
		expect((since.pieces ?? []).filter((p) => p.orphan)).toEqual([
			expect.objectContaining({ key: cluster?.key, owns: [[6, 7]] }),
		]);
		const after = await tickEveryPiece(s, view, since.pieces ?? []);
		expect(openUnits(answer, after)).toEqual([]);
		expect(after.progress.lines.reviewed).toBe(after.progress.lines.total);
	});

	it("in a whitespace-only cluster: counted (and boxed) with Ignore whitespace off, left out with it on", async () => {
		const { s, view, since, answer } = await toPs2(WHITESPACE);
		const ws = fileOf(view).clusters.find((c) => c.whitespaceOnly);
		expect(ws).toMatchObject({ removed: [""], added: ["  "] });
		const orphan = (since.pieces ?? []).find(
			(p) => p.orphan && p.key === ws?.key,
		);
		expect(orphan?.owns).toEqual([[0, 1]]);
		// Every other box ticked.
		const others = (since.pieces ?? []).filter((p) => p !== orphan);
		const most = await tickEveryPiece(s, view, others);
		const open = openUnits(answer, most);
		// With Ignore whitespace on the since view counts nothing left
		// (countedUnits leaves whitespace-only units out); off, the orphan.
		expect(countedUnits(open, true).units).toEqual([]);
		expect(countedUnits(open, false).units).toEqual([
			expect.objectContaining({ whitespaceOnly: true, lines: 1, open: 1 }),
		]);
		const done = await tickEveryPiece(s, most, since.pieces ?? []);
		expect(openUnits(answer, done)).toEqual([]);
		expect(done.progress.lines.reviewed).toBe(done.progress.lines.total);
	});

	it("a Markdown file unchanged since an unreviewed PS1: its orphan rows keep the Rendered view (CAR-328)", async () => {
		const DOC = "docs/guide.md";
		const doc = file("# Guide", "", "Read this first.", "", "- one", "- two");
		const base = commitOn(pr.mergeBase, { [PATH]: BASE });
		pr.moveMain(base);
		const ps1 = push(commitOn(base, { [PATH]: PS1, [DOC]: doc }));
		const s = await Session.open(pr.arg, process.cwd());
		const first = await s.review();
		expect(first.files.find((f) => f.path === DOC)?.markdownBlocks).toBe(true);
		// PS1: the other file reviewed, the doc not; PS2 changes only the other.
		await s.setStates(
			first.revision,
			fileOf(first).clusters.map((c) => ({
				key: c.key,
				state: "reviewed" as const,
			})),
		);
		const head = push(commitOn(ps1, { [PATH]: PS2 }));
		await s.checkHead();
		const answer = await settled(s, head);
		const view = await s.viewHead(head);
		const index = view.files.find((f) => f.path === DOC)?.index as number;
		const since = await s.interdiffHunks(1, view.revision, index);
		// Every line of it is an orphan (not reviewed in PS1)...
		expect(orphanRows(since)).toHaveLength(6);
		// ...and the since view offers Rendered for it, as for a changed one.
		expect(since.markdownBlocks).toBe(true);
		expect(answer.files.find((f) => f.path === DOC)?.markdownBlocks).toBe(true);
		expect(since.newLineCount).toBe(6);
	});

	it("works across a rebase: the base moved on between PS1 and PS2", async () => {
		// Main moves on away from the PR's lines: PS2 is rebased onto it.
		const later = (text: string) => `${text}\n\ndef helper():\n    return 1\n`;
		const { s, view, since, answer } = await toPs2(
			{ base: BASE, ps1: PS1, ps2: PS2 },
			later,
		);
		expect(answer.shape.code).not.toBe("S1");
		expect(orphanRows(since)).toEqual(["add 10: "]);
		const after = await tickEveryPiece(s, view, since.pieces ?? []);
		expect(openUnits(answer, after)).toEqual([]);
		expect(after.progress.lines.reviewed).toBe(after.progress.lines.total);
	});
});
