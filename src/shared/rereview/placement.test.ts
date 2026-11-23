import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bestCpuRatio } from "../../../test/cpu";
import {
	type MoveDraw,
	moveDraws,
	moveScenario,
} from "../../../test/move-scenario";
import {
	createLineMapper,
	IDENTITY,
	type MapHunk,
} from "../tracer/lineMapper.js";
import { TUNING } from "../tracer/moved.js";
import type { TraceDiffs } from "../tracer/trace.js";
import type { DiffSide, ThreadAnchorRef } from "../types.js";
import {
	placeThread,
	type ThreadInput,
	type ThreadPlacement,
	validAnchor,
} from "./placement.js";

/*
 * Pure thread placement (C1–C19 of the scenarios doc, the thread rows):
 * each fate, the rename rules (C7, C9), a deleted file (C8), an old-side
 * line traced through the caller's base diff (C12), and stored placements
 * (valid, stale).
 */

const h = (
	oldStart: number,
	oldCount: number,
	newStart: number,
	newCount: number,
): MapHunk => ({ oldStart, oldCount, newStart, newCount });

const lines = (prefix: string, n: number) =>
	Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

/** Diffs with the old head's text for `changed`, 20 lines on each side. */
function diffs(over: Partial<TraceDiffs> = {}, old = lines("old", 20)) {
	return {
		ac: IDENTITY,
		bd: IDENTITY,
		cd: IDENTITY,
		oldLineText: (p: { side: DiffSide; line: number }) =>
			old[p.line - 1] ?? null,
		newLineCount: { LEFT: 20, RIGHT: 20 },
		...over,
	} satisfies TraceDiffs;
}

const at = (line: number, side: DiffSide = "RIGHT", startLine = line) => ({
	side,
	line,
	startSide: side,
	startLine,
});

/** The target's text: "new N" (pairs with the old "old N"). */
const newLines = (pos: { line: number }) => `new ${pos.line}`;

const input = (over: Partial<ThreadInput> = {}): ThreadInput => ({
	id: "T1",
	path: "a.ts",
	anchor: at(5),
	diffs: diffs(),
	newPath: "a.ts",
	inComparison: true,
	newLineText: newLines,
	...over,
});

/** Every file of the target is 20 lines long; "missing.ts" is no file of it. */
const count = (path: string, _side: DiffSide) =>
	path === "missing.ts" ? null : 20;

