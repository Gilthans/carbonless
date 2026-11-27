import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Cluster, Snapshot } from "../../shared/types.js";
import { parseU0Patch } from "../diff/clusters.js";
import { clusterKeys } from "../diff/identity.js";
import { cutClusters } from "../diff/snapshot.js";
import { buildReviewView, humanMarksOf } from "./coverage.js";
import { type CrbEvent, newEvent } from "./events.js";
import { foldProgress } from "./fold.js";
import { splitCarries, withSplitCarries } from "./splitCarry.js";

const REV = "a".repeat(64);
const REV2 = "b".repeat(64);
/** The whole hunk's key before it split. */
const H = "1".repeat(64);
const P1 = "2".repeat(64);
const P2 = "3".repeat(64);
const P3 = "4".repeat(64);
const OTHER = "9".repeat(64);

/**
 * One hunk of 6 removed and 6 added lines, cut into change / whitespace
 * only / change: the hunk's lines 0-5 removed, 6-11 added; P1 owns 0-1 and
 * 6-7, P2 2-3 and 8-9, P3 4-5 and 10-11.
 */
const piece = (key: string, at: number, ws = false): Cluster => ({
	key,
	kind: "lines",
	oldStart: 1 + at,
	oldCount: 2,
	newStart: 1 + at,
	newCount: 2,
	removed: [`r${at}`, `r${at + 1}`],
	added: [`a${at}`, `a${at + 1}`],
	lines: 4,
	...(ws ? { whitespaceOnly: true as const } : {}),
	split: { key: H, removedAt: at, addedAt: at, removed: 6 },
});

const snapshot = (revision = REV): Snapshot => ({
	base: "1".repeat(40),
	head: "2".repeat(40),
	revision,
	files: [
		{
			index: 0,
			path: "src/a.ts",
			status: "modified",
			binary: false,
			submodule: false,
			additions: 6,
			deletions: 6,
			clusters: [piece(P1, 0), piece(P2, 2, true), piece(P3, 4)],
		},
	],
});

let clock = 1_000;
const at = <E extends CrbEvent>(e: E): E => {
	clock += 10;
	return { ...e, ts: clock };
};
const started = (revision = REV, patchset = 1) =>
	at(
		newEvent("patchset-started", "dan", {
			patchset,
			revision,
			mergeBase: "1".repeat(40),
			head: "2".repeat(40),
			...(patchset > 1 ? { since: patchset - 1, shape: "S1" as const } : {}),
		}),
	);
const mark = (
	cluster: string,
	state: "unreviewed" | "reviewed" | "crossed-off",
	reason?: string,
	revision = REV,
) =>
	at(
		newEvent("cluster-state", "dan", {
			patchset: revision,
			cluster,
			path: "src/a.ts",
			state,
			...(reason ? { reason } : {}),
		}),
	);
const lines = (
	cluster: string,
	state: "reviewed" | "crossed-off",
	ranges: [number, number][],
) =>
	at(
		newEvent("lines-state", "dan", {
			patchset: REV,
			cluster,
			path: "src/a.ts",
			state,
			lines: ranges,
		}),
	);

/** The split carries for `events`, folded in as the store would write them. */
function carry(events: CrbEvent[], snap = snapshot()) {
	const before = foldProgress(events).statesByRevision.get(snap.revision);
	const entries = splitCarries(snap, before ?? new Map());
	const after = [
		...events,
		at(
			newEvent(
				"split-carried",
				"dan",
				{ patchset: snap.revision, states: entries },
				"auto",
			),
		),
	];
	const progress = foldProgress(after);
	return {
		entries,
		view: buildReviewView(snap, progress),
		// What a second read would write.
		again: splitCarries(
			snap,
			progress.statesByRevision.get(snap.revision) ?? new Map(),
		),
	};
}

const states = (view: ReturnType<typeof carry>["view"]) =>
	view.files[0]?.clusters.map((c) => ({
		state: c.state,
		...(c.reason ? { reason: c.reason } : {}),
		...(c.reviewedLines ? { reviewedLines: c.reviewedLines } : {}),
		...(c.crossedLines ? { crossedLines: c.crossedLines } : {}),
		...(c.carried ? { carried: c.carried } : {}),
		...(c.linesCarried ? { linesCarried: c.linesCarried } : {}),
	}));

