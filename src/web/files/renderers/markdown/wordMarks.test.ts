// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { bestCpuRatio, repeat } from "../../../../../test/cpu";
import { tokenize } from "../../../../shared/tokenize";
import { renderMerged, renderSource } from "./renderBlocks";
import {
	BLOCK_DIFF_MAX,
	DEL_CLOSE,
	DEL_OPEN,
	INS_CLOSE,
	INS_OPEN,
	mdTokenEnd,
	mergedSource,
	newSide,
	oldSide,
} from "./wordMarks";

const opts = {
	image: (src: string) => `/blob?path=${encodeURIComponent(src)}`,
};

/** Readable form of a merged source: marks as `[-x-]` and `{+x+}`. */
const show = (s: string | null): string | null =>
	s === null
		? null
		: s
				.replaceAll(DEL_OPEN, "[-")
				.replaceAll(DEL_CLOSE, "-]")
				.replaceAll(INS_OPEN, "{+")
				.replaceAll(INS_CLOSE, "+}");

const ANY_SENTINEL = new RegExp(
	`[${String.fromCharCode(0xe000)}-${String.fromCharCode(0xe003)}]`,
);
const PUA = (n: number) => String.fromCharCode(0xe000 + n);

const dom = (html: string): HTMLElement => {
	const div = document.createElement("div");
	div.innerHTML = html;
	return div;
};

/** Merged and rendered; fails the test when either step says null. */
function marked(oldSrc: string, newSrc: string, kind = "paragraph" as const) {
	const merged = mergedSource(oldSrc, newSrc, kind);
	expect(merged).not.toBeNull();
	const html = renderMerged(merged as string, opts);
	expect(html).not.toBeNull();
	expect(html).not.toMatch(ANY_SENTINEL);
	return { merged: merged as string, el: dom(html as string) };
}

const texts = (el: HTMLElement, sel: string): string[] =>
	[...el.querySelectorAll(sel)].map((e) => e.textContent ?? "");

