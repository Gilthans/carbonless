import { describe, expect, it } from "vitest";
import { bestCpuRatio } from "../../test/cpu.js";
import type { DiffLine } from "./types.js";
import {
	type HunkPiece,
	matchDisplayHunk,
	SPLIT_CELLS,
	splitHunk,
	stripWhitespace,
	whitespaceEqual,
	whitespaceKey,
	whitespaceLines,
} from "./whitespace.js";

/** The pieces as a readable trace: `~` whitespace-only, `*` a change, with each side's lines. */
const trace = (
	pieces: HunkPiece[],
	removed: readonly string[],
	added: readonly string[],
) =>
	pieces.map(
		(p) =>
			`${p.whitespaceOnly ? "~" : "*"}${removed.slice(p.removedFrom, p.removedTo).join(",")}|${added.slice(p.addedFrom, p.addedTo).join(",")}`,
	);

/**
 * Principle 2: the pieces cover every removed and added line of the hunk
 * exactly once, in order, none empty; a whitespace-only piece pairs its
 * lines side for side, each pair `-w`-equal (with the same final
 * newline); a change piece never sits next to another change piece, nor a
 * whitespace-only one next to another (runs are whole).
 */
function expectPieces(
	pieces: HunkPiece[],
	removed: readonly string[],
	added: readonly string[],
	noNewlineOld = false,
	noNewlineNew = false,
) {
	let r = 0;
	let a = 0;
	let last: boolean | null = null;
	for (const p of pieces) {
		expect(p.removedFrom).toBe(r);
		expect(p.addedFrom).toBe(a);
		expect(p.removedTo).toBeGreaterThanOrEqual(p.removedFrom);
		expect(p.addedTo).toBeGreaterThanOrEqual(p.addedFrom);
		expect(
			p.removedTo - p.removedFrom + p.addedTo - p.addedFrom,
		).toBeGreaterThan(0);
		if (p.whitespaceOnly) {
			expect(p.removedTo - p.removedFrom).toBe(p.addedTo - p.addedFrom);
			for (let k = 0; k < p.removedTo - p.removedFrom; k++) {
				const i = p.removedFrom + k;
				const j = p.addedFrom + k;
				expect(whitespaceEqual(removed[i] as string, added[j] as string)).toBe(
					true,
				);
				const endOld = noNewlineOld && i === removed.length - 1;
				const endNew = noNewlineNew && j === added.length - 1;
				expect(endOld).toBe(endNew);
			}
		}
		if (pieces.length > 1) expect(p.whitespaceOnly).not.toBe(last);
		last = p.whitespaceOnly;
		r = p.removedTo;
		a = p.addedTo;
	}
	expect(r).toBe(removed.length);
	expect(a).toBe(added.length);
}

function split(
	removed: string[],
	added: string[],
	noNewlineOld = false,
	noNewlineNew = false,
) {
	const pieces = splitHunk(removed, added, noNewlineOld, noNewlineNew);
	expectPieces(pieces, removed, added, noNewlineOld, noNewlineNew);
	return trace(pieces, removed, added);
}

describe("stripWhitespace", () => {
	it("removes ASCII whitespace only, as git -w does", () => {
		expect(stripWhitespace(" a\tb\r\v\fc ")).toBe("abc");
		expect(stripWhitespace("a\u00a0b")).toBe("a\u00a0b");
		expect(whitespaceEqual("  x = 1;", "x=1;\r")).toBe(true);
		expect(whitespaceEqual("x = 1;", "x = 2;")).toBe(false);
	});
});