describe("splitCarries", () => {
	it("puts a whole hunk's mark on every piece, once", () => {
		const { entries, view, again } = carry([started(), mark(H, "reviewed")]);
		expect(entries).toEqual([
			{ key: P1, fromKey: H, state: "reviewed" },
			{ key: P2, fromKey: H, state: "reviewed" },
			{ key: P3, fromKey: H, state: "reviewed" },
		]);
		expect(states(view)).toEqual([
			{ state: "reviewed" },
			{ state: "reviewed" },
			{ state: "reviewed" },
		]);
		expect(view.progress.clusters).toEqual({
			total: 3,
			reviewed: 3,
			crossedOff: 0,
		});
		expect(again).toEqual([]);
	});

	it("keeps a crossed-off hunk's reason on each piece", () => {
		const { view, again } = carry([
			started(),
			mark(H, "crossed-off", "generated"),
		]);
		expect(states(view)).toEqual(
			Array(3).fill({ state: "crossed-off", reason: "generated" }),
		);
		expect(again).toEqual([]);
	});

	it("maps a hunk's line marks onto its pieces: whole where they cover one, by lines where they cover part", () => {
		const { entries, view, again } = carry([
			started(),
			mark(H, "unreviewed"),
			// P1 whole, P2's first removed and first added line.
			lines(H, "reviewed", [
				[0, 3],
				[6, 9],
			]),
			// P3's added lines.
			lines(H, "crossed-off", [[10, 12]]),
		]);
		expect(entries).toEqual([
			{
				key: P1,
				fromKey: H,
				state: "reviewed",
				from: [
					[0, 2],
					[6, 8],
				],
			},
			{
				key: P2,
				fromKey: H,
				state: "reviewed",
				from: [
					[2, 3],
					[8, 9],
				],
				lines: [
					[0, 1],
					[2, 3],
				],
			},
			{
				key: P3,
				fromKey: H,
				state: "crossed-off",
				from: [[10, 12]],
				lines: [[2, 4]],
			},
		]);
		expect(states(view)).toEqual([
			{ state: "reviewed" },
			{
				state: "unreviewed",
				reviewedLines: [
					[0, 1],
					[2, 3],
				],
			},
			{ state: "unreviewed", crossedLines: [[2, 4]] },
		]);
		expect(again).toEqual([]);
	});

	it("marks a piece its hunk's lines cover in two states by lines, reviewed with its crossed lines", () => {
		const { entries, view } = carry([
			started(),
			lines(H, "reviewed", [
				[0, 2],
				[6, 7],
			]),
			lines(H, "crossed-off", [[7, 8]]),
		]);
		expect(entries.filter((e) => e.key === P1)).toHaveLength(2);
		expect(states(view)?.[0]).toEqual({
			state: "reviewed",
			crossedLines: [[3, 4]],
		});
	});

	it("carries nothing a hunk didn't have: unmarked, unreviewed, or a stored key matching nothing old or new", () => {
		expect(carry([started()]).entries).toEqual([]);
		expect(carry([started(), mark(H, "unreviewed")]).entries).toEqual([]);
		const stray = carry([started(), mark(OTHER, "reviewed")]);
		expect(stray.entries).toEqual([]);
		expect(states(stray.view)).toEqual(Array(3).fill({ state: "unreviewed" }));
		expect(stray.view.progress.clusters.reviewed).toBe(0);
	});

	it("leaves a piece that holds its own mark alone, unticked too", () => {
		const { entries, view } = carry([
			started(),
			mark(H, "reviewed"),
			mark(P2, "unreviewed"),
			mark(P3, "crossed-off"),
		]);
		expect(entries.map((e) => e.key)).toEqual([P1]);
		expect(states(view)).toEqual([
			{ state: "reviewed" },
			{ state: "unreviewed" },
			{ state: "crossed-off" },
		]);
	});

	it("does nothing while the hunk's key is still a cluster of the snapshot", () => {
		const snap = snapshot();
		const file = snap.files[0] as Snapshot["files"][number];
		file.clusters = [...file.clusters, { ...piece(H, 6), split: undefined }];
		expect(carry([started(), mark(H, "reviewed")], snap).entries).toEqual([]);
	});

	it("carries a carried hunk's mark as carried, in a later patch set", () => {
		const events = [
			started(),
			mark(H, "reviewed"),
			started(REV2, 2),
			at(
				newEvent(
					"carried",
					"dan",
					{
						from: 1,
						to: 2,
						rule: "exact",
						states: [{ key: H, state: "reviewed" }],
					},
					"auto",
				),
			),
		];
		const { view } = carry(events, snapshot(REV2));
		expect(states(view)).toEqual(
			Array(3).fill({
				state: "reviewed",
				carried: { from: 1, rule: "exact" },
			}),
		);
	});
});

