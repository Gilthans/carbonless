import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bestCpuRatio, repeat } from "../../../test/cpu";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
} from "../../../test/git-fixture";
import { size } from "../../shared/lineRanges";
import type { SincePiece } from "../../shared/pieces";
import type { DiffLine, FileHunks, Snapshot } from "../../shared/types";
import { matchDisplayHunk, SPLIT_CELLS } from "../../shared/whitespace";
import { hunkView } from "../../web/files/whitespace";
import { buildSnapshot } from "../diff/snapshot";
import { humanMarksOf } from "../review/coverage";
import type { StateEntry } from "../review/fold";
import {
	answerRereview,
	interdiffFileHunks,
	type SincePatchset,
	traceRereview,
} from "./engine";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

/*
 * The since view's pieces against a real interdiff (pieces.ts, engine.ts
 * interdiffFileHunks). One file, three cases:
 * - two reviewed PS1 clusters that PS2 merges into one: it deletes more
 *   base lines and keeps one line the same as a reviewed PS1 line, so the
 *   since view shows a removal-only piece inside the PS2 cluster;
 * - lines PS1 added that PS2 takes out again (back to the base): reverted;
 * - a block PS1 added that PS2 edits in three places: one cluster, three pieces.
 */
const base = Array.from({ length: 40 }, (_, i) => `base ${i + 1}`);
const block = Array.from({ length: 10 }, (_, i) => `block ${i + 1}`);
const edit = (lines: string[], at: number, remove: number, add: string[]) => {
	const copy = [...lines];
	copy.splice(at, remove, ...add);
	return copy;
};
const text = (lines: string[]) => `${lines.join("\n")}\n`;

// PS1, top to bottom: the block after base 5; base 10–13 → five new
// lines (A); base 14 kept; base 15 → one new line (B); two lines added
// after base 30 (R).
let ps1 = edit(base, 30, 0, ["added 1", "added 2"]);
ps1 = edit(ps1, 14, 1, ["b new"]);
ps1 = edit(ps1, 9, 4, ["a 1", "a 2", "a 3", "a 4", "a 5"]);
ps1 = edit(ps1, 5, 0, block);
// PS2: the block edited at its lines 2, 6 and 9; base 10–15 all gone but
// B's line; R taken out again.
const reworked = block.map((l, i) => ([1, 5, 8].includes(i) ? `${l}!` : l));
let ps2 = edit(base, 9, 6, ["b new"]);
ps2 = edit(ps2, 5, 0, reworked);

let g: GitFixture;
let s1: Snapshot;
let s2: Snapshot;
beforeAll(async () => {
	g = createGitFixture([
		{ message: "base", files: { "a.txt": text(base) } },
		{ message: "ps1", files: { "a.txt": text(ps1) } },
		{ message: "ps2", files: { "a.txt": text(ps2) } },
	]);
	const [b0, h1, h2] = g.shas as [string, string, string];
	s1 = await buildSnapshot(g.path, b0, h1);
	s2 = await buildSnapshot(g.path, b0, h2);
});
afterAll(() => g.cleanup());

async function piecesOf(reviewed: (key: string, i: number) => boolean) {
	const states = new Map<string, StateEntry>();
	s1.files[0]?.clusters.forEach((c, i) => {
		if (reviewed(c.key, i)) states.set(c.key, { state: "reviewed" });
	});
	const since: SincePatchset = {
		number: 1,
		revision: s1.revision,
		mergeBase: s1.base,
		head: s1.head,
		startedAt: 0,
		since: null,
		shape: null,
		baseBranch: "main",
		interdiff: null,
		snapshot: s1,
		states,
	};
	const target = { ...s2, baseBranch: "main" };
	const traced = await traceRereview(g.path, since, [], target);
	const { answer } = answerRereview(traced, since, [], target);
	const hunks = interdiffFileHunks(traced, s2, answer, 0);
	const lines = (p: SincePiece) => {
		const hunk = hunks.hunks[p.hunk];
		const run = [];
		for (const l of hunk?.lines.slice(p.line) ?? []) {
			if (l.kind === "context") break;
			run.push(`${l.kind === "add" ? "+" : "-"}${l.text}`);
		}
		return run;
	};
	/** The line marks the answer carried into a cluster (CAR-195). */
	const carriedInto = (key: string) =>
		answer.files[0]?.clusters.find((c) => c.key === key)?.lines;
	return { pieces: hunks.pieces ?? [], lines, answer, carriedInto };
}

const clusterOf = (start: number) => {
	const c = s2.files[0]?.clusters.find((c) => c.newStart === start);
	if (!c) throw new Error(`no cluster at ${start}`);
	return c;
};

