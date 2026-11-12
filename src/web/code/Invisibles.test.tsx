// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bestCpuRatio, repeat } from "../../../test/cpu";
import { Settings } from "../Settings";
import {
	CodeLine,
	colorPieces,
	copyWithOriginals,
	INVISIBLES_STORAGE_KEY,
	rangeText,
	readShowInvisibles,
	resetShowInvisibles,
	setShowInvisibles,
	splitMarks,
	type Token,
} from "./Invisibles";
import { renderInvisibles } from "./invisibleChars";

function renderLine(props: Parameters<typeof CodeLine>[0]) {
	const client = new QueryClient();
	return render(
		<QueryClientProvider client={client}>
			<Settings />
			<code data-testid="line" className="whitespace-pre">
				<CodeLine {...props} />
			</code>
		</QueryClientProvider>,
	);
}

const line = () => screen.getByTestId("line");
/** The Settings switch, opening Settings first. */
async function hiddenCharacters(): Promise<HTMLElement> {
	const gear = screen.getByRole("button", { name: "Settings" });
	if (gear.getAttribute("aria-expanded") !== "true")
		await userEvent.click(gear);
	return screen.getByRole("switch", { name: "Show hidden characters" });
}
/** What the reader sees: each marker's generated glyph instead of its character. */
const seen = (el: Element): string =>
	Array.from(el.childNodes)
		.map((node) => {
			if (node.nodeType === Node.TEXT_NODE) return node.textContent;
			const element = node as HTMLElement;
			return element.dataset.inv !== undefined
				? (element.dataset.glyph ?? "")
				: seen(element);
		})
		.join("");
const kinds = () =>
	Array.from(line().querySelectorAll<HTMLElement>("[data-inv]")).map(
		(e) => e.dataset.inv,
	);

beforeEach(() => {
	localStorage.clear();
	resetShowInvisibles();
});
afterEach(cleanup);

