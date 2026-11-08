import { describe, expect, it, vi } from "vitest";
import { buildDisplayHunks } from "../../../server/diff/hunks";
import type {
	Cluster,
	ClusterView,
	DiffLine,
	FileHunks,
	FileView,
} from "../../../shared/types";
import {
	type Caret,
	caretAfterTyping,
	countsByFile,
	fileLines,
	findInPr,
	type Hit,
	type HitPos,
	hitIndex,
	occurrences,
	stepCaret,
} from "./findInPr";

const ctx = (oldNo: number, newNo: number, text: string): DiffLine => ({
	kind: "context",
	oldNo,
	newNo,
	text,
});

const cluster = (over: Partial<ClusterView> = {}): ClusterView => ({
	key: "k",
	kind: "lines",
	oldStart: 3,
	oldCount: 0,
	newStart: 3,
	newCount: 0,
	removed: [],
	added: [],
	lines: 0,
	state: "unreviewed",
	...over,
});

const file = (index: number, over: Partial<FileView> = {}): FileView => ({
	index,
	path: `f${index}.txt`,
	status: "modified",
	binary: false,
	submodule: false,
	additions: 0,
	deletions: 0,
	done: false,
	reviewed: false,
	crossedOff: false,
	clusters: [],
	...over,
});

const none = () => undefined;
const noContext = () => [];
const at = (h: Hit) => ({ side: h.side, line: h.line, col: h.col });

describe("occurrences", () => {
	it("counts non-overlapping occurrences left to right", () => {
		expect(occurrences("aaaa", "aa", true)).toEqual([
			{ col: 0, len: 2 },
			{ col: 2, len: 2 },
		]);
		expect(occurrences("x", "", false)).toEqual([]);
		expect(occurrences("call a.b( and axb(", "a.b(", true)).toEqual([
			{ col: 5, len: 4 },
		]);
	});

	it("matches case-insensitively by default and exactly with Match case", () => {
		const text = "Save saveDraft SAVE";
		expect(occurrences(text, "save", false)).toHaveLength(3);
		expect(occurrences(text, "save", true)).toEqual([{ col: 5, len: 4 }]);
	});

	it("keeps the original string's columns when folding changes the length", () => {
		expect("İstanbul".toLowerCase().length).toBe(9);
		expect(occurrences("İstanbul", "stanbul", false)).toEqual([
			{ col: 1, len: 7 },
		]);
	});
});

describe("findInPr", () => {
	it("orders a file's hits: path, old path, then lines in diff order and column order", () => {
		const f = file(0, {
			path: "src/save.ts",
			oldPath: "src/old/save.ts",
			status: "renamed",
			clusters: [
				cluster({
					removed: ["save a", "b save save"],
					added: ["save c"],
					oldStart: 3,
					newStart: 3,
				}),
			],
		});
		const hits = findInPr("save", [f], none, noContext, false);
		expect(hits.map(at)).toEqual([
			{ side: "path", line: 0, col: 4 },
			{ side: "oldPath", line: 0, col: 8 },
			{ side: "LEFT", line: 3, col: 0 },
			{ side: "LEFT", line: 4, col: 2 },
			{ side: "LEFT", line: 4, col: 7 },
			{ side: "RIGHT", line: 3, col: 0 },
		]);
	});

	it("searches only paths of binary files and submodules", () => {
		const c = [cluster({ added: ["save"], removed: ["save"] })];
		const files = [
			file(0, { path: "save.png", binary: true, clusters: c }),
			file(1, { path: "save-mod", submodule: true, clusters: c }),
		];
		const hits = findInPr("save", files, none, noContext, false);
		expect(hits.map((h) => [h.index, h.side])).toEqual([
			[0, "path"],
			[1, "path"],
		]);
	});

	it("uses the hunks' lines once they are in, with expanded context in its place", () => {
		const f = file(0, {
			path: "a.txt",
			clusters: [cluster({ added: ["save"], newStart: 3 })],
		});
		const hunks: FileHunks = {
			newLineCount: 12,
			hunks: [
				{
					oldStart: 1,
					oldCount: 3,
					newStart: 1,
					newCount: 2,
					lines: [
						ctx(1, 1, "x"),
						ctx(2, 2, "save"),
						{ kind: "del", oldNo: 3, text: "x" },
					],
				},
				{
					oldStart: 10,
					oldCount: 3,
					newStart: 10,
					newCount: 3,
					lines: [ctx(10, 10, "x"), ctx(11, 11, "x"), ctx(12, 12, "save")],
				},
			],
		};
		const context = [ctx(6, 6, "save"), ctx(5, 5, "save"), ctx(2, 2, "save")];
		const lines = fileLines(f, hunks, context);
		expect(lines.map((l) => `${l.side}:${l.line}`)).toEqual([
			"RIGHT:1",
			"RIGHT:2",
			"LEFT:3",
			"RIGHT:5",
			"RIGHT:6",
			"RIGHT:10",
			"RIGHT:11",
			"RIGHT:12",
		]);
		const hits = findInPr(
			"save",
			[f],
			() => hunks,
			() => context,
			false,
		);
		expect(hits.filter((h) => h.line === 2)).toHaveLength(1);
		expect(hits.map((h) => h.line)).toEqual([2, 5, 6, 12]);
	});

	it("orders files as given", () => {
		const mk = (i: number) => file(i, { path: "save", clusters: [] });
		const hits = findInPr("save", [mk(1), mk(0)], none, noContext, false);
		expect(hits.map((h) => h.index)).toEqual([1, 0]);
	});

	it("the caret survives a file's hunks arriving", () => {
		const f = file(0, {
			path: "a.txt",
			clusters: [cluster({ added: ["save"], newStart: 3, newCount: 1 })],
		});
		const before = findInPr("save", [f], none, noContext, false);
		const pos: HitPos = { index: 0, side: "RIGHT", line: 3, col: 0 };
		expect(hitIndex(before, pos)).toBe(0);
		const hunks: FileHunks = {
			newLineCount: 4,
			hunks: [
				{
					oldStart: 1,
					oldCount: 2,
					newStart: 1,
					newCount: 3,
					lines: [
						ctx(1, 1, "save"),
						ctx(2, 2, "x"),
						{ kind: "add", newNo: 3, text: "save" },
					],
				},
			],
		};
		const after = findInPr("save", [f], () => hunks, noContext, false);
		expect(hitIndex(after, pos)).toBe(1);
		expect(after[1]?.len).toBe(before[0]?.len);
		expect(hitIndex(after, { ...pos, line: 99 })).toBe(-1);
	});
});

