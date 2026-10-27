import { describe, expect, it } from "vitest";
import type { DiffLine } from "../../shared/types";
import {
	type DiffRow,
	linesWhitespaceEqual,
	PAIR_CAP,
	pairWhitespace,
	stripWhitespace,
	whitespaceEqual,
	whitespaceOnly,
} from "./whitespace";

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

/** The rows as a readable trace: `-old`, `+new`, `~old/new`. */
const trace = (rows: DiffRow[]) =>
	rows.map((r) =>
		r.kind === "ws"
			? `~${r.del.oldNo}/${r.add.newNo}`
			: r.line.kind === "del"
				? `-${r.line.oldNo}`
				: `+${r.line.newNo}`,
	);

/**
 * Principle 2: whatever the pairing does, every removed and added line of
 * the cluster is in the rows exactly once, in diff order, and a pair only
 * joins whitespace-equal lines.
 */
function expectCoverage(lines: DiffLine[], rows: DiffRow[]) {
	const dels = lines.filter((l) => l.kind === "del");
	const adds = lines.filter((l) => l.kind === "add");
	const seenDels: DiffLine[] = [];
	const seenAdds: DiffLine[] = [];
	for (const row of rows) {
		if (row.kind === "ws") {
			expect(row.del.kind).toBe("del");
			expect(row.add.kind).toBe("add");
			expect(whitespaceEqual(row.del.text, row.add.text)).toBe(true);
			expect(!!row.del.noNewline).toBe(!!row.add.noNewline);
			expect(linesWhitespaceEqual(row.del, row.add)).toBe(true);
			seenDels.push(row.del);
			seenAdds.push(row.add);
		} else if (row.line.kind === "del") {
			seenDels.push(row.line);
		} else {
			seenAdds.push(row.line);
		}
	}
	// The same objects, each once, in order.
	expect(seenDels).toEqual(dels);
	expect(seenAdds).toEqual(adds);
	expect(new Set(seenDels).size).toBe(dels.length);
	expect(new Set(seenAdds).size).toBe(adds.length);
	// Between pairs, unpaired removed lines come before unpaired added ones.
	let sawAdd = false;
	for (const row of rows) {
		if (row.kind === "ws") sawAdd = false;
		else if (row.line.kind === "add") sawAdd = true;
		else expect(sawAdd, `del after add in ${trace(rows)}`).toBe(false);
	}
}

describe("stripWhitespace", () => {
	it("removes ASCII whitespace only", () => {
		expect(stripWhitespace(" a\tb\rc\vd\fe ")).toBe("abcde");
		// Unicode blanks are content, as for git -w.
		expect(stripWhitespace("a\u00A0b\u2003c\u200B")).toBe(
			"a\u00A0b\u2003c\u200B",
		);
	});

	it("compares lines whitespace-equal", () => {
		expect(whitespaceEqual("\tif (a) {", "  if (a) {")).toBe(true);
		expect(whitespaceEqual("x\r", "x")).toBe(true);
		expect(whitespaceEqual("x  ", "x")).toBe(true);
		expect(whitespaceEqual("a b", "ab")).toBe(true);
		expect(whitespaceEqual("a", "b")).toBe(false);
		expect(whitespaceEqual("a\u00A0b", "a b")).toBe(false);
		expect(whitespaceEqual("", " \t")).toBe(true);
	});
});

