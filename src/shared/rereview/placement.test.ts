import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	createLineMapper,
	IDENTITY,
	type MapHunk,
} from "../tracer/lineMapper.js";
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
		return `${p.kind} ${startLine === line ? line : `${startLine}-${line}`}`;
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

	it("a line without a word never follows by likeness", () => {
		const old = ["\tfoo()", "\t}"];
		const now = ["\tbar(1)", "\t\t}"];
		expect(place(rewrite(old, now, [h(1, 2, 1, 2)], at(2)))).toBe("deleted");
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