describe("findInPr's cost", () => {
	it("builds its pattern once per search, not once per line", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `save ${i}`);
		const f = file(0, {
			clusters: [cluster({ removed: lines, added: lines })],
		});
		const Real = RegExp;
		const built = vi.fn(function (this: unknown, ...args: [string, string]) {
			return new Real(...args);
		});
		vi.stubGlobal("RegExp", built);
		try {
			const hits = findInPr("save", [f], none, noContext, false);
			expect(hits).toHaveLength(100);
		} finally {
			vi.unstubAllGlobals();
		}
		expect(built).toHaveBeenCalledTimes(1);
	});
});

describe("caret", () => {
	const hit = (index: number, line = 1): Hit => ({
		index,
		side: "RIGHT",
		line,
		col: 0,
		len: 1,
	});

	it("after typing, finds the caret in one pass over the hits (not one per file)", () => {
		// Every hit in the first file, the open one has none: each file
		// after it looked for its first hit over all of them.
		const n = 20_000;
		const order = Array.from({ length: n }, (_, i) => i);
		const hits = Array.from({ length: n }, (_, i) => hit(0, i + 1));
		const t = process.threadCpuUsage();
		const caret = caretAfterTyping(hits, order, 1);
		expect(process.threadCpuUsage(t).user).toBeLessThan(150_000);
		expect(caret?.pos).toMatchObject({ index: 0, line: 1 });
	});

	it("after typing, the caret is the open file's first hit, else the next file's, wrapping, else the PR's first", () => {
		const order = [3, 1, 2];
		const hits = [hit(3), hit(2, 1), hit(2, 5)];
		expect(caretAfterTyping(hits, order, 2)?.pos).toMatchObject({
			index: 2,
			line: 1,
		});
		// Open 1 has no hit: the next in order is 2.
		expect(caretAfterTyping(hits, order, 1)?.pos.index).toBe(2);
		// Open 2 has no hit (only 3 does): the search wraps from 2 to 3.
		expect(caretAfterTyping([hit(3)], order, 2)?.pos.index).toBe(3);
		expect(caretAfterTyping(hits, order, null)?.pos.index).toBe(3);
		expect(caretAfterTyping(hits, order, 2)?.shown).toBe(false);
		expect(caretAfterTyping(hits, order, null)?.shown).toBe(false);
		expect(caretAfterTyping([], order, 1)).toBeNull();
	});

	it("the first step shows the caret where it is; later steps move and wrap", () => {
		const hits = [hit(0, 1), hit(0, 2), hit(0, 3)];
		const first = hits[0] as Hit;
		const last = hits[2] as Hit;
		const at0 = (h: Hit): HitPos => ({
			index: h.index,
			side: h.side,
			line: h.line,
			col: h.col,
		});
		const unshown = (h: Hit): Caret => ({ pos: at0(h), shown: false });
		const shown = (h: Hit): Caret => ({ pos: at0(h), shown: true });
		expect(stepCaret(hits, unshown(first), 1)).toEqual(shown(first));
		expect(stepCaret(hits, unshown(first), -1)).toEqual(shown(first));
		expect(stepCaret(hits, shown(last), 1)?.pos).toEqual(at0(first));
		expect(stepCaret(hits, shown(first), -1)?.pos).toEqual(at0(last));
		expect(stepCaret(hits, shown(first), 1)?.pos).toEqual(at0(hits[1] as Hit));
		expect(stepCaret(hits, null, 1)).toBeNull();
		expect(stepCaret([], shown(first), 1)).toBeNull();
	});

	it("an unshown caret the reviewer already sees moves on: next goes forward, previous back", () => {
		const hits = [hit(0, 1), hit(0, 2), hit(0, 3)];
		const at0 = (h: Hit): HitPos => ({
			index: h.index,
			side: h.side,
			line: h.line,
			col: h.col,
		});
		const unshown = (h: Hit): Caret => ({ pos: at0(h), shown: false });
		const middle = hits[1] as Hit;
		expect(stepCaret(hits, unshown(middle), 1, true)).toEqual({
			pos: at0(hits[2] as Hit),
			shown: true,
		});
		expect(stepCaret(hits, unshown(middle), -1, true)).toEqual({
			pos: at0(hits[0] as Hit),
			shown: true,
		});
		// Not seen: the step shows it where it is.
		expect(stepCaret(hits, unshown(middle), 1, false)).toEqual({
			pos: at0(middle),
			shown: true,
		});
	});
});

