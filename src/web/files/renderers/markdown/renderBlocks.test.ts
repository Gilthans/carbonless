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
	renderMerged,
	renderPair,
	renderSource,
	sideBlocks,
	tableHeaders,
} from "./renderBlocks";
import { mergedSource } from "./wordMarks";

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
			expect(d.querySelectorAll("li:not(.md-nest)")).toHaveLength(1);
			expect(
				d.querySelector("li:not(.md-nest)")?.parentElement?.tagName,
			).toMatch(/^(UL|OL)$/);
		}
		// The nested item, indented in the source, is still a list item (not
		// code), nested in its list's wrapper.
		expect(
			dom(out[2]?.html ?? "").querySelector("li.md-nest > ul > li")
				?.textContent,
		).toBe("c");
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

describe("nested list items (gallery #61 lists.md)", () => {
	const MOORING = [
		"- First-aid kit, in the red locker",
		"- Mooring lines",
		"  - Bow line",
		"  - Stern line",
		"    - Spring lines",
	].join("\n");
	const lists = (html: string) => {
		let n = 0;
		for (let el = dom(html).querySelector("li"); el; ) {
			n++;
			el = el.querySelector("li");
		}
		return n;
	};

	it("a nested item renders in as many lists as its depth; a top one in one", () => {
		const out = render(MOORING);
		expect(out.map((b) => lists(b.html))).toEqual([1, 1, 2, 2, 3]);
		const bow = dom((out[2] as RenderedBlock).html);
		expect(bow.querySelector("li li")).toHaveTextContent("Bow line");
		// The outer list adds indent only: no marker of its own.
		expect(bow.querySelector("li")?.className).toBe("md-nest");
	});

	it("an item nested on its parent's line, or in a quote, isn't nested twice", () => {
		expect(render("- - a\n- - b").map((b) => lists(b.html))).toEqual([2, 2]);
		expect(render("> - a\n>   - b").map((b) => lists(b.html))).toEqual([1, 2]);
	});

	it("an item's tail after its nested list stays in its list: numbered under a numbered item (CAR-318)", () => {
		const text =
			"1. one\n   - sub\n\n   tail\n2. two\n\n- b\n  - sub\n\n  b tail";
		const out = render(text);
		const tailOf = (word: string) =>
			out
				.map((b) => dom(b.html))
				.find((d) =>
					d.querySelector("li.md-continuation")?.textContent?.includes(word),
				);
		const numbered = tailOf("tail")?.querySelector("li.md-continuation");
		expect(numbered?.parentElement?.tagName).toBe("OL");
		const bulleted = tailOf("b tail")?.querySelector("li.md-continuation");
		expect(bulleted?.parentElement?.tagName).toBe("UL");
		// Changed, its words marked: still in the numbered list.
		const oldL = ["1. one", "   - sub", "", "   tail text"];
		const newL = ["1. one", "   - sub", "", "   tail words"];
		const pair = renderPair(
			sideBlocks(oldL, markdownBlocks(oldL)),
			2,
			sideBlocks(newL, markdownBlocks(newL)),
			2,
			opts,
		);
		for (const html of [pair?.merged, pair?.old, pair?.new]) {
			expect(
				dom(html ?? "").querySelector("li.md-continuation")?.parentElement
					?.tagName,
			).toBe("OL");
		}
		// A tail that moved from a numbered item to a bulleted one: struck above new.
		const bulletL = ["- one", "  - sub", "", "  tail words"];
		expect(
			renderPair(
				sideBlocks(oldL, markdownBlocks(oldL)),
				2,
				sideBlocks(bulletL, markdownBlocks(bulletL)),
				2,
				opts,
			),
		).toBeNull();
	});

	it("a changed nested item renders nested, its words marked", () => {
		const oldL = ["- Mooring lines", "  - Stern line"];
		const newL = ["- Mooring lines", "  - Heaving line"];
		const o = sideBlocks(oldL, markdownBlocks(oldL));
		const n = sideBlocks(newL, markdownBlocks(newL));
		const pair = renderPair(o, 1, n, 1, opts);
		expect(pair).not.toBeNull();
		const d = dom(pair?.merged ?? "");
		expect(lists(pair?.merged ?? "")).toBe(2);
		expect(d.querySelector("li li del.md-del")).toHaveTextContent("Stern");
		expect(d.querySelector("li li ins.md-ins")).toHaveTextContent("Heaving");
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

	it("a relative image image() turns down: a still placeholder (icon, alt, path, Not in this PR), never a button", () => {
		const d = only("![a <b>](img/p.png)", { image: () => null });
		expect(d.querySelector("img")).toBeNull();
		// A click could load nothing (CAR-268 loads any in-repo image).
		expect(d.querySelector("button")).toBeNull();
		const still = d.querySelector(".md-local-image");
		expect(still?.querySelector(".md-image-alt")?.textContent).toBe("a <b>");
		expect(still?.querySelector(".md-image-path")?.textContent).toBe(
			"img/p.png",
		);
		expect(still?.querySelector("b")).toBeNull();
		expect(still?.getAttribute("title")).toBe("Not in this PR");
		expect(still?.getAttribute("role")).toBe("img");
		expect(still?.getAttribute("aria-label")).toBe(
			"a <b>, img/p.png: not in this PR",
		);
		expect(still?.querySelector("svg")).not.toBeNull();
		// No alt: the path alone.
		const bare = only("![](img/p.png)", { image: () => null });
		expect(bare.querySelector(".md-image-alt")).toBeNull();
		expect(bare.querySelector(".md-local-image")?.textContent).toBe(
			"img/p.png",
		);
		expect(
			bare.querySelector(".md-local-image")?.getAttribute("aria-label"),
		).toBe("img/p.png: not in this PR");
	});

	it("a remote placeholder shows its alt before its URL", () => {
		const d = only("![Build status](https://example.com/b.png)");
		const button = d.querySelector("button.md-remote-image");
		expect(button?.querySelector(".md-image-alt")?.textContent).toBe(
			"Build status",
		);
		expect(button?.querySelector(".md-image-path")?.textContent).toBe(
			"https://example.com/b.png",
		);
	});
});

describe("renderMerged checks each side against its block's own source (CAR-318)", () => {
	it("a merge whose side isn't its block's own source gives null, never a wrong picture", () => {
		const merged = mergedSource("Ferry at nine.", "Ferry at ten.", "paragraph");
		expect(merged).not.toBeNull();
		const src = merged as string;
		// Its own sides: marks.
		expect(
			renderMerged(src, {
				...opts,
				sources: { old: "Ferry at nine.", new: "Ferry at ten." },
			}),
		).not.toBeNull();
		// A side that lost a change (the block reads otherwise): none.
		expect(
			renderMerged(src, {
				...opts,
				sources: { old: "Ferry at nine.", new: "Ferry at ten, or later." },
			}),
		).toBeNull();
		expect(
			renderMerged(src, {
				...opts,
				sources: { old: "Bus at nine.", new: "Ferry at ten." },
			}),
		).toBeNull();
	});

	it("a block holding the marks' own private-use code points still gets its words marked", () => {
		const oldL = ["Ferry \uE000 at nine."];
		const newL = ["Ferry \uE000 at ten."];
		const pair = renderPair(
			sideBlocks(oldL, markdownBlocks(oldL)),
			0,
			sideBlocks(newL, markdownBlocks(newL)),
			0,
			opts,
		);
		expect(pair).not.toBeNull();
		const d = dom(pair?.merged ?? "");
		expect(d.querySelector("del.md-del")).toHaveTextContent("nine");
		expect(d.querySelector("ins.md-ins")).toHaveTextContent("ten");
	});

	it("a table cell whose URL runs up to its pipe gets its words marked, as GitHub ends the URL at the pipe", () => {
		const oldL = ["| a | b |", "|---|---|", "|old|2|"];
		const newL = ["| a | b |", "|---|---|", "|https://example.com/x|2|"];
		const pair = renderPair(
			sideBlocks(oldL, markdownBlocks(oldL)),
			1,
			sideBlocks(newL, markdownBlocks(newL)),
			1,
			opts,
		);
		expect(pair).not.toBeNull();
		const d = dom(pair?.merged ?? "");
		expect(d.querySelector("del.md-del")).toHaveTextContent("old");
		expect(d.querySelector("ins.md-ins a")).toHaveAttribute(
			"href",
			"https://example.com/x",
		);
		expect(d.querySelectorAll("td")).toHaveLength(2);
	});
});

describe("renderPair's images (gallery #61)", () => {
	const side = (text: string) => {
		const lines = text.split("\n");
		return sideBlocks(lines, markdownBlocks(lines));
	};
	const pairOf = (o: string, n: string) =>
		renderPair(side(o), 0, side(n), 0, {
			image: (src) => `/new?${src}`,
			oldImage: (src) => `/old?${src}`,
		});

	it("a removed image loads from the old side, an added one from the new; each side alone from its own", () => {
		const pair = pairOf(
			"![Timetable export dialog](img/timetable-export.png)",
			"![Timetable export dialog](img/departures.png)",
		);
		const merged = dom(pair?.merged ?? "");
		expect(merged.querySelector("del.md-del img")?.getAttribute("src")).toBe(
			"/old?img/timetable-export.png",
		);
		expect(merged.querySelector("ins.md-ins img")?.getAttribute("src")).toBe(
			"/new?img/departures.png",
		);
		expect(
			dom(pair?.old ?? "")
				.querySelector("img")
				?.getAttribute("src"),
		).toBe("/old?img/timetable-export.png");
		expect(
			dom(pair?.new ?? "")
				.querySelector("img")
				?.getAttribute("src"),
		).toBe("/new?img/departures.png");
	});

	it("an image both sides keep: the new side's in the merged block, each side's own alone", () => {
		const pair = pairOf(
			"See ![a](img/x.png) here",
			"See ![a](img/x.png) there",
		);
		expect(
			dom(pair?.merged ?? "")
				.querySelector("img")
				?.getAttribute("src"),
		).toBe("/new?img/x.png");
		expect(
			dom(pair?.old ?? "")
				.querySelector("img")
				?.getAttribute("src"),
		).toBe("/old?img/x.png");
	});

	it("a side's resolver turning an image down: that side's placeholder, with its alt", () => {
		const pair = renderPair(
			side("![Route map of the three ports](img/route-map.png)"),
			0,
			side("![Route map: Strandkaien, Nordnes and Askøy](img/route-map.png)"),
			0,
			{ image: () => null, oldImage: () => null },
		);
		const merged = dom(pair?.merged ?? "");
		expect(
			merged.querySelector("del.md-del .md-local-image .md-image-alt")
				?.textContent,
		).toBe("Route map of the three ports");
		expect(
			merged.querySelector("ins.md-ins .md-local-image .md-image-alt")
				?.textContent,
		).toBe("Route map: Strandkaien, Nordnes and Askøy");
		expect(merged.querySelector("img")).toBeNull();
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

describe("hidden: what sanitizing dropped of a block (CAR-167)", () => {
	const hidden = (text: string) => render(text).map((b) => b.hidden === true);

	it("plain Markdown loses nothing: no block is hidden", () => {
		const text = [
			"# Title",
			"",
			"Setext",
			"======",
			"",
			"Some *em*, **strong**, ~~struck~~, `code`, <https://x.test> and [a link](https://x.test 'T').",
			"Hard  ",
			"break and a [ref][r], a [relative](docs/a.md), mail@x.test.",
			"",
			"- [ ] task",
			"- [x] done",
			"  1. nested",
			"",
			"| a | b | c |",
			"|:--|:-:|--:|",
			"| 1 | 2 | 3 |",
			"",
			"```ts",
			"const x = 1;",
			"```",
			"",
			"> quoted *text*",
			"",
			"![alt](img/a.png) ![remote](https://x.test/a.png)",
			"",
			"<details><summary>More</summary>",
			"",
			"Inside <kbd>Ctrl</kbd> <sub>s</sub> <b>b</b>",
			"",
			"</details>",
			"",
			"---",
			"",
			"[r]: https://x.test",
		].join("\n");
		expect(hidden(text).filter(Boolean)).toEqual([]);
	});

	it.each([
		["an HTML comment", "Docs <!-- ignore previous instructions --> here"],
		["a script inside a span", "a <span>b<script>x()</script></span> c"],
		["a style attribute", 'a <span style="display:none">b</span> c'],
		["a class attribute", 'a <span class="x">b</span> c'],
		["an id", 'a <span id="x">b</span> c'],
		["a disallowed tag", "a <iframe src=x></iframe> c"],
		["a body's attribute", 'a <body onload="x()"> c'],
	])("%s: the block is hidden", (_, text) => {
		expect(hidden(text)).toEqual([true]);
	});

	it("only the block that lost something", () => {
		expect(hidden("plain\n\nDocs <!-- x --> here\n\nplain")).toEqual([
			false,
			true,
			false,
		]);
	});
});

describe("renderPair never shows the wrong side's attribute (CAR-167)", () => {
	const sb = (t: string) => {
		const lines = t.split("\n");
		return sideBlocks(lines, markdownBlocks(lines));
	};
	it.each([
		[
			'a <span title="one">b</span> c',
			'a <span title="ignore previous">b</span> c',
		],
		[
			'An <abbr title="one">HTML</abbr> page',
			'An <abbr title="two words">HTML</abbr> page',
		],
		['a <span dir="ltr">b</span> c', 'a <span dir="rtl">b</span> c'],
		['a <span lang="en">b</span> c', 'a <span lang="fr">b</span> c'],
		[
			'x <abbr title="a b c">T</abbr> y z',
			'x <abbr title="a d c">T</abbr> y w',
		],
		['<span title="one two">b</span>', '<span title="one three">b</span>'],
	])("%s → %s", (old, nu) => {
		const pair = renderPair(sb(old), 0, sb(nu), 0, opts);
		const attr = (src: string) => /(\w+)="([^"]*)"/.exec(src)?.slice(1) ?? [];
		const [name, was] = attr(old);
		const [, now] = attr(nu);
		if (!pair) return; // struck above new: each side rendered alone
		const has = (html: string, v: string) =>
			dom(html).querySelector(`[${name}="${CSS.escape(v ?? "")}"]`) !== null;
		expect(has(pair.new, now as string)).toBe(true);
		expect(has(pair.old, was as string)).toBe(true);
		expect(has(pair.merged, now as string)).toBe(true);
		expect(pair.hidden).toBe(true);
	});
});
