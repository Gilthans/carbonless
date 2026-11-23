import { describe, expect, it } from "vitest";
import type {
	CodeAnchor,
	DiffLine,
	DiffSide,
	DisplayHunk,
	FileHunks,
	ReviewThread,
} from "../../shared/types";
import type { SpanRange } from "../threads/spanMarks";
import {
	earlierPending,
	fileThreads,
	type LineKey,
	lineKey,
	onSinceRows,
	outsideThreads,
	type Placements,
	placeThreads,
	shownThread,
	shownThreads,
	sinceEarlier,
	sinceLeft,
	threadOrder,
} from "./threadPlacement";

const HEAD = "h".repeat(40);
const PATH = "src/a.ts";

const ctx = (oldNo: number, newNo: number): DiffLine => ({
	kind: "context",
	oldNo,
	newNo,
	text: `line ${newNo}`,
});
const del = (oldNo: number): DiffLine => ({
	kind: "del",
	oldNo,
	text: `old ${oldNo}`,
});
const add = (newNo: number): DiffLine => ({
	kind: "add",
	newNo,
	text: `new ${newNo}`,
});
const hunk = (lines: DiffLine[]): DisplayHunk => {
	const olds = lines.flatMap((l) => (l.oldNo === undefined ? [] : [l.oldNo]));
	const news = lines.flatMap((l) => (l.newNo === undefined ? [] : [l.newNo]));
	return {
		oldStart: Math.min(...olds),
		oldCount: olds.length,
		newStart: Math.min(...news),
		newCount: news.length,
		lines,
	};
};

/**
 * Old 1..60, new 1..62. Gap 0 is new 1..7 (old = new); hunk A changes old 10
 * into new 10–11; gap 1 is new 15..40 (old 14..39); hunk B adds new 43;
 * gap 2 is new 46..62 (old 45..61).
 */
const HUNKS: FileHunks = {
	hunks: [
		hunk([
			ctx(8, 8),
			ctx(9, 9),
			del(10),
			add(10),
			add(11),
			ctx(11, 12),
			ctx(12, 13),
			ctx(13, 14),
		]),
		hunk([ctx(40, 41), ctx(41, 42), add(43), ctx(42, 44), ctx(43, 45)]),
	],
	newLineCount: 62,
};

let ids = 0;
const thread = (
	anchor: Partial<CodeAnchor> | null,
	extra: Partial<ReviewThread> = {},
): ReviewThread => {
	ids += 1;
	const line = anchor?.line ?? 1;
	const side: DiffSide = anchor?.side ?? "RIGHT";
	return {
		id: `T${ids}`,
		loaded: false,
		path: PATH,
		line: anchor ? line : null,
		currentLine: null,
		excerpt: "",
		html: "",
		body: "",
		createdAt: "2026-01-01T00:00:00Z",
		lastActivityAt: "2026-01-01T00:00:00Z",
		author: "rev",
		bot: false,
		avatarUrl: "",
		participants: [],
		lastAuthor: { login: "octo", avatarUrl: "", bot: false },
		commentCount: 1,
		hasReply: false,
		outdated: false,
		resolved: false,
		code: null,
		anchor: anchor && {
			path: PATH,
			commit: HEAD,
			side,
			line,
			startSide: anchor.startSide ?? side,
			startLine: anchor.startLine ?? line,
			at: "2026-01-01T00:00:00Z",
			...anchor,
		},
		commit: anchor?.commit ?? HEAD,
		subject: anchor ? "line" : "file",
		attention: [],
		yourTurn: false,
		viewerCan: { reply: false, resolve: false, unresolve: false },
		...extra,
	};
};

const place = (
	threads: ReviewThread[],
	opts: { loadedContext?: DiffLine[]; hunks?: FileHunks | null } = {},
) =>
	placeThreads({
		threads,
		path: PATH,
		snapshotHead: HEAD,
		hunks: opts.hunks === undefined ? HUNKS : opts.hunks,
		loadedContext: opts.loadedContext ?? [],
	});

/** Every bucket's threads, for "absent from all of them". */
const everywhere = (p: ReturnType<typeof place>) => [
	...[...p.end.values()].flat(),
	...[...p.gaps.values()].flat(),
	...p.header.map((h) => h.thread),
];

