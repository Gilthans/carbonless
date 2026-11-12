import { describe, expect, it } from "vitest";
import { type Cluster, pairingClusters } from "../../../test/pairing-fixtures";
import type { DiffLine } from "../../shared/types";
import { alignCluster } from "./linePairing";
import type { Partners } from "./pairOrder";
import { layoutRows, type SideRow, sides } from "./sideBySide";
import { type DiffRow, matchHunk, pairHunk, pairRun, runs } from "./whitespace";

const del = (oldNo: number, text: string, over: Partial<DiffLine> = {}) => ({
	kind: "del" as const,
	oldNo,
	text,
	clusterKey: "k",
	...over,
});
const add = (newNo: number, text: string, over: Partial<DiffLine> = {}) => ({
	kind: "add" as const,
	newNo,
	text,
	clusterKey: "k",
	...over,
});
const ctx = (oldNo: number, newNo: number, text: string): DiffLine => ({
	kind: "context",
	oldNo,
	newNo,
	text,
});
/** A line as the view's plain row (Ignore whitespace off, or a context run). */
const line = (line: DiffLine): DiffRow => ({ kind: "line", line });

/**
 * The layout as a readable trace: ` old/new` context, `[-old|+new]`,
 * `[-old|]`, `[|+new]`, `[~old|~new]`, `[~old|]`, `[|~new]`.
 */
const trace = (rows: SideRow[]) =>
	rows.map((r) => {
		if (r.kind === "context") return ` ${r.line.oldNo}/${r.line.newNo}`;
		const sign = r.ws ? "~" : undefined;
		const left = r.del ? `${sign ?? "-"}${r.del.oldNo}` : "";
		const right = r.add ? `${sign ?? "+"}${r.add.newNo}` : "";
		return `[${left}|${right}]`;
	});

const dels = (n: number, from = 1) =>
	Array.from({ length: n }, (_, i) => line(del(from + i, `old ${i}`)));
const adds = (n: number, from = 1) =>
	Array.from({ length: n }, (_, i) => line(add(from + i, `new ${i}`)));

/**
 * Principle 2, the spec's invariant: `sides` is the run's old side (del or
 * context lines) and new side (add or context lines) in order; the layout's
 * left cells and right cells hold exactly those, once each, on their own
 * side; a whitespace row stays one row with its own lines; no row is
 * empty; and a blank cell appears only once the other side has run out.
 */
function expectLayout(input: DiffRow[], out: SideRow[]) {
	// Each line's segment: a whitespace row (two-sided or not) and a
	// context row are pairing boundaries, so plain lines only pair within
	// their segment.
	const seg = new Map<DiffLine, number>();
	const lines: DiffLine[] = [];
	let segment = 0;
	for (const r of input) {
		if (r.kind === "ws") {
			segment++;
			for (const l of [r.del, r.add]) if (l) lines.push(l);
			segment++;
		} else if (r.line.kind === "context") {
			segment++;
			lines.push(r.line);
			segment++;
		} else {
			lines.push(r.line);
			seg.set(r.line, segment);
		}
	}
	const oldSide = lines.filter((l) => l.kind !== "add");
	const newSide = lines.filter((l) => l.kind !== "del");
	const s = sides(input);
	expect(s.left).toEqual(oldSide);
	expect(s.right).toEqual(newSide);

	const left: DiffLine[] = [];
	const right: DiffLine[] = [];
	const wsOut: { del?: DiffLine; add?: DiffLine }[] = [];
	let plain: ("two" | "left" | "right")[] = [];
	const endSegment = () => {
		// Two-sided pairs first, then one-sided ones all on one side.
		const lastTwo = plain.lastIndexOf("two");
		expect(
			plain.slice(0, lastTwo + 1).every((p) => p === "two"),
			`blank before the other side ran out: ${trace(out)}`,
		).toBe(true);
		expect(
			new Set(plain.slice(lastTwo + 1)).size <= 1,
			`blanks on both sides: ${trace(out)}`,
		).toBe(true);
		plain = [];
	};
	for (const row of out) {
		if (row.kind === "context") {
			expect(row.line.kind).toBe("context");
			left.push(row.line);
			right.push(row.line);
			endSegment();
			continue;
		}
		expect(
			row.del !== undefined || row.add !== undefined,
			`empty row in ${trace(out)}`,
		).toBe(true);
		if (row.del) {
			expect(row.del.kind).toBe("del");
			left.push(row.del);
		}
		if (row.add) {
			expect(row.add.kind).toBe("add");
			right.push(row.add);
		}
		if (row.ws) {
			wsOut.push({ del: row.del, add: row.add });
			endSegment();
		} else {
			plain.push(row.del && row.add ? "two" : row.del ? "left" : "right");
			if (row.del && row.add) {
				expect(
					seg.get(row.del),
					`paired across a boundary: ${trace(out)}`,
				).toBe(seg.get(row.add));
			}
		}
	}
	endSegment();
	// The same objects, each once, in order, on each side.
	expect(left).toEqual(oldSide);
	expect(right).toEqual(newSide);
	expect(new Set(left).size).toBe(oldSide.length);
	expect(new Set(right).size).toBe(newSide.length);
	// Every whitespace row is one row of the layout, with its own lines.
	const wsIn = input.flatMap((r) =>
		r.kind === "ws" ? [{ del: r.del, add: r.add }] : [],
	);
	expect(wsOut).toEqual(wsIn);
}