describe("integrity", () => {
	/** A small seeded PRNG so a failure reproduces. */
	function rng(seed: number) {
		let s = seed;
		return () => {
			s = (s * 1664525 + 1013904223) % 4294967296;
			return s / 4294967296;
		};
	}
	const WORDS = ["save", "Save", "x", "  "];

	it("holds for any input", () => {
		for (let seed = 1; seed <= 300; seed++) {
			const r = rng(seed);
			const int = (n: number) => Math.floor(r() * n);
			const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)] as T;
			const text = () =>
				Array.from({ length: 1 + int(3) }, () => pick(WORDS)).join(" ");
			const term = pick(WORDS);
			const matchCase = r() < 0.5;

			const ids = Array.from({ length: 1 + int(6) }, (_, i) => i);
			const files: FileView[] = [];
			const hunksByIndex = new Map<number, FileHunks>();
			const contextByIndex = new Map<number, DiffLine[]>();
			for (const i of ids) {
				const oldLines: string[] = [];
				const newLines: string[] = [];
				const clusters: Cluster[] = [];
				for (let c = int(4); c > 0; c--) {
					for (let k = 1 + int(8); k > 0; k--) {
						const t = text();
						oldLines.push(t);
						newLines.push(t);
					}
					const removed = Array.from({ length: int(5) }, text);
					const added = Array.from(
						{ length: removed.length ? int(5) : 1 + int(4) },
						text,
					);
					clusters.push({
						key: `c${clusters.length}`,
						kind: "lines",
						oldStart: removed.length ? oldLines.length + 1 : oldLines.length,
						oldCount: removed.length,
						newStart: added.length ? newLines.length + 1 : newLines.length,
						newCount: added.length,
						removed,
						added,
						lines: removed.length + added.length,
					});
					oldLines.push(...removed);
					newLines.push(...added);
				}
				const binary = r() < 0.15;
				const renamed = r() < 0.3;
				files.push(
					file(i, {
						path: `${pick(WORDS).trim() || "p"}/${text().trim()}.ts`,
						...(renamed ? { oldPath: `old/${text().trim()}.ts` } : {}),
						binary,
						clusters: clusters.map((c) => ({
							...c,
							state: "unreviewed" as const,
						})),
					}),
				);
				if (r() < 0.5 && clusters.length) {
					hunksByIndex.set(i, {
						newLineCount: newLines.length,
						hunks: buildDisplayHunks(oldLines, newLines, clusters),
					});
				}
				contextByIndex.set(
					i,
					Array.from({ length: int(6) }, () => {
						const n = 1 + int(Math.max(newLines.length, 1) + 3);
						return ctx(n, n, text());
					}),
				);
			}
			const order = [...files].sort(() => r() - 0.5);
			const hunksOf = (f: FileView) => hunksByIndex.get(f.index);
			const contextOf = (f: FileView) => contextByIndex.get(f.index) ?? [];

			const hits = findInPr(term, order, hunksOf, contextOf, matchCase);

			// (a) the counts add up to the hits
			let total = 0;
			for (const n of countsByFile(hits).values()) total += n;
			expect(hits.length, `seed ${seed}`).toBe(total);

			// (e) fileLines against an oracle built from the inputs alone: no
			// line searched twice or missed, none inside a hunk from context
			for (const f of files) {
				const hunks = hunksOf(f);
				const got = fileLines(f, hunks, contextOf(f)).map(
					(l) => `${l.side}:${l.line}`,
				);
				expect(new Set(got).size, `seed ${seed} file ${f.index}`).toBe(
					got.length,
				);
				let want: string[];
				if (!hunks) {
					want = f.clusters.flatMap((c) => [
						...c.removed.map((_, i) => `LEFT:${c.oldStart + i}`),
						...c.added.map((_, i) => `RIGHT:${c.newStart + i}`),
					]);
				} else {
					const inHunk = (n: number) =>
						hunks.hunks.some(
							(h) => n >= h.newStart && n < h.newStart + h.newCount,
						);
					const outside = [
						...new Set(
							contextOf(f)
								.map((l) => l.newNo as number)
								.filter((n) => !inHunk(n)),
						),
					];
					// each placed by number: before the first hunk starting after it
					const gap = (n: number) =>
						hunks.hunks.findIndex((h) => h.newStart > n);
					want = [];
					hunks.hunks.forEach((h, i) => {
						for (const n of outside
							.filter((n) => gap(n) === i)
							.sort((a, b) => a - b))
							want.push(`RIGHT:${n}`);
						for (const l of h.lines)
							want.push(
								l.kind === "del" ? `LEFT:${l.oldNo}` : `RIGHT:${l.newNo}`,
							);
					});
					for (const n of outside
						.filter((n) => gap(n) < 0)
						.sort((a, b) => a - b))
						want.push(`RIGHT:${n}`);
				}
				expect(got, `seed ${seed} file ${f.index}`).toEqual(want);
			}

			const linesOf = (f: FileView) =>
				f.binary || f.submodule ? [] : fileLines(f, hunksOf(f), contextOf(f));
			const norm = (s: string) => (matchCase ? s : s.toLowerCase());

			// (b) every hit's text is the term
			for (const h of hits) {
				const f = files.find((x) => x.index === h.index) as FileView;
				const src =
					h.side === "path"
						? f.path
						: h.side === "oldPath"
							? (f.oldPath ?? "")
							: (linesOf(f).find((l) => l.side === h.side && l.line === h.line)
									?.text ?? "");
				expect(norm(src.slice(h.col, h.col + h.len)), `seed ${seed}`).toBe(
					norm(term),
				);
			}

			// (c) the naive walk finds the same hits
			const naive: Hit[] = [];
			for (const f of order) {
				for (const o of occurrences(f.path, term, matchCase))
					naive.push({ index: f.index, side: "path", line: 0, ...o });
				for (const o of occurrences(f.oldPath ?? "", term, matchCase))
					naive.push({ index: f.index, side: "oldPath", line: 0, ...o });
				for (const l of linesOf(f))
					for (const o of occurrences(l.text, term, matchCase))
						naive.push({ index: f.index, side: l.side, line: l.line, ...o });
			}
			expect(hits, `seed ${seed}`).toEqual(naive);

			// (d) reading order
			const key = (h: Hit) => {
				const f = files.find((x) => x.index === h.index) as FileView;
				const rank = h.side === "path" ? 0 : h.side === "oldPath" ? 1 : 2;
				const lineAt =
					rank < 2
						? 0
						: linesOf(f).findIndex(
								(l) => l.side === h.side && l.line === h.line,
							);
				return [order.indexOf(f), rank, lineAt, h.col];
			};
			for (let i = 1; i < hits.length; i++) {
				const a = key(hits[i - 1] as Hit);
				const b = key(hits[i] as Hit);
				const cmp = a.findIndex((v, n) => v !== b[n]);
				if (cmp >= 0)
					expect(a[cmp] as number, `seed ${seed}`).toBeLessThan(
						b[cmp] as number,
					);
			}
		}
	});
});
