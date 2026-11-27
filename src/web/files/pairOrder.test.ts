import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { seeded, stretchWithItems } from "../../../test/group-stretches";
import { type Cluster, pairingClusters } from "../../../test/pairing-fixtures";
import { type HunkItems, hunkItems } from "../../shared/hunkPairs";
import type { DiffLine } from "../../shared/types";
import { alignCluster } from "./linePairing";
import { orderRun, type Partners, partnersOf } from "./pairOrder";
import { layoutRows } from "./sideBySide";
import { type DiffRow, hunkView, runs } from "./whitespace";

let n = 0;
const del = (text: string, clusterKey = "k"): DiffLine => ({
	kind: "del",
	oldNo: ++n,
	text,
	clusterKey,
});
const add = (text: string, clusterKey = "k"): DiffLine => ({
	kind: "add",
	newNo: ++n,
	text,
	clusterKey,
});
const ctx = (text: string): DiffLine => ({
	kind: "context",
	oldNo: ++n,
	newNo: n,
	text,
});
const plain = (...lines: DiffLine[]): DiffRow[] =>
	lines.map((line) => ({ kind: "line", line }));
const partners = (...pairs: [DiffLine, DiffLine][]): Partners =>
	partnersOf({ pairs, groups: [] });
const texts = (rows: DiffRow[]) =>
	rows.map((r) =>
		r.kind === "line"
			? `${r.line.kind === "del" ? "-" : r.line.kind === "add" ? "+" : " "}${r.line.text}`
			: `~${r.del?.text ?? ""}|${r.add?.text ?? ""}`,
	);