describe("mergedSource", () => {
	it("marks a changed word: removed then added, in place", () => {
		const { merged, el } = marked("the quick fox", "the slow fox");
		expect(show(merged)).toBe("the [-quick-]{+slow+} fox");
		expect(texts(el, "del.md-del")).toEqual(["quick"]);
		expect(texts(el, "ins.md-ins")).toEqual(["slow"]);
		expect(el.textContent?.trim()).toBe("the quickslow fox");
	});

	it("identical sources come back as they are, with no marks", () => {
		expect(mergedSource("a **b** c", "a **b** c", "paragraph")).toBe(
			"a **b** c",
		);
		expect(mergedSource("```\nx\n```", "```\nx\n```", "code")).toBe(
			"```\nx\n```",
		);
	});

	it("an inline code span changes as one token", () => {
		const { merged, el } = marked("use `foo(a)` here", "use `foo(b)` here");
		expect(show(merged)).toBe("use [-`foo(a)`-]{+`foo(b)`+} here");
		expect(texts(el, "del.md-del > code")).toEqual(["foo(a)"]);
		expect(texts(el, "ins.md-ins > code")).toEqual(["foo(b)"]);
		for (const code of el.querySelectorAll("code")) {
			expect(code.querySelector("del, ins")).toBeNull();
		}
	});

	it("a link changes as one token: no mark inside its URL", () => {
		const { merged, el } = marked(
			"see [docs](https://a.example/x) now",
			"see [docs](https://a.example/y) now",
		);
		expect(show(merged)).toBe(
			"see [-[docs](https://a.example/x)-]{+[docs](https://a.example/y)+} now",
		);
		const hrefs = [...el.querySelectorAll("a")].map((a) =>
			a.getAttribute("href"),
		);
		expect(hrefs).toEqual(["https://a.example/x", "https://a.example/y"]);
		expect(el.querySelector("del.md-del > a")).not.toBeNull();
		expect(el.querySelector("ins.md-ins > a")).not.toBeNull();
	});

	it("bold changes as one token", () => {
		const { merged, el } = marked("a **big** cat", "a **small** cat");
		expect(show(merged)).toBe("a [-**big**-]{+**small**+} cat");
		expect(texts(el, "del.md-del > strong")).toEqual(["big"]);
		expect(texts(el, "ins.md-ins > strong")).toEqual(["small"]);
	});

	it("a reference link, image and autolink are one token each", () => {
		for (const [a, b] of [
			["x [t][r1] y", "x [t][r2] y"],
			["x ![alt](a.png) y", "x ![alt](b.png) y"],
			["x <https://a.example> y", "x <https://b.example> y"],
		] as const) {
			const merged = show(mergedSource(a, b, "paragraph"));
			const changed = (s: string) => s.slice(2, -2);
			expect(merged).toBe(`x [-${changed(a)}-]{+${changed(b)}+} y`);
		}
	});

	it("a bare URL changed whole keeps both links and no mark in an href", () => {
		const { el } = marked(
			"go to https://a.example/x now",
			"go to https://b.example/y now",
		);
		const hrefs = [...el.querySelectorAll("a")].map((a) =>
			a.getAttribute("href"),
		);
		expect(hrefs).toEqual(["https://a.example/x", "https://b.example/y"]);
	});

	it("null for a code fence, a table row whose cells changed, a heading whose level changed", () => {
		expect(mergedSource("```\na\n```", "```\nb\n```", "code")).toBeNull();
		expect(mergedSource("| a | b |", "| a | b | c |", "table-row")).toBeNull();
		expect(mergedSource("# Title", "## Title", "heading")).toBeNull();
		expect(mergedSource("Title\n===", "Title\n---", "heading")).toBeNull();
	});

	it("an escaped backslash before the closing pipe still closes the row", () => {
		// `\\|` ends `| a | b \\|` with a real pipe: two cells, as `| a | b |`.
		expect(
			mergedSource("| a | b \\\\|", "| a | c |", "table-row"),
		).not.toBeNull();
		// `\|` is an escaped pipe, cell text: still two cells, no closing pipe.
		expect(
			mergedSource("| a | b \\|", "| a | c |", "table-row"),
		).not.toBeNull();
		// A real third cell is a change of shape.
		expect(
			mergedSource("| a | b \\\\| c |", "| a | c |", "table-row"),
		).toBeNull();
	});

	it("marks a table row with the same cell count, and a heading at the same level", () => {
		expect(show(mergedSource("| a | b |", "| a | c |", "table-row"))).toBe(
			"| a | [-b-]{+c+} |",
		);
		expect(show(mergedSource("## Old title", "## New title", "heading"))).toBe(
			"## [-Old-]{+New+} title",
		);
	});

	it("null for raw HTML, definitions, front matter, breaks and $$ math", () => {
		expect(mergedSource("<div>a</div>", "<div>b</div>", "html")).toBeNull();
		expect(mergedSource("[a]: http://x", "[a]: http://y", "def")).toBeNull();
		expect(
			mergedSource("---\na: 1\n---", "---\na: 2\n---", "front-matter"),
		).toBeNull();
		expect(mergedSource("---", "***", "hr")).toBeNull();
		expect(mergedSource("$$\na\n$$", "$$\nb\n$$", "paragraph")).toBeNull();
	});

	it("respects the line view's cut and the block cap", () => {
		const long = "a ".repeat(600);
		expect(mergedSource(`${long}x`, `${long}y`, "paragraph")).toBeNull();
		const lines = Array.from({ length: 80 }, (_, i) => `line ${i} words`);
		const big = lines.join("\n");
		expect(big.length).toBeGreaterThanOrEqual(BLOCK_DIFF_MAX / 4);
		const huge = Array.from({ length: 5 }, () => big).join("\n");
		expect(huge.length).toBeGreaterThanOrEqual(BLOCK_DIFF_MAX);
		expect(mergedSource(huge, `${huge} x`, "paragraph")).toBeNull();
		expect(mergedSource(big, `${big} x`, "paragraph")).not.toBeNull();
	});

	it("bridges spaces between two changes on both sides, as the line view does", () => {
		expect(show(mergedSource("a X Y b", "a P Q b", "paragraph"))).toBe(
			"a [-X Y-]{+P Q+} b",
		);
	});

	it("each side of the merged source is its input", () => {
		const a = "keep `x` and **y** then [l](u) end";
		const b = "keep `z` and *w* then end too";
		const m = mergedSource(a, b, "paragraph") as string;
		expect(oldSide(m)).toBe(a);
		expect(newSide(m)).toBe(b);
	});
});

