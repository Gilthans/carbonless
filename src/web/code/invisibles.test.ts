import { describe, expect, it } from "vitest";
import {
	describeCodePoint,
	escapeLabel,
	joinPieces,
	type Piece,
	renderInvisibles,
} from "./invisibles";

/** What a line looks like: escapes and markers inline, tabs as `\t` + dots of padding. */
function look(pieces: Piece[]): string {
	return pieces
		.map((p) => {
			switch (p.kind) {
				case "text":
					return p.raw;
				case "space":
					return "·";
				case "tab":
					return p.marker
						? `\\t${"_".repeat(p.columns - 2)}`
						: "_".repeat(p.columns);
				case "escape":
					return p.bidi ? `!${p.label}!` : p.label;
				default:
					return p.label ? `⏎${p.label}` : "";
			}
		})
		.join("");
}

const shown = (text: string, tabWidth = 4, newline = true) =>
	look(renderInvisibles(text, tabWidth, { newline }));
const hidden = (text: string, tabWidth = 4, newline = true) =>
	look(renderInvisibles(text, tabWidth, { newline, show: false }));

describe("renderInvisibles", () => {
	it("marks spaces and the line ending", () => {
		expect(shown("a b  ")).toBe("a·b··⏎\\n");
	});

	it("shows CRLF as \\r\\n, and no ending on a last line without newline", () => {
		expect(shown("x\r")).toBe("x⏎\\r\\n");
		expect(shown("x", 4, false)).toBe("x");
		// The CR of a last line without newline is a lone CR.
		expect(shown("x\r", 4, false)).toBe("x\\r");
	});

	it("shows a lone CR inside a line as \\r", () => {
		expect(shown("a\rb")).toBe("a\\rb⏎\\n");
	});

	it("pads tabs to the next stop, counting what is on screen", () => {
		expect(shown("\tx")).toBe("\\t__x⏎\\n");
		expect(shown("ab\tx")).toBe("ab\\tx⏎\\n");
		// One column to the stop is too narrow for the marker: the next stop.
		expect(shown("abc\tx")).toBe("abc\\t___x⏎\\n");
		// The escape is 6 columns wide: from column 7 the tab runs to 12.
		expect(shown("a\u200B\tx")).toBe("a\\u200B\\t___x⏎\\n");
		expect(shown("\t\t")).toBe("\\t__\\t__⏎\\n");
		expect(shown("ab\t", 8)).toBe("ab\\t____⏎\\n");
	});

	it("counts marks as zero columns before a tab", () => {
		// e + combining acute: one column, so 3 to the stop.
		expect(shown("e\u0301\tx")).toBe("e\u0301\\t_x⏎\\n");
	});

	it("keeps tabs on tab stops and nothing else when hidden", () => {
		expect(hidden("abc\tx a\r")).toBe("abc_x a");
		expect(hidden("\tx", 2)).toBe("__x");
	});

	it("escapes controls but tab, LF, CR; DEL; C1", () => {
		expect(shown("\0\x07\x1b\x7f\x85\x9f", 4, false)).toBe(
			"\\u0000\\u0007\\u001B\\u007F\\u0085\\u009F",
		);
	});

	it("escapes format characters and default-ignorables", () => {
		for (const [ch, label] of [
			["\u200B", "\\u200B"],
			["\u200C", "\\u200C"],
			["\u200D", "\\u200D"],
			["\u2060", "\\u2060"],
			["\uFEFF", "\\uFEFF"],
			["\u00AD", "\\u00AD"],
			["\u3164", "\\u3164"],
			["\u034F", "\\u034F"],
		]) {
			expect(shown(`a${ch}b`, 4, false)).toBe(`a${label}b`);
		}
	});

	it("escapes unusual spaces and line separators", () => {
		const spaces = [
			0xa0, 0x2000, 0x2001, 0x2005, 0x200a, 0x202f, 0x205f, 0x3000, 0x2028,
			0x2029, 0x2800,
		];
		for (const cp of spaces) {
			const ch = String.fromCodePoint(cp);
			expect(shown(`a${ch}b`, 4, false)).toBe(`a${escapeLabel(cp)}b`);
		}
	});

	it("flags bidi controls", () => {
		const bidi = [
			0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
			0x200e, 0x200f, 0x061c,
		];
		for (const cp of bidi) {
			const pieces = renderInvisibles(String.fromCodePoint(cp), 4, {
				newline: false,
			});
			expect(pieces).toMatchObject([{ kind: "escape", bidi: true }]);
		}
		expect(renderInvisibles("\u200B", 4)[0]).toMatchObject({ bidi: false });
	});

	it("escapes the same characters when hidden", () => {
		expect(hidden("a\u202E\u200B\u00A0\x1b b")).toBe(
			"a!\\u202E!\\u200B\\u00A0\\u001B b",
		);
	});

	it("escapes astral invisibles in braces", () => {
		// Tag characters outside a flag: ASCII smuggling.
		expect(shown("a\u{E0041}", 4, false)).toBe("a\\u{E0041}");
		expect(shown("\u{E0100}", 4, false)).toBe("\\u{E0100}");
	});

	it("leaves combining marks alone", () => {
		expect(shown("e\u0301 n\u0303", 4, false)).toBe("e\u0301·n\u0303");
	});

	it("leaves emoji intact: presentation selectors, ZWJ sequences, skin tones, flags", () => {
		for (const emoji of [
			"❤\uFE0F",
			"👨\u200D👩\u200D👧",
			"👩🏽\u200D💻",
			"🏳\uFE0F\u200D🌈",
			"🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
			"🇫🇷",
		]) {
			expect(shown(emoji, 4, false)).toBe(emoji);
		}
	});

	it("escapes selectors and joiners that aren't attached", () => {
		expect(shown("a\uFE0F", 4, false)).toBe("a\\uFE0F");
		expect(shown("❤\uFE0F\uFE0F", 4, false)).toBe("❤\uFE0F\\uFE0F");
		expect(shown("a\u200Db", 4, false)).toBe("a\\u200Db");
		// Tags after a flag's terminator are smuggled again.
		expect(shown("🏴\u{E0067}\u{E007F}\u{E0041}", 4, false)).toBe(
			"🏴\u{E0067}\u{E007F}\\u{E0041}",
		);
	});

	it("keeps joiners in scripts that need them", () => {
		// Devanagari half form: KA + VIRAMA + ZWJ + SSA.
		expect(shown("क\u094D\u200Dष", 4, false)).toBe("क\u094D\u200Dष");
	});

	it("always gives back the original text", () => {
		for (const text of [
			"\ta b\r",
			"x\u202Ey\u200B\u00A0\x1b\r",
			"👨\u200D👩 \u{E0041}\t",
			"",
		]) {
			for (const show of [true, false]) {
				for (const newline of [true, false]) {
					expect(joinPieces(renderInvisibles(text, 4, { show, newline }))).toBe(
						text,
					);
				}
			}
		}
	});

	it("records each piece's offset in the line", () => {
		const pieces = renderInvisibles("ab 👍\tc\r", 4);
		expect(pieces.map((p) => p.start)).toEqual([0, 2, 3, 5, 6, 7]);
	});

	it("clamps odd tab widths", () => {
		expect(shown("\t", 0, false)).toBe("\\t");
		expect(shown("\t", Number.NaN, false)).toBe("\\t__");
	});
});

describe("describeCodePoint", () => {
	it("names what it knows", () => {
		expect(describeCodePoint(0x200b)).toBe("U+200B zero width space");
		expect(describeCodePoint(0x1b)).toBe("U+001B control character");
		expect(describeCodePoint(0xe0041)).toBe("U+E0041 tag character");
	});
});
