import { describe, expect, it } from "vitest";
import {
	RENDERERS,
	type RendererFile,
	type RendererId,
	rendererChoices,
	rendererFileIn,
	rendererPicks,
	resolveRenderer,
} from "./index";

const f = (path: string, over: Partial<RendererFile> = {}): RendererFile => ({
	path,
	binary: false,
	submodule: false,
	...over,
});

describe("rendererChoices", () => {
	it.each<[string, RendererFile, RendererId[]]>([
		[
			"a known image type",
			f("logo.png", { binary: true }),
			["image", "binary"],
		],
		[
			"an image extension in capitals",
			f("A.JPG", { binary: true }),
			["image", "binary"],
		],
		["an SVG", f("icon.svg"), ["image", "text"]],
		[
			"an unknown binary",
			f("setup.msi", { binary: true }),
			["binary", "image"],
		],
		["an unknown text", f("src/a.ts"), ["text"]],
		["an LFS pointer", f("big.png", { lfs: true }), ["text"]],
		["a submodule", f("vendor/lib", { submodule: true }), ["text"]],
		[
			"a submodule at an image path",
			f("vendor/logo.png", { submodule: true }),
			["text"],
		],
	])("%s", (_, file, choices) => {
		expect(rendererChoices(file)).toEqual(choices);
	});

	it("never offers Text for a binary file", () => {
		for (const path of ["a.png", "a.svg", "a.bin", "a.ts", "a.ico"]) {
			expect(rendererChoices(f(path, { binary: true }))).not.toContain("text");
		}
	});
});

describe("resolveRenderer", () => {
	it("defaults to the first claim: image, then binary or text", () => {
		expect(resolveRenderer(f("a.png", { binary: true }), undefined)).toBe(
			"image",
		);
		expect(resolveRenderer(f("a.svg"), undefined)).toBe("image");
		expect(resolveRenderer(f("a.msi", { binary: true }), undefined)).toBe(
			"binary",
		);
		expect(resolveRenderer(f("a.ts"), undefined)).toBe("text");
	});

	it("the default is always the menu's first choice", () => {
		for (const file of [
			f("a.png", { binary: true }),
			f("a.svg"),
			f("a.msi", { binary: true }),
			f("a.ts"),
			f("a.png", { lfs: true }),
			f("lib", { submodule: true }),
			f("vendor/logo.png", { submodule: true }),
		]) {
			expect(resolveRenderer(file, undefined)).toBe(rendererChoices(file)[0]);
		}
	});

	it("the reviewer's pick wins over the claim", () => {
		expect(resolveRenderer(f("a.png", { binary: true }), "binary")).toBe(
			"binary",
		);
		expect(resolveRenderer(f("a.svg"), "text")).toBe("text");
		expect(resolveRenderer(f("a.msi", { binary: true }), "image")).toBe(
			"image",
		);
	});

	it("ignores a pick that isn't among the choices (a stale Text on a binary file)", () => {
		expect(resolveRenderer(f("a.png", { binary: true }), "text")).toBe("image");
		expect(resolveRenderer(f("a.ts"), "image")).toBe("text");
		expect(resolveRenderer(f("a.ts"), "binary")).toBe("text");
	});

	it("shows an LFS pointer as text, whatever was picked", () => {
		expect(resolveRenderer(f("a.png", { lfs: true }), undefined)).toBe("text");
		expect(resolveRenderer(f("a.png", { lfs: true }), "image")).toBe("text");
	});

	it("an unknown text extension has one choice", () => {
		expect(rendererChoices(f("README"))).toEqual(["text"]);
	});
});

describe("RENDERERS", () => {
	it("describes how each one ticks and what it can anchor comments on", () => {
		const by = Object.fromEntries(RENDERERS.map((r) => [r.id, r]));
		expect(by.text).toMatchObject({
			units: "lines",
			anchors: ["file", "lines"],
		});
		expect(by.binary).toMatchObject({ units: "whole-file", anchors: ["file"] });
		expect(by.image).toMatchObject({ units: "whole-file", anchors: ["file"] });
	});
});

describe("markdown", () => {
	const md = (path: string, over: Partial<RendererFile> = {}) =>
		f(path, { markdownBlocks: true, ...over });

	it("a README.md the server cut at blocks opens Rendered, with Text beside it", () => {
		expect(resolveRenderer(md("README.md"), undefined)).toBe("markdown");
		expect(rendererChoices(md("README.md"))).toEqual(["markdown", "text"]);
		expect(rendererChoices(md("docs/Guide.MARKDOWN"))).toEqual([
			"markdown",
			"text",
		]);
	});

	it("without the flag (over the cap, or not Markdown) it is Text only", () => {
		expect(rendererChoices(f("README.md"))).toEqual(["text"]);
		expect(resolveRenderer(f("README.md"), "markdown")).toBe("text");
	});

	it("never for an LFS pointer, a submodule or a binary file", () => {
		expect(rendererChoices(md("a.md", { lfs: true }))).toEqual(["text"]);
		expect(rendererChoices(md("a.md", { submodule: true }))).toEqual(["text"]);
		expect(rendererChoices(md("a.md", { binary: true }))).not.toContain(
			"markdown",
		);
	});

	it("a pick of Text is kept per path, and only for that path", () => {
		rendererPicks.set("README.md", "text");
		try {
			expect(
				resolveRenderer(md("README.md"), rendererPicks.get("README.md")),
			).toBe("text");
			expect(
				resolveRenderer(md("docs/b.md"), rendererPicks.get("docs/b.md")),
			).toBe("markdown");
		} finally {
			rendererPicks.reset();
		}
	});

	it("is a lines renderer: boxes per cluster, comments on lines", () => {
		const by = Object.fromEntries(RENDERERS.map((r) => [r.id, r]));
		expect(by.markdown).toMatchObject({
			units: "lines",
			anchors: ["file", "lines"],
		});
	});

	it("the since view offers it by the since answer's flag", () => {
		// The full diff's flag stands until the answer is in.
		expect(rendererChoices(rendererFileIn(md("a.md"), undefined))).toEqual([
			"markdown",
			"text",
		]);
		expect(
			rendererChoices(rendererFileIn(f("a.md"), { markdownBlocks: true })),
		).toEqual(["markdown", "text"]);
		// Cut in the full diff, not in this comparison: Text only.
		expect(rendererChoices(rendererFileIn(md("a.md"), {}))).toEqual(["text"]);
	});
});