describe("placeThreads", () => {
	it("a single RIGHT line: its row, highlighted", () => {
		const t = thread({ side: "RIGHT", line: 11 });
		const p = place([t]);
		expect([...p.end]).toEqual([["RIGHT:11", [t]]]);
		expect([...p.covered]).toEqual(["RIGHT:11"]);
		expect(p.gaps.size).toBe(0);
		expect(p.header).toEqual([]);
	});

	it("a multi-line RIGHT range: every line covered, the bubble on the last", () => {
		const t = thread({ side: "RIGHT", startLine: 12, line: 14 });
		const p = place([t]);
		expect([...p.end.keys()]).toEqual(["RIGHT:14"]);
		expect([...p.covered].sort()).toEqual(["RIGHT:12", "RIGHT:13", "RIGHT:14"]);
	});

	it("LEFT on a deleted line", () => {
		const t = thread({ side: "LEFT", line: 10 });
		const p = place([t]);
		expect([...p.end]).toEqual([["LEFT:10", [t]]]);
		expect([...p.covered]).toEqual(["LEFT:10"]);
	});

	it("side picks the number column: a context row's old number is never a RIGHT line", () => {
		// The row old 40 / new 41: RIGHT 41 lands on it, RIGHT 40 doesn't.
		const right41 = thread({ side: "RIGHT", line: 41 });
		const right40 = thread({ side: "RIGHT", line: 40 });
		// The row old 41 / new 42: LEFT 41 lands on it.
		const left41 = thread({ side: "LEFT", line: 41 });
		const p = place([right41, right40, left41]);
		expect(p.end.get("RIGHT:41")).toEqual([right41]);
		expect(p.end.get("LEFT:41")).toEqual([left41]);
		expect(p.end.has("RIGHT:40")).toBe(false);
		expect(p.end.has("LEFT:40")).toBe(false);
		// New 40 isn't shown: it's in the gap above hunk B.
		expect(p.gaps.get(1)).toEqual([right40]);
	});

	it("a LEFT range over context rows covers them by their old numbers", () => {
		const t = thread({ side: "LEFT", startLine: 11, line: 13 });
		const p = place([t]);
		expect([...p.end.keys()]).toEqual(["LEFT:13"]);
		expect([...p.covered].sort()).toEqual(["LEFT:11", "LEFT:12", "LEFT:13"]);
	});

	it("a range from a deleted line to an added one covers the rows between", () => {
		const t = thread({
			startSide: "LEFT",
			startLine: 10,
			side: "RIGHT",
			line: 11,
		});
		const p = place([t]);
		expect([...p.end.keys()]).toEqual(["RIGHT:11"]);
		expect([...p.covered].sort()).toEqual(["LEFT:10", "RIGHT:10", "RIGHT:11"]);
	});

	it("a file comment goes to the header", () => {
		const t = thread(null);
		expect(place([t]).header).toEqual([{ thread: t, reason: "file" }]);
	});

	it("a line beyond the file goes to the header, flagged unplaced", () => {
		const right = thread({ side: "RIGHT", line: 100 });
		const left = thread({ side: "LEFT", line: 100 });
		const p = place([right, left]);
		expect(p.header).toEqual([
			{ thread: right, reason: "unplaced" },
			{ thread: left, reason: "unplaced" },
		]);
		expect(p.end.size + p.gaps.size + p.covered.size).toBe(0);
	});

	it("a line thread with no line, or in a file with no hunks, is unplaced", () => {
		const lost = thread(null, { subject: "line" });
		expect(place([lost]).header).toEqual([
			{ thread: lost, reason: "unplaced" },
		]);
		const t = thread({ side: "RIGHT", line: 3 });
		expect(
			place([t], { hunks: { hunks: [], newLineCount: 10 } }).header,
		).toEqual([{ thread: t, reason: "unplaced" }]);
	});

	it("until the hunks are in, only file comments are placed", () => {
		const file = thread(null);
		const line = thread({ side: "RIGHT", line: 11 });
		const p = place([file, line], { hunks: null });
		expect(p.header).toEqual([{ thread: file, reason: "file" }]);
		expect(p.end.size + p.gaps.size).toBe(0);
	});

	it("a binary or submodule file's line threads are unplaced without its hunks", () => {
		const line = thread({ side: "RIGHT", line: 1 });
		const file = thread(null);
		const p = placeThreads({
			threads: [line, file],
			path: PATH,
			snapshotHead: HEAD,
			hunks: null,
			loadedContext: [],
			noLines: true,
		});
		expect(p.header).toEqual([
			{ thread: line, reason: "unplaced" },
			{ thread: file, reason: "file" },
		]);
		expect(p.end.size + p.gaps.size).toBe(0);
	});

	it("a thread on another commit, or on no known commit, is left out", () => {
		const other = thread({ side: "RIGHT", line: 11, commit: "e".repeat(40) });
		const unknown = thread({ side: "RIGHT", line: 11, commit: "" });
		const otherFile = thread(null, { commit: "e".repeat(40) });
		const p = place([other, unknown, otherFile]);
		expect(everywhere(p)).toEqual([]);
		expect(p.covered.size).toBe(0);
		// Even if the viewed head were unknown too.
		expect(
			everywhere(
				placeThreads({
					threads: [unknown, thread(null, { commit: "" })],
					path: PATH,
					snapshotHead: "",
					hunks: HUNKS,
					loadedContext: [],
				}),
			),
		).toEqual([]);
	});

	it("two threads ending on one line share one entry, in order", () => {
		const a = thread({ side: "RIGHT", line: 12 });
		const b = thread({ side: "RIGHT", startLine: 9, line: 12 });
		const p = place([a, b]);
		expect([...p.end]).toEqual([["RIGHT:12", [a, b]]]);
	});

	it("a RIGHT line inside a collapsed gap goes to that gap", () => {
		const t = thread({ side: "RIGHT", line: 20 });
		const p = place([t]);
		expect([...p.gaps]).toEqual([[1, [t]]]);
		expect(p.gapTargets.get(t)).toEqual({ show: [20, 20], key: "RIGHT:20" });
		expect(p.end.size).toBe(0);
		expect(p.covered.size).toBe(0);
	});

	it("the same line once its context is loaded goes to its row", () => {
		const t = thread({ side: "RIGHT", line: 20 });
		const p = place([t], { loadedContext: [ctx(19, 20), ctx(20, 21)] });
		expect([...p.end]).toEqual([["RIGHT:20", [t]]]);
		expect(p.gaps.size).toBe(0);
	});

	it("a LEFT line in a gap is mapped through the offset of the hunk above", () => {
		const top = thread({ side: "LEFT", line: 5 });
		const middle = thread({ side: "LEFT", line: 39 });
		const bottom = thread({ side: "LEFT", line: 45 });
		const p = place([top, middle, bottom]);
		expect(p.gaps.get(0)).toEqual([top]);
		expect(p.gaps.get(1)).toEqual([middle]);
		expect(p.gaps.get(2)).toEqual([bottom]);
		// Where to load each: old 5 is new 5, old 39 new 40, old 45 new 47.
		expect([...p.gapTargets.values()].map((g) => g.show)).toEqual([
			[5, 5],
			[40, 40],
			[47, 47],
		]);
		// Old 39 is new 40: loaded, it is that row.
		const loaded = place([middle], { loadedContext: [ctx(39, 40)] });
		expect([...loaded.end]).toEqual([["LEFT:39", [middle]]]);
	});

	it("a gap thread's target is the row end uses once its lines are loaded", () => {
		const right = thread({ side: "RIGHT", startLine: 18, line: 20 });
		const left = thread({ side: "LEFT", startLine: 29, line: 30 });
		const before = place([right, left]);
		const rt = before.gapTargets.get(right);
		const lt = before.gapTargets.get(left);
		expect(rt?.show).toEqual([18, 20]);
		// Old 29–30 are new 30–31 below hunk A.
		expect(lt?.show).toEqual([30, 31]);
		// Load exactly what the targets say, as DiffBody does.
		const loadedContext: DiffLine[] = [];
		for (const g of [rt, lt]) {
			for (let n = g?.show[0] ?? 0; n <= (g?.show[1] ?? -1); n++) {
				loadedContext.push(ctx(n - 1, n));
			}
		}
		const after = place([right, left], { loadedContext });
		expect(after.end.get(rt?.key as LineKey)).toEqual([right]);
		expect(after.end.get(lt?.key as LineKey)).toEqual([left]);
		expect(after.gaps.size).toBe(0);
	});

	it("an insertion hunk (-3,0) doesn't shift the old line it follows", () => {
		// Two lines inserted after old 3: old 3 is new 3, old 10 is new 12.
		const insert: FileHunks = {
			hunks: [
				{
					oldStart: 3,
					oldCount: 0,
					newStart: 4,
					newCount: 2,
					lines: [add(4), add(5)],
				},
			],
			newLineCount: 20,
		};
		const at3 = thread({ side: "LEFT", line: 3 });
		const at10 = thread({ side: "LEFT", line: 10 });
		const p = place([at3, at10], { hunks: insert });
		expect(p.gapTargets.get(at3)?.show).toEqual([3, 3]);
		expect(p.gapTargets.get(at10)?.show).toEqual([12, 12]);
	});

	it("a deleted file's LEFT threads land on its rows; RIGHT ones are unplaced", () => {
		const deleted: FileHunks = {
			hunks: [hunk([del(1), del(2), del(3)])].map((h) => ({
				...h,
				newStart: 0,
				newCount: 0,
			})),
			newLineCount: 0,
		};
		const left = thread({ side: "LEFT", line: 2 });
		const right = thread({ side: "RIGHT", line: 2 });
		const p = place([left, right], { hunks: deleted });
		expect([...p.end]).toEqual([["LEFT:2", [left]]]);
		expect(p.header).toEqual([{ thread: right, reason: "unplaced" }]);
	});

	it("a renamed file's threads are on its new path", () => {
		const t = thread({ side: "RIGHT", line: 11 }, { path: "src/renamed.ts" });
		const p = placeThreads({
			threads: [t],
			path: "src/renamed.ts",
			snapshotHead: HEAD,
			hunks: HUNKS,
			loadedContext: [],
		});
		expect([...p.end.keys()]).toEqual(["RIGHT:11"]);
	});

	it("git's delete + add of a rename GitHub kept: a LEFT thread on the added file is unplaced", () => {
		const added: FileHunks = {
			hunks: [
				{
					oldStart: 0,
					oldCount: 0,
					newStart: 1,
					newCount: 3,
					lines: [add(1), add(2), add(3)],
				},
			],
			newLineCount: 3,
		};
		const t = thread({ side: "LEFT", line: 2 });
		expect(place([t], { hunks: added }).header).toEqual([
			{ thread: t, reason: "unplaced" },
		]);
	});

	it("a thread on another path is ignored", () => {
		const t = thread({ side: "RIGHT", line: 11 }, { path: "src/b.ts" });
		expect(everywhere(place([t]))).toEqual([]);
	});

	it("a range that starts in a gap and ends in a hunk: the bubble on its end, only shown lines covered", () => {
		const t = thread({ side: "RIGHT", startLine: 5, line: 9 });
		const p = place([t]);
		expect([...p.end.keys()]).toEqual(["RIGHT:9"]);
		expect([...p.covered].sort()).toEqual(["RIGHT:8", "RIGHT:9"]);
	});

	it("keeps each thread's anchor as given (LEFT placed by number alone)", () => {
		const t = thread({ side: "LEFT", line: 10 });
		const [placed] = place([t]).end.get("LEFT:10") ?? [];
		expect(placed?.anchor).toBe(t.anchor);
	});
});