describe("placeThread", () => {
	it("C1: lines inserted above move it to the new number, unchanged", () => {
		const p = placeThread(
			input({ diffs: diffs({ bd: createLineMapper([h(1, 0, 2, 3)]) }) }),
			count,
		);
		expect(p).toEqual({
			kind: "placed",
			anchor: {
				path: "a.ts",
				startSide: "RIGHT",
				startLine: 8,
				side: "RIGHT",
				line: 8,
			},
			changed: false,
		});
	});

	it("C2: an edited line is changed, on its replacement, with the old text and the new", () => {
		const p = placeThread(
			input({
				diffs: diffs({ bd: createLineMapper([h(5, 1, 5, 1)]) }),
				newLineText: (pos) => `new ${pos.line}`,
			}),
			count,
		);
		expect(p).toEqual({
			kind: "changed",
			anchor: {
				path: "a.ts",
				startSide: "RIGHT",
				startLine: 5,
				side: "RIGHT",
				line: 5,
			},
			old: { side: "RIGHT", startLine: 5, line: 5, text: ["old 5"] },
			now: ["new 5"],
		});
	});

	it("C2: a range's old lines are all kept for the card", () => {
		const p = placeThread(
			input({
				anchor: at(6, "RIGHT", 4),
				diffs: diffs({ bd: createLineMapper([h(4, 3, 4, 2)]) }),
			}),
			count,
		);
		expect(p.kind).toBe("changed");
		if (p.kind !== "changed") return;
		expect(p.old).toEqual({
			side: "RIGHT",
			startLine: 4,
			line: 6,
			text: ["old 4", "old 5", "old 6"],
		});
		expect(p.anchor).toMatchObject({ startLine: 4, line: 5 });
	});

	it("C3: a deleted line is unplaced, deleted, with the nearest line above", () => {
		const p = placeThread(
			input({ diffs: diffs({ bd: createLineMapper([h(5, 2, 4, 0)]) }) }),
			count,
		);
		expect(p).toEqual({
			kind: "unplaced",
			fate: "deleted",
			path: "a.ts",
			nearest: { side: "RIGHT", line: 4 },
		});
	});

	it("C4: a range whose end is gone keeps its surviving lines, changed", () => {
		const p = placeThread(
			input({
				anchor: at(6, "RIGHT", 3),
				diffs: diffs({ bd: createLineMapper([h(5, 2, 4, 0)]) }),
			}),
			count,
		);
		expect(p).toMatchObject({
			kind: "changed",
			anchor: { startLine: 3, line: 4 },
			old: { startLine: 3, line: 6 },
		});
	});

	it("reverted: a line the PR added is gone and the PR no longer changes that place", () => {
		// Its own diff added line 5; the new head removed it again, and the
		// target's own diff has nothing there (the base's lines 4 and 5 meet).
		const p = placeThread(
			input({
				own: createLineMapper([h(4, 0, 5, 1)]),
				diffs: diffs({ bd: createLineMapper([h(5, 1, 4, 0)]) }),
			}),
			count,
		);
		expect(p).toMatchObject({ kind: "unplaced", fate: "reverted" });
	});

	it("deleted, not reverted, when the PR still changes that place", () => {
		const p = placeThread(
			input({
				own: createLineMapper([h(4, 0, 5, 1)]),
				diffs: diffs({
					bd: createLineMapper([h(5, 1, 4, 0)]),
					// The target removes the base's line 5, right below line 4.
					cd: createLineMapper([h(5, 1, 4, 0)]),
				}),
			}),
			count,
		);
		expect(p).toMatchObject({ kind: "unplaced", fate: "deleted" });
	});

	it("deleted, not reverted, for a context line the PR never changed", () => {
		const p = placeThread(
			input({
				own: IDENTITY,
				diffs: diffs({ bd: createLineMapper([h(5, 1, 4, 0)]) }),
			}),
			count,
		);
		expect(p).toMatchObject({ kind: "unplaced", fate: "deleted" });
	});

	it("C5: an old-side line the base changed is base-changed", () => {
		const p = placeThread(
			input({
				anchor: at(5, "LEFT"),
				diffs: diffs({ ac: createLineMapper([h(5, 1, 5, 1)]) }),
			}),
			count,
		);
		expect(p).toEqual({
			kind: "unplaced",
			fate: "base-changed",
			path: "a.ts",
			nearest: { side: "LEFT", line: 4 },
		});
	});

	it("C12: an old-side line traces through the base diff the caller gives (its own head's base)", () => {
		// The caller passes `ac` from the earlier head's base; two lines
		// were inserted above in the new base, and the target deletes it.
		const p = placeThread(
			input({
				anchor: at(5, "LEFT"),
				diffs: diffs({
					ac: createLineMapper([h(1, 0, 2, 2)]),
					cd: createLineMapper([h(7, 1, 6, 0)]),
				}),
			}),
			count,
		);
		expect(p).toMatchObject({
			kind: "placed",
			anchor: { side: "LEFT", line: 7 },
		});
	});

	it("C19: a line past the end of its own file never places: rewritten (untraceable)", () => {
		const p = placeThread(input({ anchor: at(500) }), count);
		expect(p).toEqual({
			kind: "unplaced",
			fate: "rewritten",
			path: "a.ts",
			nearest: null,
		});
	});

	it("C7: a renamed file with the line intact places it on the new path", () => {
		const p = placeThread(input({ newPath: "b.ts" }), count);
		expect(p).toMatchObject({
			kind: "placed",
			anchor: { path: "b.ts", line: 5 },
		});
	});

	it("C9: a renamed file whose line didn't follow is a moved? candidate to the new path", () => {
		const p = placeThread(
			input({
				newPath: "b.ts",
				diffs: diffs({ bd: createLineMapper([h(3, 5, 2, 0)]) }),
			}),
			count,
		);
		expect(p).toEqual({
			kind: "unplaced",
			fate: "moved",
			path: "b.ts",
			nearest: { side: "RIGHT", line: 2 },
			movedTo: "b.ts",
		});
	});

	it("moved only from a rename pair: a deleted line in the same file is deleted", () => {
		const p = placeThread(
			input({ diffs: diffs({ bd: createLineMapper([h(3, 5, 2, 0)]) }) }),
			count,
		);
		expect(p).toMatchObject({ kind: "unplaced", fate: "deleted" });
		expect(p).not.toHaveProperty("movedTo");
	});

	it("C8: a deleted file is file-gone under its header when the comparison deletes it", () => {
		const p = placeThread(
			input({ diffs: null, newPath: null, inComparison: true }),
			count,
		);
		expect(p).toEqual({
			kind: "unplaced",
			fate: "file-gone",
			path: "a.ts",
			nearest: null,
		});
	});

	it("C8: a deleted file not in the comparison is outside, file deleted, by its original path", () => {
		const p = placeThread(
			input({ diffs: null, newPath: null, inComparison: false }),
			count,
		);
		expect(p).toEqual({ kind: "outside", path: "a.ts", fate: "file-gone" });
	});

	it("a file the PR no longer changes is outside, reverted", () => {
		const p = placeThread(input({ inComparison: false }), count);
		expect(p).toEqual({ kind: "outside", path: "a.ts", fate: "reverted" });
	});

	it("a thread with nothing to trace from is never placed: untraced, or GitHub's outdated", () => {
		expect(placeThread(input({ diffs: null }), count)).toEqual({
			kind: "unplaced",
			fate: "untraced",
			path: "a.ts",
			nearest: null,
		});
		expect(
			placeThread(input({ diffs: null, untraced: "outdated" }), count),
		).toMatchObject({ kind: "unplaced", fate: "outdated" });
		expect(
			placeThread(input({ diffs: null, inComparison: false }), count),
		).toEqual({ kind: "outside", path: "a.ts", fate: "untraced" });
		expect(
			placeThread(
				input({ diffs: null, inComparison: false, untraced: "outdated" }),
				count,
			),
		).toEqual({ kind: "outside", path: "a.ts", fate: "outdated" });
	});

	describe("traced from GitHub's line (CAR-116)", () => {
		const github = (over: Partial<ThreadInput> = {}) =>
			input({ source: "github", ...over });

		it("on the same text: placed there, marked as GitHub's", () => {
			expect(placeThread(github(), count)).toEqual({
				kind: "placed",
				anchor: {
					path: "a.ts",
					startSide: "RIGHT",
					startLine: 5,
					side: "RIGHT",
					line: 5,
				},
				changed: false,
				source: "github",
			});
			// Through a rename and lines inserted above.
			expect(
				placeThread(
					github({
						newPath: "b.ts",
						diffs: diffs({ bd: createLineMapper([h(1, 0, 2, 2)]) }),
					}),
					count,
				),
			).toMatchObject({
				kind: "placed",
				anchor: { path: "b.ts", line: 7 },
				source: "github",
			});
		});

		it("its line rewritten or deleted: untraced, never changed or deleted since the review", () => {
			const rewritten = placeThread(
				github({ diffs: diffs({ bd: createLineMapper([h(5, 1, 5, 1)]) }) }),
				count,
			);
			expect(rewritten).toEqual({
				kind: "unplaced",
				fate: "untraced",
				path: "a.ts",
				nearest: { side: "RIGHT", line: 5 },
			});
			const deleted = placeThread(
				github({ diffs: diffs({ bd: createLineMapper([h(5, 1, 4, 0)]) }) }),
				count,
			);
			expect(deleted).toMatchObject({
				kind: "unplaced",
				fate: "untraced",
				path: "a.ts",
				nearest: { side: "RIGHT", line: 4 },
			});
		});

		it("its file out of the comparison: outside, untraced; gone: untraced too", () => {
			expect(placeThread(github({ inComparison: false }), count)).toEqual({
				kind: "outside",
				path: "a.ts",
				fate: "untraced",
			});
			expect(
				placeThread(github({ diffs: null, newPath: null }), count),
			).toMatchObject({ kind: "unplaced", fate: "untraced" });
		});

		it("a file comment stays on its file; a stored placement is the reviewer's, not GitHub's", () => {
			expect(
				placeThread(github({ anchor: null, newPath: "b.ts" }), count),
			).toEqual({ kind: "file", path: "b.ts" });
			const stored: ThreadAnchorRef = {
				path: "a.ts",
				startSide: "RIGHT",
				startLine: 9,
				side: "RIGHT",
				line: 9,
			};
			expect(placeThread(github({ stored }), count)).toEqual({
				kind: "placed",
				anchor: stored,
				changed: false,
			});
		});
	});

	it("C18: a file comment follows its file through a rename", () => {
		expect(
			placeThread(input({ anchor: null, newPath: "b.ts" }), count),
		).toEqual({ kind: "file", path: "b.ts" });
		expect(
			placeThread(input({ anchor: null, newPath: null, diffs: null }), count),
		).toMatchObject({ kind: "unplaced", fate: "file-gone" });
	});

	describe("stored placements", () => {
		const stored: ThreadAnchorRef = {
			path: "c.ts",
			startSide: "RIGHT",
			startLine: 9,
			side: "RIGHT",
			line: 9,
		};

		it("a valid stored anchor overrides the computed placement", () => {
			const p = placeThread(
				input({
					stored,
					diffs: diffs({ bd: createLineMapper([h(5, 2, 4, 0)]) }),
				}),
				count,
			);
			expect(p).toEqual({ kind: "placed", anchor: stored, changed: false });
		});

		it("overrides even outside the comparison (the reviewer put it there)", () => {
			const p = placeThread(
				input({ stored, diffs: null, newPath: null, inComparison: false }),
				count,
			);
			expect(p).toMatchObject({ kind: "placed", anchor: stored });
		});

		it("a stale one (past the end) fails closed to the computed placement", () => {
			const p = placeThread(
				input({ stored: { ...stored, line: 21, startLine: 21 } }),
				count,
			);
			expect(p).toMatchObject({ kind: "placed", anchor: { path: "a.ts" } });
		});

		it("one on a path that is no file of the snapshot is ignored", () => {
			const p = placeThread(
				input({ stored: { ...stored, path: "missing.ts" } }),
				count,
			);
			expect(p).toMatchObject({ kind: "placed", anchor: { path: "a.ts" } });
		});
	});
});

/**
 * A file rewritten between the thread's snapshot and the target: `old` and
 * `now` its lines, `hunks` git's -U0 diff between them.
 */
function rewrite(
	old: string[],
	now: string[],
	hunks: MapHunk[],
	anchor: ThreadInput["anchor"],
): ThreadInput {
	return input({
		anchor,
		diffs: {
			ac: IDENTITY,
			bd: createLineMapper(hunks),
			cd: IDENTITY,
			oldLineText: (p) => old[p.line - 1] ?? null,
			newLineCount: { LEFT: now.length, RIGHT: now.length },
		},
		newLineText: (p) => now[p.line - 1] ?? null,
	});
}