describe("CodeLine", () => {
	it("draws spaces, tabs and line endings, keeping the original text in the DOM", () => {
		const text = "\tif (a  b)\r";
		renderLine({ text, lang: null });
		expect(seen(line())).toBe("\\tif (a··b)\\r\\n");
		// The copyable text is the original, character for character.
		expect(line().textContent).toBe(text);
		const tab = line().querySelector<HTMLElement>('[data-inv="tab"]');
		expect(tab?.style.width).toBe("4ch");
	});

	it("uses the file's tab width, and no ending without a newline", () => {
		renderLine({ text: "a\tb", lang: null, tabWidth: 8, newline: false });
		expect(seen(line())).toBe("a\\tb");
		expect(
			line().querySelector<HTMLElement>('[data-inv="tab"]')?.style.width,
		).toBe("7ch");
	});

	it("escapes invisibles, tinting and naming bidi controls", () => {
		const text = 'x = "\u202Eabc\u200B\u00A0"';
		renderLine({ text, lang: null, newline: false });
		expect(seen(line())).toBe('x = "\\u202Eabc\\u200B\\u00A0"');
		expect(line().textContent).toBe(text);
		const bidi = line().querySelector<HTMLElement>('[data-inv="bidi"]');
		expect(bidi).toHaveAccessibleName(/U\+202E right-to-left override/);
		expect(bidi?.className).toMatch(/text-warn/);
		expect(
			line().querySelector<HTMLElement>('[data-inv="escape"]'),
		).toHaveAccessibleName("U+200B zero width space");
	});

	it("names an escape in a tooltip on hover and tap, with no element until then", async () => {
		renderLine({ text: "a\u200Bb", lang: null, newline: false });
		const tips = () =>
			Array.from(document.querySelectorAll('[role="tooltip"]')).filter((t) =>
				t.textContent?.includes("U+200B"),
			);
		expect(tips()).toHaveLength(0);
		const marker = line().querySelector<HTMLElement>('[data-inv="escape"]');
		if (!marker) throw new Error("no escape");
		await userEvent.hover(marker);
		await waitFor(() =>
			expect(tips().map((t) => t.textContent)).toEqual([
				"U+200B zero width space",
			]),
		);
		await userEvent.unhover(marker);
		await waitFor(() => expect(tips()).toHaveLength(0));
		// A tap focuses it (no tab stop), which opens the tooltip.
		expect(marker.tabIndex).toBe(-1);
		act(() => marker.focus());
		expect(tips().map((t) => t.textContent)).toEqual([
			"U+200B zero width space",
		]);
	});

	it("keeps highlighting, split around the markers", async () => {
		const text = "const  x\t= 1;";
		renderLine({ text, lang: "typescript", newline: false });
		await waitFor(() =>
			expect(line().querySelector("span[style*='color']")).not.toBeNull(),
		);
		expect(line().textContent).toBe(text);
		expect(seen(line())).toBe("const··x\\t= 1;");
		const colored = Array.from(
			line().querySelectorAll<HTMLElement>("span[style*='color']"),
		);
		expect(colored.map((s) => s.textContent)).toContain("const");
	});

	it("keeps everything after a lone CR when highlighting", async () => {
		const text = "let a\rb = 2;";
		renderLine({ text, lang: "typescript", newline: false });
		await waitFor(() =>
			expect(line().querySelector("span[style*='color']")).not.toBeNull(),
		);
		expect(line().textContent).toBe(text);
		expect(seen(line())).toBe("let a\\rb = 2;");
	});

	it("hides whitespace with hidden characters off but still escapes what would be invisible", async () => {
		const text = "\ta b\u202E\u200B\u00A0\u2066\r";
		renderLine({ text, lang: null });
		await userEvent.click(await hiddenCharacters());
		expect(await hiddenCharacters()).toHaveAttribute("aria-checked", "false");
		expect(seen(line())).toBe("a b\\u202E\\u200B\\u00A0\\u2066");
		expect(kinds()).toEqual(["tab", "bidi", "escape", "escape", "bidi", "eol"]);
		expect(line().textContent).toBe(text);
	});
});

describe("a thread's span on a line (marks)", () => {
	it("paints exactly the marked characters, markers included, and copies the same text", () => {
		renderLine({ text: "a\tbc😀d", lang: null, marks: [[1, 6]] });
		const marked = [...line().querySelectorAll("[data-span-mark]")];
		expect(marked.map((m) => m.textContent).join("")).toBe("\tbc😀");
		expect(marked[0]?.querySelector('[data-inv="tab"]')).not.toBeNull();
		// One code element, holding exactly the line's characters.
		expect(line().querySelector("[data-code]")?.textContent).toBe("a\tbc😀d");
	});

	it("splits text at the marks' edges", () => {
		expect(splitMarks("abcdef", 10, [[12, 14]])).toEqual([
			{ text: "ab", marked: false },
			{ text: "cd", marked: true },
			{ text: "ef", marked: false },
		]);
		expect(splitMarks("abc", 0, [[0, 9]])).toEqual([
			{ text: "abc", marked: true },
		]);
		expect(splitMarks("abc", 0, [])).toEqual([{ text: "abc", marked: false }]);
	});
});

