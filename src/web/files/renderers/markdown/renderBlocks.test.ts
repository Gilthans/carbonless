// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { bestCpuRatio, repeat } from "../../../../../test/cpu";
import {
	type MdBlock,
	markdownBlocks,
} from "../../../../shared/markdownBlocks";
import {
	type RenderedBlock,
	renderBlocks,
	renderSource,
	tableHeaders,
} from "./renderBlocks";

const local = (src: string) => `/blob?path=${encodeURIComponent(src)}`;
const opts = {
	image: (src: string) => (/^https?:/.test(src) ? null : local(src)),
};

const render = (text: string, o = opts): RenderedBlock[] => {
	const lines = text.split("\n");
	return renderBlocks(lines, markdownBlocks(lines), o);
};

const dom = (html: string): HTMLElement => {
	const div = document.createElement("div");
	div.innerHTML = html;
	return div;
};

/** The one block of `text`, parsed. */
const only = (text: string, o = opts): HTMLElement => {
	const out = render(text, o);
	expect(out).toHaveLength(1);
	return dom((out[0] as RenderedBlock).html);
};

describe("renderBlocks", () => {
	it("one RenderedBlock per block, in order, for Task 1's fixtures", () => {
		const fixtures = [
			"p1\n\np2\n\n# H",
			"Title\n=====\n\ntext",
			"a\n\n---\n\nb",
			"- a\n- b\n  - c\n- d",
			"- a\n\n  more",
			"| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |",
			"```\na\n\n# not heading\n```\n\nx",
			"> p1\n>\n> - x",
			"---\ntitle: x\n---\n# H",
			"<div>\nx\n</div>",
			"[a]: http://x",
			"- a\n  - b\n\n  cont\n- c",
			"- - a\n- - b",
			"1. - x\n   - y",
			"> - > a",
			"    indented\n\n    code",
			`${"- ".repeat(5000)}x`,
		];
		for (const text of fixtures) {
			const lines = text.split("\n");
			const blocks = markdownBlocks(lines);
			const out = renderBlocks(lines, blocks, opts);
			expect(
				out.map((b) => b.index),
				text,
			).toEqual(blocks.map((_, i) => i));
			for (const b of out) expect(b.html.trim(), text).not.toBe("");
		}
	});

	it("block kinds render as their elements", () => {
		const out = render("# H\n\npara *em*\n\n---\n\n```js\nx < 1\n```");
		expect(dom(out[0]?.html ?? "").querySelector("h1")?.textContent).toBe("H");
		expect(dom(out[1]?.html ?? "").querySelector("p em")?.textContent).toBe(
			"em",
		);
		expect(dom(out[2]?.html ?? "").querySelector("hr")).not.toBeNull();
		const code = dom(out[3]?.html ?? "").querySelector("pre code");
		expect(code?.textContent).toBe("x < 1\n");
		expect(code?.className).toBe("language-js");
	});

	it("a list item is an <li> in its list, keeping an ordered item's number", () => {
		const out = render("- a\n- b\n  - c\n\n3. x\n4. y");
		expect(out).toHaveLength(5);
		for (const b of out) {
			const d = dom(b.html);
			expect(d.querySelectorAll("li")).toHaveLength(1);
			expect(d.querySelector("li")?.parentElement?.tagName).toMatch(
				/^(UL|OL)$/,
			);
		}
		// The nested item, indented in the source, is still a list item (not code).
		expect(dom(out[2]?.html ?? "").querySelector("ul > li")?.textContent).toBe(
			"c",
		);
		expect(
			dom(out[3]?.html ?? "")
				.querySelector("ol")
				?.getAttribute("start"),
		).toBe("3");
		expect(
			dom(out[4]?.html ?? "")
				.querySelector("ol")
				?.getAttribute("start"),
		).toBe("4");
	});

	it("a list item's tail after its nested list is an <li> too", () => {
		const out = render("- a\n  - b\n\n  cont\n- c");
		expect(out).toHaveLength(4);
		const tail = dom(out[2]?.html ?? "");
		expect(tail.querySelector("ul > li")?.textContent?.trim()).toBe("cont");
	});

	it("a table row is a <tr> inside its table; the header block is the head", () => {
		const out = render("| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |");
		expect(out).toHaveLength(3);
		const head = dom(out[0]?.html ?? "");
		expect(
			[...head.querySelectorAll("table thead th")].map((th) => th.textContent),
		).toEqual(["a", "b"]);
		expect(head.querySelector("tbody tr")).toBeNull();
		for (const [i, cells] of [
			[1, ["1", "2"]],
			[2, ["3", "4"]],
		] as const) {
			const row = dom(out[i]?.html ?? "");
			expect(row.querySelectorAll("tr")).toHaveLength(1);
			expect(row.querySelector("thead")).toBeNull();
			const tds = [...row.querySelectorAll("table tbody tr td")];
			expect(tds.map((td) => td.textContent)).toEqual(cells);
			// The header's alignment carries to the row.
			expect(tds.map((td) => td.getAttribute("align"))).toEqual([
				"left",
				"right",
			]);
		}
	});

	it("blocks in a quote stay quoted", () => {
		const out = render("> p1\n>\n> - x\n>\n> | a |\n> |---|\n> | 1 |");
		expect(out).toHaveLength(4);
		expect(
			dom(out[0]?.html ?? "").querySelector("blockquote > p")?.textContent,
		).toBe("p1");
		expect(
			dom(out[1]?.html ?? "").querySelector("blockquote > ul > li")
				?.textContent,
		).toBe("x");
		expect(
			dom(out[3]?.html ?? "").querySelector("blockquote table tbody td")
				?.textContent,
		).toBe("1");
	});

	it("nested structures: one RenderedBlock per block, no source dropped", () => {
		const cases = [
			// A list item with a continuation paragraph.
			{ text: "- a\n\n  more", words: ["a", "more"] },
			// A list inside a blockquote.
			{ text: "> intro\n>\n> - one\n> - two", words: ["intro", "one", "two"] },
			// A table inside a list item.
			{
				text: "- item\n\n  | h |\n  |---|\n  | cell |",
				words: ["item", "h", "cell"],
			},
			// A list inside a list inside a quote, with a tail.
			{
				text: "> - a\n>   - b\n>\n>   tail\n> - c",
				words: ["a", "b", "tail", "c"],
			},
		];
		for (const { text, words } of cases) {
			const lines = text.split("\n");
			const blocks = markdownBlocks(lines);
			const out = renderBlocks(lines, blocks, opts);
			expect(
				out.map((b) => b.index),
				text,
			).toEqual(blocks.map((_, i) => i));
			const all = out.map((b) => dom(b.html).textContent).join(" ");
			for (const w of words) expect(all, text).toContain(w);
		}
		const table = render("- item\n\n  | h |\n  |---|\n  | cell |");
		expect(
			dom(table[0]?.html ?? "").querySelector("li table td")?.textContent,
		).toBe("cell");
	});

	it("front matter, raw HTML and math render as escaped source", () => {
		const [fm] = render("---\ntitle: <b>x</b>\n---\n# H");
		const fmPre = dom(fm?.html ?? "").querySelector("pre");
		expect(fmPre?.textContent).toBe("---\ntitle: <b>x</b>\n---");
		expect(fmPre?.querySelector("b")).toBeNull();

		const html = only('<div onclick="x()">\n<b>bold</b>\n</div>');
		expect(html.querySelector("pre")?.textContent).toBe(
			'<div onclick="x()">\n<b>bold</b>\n</div>',
		);
		expect(html.querySelector("div,b")).toBeNull();

		const math = only("$$\na < b\n$$");
		expect(math.querySelector("pre")?.textContent).toBe("$$\na < b\n$$");
	});

	it("a link reference definition shows its source, and references to it resolve", () => {
		const out = render("see [docs][d]\n\n[d]: https://example.com/docs");
		const a = dom(out[0]?.html ?? "").querySelector("a");
		expect(a?.getAttribute("href")).toBe("https://example.com/docs");
		expect(dom(out[1]?.html ?? "").querySelector("pre")?.textContent).toBe(
			"[d]: https://example.com/docs",
		);
	});

	it("CRLF lines render as LF ones", () => {
		const text = "# H\n\n- a\n\n| a |\n|---|\n| 1 |";
		const crlf = text.split("\n").map((l) => `${l}\r`);
		expect(renderBlocks(crlf, markdownBlocks(crlf), opts)).toEqual(
			render(text),
		);
	});

	it("hostile input renders as source, not parsed", () => {
		const deep = `${"- ".repeat(5000)}x`;
		const d = only(deep);
		expect(d.querySelector("pre")?.textContent).toBe(deep);
		expect(d.querySelector("li")).toBeNull();
	});

	it("a block whose render throws shows its escaped source; the others render", () => {
		const image = vi.fn(() => {
			throw new Error("boom");
		});
		const out = render("# H\n\n![a](p.png)\n\ntext", { image });
		expect(out).toHaveLength(3);
		expect(image).toHaveBeenCalled();
		expect(dom(out[0]?.html ?? "").querySelector("h1")).not.toBeNull();
		const pre = dom(out[1]?.html ?? "").querySelector("pre");
		expect(pre?.textContent).toBe("![a](p.png)");
		expect(dom(out[2]?.html ?? "").querySelector("p")?.textContent).toBe(
			"text",
		);
	});
});

