import { describe, expect, it, vi } from "vitest";
import { bestCpuRatio, repeat } from "../../../../test/cpu";
import { buildDisplayHunks } from "../../../server/diff/hunks";
import type {
	Cluster,
	ClusterView,
	DiffLine,
	FileHunks,
	FileView,
} from "../../../shared/types";
import { viewRuns } from "../whitespace";
import {
	type Caret,
	caretAfterTyping,
	countsByFile,
	emitHunk,
	fileLines,
	findInPr,
	type Hit,
	type HitPos,
	hiddenHitMoved,
	hitIndex,
	keptCaret,
	occurrences,
	shownHits,
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
		const of = (n: number) => ({
			order: Array.from({ length: n }, (_, i) => i),
			hits: Array.from({ length: n }, (_, i) => hit(0, i + 1)),
		});
		const long = of(20_000);
		const short = of(5_000);
		// CPU against four runs a quarter the size (CLAUDE.md): one pass is
		// about 1x, one per file 4x.
		const { ratio } = bestCpuRatio(
			() => caretAfterTyping(long.hits, long.order, 1),
			repeat(4, () => caretAfterTyping(short.hits, short.order, 1)),
		);
		console.info(
			`caretAfterTyping: 4x the hits in ${ratio.toFixed(2)}x the CPU`,
		);
		expect(ratio).toBeLessThan(2);
		expect(caretAfterTyping(long.hits, long.order, 1)?.pos).toMatchObject({
			index: 0,
			line: 1,
		});
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
		// Old-side hits that unified + Ignore whitespace leaves out, over all
		// seeds: (f) must have met some.
		let hidden = 0;
		// Seeds whose unified order differs from the hunks' own: some must.
		let reordered = 0;
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
					// Often a whitespace-only change of a removed line.
					if (removed.length && added.length && r() < 0.5)
						added[int(added.length)] = `  ${pick(removed)}`;
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

			// (f) Pairing (unified + Ignore whitespace) finds the plain
			// search's hits. Unified shows exactly those not on the old line of
			// a two-sided `~` row, in the order of the rows as rendered: the
			// oracle is viewRuns, what HunkRows renders, with each hunk's rows
			// in the hunk's place.
			const paired = findInPr(term, order, hunksOf, contextOf, matchCase, true);
			const posKey = (h: {
				index: number;
				side: string;
				line: number;
				col: number;
			}) => `${h.index}:${h.side}:${h.line}:${h.col}`;
			expect(paired.map(posKey).sort(), `seed ${seed}`).toEqual(
				hits.map(posKey).sort(),
			);
			for (const h of paired)
				if (h.twin !== undefined) expect(h.side, `seed ${seed}`).toBe("LEFT");
			const offScreen = new Set<string>();
			// Each shown line's place: fileLines' index, a hunk's lines by
			// their row's place from the hunk's first line.
			const placeOf = new Map<string, number>();
			const lineKey = (index: number, side: string, line: number) =>
				`${index}:${side}:${line}`;
			for (const f of files) {
				const plain = linesOf(f);
				plain.forEach((l, i) => {
					placeOf.set(lineKey(f.index, l.side, l.line), i);
				});
				if (f.binary || f.submodule) continue;
				for (const h of hunksOf(f)?.hunks ?? []) {
					const first = h.lines[0] as DiffLine;
					const start = placeOf.get(
						first.kind === "del"
							? lineKey(f.index, "LEFT", first.oldNo as number)
							: lineKey(f.index, "RIGHT", first.newNo as number),
					) as number;
					let row = 0;
					for (const run of viewRuns(h.lines, true))
						for (const r of run.rows) {
							if (r.kind === "ws" && r.del && r.add)
								offScreen.add(lineKey(f.index, "LEFT", r.del.oldNo as number));
							const shown =
								r.kind === "line" ? r.line : ((r.add ?? r.del) as DiffLine);
							placeOf.set(
								shown.kind === "del"
									? lineKey(f.index, "LEFT", shown.oldNo as number)
									: lineKey(f.index, "RIGHT", shown.newNo as number),
								start + row++,
							);
						}
				}
			}
			const onScreen = hits.filter(
				(h) => !offScreen.has(lineKey(h.index, h.side, h.line)),
			);
			hidden += hits.length - onScreen.length;
			const screenKey = (h: Hit) => {
				const f = files.find((x) => x.index === h.index) as FileView;
				const rank = h.side === "path" ? 0 : h.side === "oldPath" ? 1 : 2;
				const at =
					rank < 2
						? 0
						: (placeOf.get(lineKey(h.index, h.side, h.line)) as number);
				return [order.indexOf(f), rank, at, h.col];
			};
			const cmp = (x: Hit, y: Hit) => {
				const a = screenKey(x);
				const b = screenKey(y);
				const i = a.findIndex((v, n) => v !== b[n]);
				return i < 0 ? 0 : (a[i] as number) - (b[i] as number);
			};
			const inRows = [...onScreen].sort(cmp);
			if (inRows.some((h, i) => h !== onScreen[i])) reordered++;
			expect(shownHits(paired, true).map(posKey), `seed ${seed}`).toEqual(
				inRows.map(posKey),
			);
		}
		expect(hidden).toBeGreaterThan(0);
		expect(reordered).toBeGreaterThan(0);
	});
});

