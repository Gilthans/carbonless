import { describe, expect, it } from "vitest";
import { highlightLine, languageFor } from "./highlight";

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