describe("orderRun", () => {
	/** The gallery's case `file` (test/fixtures/pairing), cluster `at`, and its pairs. */
	const galleryCase = (file: string, at = 0) => {
		const c = pairingClusters(file)[at] as Cluster;
		const ds = c.dels.map((t) => del(t));
		const as = c.adds.map((t) => add(t));
		const pairs = alignCluster(c.dels, c.adds).map(
			([i, j]) => [ds[i], as[j]] as [DiffLine, DiffLine],
		);
		return { rows: plain(...ds, ...as), pairs };
	};
	it("case 2: the comment, then the pair", () => {
		const { rows, pairs } = galleryCase("02-comment-above.ts");
		expect(texts(orderRun(rows, partners(...pairs)))).toEqual([
			"+// seconds before a request gives up",
			"-const timeout = 30;",
			"+const timeout = 60;",
		]);
	});
	it("case 3: a pair, the dropped line, a pair", () => {
		const { rows, pairs } = galleryCase("03-removed-middle.ts");
		expect(texts(orderRun(rows, partners(...pairs)))).toEqual([
			"-\tconst user = await retry(getUser, 3);",
			"+\tconst user = await retry(getUser, 5);",
			'-\tlog("fetching orders");',
			"-\tconst orders = await retry(getOrders, 3);",
			"+\tconst orders = await retry(getOrders, 5);",
		]);
	});
	it("case 5: the helper's added lines, then the pair", () => {
		const { rows, pairs } = galleryCase("05-helper-above.go");
		const out = texts(orderRun(rows, partners(...pairs)));
		expect(out).toHaveLength(9);
		expect(out.slice(0, 7).every((t) => t.startsWith("+"))).toBe(true);
		expect(out[0]).toMatch(/^\+\/\/ flagsOr /);
		expect(out[6]).toBe("+}");
		expect(out[7]).toMatch(/^-\/\/ IsCacheSkippedForDomain /);
		expect(out[8]).toMatch(/^\+\/\/ SkipsCacheFor /);
	});
	// Provisional: these exact pairs are pinned as a regression detector
	// until the owner's pass over the real-PR comparison; a different
	// answer from the owner changes them.
	it("case 6: Clear's old signature pairs with Touch's, after the new functions", () => {
		const { rows, pairs } = galleryCase("06-clear-touch.go");
		const out = texts(orderRun(rows, partners(...pairs)));
		expect(out).toHaveLength(16);
		expect(out.slice(0, 14).every((t) => t.startsWith("+"))).toBe(true);
		expect(out[14]).toMatch(/^-func .*\) Clear\(/);
		expect(out[15]).toMatch(/^\+func .*\) Touch\(/);
	});
	it("an equal 2/2 cluster keeps its order", () => {
		const a = del("a");
		const b = del("b");
		const a2 = add("a'");
		const b2 = add("b'");
		const rows = plain(a, b, a2, b2);
		expect(texts(orderRun(rows, partners([a, a2], [b, b2])))).toEqual(
			texts(rows),
		);
	});
	it("no partners: unchanged", () => {
		const rows = plain(del("a"), add("b"), add("c"));
		expect(orderRun(rows, new Map())).toEqual(rows);
	});
	it("never moves a line across a `~` row or a context line", () => {
		const d1 = del("x1");
		const d2 = del("y");
		const a1 = add("new");
		const a2 = add("y'");
		const ws: DiffRow = { kind: "ws", del: del("w"), add: add("w") };
		const c = ctx("c");
		const rows: DiffRow[] = [
			...plain(d1, a1),
			ws,
			...plain(d2, add("z"), a2),
			...plain(c),
		];
		// d2 pairs with a2 across a stretch holding "z": z moves above d2.
		const out = orderRun(rows, partners([d2, a2]));
		expect(out[2]).toBe(ws);
		expect(out[out.length - 1]).toBe(rows[rows.length - 1]);
		expect(texts(out).slice(0, 3)).toEqual(["-x1", "+new", "~w|w"]);
		expect(texts(out).slice(3)).toEqual(["+z", "-y", "+y'", " c"]);
	});
	it("a partner in another run leaves the rows unchanged", () => {
		const d = del("a");
		const a = add("b");
		const other = add("a'", "k2");
		const rows = plain(d, a);
		expect(orderRun(rows, partners([d, other]))).toEqual(rows);
	});
	it("property: a permutation, dels and adds in order, non-plain rows in place", () => {
		const shape = fc.record({
			dels: fc.integer({ min: 0, max: 6 }),
			adds: fc.integer({ min: 0, max: 6 }),
			ws: fc.boolean(),
			picks: fc.array(fc.nat({ max: 5 }), { maxLength: 6 }),
		});
		fc.assert(
			fc.property(fc.array(shape, { minLength: 1, maxLength: 3 }), (parts) => {
				const rows: DiffRow[] = [];
				const m = new Map<DiffLine, [DiffLine, DiffLine]>();
				for (const p of parts) {
					const ds = Array.from({ length: p.dels }, () => del("d"));
					const as = Array.from({ length: p.adds }, () => add("a"));
					// Non-crossing pairs: the i-th pick is a cumulative index.
					let di = 0;
					let aj = 0;
					for (const pick of p.picks) {
						di += pick % 2;
						aj += (pick >> 1) % 3;
						if (di >= ds.length || aj >= as.length) break;
						const pair: [DiffLine, DiffLine] = [
							ds[di] as DiffLine,
							as[aj] as DiffLine,
						];
						m.set(pair[0], pair);
						m.set(pair[1], pair);
						di++;
						aj++;
					}
					rows.push(...plain(...ds, ...as));
					if (p.ws) rows.push({ kind: "ws", del: del("w"), add: add("w") });
				}
				const out = orderRun(rows, m);
				expect(new Set(out)).toEqual(new Set(rows));
				expect(out).toHaveLength(rows.length);
				rows.forEach((r, i) => {
					if (r.kind === "ws") expect(out[i]).toBe(r);
				});
				const side = (kind: "del" | "add") => (rs: DiffRow[]) =>
					rs.flatMap((r) =>
						r.kind === "line" && r.line.kind === kind ? [r.line] : [],
					);
				expect(side("del")(out)).toEqual(side("del")(rows));
				expect(side("add")(out)).toEqual(side("add")(rows));
			}),
		);
	});
});