describe("layoutRows", () => {
	it("pairs the i-th removed with the i-th added, the surplus one-sided", () => {
		const two3 = [...dels(2), ...adds(3)];
		expect(trace(layoutRows(two3))).toEqual(["[-1|+1]", "[-2|+2]", "[|+3]"]);
		expectLayout(two3, layoutRows(two3));
		const three2 = [...dels(3), ...adds(2)];
		expect(trace(layoutRows(three2))).toEqual(["[-1|+1]", "[-2|+2]", "[-3|]"]);
		expectLayout(three2, layoutRows(three2));
		const one5 = [...dels(1), ...adds(5)];
		expect(trace(layoutRows(one5))).toEqual([
			"[-1|+1]",
			"[|+2]",
			"[|+3]",
			"[|+4]",
			"[|+5]",
		]);
		expectLayout(one5, layoutRows(one5));
		expect(trace(layoutRows(adds(3)))).toEqual(["[|+1]", "[|+2]", "[|+3]"]);
		expect(trace(layoutRows(dels(3)))).toEqual(["[-1|]", "[-2|]", "[-3|]"]);
		expect(layoutRows([])).toEqual([]);
		const pair = layoutRows(two3)[0];
		expect(pair).toEqual({
			kind: "pair",
			del: (two3[0] as { line: DiffLine }).line,
			add: (two3[2] as { line: DiffLine }).line,
			ws: false,
		});
	});

	it("shows a context line once on both sides", () => {
		const c = ctx(4, 4, "same");
		expect(layoutRows([line(c)])).toEqual([{ kind: "context", line: c }]);
		expect(sides([line(c)])).toEqual({ left: [c], right: [c] });
		// Context between changes ends the pairing on each side of it.
		const rows = [
			...dels(2, 1),
			...adds(1, 1),
			line(ctx(3, 2, "mid")),
			...adds(2, 3),
		];
		expect(trace(layoutRows(rows))).toEqual([
			"[-1|+1]",
			"[-2|]",
			" 3/2",
			"[|+3]",
			"[|+4]",
		]);
		expectLayout(rows, layoutRows(rows));
	});

	it("keeps a whitespace pair as one row with each side's own line and pairs the plain lines between", () => {
		// -d1 +a1 ~d2/a2 -d3 +a3: d2 and a2 whitespace-equal.
		const lines: DiffLine[] = [
			del(1, "x"),
			del(2, "a"),
			del(3, "y"),
			add(1, "p"),
			add(2, "  a"),
			add(3, "q"),
		];
		const rows = pairHunk(lines);
		expect(rows.map((r) => r.kind)).toEqual([
			"line",
			"line",
			"ws",
			"line",
			"line",
		]);
		const out = layoutRows(rows);
		expect(trace(out)).toEqual(["[-1|+1]", "[~2|~2]", "[-3|+3]"]);
		expect(out[1]).toEqual({
			kind: "pair",
			del: lines[1],
			add: lines[4],
			ws: true,
		});
		expectLayout(rows, out);

		// Unbalanced plain lines around the pair never cross it.
		const uneven: DiffLine[] = [
			del(1, "x"),
			del(2, "z"),
			del(3, "a"),
			add(1, "p"),
			add(2, "\ta"),
			add(3, "q"),
			add(4, "r"),
		];
		const unevenRows = pairHunk(uneven);
		expect(trace(layoutRows(unevenRows))).toEqual([
			"[-1|+1]",
			"[-2|]",
			"[~3|~2]",
			"[|+3]",
			"[|+4]",
		]);
		expectLayout(unevenRows, layoutRows(unevenRows));

		// A one-sided whitespace row (its twin elsewhere) faces a blank.
		const d = del(7, "  }");
		const a = add(9, "}");
		const oneSided: DiffRow[] = [
			{ kind: "ws", del: d },
			line(del(8, "gone")),
			{ kind: "ws", add: a },
		];
		expect(trace(layoutRows(oneSided))).toEqual(["[~7|]", "[-8|]", "[|~9]"]);
		expect(layoutRows(oneSided)[0]).toEqual({
			kind: "pair",
			del: d,
			ws: true,
		});
		expect(layoutRows(oneSided)[2]).toEqual({
			kind: "pair",
			add: a,
			ws: true,
		});
		expectLayout(oneSided, layoutRows(oneSided));

		// A one-sided whitespace row is a pairing boundary like a two-sided one.
		const boundary: DiffRow[] = [
			line(del(1, "x")),
			{ kind: "ws", del: del(2, "  }") },
			line(add(3, "y")),
		];
		expect(trace(layoutRows(boundary))).toEqual(["[-1|]", "[~2|]", "[|+3]"]);
		expectLayout(boundary, layoutRows(boundary));
	});

	it("lays a hunk of several clusters out run by run", () => {
		const lines: DiffLine[] = [
			ctx(1, 1, "top"),
			del(2, "a", { clusterKey: "A" }),
			add(2, "b", { clusterKey: "A" }),
			add(3, "c", { clusterKey: "A" }),
			ctx(3, 4, "mid"),
			ctx(4, 5, "mid 2"),
			del(5, "d", { clusterKey: "B" }),
			del(6, "e", { clusterKey: "B" }),
			ctx(7, 6, "end"),
		];
		const twins = matchHunk(lines);
		const out = runs(lines).flatMap((run) =>
			layoutRows(
				run.key === undefined ? run.lines.map(line) : pairRun(run.lines, twins),
			),
		);
		expect(trace(out)).toEqual([
			" 1/1",
			"[-2|+2]",
			"[|+3]",
			" 3/4",
			" 4/5",
			"[-5|]",
			"[-6|]",
			" 7/6",
		]);
		// The same from the whole hunk's flattened rows.
		expect(trace(layoutRows(pairHunk(lines)))).toEqual(trace(out));
		expectLayout(pairHunk(lines), layoutRows(pairHunk(lines)));
	});

	it("holds for any input", () => {
		// A small deterministic generator, so a failure reproduces.
		let seed = 777;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		const words = ["a", "b", "}", "if (x)"];
		const blank = ["", " ", "\t", "  "];
		const text = () => {
			const w = words[rand(words.length)] as string;
			return `${blank[rand(blank.length)]}${w}${blank[rand(blank.length)]}`;
		};
		let laidOut = 0;
		for (let n = 0; n < 300; n++) {
			const lines: DiffLine[] = [];
			let oldNo = 1;
			let newNo = 1;
			const parts = 1 + rand(4);
			for (let p = 0; p < parts; p++) {
				for (let c = rand(3); c > 0; c--) {
					lines.push(ctx(oldNo++, newNo++, text()));
				}
				const key = `k${p}`;
				const ds = Array.from({ length: rand(13) }, () =>
					del(oldNo++, text(), { clusterKey: key }),
				);
				const as = Array.from({ length: rand(13) }, () =>
					add(newNo++, text(), { clusterKey: key }),
				);
				const lastDel = ds[ds.length - 1];
				if (lastDel && rand(3) === 0) lastDel.noNewline = true;
				const lastAdd = as[as.length - 1];
				if (lastAdd && rand(3) === 0) lastAdd.noNewline = true;
				lines.push(...ds, ...as);
			}
			const twins = matchHunk(lines);
			for (const run of runs(lines)) {
				const plain = run.lines.map(line);
				expectLayout(plain, layoutRows(plain));
				laidOut++;
				if (run.key === undefined) continue;
				const paired = pairRun(run.lines, twins);
				expectLayout(paired, layoutRows(paired));
				laidOut++;
			}
			expectLayout(pairHunk(lines), layoutRows(pairHunk(lines)));
			laidOut++;
		}
		// Rows of any shape, as the type allows them (one-sided whitespace
		// rows between plain lines included), whether or not a whitespace
		// matching would produce them: the layout's contract is the rows.
		for (let n = 0; n < 300; n++) {
			const rows: DiffRow[] = [];
			let oldNo = 1;
			let newNo = 1;
			for (let k = rand(12); k > 0; k--) {
				switch (rand(6)) {
					case 0:
						rows.push(line(ctx(oldNo++, newNo++, text())));
						break;
					case 1:
						rows.push(line(del(oldNo++, text())));
						break;
					case 2:
						rows.push(line(add(newNo++, text())));
						break;
					case 3:
						rows.push({
							kind: "ws",
							del: del(oldNo++, text()),
							add: add(newNo++, text()),
						});
						break;
					case 4:
						rows.push({ kind: "ws", del: del(oldNo++, text()) });
						break;
					default:
						rows.push({ kind: "ws", add: add(newNo++, text()) });
				}
			}
			expectLayout(rows, layoutRows(rows));
			laidOut++;
		}
		expect(laidOut).toBeGreaterThan(600);
	});
});