describe("the since view's pieces (engine)", () => {
	it("a removal-only piece inside a PS2 cluster gets that cluster's key and the line it shows; its lines unchanged since reviewed ones carry as reviewed", async () => {
		const { pieces, lines, carriedInto } = await piecesOf(() => true);
		// PS2's cluster: base 10–15 removed, "b new" added (after the block: line 20).
		const merged = clusterOf(20);
		expect(merged).toMatchObject({
			removed: base.slice(9, 15),
			added: ["b new"],
		});
		const piece = pieces.find((p) => p.key === merged.key);
		expect(piece && lines(piece)).toEqual([
			"-a 1",
			"-a 2",
			"-a 3",
			"-a 4",
			"-a 5",
			"-base 14",
		]);
		expect(piece?.owns).toEqual([[4, 5]]);
		expect(piece?.kind).toBe("removed");
		// The rest is unchanged since lines reviewed in PS1: carried.
		expect(carriedInto(merged.key)).toEqual({
			reviewed: [
				[0, 4],
				[5, 7],
			],
		});
	});

	it("fails closed: the PS1 cluster those lines came from unreviewed, its lines carry nothing", async () => {
		// A (PS1's second cluster) unreviewed: base 10–13 it removed carry nothing.
		const { pieces, carriedInto } = await piecesOf((_, i) => i !== 1);
		const merged = clusterOf(20);
		const piece = pieces.find((p) => p.key === merged.key);
		expect(piece?.owns).toEqual([[4, 5]]);
		// base 15 (B removed it, reviewed), "b new" (B's line).
		expect(carriedInto(merged.key)).toEqual({ reviewed: [[5, 7]] });
	});

	it("lines PS1 added that PS2 takes out again are a reverted piece of their own", async () => {
		const { pieces, lines, answer } = await piecesOf(() => true);
		const revert = pieces.find((p) => p.owns === null);
		expect(revert && lines(revert)).toEqual(["-added 1", "-added 2"]);
		expect(revert).toMatchObject({ kind: "reverted", new: [] });
		// The answer lists every piece; to read counts pieces, not clusters:
		// the block's three, the merged cluster's removal, the revert.
		expect(answer.files[0]?.pieces).toEqual(pieces);
		expect(answer.toRead).toEqual({ files: 1, clusters: 5 });
	});

	it("a block edited in three places is one cluster in three pieces; its unchanged lines carry", async () => {
		const { pieces, carriedInto } = await piecesOf(() => true);
		const blockCluster = clusterOf(6);
		const own = pieces.filter((p) => p.key === blockCluster.key);
		expect(own).toHaveLength(3);
		expect(own.map((p) => p.owns)).toEqual([[[1, 2]], [[5, 6]], [[8, 9]]]);
		expect(carriedInto(blockCluster.key)).toEqual({
			reviewed: [
				[0, 1],
				[2, 5],
				[6, 8],
				[9, 10],
			],
		});
	});
});

describe("a base line removed next to a reverted line", () => {
	// PS1 edits lines 3 and 5; PS2 reverts 3 and edits 4 (keeping 5's edit):
	// PS2's one cluster removes base 4 and 5. Base 4 shows removed in the
	// since view next to the reverted line 3: it is PS2's cluster's.
	const lines = Array.from({ length: 10 }, (_, i) => `base ${i + 1}`);
	const at = (over: Record<number, string>) =>
		text(lines.map((l, i) => over[i + 1] ?? l));
	let r: GitFixture;
	let ps1: Snapshot;
	let ps2: Snapshot;
	beforeAll(async () => {
		r = createGitFixture([
			{ message: "base", files: { "b.txt": at({}) } },
			{ message: "ps1", files: { "b.txt": at({ 3: "edit 3", 5: "edit 5" }) } },
			{ message: "ps2", files: { "b.txt": at({ 4: "edit 4", 5: "edit 5" }) } },
		]);
		const [b0, h1, h2] = r.shas as [string, string, string];
		ps1 = await buildSnapshot(r.path, b0, h1);
		ps2 = await buildSnapshot(r.path, b0, h2);
	});
	afterAll(() => r.cleanup());

	it("is keyed to that cluster, so its pieces cover it and it can be completed", async () => {
		const states = new Map<string, StateEntry>(
			ps1.files[0]?.clusters.map((c) => [c.key, { state: "reviewed" }]) ?? [],
		);
		const since: SincePatchset = {
			number: 1,
			revision: ps1.revision,
			mergeBase: ps1.base,
			head: ps1.head,
			startedAt: 0,
			since: null,
			shape: null,
			baseBranch: "main",
			interdiff: null,
			snapshot: ps1,
			states,
		};
		const target = { ...ps2, baseBranch: "main" };
		const traced = await traceRereview(r.path, since, [], target);
		const { answer } = answerRereview(traced, since, [], target);
		const hunks = interdiffFileHunks(traced, ps2, answer, 0);
		const k = ps2.files[0]?.clusters[0];
		expect(k).toMatchObject({
			removed: ["base 4", "base 5"],
			added: ["edit 4", "edit 5"],
		});
		const keyOf = (t: string, kind: string) =>
			hunks.hunks
				.flatMap((h) => h.lines)
				.find((l) => l.text === t && l.kind === kind)?.clusterKey;
		expect(keyOf("base 4", "del")).toBe(k?.key);
		expect(keyOf("edit 4", "add")).toBe(k?.key);
		// The reverted line's piece is the gone PS1 cluster's, on its own.
		expect(keyOf("edit 3", "del")).not.toBe(k?.key);
		// K's pieces own what they show; base 5 / edit 5, unchanged since a
		// reviewed line, carry: together, all of it.
		const carried = answer.files[0]?.clusters.find(
			(c) => c.key === k?.key,
		)?.lines;
		const owned = [
			...(hunks.pieces ?? [])
				.filter((p) => p.key === k?.key)
				.flatMap((p) => p.owns ?? []),
			...(carried?.reviewed ?? []),
		];
		const all = new Set<number>();
		for (const [s, e] of owned) for (let i = s; i < e; i++) all.add(i);
		expect([...all].sort()).toEqual([0, 1, 2, 3]);
	});
});