/** Where a placement sits: "changed 4-5", "deleted near 1", .... */
function where(p: ThreadPlacement): string {
	if (p.kind === "changed" || p.kind === "placed") {
		const { startLine, line } = p.anchor;
		const moved = p.kind === "changed" && p.inFileMove ? " moved" : "";
		return `${p.kind} ${startLine === line ? line : `${startLine}-${line}`}${moved}`;
	}
	if (p.kind === "unplaced") {
		return `${p.fate}${p.nearest ? ` near ${p.nearest.line}` : ""}`;
	}
	return p.kind;
}

const place = (t: ThreadInput) => where(placeThread(t, () => 100));

describe("a replaced line follows its likeness (CAR-95)", () => {
	// f() rewritten: its two statements moved into an if, `return b`
	// re-indented, b's call edited.
	const OLD_F = [
		"func f() {",
		"\ta := 1",
		"\tb := compute(a)",
		"\treturn b",
		"}",
	];
	const NEW_F = [
		"func f() {",
		"\tif ready() {",
		'\t\tlog("start")',
		"\t\tb := compute(a, opts)",
		"\t\treturn b",
		"\t}",
		"\treturn 0",
		"}",
	];
	const F_HUNKS = [h(2, 3, 2, 6)];

	it("deleted code with unrelated code added in its place is deleted, never on the new code", () => {
		const old = ["func a() {", "\tx := load()", "\tstore.Save(x)", "}"];
		const now = ["func a() {", '\tstats.Count("calls")', "\treturn", "}"];
		expect(place(rewrite(old, now, [h(2, 2, 2, 2)], at(3)))).toBe(
			"deleted near 1",
		);
	});

	it("a statement edited and moved inside a rewritten block goes to its new line", () => {
		expect(place(rewrite(OLD_F, NEW_F, F_HUNKS, at(3)))).toBe("changed 4");
	});

	it("a re-indented line is the same line", () => {
		expect(place(rewrite(OLD_F, NEW_F, F_HUNKS, at(4)))).toBe("changed 5");
	});

	it("a range maps to its lines' new span", () => {
		expect(place(rewrite(OLD_F, NEW_F, F_HUNKS, at(4, "RIGHT", 3)))).toBe(
			"changed 4-5",
		);
		// The deleted `a := 1` start moves inwards to the next surviving line.
		expect(place(rewrite(OLD_F, NEW_F, F_HUNKS, at(3, "RIGHT", 2)))).toBe(
			"changed 4",
		);
	});

	it("a neighbour inserted above never takes the line", () => {
		const old = [
			"func g() {",
			"\t// sum the items",
			"\tif total > limit {",
			"\t\twarn()",
			"\t}",
		];
		const now = [
			"func g() {",
			"\t// sum the items, skipping empty ones",
			"\titems := nonEmpty(all)",
			"\tif total > limitFor(items) {",
			"\t\twarn()",
			"\t}",
		];
		expect(place(rewrite(old, now, [h(2, 2, 2, 3)], at(3)))).toBe("changed 4");
	});

	it("follows a line into the neighbouring hunk across a `}` git cut at", () => {
		const old = [
			"func h() {",
			"\tif ok {",
			"\t\trun()",
			"\t}",
			"\tnotify(x)",
			"}",
		];
		const now = [
			"func h() {",
			"\tif ok {",
			"\t\tnotify(x, y)",
			"\t\trun()",
			"\t}",
			"}",
		];
		// notify(x) deleted after `}`; notify(x, y) added inside the if.
		const hunks = [h(2, 0, 3, 1), h(5, 1, 5, 0)];
		expect(place(rewrite(old, now, hunks, at(5)))).toBe("changed 3");
	});

	it("two lines merged into one: the line the pairing left alone shares it", () => {
		const old = [
			"\twidth := max(opts.Width, opts.MinWidth)",
			"\tbox := Box{Kind: opts.Kind, Pixels: int64(width * scale)}",
		];
		const now = [
			"\tbox := Box{Kind: opts.Kind, Width: max(opts.Width, opts.MinWidth)}",
		];
		expect(place(rewrite(old, now, [h(1, 2, 1, 1)], at(1)))).toBe("changed 1");
		expect(place(rewrite(old, now, [h(1, 2, 1, 1)], at(2)))).toBe("changed 1");
	});

	it("a line without a word never follows by likeness, nor reads as deleted: rewritten", () => {
		const old = ["\tfoo()", "\t}", ""];
		const now = ["\tbar(1)", "\t\t}", "  "];
		const hunks = [h(1, 3, 1, 3)];
		expect(place(rewrite(old, now, hunks, at(2)))).toBe("rewritten");
		expect(place(rewrite(old, now, hunks, at(3)))).toBe("rewritten");
		// Nothing replacing it at all: deleted.
		expect(place(rewrite(old, ["\tbar(1)"], [h(2, 2, 1, 0)], at(2)))).toBe(
			"deleted near 1",
		);
	});

	it("never joins hunks across a line opening a block: a generic line stays out of the next function", () => {
		// A's early `return nil` gave way to logIt(); B's do() became
		// `return nil`. Between the two hunks: `}`, `}`, blank, `func B() {`.
		const old = [
			"func A() {",
			"\tif x {",
			"\t\treturn nil",
			"\t}",
			"}",
			"",
			"func B() {",
			"\tdo()",
			"}",
		];
		const now = [
			"func A() {",
			"\tif x {",
			"\t\tlogIt()",
			"\t}",
			"}",
			"",
			"func B() {",
			"\treturn nil",
			"}",
		];
		const hunks = [h(3, 1, 3, 1), h(8, 1, 8, 1)];
		// `return nil` is among the added lines as it was: rewritten, never
		// deleted (fix round 2).
		expect(place(rewrite(old, now, hunks, at(3)))).toBe("rewritten near 2");
		// One word line that opens nothing still joins (a kept call).
		const kept = [...old.slice(0, 6), "\tkeep()", ...old.slice(7)];
		const keptNow = [...now.slice(0, 6), "\tkeep()", ...now.slice(7)];
		expect(place(rewrite(kept, keptNow, hunks, at(3)))).toBe("changed 8");
	});

	it("a joined region with two lines as like it as its partner: rewritten, never a pick", () => {
		const old = ["\tlogIt()", "\treturn nil", "\t}", "\tfinish()"];
		const now = [
			"\tlogIt()",
			"\tlogAgain()",
			"\t}",
			"\treturn nil",
			"\treturn nil",
		];
		// Old 2 deleted (its hunk adds logAgain()); two `return nil` added
		// past the `}`.
		const hunks = [h(2, 1, 2, 1), h(4, 1, 4, 2)];
		expect(place(rewrite(old, now, hunks, at(2)))).toBe("rewritten near 1");
	});

	it("a pure deletion next to a region too large to pair is rewritten, not deleted", () => {
		const big = Array.from({ length: 60 }, (_, i) => `value ${i}`);
		const old = ["\tgone()", "\t}", ...big];
		const now = ["\t}", ...big.map((t) => `${t} changed`)];
		const hunks = [h(1, 1, 0, 0), h(3, 60, 2, 60)];
		expect(place(rewrite(old, now, hunks, at(1)))).toBe("rewritten");
	});

	it("a hunk too large to pair is rewritten, never guessed", () => {
		const old = Array.from({ length: 60 }, (_, i) => `value ${i}`);
		const now = old.map((t) => `${t} changed`);
		const p = placeThread(
			rewrite(old, now, [h(1, 60, 1, 60)], at(30)),
			() => 100,
		);
		expect(p).toEqual({
			kind: "unplaced",
			fate: "rewritten",
			path: "a.ts",
			nearest: null,
		});
	});
});

