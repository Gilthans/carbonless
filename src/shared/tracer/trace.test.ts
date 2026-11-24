// Scenario ids are the C-cases of
// Linear CAR-5's document "Re-review after new pushes: scenarios and prior art".
// Covered elsewhere: C7 (renames) and C9–C12 (other heads, moved code) are
// inputs the server resolves before calling the tracer (PR 3 and PR 5); C14
// (a suggestion applied) is C2; C18 (file-level) has no position to trace;
// C19 (GitHub's own line disagrees) is the real-PR check.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { lineSimilarity } from "../linePairing";
import type { DiffSide } from "../types";
import * as tracer from "./index";
import { createLineMapper, IDENTITY, type MapHunk } from "./lineMapper";
import {
	type Placement,
	type Position,
	SHARE_MIN_SIMILARITY,
	TRACER_VERSION,
	type TraceDiffs,
	tracePosition,
	traceRange,
	traceSpan,
} from "./trace";

const R = (line: number): Position => ({ side: "RIGHT", line });
const L = (line: number): Position => ({ side: "LEFT", line });

/** The new snapshot adds its first 50 lines: every RIGHT line is still added. */
const ALL_ADDED = createLineMapper([
	{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 50 },
]);

/** `texts`: the old snapshot's lines by "SIDE:line"; `now`: the new one's. */
function diffs(
	over: Partial<TraceDiffs> & {
		texts?: Record<string, string>;
		now?: Record<string, string>;
	},
): TraceDiffs {
	const { texts, now, ...rest } = over;
	return {
		ac: IDENTITY,
		bd: IDENTITY,
		cd: ALL_ADDED,
		oldLineText: texts
			? (pos) => texts[`${pos.side}:${pos.line}`] ?? null
			: undefined,
		newLineText: now
			? (pos) => now[`${pos.side}:${pos.line}`] ?? null
			: undefined,
		...rest,
	};
}

/** Lines `from`.. of a side as "SIDE:line" keys, for `texts` and `now`. */
const rows = (from: number, lines: string[], side: DiffSide = "RIGHT") =>
	Object.fromEntries(lines.map((t, i) => [`${side}:${from + i}`, t]));