describe("whitespace-only pairs (Ignore whitespace)", () => {
	/**
	 * A hunk: a context line, then one cluster whose removed line 2 and added
	 * line 2 differ only in whitespace (one `~` row in unified view), and an
	 * added line 3 that pairs with nothing.
	 */
	const pairFile = (oldText: string, newText: string) => {
		const f = file(0, {
			path: "a.txt",
			clusters: [
				cluster({
					removed: [oldText],
					added: [newText, "save other"],
					oldStart: 2,
					newStart: 2,
				}),
			],
		});
		const hunks: FileHunks = {
			newLineCount: 3,
			hunks: [
				{
					oldStart: 1,
					oldCount: 2,
					newStart: 1,
					newCount: 3,
					lines: [
						ctx(1, 1, "x"),
						{ kind: "del", oldNo: 2, text: oldText, clusterKey: "k" },
						{ kind: "add", newNo: 2, text: newText, clusterKey: "k" },
						{ kind: "add", newNo: 3, text: "save other", clusterKey: "k" },
					],
				},
			],
		};
		return { f, hunks };
	};
	const search = (
		term: string,
		oldText: string,
		newText: string,
		ws: boolean,
	) => {
		const { f, hunks } = pairFile(oldText, newText);
		return findInPr(term, [f], () => hunks, noContext, false, ws);
	};
	const where = (h: Hit) => `${h.side}:${h.line}:${h.col}`;

	it("unified counts a pair once, from the new text it shows; side by side counts both", () => {
		const all = search("save", "save(a) save", "  save(a)  save", true);
		expect(all.map(where)).toEqual([
			"LEFT:2:0",
			"LEFT:2:8",
			"RIGHT:2:2",
			"RIGHT:2:11",
			"RIGHT:3:0",
		]);
		expect(all.filter((h) => h.twin !== undefined).map(where)).toEqual([
			"LEFT:2:0",
			"LEFT:2:8",
		]);
		expect(all[0]?.twin).toBe(2);
		expect(shownHits(all, true).map(where)).toEqual([
			"RIGHT:2:2",
			"RIGHT:2:11",
			"RIGHT:3:0",
		]);
		expect(shownHits(all, false)).toBe(all);
		// The tree's per-file count follows the shown hits too.
		expect(countsByFile(shownHits(all, true)).get(0)).toBe(3);
	});

	it("with Ignore whitespace off both sides count in either view", () => {
		const all = search("save", "save(a) save", "  save(a)  save", false);
		expect(all.some((h) => h.twin !== undefined)).toBe(false);
		expect(shownHits(all, true)).toBe(all);
		expect(all).toHaveLength(5);
	});

	it("a line that isn't a whitespace-only pair keeps its old side", () => {
		const all = search("save", "save(a)", "save(b)", true);
		expect(shownHits(all, true).map(where)).toEqual([
			"LEFT:2:0",
			"RIGHT:2:0",
			"RIGHT:3:0",
		]);
	});

	it("unified steps through a cluster in the order of its rows: a `~` row where it sits", () => {
		// Removed A, B, C; added B' (B re-indented), D. Unified shows
		// A, B~B', C, D: the pair's row between A and C.
		const del = (n: number, text: string): DiffLine => ({
			kind: "del",
			oldNo: n,
			text,
			clusterKey: "k",
		});
		const add = (n: number, text: string): DiffLine => ({
			kind: "add",
			newNo: n,
			text,
			clusterKey: "k",
		});
		const lines = [
			ctx(1, 1, "x"),
			del(2, "save(a)"),
			del(3, "  save(b)"),
			del(4, "save(c)"),
			add(2, "save(b)"),
			add(3, "save(d)"),
			ctx(5, 4, "x"),
		];
		const f = file(0, { path: "a.txt" });
		const hunks: FileHunks = {
			newLineCount: 4,
			hunks: [{ oldStart: 1, oldCount: 5, newStart: 1, newCount: 4, lines }],
		};
		const unified = findInPr("save", [f], () => hunks, noContext, false, true);
		expect(shownHits(unified, true).map(where)).toEqual([
			"LEFT:2:0",
			"RIGHT:2:0",
			"LEFT:4:0",
			"RIGHT:3:0",
		]);
		// The pair's hidden old side sits right before its row's shown hit.
		expect(unified.map(where)).toEqual([
			"LEFT:2:0",
			"LEFT:3:2",
			"RIGHT:2:0",
			"LEFT:4:0",
			"RIGHT:3:0",
		]);
		// Side by side, or Ignore whitespace off: the hunk's own order.
		const plain = findInPr("save", [f], () => hunks, noContext, false);
		expect(plain.map(where)).toEqual([
			"LEFT:2:0",
			"LEFT:3:2",
			"LEFT:4:0",
			"RIGHT:2:0",
			"RIGHT:3:0",
		]);
		// Stepping goes down the screen: from A to the `~` row, then C.
		const shown = shownHits(unified, true);
		const caret = stepCaret(
			shown,
			{ pos: { index: 0, side: "LEFT", line: 2, col: 0 }, shown: true },
			1,
		);
		expect(caret?.pos).toEqual({ index: 0, side: "RIGHT", line: 2, col: 0 });
	});

	it("a hunk's hits all come out even should its rows miss a line", () => {
		const a: DiffLine = {
			kind: "del",
			oldNo: 1,
			text: "save",
			clusterKey: "k",
		};
		const b: DiffLine = {
			kind: "add",
			newNo: 1,
			text: "save",
			clusterKey: "k",
		};
		const c: DiffLine = {
			kind: "add",
			newNo: 2,
			text: "save",
			clusterKey: "k",
		};
		const hit = (side: "LEFT" | "RIGHT", line: number): Hit => ({
			index: 0,
			side,
			line,
			col: 0,
			len: 4,
		});
		const byLine = new Map([
			[a, [hit("LEFT", 1)]],
			[b, [hit("RIGHT", 1)]],
			[c, [hit("RIGHT", 2)]],
		]);
		const out: Hit[] = [];
		// Rows that lost `a` (a regression in viewRuns would): still emitted.
		emitHunk(out, [a, b, c], byLine, {
			order: [b, c],
			twins: new Map(),
		});
		expect(out.map(where)).toEqual(["RIGHT:1:0", "RIGHT:2:0", "LEFT:1:0"]);
		expect(byLine.size).toBe(0);
	});

	it("without hunks yet (clusters only), nothing is paired", () => {
		const { f } = pairFile("save", "  save");
		const all = findInPr("save", [f], none, noContext, false, true);
		expect(shownHits(all, true)).toHaveLength(3);
	});

	it("a hidden old-side hit moves to the same row's hit of the same order", () => {
		const all = search("save", "save(a) save", "  save(a)  save", true);
		const shown = shownHits(all, true);
		const second = { index: 0, side: "LEFT" as const, line: 2, col: 8 };
		expect(hiddenHitMoved(all, shown, second)).toEqual({
			pos: { index: 0, side: "RIGHT", line: 2, col: 11 },
			sameRow: true,
		});
		expect(keptCaret(all, shown, { pos: second, shown: true })).toEqual({
			pos: { index: 0, side: "RIGHT", line: 2, col: 11 },
			shown: true,
		});
		// A hit still shown stays as it is.
		const caret: Caret = {
			pos: { ...second, side: "RIGHT", col: 2 },
			shown: false,
		};
		expect(keptCaret(all, shown, caret)).toBe(caret);
		// A hit gone altogether isn't moved.
		expect(
			keptCaret(all, shown, { pos: { ...second, line: 9 }, shown: true }),
		).toBeNull();
	});

	it("when the row shows fewer hits, the row's first; with none, the next hit after it", () => {
		// "a b" twice on the old side, once on the new ("ab" doesn't match).
		const fewer = search("a b", "a b a b", "a b ab", true);
		const shownFewer = shownHits(fewer, true);
		expect(
			hiddenHitMoved(fewer, shownFewer, {
				index: 0,
				side: "LEFT",
				line: 2,
				col: 4,
			}),
		).toEqual({
			pos: { index: 0, side: "RIGHT", line: 2, col: 0 },
			sameRow: true,
		});
		// None on the new side ("saveother"): the next shown hit, line 3's.
		const spaced = search("e o", "save other", "saveother", true);
		expect(spaced.map(where)).toEqual(["LEFT:2:3", "RIGHT:3:3"]);
		expect(
			hiddenHitMoved(spaced, shownHits(spaced, true), {
				index: 0,
				side: "LEFT",
				line: 2,
				col: 3,
			}),
		).toEqual({
			pos: { index: 0, side: "RIGHT", line: 3, col: 3 },
			sameRow: false,
		});
		// A caret moved off its row is unshown: the next step goes to it.
		const moved = keptCaret(spaced, shownHits(spaced, true), {
			pos: { index: 0, side: "LEFT", line: 2, col: 3 },
			shown: true,
		});
		expect(moved).toEqual({
			pos: { index: 0, side: "RIGHT", line: 3, col: 3 },
			shown: false,
		});
		expect(stepCaret(shownHits(spaced, true), moved, 1)).toEqual({
			pos: { index: 0, side: "RIGHT", line: 3, col: 3 },
			shown: true,
		});
	});
});