describe("a hunk the engine line-carried (CAR-308)", () => {
	const K0 = "8".repeat(64);
	/** PS1 (REV2) reviews K0 whole; PS2 (REV) line-carries 4 of its lines onto H: P1's. */
	const events = (): CrbEvent[] => [
		started(REV2, 1),
		mark(K0, "reviewed", undefined, REV2),
		started(REV, 2),
		at(
			newEvent(
				"lines-carried",
				"dan",
				{
					from: 1,
					to: 2,
					states: [
						{
							key: H,
							fromKey: K0,
							state: "reviewed",
							lines: [
								[0, 2],
								[6, 8],
							],
							fromLines: [[0, 4]],
						},
					],
				},
				"auto",
			),
		),
	];

	it("carries onto the piece as the engine's, never as the reviewer's own, and only once", () => {
		const { entries, view, again } = carry(events());
		expect(entries).toEqual([
			{
				key: P1,
				fromKey: H,
				state: "reviewed",
				from: [
					[0, 2],
					[6, 8],
				],
				lines: [[0, 4]],
			},
		]);
		expect(states(view)).toEqual([
			{ state: "reviewed", linesCarried: { from: 1, lines: [[0, 4]] } },
			{ state: "unreviewed" },
			{ state: "unreviewed" },
		]);
		expect(again).toEqual([]);
		// What the next push's carry reads as the reviewer's: nothing.
		const progress = foldProgress([
			...events(),
			at(
				newEvent(
					"split-carried",
					"dan",
					{ patchset: REV, states: entries },
					"auto",
				),
			),
		]);
		const human = humanMarksOf(
			snapshot(),
			progress.statesByRevision.get(REV) ?? new Map(),
		);
		expect(human.get(P1)).toMatchObject({ reviewed: [], crossed: [] });
	});

	it("withSplitCarries, as Home reads it, shows the same carried piece", () => {
		const view = buildReviewView(
			snapshot(),
			withSplitCarries(events(), snapshot(), "dan"),
		);
		expect(states(view)?.[0]).toEqual({
			state: "reviewed",
			linesCarried: { from: 1, lines: [[0, 4]] },
		});
	});
});

describe("withSplitCarries", () => {
	it("folds the carries in without writing, as carrySplits would", () => {
		const events = [started(), mark(H, "reviewed"), mark(OTHER, "reviewed")];
		const view = buildReviewView(
			snapshot(),
			withSplitCarries(events, snapshot(), "dan"),
		);
		expect(states(view)).toEqual(Array(3).fill({ state: "reviewed" }));
		// Nothing to carry: the fold as it is.
		const plain = [started(), mark(OTHER, "reviewed")];
		expect(withSplitCarries(plain, snapshot(), "dan")).toEqual(
			foldProgress(plain),
		);
	});
});