describe("mdTokenEnd", () => {
	const tokens = (s: string) => {
		const out: string[] = [];
		for (let i = 0; i < s.length; ) {
			const e = mdTokenEnd(s, i);
			out.push(s.slice(i, e));
			i = e;
		}
		return out;
	};
	it("keeps spans whole and words as the line view's tokens", () => {
		expect(
			tokens('a `b c` [d](e f) **g h** ~~i~~ <b x="1"> &amp; \\* j'),
		).toEqual([
			"a",
			" ",
			"`b c`",
			" ",
			"[d](e f)",
			" ",
			"**g h**",
			" ",
			"~~i~~",
			" ",
			'<b x="1">',
			" ",
			"&amp;",
			" ",
			"\\*",
			" ",
			"j",
		]);
		expect(tokens("snake_case x")).toEqual(tokenize("snake_case x"));
		expect(tokens("* item")).toEqual(["*", " ", "item"]);
	});
});

describe("content can't forge a mark", () => {
	const forged = [
		"~~a~~",
		"<ins>b</ins>",
		'<del class="md-del">c</del>',
		'<ins class="md-ins">d</ins>',
		`lit${PUA(0)}e${PUA(1)}f${PUA(2)}g${PUA(3)}`,
	].join(" ");

	it("plain rendering never gives content the mark classes", () => {
		const el = dom(renderSource(forged, opts));
		expect(el.querySelector(".md-del, .md-ins")).toBeNull();
		expect(el.querySelectorAll("del").length).toBeGreaterThan(0);
		expect(el.querySelectorAll("ins").length).toBeGreaterThan(0);
	});

	it("in a merged block only the real change carries the mark classes", () => {
		const { el } = marked(`${forged} old`, `${forged} new`);
		expect(texts(el, ".md-del")).toEqual(["old"]);
		expect(texts(el, ".md-ins")).toEqual(["new"]);
		// Content's own sentinels show as replacement characters, not marks.
		expect(el.textContent).toContain("lit\uFFFDe\uFFFDf\uFFFDg\uFFFD");
	});

	it("content's sentinel code points never reach the merged source", () => {
		const m = mergedSource(`x${PUA(0)}y old`, `x${PUA(0)}y new`, "paragraph");
		expect(show(m)).toBe("x\uFFFDy [-old-]{+new+}");
		expect(mergedSource(PUA(1), PUA(1), "paragraph")).toBe("\uFFFD");
	});
});