describe("pairWhitespace", () => {
	it("pairs a re-indented block line by line", () => {
		const lines = [
			del(1, "a"),
			del(2, "b"),
			del(3, "c"),
			add(1, "  a"),
			add(2, "  b"),
			add(3, "  c"),
		];
		const rows = pairWhitespace(lines);
		expect(trace(rows)).toEqual(["~1/1", "~2/2", "~3/3"]);
		expect(whitespaceOnly(rows)).toBe(true);
		expectCoverage(lines, rows);
	});

	it("pairs a CRLF to LF change", () => {
		const lines = [del(5, "x\r"), del(6, "y\r"), add(5, "x"), add(6, "y")];
		const rows = pairWhitespace(lines);
		expect(trace(rows)).toEqual(["~5/5", "~6/6"]);
		expect(whitespaceOnly(rows)).toBe(true);
	});

	it("pairs trailing-space removal", () => {
		const rows = pairWhitespace([del(1, "x   "), add(1, "x")]);
		expect(trace(rows)).toEqual(["~1/1"]);
	});

	it("keeps a real change as add/del rows among the pairs, in diff order", () => {
		const lines = [
			del(3, "a"),
			del(4, "b"),
			del(5, "c"),
			del(6, "d"),
			add(3, "  a"),
			add(4, "  b changed"),
			add(5, "  c"),
			add(6, "  d"),
		];
		const rows = pairWhitespace(lines);
		expect(trace(rows)).toEqual(["~3/3", "-4", "+4", "~5/5", "~6/6"]);
		expect(whitespaceOnly(rows)).toBe(false);
		expectCoverage(lines, rows);
	});

	it("puts unpaired removed lines before unpaired added ones between pairs", () => {
		const lines = [
			del(1, "a"),
			del(2, "gone"),
			del(3, "b"),
			add(1, " a"),
			add(2, "new"),
			add(3, "also new"),
			add(4, " b"),
			add(5, "tail"),
		];
		const rows = pairWhitespace(lines);
		expect(trace(rows)).toEqual(["~1/1", "-2", "+2", "+3", "~3/4", "+5"]);
		expectCoverage(lines, rows);
	});

	it("pairs duplicate lines in order", () => {
		const lines = [
			del(1, "}"),
			del(2, "}"),
			del(3, "}"),
			add(1, "  }"),
			add(2, "  }"),
		];
		const rows = pairWhitespace(lines);
		expect(trace(rows)).toEqual(["~1/1", "~2/2", "-3"]);
		expectCoverage(lines, rows);
	});

	it("leaves one-sided and empty clusters as plain rows", () => {
		expect(pairWhitespace([])).toEqual([]);
		const adds = [add(1, "a"), add(2, "b")];
		expect(trace(pairWhitespace(adds))).toEqual(["+1", "+2"]);
		expect(whitespaceOnly(pairWhitespace(adds))).toBe(false);
		const dels = [del(1, "a")];
		expect(trace(pairWhitespace(dels))).toEqual(["-1"]);
		expectCoverage(dels, pairWhitespace(dels));
	});

	it("never pairs lines that differ in more than whitespace", () => {
		const lines = [del(1, "a\u00A0b"), add(1, "a b")];
		expect(trace(pairWhitespace(lines))).toEqual(["-1", "+1"]);
	});

	it("treats a final newline lost or gained as a real change, like git -w", () => {
		// Old file ends without a newline, new one with it: a change.
		expect(
			trace(pairWhitespace([del(1, "a", { noNewline: true }), add(1, "a")])),
		).toEqual(["-1", "+1"]);
		// And the other way round.
		expect(
			trace(pairWhitespace([del(1, "a"), add(1, " a", { noNewline: true })])),
		).toEqual(["-1", "+1"]);
		// Both without one: whitespace only.
		expect(
			trace(
				pairWhitespace([
					del(1, "a", { noNewline: true }),
					add(1, "  a", { noNewline: true }),
				]),
			),
		).toEqual(["~1/1"]);
		expect(
			linesWhitespaceEqual(del(1, "a", { noNewline: true }), add(1, "a")),
		).toBe(false);
	});

	it("doesn't pair a cluster over the size cap, and does at the cap", () => {
		const big = (n: number) => [
			...Array.from({ length: n }, (_, i) => del(i + 1, `line ${i}`)),
			...Array.from({ length: n }, (_, i) => add(i + 1, `  line ${i}`)),
		];
		const over = big(PAIR_CAP + 1);
		const plain = pairWhitespace(over);
		expect(plain.every((r) => r.kind === "line")).toBe(true);
		expectCoverage(over, plain);
		const at = big(PAIR_CAP);
		const paired = pairWhitespace(at);
		expect(paired.every((r) => r.kind === "ws")).toBe(true);
		expect(paired).toHaveLength(PAIR_CAP);
	});

	it("leaves lines that aren't add or del alone", () => {
		const lines: DiffLine[] = [
			{ kind: "context", oldNo: 1, newNo: 1, text: "a" },
			del(2, "b"),
			add(2, " b"),
		];
		const rows = pairWhitespace(lines);
		expect(rows.every((r) => r.kind === "line")).toBe(true);
		expect(rows.map((r) => (r.kind === "line" ? r.line : null))).toEqual(lines);
	});

	it("covers every line exactly once for any generated cluster", () => {
		// A small deterministic generator, so a failure reproduces.
		let seed = 12345;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		const words = ["a", "b", "}", "if (x)", "return", "", "a\u00A0b"];
		const blank = ["", " ", "\t", "  ", "\r", " \t "];
		const line = () => {
			const w = words[rand(words.length)] as string;
			return `${blank[rand(blank.length)]}${w}${blank[rand(blank.length)]}`;
		};
		for (let n = 0; n < 400; n++) {
			const dels = Array.from({ length: rand(8) }, (_, i) =>
				del(i + 1, line()),
			);
			const adds = Array.from({ length: rand(8) }, (_, i) =>
				add(i + 1, line()),
			);
			// Sometimes a side's last line has no final newline.
			const lastDel = dels[dels.length - 1];
			if (lastDel && rand(3) === 0) lastDel.noNewline = true;
			const lastAdd = adds[adds.length - 1];
			if (lastAdd && rand(3) === 0) lastAdd.noNewline = true;
			const lines = [...dels, ...adds];
			const rows = pairWhitespace(lines);
			expectCoverage(lines, rows);
			expect(whitespaceOnly(rows)).toBe(
				rows.length > 0 && rows.every((r) => r.kind === "ws"),
			);
		}
	});
});