describe("identical text: a shown removed line is placed in the base by position", () => {
	// Base "", c, "" around d; PS1 adds two lines above and removes c and
	// the blank after it (unreviewed); PS2 removes the blank before c too.
	const base = ["l1", "l2", "", "c", "", "d", "e", "f", "g", "h", "i", "j"];
	const ps1 = [
		"l1",
		"top1",
		"top2",
		"l2",
		"",
		"d",
		"e",
		"f",
		"g",
		"h",
		"i",
		"j",
	];
	const ps2 = ["l1", "top1", "top2", "l2", "d", "e", "f", "g", "h", "i", "j"];
	let r: GitFixture;
	let a: Snapshot;
	let b: Snapshot;
	beforeAll(async () => {
		r = createGitFixture([
			{ message: "base", files: { "a.txt": text(base) } },
			{ message: "ps1", files: { "a.txt": text(ps1) } },
			{ message: "ps2", files: { "a.txt": text(ps2) } },
		]);
		const [b0, h1, h2] = r.shas as [string, string, string];
		a = await buildSnapshot(r.path, b0, h1);
		b = await buildSnapshot(r.path, b0, h2);
	});
	afterAll(() => r.cleanup());

	const piecesFor = async (states: Map<string, StateEntry>) => {
		const since: SincePatchset = {
			number: 1,
			revision: a.revision,
			mergeBase: a.base,
			head: a.head,
			startedAt: 0,
			since: null,
			shape: null,
			baseBranch: "main",
			interdiff: null,
			snapshot: a,
			states,
		};
		const target = { ...b, baseBranch: "main" };
		const traced = await traceRereview(r.path, since, [], target);
		const { answer } = answerRereview(traced, since, [], target);
		const pieces = interdiffFileHunks(traced, b, answer, 0).pieces ?? [];
		return Object.assign(pieces, {
			carriedInto: (key?: string) =>
				answer.files[0]?.clusters.find((c) => c.key === key)?.lines,
		});
	};

	it("the shown blank owns its own place, never the unshown, unvouched twin", async () => {
		const merged = b.files[0]?.clusters.find((c) => c.removed.length === 3);
		expect(merged?.removed).toEqual(["", "c", ""]);
		const pieces = await piecesFor(new Map());
		const own = pieces.find((p) => p.key === merged?.key);
		// Base line 3 (index 0) is what the since view shows; base 5 (index 2)
		// is unshown, unchanged since an unreviewed PS1 removal.
		expect(own?.owns).toEqual([[0, 1]]);
	});

	it("a file the engine has no placement map for: its removed lines are none of a cluster's (never read as base numbers)", async () => {
		const since: SincePatchset = {
			number: 1,
			revision: a.revision,
			mergeBase: a.base,
			head: a.head,
			startedAt: 0,
			since: null,
			shape: null,
			baseBranch: "main",
			interdiff: null,
			snapshot: a,
			states: new Map(),
		};
		const target = { ...b, baseBranch: "main" };
		const traced = await traceRereview(r.path, since, [], target);
		const { answer } = answerRereview(traced, since, [], target);
		// As an old cache entry would be: no baseLine at all.
		const { baseLine: _, ...keys } = traced.lineKeys;
		const stale = { ...traced, lineKeys: keys };
		const merged = b.files[0]?.clusters.find((c) => c.removed.length === 3);
		const pieces = interdiffFileHunks(stale, b, answer, 0).pieces ?? [];
		const own = pieces.filter(
			(p) => p.key === merged?.key && p.owns && !p.orphan,
		);
		expect(own).toEqual([]);
		// Those lines are orphans then (CAR-216): boxes of their own, by the
		// cluster's own base numbers, so still markable.
		expect(
			pieces
				.filter((p) => p.key === merged?.key && p.orphan)
				.flatMap((p) => p.owns ?? []),
		).not.toEqual([]);
	});

	it("PS1's removal crossed off carries as crossed off; reviewed, as reviewed", async () => {
		const states = new Map<string, StateEntry>(
			a.files[0]?.clusters.map((c) => [c.key, { state: "crossed-off" }]) ?? [],
		);
		const merged = b.files[0]?.clusters.find((c) => c.removed.length === 3);
		const crossed = await piecesFor(states);
		expect(crossed.find((p) => p.key === merged?.key)?.owns).toEqual([[0, 1]]);
		expect(crossed.carriedInto(merged?.key)).toEqual({ crossed: [[1, 3]] });
		const reviewed = new Map<string, StateEntry>(
			a.files[0]?.clusters.map((c) => [c.key, { state: "reviewed" }]) ?? [],
		);
		const all = await piecesFor(reviewed);
		expect(all.find((p) => p.key === merged?.key)?.owns).toEqual([[0, 1]]);
		expect(all.carriedInto(merged?.key)).toEqual({ reviewed: [[1, 3]] });
	});
});