describe("tracePosition", () => {
	it("exports TRACER_VERSION 4 from the index", () => {
		expect(TRACER_VERSION).toBe(4);
		expect(tracer.TRACER_VERSION).toBe(4);
		expect(tracer.createLineMapper).toBe(createLineMapper);
		expect(tracer.tracePosition).toBe(tracePosition);
	});

	it("C1: lines inserted above the commented line place it on the new number", () => {
		// Three lines inserted after old line 2.
		const bd = createLineMapper([
			{ oldStart: 2, oldCount: 0, newStart: 3, newCount: 3 },
		]);
		expect(tracePosition(R(5), diffs({ bd }))).toStrictEqual({
			kind: "placed",
			side: "RIGHT",
			line: 8,
		});
		// Lines removed above shift the other way.
		const cut = createLineMapper([
			{ oldStart: 1, oldCount: 3, newStart: 0, newCount: 0 },
		]);
		expect(tracePosition(R(5), diffs({ bd: cut }))).toStrictEqual({
			kind: "placed",
			side: "RIGHT",
			line: 2,
		});
	});

	it("C1 (LEFT): the base inserted lines above a deleted line the PR still deletes", () => {
		const ac = createLineMapper([
			{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 4 },
		]);
		// The new snapshot still removes new-base line 14.
		const cd = createLineMapper([
			{ oldStart: 14, oldCount: 1, newStart: 13, newCount: 0 },
		]);
		expect(tracePosition(L(10), diffs({ ac, cd }))).toStrictEqual({
			kind: "placed",
			side: "LEFT",
			line: 14,
		});
	});

	it("a RIGHT line the new snapshot no longer adds is placed as context", () => {
		// bd keeps the line; cd (the new PR's diff) touches nothing around it.
		expect(tracePosition(R(7), diffs({ cd: IDENTITY }))).toStrictEqual({
			kind: "placed",
			side: "RIGHT",
			line: 7,
			became: "context",
		});
	});

	it("a LEFT line the new snapshot no longer removes is placed on the RIGHT as context", () => {
		// The base took the deletion: the new PR adds two lines above instead.
		const cd = createLineMapper([
			{ oldStart: 3, oldCount: 0, newStart: 4, newCount: 2 },
		]);
		expect(tracePosition(L(10), diffs({ cd }))).toStrictEqual({
			kind: "placed",
			side: "RIGHT",
			line: 12,
			became: "context",
		});
	});

	it("C2: an edited line is placed, changed, with the old text", () => {
		const bd = createLineMapper([
			{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 },
		]);
		expect(
			tracePosition(
				R(5),
				diffs({
					bd,
					texts: { "RIGHT:5": "const x = 1;" },
					now: { "RIGHT:5": "const x = 2;" },
				}),
			),
		).toStrictEqual({
			kind: "changed",
			side: "RIGHT",
			line: 5,
			oldText: "const x = 1;",
		});
	});

	it("C2: a replaced line lands on the replacing line that resembles it, not at its offset", () => {
		// Old lines 5-8 became new lines 6-7 (one line inserted above too).
		const bd = createLineMapper([
			{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 },
			{ oldStart: 5, oldCount: 4, newStart: 6, newCount: 2 },
		]);
		const d = diffs({
			bd,
			texts: rows(5, ["let a = 1;", "let b = 2;", "let c = 3;", "log(d);"]),
			now: rows(6, ["let c = 4;", "trace(d, e);"]),
		});
		// Offset 2 of the old hunk is offset 0 of the new one.
		expect(tracePosition(R(7), d)).toStrictEqual({
			kind: "changed",
			side: "RIGHT",
			line: 6,
			oldText: "let c = 3;",
		});
		// Nothing replacing `let b` resembles it: deleted, not on `trace(d, e)`.
		expect(tracePosition(R(6), d)).toStrictEqual({
			kind: "unplaced",
			reason: "deleted",
			nearest: { side: "RIGHT", line: 5 },
		});
	});

	it("C2: a mapper reused with other texts never answers from what it paired before", () => {
		const bd = createLineMapper([
			{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 2 },
		]);
		const texts = { "RIGHT:1": "\tsave(x)" };
		const first = diffs({
			bd,
			texts,
			now: rows(1, ["\tsave(x, y)", "\tother()"]),
		});
		expect(tracePosition(R(1), first)).toMatchObject({ line: 1 });
		const second = diffs({
			bd,
			texts,
			now: rows(1, ["\tother()", "\tsave(x, y)"]),
		});
		expect(tracePosition(R(1), second)).toMatchObject({ line: 2 });
		// And back: the first texts again.
		expect(tracePosition(R(1), first)).toMatchObject({ line: 1 });
	});

	it("C2: without the texts to pair, a replaced line is rewritten, never guessed", () => {
		const bd = createLineMapper([
			{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 },
		]);
		expect(tracePosition(R(5), diffs({ bd }))).toStrictEqual({
			kind: "unplaced",
			reason: "rewritten",
			nearest: { side: "RIGHT", line: 4 },
		});
		// A pure deletion needs no text: nothing replaced it.
		const cut = createLineMapper([
			{ oldStart: 5, oldCount: 1, newStart: 4, newCount: 0 },
		]);
		expect(tracePosition(R(5), diffs({ bd: cut })).kind).toBe("unplaced");
	});

	it("C3: a deleted line is unplaced with the nearest surviving line above", () => {
		// Old lines 5-6 deleted; they sat after new line 4.
		const bd = createLineMapper([
			{ oldStart: 5, oldCount: 2, newStart: 4, newCount: 0 },
		]);
		expect(tracePosition(R(6), diffs({ bd }))).toStrictEqual({
			kind: "unplaced",
			reason: "deleted",
			nearest: { side: "RIGHT", line: 4 },
		});
	});

	it("C3: the nearest line is the mapped image of the last surviving old line", () => {
		// Two lines inserted after old 1, then old 5-6 deleted: old 4 is new 6.
		const bd = createLineMapper([
			{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 2 },
			{ oldStart: 5, oldCount: 2, newStart: 6, newCount: 0 },
		]);
		expect(tracePosition(R(5), diffs({ bd }))).toStrictEqual({
			kind: "unplaced",
			reason: "deleted",
			nearest: { side: "RIGHT", line: 6 },
		});
	});

	it("C3: a deletion at the top of the file has no nearest line", () => {
		const bd = createLineMapper([
			{ oldStart: 1, oldCount: 2, newStart: 0, newCount: 0 },
		]);
		expect(tracePosition(R(1), diffs({ bd }))).toStrictEqual({
			kind: "unplaced",
			reason: "deleted",
			nearest: null,
		});
	});

	it("C5: a LEFT line the base changed is unplaced as base-changed", () => {
		const ac = createLineMapper([
			{ oldStart: 10, oldCount: 1, newStart: 10, newCount: 1 },
		]);
		expect(tracePosition(L(10), diffs({ ac }))).toStrictEqual({
			kind: "unplaced",
			reason: "base-changed",
			nearest: { side: "LEFT", line: 9 },
		});
	});

	it("C5: a LEFT line the base deleted is base-changed, nearest through the base's diff", () => {
		// The base dropped old-base lines 8-10 and gained one line above.
		const ac = createLineMapper([
			{ oldStart: 2, oldCount: 0, newStart: 3, newCount: 1 },
			{ oldStart: 8, oldCount: 3, newStart: 8, newCount: 0 },
		]);
		expect(tracePosition(L(9), diffs({ ac }))).toStrictEqual({
			kind: "unplaced",
			reason: "base-changed",
			nearest: { side: "LEFT", line: 8 },
		});
	});

	it("C6: a context line the base changed (and the head took) is changed", () => {
		// The PR never touched line 12; after the merge-in the head has the
		// base's version: bd shows it edited, cd shows it as context.
		const bd = createLineMapper([
			{ oldStart: 12, oldCount: 1, newStart: 12, newCount: 1 },
		]);
		expect(
			tracePosition(
				R(12),
				diffs({
					bd,
					cd: IDENTITY,
					texts: { "RIGHT:12": "  return a;" },
					now: { "RIGHT:12": "  return a + b;" },
				}),
			),
		).toStrictEqual({
			kind: "changed",
			side: "RIGHT",
			line: 12,
			oldText: "  return a;",
		});
	});

	it("C13: a line changed in one push and changed back in the next is placed", () => {
		// H1 -> H2 edited line 5; H1 -> H3 (the diff the tracer gets) does not.
		const h1ToH2 = createLineMapper([
			{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 },
		]);
		const texts = { "RIGHT:5": "x = 1" };
		expect(
			tracePosition(
				R(5),
				diffs({ bd: h1ToH2, texts, now: { "RIGHT:5": "x = 2" } }),
			).kind,
		).toBe("changed");
		const h1ToH3 = IDENTITY;
		expect(tracePosition(R(5), diffs({ bd: h1ToH3 }))).toStrictEqual({
			kind: "placed",
			side: "RIGHT",
			line: 5,
		});
	});

	it("C15: duplicate lines pair by position: the moved twin is deleted, the other stays", () => {
		// Lines 3 and 9 are identical. The author moved line 9 below old line
		// 12: git's diff removes old 9 (it sat after new 8) and adds new 12.
		const bd = createLineMapper([
			{ oldStart: 9, oldCount: 1, newStart: 8, newCount: 0 },
			{ oldStart: 12, oldCount: 0, newStart: 12, newCount: 1 },
		]);
		const d = diffs({ bd, texts: { "RIGHT:3": "x = 1", "RIGHT:9": "x = 1" } });
		expect(tracePosition(R(3), d)).toStrictEqual({
			kind: "placed",
			side: "RIGHT",
			line: 3,
		});
		// Never placed on the twin at new line 12 by its text.
		expect(tracePosition(R(9), d)).toStrictEqual({
			kind: "unplaced",
			reason: "deleted",
			nearest: { side: "RIGHT", line: 8 },
		});
	});

	it("C16: a whitespace-only edit is changed, with the old text as it was", () => {
		const bd = createLineMapper([
			{ oldStart: 4, oldCount: 1, newStart: 4, newCount: 1 },
		]);
		expect(
			tracePosition(
				R(4),
				diffs({
					bd,
					texts: { "RIGHT:4": "\tfoo( a )" },
					now: { "RIGHT:4": "    foo(a)" },
				}),
			),
		).toStrictEqual({
			kind: "changed",
			side: "RIGHT",
			line: 4,
			oldText: "\tfoo( a )",
		});
	});

	it("Review focus 3: a line past the end of the file, or before line 1, is outside", () => {
		const d = diffs({
			cd: IDENTITY,
			newLineCount: { LEFT: 10, RIGHT: 10 },
		});
		expect(tracePosition(R(12), d)).toStrictEqual({
			kind: "unplaced",
			reason: "outside",
			nearest: null,
		});
		expect(tracePosition(L(11), d)).toStrictEqual({
			kind: "unplaced",
			reason: "outside",
			nearest: null,
		});
		expect(tracePosition(R(10), d).kind).toBe("placed");
		for (const pos of [R(0), L(0), R(-3)]) {
			expect(tracePosition(pos, diffs({}))).toStrictEqual({
				kind: "unplaced",
				reason: "outside",
				nearest: null,
			});
		}
	});

	it("Review focus 3: outside is checked where the line lands, on the side it lands on", () => {
		// The file grew by 5 lines in the head: old line 12 of a 10-line file
		// still lands past the new end (15 + 2).
		const bd = createLineMapper([
			{ oldStart: 10, oldCount: 0, newStart: 11, newCount: 5 },
		]);
		expect(
			tracePosition(
				R(12),
				diffs({ bd, cd: IDENTITY, newLineCount: { LEFT: 15, RIGHT: 15 } }),
			),
		).toStrictEqual({ kind: "unplaced", reason: "outside", nearest: null });
		// A LEFT line that became context lands on the RIGHT: its count applies.
		expect(
			tracePosition(
				L(10),
				diffs({ cd: IDENTITY, newLineCount: { LEFT: 10, RIGHT: 9 } }),
			),
		).toStrictEqual({ kind: "unplaced", reason: "outside", nearest: null });
	});
});