describe("find marks on a line (finds)", () => {
	it("paints find marks on their characters, the current one apart, over a thread span", () => {
		renderLine({
			text: "a save save",
			lang: null,
			marks: [[2, 6]],
			finds: [
				{ from: 2, to: 6, current: false },
				{ from: 7, to: 11, current: true },
			],
		});
		const mark = line().querySelector("[data-find-mark]");
		expect(mark?.textContent).toBe("save");
		expect(mark?.hasAttribute("data-span-mark")).toBe(false);
		expect(line().querySelector("[data-find-current]")?.textContent).toBe(
			"save",
		);
		expect(line().querySelector("[data-code]")?.textContent).toBe(
			"a save save",
		);
	});

	it("a find mark over a hidden-character marker wraps the marker", () => {
		renderLine({
			text: "a  b",
			lang: null,
			finds: [{ from: 1, to: 3, current: false }],
		});
		const wrap = line().querySelector("[data-find-mark]");
		expect(wrap).not.toBeNull();
		expect(wrap?.querySelector('[data-inv="space"]')).not.toBeNull();
	});

	it("a find over part of a run of spaces wraps only its own dots", () => {
		renderLine({
			text: "a    b",
			lang: null,
			newline: false,
			finds: [{ from: 2, to: 4, current: true }],
		});
		const wraps = [...line().querySelectorAll("[data-find-current]")];
		expect(wraps).toHaveLength(1);
		expect(
			wraps[0]?.querySelector('[data-inv="space"]')?.getAttribute("data-glyph"),
		).toBe("··");
		expect(seen(line())).toBe("a····b");
		expect(line().querySelector("[data-code]")?.textContent).toBe("a    b");
	});

	it("thread spans, word marks and finds on one line: span over word, find inside a word's tint", () => {
		// "ab  cd efgh": a thread span over "cd", a word mark over "  cd efgh",
		// hits on "c" (in the span), "fg" (in the word) and the second space
		// (a marker in the word).
		renderLine({
			text: "ab  cd efgh",
			lang: null,
			newline: false,
			marks: [[4, 6]],
			words: { marks: [[2, 11]], tone: "add" },
			finds: [
				{ from: 4, to: 5, current: false },
				{ from: 8, to: 10, current: true },
				{ from: 3, to: 4, current: false },
			],
		});
		const inSpan = [...line().querySelectorAll("[data-find-mark]")].find(
			(m) => m.textContent === "c",
		);
		expect(inSpan).toBeDefined();
		expect(inSpan?.closest("[data-word]")).toBeNull();
		const current = line().querySelector("[data-find-current]");
		expect(current?.textContent).toBe("fg");
		expect(current?.closest("[data-word]")).not.toBeNull();
		const marker = line().querySelector('[data-find-mark] [data-inv="space"]');
		expect(marker?.getAttribute("data-glyph")).toBe("·");
		expect(marker?.closest("[data-word]")).not.toBeNull();
		expect(line().querySelector("[data-code]")?.textContent).toBe(
			"ab  cd efgh",
		);
	});

	it("splits text at the finds' edges, a current one winning where it overlaps", () => {
		expect(
			splitMarks(
				"abcdef",
				0,
				[],
				[
					{ from: 1, to: 4, current: false },
					{ from: 3, to: 5, current: true },
				],
			),
		).toEqual([
			{ text: "a", marked: false },
			{ text: "bc", marked: false, find: "mark" },
			{ text: "d", marked: false, find: "current" },
			{ text: "e", marked: false, find: "current" },
			{ text: "f", marked: false },
		]);
	});

	it("paints a find hit inside a word mark's tint, the current hit on top", () => {
		const text = "const userCount = 1;";
		renderLine({
			text,
			lang: null,
			words: { marks: [[6, 15]], tone: "add" },
			finds: [{ from: 10, to: 17, current: true }],
		});
		// The overlapped characters carry both: the word tint outside, the
		// current hit's paint inside it (so it shows on top).
		const inWord = line().querySelector("[data-word] [data-find-current]");
		expect(inWord?.textContent).toBe("Count");
		expect(inWord?.closest("[data-word]")).toHaveClass("bg-add-word");
		expect(inWord).toHaveClass("find-current");
		// The hit goes on past the word, without a tint there.
		const hits = [...line().querySelectorAll("[data-find-current]")];
		expect(hits.map((h) => h.textContent).join("")).toBe("Count =");
		expect(hits[1]?.closest("[data-word]")).toBeNull();
		expect(
			[...line().querySelectorAll("[data-word]")]
				.map((w) => w.textContent)
				.join(""),
		).toBe("userCount");
		expect(line().querySelector("[data-code]")?.textContent).toBe(text);
	});
});

