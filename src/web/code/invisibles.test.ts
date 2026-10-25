import { describe, expect, it } from "vitest";
import {
	describeCodePoint,
	escapeLabel,
	joinPieces,
	type Piece,
	renderInvisibles,
} from "./invisibles";
import {
	JOINING_SCRIPTS,
	JOINING_TYPES,
	JOINING_UNICODE,
} from "./joiningTypes";

/** What a line looks like: escapes and markers inline, tabs as `\t` + dots of padding. */
function look(pieces: Piece[]): string {
	return pieces
		.map((p) => {
			switch (p.kind) {
				case "text":
					return p.raw;
				case "space":
					return "·".repeat(p.raw.length);
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

	it("draws a run of spaces as one piece", () => {
		const pieces = renderInvisibles("a    b  \tc", 4, { newline: false });
		expect(pieces.map((p) => [p.kind, p.raw])).toEqual([
			["text", "a"],
			["space", "    "],
			["text", "b"],
			["space", "  "],
			["tab", "\t"],
			["text", "c"],
		]);
		// The tab still counts the spaces: "a····b··" is 8 columns.
		expect(pieces[4]).toMatchObject({ columns: 4 });
	});

	it("splits a 100 KB line quickly", () => {
		const text = "const value = call(a, b);\t// note  ".repeat(3000);
		const start = performance.now();
		const pieces = renderInvisibles(text, 4);
		expect(performance.now() - start).toBeLessThan(200);
		expect(joinPieces(pieces)).toBe(text);
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

	it("counts wide characters and emoji as two columns before a tab", () => {
		// Ideographs and fullwidth forms.
		expect(shown("確\tx")).toBe("確\\tx⏎\\n");
		expect(shown("ＡＢ\tx")).toBe("ＡＢ\\t__x⏎\\n");
		// An emoji, a VS16 emoji, a ZWJ family, a skin tone, a flag: two each.
		for (const emoji of [
			"👍",
			"❤\uFE0F",
			"👨\u200D👩\u200D👧",
			"👩🏽\u200D💻",
			"🇫🇷",
			"1\uFE0F\u20E3",
		]) {
			expect(shown(`${emoji}\tx`), emoji).toBe(`${emoji}\\tx⏎\\n`);
		}
		// Two flags: four columns.
		expect(shown("🇫🇷🇩🇪\tx")).toBe("🇫🇷🇩🇪\\t__x⏎\\n");
		// A text-style symbol is one column.
		expect(shown("❤\tx")).toBe("❤\\t_x⏎\\n");
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
		// Tags that aren't an RGI flag's are smuggled text.
		expect(shown("🏴\u{E0067}\u{E007F}\u{E0041}", 4, false)).toBe(
			"🏴\\u{E0067}\\u{E007F}\\u{E0041}",
		);
	});

	it("keeps joiners in scripts that need them", () => {
		for (const text of [
			// Devanagari half form: KA + VIRAMA + ZWJ + SSA; and with ZWNJ.
			"क\u094D\u200Dष",
			"क\u094D\u200Cष",
			// Persian: the ZWNJ in "mi-khaham".
			"می\u200Cخواهم",
			// Arabic ZWNJ after a dual-joining letter, a vowel mark between.
			"ب\u064E\u200Cت",
			// ...before a right-joining one (beh, ZWNJ, alef).
			"ب\u200Cا",
			"👨\u200D👩\u200D👧",
			"❤\uFE0F\u200D🔥",
		]) {
			expect(shown(text, 4, false)).toBe(text);
		}
	});

	it("escapes joiners anywhere else", () => {
		const zwj = "\\u200D";
		const cases: [string, string][] = [
			// CJK, Hebrew, Thai don't join.
			["確\u200D認", `確${zwj}認`],
			["変\u200C数", "変\\u200C数"],
			["של\u200Dום", `של${zwj}ום`],
			["ก\u200Dข", `ก${zwj}ข`],
			// A combining mark on ASCII is no virama.
			["e\u0301\u200D\u0301", `e\u0301${zwj}\u0301`],
			// A virama on ASCII.
			["a\u094D\u200D", `a\u094D${zwj}`],
			// Escaped neighbours never count.
			["x\u034F\u200D\u034Fy", `x\\u034F${zwj}\\u034Fy`],
			["a\uFE0F\u200D\uFE0Fb", `a\\uFE0F${zwj}\\uFE0Fb`],
			["ب\u200B\u200Cت", "ب\\u200B\\u200Cت"],
			// Text-style symbols aren't an emoji sequence.
			["©\u200D®", `©${zwj}®`],
			["ab\u200Dcd", `ab${zwj}cd`],
			// Never a ZWJ between letters, even in a joining script.
			["ب\u200Dب", `ب${zwj}ب`],
			["ب\u064E\u200D\u064Eب", `ب\u064E${zwj}\u064Eب`],
			["ᠠ\u200Dᠠ", `ᠠ${zwj}ᠠ`],
			// ZWNJ after a right-joining letter (alef) or before a non-letter.
			["ا\u200Cب", "ا\\u200Cب"],
			["ب\u200C1", "ب\\u200C1"],
			["ء\u200Cب", "ء\\u200Cب"],
			// A virama of another script, or one not trusted.
			["e\u0301\u094D\u200D", `e\u0301\u094D${zwj}`],
			["ب\u094D\u200Dب", `ب\u094D${zwj}ب`],
			["\u00E9\u094D\u200D", `\u00E9\u094D${zwj}`],
			["ก\u0E3A\u200D", `ก\u0E3A${zwj}`],
			["க\u0BCD\u200D", `க\u0BCD${zwj}`],
		];
		for (const [text, look] of cases) {
			expect(shown(text, 4, false), text).toBe(look);
		}
	});

	it("keeps a ZWNJ only between joining letters of one script (Unicode data)", () => {
		const kept = [
			// Mongolian A + ZWNJ + A; an inherited mark on the letter before.
			"\u1820\u200C\u1820",
			"ب\u0301\u200Cب",
			// Syriac Supplement: dual-joining nga before right-joining ra.
			"\u0860\u200C\u0867",
			// Arabic Extended-B: right-joining alef with fatha after.
			"ب\u200C\u0870",
		];
		for (const text of kept) {
			expect(shown(text, 4, false), text).toBe(text);
		}
		const escaped = [
			// Two scripts: Arabic beside Syriac, Mongolian, N'Ko.
			"ب\u200Cܒ",
			"ب\u200C\u1820",
			"ب\u200C\u07CA",
			// Between them an invisible mark (CGJ, VS1, Mongolian FVS1) or a
			// mark of another script (Devanagari candrabindu).
			"ب\u034F\u200Cب",
			"ب\u200C\uFE00ب",
			"\u1820\u180B\u200C\u1820",
			"ب\u0901\u200Cب",
			// Non-joining in the data: presentation forms, Arabic math letters,
			// Syriac Supplement's non-joining letter.
			"ب\u200C\uFEDF",
			"ب\u200C\u{1EE01}",
			"\u0860\u200C\u0861",
			// Right-joining before the ZWNJ.
			"\u0870\u200Cب",
		];
		for (const text of escaped) {
			expect(shown(text, 4, false), text).toContain("\\u200C");
		}
	});

	it("keeps variation selectors only where they select", () => {
		for (const text of [
			"❤\uFE0F",
			"☺\uFE0E",
			"1\uFE0F\u20E3",
			"#\uFE0F\u20E3",
		]) {
			expect(shown(text, 4, false)).toBe(text);
		}
		for (const [text, look] of [
			["x1\uFE0F", "x1\\uFE0F"],
			["x1\uFE00", "x1\\uFE00"],
			["#\uFE0F", "#\\uFE0F"],
			["*\uFE0F*", "*\\uFE0F*"],
			// Other standardized selectors aren't worth the risk.
			["≩\uFE00", "≩\\uFE00"],
			// Ideographic selectors, even on an ideograph.
			["葛\u{E0100}", "葛\\u{E0100}"],
			["a\u{E0100}", "a\\u{E0100}"],
			["❤\u{E0100}", "❤\\u{E0100}"],
		] as const) {
			expect(shown(text, 4, false), text).toBe(look);
		}
	});

	it("keeps tag characters only in the RGI subdivision flags", () => {
		const tags = (s: string) =>
			[...s]
				.map((c) => String.fromCodePoint(0xe0000 + (c.codePointAt(0) ?? 0)))
				.join("");
		const cancel = "\u{E007F}";
		for (const code of ["gbeng", "gbsct", "gbwls"]) {
			const flag = `🏴${tags(code)}${cancel}`;
			expect(shown(flag, 4, false)).toBe(flag);
		}
		// ASCII smuggled behind a black flag.
		const smuggled = `🏴${tags("ignore")}${cancel}`;
		expect(shown(smuggled, 4, false)).toBe(
			`🏴${[...tags("ignore"), cancel].map((t) => escapeLabel(t.codePointAt(0) ?? 0)).join("")}`,
		);
		// An unknown subdivision, a missing cancel tag, a flag cut short.
		expect(shown(`🏴${tags("usca")}${cancel}`, 4, false)).not.toContain(
			tags("u"),
		);
		expect(shown(`🏴${tags("gbeng")}x`, 4, false)).not.toContain(tags("g"));
		expect(shown(`🏴${tags("gbe")}${cancel}`, 4, false)).not.toContain(
			tags("g"),
		);
		// Tags after a valid flag are smuggled again.
		expect(shown(`🏴${tags("gbeng")}${cancel}${tags("a")}`, 4, false)).toBe(
			`🏴${tags("gbeng")}${cancel}\\u{E0061}`,
		);
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

describe("JOINING_TYPES", () => {
	it("is no newer than Node's Unicode (an older one fails closed)", () => {
		const version = (v: string) => {
			const [major = 0, minor = 0] = v.split(".").map(Number);
			return major * 1000 + minor;
		};
		expect(version(JOINING_UNICODE)).toBeLessThanOrEqual(
			version(process.versions.unicode ?? "0.0"),
		);
	});

	it("is sorted and non-overlapping", () => {
		let prev = -1;
		for (const [first, last, type] of JOINING_TYPES) {
			expect(first).toBeGreaterThan(prev);
			expect(last).toBeGreaterThanOrEqual(first);
			expect(["D", "R", "L"]).toContain(type);
			prev = last;
		}
		expect(JOINING_TYPES.length).toBeGreaterThan(50);
		expect(JOINING_SCRIPTS).toEqual(
			expect.arrayContaining(["Arabic", "Syriac", "Nko", "Mongolian"]),
		);
	});
});

describe("describeCodePoint", () => {
	it("names what it knows", () => {
		expect(describeCodePoint(0x200b)).toBe("U+200B zero width space");
		expect(describeCodePoint(0x1b)).toBe("U+001B control character");
		expect(describeCodePoint(0xe0041)).toBe("U+E0041 tag character");
	});
});
