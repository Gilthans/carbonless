import { describe, expect, it } from "vitest";
import { compareUrl, noteParts, prUrl, splitNote } from "./whatsNew";

describe("splitNote", () => {
	it("the first sentence and the rest; a dot in code or a word is no end", () => {
		expect(splitNote("One. Two! Three?")).toEqual({
			first: "One.",
			rest: "Two! Three?",
		});
		expect(splitNote("Run `a. b` now. Then rest.")).toEqual({
			first: "Run `a. b` now.",
			rest: "Then rest.",
		});
		expect(splitNote("Uses v0.4.0 now.")).toEqual({
			first: "Uses v0.4.0 now.",
			rest: "",
		});
	});
});

describe("noteParts", () => {
	it("code spans in backticks; an unclosed backtick stays text", () => {
		expect(noteParts("Run `crb serve` now")).toEqual([
			{ code: false, text: "Run " },
			{ code: true, text: "crb serve" },
			{ code: false, text: " now" },
		]);
		expect(noteParts("a `b` c `d")).toEqual([
			{ code: false, text: "a " },
			{ code: true, text: "b" },
			{ code: false, text: " c `d" },
		]);
	});
});

describe("links", () => {
	it("built from numbers and versions only", () => {
		expect(prUrl(12)).toBe("https://github.com/Gilthans/carbonless/pull/12");
		expect(prUrl(1.5)).toBeNull();
		expect(prUrl(-1)).toBeNull();
		expect(compareUrl("0.4.0-rc.3", "0.4.0-rc.5")).toBe(
			"https://github.com/Gilthans/carbonless/compare/v0.4.0-rc.3...v0.4.0-rc.5",
		);
	});
});
