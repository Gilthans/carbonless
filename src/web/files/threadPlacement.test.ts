import { describe, expect, it } from "vitest";
import type {
	CodeAnchor,
	DiffLine,
	DiffSide,
	DisplayHunk,
	FileHunks,
	ReviewThread,
} from "../../shared/types";
import { lineKey, placeThreads } from "./threadPlacement";

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
		// Old 39 is new 40: loaded, it is that row.
		const loaded = place([middle], { loadedContext: [ctx(39, 40)] });
		expect([...loaded.end]).toEqual([["LEFT:39", [middle]]]);
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

describe("lineKey", () => {
	it("RIGHT names the new number, LEFT the old one", () => {
		expect(lineKey("RIGHT", ctx(40, 45))).toBe("RIGHT:45");
		expect(lineKey("LEFT", ctx(40, 45))).toBe("LEFT:40");
		expect(lineKey("RIGHT", del(3))).toBeNull();
		expect(lineKey("LEFT", add(3))).toBeNull();
	});
});