describe("a pair's word marks on a line (words)", () => {
	const words = () =>
		Array.from(line().querySelectorAll<HTMLElement>("[data-word]"));

	it("tints exactly the marked characters, synchronously, under the syntax colors", async () => {
		const text = "const userCount = 1;";
		renderLine({
			text,
			lang: "typescript",
			words: { marks: [[6, 15]], tone: "add" },
		});
		// Painted with the first render, before any highlighting arrives.
		expect(words().map((w) => w.textContent)).toEqual(["userCount"]);
		await waitFor(() =>
			expect(line().querySelector("span[style*='color']")).not.toBeNull(),
		);
		expect(words().map((w) => w.textContent)).toEqual(["userCount"]);
		const [word] = words();
		expect(word).toHaveClass("bg-add-word");
		// The syntax color sits inside the tint: background only.
		expect(word?.querySelector("span[style*='color']")).not.toBeNull();
		expect(word?.getAttribute("style")).toBeNull();
		expect(line().querySelector("[data-code]")?.textContent).toBe(text);
	});

	it("keeps each mark its own element, one tone per line", () => {
		renderLine({
			text: "a + b - c",
			lang: null,
			words: {
				marks: [
					[0, 1],
					[8, 9],
				],
				tone: "del-done",
			},
		});
		expect(words().map((w) => w.textContent)).toEqual(["a", "c"]);
		for (const w of words()) expect(w).toHaveClass("bg-del-word-done");
	});

	it("marks the invisibles inside a mark with it, so a changed indent shows as tinted dots", () => {
		const text = "        if (x)";
		renderLine({
			text,
			lang: null,
			newline: false,
			words: { marks: [[4, 8]], tone: "add" },
		});
		expect(words().map((w) => w.textContent)).toEqual(["    "]);
		const [word] = words();
		expect(word?.querySelector('[data-inv="space"]')).toHaveAttribute(
			"data-glyph",
			"····",
		);
		expect(seen(line())).toBe("········if (x)");
		expect(line().querySelector("[data-code]")?.textContent).toBe(text);
	});

	it("tints a CRLF ending's marker when the mark covers its \\r", () => {
		const text = "const a = 1;\r";
		renderLine({
			text,
			lang: null,
			words: { marks: [[12, 13]], tone: "add" },
		});
		const [word] = words();
		expect(word?.querySelector('[data-inv="eol"]')).toHaveAttribute(
			"data-glyph",
			"\\r\\n",
		);
		expect(words()).toHaveLength(1);
		expect(line().querySelector("[data-code]")?.textContent).toBe(text);
	});

	it("lets a thread's span win where they overlap, the word tint showing outside it", () => {
		const text = "const userCount = 1;";
		renderLine({
			text,
			lang: null,
			marks: [[10, 20]],
			words: { marks: [[6, 15]], tone: "add" },
		});
		expect(words().map((w) => w.textContent)).toEqual(["user"]);
		const spans = [...line().querySelectorAll("[data-span-mark]")];
		expect(spans.map((m) => m.textContent).join("")).toBe("Count = 1;");
		expect(
			line().querySelector(
				"[data-word] [data-span-mark], [data-span-mark] [data-word], [data-word][data-span-mark]",
			),
		).toBeNull();
		expect(line().querySelector("[data-code]")?.textContent).toBe(text);
	});

	it("labels a kept emoji selector or joiner inside a mark while hidden characters show, never outside (owner, 2026-11-04)", async () => {
		// Case 65's pets ZWJ (marked), then an unmarked family and smile.
		const text = "🐶\u200D🐱 👨\u200D👩 😀\uFE0F\tx";
		renderLine({
			text,
			lang: null,
			newline: false,
			words: { marks: [[2, 3]], tone: "add" },
		});
		const [word] = words();
		expect(word?.querySelector('[data-inv="escape"]')).toHaveAttribute(
			"data-glyph",
			"\\u200D",
		);
		expect(
			word?.querySelector('[data-inv="escape"]')?.getAttribute("aria-label"),
		).toBe("U+200D zero width joiner");
		// 2 + 6 + 2 + 1 + 2 + 1 + 2 = 16: the tab's marker takes a full stop.
		expect(seen(line())).toBe("🐶\\u200D🐱 👨\u200D👩 😀\uFE0F\\tx");
		expect(kinds()).toEqual(["escape", "tab"]);
		// Copy gives the raw characters back.
		const range = document.createRange();
		range.selectNodeContents(line().querySelector("[data-code]") as Node);
		expect(rangeText(range)).toBe(text);
		// Off: the emoji stay whole, the mark draws nothing.
		await userEvent.click(await hiddenCharacters());
		expect(seen(line())).toBe(text.replace("\t", ""));
		expect(kinds()).toEqual(["tab"]);
		expect(line().querySelector("[data-code]")?.textContent).toBe(text);
	});

	it("copies the original text", () => {
		const text = "\tlet  a\u00A0=  b;";
		renderLine({
			text,
			lang: null,
			words: { marks: [[1, 9]], tone: "del" },
		});
		const range = document.createRange();
		range.selectNodeContents(line().querySelector("[data-code]") as Node);
		expect(rangeText(range)).toBe(text);
	});
});