describe("splitCarries, for any hunk and any marks on it (principle 2)", () => {
	type Mark = "r" | "x" | "-";
	const word = fc.constantFrom("a", "b", "c", "", "}");
	const spaced = fc
		.tuple(word, fc.constantFrom("", " ", "\t", "  "), fc.boolean())
		.map(([w, ws, after]) => (after ? `${w}${ws}` : `${ws}${w}`));
	const hunkArb = fc.record({
		removed: fc.array(spaced, { minLength: 1, maxLength: 7 }),
		added: fc.array(spaced, { minLength: 1, maxLength: 7 }),
		whole: fc.option(fc.constantFrom("reviewed", "crossed-off" as const)),
		marks: fc.array(fc.constantFrom<Mark>("r", "x", "-"), {
			minLength: 14,
			maxLength: 14,
		}),
	});
	const keyOf = (i: number) => (i + 2).toString(16).padStart(64, "0");

	/** Each piece line's effective state, as the view shows it. */
	function check(
		removed: string[],
		added: string[],
		whole: "reviewed" | "crossed-off" | null,
		lineMarks: Mark[],
		markdown = false,
	): boolean {
		const n = removed.length;
		const hunk: Omit<Cluster, "key"> = {
			kind: "lines",
			oldStart: 10,
			oldCount: n,
			newStart: 10,
			newCount: added.length,
			removed,
			added,
			lines: n + added.length,
		};
		// As buildSnapshot cuts and keys them; the hunk alone keys as H.
		// Unchanged lines around the hunk that match none of its lines; for
		// the Markdown cut, lines 1-9 above it only, as the file's.
		const above = Array.from({ length: 9 }, (_, i) => `para ${i}`);
		const around = (side: string[]) => [
			...Array.from({ length: 9 }, (_, i) => `ctx ${i}`),
			...side,
			"ctx end",
		];
		const clusters = cutClusters(
			[hunk],
			(cs) =>
				cs.length === 1 && cs[0] === hunk ? [H] : cs.map((_, i) => keyOf(i)),
			markdown
				? {
						oldLines: [...above, ...removed],
						newLines: [...above, ...added],
						noNewlineAtEnd: false,
					}
				: {
						oldLines: around(removed),
						newLines: around(added),
						noNewlineAtEnd: false,
					},
			{ markdown },
		);
		if (clusters.length < 2) return true;
		const snap = snapshot();
		(snap.files[0] as Snapshot["files"][number]).clusters = clusters;
		const hl = lineMarks.slice(0, hunk.lines);
		const ranges = (want: Mark) => {
			const out: [number, number][] = [];
			hl.forEach((v, i) => {
				if (v !== want) return;
				const last = out.at(-1);
				if (last && last[1] === i) last[1]++;
				else out.push([i, i + 1]);
			});
			return out;
		};
		const events: CrbEvent[] = [started()];
		if (whole) {
			events.push(mark(H, whole));
			hl.fill(whole === "reviewed" ? "r" : "x");
		} else {
			for (const [state, m] of [
				["reviewed", "r"],
				["crossed-off", "x"],
			] as const) {
				const r = ranges(m);
				if (r.length > 0) events.push(lines(H, state, r));
			}
		}
		const { view } = carry(events, snap);
		const has = (r: [number, number][] | undefined, i: number) =>
			(r ?? []).some(([a, b]) => a <= i && i < b);
		return (view.files[0]?.clusters ?? []).every((c) => {
			const split = c.split as NonNullable<Cluster["split"]>;
			const rn = c.removed.length;
			for (let i = 0; i < c.lines; i++) {
				const h = i < rn ? split.removedAt + i : n + split.addedAt + i - rn;
				const got: Mark =
					c.state === "crossed-off"
						? "x"
						: c.state === "reviewed"
							? has(c.crossedLines, i)
								? "x"
								: "r"
							: has(c.reviewedLines, i)
								? "r"
								: has(c.crossedLines, i)
									? "x"
									: "-";
				if (got !== hl[h]) return false;
			}
			return true;
		});
	}

	it("marks each piece line exactly as its hunk line was marked: one-sided pieces, unequal offsets, partial marks", () => {
		fc.assert(
			fc.property(hunkArb, ({ removed, added, whole, marks }) =>
				check(removed, added, whole, marks),
			),
			{ numRuns: 3000 },
		);
	});

	it("the same with the Markdown block cut too (CAR-167)", () => {
		const prefix = fc.constantFrom("", "- ", "  - ", "# ", "| ");
		const mdLine = fc.tuple(prefix, spaced).map(([p, l]) => `${p}${l}`);
		fc.assert(
			fc.property(
				fc.array(mdLine, { minLength: 1, maxLength: 7 }),
				fc.array(mdLine, { minLength: 1, maxLength: 7 }),
				hunkArb,
				(removed, added, { whole, marks }) =>
					check(removed, added, whole, marks, true),
			),
			{ numRuns: 3000 },
		);
	});

	it("a deletion-only piece before a whitespace-only one: only the lines marked", () => {
		// Pieces: -gone | ~ b1,b2 | +new: removedAt 0,1,3 / addedAt 0,0,2.
		const removed = ["gone", "  b1", "  b2"];
		const added = ["b1", "b2", "new"];
		// Hunk lines: 0 gone, 1-2 b1 b2 (old), 3-4 b1 b2 (new), 5 new.
		const marks: Mark[] = ["-", "r", "-", "x", "r", "r"];
		expect(check(removed, added, null, marks)).toBe(true);
		expect(check(removed, added, "crossed-off", marks)).toBe(true);
	});
});