describe("a file the since patch set didn't touch", () => {
	const lines = Array.from({ length: 8 }, (_, i) => `b ${i + 1}`);
	let r: GitFixture;
	let a: Snapshot;
	let b: Snapshot;
	beforeAll(async () => {
		r = createGitFixture([
			{ message: "base", files: { "a.txt": "one\n", "b.txt": text(lines) } },
			{ message: "ps1", files: { "a.txt": "one!\n" } },
			{
				message: "ps2",
				files: {
					"b.txt": text(lines.map((l, i) => (i === 3 ? "b four" : l))),
				},
			},
		]);
		const [b0, h1, h2] = r.shas as [string, string, string];
		a = await buildSnapshot(r.path, b0, h1);
		b = await buildSnapshot(r.path, b0, h2);
	});
	afterAll(() => r.cleanup());

	it("its old side is the base: a shown removed line is the cluster's own (the identity map)", async () => {
		const since: SincePatchset = {
			number: 1,
			revision: a.revision,
			mergeBase: a.base,
			head: a.head,
			startedAt: 0,
			since: null,
			shape: null,
			baseBranch: "main",
			interdiff: null,
			snapshot: a,
			states: new Map(),
		};
		const target = { ...b, baseBranch: "main" };
		const traced = await traceRereview(r.path, since, [], target);
		const { answer } = answerRereview(traced, since, [], target);
		const index = b.files.findIndex((f) => f.path === "b.txt");
		const k = b.files[index]?.clusters[0];
		expect(k).toMatchObject({ removed: ["b 4"], added: ["b four"] });
		const pieces = interdiffFileHunks(traced, b, answer, index).pieces ?? [];
		expect(pieces.find((p) => p.key === k?.key)?.owns).toEqual([[0, 2]]);
	});
});

describe("since pieces judged on the interdiff (CAR-218)", () => {
	const head = Array.from({ length: 12 }, (_, i) => `head ${i + 1}`);
	const tail = Array.from({ length: 12 }, (_, i) => `tail ${i + 1}`);
	// PS1 adds a block; PS2 only wraps it one level deeper. The blank line
	// inside reads the same at both depths: an unchanged line between the
	// interdiff's two git hunks, so one display hunk spans both.
	const block = ["if (ready) {", "  start();", "", "  finish();", "}"];
	const deeper = block.map((l) => (l === "" ? l : `  ${l}`));
	// Elsewhere, PS1 changes a base line for real; PS2 instead only
	// re-indents it: whitespace-only against the base, a real edit since.
	const base = [...head, "load();", ...tail];
	const ps1 = [...head, "unload();", ...block, ...tail];
	const ps2 = [...head, "  load();", ...deeper, ...tail];
	let r: GitFixture;
	let a: Snapshot;
	let b: Snapshot;
	beforeAll(async () => {
		r = createGitFixture([
			{ message: "base", files: { "a.ts": text(base) } },
			{ message: "ps1", files: { "a.ts": text(ps1) } },
			{ message: "ps2", files: { "a.ts": text(ps2) } },
		]);
		const [b0, h1, h2] = r.shas as [string, string, string];
		a = await buildSnapshot(r.path, b0, h1);
		b = await buildSnapshot(r.path, b0, h2);
	});
	afterAll(() => r.cleanup());

	const since = async (state: "reviewed" | "crossed-off" | null) => {
		const states = new Map<string, StateEntry>(
			state === null
				? []
				: (a.files[0]?.clusters.map((c) => [c.key, { state }]) ?? []),
		);
		const ps: SincePatchset = {
			number: 1,
			revision: a.revision,
			mergeBase: a.base,
			head: a.head,
			startedAt: 0,
			since: null,
			shape: null,
			baseBranch: "main",
			interdiff: null,
			snapshot: a,
			states,
		};
		const target = { ...b, baseBranch: "main" };
		const traced = await traceRereview(r.path, ps, [], target);
		const { answer } = answerRereview(traced, ps, [], target);
		const hunks = interdiffFileHunks(
			traced,
			b,
			answer,
			0,
			humanMarksOf(a, states),
		);
		const linesOf = (p: SincePiece) => {
			const out: DiffLine[] = [];
			const all = hunks.hunks[p.hunk]?.lines ?? [];
			const n = p.line + size(p.old) + size(p.new);
			for (const l of all.slice(p.line, n)) out.push(l);
			return out;
		};
		const pieces = hunks.pieces ?? [];
		return { hunks, pieces, linesOf, answer };
	};
	const textsOf = (lines: DiffLine[]) =>
		lines.map((l) => `${l.kind === "add" ? "+" : "-"}${l.text}`);

	it("a re-indent since the last review is whitespace-only", async () => {
		for (const state of ["reviewed", "crossed-off"] as const) {
			const { pieces, linesOf, answer } = await since(state);
			const reindent = pieces.filter((p) =>
				linesOf(p).some((l) => l.text.includes("start();")),
			);
			expect(reindent.length).toBeGreaterThan(0);
			const blockLines = pieces
				.filter((p) =>
					linesOf(p).every(
						(l) => block.includes(l.text) || deeper.includes(l.text),
					),
				)
				.flatMap(linesOf);
			// Every changed line of the block, both depths, in a flagged piece;
			// the blank line inside stays unchanged.
			expect(textsOf(blockLines).sort()).toEqual(
				[...block, ...deeper]
					.filter((l) => l !== "")
					.map((l) => (block.includes(l) ? `-${l}` : `+${l}`))
					.sort(),
			);
			for (const p of pieces) {
				if (linesOf(p).some((l) => l.text.includes("load();"))) continue;
				expect(p.whitespaceOnly, `${state} ${textsOf(linesOf(p))}`).toBe(true);
			}
			// The answer's pieces are the page's.
			expect(answer.files[0]?.pieces).toEqual(pieces);
		}
	});

	it("an unread re-indent still counts", async () => {
		const { pieces } = await since(null);
		expect(pieces.length).toBeGreaterThan(0);
		// PS1's own unread changes are orphan pieces (CAR-216), whitespace-
		// only as their cluster is against the base: not the re-indent.
		expect(pieces.filter((p) => p.whitespaceOnly && !p.orphan)).toEqual([]);
	});

	it("a real edit since counts though its cluster is whitespace-only against the base", async () => {
		const cluster = b.files[0]?.clusters.find((c) =>
			c.added.includes("  load();"),
		);
		expect(cluster?.whitespaceOnly).toBe(true);
		const { pieces, linesOf } = await since("reviewed");
		const edit = pieces.filter((p) =>
			linesOf(p).some((l) => l.text.includes("load();")),
		);
		expect(edit.flatMap((p) => textsOf(linesOf(p)))).toEqual([
			"-unload();",
			"+  load();",
		]);
		for (const p of edit) expect(p.whitespaceOnly).toBeUndefined();
	});
});