/**
 * A file whose changed lines were edited in place, line for line (old and
 * new the same length): each differing line its own one-line hunk, as
 * `git diff -U0` splits them around the kept lines between.
 */
function inPlace(old: string[], now: string[]): TraceDiffs {
	const hunks: MapHunk[] = [];
	old.forEach((t, i) => {
		if (t !== now[i]) {
			hunks.push({
				oldStart: i + 1,
				oldCount: 1,
				newStart: i + 1,
				newCount: 1,
			});
		}
	});
	return diffs({
		bd: createLineMapper(hunks),
		texts: rows(1, old),
		now: rows(1, now),
	});
}

/** Where old line `n` of the swap's thread lands: its line, or its unplaced reason. */
function landing(d: TraceDiffs, n: number): number | string {
	const p = tracePosition(R(n), d);
	return p.kind === "unplaced" ? p.reason : p.line;
}

describe("tracePosition: look-alike lines swapped around a kept line (CAR-279)", () => {
	it("Markdown items swapped and edited follow their own text across the kept line", () => {
		const d = inPlace(
			[
				"# Steps",
				"",
				"- Run the build script for the web package",
				"Note: kept.",
				"- Run the build script for the server package",
				"",
				"End.",
			],
			[
				"# Steps",
				"",
				"- Run the build script for the server package twice",
				"Note: kept.",
				"- Run the build script for the web package twice",
				"",
				"End.",
			],
		);
		expect(tracePosition(R(3), d)).toStrictEqual({
			kind: "changed",
			side: "RIGHT",
			line: 5,
			oldText: "- Run the build script for the web package",
			moved: true,
		});
		expect(tracePosition(R(5), d)).toStrictEqual({
			kind: "changed",
			side: "RIGHT",
			line: 3,
			oldText: "- Run the build script for the server package",
			moved: true,
		});
	});

	it("YAML keys swapped and edited follow their own key", () => {
		const d = inPlace(
			[
				"primary_database_host: db-1.internal",
				"timeout: 30",
				"replica_database_host: db-2.internal",
			],
			[
				"replica_database_host: db-3.internal",
				"timeout: 30",
				"primary_database_host: db-4.internal",
			],
		);
		expect(landing(d, 1)).toBe(3);
		expect(landing(d, 3)).toBe(1);
	});

	it("Go statements swapped and edited follow their own call", () => {
		const d = inPlace(
			[
				"func f() {",
				'\tbuildPackage("web", opts)',
				"\tkept()",
				'\tbuildPackage("server", opts)',
				"}",
			],
			[
				"func f() {",
				'\tbuildPackage("server", opts, twice)',
				"\tkept()",
				'\tbuildPackage("web", opts, twice)',
				"}",
			],
		);
		expect(landing(d, 2)).toBe(4);
		expect(landing(d, 4)).toBe(2);
	});

	it("lines swapped as they were follow their text", () => {
		const d = inPlace(
			["value = compute(alpha)", "kept()", "value = compute(beta)"],
			["value = compute(beta)", "kept()", "value = compute(alpha)"],
		);
		expect(landing(d, 1)).toBe(3);
		expect(landing(d, 3)).toBe(1);
	});

	it("crossed one way only: can't tell, never a guess", () => {
		// `register(web…)` resembles the line below more than its own
		// replacement; `register(server…)` stays closest to its own.
		const d = inPlace(
			["register(web, opts)", "kept()", "register(server, opts)"],
			["register(web_v2, opts)", "kept()", "register(server, web, opts)"],
		);
		expect(landing(d, 1)).toBe("rewritten");
		expect(landing(d, 3)).toBe("rewritten");
	});

	it("crossed both ways by less than the margin: can't tell", () => {
		// Both crossings are under SWAP_MARGIN (0.875 over 0.857, 0.615
		// over 0.533).
		const d = inPlace(
			[
				"send the report to the web team now",
				"kept()",
				"fetch the report for the server team",
			],
			[
				"send the report to the team",
				"kept()",
				"send the report to the web team later",
			],
		);
		expect(landing(d, 1)).toBe("rewritten");
		expect(landing(d, 3)).toBe("rewritten");
	});

	it("look-alikes both edited in place, not swapped, stay in place", () => {
		const d = inPlace(
			[
				"- Run the build script for the web package",
				"Note: kept.",
				"- Run the build script for the server package",
			],
			[
				"- Run the build script for the web package twice",
				"Note: kept.",
				"- Run the build script for the server package twice",
			],
		);
		expect(tracePosition(R(1), d)).toStrictEqual({
			kind: "changed",
			side: "RIGHT",
			line: 1,
			oldText: "- Run the build script for the web package",
		});
		expect(landing(d, 3)).toBe(3);
	});

	it("a line edited in place next to an unrelated look-alike edit stays in place", () => {
		const d = inPlace(
			[
				"- Deploy the web package",
				"Note: kept.",
				"- Deploy the server package",
			],
			[
				"- Deploy the web package to staging",
				"Note: kept.",
				"- Deploy the server package to staging",
			],
		);
		expect(landing(d, 1)).toBe(1);
		expect(landing(d, 3)).toBe(3);
		// A look-alike that stayed as it was is no candidate.
		const kept = inPlace(
			[
				"- Deploy the web package",
				"Note: kept.",
				"- Deploy the server package",
			],
			[
				"- Deploy the web package now",
				"Note: kept.",
				"- Deploy the server package",
			],
		);
		expect(landing(kept, 1)).toBe(1);
	});

	it("twins (the same text twice) stay as they were: no crossing", () => {
		const d = inPlace(
			["retry(3, web)", "kept()", "retry(3, web)"],
			["retry(4, web)", "kept()", "retry(4, web)"],
		);
		// Which of the two went where can't be told, and needn't be: either
		// way each lands on a line of its own text, edited alike.
		expect(landing(d, 1)).toBe(1);
		expect(landing(d, 3)).toBe(3);
		// Twins edited apart resemble both replacements alike: a tie, no
		// crossing.
		const apart = inPlace(
			["retry(3, web)", "kept()", "retry(3, web)"],
			["retry(4, web)", "kept()", "retry(5, web)"],
		);
		expect(landing(apart, 1)).toBe(1);
		expect(landing(apart, 3)).toBe(3);
	});
});