/** Partners both ways, as hunkView gives them. */
const partnered = (...pairs: [DiffLine, DiffLine][]): Partners =>
	new Map(pairs.flatMap(([d, a]) => [[d, a] as const, [a, d] as const]));

describe("layoutRows with partners", () => {
	const D = (n: number): DiffLine => del(n, `d${n}`);
	const A = (n: number): DiffLine => add(n, `a${n}`);

	/**
	 * The gallery's case `file` (test/fixtures/pairing), cluster `at`: its
	 * lines as rows, and the pairs alignCluster makes of them.
	 */
	const galleryCase = (file: string, at = 0) => {
		const c = pairingClusters(file)[at] as Cluster;
		const ds = c.dels.map((t, i) => del(i + 1, t));
		const as = c.adds.map((t, i) => add(i + 1, t));
		const pairs = alignCluster(c.dels, c.adds).map(
			([i, j]) => [ds[i], as[j]] as [DiffLine, DiffLine],
		);
		return { rows: [...ds, ...as].map(line), pairs };
	};

	it("puts a pair on one row, gaps by position (gallery cases 2, 3, 5)", () => {
		// Case 2: the one removed line pairs with the second added.
		const c2 = galleryCase("02-comment-above.ts");
		expect(trace(layoutRows(c2.rows, partnered(...c2.pairs)))).toEqual([
			"[|+1]",
			"[-1|+2]",
		]);
		// Case 3: pairs d1-a1 and d3-a2, d2 alone between.
		const c3 = galleryCase("03-removed-middle.ts");
		expect(trace(layoutRows(c3.rows, partnered(...c3.pairs)))).toEqual([
			"[-1|+1]",
			"[-2|]",
			"[-3|+2]",
		]);
		// Case 5: seven added lines, then the pair.
		const c5 = galleryCase("05-helper-above.go");
		expect(trace(layoutRows(c5.rows, partnered(...c5.pairs)))).toEqual([
			...Array.from({ length: 7 }, (_, i) => `[|+${i + 1}]`),
			"[-1|+8]",
		]);
	});

	it("shares rows by position in a gap with lines on both sides", () => {
		const [d1, dX, d2] = [D(1), D(2), D(3)] as const;
		const [a1, aY, a2] = [A(1), A(2), A(3)] as const;
		// d1 dX d2 / a1 aY a2 with d1-a2 paired: nothing before d1; after it dX d2 / (none).
		const rows = [d1, dX, d2, a1, aY, a2].map(line);
		expect(trace(layoutRows(rows, partnered([d1, a2])))).toEqual([
			"[|+1]",
			"[|+2]",
			"[-1|+3]",
			"[-2|]",
			"[-3|]",
		]);
		// Two pairs d1-a1 and d2-a2 around a gap dX / aY.
		const p = partnered([d1, a1], [d2, a2]);
		const gapRows = [d1, dX, d2, a1, aY, a2].map(line);
		expect(trace(layoutRows(gapRows, p))).toEqual([
			"[-1|+1]",
			"[-2|+2]",
			"[-3|+3]",
		]);
	});

	it("is the same for git order and interleaved unified order", () => {
		const [d1, d2, d3] = [D(1), D(2), D(3)] as const;
		const [a1, a2] = [A(1), A(2)] as const;
		const p = partnered([d1, a1], [d3, a2]);
		const git = [d1, d2, d3, a1, a2].map(line);
		const mixed = [d1, a1, d2, d3, a2].map(line);
		expect(layoutRows(mixed, p)).toEqual(layoutRows(git, p));
		expect(trace(layoutRows(git, p))).toEqual(["[-1|+1]", "[-2|]", "[-3|+2]"]);
	});

	it("treats a partner outside the stretch or the rows as unpaired", () => {
		const [d1, a1] = [D(1), A(1)] as const;
		const c = ctx(2, 2, "mid");
		const stranger = A(9);
		const rows = [line(d1), line(c), line(a1)];
		expect(trace(layoutRows(rows, partnered([d1, a1])))).toEqual([
			"[-1|]",
			" 2/2",
			"[|+1]",
		]);
		expect(trace(layoutRows([line(d1)], partnered([d1, stranger])))).toEqual([
			"[-1|]",
		]);
	});

	it("lays out gallery cases 1, 4 and 6", () => {
		// Case 1: 'beta' -> 'beta,' + 'gamma'.
		const c1 = galleryCase("01-list-item.ts");
		expect(trace(layoutRows(c1.rows, partnered(...c1.pairs)))).toEqual([
			"[-1|+1]",
			"[|+2]",
		]);
		// Case 4: no pairs, today's layout.
		const c4 = galleryCase("04-nothing-similar.ts");
		expect(c4.pairs).toEqual([]);
		expect(layoutRows(c4.rows, new Map())).toEqual(layoutRows(c4.rows));
		expect(trace(layoutRows(c4.rows, new Map()))).toEqual(["[-1|+1]", "[|+2]"]);
		// Case 6: Clear's old signature is on one row with Touch's, after the
		// fourteen lines of the new functions.
		const c6 = galleryCase("06-clear-touch.go");
		expect(trace(layoutRows(c6.rows, partnered(...c6.pairs)))).toEqual([
			...Array.from({ length: 14 }, (_, i) => `[|+${i + 1}]`),
			"[-1|+15]",
		]);
	});

	it("keeps every line once, in order, when partners cross", () => {
		const [d1, d2, a1, a2] = [
			del(1, "x"),
			del(2, "y"),
			add(1, "y"),
			add(2, "x"),
		];
		const out = layoutRows(
			[d1, d2, a1, a2].map(line),
			partnered([d1, a2], [d2, a1]),
		);
		const left = out.flatMap((r) =>
			r.kind === "pair" && r.del ? [r.del] : [],
		);
		const right = out.flatMap((r) =>
			r.kind === "pair" && r.add ? [r.add] : [],
		);
		expect(left).toEqual([d1, d2]);
		expect(right).toEqual([a1, a2]);
	});

	it("keeps every line once, in order, a pair on one row, for random partners", () => {
		let seed = 4242;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return (seed >>> 8) % n;
		};
		let twoSidedGaps = 0;
		for (let n = 0; n < 500; n++) {
			const ds = Array.from({ length: rand(9) }, (_, i) => D(i + 1));
			const as = Array.from({ length: rand(9) }, (_, i) => A(i + 1));
			// Random non-crossing partners.
			const pairs: [DiffLine, DiffLine][] = [];
			let ai = 0;
			for (const d of ds) {
				if (ai < as.length && rand(2) === 0) {
					const j = ai + rand(as.length - ai);
					pairs.push([d, as[j] as DiffLine]);
					ai = j + 1;
				}
			}
			const git = [...ds, ...as].map(line);
			const out = layoutRows(git, partnered(...pairs));
			const left = out.flatMap((r) =>
				r.kind === "pair" && r.del ? [r.del] : [],
			);
			const right = out.flatMap((r) =>
				r.kind === "pair" && r.add ? [r.add] : [],
			);
			expect(left).toEqual(ds);
			expect(right).toEqual(as);
			// Rows per stretch: each gap's max(dels, adds), plus the pairs.
			let expected = pairs.length;
			let di = 0;
			let ai2 = 0;
			for (const [d, a] of [...pairs, [undefined, undefined] as const]) {
				const dj = d ? ds.indexOf(d) : ds.length;
				const aj = a ? as.indexOf(a) : as.length;
				expected += Math.max(dj - di, aj - ai2);
				if (dj - di > 0 && aj - ai2 > 0) twoSidedGaps++;
				di = dj + 1;
				ai2 = aj + 1;
			}
			expect(out.length).toBe(expected);
			for (const [d, a] of pairs) {
				expect(
					out.some((r) => r.kind === "pair" && r.del === d && r.add === a),
				).toBe(true);
			}
			// Interleaved input lays out the same.
			const mixed: DiffRow[] = [];
			for (let i = 0; i < Math.max(ds.length, as.length); i++) {
				if (ds[i]) mixed.push(line(ds[i] as DiffLine));
				if (as[i]) mixed.push(line(as[i] as DiffLine));
			}
			expect(layoutRows(mixed, partnered(...pairs))).toEqual(out);
		}
		expect(twoSidedGaps).toBeGreaterThan(50);
	});
});
