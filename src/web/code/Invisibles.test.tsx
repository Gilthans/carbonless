// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CodeLine,
	INVISIBLES_STORAGE_KEY,
	InvisiblesToggle,
	readShowInvisibles,
	resetShowInvisibles,
	setShowInvisibles,
} from "./Invisibles";

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
		expect(bidi?.title).toMatch(/U\+202E right-to-left override/);
		expect(bidi?.className).toMatch(/text-warn/);
		expect(
			line().querySelector<HTMLElement>('[data-inv="escape"]')?.title,
		).toBe("U+200B zero width space");
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