describe("colorPieces", () => {
	it("cuts text pieces by the tokens they overlap", () => {
		const pieces = renderInvisibles("const  x = 1;", 4, { newline: false });
		const tokens: Token[] = [
			{ content: "const", offset: 0, color: "red" },
			{ content: "  x ", offset: 5 },
			{ content: "=", offset: 9, color: "blue" },
			{ content: " 1;", offset: 10 },
		];
		const out = colorPieces(pieces, tokens);
		const texts = pieces.map((p, i) =>
			p.kind === "text"
				? (out[i] ?? []).map((s) => `${s.token?.color ?? ""}:${s.text}`)
				: p.kind,
		);
		// A lone space between printing characters stays in its text run,
		// which the tokens then cut.
		expect(texts).toEqual([["red:const"], "space", [":x ", "blue:=", ": 1;"]]);
	});

	it("is linear in the pieces and tokens of a 100 KB line", () => {
		const line = (repeats: number) => {
			const text = "let a = b;  ".repeat(repeats);
			const tokens: Token[] = [];
			for (let at = 0; at < text.length; at += 3) {
				tokens.push({ content: text.slice(at, at + 3), offset: at });
			}
			return { text, tokens };
		};
		const long = line(9000);
		const short = line(2250);
		const color = ({ text, tokens }: typeof long) =>
			colorPieces(renderInvisibles(text, 4), tokens);
		// CPU against four lines a quarter as long (CLAUDE.md): linear is
		// about 1x, a quadratic pass 4x.
		const { ratio } = bestCpuRatio(
			() => color(long),
			repeat(4, () => color(short)),
		);
		console.info(`colorPieces: a 4x line in ${ratio.toFixed(2)}x the CPU`);
		expect(ratio).toBeLessThan(2);
		const pieces = renderInvisibles(long.text, 4);
		const out = colorPieces(pieces, long.tokens);
		const joined = pieces
			.map((p, i) =>
				p.kind === "text" ? (out[i] ?? []).map((s) => s.text).join("") : p.raw,
			)
			.join("");
		expect(joined).toBe(long.text);
	});
});

