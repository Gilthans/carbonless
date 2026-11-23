import { describe, expect, it } from "vitest";
import {
	type ImageFile,
	imageResolver,
	remoteImageUrl,
	repoPathOf,
} from "./images";

const files: ImageFile[] = [
	{
		index: 0,
		path: "docs/README.md",
		status: "modified",
		binary: false,
		submodule: false,
	},
	{
		index: 3,
		path: "docs/img/a.png",
		status: "modified",
		binary: true,
		submodule: false,
	},
	{
		index: 4,
		path: "logo.png",
		status: "added",
		binary: true,
		submodule: false,
	},
	{
		index: 5,
		path: "docs/notes.txt",
		status: "modified",
		binary: false,
		submodule: false,
	},
	{
		index: 6,
		path: "big.png",
		status: "modified",
		binary: false,
		submodule: false,
		lfs: true,
	},
];

describe("repoPathOf", () => {
	it.each([
		["img/a.png", "docs/img/a.png"],
		["./img/a.png", "docs/img/a.png"],
		["../logo.png", "logo.png"],
		["/logo.png", "logo.png"],
		["img//a.png", "docs/img/a.png"],
		["/.//evil.example/p.png", "evil.example/p.png"],
	])("%s → %s", (src, path) => {
		expect(repoPathOf(src, "docs/README.md")).toBe(path);
	});

	it("refuses a path climbing above the repo root", () => {
		expect(repoPathOf("../../../x.png", "docs/README.md")).toBeNull();
		expect(repoPathOf("/../x.png", "docs/README.md")).toBeNull();
		expect(repoPathOf("..", "README.md")).toBeNull();
	});
});

describe("imageResolver", () => {
	const resolve = (src: string, side: "old" | "new" = "new", from?: number) =>
		imageResolver({
			mdPath: "docs/README.md",
			files,
			revision: "r1",
			side,
			from,
		})(src);

	it("a changed image of the review loads through the blob route, by index, never by its path", () => {
		const url = resolve("img/a.png") as string;
		expect(url).toMatch(/\/api\/files\/3\/blob\?/);
		expect(url).toContain("side=new");
		expect(url).not.toContain("a.png");
		expect(resolve("img/a.png", "old", 2)).toContain("from=2");
	});

	it("anything else is a placeholder: not in the review, not an image, LFS, above the root, a side the file lacks", () => {
		expect(resolve("img/other.png")).toBeNull();
		expect(resolve("notes.txt")).toBeNull();
		expect(resolve("/big.png")).toBeNull();
		expect(resolve("../../../x.png")).toBeNull();
		expect(resolve("/.//evil.example/p.png")).toBeNull();
		expect(resolve("../logo.png", "old")).toBeNull();
		expect(resolve("../logo.png", "new")).toMatch(/files\/4\/blob/);
		expect(resolve("img/a.png?x=1")).toBeNull();
	});

	it("the since view's old side is the compared patch set's: an image the base lacks loads from it", () => {
		// logo.png is added against the base: no old side in the full diff.
		expect(resolve("../logo.png", "old")).toBeNull();
		const url = resolve("../logo.png", "old", 1) as string;
		expect(url).toMatch(/files\/4\/blob/);
		expect(url).toContain("side=old");
		expect(url).toContain("from=1");
	});
});

describe("remoteImageUrl", () => {
	it("only http(s)", () => {
		expect(remoteImageUrl("https://x.example/a.png")).toBe(
			"https://x.example/a.png",
		);
		expect(remoteImageUrl("http://x.example/a.png")).toBe(
			"http://x.example/a.png",
		);
		for (const bad of [
			"javascript:alert(1)",
			" javascript:alert(1)",
			"data:image/png;base64,AA",
			"//x.example/a.png",
			"a.png",
			"",
			null,
			"vbscript:x",
			"file:///etc/passwd",
		]) {
			expect(remoteImageUrl(bad)).toBeNull();
		}
	});
});
