import { describe, expect, it } from "vitest";
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
