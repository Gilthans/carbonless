import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DiffLine } from "../../shared/types";
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
	it("case 2: the comment, then the pair", () => {
		const d = del("t");
		const c = add("comment");
		const a = add("t'");
		expect(texts(orderRun(plain(d, c, a), partners([d, a])))).toEqual([
			"+comment",
			"-t",
			"+t'",
		]);
	});
	it("case 3: a pair, the dropped line, a pair", () => {
		const u = del("u");
		const log = del("log");
		const o = del("o");
		const u2 = add("u'");
		const o2 = add("o'");
		expect(
			texts(orderRun(plain(u, log, o, u2, o2), partners([u, u2], [o, o2]))),
		).toEqual(["-u", "+u'", "-log", "-o", "+o'"]);
	});
	it("case 5: the helper's added lines, then the pair", () => {
		const c = del("c");
		const h = Array.from({ length: 7 }, (_, i) => add(`h${i + 1}`));
		const c2 = add("c'");
		expect(
			texts(orderRun(plain(c, ...h, c2), partners([c, c2]))).join(" "),
		).toBe("+h1 +h2 +h3 +h4 +h5 +h6 +h7 -c +c'");
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
});