/**
 * The since view's hunks of one file as the page gets them (JSON: nothing
 * shares an array) against the view's rows (hunkView, with the pieces'
 * first lines as HunkRows passes them): every changed line in exactly one
 * piece; every piece's first line starts a run of the view, the switch off
 * and on (so every piece has its controls); a whitespace-only piece's lines
 * all `~` rows; and, where the file's pieces are cut at whitespace runs
 * (`cut`: something of it marked at PS1), each piece all `~` or none.
 */
function expectAgree(hunks: FileHunks, cut: boolean, label: string) {
	const page = JSON.parse(JSON.stringify(hunks)) as FileHunks;
	const pieces = page.pieces ?? [];
	let flagged = 0;
	let wsRows = 0;
	page.hunks.forEach((hk, h) => {
		const mine = pieces.filter((p) => p.hunk === h);
		const starts = new Set(mine.map((p) => hk.lines[p.line] as DiffLine));
		const tilde = new Set<DiffLine>();
		for (const on of [false, true]) {
			const view = hunkView(hk.lines, on, starts);
			const firsts = new Set(view.runs.map((r) => r.lines[0]));
			for (const p of mine) {
				expect(firsts.has(hk.lines[p.line]), `${label} ${h}:${p.line}`).toBe(
					true,
				);
			}
			if (!on) continue;
			for (const run of view.runs) {
				for (const row of run.rows) {
					if (row.kind !== "ws") continue;
					if (row.del) tilde.add(row.del);
					if (row.add) tilde.add(row.add);
				}
			}
		}
		wsRows += tilde.size;
		const covered = new Set<number>();
		for (const p of mine) {
			// An orphan piece (CAR-216) owns exactly its lines; its removed
			// ones have no number here.
			const n = p.orphan && p.owns ? size(p.owns) : size(p.old) + size(p.new);
			const lines = hk.lines.slice(p.line, p.line + n);
			for (let k = p.line; k < p.line + n; k++) {
				expect(covered.has(k)).toBe(false);
				covered.add(k);
			}
			// Not on the interdiff: never cut at whitespace runs, and
			// whitespace-only as its cluster is (against the base).
			if (p.orphan) continue;
			const rows = lines.map((l) => tilde.has(l));
			if (cut) {
				expect(new Set(rows).size, `${label} ${h}:${p.line}`).toBe(1);
			}
			if (p.whitespaceOnly) {
				expect(rows.every(Boolean), `${label} ${h}:${p.line}`).toBe(true);
				flagged++;
			}
		}
		hk.lines.forEach((l, k) => {
			if (l.kind !== "context") expect(covered.has(k)).toBe(true);
		});
	});
	return { flagged, wsRows };
}

/** The since view from PS1 (`a`, marked by `states`) to PS2 (`b`). */
async function sinceView(
	repo: string,
	a: Snapshot,
	b: Snapshot,
	states: Map<string, StateEntry>,
) {
	const ps: SincePatchset = {
		number: 1,
		revision: a.revision,
		mergeBase: a.base,
		head: a.head,
		startedAt: 0,
		since: null,
		shape: null,
		baseBranch: "main",
		interdiff: null,
		snapshot: a,
		states,
	};
	const target = { ...b, baseBranch: "main" };
	const traced = await traceRereview(repo, ps, [], target);
	const { answer, sources } = answerRereview(traced, ps, [], target);
	return {
		traced,
		answer,
		sources,
		hunks: (index: number) =>
			interdiffFileHunks(traced, b, answer, index, sources),
	};
}

const allReviewed = (s: Snapshot) =>
	new Map<string, StateEntry>(
		s.files.flatMap((f) =>
			f.clusters.map((c) => [c.key, { state: "reviewed" }] as const),
		),
	);