describe("the since view: LEFT anchors go through the full diff", () => {
	/**
	 * The full diff (base → head): PS1 inserted 10 lines at the top and
	 * deleted base line 30. Base 20 is head 30; base 30 is gone.
	 */
	const clusters = [
		{
			kind: "lines" as const,
			oldStart: 0,
			oldCount: 0,
			newStart: 1,
			newCount: 10,
		},
		{
			kind: "lines" as const,
			oldStart: 30,
			oldCount: 1,
			newStart: 39,
			newCount: 0,
		},
	];
	const sincePlace = (
		threads: ReviewThread[],
		hunks: FileHunks,
		loadedContext: DiffLine[] = [],
		spans: SpanRange[] = [],
	) =>
		placeThreads({
			threads,
			path: PATH,
			snapshotHead: HEAD,
			hunks,
			loadedContext,
			spans,
			sinceLeft: sinceLeft(clusters, hunks.hunks),
		});
	const whole: FileHunks = { hunks: [], newLineCount: 49, wholeGap: true };

	it("a whole-file gap: a LEFT line the full diff deleted goes to the header, never onto the row with its number", () => {
		const gone = thread({ side: "LEFT", line: 30 });
		const p = sincePlace([gone], whole, [ctx(30, 30), ctx(31, 31)]);
		expect(p.header).toEqual([
			{
				thread: gone,
				reason: "unplaced",
				notHere: { why: "unchanged", side: "LEFT", line: 30 },
			},
		]);
		expect(p.end.size).toBe(0);
		expect(p.gaps.size).toBe(0);
		expect(p.covered.size).toBe(0);
	});

	it("a whole-file gap: a LEFT line that survives lands on the head line it became", () => {
		const kept = thread({ side: "LEFT", startLine: 19, line: 20 });
		const hidden = sincePlace([kept], whole);
		expect([...hidden.gaps]).toEqual([[0, [kept]]]);
		expect(hidden.gapTargets.get(kept)).toEqual({
			show: [29, 30],
			key: "RIGHT:30",
		});
		// Loaded, it is head line 30's row (base 20), never old-number 20's.
		const shown = sincePlace([kept], whole, [
			ctx(20, 20),
			ctx(29, 29),
			ctx(30, 30),
		]);
		expect([...shown.end]).toEqual([["RIGHT:30", [kept]]]);
		expect([...shown.covered].sort()).toEqual(["RIGHT:29", "RIGHT:30"]);
	});

	it("with since hunks: a LEFT line never matches a row by the since view's old numbers", () => {
		// The since view's hunk: H1' 5 (base nothing like it) became head 15.
		const since: FileHunks = {
			hunks: [hunk([ctx(4, 14), del(5), add(15), ctx(6, 16)])],
			newLineCount: 49,
		};
		const t = thread({ side: "LEFT", line: 5 });
		const p = sincePlace([t], since, [ctx(1, 11), ctx(2, 12), ctx(3, 13)]);
		// Base 5 is head 15: the added row, by its new number.
		expect([...p.end]).toEqual([["RIGHT:15", [t]]]);
		expect(p.end.has("LEFT:5")).toBe(false);
	});

	/**
	 * CAR-217: the since view's hunk removes PS1 40 (base 30, the line the
	 * full diff deletes: `baseNo` 30) and PS1 41, a line only PS1 had
	 * (`baseNo` null). PS1 numbers base k as k+10 here.
	 */
	const removedSince: FileHunks = {
		hunks: [
			hunk([
				ctx(39, 38),
				{ ...del(40), baseNo: 30 },
				{ ...del(41), baseNo: null },
				ctx(42, 39),
			]),
		],
		newLineCount: 49,
	};

	it("a LEFT line the full diff deleted lands on the since view's removed row that shows it, by its base number (CAR-217)", () => {
		const t = thread({ side: "LEFT", line: 30 });
		const p = sincePlace([t], removedSince);
		expect([...p.end]).toEqual([["LEFT:40", [t]]]);
		expect(p.header).toEqual([]);
	});

	it("a new thread's LEFT span in base numbers paints the removed row it was written on; a range from it to a head line keeps both sides (CAR-217)", () => {
		const one = {
			startSide: "LEFT",
			startLine: 30,
			side: "LEFT",
			line: 30,
		} as const;
		const p = sincePlace([], removedSince, [], [one]);
		expect([...p.spansShown]).toEqual([0]);
		expect([...p.covered]).toEqual(["LEFT:40"]);
		expect(onSinceRows(one, sinceLeft(clusters, removedSince.hunks))).toEqual({
			...one,
			line: 40,
			startLine: 40,
		});
		// Base 30 to head 39 (base 31): LEFT 40 → RIGHT 39 on the since rows.
		const range = {
			startSide: "LEFT",
			startLine: 30,
			side: "RIGHT",
			line: 39,
		} as const;
		expect(onSinceRows(range, sinceLeft(clusters, removedSince.hunks))).toEqual(
			{
				startSide: "LEFT",
				startLine: 40,
				side: "RIGHT",
				line: 39,
			},
		);
	});

	it("a LEFT line no row shows (deleted in the full diff, not removed since) goes to the header, never to a row only PS1 had (CAR-217)", () => {
		// Base 41 is in neither: the row PS1 41 (only PS1's) is never it.
		const fullGone = [
			...clusters,
			{
				kind: "lines" as const,
				oldStart: 41,
				oldCount: 1,
				newStart: 49,
				newCount: 0,
			},
		];
		const t = thread({ side: "LEFT", line: 41 });
		const p = placeThreads({
			threads: [t],
			path: PATH,
			snapshotHead: HEAD,
			hunks: removedSince,
			loadedContext: [],
			sinceLeft: sinceLeft(fullGone, removedSince.hunks),
		});
		expect(p.header).toEqual([
			{
				thread: t,
				reason: "unplaced",
				notHere: { why: "deleted-before", side: "LEFT", line: 41 },
			},
		]);
		expect(p.end.size).toBe(0);
	});

	it("says why a LEFT line has no row: deleted before the compared patch set, the file unchanged since, or unknown when a removed row's base line isn't (CAR-255)", () => {
		const fullGone = [
			...clusters,
			{
				kind: "lines" as const,
				oldStart: 41,
				oldCount: 1,
				newStart: 49,
				newCount: 0,
			},
		];
		const why = (hunks: FileHunks) => {
			const t = thread({ side: "LEFT", startLine: 40, line: 41 });
			const p = placeThreads({
				threads: [t],
				path: PATH,
				snapshotHead: HEAD,
				hunks,
				loadedContext: [],
				sinceLeft: sinceLeft(fullGone, hunks.hunks),
			});
			expect(p.end.size).toBe(0);
			expect(p.header.map((h) => h.reason)).toEqual(["unplaced"]);
			return p.header[0]?.notHere;
		};
		// Every removed row is a known base line (or none), and none is 41.
		expect(why(removedSince)).toEqual({
			why: "deleted-before",
			side: "LEFT",
			line: 41,
		});
		// The interdiff doesn't touch the file.
		expect(why(whole)?.why).toBe("unchanged");
		// A removed row whose base line isn't known could be it: never
		// claimed deleted before.
		const unmapped: FileHunks = {
			hunks: [hunk([ctx(39, 38), del(40), ctx(41, 39)])],
			newLineCount: 49,
		};
		expect(why(unmapped)?.why).toBe("unknown");
	});

	it("a LEFT line no row shows waits for the hunks before it goes to the header (which removed rows are base lines isn't known yet) (CAR-255)", () => {
		const t = thread({ side: "LEFT", line: 30 });
		const p = placeThreads({
			threads: [t],
			path: PATH,
			snapshotHead: HEAD,
			hunks: null,
			loadedContext: [],
			sinceLeft: sinceLeft(clusters, null),
		});
		expect(everywhere(p)).toEqual([]);
		// A file with no lines to show (binary): the header, as before.
		const binary = placeThreads({
			threads: [t],
			path: PATH,
			snapshotHead: HEAD,
			hunks: null,
			loadedContext: [],
			noLines: true,
			sinceLeft: sinceLeft(clusters, null),
		});
		expect(binary.header).toEqual([{ thread: t, reason: "unplaced" }]);
	});

	it("twins: a base line the full diff keeps is its head line in the since view too, never a removed twin's row that names it (CAR-139)", () => {
		// Base "}\nb"; PS1 "}\n}\nb"; head "Y\n}\nb". The full diff adds Y
		// on top: base 1 ("}") is head 2. The interdiff removes PS1's *first*
		// "}" (old 1), whose base number is 1 too (git aligns the twins
		// otherwise there).
		const twinsFull = [
			{
				kind: "lines" as const,
				oldStart: 0,
				oldCount: 0,
				newStart: 1,
				newCount: 1,
			},
		];
		const twins: FileHunks = {
			hunks: [hunk([{ ...del(1), baseNo: 1 }, add(1), ctx(2, 2), ctx(3, 3)])],
			newLineCount: 3,
		};
		const t = thread({ side: "LEFT", line: 1 });
		const p = placeThreads({
			threads: [t],
			path: PATH,
			snapshotHead: HEAD,
			hunks: twins,
			loadedContext: [],
			sinceLeft: sinceLeft(twinsFull, twins.hunks),
		});
		// Where the full diff shows it (head line 2), not the removed row.
		expect([...p.end]).toEqual([["RIGHT:2", [t]]]);
		expect(p.end.has("LEFT:1")).toBe(false);
	});

	/** CAR-233: PS1 41 is its commit's line 51 (an added line of its diff). */
	const PS1 = "e".repeat(40);
	const earlierSince: FileHunks = {
		...removedSince,
		hunks: removedSince.hunks.map((h) => ({
			...h,
			lines: h.lines.map((l) => (l.oldNo === 41 ? { ...l, psNo: 51 } : l)),
		})),
	};

	it("a span on PS1's commit (a line only PS1 had) paints the removed row that shows it; never without PS1's rows (CAR-233)", () => {
		const one = {
			startSide: "RIGHT",
			startLine: 51,
			side: "RIGHT",
			line: 51,
			earlier: true,
		} as const;
		const p = placeThreads({
			threads: [],
			path: PATH,
			snapshotHead: HEAD,
			hunks: earlierSince,
			loadedContext: [],
			spans: [one],
			sinceLeft: sinceLeft(clusters, earlierSince.hunks),
			sinceEarlier: sinceEarlier(PS1, earlierSince.hunks),
		});
		expect([...p.spansShown]).toEqual([0]);
		expect([...p.covered]).toEqual(["LEFT:41"]);
		// Not the head's RIGHT 51, nor anything without PS1's rows.
		expect(
			onSinceRows(one, sinceLeft(clusters, earlierSince.hunks), undefined),
		).toBeNull();
		expect(onSinceRows(one, undefined, undefined)).toBeNull();
	});

	it("a thread made on PS1's commit on such a line, which the tracer can't place in the head, shows on that removed row (CAR-233)", () => {
		const t = thread({ side: "RIGHT", line: 51, commit: PS1 }, { commit: PS1 });
		const placements: Placements = new Map([
			[
				t.id,
				{
					kind: "unplaced" as const,
					fate: "deleted" as const,
					path: PATH,
					nearest: { side: "RIGHT" as const, line: 39 },
				},
			],
		]);
		const shown = shownThreads([t], HEAD, placements);
		const p = placeThreads({
			threads: shown,
			path: PATH,
			snapshotHead: HEAD,
			hunks: earlierSince,
			loadedContext: [],
			placements,
			sinceLeft: sinceLeft(clusters, earlierSince.hunks),
			sinceEarlier: sinceEarlier(PS1, earlierSince.hunks),
		});
		expect([...p.end.keys()]).toEqual(["LEFT:41"]);
		expect(p.fates).toEqual([]);
		// Another commit's thread on that line number stays a fate.
		const other = thread(
			{ side: "RIGHT", line: 51, commit: "f".repeat(40) },
			{ commit: "f".repeat(40) },
		);
		const otherPlacements: Placements = new Map([
			[
				other.id,
				placements.get(t.id) as NonNullable<ReturnType<Placements["get"]>>,
			],
		]);
		const q = placeThreads({
			threads: shownThreads([other], HEAD, otherPlacements),
			path: PATH,
			snapshotHead: HEAD,
			hunks: earlierSince,
			loadedContext: [],
			placements: otherPlacements,
			sinceLeft: sinceLeft(clusters, earlierSince.hunks),
			sinceEarlier: sinceEarlier(PS1, earlierSince.hunks),
		});
		expect(q.end.size).toBe(0);
		expect(q.fates).toHaveLength(1);
	});

	it("one just posted on PS1's commit, before the tracer has placed it, shows on that removed row in the since view only (CAR-233)", () => {
		const t = thread({ side: "RIGHT", line: 51, commit: PS1 }, { commit: PS1 });
		const empty: Placements = new Map();
		// Not among the shown threads: only a pending one, in the since view.
		expect(shownThreads([t], HEAD, empty)).toEqual([]);
		expect(earlierPending([t], HEAD, empty, undefined)).toEqual([]);
		const pending = earlierPending([t], HEAD, empty, PS1);
		expect(pending).toHaveLength(1);
		expect(earlierPending([t], HEAD, empty, PS1)[0]).toBe(pending[0]);
		const p = placeThreads({
			threads: [],
			path: PATH,
			snapshotHead: HEAD,
			hunks: earlierSince,
			loadedContext: [],
			placements: empty,
			sinceLeft: sinceLeft(clusters, earlierSince.hunks),
			sinceEarlier: sinceEarlier(PS1, earlierSince.hunks),
			earlierPending: pending,
		});
		// LEFT:41, never the head's RIGHT 51.
		expect([...p.end.keys()]).toEqual(["LEFT:41"]);
		expect(p.header).toEqual([]);
	});

	it("pending PS1 threads with no removed row aren't shown, never as unplaced; a LEFT one never reads its PS1-base number in today's base (CAR-233)", () => {
		// RIGHT 30 on PS1: a line the head still has (no psNo row).
		const right = thread(
			{ side: "RIGHT", line: 30, commit: PS1 },
			{ commit: PS1 },
		);
		// LEFT 5 on PS1: PS1's base numbering (the base moved since).
		const left = thread(
			{ side: "LEFT", line: 5, commit: PS1 },
			{ commit: PS1 },
		);
		for (const placements of [new Map() as Placements, null]) {
			const pending = earlierPending([right, left], HEAD, placements, PS1);
			// Only RIGHT threads are pending candidates; the LEFT one waits for
			// the tracer, as before.
			expect(pending.map((t) => t.anchor?.side)).toEqual(["RIGHT"]);
			const shown = shownThreads([right, left], HEAD, placements);
			expect(shown).toEqual([]);
			const p = placeThreads({
				threads: shown,
				path: PATH,
				snapshotHead: HEAD,
				hunks: earlierSince,
				loadedContext: [],
				placements,
				sinceLeft: sinceLeft(clusters, earlierSince.hunks),
				sinceEarlier: sinceEarlier(PS1, earlierSince.hunks),
				earlierPending: pending,
			});
			expect(p.end.size).toBe(0);
			expect(p.header).toEqual([]);
			expect(p.fates).toEqual([]);
			expect(p.covered.size).toBe(0);
		}
	});

	it("outside the since view (no mapper) LEFT stays by number", () => {
		const t = thread({ side: "LEFT", line: 30 });
		const p = place([t], { hunks: whole });
		expect([...p.gaps]).toEqual([[0, [t]]]);
	});
});

