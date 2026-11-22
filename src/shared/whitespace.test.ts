import { describe, expect, it } from "vitest";
import { bestCpuRatio } from "../../test/cpu.js";
import type { DiffLine } from "./types.js";
import {
	cutByLines,
	type HunkPiece,
	hunkCut,
	hunkCuts,
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

	it("over the cap costs what its git hunks do apart: a display hunk of four costs four of one", () => {
		// The scaling check (test/cpu.ts): a display hunk of 4 git hunks,
		// each well under the cap, 4x the cap together (about 995 × 999
		// lines), against 4 runs of one of them alone. Matched per git
		// hunk, as the cap says, it is the same work (about 1x); matched
		// whole (the fallback missing), a 1e6-cell DP against 4 × 62e3,
		// about 4x.
		const removed = 248;
		const gitHunk = (key: string, oldFrom: number, newFrom: number) => [
			...Array.from({ length: removed }, (_, i) =>
				del(oldFrom + i, `${key}${i % 30}`, { clusterKey: key }),
			),
			...Array.from({ length: removed + 1 }, (_, i) =>
				add(newFrom + i, ` ${key}${(i + 7) % 31}`, { clusterKey: key }),
			),
		];
		const lines: DiffLine[] = [];
		for (let h = 0; h < 4; h++) {
			if (h > 0) {
				const at = h * (removed + 1);
				lines.push(ctx(at, at + h, `between ${h}`));
			}
			lines.push(
				...gitHunk(`g${h}`, h * (removed + 1) + 1, h * (removed + 2) + 1),
			);
		}
		const one = gitHunk("g0", 1, 1);
		const old = lines.filter((l) => l.kind !== "add").length;
		const young = lines.filter((l) => l.kind !== "del").length;
		expect(old * young).toBeGreaterThan(4 * SPLIT_CELLS * 0.95);
		expect(removed * (removed + 1)).toBeLessThan(SPLIT_CELLS);
		const { ratio } = bestCpuRatio(
			// Fresh arrays each time: no cache hit.
			() => matchDisplayHunk([...lines]),
			() => {
				for (let k = 0; k < 4; k++) matchDisplayHunk([...one]);
			},
		);
		// test/cpu.ts's limit: linear about 1x, the whole-hunk DP about 4x.
		expect(ratio).toBeLessThan(2);
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

/** `cutByLines`' pieces as a trace: `~`/`*`, then each side's line indexes. */
const cutTrace = (pieces: HunkPiece[]) =>
	pieces.map(
		(p) =>
			`${p.whitespaceOnly ? "~" : "*"}${p.removedFrom}-${p.removedTo}|${p.addedFrom}-${p.addedTo}`,
	);

/**
 * Principle 2 for `cutByLines`: the pieces cover every removed and added
 * line exactly once, in order, none empty; a whitespace-only piece holds
 * only flagged lines and a change piece at least one unflagged line (a
 * flag never makes a change read whitespace-only, an unflagged line never
 * hides in a whitespace-only piece); neighbours differ (runs are whole).
 */
function expectCut(
	pieces: HunkPiece[],
	removedWs: readonly boolean[],
	addedWs: readonly boolean[],
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
		const flags = [
			...removedWs.slice(p.removedFrom, p.removedTo),
			...addedWs.slice(p.addedFrom, p.addedTo),
		];
		if (p.whitespaceOnly) expect(flags.every(Boolean)).toBe(true);
		else expect(flags.some((f) => !f)).toBe(true);
		if (pieces.length > 1) expect(p.whitespaceOnly).not.toBe(last);
		last = p.whitespaceOnly;
		r = p.removedTo;
		a = p.addedTo;
	}
	expect(r).toBe(removedWs.length);
	expect(a).toBe(addedWs.length);
}

describe("cutByLines (CAR-218)", () => {
	const T = true;
	const F = false;
	const cut = (
		removedWs: boolean[],
		addedWs: boolean[],
		pairs: [number, number][],
	) => {
		const pieces = cutByLines(removedWs, addedWs, pairs);
		expectCut(pieces, removedWs, addedWs);
		return cutTrace(pieces);
	};

	it("in-hunk pairs give two-sided whitespace-only pieces, as splitHunk did", () => {
		// change / whitespace only / change.
		expect(
			cut(
				[F, F, T, T, F, F],
				[F, F, T, T, F, F],
				[
					[2, 2],
					[3, 3],
				],
			),
		).toEqual(["*0-2|0-2", "~2-4|2-4", "*4-6|4-6"]);
		// A deletion, a re-indent, an addition.
		expect(
			cut(
				[F, T, T],
				[T, T, F],
				[
					[1, 0],
					[2, 1],
				],
			),
		).toEqual(["*0-1|0-0", "~1-3|0-2", "*3-3|2-3"]);
		// Nothing flagged: one change.
		expect(cut([F, F], [F], [])).toEqual(["*0-2|0-1"]);
		// All paired: one whitespace-only piece.
		expect(
			cut(
				[T, T],
				[T, T],
				[
					[0, 0],
					[1, 1],
				],
			),
		).toEqual(["~0-2|0-2"]);
	});

	it("cuts a gap's removed runs first, then its added runs, one-sided whitespace-only pieces too", () => {
		// Removed lines whose twins are elsewhere, then a real addition.
		expect(cut([T, T], [F], [])).toEqual(["~0-2|0-0", "*2-2|0-1"]);
		// A real deletion, then added lines whose twins are elsewhere.
		expect(cut([F], [T, T], [])).toEqual(["*0-1|0-0", "~1-1|0-2"]);
		// Removed: twin elsewhere, change; added: change, twin elsewhere.
		// The gap's change lines on both sides are one change piece.
		expect(cut([T, F], [F, T], [])).toEqual([
			"~0-1|0-0",
			"*1-2|0-1",
			"~2-2|1-2",
		]);
		// A pure addition or deletion, flagged or not.
		expect(cut([], [T, F, T], [])).toEqual([
			"~0-0|0-1",
			"*0-0|1-2",
			"~0-0|2-3",
		]);
		expect(cut([F, F], [], [])).toEqual(["*0-2|0-0"]);
	});

	it("keeps a run of whitespace-only lines one piece across a pair and the gap beside it", () => {
		// Added lines with twins elsewhere, a pair, more such added lines:
		// every line whitespace-only, so the hunk is one piece.
		expect(cut([T], [T, T, T, T, T], [[0, 2]])).toEqual(["~0-1|0-5"]);
		expect(cut([T, F], [T, T, F], [[0, 1]])).toEqual(["~0-1|0-2", "*1-2|2-3"]);
	});

	it("never trusts a pair against the flags or out of order: those lines go by their flags", () => {
		// A pair on an unflagged line is no pair.
		expect(cut([F], [F], [[0, 0]])).toEqual(["*0-1|0-1"]);
		// Out of order or out of range: skipped.
		expect(
			cut(
				[T, T],
				[T, T],
				[
					[1, 0],
					[0, 1],
					[5, 5],
				],
			),
		).toEqual(["~0-2|0-2"]);
		expect(
			cut(
				[T, F],
				[F, T],
				[
					[1, 1],
					[0, 0],
				],
			),
		).toEqual(["~0-1|0-0", "*1-2|0-1", "~2-2|1-2"]);
	});

	it("covers every line once, in order, for any flags and pairs", () => {
		let seed = 4211;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		for (let n = 0; n < 2000; n++) {
			const removedWs = Array.from({ length: rand(7) }, () => rand(2) === 0);
			const addedWs = Array.from({ length: rand(7) }, () => rand(2) === 0);
			const pairs: [number, number][] = Array.from(
				{ length: rand(5) },
				() => [rand(8), rand(8)] as [number, number],
			);
			if (rand(2) === 0) pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
			const pieces = cutByLines(removedWs, addedWs, pairs);
			if (removedWs.length + addedWs.length === 0) {
				expect(pieces.length).toBeLessThanOrEqual(1);
				continue;
			}
			expectCut(pieces, removedWs, addedWs);
		}
	});

	it("gives splitHunk's pieces for the pairs splitHunk finds", () => {
		const removed = ["a", "  x", "b", "  y", "  z"];
		const added = ["x", "B", "y", "z", "c"];
		const { removedWs, addedWs, pairs } = hunkCut(removed, added);
		expect(cutByLines(removedWs, addedWs, pairs)).toEqual(
			splitHunk(removed, added),
		);
	});
});

describe("the cut over a display hunk (CAR-218)", () => {
	/**
	 * Each git hunk of a display hunk (its lines' `clusterKey`) cut by the
	 * display hunk's matching, as the server cuts it: every changed line
	 * as `~` or `*` with its text.
	 */
	const cutLines = (lines: DiffLine[]) => {
		const out = new Map<DiffLine, boolean>();
		for (const [key, c] of hunkCuts(lines)) {
			const dels = lines.filter(
				(l) => l.kind === "del" && l.clusterKey === key,
			);
			const adds = lines.filter(
				(l) => l.kind === "add" && l.clusterKey === key,
			);
			const pieces = cutByLines(c.removedWs, c.addedWs, c.pairs);
			expectCut(pieces, c.removedWs, c.addedWs);
			for (const p of pieces) {
				for (const l of dels.slice(p.removedFrom, p.removedTo))
					out.set(l, p.whitespaceOnly);
				for (const l of adds.slice(p.addedFrom, p.addedTo))
					out.set(l, p.whitespaceOnly);
			}
		}
		return out;
	};

	it("re-indent across an accidental unchanged line: only the wrapper's lines are changes", () => {
		// A page's markup wrapped one level deeper in a new <Provider>. The
		// inner `<div>` and `</div>` at the old depth equal the outer ones
		// at the new depth byte for byte, so git keeps them as unchanged
		// lines and cuts the block into three hunks (git diff -U0's shape).
		const lines: DiffLine[] = [
			ctx(1, 1, "export function Page() {"),
			ctx(2, 2, "  return ("),
			del(3, "    <div>", { clusterKey: "A" }),
			del(4, "      <Header />", { clusterKey: "A" }),
			add(3, "    <Provider>", { clusterKey: "A" }),
			ctx(5, 4, "      <div>"),
			del(6, "        <Title />", { clusterKey: "B" }),
			add(5, "        <Header />", { clusterKey: "B" }),
			add(6, "        <div>", { clusterKey: "B" }),
			add(7, "          <Title />", { clusterKey: "B" }),
			add(8, "        </div>", { clusterKey: "B" }),
			add(9, "        <Footer />", { clusterKey: "B" }),
			ctx(7, 10, "      </div>"),
			del(8, "      <Footer />", { clusterKey: "C" }),
			del(9, "    </div>", { clusterKey: "C" }),
			add(11, "    </Provider>", { clusterKey: "C" }),
			ctx(10, 12, "  );"),
			ctx(11, 13, "}"),
		];
		const cut = cutLines(lines);
		expect(
			[...cut].filter(([, ws]) => !ws).map(([l]) => l.text.trim()),
		).toEqual(["<Provider>", "</Provider>"]);
		const changed = lines.filter((l) => l.kind !== "context");
		expect(cut.size).toBe(changed.length);
		// The accidental lines stay unchanged lines, and the cut agrees with
		// the view's `~` rows line for line.
		expect(lines[5]?.kind).toBe("context");
		for (const l of changed)
			expect(cut.get(l)).toBe(whitespaceLines(lines).has(l));
		// Hunk B is all whitespace: one piece, though only one pair is its own.
		const b = hunkCuts(lines).get("B");
		expect(b && cutTrace(cutByLines(b.removedWs, b.addedWs, b.pairs))).toEqual([
			"~0-1|0-5",
		]);
	});

	it("a block moved across a change stays a change", () => {
		// Swapped and re-indented: only one of the two can pair in order.
		const swapped = [
			del(1, "first();"),
			del(2, "second();"),
			add(1, "  second();"),
			add(2, "  first();"),
		];
		const cut = cutLines(swapped);
		expect([...cut.values()].filter((ws) => !ws)).toHaveLength(2);
		// Moved below an unchanged line: its twin is across it, so no twin.
		const moved: DiffLine[] = [
			del(1, "moved();", { clusterKey: "A" }),
			ctx(2, 1, "keep();"),
			add(2, "  moved();", { clusterKey: "B" }),
		];
		expect([...cutLines(moved).values()]).toEqual([false, false]);
	});

	it("over the cap, cuts each git hunk as splitHunk does", () => {
		const size = 300;
		const hunk = (key: string, from: number) => {
			const removed = Array.from({ length: size }, (_, i) =>
				i === 5 ? `${key} gone` : `${key} ${i % 40}`,
			);
			const added = removed.map((t, i) => (i === 9 ? `${key} new` : `  ${t}`));
			return {
				removed,
				added,
				lines: [
					...removed.map((t, i) => del(from + i, t, { clusterKey: key })),
					...added.map((t, i) => add(from + i, t, { clusterKey: key })),
				],
			};
		};
		const a = hunk("A", 1);
		const b = hunk("B", size + 2);
		const lines = [...a.lines, ctx(size + 1, size + 1, "}"), ...b.lines];
		const old = lines.filter((l) => l.kind !== "add").length;
		expect(old * old).toBeGreaterThan(SPLIT_CELLS);
		const cuts = hunkCuts(lines);
		for (const [key, h] of [
			["A", a],
			["B", b],
		] as const) {
			const c = cuts.get(key);
			expect(c && cutByLines(c.removedWs, c.addedWs, c.pairs)).toEqual(
				splitHunk(h.removed, h.added),
			);
		}
	});
});