describe("since pieces and the view's `~` rows agree (CAR-218)", () => {
	let seed = 4218;
	const rand = (k: number) => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return (seed >>> 16) % k;
	};
	const words = ["<div>", "</div>", "}", "a();", "if (x) {", "", "b"];
	const pad = ["", "  ", "\t"];
	const line = () => `${pad[rand(pad.length)]}${words[rand(words.length)]}`;
	const indent = (l: string) => (l === "" ? l : `  ${l}`);
	const edit = (old: string[]) =>
		old.flatMap((l) => {
			const r = rand(8);
			if (r === 0) return [];
			if (r === 1) return [line()];
			if (r === 2) return [l, line()];
			if (r < 5) return [indent(l)];
			return [l];
		});
	const FILES = 24;
	const names = Array.from({ length: FILES }, (_, i) => `f${i}.txt`);
	const bases = names.map(() => Array.from({ length: 6 + rand(24) }, line));
	const ps1s = bases.map(edit);
	const ps2s = ps1s.map(edit);
	const files = (texts: string[][]) =>
		Object.fromEntries(names.map((n, i) => [n, text(texts[i] as string[])]));
	let r: GitFixture;
	let a: Snapshot;
	let b: Snapshot;
	beforeAll(async () => {
		r = createGitFixture([
			{ message: "base", files: files(bases) },
			{ message: "ps1", files: files(ps1s) },
			{ message: "ps2", files: files(ps2s) },
		]);
		const [b0, h1, h2] = r.shas as [string, string, string];
		a = await buildSnapshot(r.path, b0, h1);
		b = await buildSnapshot(r.path, b0, h2);
	});
	afterAll(() => r.cleanup());

	it("every piece starts a view run; every whitespace-only piece's lines are `~` rows; nothing marked, only re-indents of lines PS1 left alone are", async () => {
		let flagged = 0;
		let wsRows = 0;
		let leftAlone = 0;
		for (const marked of [true, false]) {
			const view = await sinceView(
				r.path,
				a,
				b,
				marked ? allReviewed(a) : new Map(),
			);
			for (const f of view.answer.files) {
				// Marked: every file PS1 added a line to is cut.
				const cut =
					marked &&
					Object.keys(view.traced.lineKeys.old[f.path] ?? {}).length > 0;
				const hunks = view.hunks(f.index);
				const seen = expectAgree(hunks, cut, f.path);
				if (!marked) {
					// Each line of a flagged piece stands for a removed line
					// no cluster of PS1 added (itself, or an added line's twin).
					const addedThen = view.traced.lineKeys.old[f.path] ?? {};
					for (const p of hunks.pieces ?? []) {
						// An orphan's flag is its cluster's (CAR-216), not a twin's.
						if (!p.whitespaceOnly || p.orphan) continue;
						const all = hunks.hunks[p.hunk]?.lines ?? [];
						const twins = matchDisplayHunk(all);
						const n = size(p.old) + size(p.new);
						for (const l of all.slice(p.line, p.line + n)) {
							const old = l.kind === "add" ? twins.get(l) : l;
							expect(old?.kind, f.path).toBe("del");
							expect(addedThen[old?.oldNo as number], f.path).toBeUndefined();
						}
						leftAlone++;
					}
				}
				flagged += seen.flagged;
				wsRows += seen.wsRows;
			}
		}
		expect(wsRows).toBeGreaterThan(0);
		expect(flagged).toBeGreaterThan(0);
		expect(leftAlone).toBeGreaterThan(0);
	});
});

describe("a since display hunk over the cap (CAR-218)", () => {
	// 600 lines; PS1 changes every 4th, PS2 re-indents those and edits a
	// few for real: the interdiff's changes sit 3 lines apart, so one
	// display hunk of about 600 x 600 lines, over SPLIT_CELLS and not the
	// same keys line for line. Server and view both fall back per run.
	const base = Array.from({ length: 600 }, (_, i) => `row ${i + 1};`);
	const ps1 = base.map((l, i) => (i % 4 === 0 ? `${l} // one` : l));
	const ps2 = ps1.map((l, i) =>
		i % 4 !== 0 ? l : i % 40 === 0 ? `${l} two` : `  ${l}`,
	);
	let r: GitFixture;
	let a: Snapshot;
	let b: Snapshot;
	beforeAll(async () => {
		r = createGitFixture([
			{ message: "base", files: { "big.ts": text(base) } },
			{ message: "ps1", files: { "big.ts": text(ps1) } },
			{ message: "ps2", files: { "big.ts": text(ps2) } },
		]);
		const [b0, h1, h2] = r.shas as [string, string, string];
		a = await buildSnapshot(r.path, b0, h1);
		b = await buildSnapshot(r.path, b0, h2);
	});
	afterAll(() => r.cleanup());

	it("pieces and rows still agree", async () => {
		const view = await sinceView(r.path, a, b, allReviewed(a));
		const hunks = view.hunks(0);
		const [hunk] = hunks.hunks;
		const sides = (k: string) =>
			hunk?.lines.filter((l) => l.kind !== k).length ?? 0;
		expect(hunks.hunks).toHaveLength(1);
		expect(sides("add") * sides("del")).toBeGreaterThan(SPLIT_CELLS);
		const { flagged } = expectAgree(hunks, true, "big.ts");
		expect(flagged).toBeGreaterThan(0);
		// The real edits count.
		const real = (hunks.pieces ?? []).filter((p) =>
			hunk?.lines
				.slice(p.line, p.line + size(p.old) + size(p.new))
				.some((l) => l.text.endsWith("two")),
		);
		expect(real.length).toBeGreaterThan(0);
		for (const p of real) expect(p.whitespaceOnly).toBeUndefined();
	});
});