describe("sanitizing", () => {
	// Each of these fails with its guard (DOMPurify, safeHref, the image
	// pass) taken out.
	it("a <script> in a paragraph is gone", () => {
		const d = only("hi <script>alert(1)</script> there");
		expect(d.querySelector("script")).toBeNull();
		expect(d.innerHTML).not.toContain("alert(1)");
	});

	it("a javascript: link has no href", () => {
		// Defense in depth: DOMPurify and safeHref each drop a javascript:
		// href, so this fails only with both taken out. Each guard is pinned
		// alone below (the handler on the link; "only absolute http(s)").
		for (const text of [
			"[x](javascript:alert(1))",
			'x <a href="javascript:alert(1)" onclick="alert(1)">y</a>',
		]) {
			const a = only(text).querySelector("a");
			expect(a, text).not.toBeNull();
			expect(a?.hasAttribute("href"), text).toBe(false);
		}
	});

	it("a link's own event handlers are gone (DOMPurify)", () => {
		const a = only(
			'x <a href="https://example.com/" onclick="alert(1)" onmouseover="alert(2)">y</a>',
		).querySelector("a");
		expect(a?.getAttribute("href")).toBe("https://example.com/");
		expect(a?.hasAttribute("onclick")).toBe(false);
		expect(a?.hasAttribute("onmouseover")).toBe(false);
	});

	it("only absolute http(s) links keep an href (safeHref)", () => {
		// DOMPurify lets these through; relative ones would resolve against
		// carbonless itself.
		for (const text of [
			"[x](other.md)",
			"[x](/api/reviews)",
			"[x](ftp://example.com/f)",
			"[x](mailto:a@example.com)",
		]) {
			const a = only(text).querySelector("a");
			expect(a, text).not.toBeNull();
			expect(a?.hasAttribute("href"), text).toBe(false);
		}
	});

	it("an http link keeps its href and opens in a new tab", () => {
		const a = only("[x](https://example.com/a)").querySelector("a");
		expect(a?.getAttribute("href")).toBe("https://example.com/a");
		expect(a?.getAttribute("target")).toBe("_blank");
		expect(a?.getAttribute("rel")).toBe("noreferrer noopener");
	});

	it("inline HTML loses its event handlers", () => {
		const d = only("text <img src=x onerror=alert(1)> more");
		const img = d.querySelector("img");
		expect(img).not.toBeNull();
		expect(img?.hasAttribute("onerror")).toBe(false);
		expect(d.innerHTML).not.toContain("onerror");
	});

	it("content can't bring its own buttons, data attributes, styles or ids", () => {
		const d = only(
			'x <button type="button" data-remote-src="https://evil.example/p.png" style="color:red" id="app">b</button> <span data-x="1" class="bg-red-500">s</span>',
		);
		expect(d.querySelector("button")).toBeNull();
		expect(
			d.querySelector("[data-remote-src],[data-x],[style],[id]"),
		).toBeNull();
		expect(d.querySelector("[class]")).toBeNull();
	});

	it("a remote image is a placeholder showing its URL, never loaded", () => {
		const d = only("![a](https://evil.example/p.png)");
		expect(d.querySelector("img")).toBeNull();
		expect(d.querySelector("[src]")).toBeNull();
		const button = d.querySelector("button");
		expect(button?.getAttribute("type")).toBe("button");
		expect(button?.textContent).toContain("https://evil.example/p.png");
		expect(button?.getAttribute("data-remote-src")).toBe(
			"https://evil.example/p.png",
		);
	});

	it("protocol-relative and inline-HTML remote images are placeholders too", () => {
		const image = vi.fn(local);
		for (const text of [
			"![a](//evil.example/p.png)",
			'x <img src="https://evil.example/q.png">',
			"![a](data:image/png;base64,AAAA)",
		]) {
			const d = only(text, { image });
			expect(d.querySelector("img"), text).toBeNull();
			expect(d.querySelector("button[data-remote-src]"), text).not.toBeNull();
		}
		expect(image).not.toHaveBeenCalled();
	});

	it("a src the URL parser reads as another host is a placeholder", () => {
		// The browser trims C0 controls and spaces, drops tabs and newlines
		// and reads \\ as /: each of these resolves to evil.example.
		const image = vi.fn(local);
		for (const text of [
			'x <img src="/&#9;/evil.example/p.png">',
			'x <img src="/&#10;/evil.example">',
			'x <img src="/&#13;/evil.example/p.png">',
			'x <img src="&#1;//evil.example/p.png">',
			'x <img src="\u0001//evil.example/p.png">',
			'x <img src=" \\\\evil.example/p.png">',
			'x <img src="/%2F/evil.example/p.png">',
			"![a](</\t/evil.example/p.png>)",
			"![a](\\\\\\\\evil.example/p.png)",
			"![a](%2F%2Fevil.example/p.png)",
		]) {
			const d = only(text, { image });
			expect(d.querySelector("img"), text).toBeNull();
			expect(d.querySelector("button[data-remote-src]"), text).not.toBeNull();
		}
		expect(image).not.toHaveBeenCalled();
	});

	it("image() gets the path as the browser reads it, percent-decoded", () => {
		const image = vi.fn(local);
		only("![a](img/a%20b.png)", { image });
		only('x <img src=" img/c&#9;d.png ">', { image });
		only("![a](img\\e.png)", { image });
		expect(image.mock.calls).toEqual([
			["img/a b.png"],
			["img/cd.png"],
			["img/e.png"],
		]);
	});

	it("a relative image gets the image() URL", () => {
		const image = vi.fn(local);
		const img = only("![a](img/p.png)", { image }).querySelector("img");
		expect(image).toHaveBeenCalledWith("img/p.png");
		expect(img?.getAttribute("src")).toBe(local("img/p.png"));
		expect(img?.getAttribute("alt")).toBe("a");
	});

	it("a relative image image() turns down: a still placeholder (icon, path, Not in this PR), never a button", () => {
		const d = only("![a](img/p.png)", { image: () => null });
		expect(d.querySelector("img")).toBeNull();
		// A click could load nothing (CAR-268 loads any in-repo image).
		expect(d.querySelector("button")).toBeNull();
		const still = d.querySelector(".md-local-image");
		expect(still?.textContent).toBe("img/p.png");
		expect(still?.getAttribute("title")).toBe("Not in this PR");
		expect(still?.getAttribute("role")).toBe("img");
		expect(still?.getAttribute("aria-label")).toBe("img/p.png: not in this PR");
		expect(still?.querySelector("svg")).not.toBeNull();
	});
});