describe("splitHunk", () => {
	it("cuts change / whitespace-only / change into three pieces", () => {
		expect(
			split(["a", "b", "  c", "  d", "e", "f"], ["A", "B", "c", "d", "E", "F"]),
		).toEqual(["*a,b|A,B", "~  c,  d|c,d", "*e,f|E,F"]);
	});

	it("keeps a hunk that is all whitespace one whitespace-only piece", () => {
		expect(split(["  a", "  b"], ["\ta", "\tb"])).toEqual(["~  a,  b|\ta,\tb"]);
	});

	it("keeps a hunk with no whitespace-only line one change", () => {
		expect(split(["a", "b"], ["c", "d"])).toEqual(["*a,b|c,d"]);
	});

	it("splits out a single whitespace-only line between two changes", () => {
		expect(split(["a", " x", "b"], ["A", "x", "B"])).toEqual([
			"*a|A",
			"~ x|x",
			"*b|B",
		]);
	});

	it("never counts a pure addition or deletion as whitespace-only, blank lines too", () => {
		expect(split([], ["", "  "])).toEqual(["*|,  "]);
		expect(split(["", "\t"], [])).toEqual(["*,\t|"]);
	});

	it("pairs a blank line with a whitespace-only one, as git -w does, but an added blank line stays a change", () => {
		// "  " and "" are equal once whitespace is gone: -w shows them as context.
		expect(split(["a", "  "], ["A", ""])).toEqual(["*a|A", "~  |"]);
		// The extra blank line has no twin: a change.
		expect(split(["a"], ["a ", ""])).toEqual(["~a|a ", "*|"]);
	});

	it("treats CRLF to LF and tabs to spaces as whitespace", () => {
		expect(split(["x\r", "\ty"], ["x", "    y"])).toEqual(["~x\r,\ty|x,    y"]);
	});

	it("keeps a line moved across a re-indented block a change", () => {
		expect(split(["m", "  b1", "  b2"], ["b1", "b2", "m"])).toEqual([
			"*m|",
			"~  b1,  b2|b1,b2",
			"*|m",
		]);
	});

	it("matches in order only: a swapped pair is one match and a change", () => {
		const out = split(["x ", "y "], ["y", "x"]);
		expect(out.filter((p) => p.startsWith("~"))).toHaveLength(1);
		expect(out.filter((p) => p.startsWith("*"))).toHaveLength(2);
	});

	it("treats a final newline lost or gained as a real change, like git -w", () => {
		expect(split(["a", " b"], ["a ", "b"], false, true)).toEqual([
			"~a|a ",
			"* b|b",
		]);
		expect(split(["a", " b"], ["a ", "b"], true, true)).toEqual(["~a, b|a ,b"]);
	});

	it("matches a hunk up to the cap, and keeps one over it one change", () => {
		const within = Array.from({ length: 499 }, (_, i) => ` w${i}`);
		expect(
			splitHunk([...within, "x"], [...within.map((l) => l.trim()), "y"]).map(
				(p) => p.whitespaceOnly,
			),
		).toEqual([true, false]);
		const removed = Array.from({ length: 501 }, (_, i) => ` l${i}`);
		expect(removed.length * (removed.length + 1)).toBeGreaterThan(SPLIT_CELLS);
		const added = [...removed.map((l) => l.trim()), "extra"];
		expect(splitHunk(removed, added)).toEqual([
			{
				removedFrom: 0,
				removedTo: removed.length,
				addedFrom: 0,
				addedTo: added.length,
				whitespaceOnly: false,
			},
		]);
		// A wholesale re-indent over the cap still splits (no O(n·m) work).
		expect(splitHunk(removed, added.slice(0, -1))).toEqual([
			{
				removedFrom: 0,
				removedTo: removed.length,
				addedFrom: 0,
				addedTo: removed.length,
				whitespaceOnly: true,
			},
		]);
	});

	it("does no O(n·m) work on a hunk over the cap: it costs about what a re-indent of the same size does", () => {
		const old = Array.from({ length: 2000 }, (_, i) => `  l${i % 50}`);
		const reindent = old.map((l) => l.trim());
		const rewritten = [...old.map((l, i) => (i % 3 ? l.trim() : `${l}!`)), "x"];
		const { ratio } = bestCpuRatio(
			() => splitHunk(old, rewritten),
			() => splitHunk(old, reindent),
		);
		// The matching would be well over 10x (about 50 ms against 2).
		expect(ratio).toBeLessThan(3);
	});

	it("covers every line exactly once and labels only -w-equal pairs, for any generated hunk", () => {
		let s = 11;
		const r = () => {
			s = (s * 1664525 + 1013904223) % 4294967296;
			return s / 4294967296;
		};
		const words = ["a", "b", "c", "", "}"];
		const spaced = (w: string) =>
			[w, ` ${w}`, `\t${w}`, `${w}\r`, `${w}  `][Math.floor(r() * 5)] as string;
		for (let seed = 0; seed < 2000; seed++) {
			const n = Math.floor(r() * 9);
			const m = Math.floor(r() * 9);
			const removed = Array.from({ length: n }, () =>
				spaced(words[Math.floor(r() * words.length)] as string),
			);
			const added = Array.from({ length: m }, () =>
				spaced(words[Math.floor(r() * words.length)] as string),
			);
			if (n + m === 0) continue;
			const noOld = n > 0 && r() < 0.2;
			const noNew = m > 0 && r() < 0.2;
			const pieces = splitHunk(removed, added, noOld, noNew);
			expectPieces(pieces, removed, added, noOld, noNew);
		}
	});
});

