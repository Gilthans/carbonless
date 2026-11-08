import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
} from "../../../test/git-fixture";
import type { SincePiece } from "../../shared/pieces";
import type { Snapshot } from "../../shared/types";
import { buildSnapshot } from "../diff/snapshot";
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
	const hunks = interdiffFileHunks(traced, s2, answer, 0, states);
	const lines = (p: SincePiece) => {
		const hunk = hunks.hunks[p.hunk];
		const run = [];
		for (const l of hunk?.lines.slice(p.line) ?? []) {
			if (l.kind === "context") break;
			run.push(`${l.kind === "add" ? "+" : "-"}${l.text}`);
		}
		return run;
	};
	return { pieces: hunks.pieces ?? [], lines, answer };
}

const clusterOf = (start: number) => {
	const c = s2.files[0]?.clusters.find((c) => c.newStart === start);
	if (!c) throw new Error(`no cluster at ${start}`);
	return c;
};

describe("the since view's pieces (engine)", () => {
	it("a removal-only piece inside a PS2 cluster gets that cluster's key and, its lines unchanged since reviewed ones, all of it", async () => {
		const { pieces, lines } = await piecesOf(() => true);
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
		expect(piece?.owns).toEqual([[0, 7]]);
		expect(piece?.kind).toBe("removed");
	});

	it("fails closed: the PS1 cluster those lines came from unreviewed, the piece takes only what it shows", async () => {
		// A (PS1's second cluster) unreviewed: base 10–13 it removed are not vouched.
		const { pieces } = await piecesOf((_, i) => i !== 1);
		const merged = clusterOf(20);
		const piece = pieces.find((p) => p.key === merged.key);
		// base 14 (shown), base 15 (B removed it, reviewed), "b new" (B's line).
		expect(piece?.owns).toEqual([[4, 7]]);
	});

	it("lines PS1 added that PS2 takes out again are a reverted piece of their own", async () => {
		const { pieces, lines, answer } = await piecesOf(() => true);
		const revert = pieces.find((p) => p.owns === null);
		expect(revert && lines(revert)).toEqual(["-added 1", "-added 2"]);
		expect(revert).toMatchObject({ kind: "reverted", new: [] });
		expect(answer.files[0]?.sinceOnly).toEqual([
			{ old: revert?.old, new: [], kind: "reverted" },
		]);
		// Counted to read like a cluster.
		expect(answer.toRead.clusters).toBe(2 + 1);
	});

	it("a block edited in three places is one cluster in three pieces, splitting it whole", async () => {
		const { pieces } = await piecesOf(() => true);
		const blockCluster = clusterOf(6);
		const own = pieces.filter((p) => p.key === blockCluster.key);
		expect(own).toHaveLength(3);
		expect(own.map((p) => p.owns)).toEqual([[[0, 5]], [[5, 8]], [[8, 10]]]);
	});
});