describe("orderRun with groups (CAR-130)", () => {
	const items = (x: Partial<HunkItems>): Partners =>
		partnersOf({ pairs: [], groups: [], ...x });
	it("a split reads −one, +run…, after the gap's lines", () => {
		const one = del("f(a, b)");
		const x = add("x");
		const r = [add("f("), add("a,"), add("b)")];
		const rows = plain(one, x, ...r);
		expect(texts(orderRun(rows, items({ groups: [{ one, run: r }] })))).toEqual(
			["+x", "-f(a, b)", "+f(", "+a,", "+b)"],
		);
	});
	it("a join reads −run…, +one; the gap's removed line after it", () => {
		const r = [del("f("), del("a, b)")];
		const y = del("y");
		const one = add("f(a, b)");
		const rows = plain(...r, y, one);
		expect(texts(orderRun(rows, items({ groups: [{ one, run: r }] })))).toEqual(
			["-f(", "-a, b)", "+f(a, b)", "-y"],
		);
	});
	it("a split next to a pair: each its own block, never merged", () => {
		const p = del("p");
		const one = del("f(a, b)");
		const p2 = add("p'");
		const r = [add("f("), add("a, b)")];
		const rows = plain(p, one, p2, ...r);
		const got = items({ pairs: [[p, p2]], groups: [{ one, run: r }] });
		expect(texts(orderRun(rows, got))).toEqual([
			"-p",
			"+p'",
			"-f(a, b)",
			"+f(",
			"+a, b)",
		]);
		// And the group first, then the pair.
		const q = del("q");
		const q2 = add("q'");
		const after = plain(one, q, ...r, q2);
		const both = items({ pairs: [[q, q2]], groups: [{ one, run: r }] });
		expect(texts(orderRun(after, both))).toEqual([
			"-f(a, b)",
			"+f(",
			"+a, b)",
			"-q",
			"+q'",
		]);
	});
	it("items that share a line (a bug in hunkItems) never lose or double one, unified or side by side", () => {
		const [j1, j2] = [del("j1"), del("j2")];
		const [ja, s1, s2] = [add("ja"), add("s1"), add("s2")];
		// j2 is in a join's run and also a split's one line.
		const bad = partnersOf({
			pairs: [],
			groups: [
				{ one: ja, run: [j1, j2] },
				{ one: j2, run: [s1, s2] },
			],
		});
		const rows = plain(j1, j2, ja, s1, s2);
		const out = orderRun(rows, bad);
		expect(out).toHaveLength(rows.length);
		expect(new Set(out)).toEqual(new Set(rows));
		const side = layoutRows(rows, bad);
		expect(
			side.flatMap((r) => (r.kind === "pair" && r.del ? [r.del] : [])),
		).toEqual([j1, j2]);
		expect(
			side.flatMap((r) => (r.kind === "pair" && r.add ? [r.add] : [])),
		).toEqual([ja, s1, s2]);
	});
	it("a group with a line outside the stretch leaves it as it is", () => {
		const one = del("f(a, b)");
		const r = [add("f("), add("a, b)")];
		const c = ctx("c");
		const rows = plain(one, r[0] as DiffLine, c, r[1] as DiffLine);
		expect(orderRun(rows, items({ groups: [{ one, run: r }] }))).toEqual(rows);
	});
	it("property: a permutation, each side in order, every group's rows adjacent in its order", () => {
		const rand = seeded(130);
		let grouped = 0;
		for (let n = 0; n < 500; n++) {
			const s = stretchWithItems(rand);
			const rows = plain(...s.dels, ...s.adds);
			if (rand(3) === 0) rows.push(...plain(ctx("c")));
			const out = orderRun(rows, partnersOf(s.items));
			expect(new Set(out)).toEqual(new Set(rows));
			expect(out).toHaveLength(rows.length);
			const lines = out.flatMap((r) => (r.kind === "line" ? [r.line] : []));
			expect(lines.filter((l) => l.kind === "del")).toEqual(s.dels);
			expect(lines.filter((l) => l.kind === "add")).toEqual(s.adds);
			for (const g of s.items.groups) {
				grouped++;
				const shown =
					g.one.kind === "del" ? [g.one, ...g.run] : [...g.run, g.one];
				const at = lines.indexOf(shown[0] as DiffLine);
				expect(lines.slice(at, at + shown.length)).toEqual(shown);
			}
			for (const [d, a] of s.items.pairs) {
				expect(lines.indexOf(a)).toBeGreaterThan(lines.indexOf(d));
			}
		}
		expect(grouped).toBeGreaterThan(300);
	});
	it("hunkView: a split reads together, its lines and counts as without groups", () => {
		const LINE = "def load(path, retries=3, timeout=30):";
		const SPLIT = ["def load(", "    path,", "    retries=3,", "):"];
		const one = del(LINE);
		const other = del("print(42)");
		const run = SPLIT.map((t) => add(t));
		const lines = [ctx("a"), one, other, ...run, ctx("b")];
		for (const ws of [false, true]) {
			const v = hunkView(lines, ws);
			expect(v.items.groups).toEqual([{ one, run }]);
			expect(v.pairs).toBe(v.items.pairs);
			expect(texts(v.runs.flatMap((r) => r.rows))).toEqual([
				" a",
				`-${LINE}`,
				...SPLIT.map((t) => `+${t}`),
				"-print(42)",
				" b",
			]);
			for (const l of [one, ...run])
				expect(v.partners.get(l)).toBe(v.items.groups[0]);
			expect(v.partners.has(other)).toBe(false);
			// The items are hunkItems' over the view's runs in git order.
			expect(v.items).toEqual(
				hunkItems(runs(lines).map((r) => plain(...r.lines))),
			);
		}
	});
});