describe("copying", () => {
	function table(rows: string[]) {
		const client = new QueryClient();
		return render(
			<QueryClientProvider client={client}>
				<table>
					<tbody>
						{rows.map((text, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: static rows
							<tr key={i} data-testid="row">
								<td className="select-none">{i + 1}</td>
								<td className="whitespace-pre">
									<span className="select-none">+</span>
									<CodeLine text={text} lang={null} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</QueryClientProvider>,
		);
	}

	/** Copies the selection, giving what lands on the clipboard. */
	function copy(): { plain?: string; html?: string; prevented: boolean } {
		const data = new Map<string, string>();
		const event = new Event("copy", { cancelable: true }) as ClipboardEvent;
		Object.defineProperty(event, "clipboardData", {
			value: {
				setData: (type: string, value: string) => data.set(type, value),
			},
		});
		copyWithOriginals(event);
		return {
			plain: data.get("text/plain"),
			html: data.get("text/html"),
			prevented: event.defaultPrevented,
		};
	}

	function select(start: [Node, number], end: [Node, number]) {
		const range = document.createRange();
		range.setStart(...start);
		range.setEnd(...end);
		const selection = document.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
	}

	/** The text node holding `text` inside the n-th row's code. */
	function textNode(row: number, text: string): Text {
		const rows = screen.getAllByTestId("row");
		const walker = document.createTreeWalker(
			rows[row] as Node,
			NodeFilter.SHOW_TEXT,
		);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if ((n as Text).data.includes(text)) return n as Text;
		}
		throw new Error(`no ${text}`);
	}

	it("keeps no-break spaces in a partial, multi-line selection, without touching the DOM", () => {
		table(["let a\u00A0= 1;", "b\u202F c", "x\u3000y"]);
		const before = document.body.innerHTML;
		// "let a" is one text node: a lone space between letters gets no dot.
		select([textNode(0, "let a"), 4], [textNode(2, "y"), 1]);
		const copied = copy();
		expect(copied.prevented).toBe(true);
		expect(copied.plain).toBe("a\u00A0= 1;\nb\u202F c\nx\u3000y");
		expect(copied.html).toContain("1;");
		expect(document.body.innerHTML).toBe(before);
		const selection = document.getSelection();
		expect(selection?.anchorNode).toBe(textNode(0, "let a"));
		expect(selection?.toString()).toContain("1;");
	});

	it("starts inside a no-break space's own element", () => {
		table(["a\u00A0b"]);
		const nbsp = line0Escape();
		select([nbsp, 0], [nbsp, 1]);
		expect(copy().plain).toBe("\u00A0");
	});

	it("leaves a copy without blanks to the browser", () => {
		table(["let a = 1;"]);
		select([textNode(0, "let"), 0], [textNode(0, "1;"), 1]);
		const copied = copy();
		expect(copied.prevented).toBe(false);
		expect(copied.plain).toBeUndefined();
	});

	function line0Escape(): Text {
		const span = document.querySelector('[data-inv="escape"] > span');
		return span?.firstChild as Text;
	}
});

describe("the hidden-characters setting", () => {
	it("is on by default and remembered", async () => {
		expect(readShowInvisibles()).toBe(true);
		renderLine({ text: "a  b", lang: null });
		const toggle = await hiddenCharacters();
		expect(toggle).toHaveAttribute("aria-checked", "true");
		await userEvent.click(toggle);
		expect(localStorage.getItem(INVISIBLES_STORAGE_KEY)).toBe("off");
		cleanup();
		resetShowInvisibles();
		renderLine({ text: "a  b", lang: null });
		expect(await hiddenCharacters()).toHaveAttribute("aria-checked", "false");
		expect(kinds()).toEqual([]);
		act(() => setShowInvisibles(true));
		expect(kinds()).toEqual(["space", "eol"]);
		expect(localStorage.getItem(INVISIBLES_STORAGE_KEY)).toBe("on");
	});

	it("shows everything when storage is unavailable", () => {
		const getItem = Storage.prototype.getItem;
		Storage.prototype.getItem = () => {
			throw new Error("blocked");
		};
		try {
			expect(readShowInvisibles()).toBe(true);
		} finally {
			Storage.prototype.getItem = getItem;
		}
	});
});