describe("whitespace pairing's cost (a re-indented PR)", () => {
	// Files of one hunk of 1,000 lines re-indented: 1,000 removed and 1,000
	// added lines, every one a whitespace-only pair. `header`: one more
	// added line on top, so the sides' keys differ and the DP runs (1M cells
	// per hunk) rather than the equal-keys fast path.
	const N = 1000;
	const reindent = (count: number, from: number, header: boolean) =>
		Array.from({ length: count }, (_, k) => {
			const i = from + k;
			const lines: DiffLine[] = [
				...Array.from(
					{ length: N },
					(_, j): DiffLine => ({
						kind: "del",
						oldNo: j + 1,
						text: `value_${j} = old(${j})`,
						clusterKey: "k",
					}),
				),
				...(header
					? [
							{
								kind: "add",
								newNo: 1,
								text: "# header",
								clusterKey: "k",
							} as DiffLine,
						]
					: []),
				...Array.from(
					{ length: N },
					(_, j): DiffLine => ({
						kind: "add",
						newNo: j + 1 + (header ? 1 : 0),
						text: `    value_${j} = old(${j})`,
						clusterKey: "k",
					}),
				),
			];
			const newCount = N + (header ? 1 : 0);
			return {
				f: file(i, { path: `src/reindent${i}.py` }),
				hunks: {
					newLineCount: newCount,
					hunks: [{ oldStart: 1, oldCount: N, newStart: 1, newCount, lines }],
				} as FileHunks,
			};
		});
	const cpu = (run: () => void) => {
		const t = process.threadCpuUsage();
		run();
		const { user, system } = process.threadCpuUsage(t);
		return (user + system) / 1000;
	};
	const setOf = (xs: ReturnType<typeof reindent>) => ({
		files: xs.map((x) => x.f),
		hunksOf: (f: FileView) => xs.find((x) => x.f.index === f.index)?.hunks,
		lines: xs.map((x) => x.hunks.hunks[0]?.lines ?? []),
	});

	it("a wholesale re-indent pairs in linear time; no hunk is paired without a removed-line hit, nor twice", () => {
		const whole = setOf(reindent(30, 0, false));
		// A term on paths only: as cheap as not pairing at all.
		const plain = cpu(() =>
			findInPr("reindent", whole.files, whole.hunksOf, noContext, false),
		);
		const lazy = cpu(() =>
			findInPr("reindent", whole.files, whole.hunksOf, noContext, false, true),
		);
		// A term on every line: every hunk paired (equal keys: the fast path).
		let hits: Hit[] = [];
		const first = cpu(() => {
			hits = findInPr(
				"value",
				whole.files,
				whole.hunksOf,
				noContext,
				false,
				true,
			);
		});
		const again = cpu(() =>
			findInPr("value", whole.files, whole.hunksOf, noContext, false, true),
		);
		// A re-indent with one line added (the DP), and the diff's rows
		// (HunkRows' viewRuns) after Find: its matching reused, not redone.
		const partial = setOf(reindent(10, 100, true));
		const dp = cpu(() =>
			findInPr("value", partial.files, partial.hunksOf, noContext, false, true),
		);
		const rows = cpu(() => {
			for (const lines of partial.lines) viewRuns(lines, true);
		});
		console.info(
			`whitespace pairing CPU ms: plain ${plain.toFixed(1)}, lazy (no del hit) ${lazy.toFixed(1)}, first paired (fast path) ${first.toFixed(1)}, again ${again.toFixed(1)}, DP (10 hunks) ${dp.toFixed(1)}, HunkRows after the DP ${rows.toFixed(1)}`,
		);
		expect(shownHits(hits, true)).toHaveLength(30 * N);
		expect(hits.filter((h) => h.twin !== undefined)).toHaveLength(30 * N);
		// Bounds against the plain search over the same lines (no pairing):
		// the O(n²) DP over these 30 hunks was ~25× plain.
		expect(lazy).toBeLessThan(plain * 5 + 20);
		expect(first).toBeLessThan(plain * 10 + 50);
		expect(again).toBeLessThan(plain * 10 + 50);
		expect(rows).toBeLessThan(dp / 5);
	});
});