describe("hunkView", () => {
	it("orders case 3 and keeps pairs for the marks", () => {
		const lines = [
			ctx("x"),
			del("retry(getUser, 3)"),
			del("log(msg)"),
			del("retry(getOrders, 3)"),
			add("retry(getUser, 5)"),
			add("retry(getOrders, 5)"),
			ctx("y"),
		];
		for (const ws of [false, true]) {
			const v = hunkView(lines, ws);
			expect(texts(v.runs.flatMap((r) => r.rows))).toEqual([
				" x",
				"-retry(getUser, 3)",
				"+retry(getUser, 5)",
				"-log(msg)",
				"-retry(getOrders, 3)",
				"+retry(getOrders, 5)",
				" y",
			]);
			expect(v.pairs).toHaveLength(2);
			expect(v.partners.size).toBe(4);
			expect(hunkView(lines, ws)).toBe(v);
		}
		expect(hunkView(lines, true)).not.toBe(hunkView(lines, false));
	});
	it("a `~` row between a similar del and add: no pair across it, no move past it", () => {
		const d = del("retry(getUser, 3)");
		const wd = del("  w x");
		const wa = add("w x");
		const a = add("retry(getUser, 5)");
		const v = hunkView([d, wd, wa, a], true);
		const flat = v.runs.flatMap((r) => r.rows);
		expect(flat.map((r) => r.kind)).toEqual(["line", "ws", "line"]);
		expect(flat[0]).toEqual({ kind: "line", line: d });
		expect(flat[2]).toEqual({ kind: "line", line: a });
		expect(v.pairs).toEqual([]);
		expect(v.partners.size).toBe(0);
	});
	it("a pair across two adjacent cluster runs: marked, and both runs' rows unchanged", () => {
		const d = del("const timeout = 30;", "k1");
		const a = add("const timeout = 60;", "k2");
		const lines = [d, a];
		const v = hunkView(lines, false);
		// Whether a hunk can hold two clusters with no context between: if
		// runs() splits them, the pair spans runs.
		expect(v.runs).toHaveLength(2);
		expect(v.pairs).toEqual([[d, a]]);
		expect(v.runs[0]?.rows).toEqual(plain(d));
		expect(v.runs[1]?.rows).toEqual(plain(a));
	});
});