describe("splitCarries onto Markdown block pieces (CAR-167)", () => {
	const keyOf = (i: number) => (i + 2).toString(16).padStart(64, "0");
	/** A snapshot of `clusters` as its only file's. */
	const snapOf = (clusters: Cluster[]) => {
		const snap = snapshot();
		(snap.files[0] as Snapshot["files"][number]).clusters = clusters;
		return snap;
	};

	describe("a hunk across three list items, marked before the block cut", () => {
		const oldLines = ["- a", "- b", "- c"];
		const newLines = ["- A", "- B", "- C"];
		const hunk: Omit<Cluster, "key"> = {
			kind: "lines",
			oldStart: 1,
			oldCount: 3,
			newStart: 1,
			newCount: 3,
			removed: oldLines,
			added: newLines,
			lines: 6,
		};
		// Keyed as buildSnapshot keys them: the hunk alone keys as H.
		const keysOf = (cs: Omit<Cluster, "key">[]) =>
			cs.length === 1 && cs[0] === hunk ? [H] : cs.map((_, i) => keyOf(i));
		const pieces = () =>
			cutClusters(
				[hunk],
				keysOf,
				{ oldLines, newLines, noNewlineAtEnd: false },
				{ markdown: true },
			);

		it("is cut into one piece per item, each pointing at the hunk", () => {
			expect(pieces().map((c) => [c.key, c.removed, c.added, c.split])).toEqual(
				[0, 1, 2].map((i) => [
					keyOf(i),
					[oldLines[i]],
					[newLines[i]],
					{ key: H, removedAt: i, addedAt: i, removed: 3 },
				]),
			);
		});

		it("carries a reviewed or crossed-off hunk onto every piece", () => {
			const reviewed = carry(
				[started(), mark(H, "reviewed")],
				snapOf(pieces()),
			);
			expect(states(reviewed.view)).toEqual(
				Array(3).fill({ state: "reviewed" }),
			);
			expect(reviewed.again).toEqual([]);
			const crossed = carry(
				[started(), mark(H, "crossed-off", "generated")],
				snapOf(pieces()),
			);
			expect(states(crossed.view)).toEqual(
				Array(3).fill({ state: "crossed-off", reason: "generated" }),
			);
		});

		it("carries a partly reviewed hunk's lines onto the pieces they fall in", () => {
			// Hunk lines: 0-2 removed a b c, 3-5 added A B C. Item a whole, B only.
			const { view, again } = carry(
				[
					started(),
					lines(H, "reviewed", [
						[0, 1],
						[3, 5],
					]),
				],
				snapOf(pieces()),
			);
			expect(states(view)).toEqual([
				{ state: "reviewed" },
				{ state: "unreviewed", reviewedLines: [[1, 2]] },
				{ state: "unreviewed" },
			]);
			expect(view.progress.clusters).toEqual({
				total: 3,
				reviewed: 1,
				crossedOff: 0,
			});
			expect(again).toEqual([]);
		});
	});

	describe("CAR-156 pieces marked before the block cut", () => {
		// change / whitespace only across two items / change, in one hunk.
		const oldLines = ["- x", "- a ", "- b ", "- y"];
		const newLines = ["- X", "- a", "- b", "- Y"];
		const hunk: Omit<Cluster, "key"> = {
			kind: "lines",
			oldStart: 1,
			oldCount: 4,
			newStart: 1,
			newCount: 4,
			removed: oldLines,
			added: newLines,
			lines: 8,
		};
		const keysOf = (cs: Omit<Cluster, "key">[]) =>
			clusterKeys("src/a.ts", cs, newLines);
		const ws = cutClusters([hunk], keysOf, {
			oldLines,
			newLines,
			noNewlineAtEnd: false,
		});
		const md = cutClusters(
			[hunk],
			keysOf,
			{ oldLines, newLines, noNewlineAtEnd: false },
			{ markdown: true },
		);

		it("reads a CAR-156 piece the block cut splits again unreviewed, and keeps the marks of pieces it leaves whole", () => {
			expect(ws.map((c) => c.whitespaceOnly ?? false)).toEqual([
				false,
				true,
				false,
			]);
			expect(md).toHaveLength(4);
			const [x, w, y] = ws as [Cluster, Cluster, Cluster];
			const { entries, view } = carry(
				[
					started(),
					mark(x.key, "reviewed"),
					mark(w.key, "reviewed"),
					mark(y.key, "crossed-off", "generated"),
				],
				snapOf(md),
			);
			expect(entries).toEqual([]);
			expect(states(view)).toEqual([
				{ state: "reviewed" },
				{ state: "unreviewed" },
				{ state: "unreviewed" },
				{ state: "crossed-off", reason: "generated" },
			]);
			expect(view.progress.clusters).toEqual({
				total: 4,
				reviewed: 1,
				crossedOff: 1,
			});
		});

		it("keeps the mark of a CAR-156 piece the block cut leaves whole", () => {
			// The same hunk with the whitespace run inside one item: nothing to cut again.
			const oneOld = ["- x", "- a ", "  b ", "- y"];
			const oneNew = ["- X", "- a", "  b", "- Y"];
			const one = { ...hunk, removed: oneOld, added: oneNew };
			const keys = (cs: Omit<Cluster, "key">[]) =>
				clusterKeys("src/a.ts", cs, oneNew);
			const before = cutClusters([one], keys, {
				oldLines: oneOld,
				newLines: oneNew,
				noNewlineAtEnd: false,
			});
			const after = cutClusters(
				[one],
				keys,
				{ oldLines: oneOld, newLines: oneNew, noNewlineAtEnd: false },
				{ markdown: true },
			);
			expect(after.map((c) => c.key)).toEqual(before.map((c) => c.key));
			const w = before[1] as Cluster;
			expect(w.whitespaceOnly).toBe(true);
			const { view } = carry(
				[started(), mark(w.key, "reviewed")],
				snapOf(after),
			);
			expect(states(view)).toEqual([
				{ state: "unreviewed" },
				{ state: "reviewed" },
				{ state: "unreviewed" },
			]);
		});
	});

	describe("a hunk marked before CAR-156, a CAR-156 piece the block cut splits again", () => {
		/** One hunk of `oldLines` → `newLines` from line 1, cut both ways. */
		const cuts = (oldLines: string[], newLines: string[]) => {
			const hunk: Omit<Cluster, "key"> = {
				kind: "lines",
				oldStart: 1,
				oldCount: oldLines.length,
				newStart: 1,
				newCount: newLines.length,
				removed: oldLines,
				added: newLines,
				lines: oldLines.length + newLines.length,
			};
			const keysOf = (cs: Omit<Cluster, "key">[]) =>
				clusterKeys("src/a.ts", cs, newLines);
			return {
				hunkKey: keysOf([hunk])[0] as string,
				ws: cutClusters([hunk], keysOf, {
					oldLines,
					newLines,
					noNewlineAtEnd: false,
				}),
				md: cutClusters(
					[hunk],
					keysOf,
					{ oldLines, newLines, noNewlineAtEnd: false },
					{ markdown: true },
				),
			};
		};
		// A whitespace-only piece across two items: [x] [a␠ b␠] [y].
		const wsCase = cuts(
			["- x", "- a ", "- b ", "- y"],
			["- X", "- a", "- b", "- Y"],
		);
		// The review's case: a change piece across two items, then a
		// whitespace-only one: [x y] [a␠].
		const changeCase = cuts(["- x", "- y", "- a "], ["- X", "- Y", "- a"]);

		it("cuts the CAR-156 piece again, its block pieces naming it", () => {
			expect(wsCase.md.map((c) => c.split?.piece)).toEqual([
				undefined,
				wsCase.ws[1]?.key,
				wsCase.ws[1]?.key,
				undefined,
			]);
			expect(changeCase.ws.map((c) => c.whitespaceOnly ?? false)).toEqual([
				false,
				true,
			]);
			expect(changeCase.md.map((c) => [c.removed, c.split?.piece])).toEqual([
				[["- x"], changeCase.ws[0]?.key],
				[["- y"], changeCase.ws[0]?.key],
				[["- a "], undefined],
			]);
		});

		it("gives the block pieces of an unticked whitespace piece no carry from the hunk", () => {
			const { hunkKey, ws, md } = wsCase;
			const { entries, view } = carry(
				[
					started(),
					mark(hunkKey, "reviewed"),
					mark((ws[1] as Cluster).key, "unreviewed"),
				],
				snapOf(md),
			);
			// x and y hold nothing of their own: they take the hunk's mark.
			expect(entries.map((e) => e.key)).toEqual([md[0]?.key, md[3]?.key]);
			expect(states(view)).toEqual([
				{ state: "reviewed" },
				{ state: "unreviewed" },
				{ state: "unreviewed" },
				{ state: "reviewed" },
			]);
		});

		it("gives the block pieces of an unticked change piece no carry from the hunk", () => {
			const { hunkKey, ws, md } = changeCase;
			const { entries, view } = carry(
				[
					started(),
					mark(hunkKey, "reviewed"),
					mark((ws[0] as Cluster).key, "unreviewed"),
				],
				snapOf(md),
			);
			expect(entries.map((e) => e.key)).toEqual([md[2]?.key]);
			expect(states(view)).toEqual([
				{ state: "unreviewed" },
				{ state: "unreviewed" },
				{ state: "reviewed" },
			]);
			expect(view.progress.clusters.reviewed).toBe(1);
		});

		it("gives none for any state on the CAR-156 piece: reviewed, crossed off, line marks", () => {
			const { hunkKey, ws, md } = changeCase;
			const piece = (ws[0] as Cluster).key;
			for (const own of [
				mark(piece, "reviewed"),
				mark(piece, "crossed-off", "generated"),
				lines(piece, "reviewed", [[0, 1]]),
			]) {
				const { entries } = carry(
					[started(), mark(hunkKey, "crossed-off", "old"), own],
					snapOf(md),
				);
				expect(entries.map((e) => e.key)).toEqual([md[2]?.key]);
			}
		});

		it("carries the hunk's mark as before while the CAR-156 piece holds nothing", () => {
			for (const { hunkKey, md } of [wsCase, changeCase]) {
				const { entries, view } = carry(
					[started(), mark(hunkKey, "reviewed")],
					snapOf(md),
				);
				expect(entries).toHaveLength(md.length);
				expect(states(view)).toEqual(
					Array(md.length).fill({ state: "reviewed" }),
				);
			}
		});
	});
});