describe("a block moved elsewhere in its file follows it (CAR-95 step 3)", () => {
	// b() moved above a(), unchanged.
	const OLD = [
		"func a() {",
		"\tsetup()",
		"}",
		"",
		"func b() {",
		"\ttotal := sumAll(items, weights)",
		'\treport.Write(total, "weighted sum")',
		"}",
	];
	const NEW = [
		"func b() {",
		"\ttotal := sumAll(items, weights)",
		'\treport.Write(total, "weighted sum")',
		"}",
		"",
		"func a() {",
		"\tsetup()",
		"}",
	];
	const HUNKS = [h(0, 0, 1, 5), h(4, 5, 8, 0)];

	it("a line of a moved block is on its new line, marked moved", () => {
		expect(place(rewrite(OLD, NEW, HUNKS, at(7)))).toBe("changed 3 moved");
		expect(place(rewrite(OLD, NEW, HUNKS, at(7, "RIGHT", 6)))).toBe(
			"changed 2-3 moved",
		);
		const p = placeThread(rewrite(OLD, NEW, HUNKS, at(6)), () => 100);
		expect(p).toMatchObject({
			kind: "changed",
			inFileMove: true,
			old: { text: ["\ttotal := sumAll(items, weights)"] },
			now: ["\ttotal := sumAll(items, weights)"],
		});
	});

	it("an identical block added twice is ambiguous: rewritten, never a pick", () => {
		const now = [
			"func x() {",
			"\ttotal := sumAll(items, weights)",
			'\treport.Write(total, "weighted sum")',
			"}",
			"",
			"func y() {",
			"\ttotal := sumAll(items, weights)",
			'\treport.Write(total, "weighted sum")',
			"}",
			"",
			"func a() {",
			"\tsetup()",
			"}",
		];
		const hunks = [h(0, 0, 1, 10), h(4, 5, 13, 0)];
		expect(place(rewrite(OLD, now, hunks, at(7)))).toBe("rewritten near 13");
	});

	it("an identical block removed twice and added once is ambiguous too", () => {
		const old = [
			"func b() {",
			"\ttotal := sumAll(items, weights)",
			'\treport.Write(total, "weighted sum")',
			"}",
			"func c() {",
			"\ttotal := sumAll(items, weights)",
			'\treport.Write(total, "weighted sum")',
			"}",
			"func a() {",
			"\tsetup()",
			"}",
		];
		const now = [
			"func a() {",
			"\tsetup()",
			"}",
			"func d() {",
			"\ttotal := sumAll(items, weights)",
			'\treport.Write(total, "weighted sum")',
			"}",
		];
		const hunks = [h(1, 8, 0, 0), h(11, 0, 4, 4)];
		expect(place(rewrite(old, now, hunks, at(3)))).toBe("rewritten");
	});

	it("a short generic line found elsewhere alone never moves: rewritten (its text is there), never moved", () => {
		const old = [
			"func a() {",
			"\tif x {",
			"\t\treturn nil",
			"\t}",
			"}",
			"func m() {",
			"\tkeep()",
			"}",
		];
		const now = [
			"func a() {",
			"}",
			"func m() {",
			"\tkeep()",
			"}",
			"func z() {",
			"\treturn nil",
			"}",
		];
		const hunks = [h(2, 3, 1, 0), h(8, 0, 6, 3)];
		expect(place(rewrite(old, now, hunks, at(3)))).toBe("rewritten near 1");
	});

	it("an opener whose whole body moved into another block goes to the body", () => {
		const old = [
			"package x",
			"",
			"const (",
			"\tlimit = 1",
			")",
			"",
			"const (",
			'\txmlResponseExt = ".xml"',
			'\tzipResponseExt = ".zip"',
			")",
		];
		const now = [
			"package x",
			"",
			"const (",
			"\tlimit = 1",
			"",
			'\txmlResponseExt = ".xml"',
			'\tzipResponseExt = ".zip"',
			")",
		];
		const hunks = [h(4, 0, 5, 3), h(6, 5, 8, 0)];
		expect(place(rewrite(old, now, hunks, at(7)))).toBe("changed 6 moved");
		// A body line itself: its partner in the region joined across `)`.
		expect(place(rewrite(old, now, hunks, at(9)))).toBe("changed 7");
	});

	it("an edited block wins over a twin of the line alone", () => {
		const old = [
			"class A:",
			"    name: str",
			"    # None makes the mock answer like an old agent.",
			"    fingerprint: str | None = None",
			"",
			"class B:",
			"    size: int",
		];
		const now = [
			"class A:",
			"    name: str",
			"",
			"class B:",
			"    size: int",
			"    # None answers like an old agent.",
			"    fingerprint: str | None = None",
			"",
			"class C:",
			"    fingerprint: str | None = None",
		];
		const hunks = [h(3, 2, 2, 0), h(7, 0, 6, 5)];
		expect(place(rewrite(old, now, hunks, at(4)))).toBe("changed 7 moved");
	});

	it("one end moved and the other not: the range follows its larger part", () => {
		const old = [
			"func a() {",
			"\tsetup()",
			"\ttotal := sumAll(items, weights)",
			'\treport.Write(total, "weighted sum")',
			"}",
			"",
			"func c() {",
			"\tone()",
			"\ttwo()",
			"\tthree()",
			"}",
		];
		const now = [
			"func a() {",
			"\tsetup(opts)",
			"}",
			"",
			"func c() {",
			"\tone()",
			"\ttwo()",
			"\tthree()",
			"}",
			"",
			"func z() {",
			"\ttotal := sumAll(items, weights)",
			'\treport.Write(total, "weighted sum")',
			"}",
		];
		const hunks = [h(2, 3, 2, 1), h(11, 0, 10, 5)];
		expect(place(rewrite(old, now, hunks, at(2)))).toBe("changed 2");
		expect(place(rewrite(old, now, hunks, at(4)))).toBe("changed 13 moved");
		// Two of its three statements moved: the range is those (fix round 1).
		expect(place(rewrite(old, now, hunks, at(4, "RIGHT", 2)))).toBe(
			"changed 12-13 moved",
		);
	});

	it("a re-indented block too large to pair keeps its lines (CAR-225)", () => {
		const old = Array.from(
			{ length: 60 },
			(_, i) => `call(value${i}, other${i})`,
		);
		const now = old.map((t) => `\t${t}`);
		expect(place(rewrite(old, now, [h(1, 60, 1, 60)], at(30)))).toBe(
			"changed 30",
		);
	});
});

/**
 * A diff's -U0 hunks by the longest common subsequence of whole lines (a
 * stand-in for git's, for fixtures too long to write the hunks of by hand).
 */
