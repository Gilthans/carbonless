import { describe, expect, it } from "vitest";
import { hiddenChange } from "./hiddenChange";

describe("hiddenChange", () => {
	it("is a line ending's \\r: drawn as nothing while hidden characters are off", () => {
		expect(
			hiddenChange("const a = 1;\r", [[12, 13]], {
				partner: { text: "const a = 1;" },
			}),
		).toBe(true);
		// Whatever the other line is: the mark itself draws nothing.
		expect(hiddenChange("x\r", [[1, 2]])).toBe(true);
	});

	it("isn't a \\r drawn as one: inside a line, or ending a last line without a newline", () => {
		expect(hiddenChange("a\rb", [[1, 2]])).toBe(false);
		expect(hiddenChange("x\r", [[1, 2]], { newline: false })).toBe(false);
	});

	it("isn't an escaped character: a zero-width or no-break space shows as \\uXXXX either way", () => {
		expect(
			hiddenChange("const na\u200Bme = 1;", [[8, 9]], {
				partner: { text: "const name = 1;" },
			}),
		).toBe(false);
		expect(
			hiddenChange("const n\u00A0= 3;", [[7, 8]], {
				partner: { text: "const n = 3;" },
			}),
		).toBe(false);
		expect(hiddenChange("a\u202Eb", [[1, 2]])).toBe(false);
	});

	it("is trailing whitespace: spaces or tabs after the last thing drawn", () => {
		expect(
			hiddenChange("let s = 1;   ", [[10, 13]], {
				partner: { text: "let s = 1;" },
			}),
		).toBe(true);
		expect(hiddenChange("let s = 1;\t", [[10, 11]])).toBe(true);
		// Before a CRLF ending too.
		expect(hiddenChange("let s = 1; \r", [[10, 11]])).toBe(true);
		// A blank line that gained spaces.
		expect(hiddenChange("    ", [[0, 4]], { partner: { text: "" } })).toBe(
			true,
		);
	});

	it("is a tab swapped for spaces of the same width, either way round", () => {
		expect(
			hiddenChange("\tx = 1;", [[0, 1]], { partner: { text: "    x = 1;" } }),
		).toBe(true);
		expect(
			hiddenChange("    x = 1;", [[0, 4]], { partner: { text: "\tx = 1;" } }),
		).toBe(true);
		// Mid-line, to the next tab stop.
		expect(
			hiddenChange("ab\tc", [[2, 3]], { partner: { text: "ab  c" } }),
		).toBe(true);
	});

	it("isn't a tab swapped for spaces of another width", () => {
		expect(
			hiddenChange("\tx", [[0, 1]], {
				tabWidth: 8,
				partner: { text: "    x" },
			}),
		).toBe(false);
	});

	it("isn't a visibly changed word, nor an added or widened indent", () => {
		expect(
			hiddenChange("const userCount = 1;", [[6, 15]], {
				partner: { text: "const count = 1;" },
			}),
		).toBe(false);
		expect(hiddenChange("    x", [[0, 4]], { partner: { text: "x" } })).toBe(
			false,
		);
		expect(hiddenChange("\tx", [[0, 1]], { partner: { text: "x" } })).toBe(
			false,
		);
		expect(hiddenChange("    x", [[2, 4]], { partner: { text: "  x" } })).toBe(
			false,
		);
		expect(hiddenChange("a b", [[1, 2]], { partner: { text: "a  b" } })).toBe(
			false,
		);
	});

	it("isn't a mark that also covers something drawn (the change shows there)", () => {
		expect(
			hiddenChange("x; // c ", [[2, 8]], { partner: { text: "x;" } }),
		).toBe(false);
	});

	it("is any mark that draws nothing, beside one that shows", () => {
		expect(
			hiddenChange(
				"let b = 2;  ",
				[
					[4, 5],
					[10, 12],
				],
				{ partner: { text: "let a = 2;" } },
			),
		).toBe(true);
	});

	it("is nothing without marks", () => {
		expect(hiddenChange("x\r", [], { partner: { text: "x" } })).toBe(false);
	});
});