describe("renderMerged", () => {
	it("splits a run at table cells: never a mark around a cell", () => {
		const merged = mergedSource(
			"| a | b |",
			"| c | d |",
			"table-row",
		) as string;
		const html = renderMerged(merged, {
			...opts,
			header: "| h1 | h2 |\n|---|---|",
		});
		expect(html).not.toBeNull();
		const el = dom(`<table>${html}</table>`);
		expect(el.querySelector("thead")).toBeNull();
		const cells = [...el.querySelectorAll("td")].map((td) => td.innerHTML);
		expect(cells).toEqual([
			'<del class="md-del">a</del><ins class="md-ins">c</ins>',
			'<del class="md-del">b</del><ins class="md-ins">d</ins>',
		]);
	});

	it("a word removed or added at a cell's end, or moved to the next cell, is marked cell by cell", () => {
		const header = "| h1 | h2 |\n|---|---|";
		for (const [a, b, want] of [
			[
				"| alpha beta | gamma |",
				"| alpha | gamma |",
				"| alpha[- beta-] | gamma |",
			],
			[
				"| alpha | gamma |",
				"| alpha | gamma delta |",
				"| alpha | gamma{+ delta+} |",
			],
			["| a b | c |", "| a | b c |", "| a[- b-] | {+b +}c |"],
		] as const) {
			const merged = mergedSource(a, b, "table-row") as string;
			expect(show(merged)).toBe(want);
			const html = renderMerged(merged, { ...opts, header });
			expect(html).not.toBeNull();
			expect(
				dom(html as string).querySelectorAll(".md-del, .md-ins"),
			).toHaveLength(want.split("[-").length + want.split("{+").length - 2);
		}
	});

	it("a run across cells, its pipe struck, is null: never a mark in a row", () => {
		// The side check says null; reparse stability of every table row that
		// does take marks is the property test's.
		const header = "| h1 | h2 |\n|---|---|";
		for (const merged of [
			`| a ${DEL_OPEN}b | c${DEL_CLOSE} |`,
			`| a ${DEL_OPEN}b | c${DEL_CLOSE}${INS_OPEN}d | e${INS_CLOSE} |`,
		]) {
			expect(renderMerged(merged, { ...opts, header })).toBeNull();
		}
	});

	it("a list item keeps its list, and a quote its quote", () => {
		const li = marked(
			"- one two",
			"- one three",
			"list-item" as "paragraph",
		).el;
		expect(li.querySelector("ul > li > del.md-del")?.textContent).toBe("two");
		const q = marked("> one two", "> one three").el;
		expect(q.querySelector("blockquote ins.md-ins")?.textContent).toBe("three");
	});

	it("null when a mark would move syntax rather than show a wrong picture", () => {
		// A struck bracket: the merged source still makes a link, the new side doesn't.
		const bracket = `${DEL_OPEN}[${DEL_CLOSE}t](u)`;
		expect(renderMerged(bracket, opts)).toBeNull();
		// Emphasis made across a removed and an added run.
		const across = `x ${DEL_OPEN}*a${DEL_CLOSE}${INS_OPEN}b*${INS_CLOSE} y`;
		expect(renderMerged(across, opts)).toBeNull();
		// A mark in a link's URL.
		const inUrl = `[t](http://x/${DEL_OPEN}a${DEL_CLOSE}${INS_OPEN}b${INS_CLOSE})`;
		expect(renderMerged(inUrl, opts)).toBeNull();
		// Unpaired.
		expect(renderMerged(`a ${DEL_OPEN}b`, opts)).toBeNull();
	});
});

