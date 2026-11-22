import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
} from "../../../test/git-fixture";
import { size } from "../../shared/lineRanges";
import type { SincePiece } from "../../shared/pieces";
import type { DiffLine, Snapshot } from "../../shared/types";
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
		const own = (interdiffFileHunks(stale, b, answer, 0).pieces ?? []).filter(
			(p) => p.key === merged?.key && p.owns,
		);
		expect(own).toEqual([]);
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
		expect(pieces.filter((p) => p.whitespaceOnly)).toEqual([]);
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

	it("every whitespace-only piece's lines are `~` rows; none is when nothing was marked", async () => {
		let flagged = 0;
		let wsRows = 0;
		for (const marked of [true, false]) {
			const states = new Map<string, StateEntry>(
				marked
					? a.files.flatMap((f) =>
							f.clusters.map((c) => [c.key, { state: "reviewed" }] as const),
						)
					: [],
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
			for (const f of answer.files) {
				const hunks = interdiffFileHunks(
					traced,
					b,
					answer,
					f.index,
					humanMarksOf(a, states),
				);
				// As the page gets them: JSON, so nothing shares an array.
				const page = JSON.parse(JSON.stringify(hunks)) as typeof hunks;
				const tilde = new Set<string>();
				page.hunks.forEach((hk, h) => {
					for (const run of hunkView(hk.lines, true).runs) {
						for (const row of run.rows) {
							if (row.kind !== "ws") continue;
							for (const l of [row.del, row.add]) {
								if (l) tilde.add(`${h}:${hk.lines.indexOf(l)}`);
							}
						}
					}
				});
				wsRows += tilde.size;
				const covered = new Set<string>();
				for (const p of page.pieces ?? []) {
					const n = size(p.old) + size(p.new);
					const at = Array.from(
						{ length: n },
						(_, k) => `${p.hunk}:${p.line + k}`,
					);
					for (const id of at) {
						expect(covered.has(id)).toBe(false);
						covered.add(id);
					}
					// A piece is all `~` rows or none.
					const rows = at.map((id) => tilde.has(id));
					expect(new Set(rows).size, `${f.path} ${p.hunk}:${p.line}`).toBe(1);
					if (p.whitespaceOnly) {
						expect(marked).toBe(true);
						expect(
							rows.every(Boolean),
							JSON.stringify({
								p,
								lines: at.map(
									(id) => page.hunks[p.hunk]?.lines[Number(id.split(":")[1])],
								),
							}),
						).toBe(true);
						flagged++;
					}
				}
				// Every changed line is in exactly one piece.
				page.hunks.forEach((hk, h) => {
					hk.lines.forEach((l, k) => {
						if (l.kind !== "context")
							expect(covered.has(`${h}:${k}`)).toBe(true);
					});
				});
			}
		}
		expect(wsRows).toBeGreaterThan(0);
		expect(flagged).toBeGreaterThan(0);
	});
});