describe("shownThreads (no placements: the head's own)", () => {
	it("keeps the head's threads, in order, file comments too", () => {
		const a = thread({ side: "RIGHT", line: 3 });
		const b = thread(null);
		const other = thread({ commit: "e".repeat(40) });
		const none = thread(null, { commit: "" });
		expect(shownThreads([a, other, b, none], HEAD, null)).toEqual([a, b]);
		expect(shownThreads([none], "", null)).toEqual([]);
	});
});

describe("placements", () => {
	const OLD = "e".repeat(40);
	const ref = (line: number, path = PATH) => ({
		path,
		startSide: "RIGHT" as const,
		startLine: line,
		side: "RIGHT" as const,
		line,
	});

	it("placed: a thread from an earlier commit shows on its traced line, on the viewed head, its code its own", () => {
		const t = thread(
			{ side: "RIGHT", line: 3, commit: OLD, startCol: 1, endCol: 4 },
			{ commit: OLD },
		);
		const placements: Placements = new Map([
			[t.id, { kind: "placed", anchor: ref(11), changed: false }],
		]);
		const [shown] = shownThreads([t], HEAD, placements);
		expect(shown).toMatchObject({
			id: t.id,
			path: PATH,
			commit: HEAD,
			anchor: { line: 11, startLine: 11, commit: HEAD, startCol: 1, endCol: 4 },
			code: t.code,
		});
		// The same copy each time (stable identities for the page).
		expect(shownThread(t, HEAD, placements)).toBe(shown);
		const p = placeThreads({
			threads: shownThreads([t], HEAD, placements),
			path: PATH,
			snapshotHead: HEAD,
			hunks: HUNKS,
			loadedContext: [],
			placements,
		});
		expect(p.end.get("RIGHT:11")?.map((x) => x.id)).toEqual([t.id]);
		expect(p.fates).toEqual([]);
	});

	it("placed and resolved: it keeps carrying to its traced line on a later head (owner, 2026-11-09)", () => {
		const t = thread(
			{ side: "RIGHT", line: 3, commit: OLD },
			{ commit: OLD, resolved: true },
		);
		const placements: Placements = new Map([
			[t.id, { kind: "placed", anchor: ref(11), changed: false }],
		]);
		const p = placeThreads({
			threads: shownThreads([t], HEAD, placements),
			path: PATH,
			snapshotHead: HEAD,
			hunks: HUNKS,
			loadedContext: [],
			placements,
		});
		expect(p.end.get("RIGHT:11")?.map((x) => [x.id, x.resolved])).toEqual([
			[t.id, true],
		]);
		expect(p.fates).toEqual([]);
		expect(p.header).toEqual([]);
	});

	it("changed: on the replacing line, whole lines (its columns no longer hold), in the new path", () => {
		const t = thread(
			{ side: "RIGHT", line: 3, commit: OLD, startCol: 1, endCol: 4 },
			{ commit: OLD },
		);
		const placements: Placements = new Map([
			[
				t.id,
				{
					kind: "changed",
					anchor: ref(10, "src/b.ts"),
					old: { side: "RIGHT", startLine: 3, line: 3, text: ["x"] },
					now: ["y"],
				},
			],
		]);
		expect(shownThread(t, HEAD, placements)).toMatchObject({
			path: "src/b.ts",
			anchor: { path: "src/b.ts", line: 10, startCol: null, endCol: null },
		});
	});

	it("unplaced: listed under its file with its fate, never on a row nor in the header", () => {
		const t = thread({ side: "RIGHT", line: 3, commit: OLD }, { commit: OLD });
		const unplaced = {
			kind: "unplaced" as const,
			fate: "deleted" as const,
			path: PATH,
			nearest: { side: "RIGHT" as const, line: 2 },
		};
		const placements: Placements = new Map([[t.id, unplaced]]);
		const p = placeThreads({
			threads: shownThreads([t], HEAD, placements),
			path: PATH,
			snapshotHead: HEAD,
			hunks: HUNKS,
			loadedContext: [],
			placements,
		});
		expect(p.fates.map((f) => [f.thread.id, f.placement])).toEqual([
			[t.id, unplaced],
		]);
		expect(everywhere(p)).toEqual([]);
		// Its file counts it.
		expect(
			fileThreads(shownThreads([t], HEAD, placements), PATH, HEAD),
		).toHaveLength(1);
	});

	it("outside: in no file, only in the trailing group", () => {
		const t = thread({ side: "RIGHT", line: 3, commit: OLD }, { commit: OLD });
		const placements: Placements = new Map([
			[t.id, { kind: "outside", path: "gone.ts", fate: "file-gone" }],
		]);
		expect(shownThreads([t], HEAD, placements)).toEqual([]);
		expect(outsideThreads([t], placements)).toEqual([
			{ thread: t, placement: placements.get(t.id) },
		]);
	});

	it("a file comment follows its file's new path", () => {
		const t = thread(null, { commit: OLD });
		const placements: Placements = new Map([
			[t.id, { kind: "file", path: "src/b.ts" }],
		]);
		expect(shownThread(t, HEAD, placements)).toMatchObject({
			path: "src/b.ts",
			commit: HEAD,
			anchor: null,
		});
	});

	it("a thread with no placement (resolved, or not in yet) shows only on its own head", () => {
		const here = thread({ side: "RIGHT", line: 3 }, { resolved: true });
		const old = thread(
			{ side: "RIGHT", line: 3, commit: OLD },
			{ commit: OLD },
		);
		expect(shownThreads([here, old], HEAD, new Map())).toEqual([here]);
		expect(outsideThreads([here, old], null)).toEqual([]);
	});
});

