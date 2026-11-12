import { beforeAll, describe, expect, it } from "vitest";
import { cacheUntilRejected, highlightLine, languageFor } from "./highlight";

describe("languageFor", () => {
	it("maps the reference PR's file types", () => {
		expect(languageFor("src/Program.cs")).toBe("csharp");
		for (const path of [
			"Product.wxs",
			"en-us.wxl",
			"App.csproj",
			"Directory.Build.props",
			"build.targets",
		]) {
			expect(languageFor(path)).toBe("xml");
		}
		expect(languageFor("tools/install.ps1")).toBe("powershell");
		expect(languageFor("tools/Mod.psm1")).toBe("powershell");
		expect(languageFor("README.md")).toBe("markdown");
		expect(languageFor("src/web/App.tsx")).toBe("tsx");
	});

	it("leaves unknown types as plain text", () => {
		expect(languageFor("App.sln")).toBeNull();
		expect(languageFor("Makefile")).toBeNull();
	});
});

describe("highlightLine", () => {
	// The first use imports shiki, its regex engine and the grammar: real
	// work a loaded machine can take seconds over. Done here, with its own
	// time, rather than inside the test's 5 s. The engine compiles each of
	// the grammar's rules the first time a line reaches it, so the warm-up
	// is a line like the test's: after an empty one, the test's line still
	// took 116–130 ms of CPU (12–20 ms after this one).
	beforeAll(async () => {
		await highlightLine("public class Warm { }", "csharp");
	}, 60_000);

	it("colors code in a known language", async () => {
		const tokens = await highlightLine("public class Foo { }", "csharp");
		expect(tokens.map((t) => t.content).join("")).toBe("public class Foo { }");
		expect(new Set(tokens.map((t) => t.color)).size).toBeGreaterThan(1);
	});

	it("returns one plain token without a language", async () => {
		expect(await highlightLine("x < y", null)).toEqual([
			{ content: "x < y", offset: 0 },
		]);
	});
});

describe("cacheUntilRejected", () => {
	it("shares one load, and loads again after a failure", async () => {
		let calls = 0;
		const load = cacheUntilRejected(async () => {
			calls++;
			if (calls === 1) throw new Error("chunk failed");
			return calls;
		});
		await expect(load()).rejects.toThrow("chunk failed");
		expect(await load()).toBe(2);
		expect(await load()).toBe(2);
		expect(calls).toBe(2);
	});
});