describe("traceRange", () => {
	it("C4: a range whose tail was edited keeps its start placed and its end changed", () => {
		// Old lines 7-8 became new lines 7-9.
		const bd = createLineMapper([
			{ oldStart: 7, oldCount: 2, newStart: 7, newCount: 3 },
		]);
		const d = diffs({
			bd,
			texts: rows(7, ["middle()", "end()"]),
			now: rows(7, ["middle(1)", "added()", "end(2)"]),
		});
		expect(traceRange(R(5), R(8), d)).toStrictEqual({
			start: { kind: "placed", side: "RIGHT", line: 5 },
			end: { kind: "changed", side: "RIGHT", line: 9, oldText: "end()" },
			collapsed: false,
		});
	});

	it("collapses to its end, marked changed, when the traced end precedes the start", () => {
		// The start is a LEFT line the base took (now context at RIGHT 10);
		// the end is RIGHT 10, pushed up to 4 by a deletion above it.
		const bd = createLineMapper([
			{ oldStart: 2, oldCount: 6, newStart: 1, newCount: 0 },
		]);
		const d = diffs({
			bd,
			cd: IDENTITY,
			texts: { "LEFT:10": "gone", "RIGHT:10": "kept" },
		});
		expect(tracePosition(L(10), d)).toStrictEqual({
			kind: "placed",
			side: "RIGHT",
			line: 10,
			became: "context",
		});
		const end: Placement = {
			kind: "changed",
			side: "RIGHT",
			line: 4,
			oldText: "kept",
		};
		expect(traceRange(L(10), R(10), d)).toStrictEqual({
			start: end,
			end,
			collapsed: true,
		});
	});

	it("does not collapse ends on different sides or an unplaced end; a deleted end moves inwards", () => {
		const bd = createLineMapper([
			{ oldStart: 6, oldCount: 1, newStart: 5, newCount: 0 },
		]);
		const cd = createLineMapper([
			{ oldStart: 3, oldCount: 1, newStart: 2, newCount: 0 },
		]);
		const d = diffs({ bd, cd });
		expect(traceRange(L(3), R(4), d)).toStrictEqual({
			start: { kind: "placed", side: "LEFT", line: 3 },
			end: { kind: "placed", side: "RIGHT", line: 4, became: "context" },
			collapsed: false,
		});
		// The deleted end moves inwards to the range's last surviving line.
		expect(traceRange(R(4), R(6), d)).toStrictEqual({
			start: { kind: "placed", side: "RIGHT", line: 4, became: "context" },
			end: { kind: "changed", side: "RIGHT", line: 5, oldText: null },
			collapsed: false,
		});
		// With no line of the range left, the end stays unplaced.
		expect(traceRange(R(6), R(6), d).end).toStrictEqual({
			kind: "unplaced",
			reason: "deleted",
			nearest: R(5),
		});
	});
});