describe("findInPr over a moved pair (step 2, unified B)", () => {
	it.each([true, false])(
		"steps through case 3's hits in the order shown (Ignore whitespace %s)",
		(ws) => {
			const del = (n: number, text: string): DiffLine => ({
				kind: "del",
				oldNo: n,
				text,
				clusterKey: "k",
			});
			const add = (n: number, text: string): DiffLine => ({
				kind: "add",
				newNo: n,
				text,
				clusterKey: "k",
			});
			const lines = [
				ctx(20, 20, "x"),
				del(21, "retry(getUser, 3)"),
				del(22, "log(msg)"),
				del(23, "retry(getOrders, 3)"),
				add(21, "retry(getUser, 5)"),
				add(22, "retry(getOrders, 5)"),
				ctx(24, 23, "y"),
			];
			const f = file(0, { path: "a.txt" });
			const hunks: FileHunks = {
				newLineCount: 23,
				hunks: [
					{ oldStart: 20, oldCount: 5, newStart: 20, newCount: 4, lines },
				],
			};
			const hits = findInPr(
				"retry",
				[f],
				() => hunks,
				noContext,
				false,
				true,
				true,
				ws,
			);
			const shown = shownHits(hits, true).map(
				(h) => `${h.side === "LEFT" ? "old" : "new"} ${h.line}`,
			);
			expect(shown).toEqual(["old 21", "new 21", "old 23", "new 22"]);
			// The oracle: the rows HunkRows renders.
			const oracle = viewRuns(lines, ws)
				.flatMap((r) => r.rows)
				.flatMap((r) => (r.kind === "line" ? [r.line] : []))
				.filter((l) => l.text.startsWith("retry"))
				.map((l) => (l.kind === "del" ? `old ${l.oldNo}` : `new ${l.newNo}`));
			expect(oracle).toEqual(shown);
		},
	);
});
