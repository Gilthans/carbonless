import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Cluster, pairingClusters } from "../../../test/pairing-fixtures";
import type { DiffLine } from "../../shared/types";
import { alignCluster } from "./linePairing";
import { orderRun, type Partners } from "./pairOrder";
import { type DiffRow, hunkView } from "./whitespace";

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
const partners = (...pairs: [DiffLine, DiffLine][]): Partners => {
	const m = new Map<DiffLine, DiffLine>();
	for (const [d, a] of pairs) {
		m.set(d, a);
		m.set(a, d);
	}
	return m;
};
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
				const m = new Map<DiffLine, DiffLine>();
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
						m.set(ds[di] as DiffLine, as[aj] as DiffLine);
						m.set(as[aj] as DiffLine, ds[di] as DiffLine);
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