describe("fileThreads and threadOrder", () => {
	it("counts a file's threads on the head without its hunks", () => {
		const a = thread({ side: "RIGHT", line: 3 });
		const f = thread(null);
		const other = thread({ side: "RIGHT", line: 3 }, { path: "x.ts" });
		const old = thread({ commit: "e".repeat(40) });
		expect(fileThreads([a, f, other, old], PATH, HEAD)).toEqual([a, f]);
	});

	it("orders file comments first, then by new-side line, LEFT shifted", () => {
		const file = thread(null);
		const left = thread({ side: "LEFT", line: 39 });
		const right = thread({ side: "RIGHT", line: 39 });
		expect(threadOrder(file, HUNKS)).toBe(-1);
		// Old 39 is new 40: after RIGHT 39 once the hunks are in.
		expect(threadOrder(left, HUNKS)).toBe(40);
		expect(threadOrder(right, HUNKS)).toBe(39);
		expect(threadOrder(left, null)).toBe(39);
	});
});

describe("lineKey", () => {
	it("RIGHT names the new number, LEFT the old one", () => {
		expect(lineKey("RIGHT", ctx(40, 45))).toBe("RIGHT:45");
		expect(lineKey("LEFT", ctx(40, 45))).toBe("LEFT:40");
		expect(lineKey("RIGHT", del(3))).toBeNull();
		expect(lineKey("LEFT", add(3))).toBeNull();
	});
});

