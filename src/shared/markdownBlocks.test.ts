import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bestCpuRatio } from "../../test/cpu";
import { blockOfLine, isMarkdownPath, markdownBlocks } from "./markdownBlocks";

const blocks = (text: string) =>
	markdownBlocks(text.split("\n")).map(({ kind, from, to }) => ({
		kind,
		from,
		to,
	}));

describe("markdownBlocks", () => {
	it("paragraphs, ATX and setext headings", () => {
		expect(blocks("p1\n\np2\n\n# H")).toEqual([
			{ kind: "paragraph", from: 1, to: 1 },
			{ kind: "paragraph", from: 3, to: 3 },
			{ kind: "heading", from: 5, to: 5 },
		]);
		expect(blocks("Title\n=====\n\ntext")).toEqual([
			{ kind: "heading", from: 1, to: 2 },
			{ kind: "paragraph", from: 4, to: 4 },
		]);
		expect(blocks("a\n\n---\n\nb")[1]).toEqual({ kind: "hr", from: 3, to: 3 });
	});

	it("one block per list item, nested apart from the parent", () => {
		const bs = markdownBlocks("- a\n- b\n  - c\n- d".split("\n"));
		expect(bs.map(({ kind, from, to }) => ({ kind, from, to }))).toEqual([
			{ kind: "list-item", from: 1, to: 1 },
			{ kind: "list-item", from: 2, to: 2 },
			{ kind: "list-item", from: 3, to: 3 },
			{ kind: "list-item", from: 4, to: 4 },
		]);
		expect(bs.map((b) => b.depth)).toEqual([0, 0, 1, 0]);
	});

	it("a list item with a continuation paragraph is one block", () => {
		expect(blocks("- a\n\n  more")).toEqual([
			{ kind: "list-item", from: 1, to: 3 },
		]);
	});

	it("a table: header with delimiter, then a block per row", () => {
		expect(blocks("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |")).toEqual([
			{ kind: "table-row", from: 1, to: 2 },
			{ kind: "table-row", from: 3, to: 3 },
			{ kind: "table-row", from: 4, to: 4 },
		]);
	});

	it("a fenced block is never split", () => {
		expect(blocks("```\na\n\n# not heading\n```\n\nx")).toEqual([
			{ kind: "code", from: 1, to: 5 },
			{ kind: "paragraph", from: 7, to: 7 },
		]);
	});

	it("blockquote contents are blocks", () => {
		const bs = markdownBlocks("> p1\n>\n> - x".split("\n"));
		expect(bs.map(({ kind, from, to }) => ({ kind, from, to }))).toEqual([
			{ kind: "paragraph", from: 1, to: 1 },
			{ kind: "list-item", from: 3, to: 3 },
		]);
		expect(bs[1]?.depth).toBe(1);
	});

	it("front matter, raw html and definitions", () => {
		expect(blocks("---\ntitle: x\n---\n# H")).toEqual([
			{ kind: "front-matter", from: 1, to: 3 },
			{ kind: "heading", from: 4, to: 4 },
		]);
		expect(blocks("<div>\nx\n</div>")).toEqual([
			{ kind: "html", from: 1, to: 3 },
		]);
		expect(blocks("[a]: http://x")).toEqual([{ kind: "def", from: 1, to: 1 }]);
		expect(blocks("a\n\n---\n\nb")).toHaveLength(3); // not front matter below line 1
	});

	it("CRLF gives the same ranges", () => {
		const doc = "# H\n\n- a\n  - b\n\n| a |\n|---|\n| 1 |\n\n```\nx\n```";
		expect(markdownBlocks(doc.split("\n").map((l) => `${l}\r`))).toEqual(
			markdownBlocks(doc.split("\n")),
		);
	});

	it("a lone \\r inside a line does not shift later ranges", () => {
		expect(
			markdownBlocks(["a\rb", "", "c"]).map(({ kind, from, to }) => ({
				kind,
				from,
				to,
			})),
		).toEqual([
			{ kind: "paragraph", from: 1, to: 1 },
			{ kind: "paragraph", from: 3, to: 3 },
		]);
	});

	it("a list item's tail after a nested list starts at its first text line", () => {
		expect(blocks("- a\n  - b\n\n  cont\n- c")).toEqual([
			{ kind: "list-item", from: 1, to: 1 },
			{ kind: "list-item", from: 2, to: 2 },
			{ kind: "list-item", from: 4, to: 4 },
			{ kind: "list-item", from: 5, to: 5 },
		]);
	});

	describe("hostile input falls back to a paragraph per run of lines", () => {
		const fallbackOk = (lines: string[]) => {
			const bs = markdownBlocks(lines);
			expect(bs).toEqual([
				{ kind: "paragraph", from: 1, to: lines.length, depth: 0 },
			]);
		};
		it("deeply nested list markers", () =>
			fallbackOk([`${"- ".repeat(5000)}x`]));
		it("deeply nested quotes", () => fallbackOk([`${"> ".repeat(5000)}x`]));
		it("a staircase of indented items costs about a flat document of the same size", () => {
			const stairs = Array.from(
				{ length: 2000 },
				(_, i) => `${" ".repeat(i * 2)}- a`,
			);
			fallbackOk(stairs);
			// Same line count and indents, no nesting: the cost of the same-sized input.
			const flat = Array.from(
				{ length: 2000 },
				(_, i) => `${" ".repeat(i * 2)}a`,
			);
			const { ratio } = bestCpuRatio(
				() => markdownBlocks(stairs),
				() => markdownBlocks(flat),
			);
			expect(ratio).toBeLessThan(3);
		});
		it("runs split at blank lines and keep front matter", () => {
			const deep = "- ".repeat(5000);
			expect(
				markdownBlocks(["---", "t: 1", "---", deep, "x", "", deep]).map(
					({ kind, from, to }) => ({ kind, from, to }),
				),
			).toEqual([
				{ kind: "front-matter", from: 1, to: 3 },
				{ kind: "paragraph", from: 4, to: 5 },
				{ kind: "paragraph", from: 7, to: 7 },
			]);
		});
	});

	it("blockOfLine", () => {
		const bs = markdownBlocks("a\n\nb".split("\n"));
		expect(blockOfLine(bs, 2)).toBe(0);
		expect(blockOfLine(bs, 3)).toBe(1);
		expect(blockOfLine(markdownBlocks("\n\na".split("\n")), 1)).toBe(0);
		expect(blockOfLine([], 1)).toBe(-1);
	});

	it("isMarkdownPath", () => {
		expect(isMarkdownPath("docs/A.MD")).toBe(true);
		expect(isMarkdownPath("a.markdown")).toBe(true);
		expect(isMarkdownPath("a.mdx")).toBe(false);
	});

	it("property: sorted, non-overlapping, every non-blank line in exactly one block", () => {
		const piece = fc.constantFrom(
			"para one",
			"para two\ncontinued",
			"# Heading",
			"Setext\n======",
			"---",
			"- a\n- b\n  - c\n- d",
			"1. x\n2. y",
			"- item\n\n  more",
			"- p\n  - n1\n  - n2\n- q",
			"> quote\n>\n> - li",
			"> a\n> b",
			"| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |",
			"```\ncode\n\n# no\n```",
			"    indented\n\n    code",
			"<div>\nraw\n</div>",
			"[ref]: http://example.com",
		);
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.array(fc.tuple(piece, fc.integer({ min: 1, max: 2 })), {
					minLength: 1,
					maxLength: 8,
				}),
				(front, parts) => {
					let text = parts.map(([p, gap]) => p + "\n".repeat(gap)).join("\n");
					if (front) text = `---\ntitle: x\n---\n${text}`;
					const lines = text.split("\n");
					const bs = markdownBlocks(lines);
					for (let i = 0; i < bs.length; i++) {
						const b = bs[i];
						if (!b) continue;
						expect(b.from).toBeLessThanOrEqual(b.to);
						expect(b.to).toBeLessThanOrEqual(lines.length);
						if (i > 0) expect(b.from).toBeGreaterThan(bs[i - 1]?.to ?? 0);
					}
					lines.forEach((l, i) => {
						if (/^[\s>]*$/.test(l)) return; // blank, or an empty quote line
						const n = bs.filter((b) => b.from <= i + 1 && i + 1 <= b.to).length;
						expect(n, `line ${i + 1} of ${JSON.stringify(text)}`).toBe(1);
					});
				},
			),
			{ numRuns: 300 },
		);
	});
});
