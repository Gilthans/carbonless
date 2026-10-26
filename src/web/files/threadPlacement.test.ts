import { describe, expect, it } from "vitest";
import type {
	CodeAnchor,
	DiffLine,
	DiffSide,
	DisplayHunk,
	FileHunks,
	ReviewThread,
} from "../../shared/types";
import {
	fileThreads,
	type LineKey,
	lineKey,
	placeThreads,
	threadOrder,
	threadsOnHead,
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

describe("threadsOnHead", () => {
	it("keeps the head's threads, in order, file comments too", () => {
		const a = thread({ side: "RIGHT", line: 3 });
		const b = thread(null);
		const other = thread({ commit: "e".repeat(40) });
		const none = thread(null, { commit: "" });
		expect(threadsOnHead([a, other, b, none], HEAD)).toEqual([a, b]);
		expect(threadsOnHead([none], "")).toEqual([]);
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