describe("traceSpan", () => {
	it("C17: re-finds the span's text once in the new line", () => {
		expect(
			traceSpan({ startCol: 2, endCol: 5 }, "abcdefg", "xx-cde-yy"),
		).toStrictEqual({ startCol: 3, endCol: 6 });
		expect(
			traceSpan({ startCol: 0, endCol: 3 }, "foo(x)", "foo(y)"),
		).toStrictEqual({
			startCol: 0,
			endCol: 3,
		});
	});

	it("C17: null when the text is gone", () => {
		expect(
			traceSpan({ startCol: 2, endCol: 5 }, "abcdefg", "ab--fg"),
		).toBeNull();
	});

	it("C17: null when the text appears twice", () => {
		expect(
			traceSpan({ startCol: 2, endCol: 5 }, "abcdefg", "cde cde"),
		).toBeNull();
	});

	it("C17: null for an empty or inverted span", () => {
		expect(
			traceSpan({ startCol: 3, endCol: 3 }, "abcdefg", "abcdefg"),
		).toBeNull();
		expect(
			traceSpan({ startCol: 5, endCol: 2 }, "abcdefg", "abcdefg"),
		).toBeNull();
	});
});

// A random edit script applied to a file: `out` is the edited file and
// `hunks` the -U0 diff from `lines` to `out`.
interface Step {
	gap: number;
	remove: number;
	insert: string[];
}