describe("the cut over display hunks: reset, no carry (CAR-218, owner 2026-11-22)", () => {
	// A page's markup wrapped one level deeper in a new <Provider>, cut by
	// git into three hunks around the inner `<div>` and `</div>` that equal
	// the outer ones at the new depth; and an unrelated change further down.
	const oldLines = [
		"export function Page() {",
		"  return (",
		"    <div>",
		"      <Header />",
		"      <div>",
		"        <Title />",
		"      </div>",
		"      <Footer />",
		"    </div>",
		"  );",
		"}",
		"",
		"function a() {}",
		"function b() {}",
		"function c() {}",
		"function d() {}",
		"const limit = 1;",
	];
	const newLines = [
		"export function Page() {",
		"  return (",
		"    <Provider>",
		"      <div>",
		"        <Header />",
		"        <div>",
		"          <Title />",
		"        </div>",
		"        <Footer />",
		"      </div>",
		"    </Provider>",
		"  );",
		"}",
		"",
		"function a() {}",
		"function b() {}",
		"function c() {}",
		"function d() {}",
		"const limit = 2;",
	];
	const patch =
		"@@ -3,2 +3 @@\n-    <div>\n-      <Header />\n+    <Provider>\n@@ -6 +5,5 @@\n-        <Title />\n+        <Header />\n+        <div>\n+          <Title />\n+        </div>\n+        <Footer />\n@@ -8,2 +11 @@\n-      <Footer />\n-    </div>\n+    </Provider>\n@@ -17 +19 @@\n-const limit = 1;\n+const limit = 2;\n";

	it("opens a review marked under the old cut with the re-keyed clusters unreviewed and every other mark kept", () => {
		const hunks = parseU0Patch(patch).map((c) => ({
			...c,
			kind: "lines" as const,
		}));
		const keysOf = (cs: Omit<Cluster, "key">[]) =>
			clusterKeys("src/a.ts", cs, newLines);
		// The cut before CAR-218: each hunk matched on its own (what
		// cutClusters falls back to when the hunks don't fit the text).
		const before = cutClusters(hunks, keysOf, {
			oldLines: [],
			newLines: [],
			noNewlineAtEnd: false,
		});
		const after = cutClusters(hunks, keysOf, {
			oldLines,
			newLines,
			noNewlineAtEnd: false,
		});
		const [H1, H2, H3, H4] = keysOf(hunks);
		// Before: H1 whole, H2 in three pieces (only <Title /> paired), H3
		// whole, H4 whole. After: H1 and H3 in two pieces each, H2 whole
		// (all whitespace), H4 whole.
		expect(before.map((c) => c.split?.key ?? c.key)).toEqual([
			H1,
			H2,
			H2,
			H2,
			H3,
			H4,
		]);
		expect(after.map((c) => c.split?.key ?? c.key)).toEqual([
			H1,
			H1,
			H2,
			H3,
			H3,
			H4,
		]);
		const snap = snapshot();
		(snap.files[0] as Snapshot["files"][number]).clusters = after;
		const events: CrbEvent[] = [
			started(),
			...before.map((c) => mark(c.key, "reviewed")),
		];
		const { view } = carry(events, snap);
		const got = view.files[0]?.clusters.map((c) => c.state);
		// H2's pieces were marked; H2 whole is a key nobody marked: it reads
		// unreviewed (no carry). H1's and H3's marks reach their pieces by
		// the split carry, as for any hunk that splits; H4 keeps its key.
		expect(got).toEqual([
			"reviewed",
			"reviewed",
			"unreviewed",
			"reviewed",
			"reviewed",
			"reviewed",
		]);
		const afterKeys = new Set(after.map((c) => c.key));
		expect(
			before.filter((c) => afterKeys.has(c.key)).map((c) => c.key),
		).toEqual([H4]);
	});
});