function lcsHunks(old: readonly string[], now: readonly string[]): MapHunk[] {
	const n = old.length;
	const m = now.length;
	const best = Array.from({ length: n + 1 }, () =>
		new Array<number>(m + 1).fill(0),
	);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			const row = best[i] as number[];
			row[j] =
				old[i] === now[j]
					? ((best[i + 1] as number[])[j + 1] as number) + 1
					: Math.max(
							(best[i + 1] as number[])[j] as number,
							row[j + 1] as number,
						);
		}
	}
	const hunks: MapHunk[] = [];
	let i = 0;
	let j = 0;
	let from: [number, number] | null = null;
	const close = () => {
		if (!from) return;
		const [oi, oj] = from;
		const oldCount = i - oi;
		const newCount = j - oj;
		hunks.push({
			oldStart: oldCount > 0 ? oi + 1 : oi,
			oldCount,
			newStart: newCount > 0 ? oj + 1 : oj,
			newCount,
		});
		from = null;
	};
	while (i < n || j < m) {
		if (i < n && j < m && old[i] === now[j]) {
			close();
			i++;
			j++;
		} else {
			from ??= [i, j];
			const down = i < n ? ((best[i + 1] as number[])[j] as number) : -1;
			const right = j < m ? ((best[i] as number[])[j + 1] as number) : -1;
			if (down >= right) i++;
			else j++;
		}
	}
	close();
	return hunks;
}

/** Where a thread on `old`'s lines lands in `now`, with lcsHunks' diff. */
const placeIn = (
	old: string[],
	now: string[],
	line: number,
	startLine = line,
) => place(rewrite(old, now, lcsHunks(old, now), at(line, "RIGHT", startLine)));

describe("a line edited in place keeps its partner, whatever looks like it elsewhere (CAR-95 step 3, fix round 1)", () => {
	it("an assertion edited in place, its old text in a new test elsewhere", () => {
		const old = [
			"func TestA(t *testing.T) {",
			"\tgot := parse(input)",
			"\tassert.Equal(t, expected, actual)",
			"\tcleanup()",
			"}",
			"",
			"func TestM(t *testing.T) {",
			"\tmiddle()",
			"}",
		];
		const now = [
			"func TestA(t *testing.T) {",
			"\tgot := parse(input)",
			'\tassert.Equal(t, expected, actual, "parsed")',
			"\tcleanup()",
			"}",
			"",
			"func TestM(t *testing.T) {",
			"\tmiddle()",
			"}",
			"",
			"func TestB(t *testing.T) {",
			"\tother := build(x)",
			"\tassert.Equal(t, expected, actual)",
			"}",
		];
		expect(placeIn(old, now, 3)).toBe("changed 3");
	});

	it("a Python assertion, and a version bumped in YAML with the old one in a new section", () => {
		const py = [
			"def test_a():",
			"    resp = client.get(url)",
			"    self.assertEqual(response.status_code, 200)",
			"    done()",
			"",
			"def test_m():",
			"    pass",
		];
		const pyNow = [
			...py.slice(0, 2),
			"    self.assertEqual(response.status_code, 201)",
			...py.slice(3),
			"",
			"def test_b():",
			"    other()",
			"    self.assertEqual(response.status_code, 200)",
		];
		expect(placeIn(py, pyNow, 3)).toBe("changed 3");
		const yaml = [
			"staging:",
			"  image: registry.example.com/app:1.2.3",
			"  replicas: 2",
			"production:",
			"  image: registry.example.com/app:1.2.0",
			"  replicas: 5",
		];
		const yamlNow = [
			"staging:",
			"  image: registry.example.com/app:1.2.4",
			...yaml.slice(2),
			"canary:",
			"  image: registry.example.com/app:1.2.3",
			"  replicas: 1",
		];
		expect(placeIn(yaml, yamlNow, 2)).toBe("changed 2");
	});

	it("`return nil` edited in place while forty new functions each add one", () => {
		const fn = (i: number) => [
			`func gen${i}(x int) error {`,
			`\tif x > ${i} {`,
			"\t\treturn nil",
			"\t}",
			`\treturn fail${i}(x)`,
			"}",
		];
		const old = [
			"func keep(a int) error {",
			"\tif a > 0 {",
			"\t\treturn nil",
			"\t}",
			"\treturn bad(a)",
			"}",
		];
		const now = [
			...old.slice(0, 2),
			"\t\treturn nil, nil",
			...old.slice(3),
			...Array.from({ length: 40 }, (_, i) => fn(i)).flat(),
		];
		expect(placeIn(old, now, 3)).toBe("changed 3");
	});

	it("copy a function, then edit the original: the edit keeps the thread", () => {
		const old = [
			"func handleA(w http.ResponseWriter, r *http.Request) {",
			"\tuser := auth.Current(r)",
			"\titems := store.List(user.ID, 50)",
			"\trender(w, items)",
			"}",
			"",
			"func other() {",
			"\tkeep()",
			"}",
		];
		const now = [
			...old.slice(0, 2),
			"\titems := store.List(user.ID, limit)",
			...old.slice(3),
			"",
			"func handleB(w http.ResponseWriter, r *http.Request) {",
			"\tuser := auth.Current(r)",
			"\titems := store.List(user.OrgID, 50)",
			"\trender(w, items)",
			"}",
		];
		expect(placeIn(old, now, 3)).toBe("changed 3");
	});
});

describe("a deleted line never moves on one line alone (CAR-95 step 3, fix round 1)", () => {
	it("a deleted test's boilerplate line, found in a new test elsewhere, never moves: rewritten (its copy is there)", () => {
		const old = [
			"func TestA(t *testing.T) {",
			"\tctx := context.Background()",
			"\tgot, err := doA(ctx)",
			"\trequire.NoError(t, err)",
			"\tassert.Len(t, got, 3)",
			"}",
			"",
			"func TestM(t *testing.T) {",
			"\tmiddle()",
			"}",
		];
		const now = [
			"func TestM(t *testing.T) {",
			"\tmiddle()",
			"}",
			"",
			"func TestZ(t *testing.T) {",
			"\tctx := context.Background()",
			"\tsrv := startServer(ctx)",
			"\trequire.NoError(t, err)",
			"}",
		];
		expect(placeIn(old, now, 2)).toBe("rewritten");
	});

	it("a switch arm removed, another arm with the same one-line body added: the case line is deleted", () => {
		const old = [
			"switch kind {",
			'case "png":',
			"\treturn renderImage(ctx, req, opts)",
			'case "svg":',
			"\treturn renderVector(ctx, req)",
			"}",
		];
		const now = [
			"switch kind {",
			'case "svg":',
			"\treturn renderVector(ctx, req)",
			'case "jpeg", "webp":',
			"\treturn renderImage(ctx, req, opts)",
			"}",
		];
		expect(placeIn(old, now, 2)).toMatch(/^deleted/);
	});
});