const lineArb = fc.constantFrom("a", "b", "c", "d", "", " a", "a ");
const fileArb = fc.array(lineArb, { minLength: 1, maxLength: 20 });
const stepsArb = fc.array(
	fc.record({
		gap: fc.integer({ min: 1, max: 4 }),
		remove: fc.integer({ min: 0, max: 3 }),
		insert: fc.array(lineArb, { maxLength: 3 }),
	}),
	{ maxLength: 6 },
);

function applyScript(
	lines: readonly string[],
	steps: readonly Step[],
	atTop: boolean,
): { out: string[]; hunks: MapHunk[] } {
	const out: string[] = [];
	const hunks: MapHunk[] = [];
	let oldPos = 0; // lines consumed from `lines`
	steps.forEach((step, i) => {
		const gap = Math.min(
			i === 0 && atTop ? 0 : step.gap,
			lines.length - oldPos,
		);
		out.push(...lines.slice(oldPos, oldPos + gap));
		oldPos += gap;
		const remove = Math.min(step.remove, lines.length - oldPos);
		if (remove + step.insert.length === 0) return;
		hunks.push({
			oldStart: remove > 0 ? oldPos + 1 : oldPos,
			oldCount: remove,
			newStart: step.insert.length > 0 ? out.length + 1 : out.length,
			newCount: step.insert.length,
		});
		oldPos += remove;
		out.push(...step.insert);
	});
	out.push(...lines.slice(oldPos));
	return { out, hunks };
}

