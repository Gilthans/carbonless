// Scenario ids are the C-cases of
// Linear CAR-5's document "Re-review after new pushes: scenarios and prior art".
// Covered elsewhere: C7 (renames) and C9–C12 (other heads, moved code) are
// inputs the server resolves before calling the tracer (PR 3 and PR 5); C14
// (a suggestion applied) is C2; C18 (file-level) has no position to trace;
// C19 (GitHub's own line disagrees) is the real-PR check.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bestCpuRatio, repeat } from "../../../test/cpu";
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
	WIDE_SWAP_LINES,
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
	it("exports TRACER_VERSION 5 from the index", () => {
		expect(TRACER_VERSION).toBe(5);
		expect(tracer.TRACER_VERSION).toBe(5);
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
	return withHunks(old, now, hunks);
}

/** `old` to `now` through the given `git diff -U0` hunks. */
const withHunks = (old: string[], now: string[], hunks: MapHunk[]) =>
	diffs({
		bd: createLineMapper(hunks),
		texts: rows(1, old),
		now: rows(1, now),
	});

/** A one-line hunk: `[old, new]` start and count, as `@@ -o,oc +n,nc @@`. */
const hunk = (o: number, oc: number, n: number, nc: number): MapHunk => ({
	oldStart: o,
	oldCount: oc,
	newStart: n,
	newCount: nc,
});

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

	it("a near miss (ten-word items, one word apart, swapped with a word added) can't be told", () => {
		// Crosses by 0.087 both ways, just under SWAP_MARGIN.
		const d = inPlace(
			[
				"- Run the full build script for the main web package now",
				"Note: kept.",
				"- Run the full build script for the main server package now",
			],
			[
				"- Run the full build script for the main server package now twice",
				"Note: kept.",
				"- Run the full build script for the main web package now twice",
			],
		);
		expect(landing(d, 1)).toBe("rewritten");
		expect(landing(d, 3)).toBe("rewritten");
	});

	it("values swapped under keys that stay put: each thread stays on its key", () => {
		const d = inPlace(
			[
				"primary_host: db-west-1.internal.example.com",
				"timeout: 30",
				"replica_host: db-east-2.internal.example.com",
			],
			[
				"primary_host: db-east-2.internal.example.com",
				"timeout: 30",
				"replica_host: db-west-1.internal.example.com",
			],
		);
		expect(tracePosition(R(1), d)).toStrictEqual({
			kind: "changed",
			side: "RIGHT",
			line: 1,
			oldText: "primary_host: db-west-1.internal.example.com",
		});
		expect(landing(d, 3)).toBe(3);
	});

	it("values swapped under call subjects that stay put: each thread stays on its call", () => {
		const d = inPlace(
			[
				'\texpect(primary).toBe("db-east-1.internal.example.com")',
				"\tkept()",
				'\texpect(replica).toBe("db-west-2.internal.example.com")',
			],
			[
				'\texpect(primary).toBe("db-west-2.internal.example.com")',
				"\tkept()",
				'\texpect(replica).toBe("db-east-1.internal.example.com")',
			],
		);
		expect(landing(d, 1)).toBe(1);
		expect(landing(d, 3)).toBe(3);
	});

	it("generic short lines that cross never move: can't tell", () => {
		const d = inPlace(
			["if err != nil {", "\treturn err", "}", "return nil"],
			["if err != nil {", "\treturn nil", "}", "return err"],
		);
		expect(landing(d, 2)).toBe("rewritten");
		expect(landing(d, 4)).toBe("rewritten");
	});

	it("short generic lines swapped between branches never move: can't tell", () => {
		const bools = inPlace(
			["if missing {", "\treturn false", "}", "return true"],
			["if missing {", "\treturn true", "}", "return false"],
		);
		expect(landing(bools, 2)).toBe("rewritten");
		expect(landing(bools, 4)).toBe("rewritten");
		const results = inPlace(
			["if err != nil {", "\treturn nil, err", "}", "return res, nil"],
			["if err != nil {", "\treturn res, nil", "}", "return nil, err"],
		);
		expect(landing(results, 2)).toBe("rewritten");
		expect(landing(results, 4)).toBe("rewritten");
	});

	it("a swap never overrides a block that moved elsewhere: can't tell", () => {
		// Old 1-3 found again word for word at new 6-8, and old 2 also
		// crosses with old 5 at home.
		const d = withHunks(
			[
				"setupAlphaConnection(pool)",
				"value = computeTotal(alpha)",
				"logAlphaTotals(value)",
				"kept()",
				"value = computeTotal(beta)",
				"other()",
				"more()",
			],
			[
				"value = computeTotal(beta, 2)",
				"kept()",
				"value = computeTotal(alpha, 2)",
				"other()",
				"more()",
				"setupAlphaConnection(pool)",
				"value = computeTotal(alpha)",
				"logAlphaTotals(value)",
			],
			[hunk(1, 3, 1, 1), hunk(5, 1, 3, 1), hunk(7, 0, 6, 3)],
		);
		expect(landing(d, 2)).toBe("rewritten");
		expect(landing(d, 5)).toBe("rewritten");
	});

	it("a swap decides the same for both lines when a deletion unanchors one", () => {
		const d = withHunks(
			[
				"value = compute(alpha)",
				"kept()",
				"value = compute(beta)",
				"k2()",
				"drop_this_line(now)",
			],
			[
				"value = compute(beta, 1)",
				"kept()",
				"value = compute(alpha, 1)",
				"k2()",
			],
			[hunk(1, 1, 1, 1), hunk(3, 1, 3, 1), hunk(5, 1, 4, 0)],
		);
		expect(landing(d, 1)).toBe(3);
		expect(landing(d, 3)).toBe(1);
	});

	it("the same, mirrored: a deletion above the first line unanchors it", () => {
		const mirror = withHunks(
			[
				"drop_this_line(now)",
				"k0()",
				"value = compute(alpha)",
				"kept()",
				"value = compute(beta)",
			],
			[
				"k0()",
				"value = compute(beta, 1)",
				"kept()",
				"value = compute(alpha, 1)",
			],
			[hunk(1, 1, 0, 0), hunk(3, 1, 2, 1), hunk(5, 1, 4, 1)],
		);
		expect(landing(mirror, 3)).toBe(4);
		expect(landing(mirror, 5)).toBe(2);
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

/** `n` kept lines between a swap's two lines. */
const kept = (n: number) =>
	Array.from({ length: n }, (_, i) => `step${i + 1}()`);

describe("tracePosition: look-alike lines swapped across a wider gap (CAR-294)", () => {
	const A = "value = computeTotal(alpha)";
	const B = "value = computeTotal(beta)";

	for (const gap of [3, 10]) {
		it(`swapped as they were, ${gap} kept lines apart, follow their text`, () => {
			const d = inPlace([A, ...kept(gap), B], [B, ...kept(gap), A]);
			expect(tracePosition(R(1), d)).toStrictEqual({
				kind: "changed",
				side: "RIGHT",
				line: gap + 2,
				oldText: A,
				moved: true,
			});
			expect(landing(d, gap + 2)).toBe(1);
		});

		it(`swapped and edited, ${gap} kept lines apart, follow their text`, () => {
			const d = inPlace(
				[A, ...kept(gap), B],
				[
					"value = computeTotal(beta, 2)",
					...kept(gap),
					"value = computeTotal(alpha, 2)",
				],
			);
			expect(landing(d, 1)).toBe(gap + 2);
			expect(landing(d, gap + 2)).toBe(1);
		});
	}

	it("Markdown items of one list swapped and edited four lines apart follow their text", () => {
		// Crosses by 0.118 both ways, as CAR-279's Markdown case.
		const d = inPlace(
			[
				"- Run the build script for the web package",
				"- Lint",
				"- Test",
				"- Pack",
				"- Sign",
				"- Run the build script for the server package",
			],
			[
				"- Run the build script for the server package twice",
				"- Lint",
				"- Test",
				"- Pack",
				"- Sign",
				"- Run the build script for the web package twice",
			],
		);
		expect(landing(d, 1)).toBe(6);
		expect(landing(d, 6)).toBe(1);
	});

	it("a nested block between the two lines is still their block", () => {
		const d = inPlace(
			[
				"func build() {",
				'\tbuildPackage("web", opts)',
				"\tif debug {",
				"\t\tlog(opts)",
				"\t}",
				'\tbuildPackage("server", opts)',
				"}",
			],
			[
				"func build() {",
				'\tbuildPackage("server", opts)',
				"\tif debug {",
				"\t\tlog(opts)",
				"\t}",
				'\tbuildPackage("web", opts)',
				"}",
			],
		);
		expect(landing(d, 2)).toBe(6);
		expect(landing(d, 6)).toBe(2);
	});

	it("crossed by less than the margin far apart: can't tell", () => {
		// CAR-279's near miss (0.087), five lines apart.
		const d = inPlace(
			[
				"- Run the full build script for the main web package now",
				...kept(4),
				"- Run the full build script for the main server package now",
			],
			[
				"- Run the full build script for the main server package now twice",
				...kept(4),
				"- Run the full build script for the main web package now twice",
			],
		);
		expect(landing(d, 1)).toBe("rewritten");
		expect(landing(d, 6)).toBe("rewritten");
	});

	it("three look-alikes rotated far apart: can't tell", () => {
		const C = "value = computeTotal(gamma)";
		const d = inPlace(
			[A, ...kept(4), B, ...kept(4), C],
			[C, ...kept(4), A, ...kept(4), B],
		);
		expect(landing(d, 1)).toBe("rewritten");
		expect(landing(d, 6)).toBe("rewritten");
		expect(landing(d, 11)).toBe("rewritten");
	});

	it("a far swap never overrides a block that moved elsewhere: can't tell", () => {
		const d = withHunks(
			[
				"setupAlpha(pool)",
				A,
				"logAlphaTotals(value)",
				...kept(5),
				B,
				...kept(2),
			],
			[
				B,
				...kept(5),
				"value = computeTotal(alpha, 2)",
				...kept(2),
				"setupAlpha(pool)",
				A,
				"logAlphaTotals(value)",
			],
			[hunk(1, 3, 1, 1), hunk(9, 1, 7, 1), hunk(11, 0, 10, 3)],
		);
		expect(landing(d, 2)).toBe("rewritten");
		expect(landing(d, 9)).toBe("rewritten");
	});

	it("past WIDE_SWAP_LINES nothing is compared: each stays on its edit, as before", () => {
		const gap = WIDE_SWAP_LINES;
		const d = inPlace([A, ...kept(gap), B], [B, ...kept(gap), A]);
		expect(landing(d, 1)).toBe(1);
		expect(landing(d, gap + 2)).toBe(gap + 2);
	});

	it("look-alikes in two functions never swap (Go, Python, a class's methods)", () => {
		const users = 'rows := db.Query("SELECT id, name FROM users")';
		const teams = 'rows := db.Query("SELECT id, name FROM teams")';
		const go = (a: string, b: string) => [
			"func loadUsers() {",
			`\t${a}`,
			"\tdefer rows.Close()",
			"\treturn scan(rows)",
			"}",
			"",
			"func loadTeams() {",
			`\t${b}`,
			"\tdefer rows.Close()",
			"\treturn scan(rows)",
			"}",
		];
		const goSwap = inPlace(go(users, teams), go(teams, users));
		expect(landing(goSwap, 2)).toBe(2);
		expect(landing(goSwap, 8)).toBe(8);
		const py = (a: string, b: string) => [
			"def load_users():",
			`    rows = db.query("SELECT id, name FROM ${a}")`,
			"    log(rows)",
			"    return rows",
			"",
			"def load_teams():",
			`    rows = db.query("SELECT id, name FROM ${b}")`,
			"    log(rows)",
			"    return rows",
		];
		const pySwap = inPlace(py("users", "teams"), py("teams", "users"));
		expect(landing(pySwap, 2)).toBe(2);
		expect(landing(pySwap, 7)).toBe(7);
		const js = (a: string, b: string) => [
			"class Repo {",
			"  loadUsers() {",
			`    return this.db.query("SELECT id, name FROM ${a}")`,
			"  }",
			"",
			"  loadTeams() {",
			`    return this.db.query("SELECT id, name FROM ${b}")`,
			"  }",
			"}",
		];
		const jsSwap = inPlace(js("users", "teams"), js("teams", "users"));
		expect(landing(jsSwap, 3)).toBe(3);
		expect(landing(jsSwap, 7)).toBe(7);
	});

	it("look-alikes in two sections never swap (YAML parents, INI tables, Markdown headings)", () => {
		const yaml = (a: string, b: string) => [
			"server:",
			`  log_file: /var/log/${a}.log`,
			"  host: alpha",
			"  user: svc",
			"client:",
			`  log_file: /var/log/${b}.log`,
			"  host: beta",
		];
		const y = inPlace(
			yaml("server-main", "client-main"),
			yaml("client-main", "server-main"),
		);
		expect(landing(y, 2)).toBe(2);
		expect(landing(y, 6)).toBe(6);
		const ini = (a: string, b: string) => [
			"[server]",
			`log_file = /var/log/${a}.log`,
			"host = alpha",
			"user = svc",
			"[client]",
			`log_file = /var/log/${b}.log`,
			"host = beta",
		];
		const i = inPlace(
			ini("server-main", "client-main"),
			ini("client-main", "server-main"),
		);
		expect(landing(i, 2)).toBe(2);
		expect(landing(i, 6)).toBe(6);
		const md = (a: string, b: string) => [
			"## Web",
			`- Run the build script for the ${a} package`,
			"- Check the output",
			"",
			"## Server",
			`- Run the build script for the ${b} package`,
			"- Check the logs",
		];
		const m = inPlace(md("web", "server"), md("server", "web"));
		expect(landing(m, 2)).toBe(2);
		expect(landing(m, 6)).toBe(6);
	});

	it("far look-alikes told apart only by a number stay on their edit", () => {
		// 200→201 above, 201→404 below: the lower line's old text is the
		// upper's new one, a crossing one way, by chance.
		const chain = inPlace(
			[
				"expect(response.status).toBe(200)",
				...kept(5),
				"expect(response.status).toBe(201)",
			],
			[
				"expect(response.status).toBe(201)",
				...kept(5),
				"expect(response.status).toBe(404)",
			],
		);
		expect(landing(chain, 1)).toBe(1);
		expect(landing(chain, 7)).toBe(7);
		// Values swapped under one key: which moved can't be read from the
		// text; the edits in place stand, as before.
		const values = inPlace(
			[
				"connection_timeout_ms = 3000",
				...kept(5),
				"connection_timeout_ms = 5000",
			],
			[
				"connection_timeout_ms = 5000",
				...kept(5),
				"connection_timeout_ms = 3000",
			],
		);
		expect(landing(values, 1)).toBe(1);
		expect(landing(values, 7)).toBe(7);
	});

	it("block headers whose names swapped far apart stay on their block (tests, methods, cases, arms)", () => {
		// A mislabelled pair fixed by swapping the titles: the bodies, and
		// what a thread on the header is about, stayed.
		const tests = (a: string, b: string) => [
			'describe("auth", () => {',
			`\tit("${a}", async () => {`,
			'\t\tconst res = await get("/x", guest)',
			"\t\texpect(res.status).toBe(403)",
			"\t})",
			"",
			`\tit("${b}", async () => {`,
			'\t\tconst res = await get("/x", admin)',
			"\t\texpect(res.status).toBe(200)",
			"\t})",
			"})",
		];
		const it2 = inPlace(
			tests("returns 200 for admin users", "returns 403 for guest users"),
			tests("returns 403 for guest users", "returns 200 for admin users"),
		);
		expect(landing(it2, 2)).toBe(2);
		expect(landing(it2, 7)).toBe(7);
		const py = (a: string, b: string) => [
			"class TestAuth:",
			`    def ${a}(self):`,
			"        r = get(guest)",
			"        assert r.status == 403",
			"",
			`    def ${b}(self):`,
			"        r = get(admin)",
			"        assert r.status == 200",
		];
		const methods = inPlace(
			py("test_admin_gets_ok", "test_guest_is_forbidden"),
			py("test_guest_is_forbidden", "test_admin_gets_ok"),
		);
		expect(landing(methods, 2)).toBe(2);
		expect(landing(methods, 6)).toBe(6);
		const go = (a: string, b: string) => [
			"\tswitch event.kind {",
			`\tcase ${a}:`,
			"\t\tnotifyAdmins(event)",
			'\t\tmetrics.inc("x")',
			"\t\taudit(event)",
			`\tcase ${b}:`,
			"\t\tarchive(event)",
			'\t\tmetrics.inc("y")',
			"\t}",
		];
		const cases = inPlace(
			go("EventKindUserCreated", "EventKindUserDeleted"),
			go("EventKindUserDeleted", "EventKindUserCreated"),
		);
		expect(landing(cases, 2)).toBe(2);
		expect(landing(cases, 6)).toBe(6);
		const rust = (a: string, b: string) => [
			"    match kind {",
			`        Kind::${a} => {`,
			"            notify_admins(&ev);",
			"            audit(&ev);",
			"        }",
			`        Kind::${b} => {`,
			"            archive(&ev);",
			"        }",
			"    }",
		];
		const arms = inPlace(
			rust("UserCreated", "UserDeleted"),
			rust("UserDeleted", "UserCreated"),
		);
		expect(landing(arms, 2)).toBe(2);
		expect(landing(arms, 6)).toBe(6);
	});

	it("values swapped far apart under keys that stay put stay, even when the key's word is in the value", () => {
		const d = inPlace(
			[
				'handlers["users"] = newHandler("/api/users", usersStore)',
				"func init() { setup() }",
				"a := 1",
				"b := 2",
				"c := 3",
				'handlers["teams"] = newHandler("/api/teams", teamsStore)',
			],
			[
				'handlers["users"] = newHandler("/api/teams", teamsStore)',
				"func init() { setup() }",
				"a := 1",
				"b := 2",
				"c := 3",
				'handlers["teams"] = newHandler("/api/users", usersStore)',
			],
		);
		expect(landing(d, 1)).toBe(1);
		expect(landing(d, 6)).toBe(6);
	});

	it("far look-alikes edited in place, or keeping their keys, stay", () => {
		const logs = inPlace(
			[
				'logger.info("Server started on port", port)',
				...kept(8),
				'logger.info("Worker started with id", id)',
			],
			[
				'logger.info("HTTP server started on port", port)',
				...kept(8),
				'logger.info("Worker started with id and pool", id, pool)',
			],
		);
		expect(landing(logs, 1)).toBe(1);
		expect(landing(logs, 10)).toBe(10);
		const renamed = inPlace(
			[A, ...kept(5), B],
			["value = computeSum(alpha)", ...kept(5), "value = computeSum(beta)"],
		);
		expect(landing(renamed, 1)).toBe(1);
		expect(landing(renamed, 7)).toBe(7);
		const rows = inPlace(
			[
				'{name: "empty input", want: errEmptyInput},',
				...kept(4),
				'{name: "nil input", want: errNilInput},',
			],
			[
				'{name: "empty input", want: errNilInput},',
				...kept(4),
				'{name: "nil input", want: errEmptyInput},',
			],
		);
		expect(landing(rows, 1)).toBe(1);
		expect(landing(rows, 6)).toBe(6);
	});

	it("scales linearly: tracing 4x the changed look-alike lines costs about 4 runs of a quarter", () => {
		// One function of look-alike calls, every other line edited: each
		// line's swap check reads WIDE_SWAP_LINES around it, never the
		// whole block. Measured on the dev machine: 1.0-1.2x; a whole-block
		// window 4.1-4.5x.
		const traceAll = (n: number) => () => {
			const old = ["func f() {"];
			const now = ["func f() {"];
			for (let i = 0; i < n; i++) {
				old.push(`\tvalue${i % 7} = computeTotal(item${i}, opts)`);
				now.push(`\tvalue${i % 7} = computeTotal(item${i}, opts, 2)`);
				old.push(`\tkept${i}()`);
				now.push(`\tkept${i}()`);
			}
			old.push("}");
			now.push("}");
			const d = inPlace(old, now);
			for (let i = 0; i < n; i++) tracePosition(R(2 + 2 * i), d);
		};
		const n = 30;
		const { ratio } = bestCpuRatio(traceAll(4 * n), repeat(4, traceAll(n)));
		expect(ratio).toBeLessThan(2);
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
