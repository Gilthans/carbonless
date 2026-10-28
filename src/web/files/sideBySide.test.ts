import { describe, expect, it } from "vitest";
import type { DiffLine } from "../../shared/types";
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
	const lines = input.flatMap((r) =>
		r.kind === "ws"
			? [...(r.del ? [r.del] : []), ...(r.add ? [r.add] : [])]
			: [r.line],
	);
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
		expect(laidOut).toBeGreaterThan(300);
	});
});