const invert = (hunks: readonly MapHunk[]): MapHunk[] =>
	hunks.map((h) => ({
		oldStart: h.newStart,
		oldCount: h.newCount,
		newStart: h.oldStart,
		newCount: h.oldCount,
	}));

/**
 * Three files and the three diffs between them, built so the new base and
 * the new head never need to descend from the old ones: the new snapshot
 * (base2 -> head2) comes first, then the old head and old base are random
 * edits of them, and bd / ac are those edits inverted.
 */
const worldArb = fc
	.record({
		base2: fileArb,
		cdSteps: stepsArb,
		cdTop: fc.boolean(),
		h1Steps: stepsArb,
		h1Top: fc.boolean(),
		b1Steps: stepsArb,
		b1Top: fc.boolean(),
	})
	.map((w) => {
		const cd = applyScript(w.base2, w.cdSteps, w.cdTop);
		const head2 = cd.out;
		const h1 = applyScript(head2, w.h1Steps, w.h1Top);
		const b1 = applyScript(w.base2, w.b1Steps, w.b1Top);
		return {
			base1: b1.out,
			head1: h1.out,
			base2: w.base2,
			head2,
			diffs: {
				ac: createLineMapper(invert(b1.hunks)),
				bd: createLineMapper(invert(h1.hunks)),
				cd: createLineMapper(cd.hunks),
			},
		};
	});

const textAt = (file: readonly string[], line: number): string | null =>
	file[line - 1] ?? null;