describe("fix round 2 (CAR-95 step 3)", () => {
	it("copy a function, edit the original and delete a neighbour: the edit keeps the thread", () => {
		const old = [
			"func handleA(w http.ResponseWriter, r *http.Request) {",
			"\tuser := auth.Current(r)",
			"\titems := store.List(user.ID, 50)",
			"\trender(w, items)",
			"}",
			"",
			"func other() {",
			"\tkeep()",
			"}",
		];
		const now = [
			"func handleA(w http.ResponseWriter, r *http.Request) {",
			"\titems := store.List(currentID(r), limit)",
			"\trender(w, items)",
			"}",
			"",
			"func other() {",
			"\tkeep()",
			"}",
			"",
			"func handleB(w http.ResponseWriter, r *http.Request) {",
			"\tuser := auth.Current(r)",
			"\titems := store.List(user.OrgID, 50)",
			"\trender(w, items)",
			"}",
		];
		expect(placeIn(old, now, 3)).toBe("changed 2");
	});

	it("a deleted function's two boilerplate lines in unrelated new code never move it", () => {
		const old = [
			"func TestA(t *testing.T) {",
			"\tt.Parallel()",
			"\tctx := context.Background()",
			"\tgot, err := doA(ctx)",
			"\trequire.NoError(t, err)",
			"}",
			"",
			"func TestM(t *testing.T) {",
			"\tmiddle()",
			"}",
		];
		const now = [
			"func TestM(t *testing.T) {",
			"\tmiddle()",
			"}",
			"",
			"func TestZ(t *testing.T) {",
			"\tt.Parallel()",
			"\tctx := context.Background()",
			"\tsrv := startServer(ctx)",
			"\tsrv.Stop()",
			"}",
		];
		expect(placeIn(old, now, 3)).toBe("rewritten");
		expect(placeIn(old, now, 2)).toBe("rewritten");
		const fetch = [
			"func fetchUser(id string) (*User, error) {",
			"\tctx, cancel := context.WithTimeout(ctx, defaultTimeout)",
			"\tdefer cancel()",
			"\treturn users.Get(ctx, id)",
			"}",
			"",
			"func keep() {",
			"\tstay()",
			"}",
		];
		const ping = [
			"func keep() {",
			"\tstay()",
			"}",
			"",
			"func pingAll(hosts []string) error {",
			"\tctx, cancel := context.WithTimeout(ctx, defaultTimeout)",
			"\tdefer cancel()",
			"\tfor _, h := range hosts {",
			"\t\tping(ctx, h)",
			"\t}",
			"\treturn nil",
			"}",
		];
		expect(placeIn(fetch, ping, 2)).toBe("rewritten");
		expect(placeIn(fetch, ping, 3)).toBe("rewritten");
	});

	it("a block that moved whole still takes its threads: most of its hunk went with it", () => {
		const old = [
			"func a() {",
			"\tsetup()",
			"}",
			"",
			"func b() {",
			"\tt.Parallel()",
			"\tctx := context.Background()",
			"}",
		];
		const now = [
			"func b() {",
			"\tt.Parallel()",
			"\tctx := context.Background()",
			"}",
			"",
			"func a() {",
			"\tsetup()",
			"}",
		];
		// b moved above a: old 4-8 removed, new 1-5 added.
		const hunks = [h(0, 0, 1, 5), h(4, 5, 8, 0)];
		expect(place(rewrite(old, now, hunks, at(7)))).toBe("changed 3 moved");
	});

	it("text still among the added lines, with no move decided, is rewritten, never deleted", () => {
		const fn = (i: number) => [
			`func gen${i}() error {`,
			`\terr := step${i}()`,
			"\tif err != nil {",
			"\t\treturn err",
			"\t}",
			"\treturn nil",
			"}",
		];
		const old = [
			"func a() error {",
			"\tif err := loadConfiguration(path); err != nil {",
			"\t\treturn err",
			"\t}",
			"\treturn nil",
			"}",
			"func mid() {}",
		];
		const now = [
			"func a() error {",
			"\treturn nil",
			"}",
			"func mid() {}",
			"func b() error {",
			"\tif err := loadConfiguration(path); err != nil {",
			"\t\treturn err",
			"\t}",
			"\treturn nil",
			"}",
			...Array.from({ length: 40 }, (_, i) => fn(i)).flat(),
		];
		// a's if-block moved into the new b; forty new functions add `return
		// err` too: past the cap of equal lines, no move for that line, but
		// its text is there.
		const hunks = [h(2, 3, 1, 0), h(7, 0, 5, now.length - 4)];
		expect(place(rewrite(old, now, hunks, at(3)))).toMatch(/^rewritten/);
		expect(place(rewrite(old, now, hunks, at(2)))).toBe("changed 6 moved");
		// One import line moved, alone: no block, but not deleted either.
		const imports = [
			'import { zebra } from "./zebra";',
			'import { alpha } from "./alpha";',
			'import { beta } from "./beta";',
		];
		const sorted = [...imports.slice(1), imports[0] as string];
		expect(placeIn(imports, sorted, 1)).toBe("rewritten");
	});

	it("a large table edited row by row keeps each row's thread (each row's own hunk pairs it)", () => {
		const n = 3000;
		const row = (i: number, v: string) =>
			`  "msg_${i}_title": "${v} number ${i} for screen ${i % 17}",`;
		const old = Array.from({ length: n }, (_, i) => row(i, "Title"));
		const now = old.map((t, i) => (i % 3 ? row(i, "Heading") : t));
		const hunks: MapHunk[] = [];
		for (let i = 1; i < n; i += 3) {
			const count = Math.min(2, n - i);
			hunks.push(h(i + 1, count, i + 1, count));
		}
		expect(place(rewrite(old, now, hunks, at(5)))).toBe("changed 5");
		expect(place(rewrite(old, now, hunks, at(302)))).toBe("changed 302");
	});
});

describe("a range split by a move follows its larger part (CAR-95 step 3, fix round 1)", () => {
	const old = [
		"func a() {",
		"\tsetup()",
		"\ttotal := sumAll(items, weights)",
		'\treport.Write(total, "weighted sum")',
		"}",
		"",
		"func c() {",
		"\tone()",
		"}",
	];
	const now = [
		"func a() {",
		"\tsetup()",
		"}",
		"",
		"func c() {",
		"\tone()",
		"}",
		"",
		"func z() {",
		"\ttotal := sumAll(items, weights)",
		'\treport.Write(total, "weighted sum")',
		"}",
	];

	it("more of it moved: the moved lines", () => {
		expect(placeIn(old, now, 4, 2)).toBe("changed 10-11 moved");
	});

	it("more of it stayed: the lines that stayed, with all its old lines kept", () => {
		const p = placeThread(
			rewrite(old, now, lcsHunks(old, now), at(8, "RIGHT", 4)),
			() => 100,
		);
		expect(where(p)).toBe("changed 5-6");
		expect(p).toMatchObject({
			old: { startLine: 4, line: 8 },
			now: ["func c() {", "\tone()"],
		});
	});
});

describe("a partner contested by a look-alike elsewhere (CAR-95 step 3)", () => {
	const OLD = [
		"func TestParsesText(t *testing.T) {",
		"\tt.Parallel()",
		'\tassert.Equal(t, parse("plain words here"), want)',
		"}",
	];

	it("the look-alike whose surroundings match wins", () => {
		const now = [
			"func TestRejectsBadInput(t *testing.T) {",
			"\tt.Parallel()",
			'\tassert.Error(t, check("<not xml>"))',
			"}",
			"",
			"func TestParsesPlainText(t *testing.T) {",
			"\tt.Parallel()",
			'\tassert.Equal(t, parse("plain words here"), want)',
			"}",
		];
		// git kept old 2-4 as new 7-9: old 1 is replaced by new 1-6.
		expect(place(rewrite(OLD, now, [h(1, 1, 1, 6)], at(1)))).toBe("changed 6");
	});

	it("as alike, surroundings as alike: rewritten, never a pick", () => {
		const now = [
			"func TestRejectsBadInput(t *testing.T) {",
			"\tt.Parallel()",
			'\tassert.Equal(t, parse("plain words here"), want)',
			"}",
			"",
			"func TestParsesPlainText(t *testing.T) {",
			"\tt.Parallel()",
			'\tassert.Equal(t, parse("plain words here"), want)',
			"}",
		];
		expect(place(rewrite(OLD, now, [h(1, 1, 1, 6)], at(1)))).toBe("rewritten");
	});

	it("a partner nearby with a look-alike in a far hunk, neither clearer: rewritten", () => {
		const old = [
			"func load() {",
			"\tcached, err := cache.Touch(ctx, key, ext)",
			"\tif err != nil && cached != nil {",
			'\t\tlog("serving the cached report anyway", err)',
			"\t\treturn cached, nil",
			"\t}",
			"\tone()",
			"\ttwo()",
			"\tthree()",
			"\tfour()",
			"\tfive()",
			"\tsix()",
			"\treturn cached, err",
			"}",
		];
		const now = [
			"func load() {",
			"\tcached, err := cache.Get(ctx, key, ext)",
			"\tif cached == nil {",
			"\t\terr = errMissing",
			"\t}",
			"\tone()",
			"\ttwo()",
			"\tthree()",
			"\tfour()",
			"\tfive()",
			"\tsix()",
			"\tif err = cache.Touch(ctx, key, ext); err != nil {",
			'\t\tlog("serving the cached report anyway", err)',
			"\t}",
			"\treturn cached, nil",
			"}",
		];
		// Old 2-5 replaced by new 2-4; old 13 by new 12-15, past six().
		const hunks = [h(2, 4, 2, 3), h(13, 1, 12, 4)];
		expect(place(rewrite(old, now, hunks, at(2)))).toBe("rewritten near 1");
	});
});

