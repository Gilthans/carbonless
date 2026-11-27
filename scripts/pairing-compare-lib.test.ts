import { describe, expect, it } from "vitest";
import {
	byWorst,
	byWorstGroups,
	type ClusterLayouts,
	changedByStep2,
	esc,
	farthestMove,
	groupIndexes,
	hasGroups,
	markup,
} from "./pairing-compare-lib";

const layouts = (over: Partial<ClusterLayouts> = {}): ClusterLayouts => ({
	today: [
		[0, 2],
		[1, 3],
		[null, 4],
	],
	step2: [
		[0, null],
		[1, 2],
		[null, 3],
		[null, 4],
	],
	todayUnified: [0, 1, 2, 3, 4],
	step2Unified: [0, 1, 2, 3, 4],
	pairs: [[1, 2]],
	todayPairs: [],
	...over,
});

describe("changedByStep2", () => {
	it("is false when rows, unified order and pairs all match today's", () => {
		const l = layouts();
		expect(
			changedByStep2({ ...l, step2: l.today, pairs: [], todayPairs: [] }),
		).toBe(false);
	});
	it("is true when a pair moves rows", () => {
		expect(changedByStep2(layouts())).toBe(true);
	});
	it("is true when only the unified order differs", () => {
		const l = layouts();
		expect(
			changedByStep2({
				...l,
				step2: l.today,
				pairs: [],
				step2Unified: [0, 2, 1, 3, 4],
			}),
		).toBe(true);
	});
	it("is true when only the pairs differ (a mark appears)", () => {
		const l = layouts();
		expect(changedByStep2({ ...l, step2: l.today, pairs: [[0, 2]] })).toBe(
			true,
		);
	});
});

describe("farthestMove", () => {
	it("is the rows between a pair's lines today", () => {
		// line 1 sat on row 1, line 2 on row 0: one row apart
		expect(farthestMove(layouts())).toBe(1);
		expect(farthestMove(layouts({ pairs: [[0, 4]] }))).toBe(2);
	});
	it("is 0 without pairs", () => {
		expect(farthestMove(layouts({ pairs: [] }))).toBe(0);
	});
});

describe("byWorst", () => {
	const c = (minScore: number, move: number, size: number) => ({
		minScore,
		move,
		size,
	});
	it("sorts lowest score, then farthest move, then biggest cluster", () => {
		const sorted = [
			c(0.9, 5, 9),
			c(0.5, 1, 2),
			c(0.5, 3, 2),
			c(0.5, 3, 8),
			c(Infinity, 0, 99),
		].sort(byWorst);
		expect(sorted).toEqual([
			c(0.5, 3, 8),
			c(0.5, 3, 2),
			c(0.5, 1, 2),
			c(0.9, 5, 9),
			c(Infinity, 0, 99),
		]);
	});
});

describe("esc and markup (third-party code reaches the page's HTML)", () => {
	it("escapes markup characters, quotes and ampersands", () => {
		expect(esc(`<script>alert("x" + 'y' & z)</script>`)).toBe(
			"&lt;script&gt;alert(&quot;x&quot; + &#39;y&#39; &amp; z)&lt;/script&gt;",
		);
	});
	it("escapes inside a marked range and across its boundaries", () => {
		// marks cover `b<` and `>c`: a < inside one, a > starting the other
		const text = "a<b<>c</d>";
		const html = markup(text, [
			[2, 4],
			[4, 6],
		]);
		expect(html).toBe("a&lt;<mark>b&lt;</mark><mark>&gt;c</mark>&lt;/d&gt;");
		// the only tags in the output are our own <mark>s
		expect(html.replace(/<\/?mark>/g, "")).not.toMatch(/[<>]/);
	});
	it("keeps text without marks and a script tag split by a mark inert", () => {
		expect(markup("<b>", undefined)).toBe("&lt;b&gt;");
		const html = markup("<script>", [[3, 5]]);
		expect(html.replace(/<\/?mark>/g, "")).toBe("&lt;scr" + "ipt&gt;");
	});
});

describe("groups page", () => {
	const line = (text: string, kind: "del" | "add") =>
		({ kind, text, oldNo: 1, newNo: 1 }) as never;
	it("turns groups into line indexes and drops one with a stray line", () => {
		const a = line("a", "del");
		const b = line("b", "add");
		const c = line("c", "add");
		const stray = line("s", "add");
		const at = new Map<never, number>([
			[a, 0],
			[b, 1],
			[c, 2],
		]);
		expect(
			groupIndexes(
				[
					{ one: a, run: [b, c] },
					{ one: a, run: [b, stray] },
				],
				at,
			),
		).toEqual([{ one: 0, run: [1, 2] }]);
	});
	it("lists a stretch only when it has a group", () => {
		expect(hasGroups([{}])).toBe(true);
		expect(hasGroups([])).toBe(false);
	});
	it("orders worst first: lowest score, then longest run, then size", () => {
		const rows = [
			{ minScore: 0.8, runLength: 9, size: 10 },
			{ minScore: 0.5, runLength: 2, size: 3 },
			{ minScore: 0.5, runLength: 4, size: 3 },
			{ minScore: 0.5, runLength: 4, size: 8 },
		];
		expect([...rows].sort(byWorstGroups)).toEqual([
			rows[3],
			rows[2],
			rows[1],
			rows[0],
		]);
	});
});