describe("a run mixing a re-indent and a real edit (CAR-218)", () => {
	const head = Array.from({ length: 8 }, (_, i) => `head ${i + 1}`);
	const tail = Array.from({ length: 8 }, (_, i) => `tail ${i + 1}`);
	// PS1 adds three lines (one cluster); PS2 re-indents two and edits one.
	const ps1 = [...head, "one();", "two();", "three();", ...tail];
	const ps2 = [...head, "  one();", "  two();", "three!();", ...tail];
	let r: GitFixture;
	let a: Snapshot;
	let b: Snapshot;
	beforeAll(async () => {
		r = createGitFixture([
			{ message: "base", files: { "a.ts": text([...head, ...tail]) } },
			{ message: "ps1", files: { "a.ts": text(ps1) } },
			{ message: "ps2", files: { "a.ts": text(ps2) } },
		]);
		const [b0, h1, h2] = r.shas as [string, string, string];
		a = await buildSnapshot(r.path, b0, h1);
		b = await buildSnapshot(r.path, b0, h2);
	});
	afterAll(() => r.cleanup());

	const shape = (hunks: FileHunks) =>
		(hunks.pieces ?? []).map((p) => [
			hunks.hunks[p.hunk]?.lines
				.slice(p.line, p.line + size(p.old) + size(p.new))
				.map((l) => `${l.kind === "add" ? "+" : "-"}${l.text}`),
			p.whitespaceOnly === true,
		]);

	it("read in PS1: each run is cut at its re-indent, which alone is whitespace-only", async () => {
		const view = await sinceView(r.path, a, b, allReviewed(a));
		expect(shape(view.hunks(0))).toEqual([
			[["-one();", "-two();"], true],
			[["-three();"], false],
			[["+  one();", "+  two();"], true],
			[["+three!();"], false],
		]);
		expectAgree(view.hunks(0), true, "a.ts");
	});

	it("nothing of the file marked in PS1: no matching, no cut, it all counts", async () => {
		const view = await sinceView(r.path, a, b, new Map());
		expect(shape(view.hunks(0))).toEqual([
			[
				[
					"-one();",
					"-two();",
					"-three();",
					"+  one();",
					"+  two();",
					"+three!();",
				],
				false,
			],
		]);
	});

	it("one line of PS1's cluster reviewed, its neighbour not: the re-indent counts", async () => {
		const key = a.files[0]?.clusters[0]?.key as string;
		// "one();" (line 0) reviewed, "two();" not.
		const states = new Map<string, StateEntry>([
			[key, { state: "unreviewed", lines: [[0, 1]] }],
		]);
		const view = await sinceView(r.path, a, b, states);
		const pieces = view.hunks(0).pieces ?? [];
		expect(pieces.length).toBeGreaterThan(0);
		expect(pieces.filter((p) => p.whitespaceOnly)).toEqual([]);
		// Both lines reviewed: whitespace-only again.
		const both = await sinceView(
			r.path,
			a,
			b,
			new Map<string, StateEntry>([
				[key, { state: "unreviewed", lines: [[0, 2]] }],
			]),
		);
		expect(
			(both.hunks(0).pieces ?? []).filter((p) => p.whitespaceOnly),
		).toHaveLength(2);
	});
});