describe("property: random word edits", () => {
	/** Deterministic PRNG (mulberry32). */
	function rng(seed: number) {
		let a = seed;
		return () => {
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}
	const WORDS = [
		"alpha",
		"beta",
		"gamma",
		"delta",
		"`code`",
		"**bold**",
		"*em*",
		"[link](https://x.example/p)",
		"~~gone~~",
		"omega",
	];
	const shapes: {
		kind: "paragraph" | "list-item" | "heading" | "table-row";
		wrap: (w: string[]) => string;
	}[] = [
		{ kind: "paragraph", wrap: (w) => w.join(" ") },
		{ kind: "list-item", wrap: (w) => `- ${w.join(" ")}` },
		{ kind: "heading", wrap: (w) => `## ${w.join(" ")}` },
		{ kind: "paragraph", wrap: (w) => `> ${w.join(" ")}` },
		{
			kind: "table-row",
			wrap: (w) => `| ${w.slice(0, 2).join(" ")} | ${w.slice(2).join(" ")} |`,
		},
	];
	/** The words a rendered piece of text holds, as plain text tokens. */
	const plain = (w: string) =>
		w.replace(/[`*~]/g, "").replace(/\[(\w+)\]\(.*\)/, "$1");

	it("no stray sentinel, and every old and new word shows as often as expected", () => {
		const r = rng(42);
		const pick = () => WORDS[Math.floor(r() * WORDS.length)] as string;
		let rendered = 0;
		for (let n = 0; n < 300; n++) {
			const shape = shapes[n % shapes.length] as (typeof shapes)[number];
			const a = Array.from({ length: 3 + Math.floor(r() * 4) }, pick);
			const b = [...a];
			const edits = 1 + Math.floor(r() * 3);
			for (let e = 0; e < edits; e++) {
				const at = Math.floor(r() * (b.length + 1));
				const op = r();
				if (op < 0.33 && b.length > 3) b.splice(Math.min(at, b.length - 1), 1);
				else if (op < 0.66) b.splice(at, 0, pick());
				else b[Math.min(at, b.length - 1)] = pick();
			}
			const oldSrc = shape.wrap(a);
			const newSrc = shape.wrap(b);
			const merged = mergedSource(oldSrc, newSrc, shape.kind);
			if (merged === null) continue;
			expect(merged).not.toContain("\uFFFD");
			const table = shape.kind === "table-row";
			const html = renderMerged(merged, {
				...opts,
				header: table ? "| h1 | h2 |\n|---|---|" : undefined,
			});
			if (html === null) continue;
			rendered++;
			expect(html).not.toMatch(ANY_SENTINEL);
			// What the view will set as innerHTML parses back to itself: no mark
			// the HTML parser would move (out of a row, say).
			const host = document.createElement("div");
			host.innerHTML = html;
			expect(host.innerHTML).toBe(html);
			if (table) {
				expect(host.querySelectorAll("td")).toHaveLength(2);
				expect(host.querySelector(":is(tr, tbody) > :is(del, ins)")).toBeNull();
			}
			const el = dom(html);
			// The old side: everything but the insertions; the new: but the deletions.
			const side = (drop: string) => {
				const c = el.cloneNode(true) as HTMLElement;
				for (const x of c.querySelectorAll(drop)) x.remove();
				return c.textContent ?? "";
			};
			const count = (text: string, words: string[]) => {
				const m = new Map<string, number>();
				for (const t of text.split(/[^A-Za-z]+/).filter(Boolean)) {
					m.set(t, (m.get(t) ?? 0) + 1);
				}
				const want = new Map<string, number>();
				for (const w of words.map(plain)) {
					for (const t of w.split(/[^A-Za-z]+/).filter(Boolean)) {
						want.set(t, (want.get(t) ?? 0) + 1);
					}
				}
				expect(Object.fromEntries(m)).toEqual(Object.fromEntries(want));
			};
			count(side("ins.md-ins"), a);
			count(side("del.md-del"), b);
		}
		// Every shape here takes marks (measured: 300 of 300); a null is the
		// safe fallback, never the norm.
		expect(rendered).toBe(300);
	});
});

describe("cost", () => {
	/** `lines` lines of `unit` repeated (each under the line view's cut). */
	const block = (unit: string, lines: number): string =>
		Array.from({ length: lines }, () =>
			unit.repeat(Math.floor(300 / unit.length)),
		).join("\n");

	// Openers that never close, unclosed code spans, quoted attributes, long
	// e-mail local parts and paren runs after a URL: each scanned to the end of
	// the block per opener would make a block quadratic. A scaling check
	// (test/cpu.ts): 4x the block against four runs of the quarter.
	it.each([
		"*a ",
		"[a ",
		"(a [b] ",
		"`a ``b ",
		'<a b="',
		"<!-- ",
		"a.",
		"http://x/)",
	])("tokenizing stays linear in the block: %j", (unit) => {
		const quarter = block(unit, 3);
		const full = block(unit, 12);
		expect(full.length).toBeLessThan(BLOCK_DIFF_MAX);
		expect(mergedSource(full, `${full} x`, "paragraph")).not.toBeNull();
		const { ratio } = bestCpuRatio(
			() => mergedSource(full, `${full} x`, "paragraph"),
			repeat(4, () => mergedSource(quarter, `${quarter} x`, "paragraph")),
		);
		expect(ratio).toBeLessThan(2);
	});
});
