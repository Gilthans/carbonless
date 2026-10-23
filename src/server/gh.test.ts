import { describe, expect, it } from "vitest";
import { GhError, parsePrArg, runGh, slugify } from "./gh";

describe("parsePrArg", () => {
	it.each([
		[
			"https://github.com/Acme/Widget/pull/12",
			{ owner: "Acme", repo: "Widget", number: 12 },
		],
		[
			"https://github.com/Acme/Widget/pull/12/",
			{ owner: "Acme", repo: "Widget", number: 12 },
		],
		[
			"https://github.com/Acme/Widget/pull/12/files",
			{ owner: "Acme", repo: "Widget", number: 12 },
		],
		[
			"http://www.github.com/a.b/c-d_e/pull/7?diff=split#x",
			{ owner: "a.b", repo: "c-d_e", number: 7 },
		],
		["  acme/widget#12 ", { owner: "acme", repo: "widget", number: 12 }],
		["a-b/c.d#1", { owner: "a-b", repo: "c.d", number: 1 }],
		["12", { number: 12 }],
	])("parsePrArg(%s)", (arg, expected) => {
		expect(parsePrArg(arg)).toEqual(expected);
	});

	it.each([
		"main",
		"",
		"0",
		"acme/widget",
		"https://gitlab.com/a/b/pull/1",
		"https://github.com/a/b/issues/1",
		"-5",
		"1.5",
		"99999999999999999999",
	])("rejects %j", (arg) => {
		expect(() => parsePrArg(arg)).toThrow(GhError);
	});

	it("names the input in the error", () => {
		expect(() => parsePrArg("main")).toThrow(
			"Not a PR: main. Use a PR URL, owner/repo#123 or a number",
		);
	});
});

describe("slugify", () => {
	it("slugifies logins", () => {
		expect(slugify("Dan_O.Riyan")).toBe("dan-o-riyan");
	});
	it("caps at 64 characters", () => {
		expect(slugify("a".repeat(100))).toHaveLength(64);
	});
});

describe("runGh", () => {
	it("reports a missing gh binary", async () => {
		const saved = process.env.PATH;
		process.env.PATH = "/nonexistent-dir";
		try {
			await expect(runGh(["auth", "status"])).rejects.toThrow(
				"gh is not installed. Install it from https://cli.github.com",
			);
		} finally {
			process.env.PATH = saved;
		}
	});
});