describe("an added file cut at blank lines (CAR-235): marks from before carry", () => {
	const newLines = ["import x", "", "function a() {", "}", "", "const b = 1;"];
	const patch = `@@ -0,0 +1,6 @@\n${newLines.map((l) => `+${l}\n`).join("")}`;
	const hunks = parseU0Patch(patch).map((c) => ({
		...c,
		kind: "lines" as const,
	}));
	const keysOf = (cs: Omit<Cluster, "key">[]) =>
		clusterKeys("src/a.ts", cs, newLines);
	const text = { oldLines: [], newLines, noNewlineAtEnd: false };
	/** The review's snapshot as this change cuts it (the whole hunk before). */
	const cutSnapshot = (): Snapshot => {
		const snap = snapshot();
		const file = snap.files[0] as Snapshot["files"][number];
		file.status = "added";
		file.additions = 6;
		file.deletions = 0;
		file.clusters = cutClusters(hunks, keysOf, text, { blankLines: true });
		return snap;
	};
	const [WHOLE] = keysOf(hunks);

	it("cuts the file in three, each piece remembering the whole file's key", () => {
		const before = cutClusters(hunks, keysOf, text);
		expect(before.map((c) => c.key)).toEqual([WHOLE]);
		const after = cutSnapshot().files[0]?.clusters ?? [];
		expect(after.map((c) => c.added.length)).toEqual([2, 3, 1]);
		expect(after.every((c) => c.split?.key === WHOLE)).toBe(true);
	});

	it("a whole-file mark from before reads on every piece, and nothing more", () => {
		for (const state of ["reviewed", "crossed-off"] as const) {
			const { view, again } = carry(
				[
					started(),
					mark(
						WHOLE as string,
						state,
						state === "crossed-off" ? "generated" : undefined,
					),
				],
				cutSnapshot(),
			);
			expect(view.files[0]?.clusters.map((c) => c.state)).toEqual([
				state,
				state,
				state,
			]);
			expect(again).toEqual([]);
		}
	});

	it("an unmarked file stays unreviewed; line marks land on the lines they marked", () => {
		expect(
			carry([started()], cutSnapshot()).view.files[0]?.clusters.map(
				(c) => c.state,
			),
		).toEqual(["unreviewed", "unreviewed", "unreviewed"]);
		// Lines 0-2 of the whole hunk reviewed: the first piece whole, the
		// second's first line only, the third not at all.
		const { view } = carry(
			[started(), lines(WHOLE as string, "reviewed", [[0, 3]])],
			cutSnapshot(),
		);
		expect(states(view)).toEqual([
			{ state: "reviewed" },
			{ state: "unreviewed", reviewedLines: [[0, 1]] },
			{ state: "unreviewed" },
		]);
	});
});