describe("tableHeaders", () => {
	const table = (rows: number): MdBlock[] => [
		{ kind: "paragraph", from: 1, to: 1, depth: 0 },
		{ kind: "table-row", from: 3, to: 4, depth: 0 },
		...Array.from(
			{ length: rows },
			(_, i): MdBlock => ({
				kind: "table-row",
				from: 5 + i,
				to: 5 + i,
				depth: 0,
			}),
		),
	];

	it("each row's header, nothing for other blocks", () => {
		const bs = [
			...table(2),
			{ kind: "paragraph", from: 8, to: 8, depth: 0 },
			{ kind: "table-row", from: 10, to: 11, depth: 0 },
			{ kind: "table-row", from: 12, to: 12, depth: 0 },
		] satisfies MdBlock[];
		const h = tableHeaders(bs);
		expect(h).toEqual([
			undefined,
			bs[1],
			bs[1],
			bs[1],
			undefined,
			bs[5],
			bs[5],
		]);
	});

	it("a long table costs linear CPU, not a walk back per row", () => {
		// Scaling check (test/cpu.ts): 4x the rows against four runs of a
		// quarter; linear reads about 1x, a walk back per row 4x.
		const big = table(16_000);
		const quarter = table(4_000);
		const { ratio } = bestCpuRatio(
			() => tableHeaders(big),
			repeat(4, () => tableHeaders(quarter)),
		);
		expect(ratio).toBeLessThan(2);
	});
});

describe("renderSource", () => {
	it("renders merged source, sanitized", () => {
		const d = dom(
			renderSource("- a\n- b\n\n[x](javascript:1) <script>1</script>", opts),
		);
		expect(d.querySelectorAll("li")).toHaveLength(2);
		expect(d.querySelector("script")).toBeNull();
		expect(d.querySelector("a")?.hasAttribute("href")).toBe(false);
	});
});