describe("painting a thread's range and span", () => {
	/** The rows painted, as keys, in the order rows show. */
	const painted = (t: ReviewThread, loadedContext: DiffLine[] = []) => [
		...place([t], { loadedContext }).covered,
	];

	// The owner's rule: the marked lines are exactly the anchor's lines.
	it.each([
		["a context row (RIGHT)", { side: "RIGHT", line: 9 }, ["RIGHT:9"]],
		["an added row", { side: "RIGHT", line: 11 }, ["RIGHT:11"]],
		["a deleted row (LEFT)", { side: "LEFT", line: 10 }, ["LEFT:10"]],
		[
			"added rows",
			{ startSide: "RIGHT", startLine: 10, side: "RIGHT", line: 11 },
			["RIGHT:10", "RIGHT:11"],
		],
		[
			"a deleted row into added ones",
			{ startSide: "LEFT", startLine: 10, side: "RIGHT", line: 11 },
			["LEFT:10", "RIGHT:10", "RIGHT:11"],
		],
		[
			"context into a deletion, by old numbers",
			{ startSide: "LEFT", startLine: 9, side: "LEFT", line: 10 },
			["LEFT:9", "LEFT:10"],
		],
	] as const)("paints exactly %s", (_, anchor, keys) => {
		expect(painted(thread(anchor))).toEqual(keys);
	});

	it("paints expanded context rows exactly", () => {
		const loaded = [20, 21, 22].map((n) => ctx(n - 1, n));
		expect(painted(thread({ startLine: 21, line: 22 }), loaded)).toEqual([
			"RIGHT:21",
			"RIGHT:22",
		]);
	});

	it("paints a span's characters on its rows when its columns fit", () => {
		const one = place([thread({ line: 9, startCol: 2, endCol: 4 })]);
		expect(one.marks.get("RIGHT:9")).toEqual([[2, 4]]);
		// "new 10" / "new 11": from col 4 of the first to col 2 of the last.
		const two = place([
			thread({ startLine: 10, line: 11, startCol: 4, endCol: 2 }),
		]);
		expect(two.marks.get("RIGHT:10")).toEqual([[4, 6]]);
		expect(two.marks.get("RIGHT:11")).toEqual([[0, 2]]);
		expect([...two.marks.keys()]).toEqual([...two.covered]);
	});

	it("falls back to the lines when the columns don't fit the text", () => {
		// "line 9" is 6 long; the code moved on under the comment.
		const p = place([thread({ line: 9, startCol: 2, endCol: 40 })]);
		expect(p.covered).toEqual(new Set(["RIGHT:9"]));
		expect(p.marks.size).toBe(0);
		const empty = place([thread({ line: 9, startCol: 3, endCol: 3 })]);
		expect(empty.marks.size).toBe(0);
		// No columns: the lines alone, as today.
		expect(place([thread({ line: 9 })]).marks.size).toBe(0);
	});

	it("paints a new thread being written like a thread", () => {
		const p = placeThreads({
			threads: [],
			path: PATH,
			snapshotHead: HEAD,
			hunks: HUNKS,
			loadedContext: [],
			spans: [
				{
					startSide: "RIGHT",
					startLine: 12,
					side: "RIGHT",
					line: 13,
					startCol: 0,
					endCol: 4,
				},
			],
		});
		expect(p.covered).toEqual(new Set(["RIGHT:12", "RIGHT:13"]));
		expect(p.marks.get("RIGHT:12")).toEqual([[0, 7]]);
		expect(p.marks.get("RIGHT:13")).toEqual([[0, 4]]);
		expect(p.end.size).toBe(0);
	});
});