describe("principle 2 end to end: hunkView's rows, unified and side by side", () => {
	// Random hunks through the real hunkView under both Ignore whitespace
	// settings: similar lines (they pair), whitespace twins (`~` rows),
	// adjacent cluster runs without context between, and added lines under
	// another cluster's key. Whatever pairs or moves, no line is lost,
	// doubled or moved out of order or out of its run.
	const vocab = [
		"retry(getUser, 3)",
		"retry(getUser, 5)",
		"  retry(getUser, 3)",
		"log(msg)",
		"x = 1",
		"x = 2",
		"  x = 1",
		"}",
		"},",
		"",
		"const a = b",
		"foo bar baz",
	];
	const text = fc.constantFrom(...vocab);
	// A split or a join (CAR-130) at the stretch's middle: the one line last
	// of the removed lines and its run first of the added ones, or the
	// other way round. Whether it groups is hunkItems' call.
	const ONE = "call(alpha, beta, gamma)";
	const RUN = ["call(", "  alpha,", "  beta, gamma)"];
	const run = fc.record({
		context: fc.array(text, { maxLength: 2 }),
		sameKeyAsLast: fc.boolean(),
		dels: fc.array(text, { maxLength: 4 }),
		adds: fc.array(fc.record({ text, otherKey: fc.boolean() }), {
			maxLength: 4,
		}),
		group: fc.constantFrom("none", "split", "join"),
	});
	type RunShape = {
		context: string[];
		sameKeyAsLast: boolean;
		dels: string[];
		adds: { text: string; otherKey: boolean }[];
		group: "none" | "split" | "join";
	};
	const hunkOf = (runs: RunShape[]): DiffLine[] => {
		const lines: DiffLine[] = [];
		let oldNo = 1;
		let newNo = 1;
		runs.forEach((r, k) => {
			for (const t of r.context)
				lines.push({
					kind: "context",
					oldNo: oldNo++,
					newNo: newNo++,
					text: t,
				});
			const key = r.sameKeyAsLast && k > 0 ? `k${k - 1}` : `k${k}`;
			const own = (text: string) => ({ text, otherKey: false });
			const dels =
				r.group === "split"
					? [...r.dels, ONE]
					: r.group === "join"
						? [...r.dels, ...RUN]
						: r.dels;
			const adds =
				r.group === "split"
					? [...RUN.map(own), ...r.adds]
					: r.group === "join"
						? [own(ONE), ...r.adds]
						: r.adds;
			for (const t of dels)
				lines.push({ kind: "del", oldNo: oldNo++, text: t, clusterKey: key });
			for (const a of adds)
				lines.push({
					kind: "add",
					newNo: newNo++,
					text: a.text,
					clusterKey: a.otherKey ? `z${k}` : key,
				});
		});
		return lines;
	};
	it("property: every line exactly once, each side in order, no row leaves its run", () => {
		let groups = 0;
		// A wall-clock timeout only: about a second of CPU, which a loaded
		// machine stretches several times over.
		fc.assert(
			fc.property(fc.array(run, { minLength: 1, maxLength: 4 }), (shape) => {
				const lines = hunkOf(shape);
				const left = lines.filter((l) => l.kind !== "add");
				const right = lines.filter((l) => l.kind !== "del");
				for (const ws of [false, true]) {
					const v = hunkView(lines, ws);
					// The same runs, keys and lines as without groups.
					expect(v.runs.map((r) => [r.key, r.orphan, r.lines])).toEqual(
						runs(lines).map((r) => [r.key, r.orphan, r.lines]),
					);
					groups += v.items.groups.length;
					// Unified: the rows' lines, every one once.
					const shown: DiffLine[] = [];
					for (const r of v.runs) {
						const own = new Set(r.lines);
						for (const row of r.rows) {
							const got =
								row.kind === "line"
									? [row.line]
									: [row.del, row.add].filter(
											(l): l is DiffLine => l !== undefined,
										);
							for (const l of got) expect(own.has(l)).toBe(true);
							shown.push(...got);
						}
					}
					for (const g of v.items.groups) {
						const rows =
							g.one.kind === "del" ? [g.one, ...g.run] : [...g.run, g.one];
						const at = shown.indexOf(rows[0] as DiffLine);
						expect(shown.slice(at, at + rows.length)).toEqual(rows);
					}
					expect(shown).toHaveLength(lines.length);
					expect(new Set(shown).size).toBe(lines.length);
					expect(shown.filter((l) => l.kind !== "add")).toEqual(left);
					expect(shown.filter((l) => l.kind !== "del")).toEqual(right);
					// Side by side: each side's lines once, in order.
					const sl: DiffLine[] = [];
					const sr: DiffLine[] = [];
					for (const r of v.runs)
						for (const s of layoutRows(r.rows, v.partners)) {
							if (s.kind === "context") {
								sl.push(s.line);
								sr.push(s.line);
							} else {
								if (s.del) sl.push(s.del);
								if (s.add) sr.push(s.add);
							}
						}
					expect(sl).toEqual(left);
					expect(sr).toEqual(right);
				}
			}),
			{ numRuns: 1000 },
		);
		expect(groups).toBeGreaterThan(20);
	}, 60_000);
});