describe("a range whose statements are all gone (CAR-95 step 3)", () => {
	it("doesn't live on in a `}` that stayed", () => {
		const old = [
			"func f() {",
			"\tfor _, c := range kids {",
			"\t\twalk(c)",
			"\t}",
			"\treturn out",
			"}",
		];
		const now = [
			"func f() {",
			"\tif len(stack) == 0 {",
			"\t\tfail()",
			"\t}",
			"\treturn out",
			"}",
		];
		expect(place(rewrite(old, now, [h(2, 2, 2, 2)], at(4, "RIGHT", 2)))).toBe(
			"deleted near 1",
		);
		// One statement kept: the range lives on.
		const kept = [...now.slice(0, 2), "\t\twalk(c)", ...now.slice(3)];
		expect(place(rewrite(old, kept, [h(2, 1, 2, 1)], at(4, "RIGHT", 2)))).toBe(
			"changed 3-4",
		);
	});
});

describe("a replaced hunk's CPU (CAR-95)", () => {
	// A 49 x 49 replaced hunk of unrelated lines of ~90 tokens (under every
	// pairing cap): no line has a partner, so every line of a range is
	// looked up, and the share step scores each against the whole hunk.
	const N = 49;
	const lineOf = (prefix: string, seed: number) =>
		`\t${Array.from({ length: 45 }, (_, k) => `${prefix}${(seed * 45 + k * 7) % 211}`).join(" + ")}`;
	const old = Array.from({ length: N }, (_, i) => lineOf("a", i));
	const now = Array.from({ length: N }, (_, i) => lineOf("b", i));
	/** A fresh input (its own mapper: nothing memoized from the last run). */
	const thread = (
		end: number,
		start = end,
		bd = createLineMapper([h(1, N, 1, N)]),
	) =>
		input({
			anchor: at(end, "RIGHT", start),
			diffs: {
				ac: IDENTITY,
				bd,
				cd: IDENTITY,
				oldLineText: (p) => old[p.line - 1] ?? null,
				newLineCount: { LEFT: N, RIGHT: N },
			},
			newLineText: (p) => now[p.line - 1] ?? null,
		});

	it("a range of the whole hunk costs about one line of it, not one per line", () => {
		expect(placeThread(thread(N, 1), () => N).kind).toBe("unplaced");
		const { best, ref, ratio } = bestCpuRatio(
			() => placeThread(thread(N, 1), () => N),
			() => placeThread(thread(25), () => N),
		);
		console.info(
			`range 1-${N}: ${best} µs, ${ratio.toFixed(2)}x one line (${ref} µs)`,
		);
		// Measured 1.4x on the devbox; with no memo per line, both ends
		// walked and each line re-tokenized per score: 24x.
		expect(ratio).toBeLessThan(5);
	});

	it("threads on one diff share its pairings: eight cost about one", () => {
		const { best, ref, ratio } = bestCpuRatio(
			() => {
				const bd = createLineMapper([h(1, N, 1, N)]);
				for (let i = 0; i < 8; i++)
					placeThread(thread(i * 6 + 1, i * 6 + 1, bd), () => N);
			},
			() => placeThread(thread(25), () => N),
		);
		console.info(
			`8 threads on one hunk: ${best} µs, ${ratio.toFixed(2)}x one (${ref} µs)`,
		);
		// Measured 1.1x; the pairings memoized per thread instead: 8.9x.
		expect(ratio).toBeLessThan(3);
	});
});

/** A random edit of `lines`: the new file and git's -U0 hunks. */
function edit(
	lines: readonly string[],
	steps: readonly { gap: number; remove: number; insert: string[] }[],
): { now: string[]; hunks: MapHunk[] } {
	const now: string[] = [];
	const hunks: MapHunk[] = [];
	let pos = 0;
	for (const step of steps) {
		const gap = Math.min(step.gap, lines.length - pos);
		now.push(...lines.slice(pos, pos + gap));
		pos += gap;
		const remove = Math.min(step.remove, lines.length - pos);
		if (remove + step.insert.length === 0) continue;
		hunks.push({
			oldStart: remove > 0 ? pos + 1 : pos,
			oldCount: remove,
			newStart: step.insert.length > 0 ? now.length + 1 : now.length,
			newCount: step.insert.length,
		});
		pos += remove;
		now.push(...step.insert);
	}
	now.push(...lines.slice(pos));
	return { now, hunks };
}