const del = (oldNo: number, text: string, over: Partial<DiffLine> = {}) =>
	({ kind: "del", oldNo, text, clusterKey: "k", ...over }) as DiffLine;
const add = (newNo: number, text: string, over: Partial<DiffLine> = {}) =>
	({ kind: "add", newNo, text, clusterKey: "k", ...over }) as DiffLine;
const ctx = (oldNo: number, newNo: number, text: string): DiffLine => ({
	kind: "context",
	oldNo,
	newNo,
	text,
});
const lineKey = (l: DiffLine) => whitespaceKey(l.text, l.noNewline === true);

/** The twins as index pairs into `lines`, sorted: [line, twin]. */
const twinIndexes = (lines: DiffLine[]) =>
	[...matchDisplayHunk(lines)]
		.map(([l, t]) => [lines.indexOf(l), lines.indexOf(t)])
		.sort((x, y) => (x[0] as number) - (y[0] as number));

/**
 * What the twins must be for any display hunk: each pair joins a removed
 * line to an added or context line (or an added line to a removed or
 * context line), whitespace-equal; a removed and an added line that twin
 * each other agree; the matched sides keep their order; and every context
 * line is matched (to itself or to a change), so the rows are a sound
 * `-w` edit script. `whitespaceLines` is exactly the twins' changed lines.
 */
function expectTwins(lines: DiffLine[]) {
	const twins = matchDisplayHunk(lines);
	for (const [line, twin] of twins) {
		expect(line.kind).not.toBe("context");
		expect(lines).toContain(twin);
		expect(twin.kind).not.toBe(line.kind);
		expect(lineKey(line)).toBe(lineKey(twin));
		if (twin.kind !== "context") expect(twins.get(twin)).toBe(line);
	}
	// The matching as old index → new index pairs, context lines to themselves.
	const old = lines.filter((l) => l.kind !== "add");
	const young = lines.filter((l) => l.kind !== "del");
	const pairs: [number, number][] = [];
	for (const [line, twin] of twins) {
		if (line.kind === "del")
			pairs.push([old.indexOf(line), young.indexOf(twin)]);
		else if (twin.kind === "context")
			pairs.push([old.indexOf(twin), young.indexOf(line)]);
	}
	const matchedContext = new Set(
		[...twins.values()].filter((t) => t.kind === "context"),
	);
	for (const l of lines) {
		if (l.kind === "context" && !matchedContext.has(l))
			pairs.push([old.indexOf(l), young.indexOf(l)]);
	}
	pairs.sort((x, y) => x[0] - y[0]);
	for (let k = 1; k < pairs.length; k++) {
		expect((pairs[k] as [number, number])[0]).toBeGreaterThan(
			(pairs[k - 1] as [number, number])[0],
		);
		expect((pairs[k] as [number, number])[1]).toBeGreaterThan(
			(pairs[k - 1] as [number, number])[1],
		);
	}
	// A context line matched to a change has its own other side taken by
	// another change: each old and new index once.
	expect(new Set(pairs.map((p) => p[1])).size).toBe(pairs.length);
	expect(new Set(pairs.map((p) => p[0])).size).toBe(pairs.length);
	expect(whitespaceLines(lines)).toEqual(new Set(twins.keys()));
}