describe("a base line PS1 left alone, only re-indented since (CAR-218)", () => {
	const head = Array.from({ length: 8 }, (_, i) => `head ${i + 1}`);
	const mid = Array.from({ length: 8 }, (_, i) => `mid ${i + 1}`);
	const tail = Array.from({ length: 8 }, (_, i) => `tail ${i + 1}`);
	// a.ts: PS1 changes `old();` and leaves `load();` alone; PS2 keeps
	// PS1's change and only re-indents `load();`. b.ts: PS1 never touches
	// it; PS2 only re-indents `save();`. c.ts: PS1 changes `keep();`
	// (left unmarked) and PS2 only re-indents PS1's line. d.ts: PS1 adds
	// a copy of `end();` right after the base's (git takes the second as
	// added); PS2 re-indents the first copy, a slider twin of PS1's line.
	const files = (
		load: string,
		old: string,
		save: string,
		keep: string,
		end: string[],
	): Record<string, string> => ({
		"a.ts": text([...head, old, ...mid, load, ...tail]),
		"b.ts": text([...head, save, ...tail]),
		"c.ts": text([...head, keep, ...tail]),
		"d.ts": text([...head, ...end, ...tail]),
	});
	let r: GitFixture;
	let a: Snapshot;
	let b: Snapshot;
	beforeAll(async () => {
		r = createGitFixture([
			{
				message: "base",
				files: files("load();", "old();", "save();", "keep();", ["end();"]),
			},
			{
				message: "ps1",
				files: files("load();", "new();", "save();", "kept();", [
					"end();",
					"end();",
				]),
			},
			{
				message: "ps2",
				files: files("  load();", "new();", "  save();", "  kept();", [
					"  end();",
					"end();",
				]),
			},
		]);
		const [b0, h1, h2] = r.shas as [string, string, string];
		a = await buildSnapshot(r.path, b0, h1);
		b = await buildSnapshot(r.path, b0, h2);
	});
	afterAll(() => r.cleanup());

	// The re-indents' pieces: PS1's own unread change (a.ts's `old();`)
	// is an orphan piece (CAR-216), checked on its own.
	const shape = (hunks: FileHunks) =>
		(hunks.pieces ?? [])
			.filter((p) => !p.orphan)
			.map((p) => [
				hunks.hunks[p.hunk]?.lines
					.slice(p.line, p.line + size(p.old) + size(p.new))
					.map((l) => `${l.kind === "add" ? "+" : "-"}${l.text}`),
				p.whitespaceOnly === true,
			]);
	const at = (path: string) => b.files.findIndex((f) => f.path === path);

	it("nothing marked in PS1: the re-indent is whitespace-only, as in the full diff", async () => {
		const view = await sinceView(r.path, a, b, new Map());
		expect(shape(view.hunks(at("a.ts")))).toEqual([
			[["-load();", "+  load();"], true],
		]);
		// PS1's change, never reviewed: an orphan piece of its own, counted.
		const orphans = (view.hunks(at("a.ts")).pieces ?? []).filter(
			(p) => p.orphan,
		);
		expect(orphans).toHaveLength(1);
		expect(orphans[0]?.whitespaceOnly).toBeUndefined();
		expectAgree(view.hunks(at("a.ts")), true, "a.ts");
		// A file PS1 never touched: the same.
		expect(shape(view.hunks(at("b.ts")))).toEqual([
			[["-save();", "+  save();"], true],
		]);
	});

	it("fails closed: no placement map (an old cache entry), the re-indent counts", async () => {
		const view = await sinceView(r.path, a, b, new Map());
		const { baseLine: _, ...keys } = view.traced.lineKeys;
		const stale = { ...view.traced, lineKeys: keys };
		for (const path of ["a.ts", "b.ts"]) {
			const hunks = interdiffFileHunks(
				stale,
				b,
				view.answer,
				at(path),
				view.sources,
			);
			expect(hunks.pieces?.length, path).toBeGreaterThan(0);
			expect(
				hunks.pieces?.filter((p) => p.whitespaceOnly && !p.orphan),
				path,
			).toEqual([]);
		}
	});

	it("fails closed: a re-indent of a slider twin of a line PS1 added still counts", async () => {
		const view = await sinceView(r.path, a, b, new Map());
		const hunks = view.hunks(at("d.ts"));
		// The interdiff removes the copy PS1's diff kept as the base's
		// (no cluster's line, placed in the new base): only the slider
		// twin check tells it from PS1's own.
		const addedThen = view.traced.lineKeys.old["d.ts"] ?? {};
		const placed = view.traced.lineKeys.baseLine?.["d.ts"] ?? {};
		const removed = hunks.hunks
			.flatMap((h) => h.lines)
			.filter((l) => l.kind === "del");
		expect(removed.map((l) => l.text)).toEqual(["end();"]);
		const oldNo = removed[0]?.oldNo as number;
		expect(addedThen[oldNo]).toBeUndefined();
		expect(placed[oldNo]).toBeDefined();
		expect(shape(hunks)).toEqual([[["-end();", "+  end();"], false]]);
	});

	it("a line PS1 changed, left unmarked, still counts when only re-indented since", async () => {
		const view = await sinceView(r.path, a, b, new Map());
		const pieces = view.hunks(at("c.ts")).pieces ?? [];
		expect(pieces.length).toBeGreaterThan(0);
		expect(pieces.filter((p) => p.whitespaceOnly)).toEqual([]);
	});
});

describe("the since pieces' whitespace cost (CAR-218)", () => {
	// A file of `blocks` blocks of three lines, ten unchanged lines apart
	// (a display hunk each): PS1 changes every block (reviewed), PS2
	// re-indents it and edits one line, so every hunk is matched and cut.
	const body = (blocks: number, tag: string, at: (l: string) => string) =>
		Array.from({ length: blocks }, (_, k) => [
			...Array.from({ length: 10 }, (_, i) => `${tag} gap ${k} ${i}`),
			...[0, 1, 2].map((j) => at(`${tag} block ${k} ${j}`)),
		]).flat();
	const versions = (blocks: number, tag: string) => [
		body(blocks, tag, (l) => l),
		body(blocks, tag, (l) => `${l} // one`),
		body(blocks, tag, (l) =>
			l.endsWith(" 2") ? `${l} // one two` : `  ${l} // one`,
		),
	];
	let r: GitFixture;
	let a: Snapshot;
	let b: Snapshot;
	beforeAll(async () => {
		const small = versions(30, "s");
		const large = versions(120, "l");
		r = createGitFixture(
			[0, 1, 2].map((v) => ({
				message: `v${v}`,
				files: {
					"small.ts": text(small[v] as string[]),
					"large.ts": text(large[v] as string[]),
				},
			})),
		);
		const [b0, h1, h2] = r.shas as [string, string, string];
		a = await buildSnapshot(r.path, b0, h1);
		b = await buildSnapshot(r.path, b0, h2);
	});
	afterAll(() => r.cleanup());

	it("is linear in a file's hunks", async () => {
		const view = await sinceView(r.path, a, b, allReviewed(a));
		const at = (path: string) => b.files.findIndex((f) => f.path === path);
		const large = () => view.hunks(at("large.ts"));
		const small = () => view.hunks(at("small.ts"));
		// The cut is in play: 120 blocks, each a re-indent piece per side.
		expect((large().pieces ?? []).filter((p) => p.whitespaceOnly)).toHaveLength(
			240,
		);
		// The file 4x as large against four runs of the quarter (test/cpu.ts):
		// linear is about 1x, a cost quadratic in the hunks 4x.
		const { best, ratio } = bestCpuRatio(large, repeat(4, small));
		console.info(
			`since hunks CPU for 120 hunks: ${(best / 1000).toFixed(1)} ms, ${ratio.toFixed(2)}x four 30-hunk files`,
		);
		expect(ratio).toBeLessThan(2);
	});
});