describe("the move search's CPU over a whole file (CAR-95 step 3)", () => {
	const BLOCK = [
		"\ttotal := sumAll(items, weights)",
		'\treport.Write(total, "weighted sum")',
		"\treturn total",
	];
	/**
	 * A file of `n` lines with every other one rewritten (one hunk each,
	 * joined into one region too large to pair) and BLOCK moved from its top
	 * to its end: a thread on BLOCK's middle line is found by the move
	 * search over every changed line. Every line shares words with the
	 * others, so the look-alike index has work too.
	 */
	function file(n: number) {
		const fill = (i: number, v: string) =>
			`\tcall${i}(items, weights, ${v}${i % 13})`;
		const old = [
			...BLOCK,
			...Array.from({ length: n }, (_, i) => fill(i, "a")),
		];
		const now = [
			...Array.from({ length: n }, (_, i) => fill(i, i % 2 ? "b" : "a")),
			...BLOCK,
		];
		const hunks = [h(1, BLOCK.length, 0, 0)];
		for (let i = 1; i < n; i += 2) {
			hunks.push(h(BLOCK.length + i + 1, 1, i + 1, 1));
		}
		hunks.push(h(old.length, 0, n + 1, BLOCK.length));
		return { old, now, hunks };
	}
	/**
	 * Threads on `lines` on a fresh mapper (nothing memoized from the last
	 * run), every thread of the file reading through the same two readers,
	 * as the server's do (threads.ts).
	 */
	const placeAll =
		(f: { old: string[]; now: string[]; hunks: MapHunk[] }, lines: number[]) =>
		() => {
			const bd = createLineMapper(f.hunks);
			const oldLineText = (p: { line: number }) => f.old[p.line - 1] ?? null;
			const newLineText = (p: { line: number }) => f.now[p.line - 1] ?? null;
			for (const line of lines) {
				placeThread(
					input({
						anchor: at(line),
						diffs: {
							ac: IDENTITY,
							bd,
							cd: IDENTITY,
							oldLineText,
							newLineCount: { LEFT: f.now.length, RIGHT: f.now.length },
						},
						newLineText,
					}),
					() => f.now.length,
				);
			}
		};
	/**
	 * Two threads: one on BLOCK, one on a rewritten line whose partner every
	 * other added line half resembles (the look-alike check).
	 */
	const placeIn = (f: ReturnType<typeof file>) =>
		placeAll(f, [2, BLOCK.length + 2]);

	it("finds the block", () => {
		const f = file(40);
		expect(place(rewrite(f.old, f.now, f.hunks, at(2)))).toBe(
			"changed 42 moved",
		);
	});

	it("a file four times as large costs about four of the quarter, not sixteen", () => {
		const big = file(1600);
		const small = file(400);
		const { best, ref, ratio } = bestCpuRatio(placeIn(big), () => {
			for (let i = 0; i < 4; i++) placeIn(small)();
		});
		console.info(
			`move search, 1600 lines: ${best} µs, ${ratio.toFixed(2)}x four of 400 (${ref} µs)`,
		);
		expect(ratio).toBeLessThan(2);
	});

	it("threads growing with the file: four times the lines and threads cost about four of the quarter", () => {
		// One thread every 10 lines, on rewritten lines and the block: a
		// lookup that scanned the file per thread would cost 16x here.
		const threadsOf = (f: ReturnType<typeof file>) => [
			2,
			...Array.from(
				{ length: Math.floor(f.old.length / 10) },
				(_, i) => BLOCK.length + 2 + i * 10,
			),
		];
		const big = file(1600);
		const small = file(400);
		const { best, ref, ratio } = bestCpuRatio(
			placeAll(big, threadsOf(big)),
			() => {
				for (let i = 0; i < 4; i++) placeAll(small, threadsOf(small))();
			},
		);
		console.info(
			`${threadsOf(big).length} threads on 1600 lines: ${best} µs, ${ratio.toFixed(2)}x four of 400 (${ref} µs)`,
		);
		expect(ratio).toBeLessThan(2);
	});

	it("a block among near-copies: four times the block costs about four of the quarter", () => {
		// A block of alike statements removed; eight near-copies of it added
		// (each line alike, not equal), one line of each equal: every equal
		// line's run meets look-alikes all the way (CAR-95 review, S3).
		const nearCopies = (length: number) => {
			const row = (i: number, v: string) =>
				`\tresult${i} := transform(input${i}, config.${v}Option, registry.lookup("key${i}"))`;
			const old = [
				"package x",
				"func f() {",
				...Array.from({ length }, (_, i) => row(i, "alpha")),
				"}",
				"func g() {}",
			];
			const now = ["package x", "func g() {}"];
			for (let c = 0; c < 8; c++) {
				now.push(
					`func f${c}() {`,
					...Array.from({ length }, (_, i) =>
						row(i, i === length / 2 ? "alpha" : `beta${c}`),
					),
					"}",
				);
			}
			return { old, now, hunks: lcsHunks(old, now) };
		};
		const threads = (length: number) => [3, length / 2 + 3, length + 2];
		const big = nearCopies(160);
		const small = nearCopies(40);
		const { best, ref, ratio } = bestCpuRatio(
			placeAll(big, threads(160)),
			() => {
				for (let i = 0; i < 4; i++) placeAll(small, threads(40))();
			},
		);
		console.info(
			`near-copies, block of 160: ${best} µs, ${ratio.toFixed(2)}x four of 40 (${ref} µs)`,
		);
		expect(ratio).toBeLessThan(2);
	});
});

describe("placeThread property (principle 2)", () => {
	const line = fc.constantFrom(
		"a := 1",
		"a := 2",
		"\ta := 1",
		"return a",
		"}",
		"",
		"log(a, b)",
	);
	it("every thread gets exactly one placement, inside the target when on a line", () => {
		fc.assert(
			fc.property(
				fc.array(line, { minLength: 1, maxLength: 15 }),
				fc.array(
					fc.record({
						gap: fc.integer({ min: 0, max: 3 }),
						remove: fc.integer({ min: 0, max: 3 }),
						insert: fc.array(line, { maxLength: 4 }),
					}),
					{ maxLength: 5 },
				),
				(old, steps) => {
					const { now, hunks } = edit(old, steps);
					for (let end = 1; end <= old.length; end++) {
						for (const start of [end, Math.max(1, end - 2)]) {
							const p = placeThread(
								rewrite(old, now, hunks, at(end, "RIGHT", start)),
								() => now.length,
							);
							expect(["placed", "changed", "unplaced"]).toContain(p.kind);
							if (p.kind === "placed" || p.kind === "changed") {
								expect(p.anchor.startLine).toBeGreaterThanOrEqual(1);
								expect(p.anchor.startLine).toBeLessThanOrEqual(p.anchor.line);
								expect(p.anchor.line).toBeLessThanOrEqual(now.length);
							}
							if (p.kind === "unplaced") {
								expect(["deleted", "rewritten", "reverted"]).toContain(p.fate);
							}
						}
					}
				},
			),
		);
	});
});

describe("moves, deletions and look-alikes never put a thread on a wrong line (CAR-95 step 3, property)", () => {
	/** Every thread on a line with a word lands on its true line, or nowhere. */
	function check(o: MoveDraw) {
		const { old, now, hunks, truth } = moveScenario(o);
		for (let line = 1; line <= old.length; line++) {
			if (!/\w/u.test(old[line - 1] ?? "")) continue;
			const p = placeThread(
				rewrite(old, now, hunks, at(line)),
				() => now.length,
			);
			if (p.kind !== "placed" && p.kind !== "changed") continue;
			expect(
				p.anchor.line,
				`old line ${line} (${old[line - 1]?.trim()}) on ${p.anchor.line} "${now[p.anchor.line - 1]?.trim()}"`,
			).toBe(truth.get(line));
		}
	}
	const arb = moveDraws;

	it("with today's tuning", () => {
		fc.assert(fc.property(arb, check), { numRuns: 200 });
	});

	// A constant that only works at one value is a knife-edge: each
	// neighbouring setting must hold too.
	const nudges: Partial<typeof TUNING>[] = [
		{ contextLines: 2 },
		{ contextLines: 4 },
		{ minAlnum: 15 },
		{ minAlnum: 25 },
		{ contextMargin: 0.15 },
		{ contextMargin: 0.35 },
		{ contestMargin: 0.1 },
		{ contestMargin: 0.2 },
	];
	for (const nudge of nudges) {
		it(`with ${JSON.stringify(nudge)}`, () => {
			const saved = { ...TUNING };
			Object.assign(TUNING, nudge);
			try {
				fc.assert(fc.property(arb, check), { numRuns: 100 });
			} finally {
				Object.assign(TUNING, saved);
			}
		});
	}
});

describe("validAnchor", () => {
	const ok: ThreadAnchorRef = {
		path: "a.ts",
		startSide: "RIGHT",
		startLine: 2,
		side: "RIGHT",
		line: 4,
	};
	it("takes a range inside the file", () => {
		expect(validAnchor(ok, count)).toBe(true);
	});
	it.each([
		["a line of 0", { line: 0 }],
		["a fractional line", { line: 2.5 }],
		["a start after the end", { startLine: 5 }],
		["a side that is none", { side: "UP" }],
		["an empty path", { path: "" }],
		["a path that is no file", { path: "missing.ts" }],
		["a line past the end", { line: 21 }],
	])("refuses %s", (_, over) => {
		expect(
			validAnchor({ ...ok, ...over } as unknown as ThreadAnchorRef, count),
		).toBe(false);
	});
});