describe("tracePosition property", () => {
	it("never places a position on a line whose text differs from the old one, nor changed onto one unlike it", () => {
		fc.assert(
			fc.property(worldArb, (w) => {
				const oldFile = (side: DiffSide) =>
					side === "LEFT" ? w.base1 : w.head1;
				const newFile = (side: DiffSide) =>
					side === "LEFT" ? w.base2 : w.head2;
				const d: TraceDiffs = {
					...w.diffs,
					oldLineText: (pos) => textAt(oldFile(pos.side), pos.line),
					newLineText: (pos) => textAt(newFile(pos.side), pos.line),
					newLineCount: { LEFT: w.base2.length, RIGHT: w.head2.length },
				};
				const positions: Position[] = [];
				for (let n = 1; n <= w.head1.length + 2; n++) positions.push(R(n));
				for (let n = 1; n <= w.base1.length + 2; n++) positions.push(L(n));
				for (const pos of positions) {
					const oldText = textAt(oldFile(pos.side), pos.line);
					const placement = tracePosition(pos, d);
					switch (placement.kind) {
						case "placed":
							expect(textAt(newFile(placement.side), placement.line)).toBe(
								oldText,
							);
							break;
						case "changed": {
							expect(placement.oldText).toBe(oldText);
							// A replaced RIGHT line lands on a line the diff added,
							// one that resembles it, never by its offset alone.
							expect(placement.side).toBe("RIGHT");
							expect(d.bd.hunkRemovingOld(pos.line)).not.toBeNull();
							expect(d.bd.hunkAddingNew(placement.line)).not.toBeNull();
							expect(oldText).toMatch(/\w/);
							expect(
								lineSimilarity(
									oldText as string,
									textAt(w.head2, placement.line) as string,
								),
							).toBeGreaterThanOrEqual(SHARE_MIN_SIMILARITY);
							break;
						}
						case "unplaced":
							if (placement.reason === "outside") {
								expect(oldText).toBeNull();
								expect(placement.nearest).toBeNull();
							} else {
								expect(oldText).not.toBeNull();
							}
							if (placement.nearest) {
								expect(placement.nearest.line).toBeGreaterThanOrEqual(1);
								expect(placement.nearest.line).toBeLessThanOrEqual(
									newFile(placement.nearest.side).length,
								);
							}
							break;
					}
				}
			}),
		);
	});
});

describe("traceRange property", () => {
	it("never yields an inverted range: a new-side start before an old-side end, or an end above its start", () => {
		fc.assert(
			fc.property(worldArb, (w) => {
				const d: TraceDiffs = {
					...w.diffs,
					oldLineText: (pos) =>
						textAt(pos.side === "LEFT" ? w.base1 : w.head1, pos.line),
					newLineText: (pos) =>
						textAt(pos.side === "LEFT" ? w.base2 : w.head2, pos.line),
					newLineCount: { LEFT: w.base2.length, RIGHT: w.head2.length },
				};
				const ranges: [Position, Position][] = [];
				for (let a = 1; a <= w.head1.length; a++) {
					for (let b = a; b <= Math.min(a + 4, w.head1.length); b++) {
						ranges.push([R(a), R(b)]);
					}
				}
				for (let a = 1; a <= w.base1.length; a++) {
					for (let b = a; b <= Math.min(a + 4, w.base1.length); b++) {
						ranges.push([L(a), L(b)]);
					}
					// GitHub's one mixed range: an old-side start, a new-side end.
					for (let b = 1; b <= w.head1.length; b += 3)
						ranges.push([L(a), R(b)]);
				}
				for (const [start, end] of ranges) {
					const r = traceRange(start, end, d);
					if (r.start.kind === "unplaced" || r.end.kind === "unplaced") {
						continue;
					}
					expect(r.start.side === "RIGHT" && r.end.side === "LEFT").toBe(false);
					if (r.start.side === r.end.side) {
						expect(r.start.line).toBeLessThanOrEqual(r.end.line);
					}
				}
			}),
		);
	});
});
