// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CodeLine,
	colorPieces,
	copyWithOriginals,
	INVISIBLES_STORAGE_KEY,
	InvisiblesToggle,
	readShowInvisibles,
	resetShowInvisibles,
	setShowInvisibles,
	type Token,
} from "./Invisibles";
import { renderInvisibles } from "./invisibles";

function renderLine(props: Parameters<typeof CodeLine>[0]) {
	const client = new QueryClient();
	return render(
		<QueryClientProvider client={client}>
			<InvisiblesToggle />
			<code data-testid="line" className="whitespace-pre">
				<CodeLine {...props} />
			</code>
		</QueryClientProvider>,
	);
}

const line = () => screen.getByTestId("line");
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
		expect(seen(line())).toBe("\\tif·(a··b)\\r\\n");
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
		expect(seen(line())).toBe('x·=·"\\u202Eabc\\u200B\\u00A0"');
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
		expect(seen(line())).toBe("const··x\\t=·1;");
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
		expect(seen(line())).toBe("let·a\\rb·=·2;");
	});

	it("hides whitespace with ¶ off but still escapes what would be invisible", async () => {
		const text = "\ta b\u202E\u200B\u00A0\u2066\r";
		renderLine({ text, lang: null });
		await userEvent.click(
			screen.getByRole("button", { name: "Show all characters" }),
		);
		expect(
			screen.getByRole("button", { name: "Show all characters" }),
		).toHaveAttribute("aria-pressed", "false");
		expect(seen(line())).toBe("a b\\u202E\\u200B\\u00A0\\u2066");
		expect(kinds()).toEqual(["tab", "bidi", "escape", "escape", "bidi", "eol"]);
		expect(line().textContent).toBe(text);
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
		expect(texts).toEqual([
			["red:const"],
			"space",
			[":x"],
			"space",
			["blue:="],
			"space",
			[":1;"],
		]);
	});

	it("is linear in the pieces and tokens of a 100 KB line", () => {
		const text = "let a = b;  ".repeat(9000);
		const tokens: Token[] = [];
		for (let at = 0; at < text.length; at += 3) {
			tokens.push({ content: text.slice(at, at + 3), offset: at });
		}
		const start = performance.now();
		const pieces = renderInvisibles(text, 4);
		const out = colorPieces(pieces, tokens);
		expect(performance.now() - start).toBeLessThan(200);
		const joined = pieces
			.map((p, i) =>
				p.kind === "text" ? (out[i] ?? []).map((s) => s.text).join("") : p.raw,
			)
			.join("");
		expect(joined).toBe(text);
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
		select([textNode(0, "a"), 0], [textNode(2, "y"), 1]);
		const copied = copy();
		expect(copied.prevented).toBe(true);
		expect(copied.plain).toBe("a\u00A0= 1;\nb\u202F c\nx\u3000y");
		expect(copied.html).toContain("1;");
		expect(document.body.innerHTML).toBe(before);
		const selection = document.getSelection();
		expect(selection?.anchorNode).toBe(textNode(0, "a"));
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

describe("the ¶ choice", () => {
	it("is on by default and remembered", async () => {
		expect(readShowInvisibles()).toBe(true);
		renderLine({ text: "a b", lang: null });
		const toggle = screen.getByRole("button", { name: "Show all characters" });
		expect(toggle).toHaveAttribute("aria-pressed", "true");
		await userEvent.click(toggle);
		expect(localStorage.getItem(INVISIBLES_STORAGE_KEY)).toBe("off");
		cleanup();
		resetShowInvisibles();
		renderLine({ text: "a b", lang: null });
		expect(
			screen.getByRole("button", { name: "Show all characters" }),
		).toHaveAttribute("aria-pressed", "false");
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