describe("matchDisplayHunk", () => {
	it("within the cap it matches like matchHunk did", () => {
		// A re-indented block, line by line.
		const reindent = [del(1, "a"), del(2, "b"), add(1, "  a"), add(2, "  b")];
		expect(twinIndexes(reindent)).toEqual([
			[0, 2],
			[1, 3],
			[2, 0],
			[3, 1],
		]);
		// Duplicates pair in order; the extra one has no twin.
		const dups = [del(1, "}"), del(2, "}"), add(1, "  }")];
		expect(twinIndexes(dups)).toEqual([
			[0, 2],
			[2, 0],
		]);
		// A final newline lost or gained is a real change.
		expect(
			twinIndexes([del(1, "a", { noNewline: true }), add(1, "a")]),
		).toEqual([]);
		// Unicode blanks are content.
		expect(twinIndexes([del(1, "a\u00A0b"), add(1, "a b")])).toEqual([]);
		// Across a context line: a twin in another run, or a context twin.
		const across: DiffLine[] = [
			del(8, "  if (x) {", { clusterKey: "A" }),
			add(8, "    if (x) {", { clusterKey: "A" }),
			add(9, "    }", { clusterKey: "A" }),
			add(10, "    sum += 1;", { clusterKey: "A" }),
			ctx(9, 11, "  }"),
			del(10, "  sum += 1;", { clusterKey: "B" }),
			del(11, "}", { clusterKey: "B" }),
			ctx(12, 12, "return;"),
		];
		expect(twinIndexes(across)).toEqual([
			[0, 1],
			[1, 0],
			[2, 4],
			[3, 5],
			[5, 3],
			[6, 4],
		]);
		// A block moved across an unchanged line stays a change.
		const moved: DiffLine[] = [
			add(1, "    a();", { clusterKey: "A" }),
			add(2, "    b();", { clusterKey: "A" }),
			ctx(1, 3, "  init();"),
			del(2, "  a();", { clusterKey: "B" }),
			del(3, "  b();", { clusterKey: "B" }),
		];
		expect(twinIndexes(moved)).toEqual([]);
		// An added `}` before a context `}`: the context keeps its own line.
		expect(twinIndexes([add(1, "}"), ctx(1, 2, "  }")])).toEqual([]);
		for (const lines of [reindent, dups, across, moved]) expectTwins(lines);
	});

	it("a pure addition has no twin", () => {
		const lines = [del(1, "a"), add(1, "a "), add(2, "")];
		expect(whitespaceLines(lines)).toEqual(
			new Set([lines[0], lines[1]] as DiffLine[]),
		);
		expect(whitespaceLines(lines).has(lines[2] as DiffLine)).toBe(false);
		expect(whitespaceLines([add(1, ""), add(2, "  ")]).size).toBe(0);
	});

	it("over the cap the rows follow the per-hunk cut", () => {
		// Two git hunks around a context line `}`, each re-indenting its own
		// lines (with a real change in each), together over SPLIT_CELLS.
		// Matched as one, git's shape for a block whose `}` byte-matched
		// would twin across the context line: A's added `  }` with it, its
		// `  s` with B's removed `s`, and B's removed `}` with it.
		const size = 300;
		const hunk = (key: string, from: number, pre: string[], post: string[]) => {
			const body = Array.from({ length: size }, (_, i) =>
				i === 7 ? `${key} old ${i}` : `${key} ${i % 40}`,
			);
			const removed = [...pre, ...body];
			const added = [
				...body.map((t, i) => (i === 7 ? `  ${key} new` : `  ${t}`)),
				...post,
			];
			return {
				removed,
				added,
				lines: [
					...removed.map((t, i) => del(from + i, t, { clusterKey: key })),
					...added.map((t, i) => add(from + i, t, { clusterKey: key })),
				],
			};
		};
		const a = hunk("A", 1, [], ["  }", "  s"]);
		const b = hunk("B", size + 2, ["s", "}"], []);
		const lines: DiffLine[] = [
			...a.lines,
			ctx(size + 1, size + 3, "}"),
			...b.lines,
		];
		// Within the cap (the same shape, small), the twins do cross.
		const small = [
			del(1, "if", { clusterKey: "A" }),
			add(1, "  if", { clusterKey: "A" }),
			add(2, "  }", { clusterKey: "A" }),
			add(3, "  s", { clusterKey: "A" }),
			ctx(2, 4, "}"),
			del(3, "s", { clusterKey: "B" }),
			del(4, "}", { clusterKey: "B" }),
		];
		expect(twinIndexes(small)).toEqual([
			[0, 1],
			[1, 0],
			[2, 4],
			[3, 5],
			[5, 3],
			[6, 4],
		]);
		const old = lines.filter((l) => l.kind !== "add").length;
		const young = lines.filter((l) => l.kind !== "del").length;
		expect(old * young).toBeGreaterThan(SPLIT_CELLS);
		expect(a.removed.length * a.added.length).toBeLessThanOrEqual(SPLIT_CELLS);
		const expected = new Set<DiffLine>();
		for (const h of [a, b]) {
			for (const p of splitHunk(h.removed, h.added)) {
				if (!p.whitespaceOnly) continue;
				for (let i = p.removedFrom; i < p.removedTo; i++)
					expected.add(h.lines[i] as DiffLine);
				for (let j = p.addedFrom; j < p.addedTo; j++)
					expected.add(h.lines[h.removed.length + j] as DiffLine);
			}
		}
		expect(expected.size).toBeGreaterThan(0);
		expect(whitespaceLines(lines)).toEqual(expected);
		const twins = matchDisplayHunk(lines);
		for (const [line, twin] of twins) {
			expect(twin.clusterKey).toBe(line.clusterKey);
		}
		expectTwins(lines);
	});

	it("caches one matching per lines array", () => {
		const lines = [del(1, "a"), add(1, " a")];
		expect(matchDisplayHunk(lines)).toBe(matchDisplayHunk(lines));
		expect(whitespaceLines(lines)).toBe(whitespaceLines(lines));
	});

	it("gives sound, order-preserving twins for any generated display hunk", () => {
		let seed = 977;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		const words = ["a", "b", "}", "if (x)", "", "a\u00A0b"];
		const blank = ["", " ", "\t", "  ", "\r"];
		const text = () =>
			`${blank[rand(blank.length)]}${words[rand(words.length)]}${blank[rand(blank.length)]}`;
		for (let n = 0; n < 600; n++) {
			const lines: DiffLine[] = [];
			let oldNo = 1;
			let newNo = 1;
			const parts = 1 + rand(4);
			for (let p = 0; p < parts; p++) {
				for (let c = rand(3); c > 0; c--)
					lines.push(ctx(oldNo++, newNo++, text()));
				const key = `k${p}`;
				const dels = Array.from({ length: rand(6) }, () =>
					del(oldNo++, text(), { clusterKey: key }),
				);
				const adds = Array.from({ length: rand(6) }, () =>
					add(newNo++, text(), { clusterKey: key }),
				);
				lines.push(...dels, ...adds);
			}
			const lastDel = lines.findLast((l) => l.kind === "del");
			if (lastDel && rand(3) === 0) lastDel.noNewline = true;
			const lastAdd = lines.findLast((l) => l.kind === "add");
			if (lastAdd && rand(3) === 0) lastAdd.noNewline = true;
			expectTwins(lines);
		}
	});

	it("costs at the cap about what the matching's own DP of that size does", () => {
		// A display hunk just under the cap (500 × 500 sides), lines that
		// differ everywhere but share keys, so the DP runs in full.
		const n = 495;
		const lines: DiffLine[] = [
			...Array.from({ length: n }, (_, i) => del(i + 1, `x${i % 30}`)),
			...Array.from({ length: n }, (_, i) => add(i + 1, ` x${(i + 7) % 31}`)),
			...Array.from({ length: 5 }, (_, i) =>
				ctx(n + 1 + i, n + 1 + i, `c${i}`),
			),
		];
		const old = n + 5;
		expect(old * old).toBeLessThanOrEqual(SPLIT_CELLS);
		// The reference: splitHunk on a hunk of the same size (the server's
		// cut today, measured ~4 ms at its cap).
		const removed = Array.from({ length: old }, (_, i) => `x${i % 30}`);
		const added = Array.from({ length: old }, (_, i) => ` x${(i + 7) % 31}`);
		const { ratio } = bestCpuRatio(
			// A fresh array each time: no cache hit.
			() => matchDisplayHunk([...lines]),
			() => splitHunk(removed, added),
		);
		// Both are one O(n·m) DP of the same cells; a second pass or a
		// quadratic step on top would read well over 3x.
		expect(ratio).toBeLessThan(3);
	});
});
