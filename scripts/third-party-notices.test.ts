import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	collectPackages,
	cssPackageFiles,
	packageRoot,
	renderNotices,
	thirdPartyNotices,
	virtualPackageFile,
} from "./third-party-notices.mjs";

const repoRoot = join(import.meta.dirname, "..");

describe("the third-party notices collector", () => {
	let dir: string;
	let nm: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-notices-"));
		nm = join(dir, "node_modules");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	/** A package in the fixture node_modules (pnpm's nested layout). */
	function pkg(
		name: string,
		manifest: Record<string, unknown>,
		files: Record<string, string> = {},
	) {
		const root = join(
			nm,
			".pnpm",
			`${name.replace("/", "+")}@1.0.0`,
			"node_modules",
			name,
		);
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name, version: "1.0.0", ...manifest }),
		);
		for (const [file, text] of Object.entries(files)) {
			mkdirSync(dirname(join(root, file)), { recursive: true });
			writeFileSync(join(root, file), text);
		}
		return root;
	}

	it("finds a module's package, scoped or not, in pnpm's layout; not our files or virtual modules", () => {
		const a = pkg("a", {}, { "lib/x.js": "" });
		const b = pkg("@s/b", {}, { "dist/y.css": "" });
		expect(packageRoot(join(a, "lib/x.js"))).toBe(a);
		expect(packageRoot(`${join(b, "dist/y.css")}?inline`)).toBe(b);
		expect(packageRoot("/repo/src/web/main.tsx")).toBeNull();
		expect(packageRoot("\0vite/preload-helper.js")).toBeNull();
	});

	it("lists each package once, sorted, with its license, source, and every license, copying and notice text", () => {
		const a = pkg(
			"zeta",
			{
				license: "MIT",
				repository: { url: "git+https://github.com/x/zeta.git" },
			},
			{ LICENSE: "MIT text zeta", "index.js": "" },
		);
		const b = pkg(
			"@s/alpha",
			{ license: "Apache-2.0", homepage: "https://alpha.example" },
			{
				"LICENCE.md": "Apache text",
				NOTICE: "Alpha notice",
				"README.md": "no",
			},
		);
		const d = pkg(
			"dual",
			{ license: "(MPL-2.0 OR Apache-2.0)" },
			{ "LICENSE-APACHE": "Apache", "LICENSE-MPL": "MPL" },
		);
		const list = collectPackages(
			[
				join(a, "index.js"),
				join(a, "index.js"),
				join(b, "x.css"),
				join(d, "y.js"),
				"/repo/src/a.ts",
			],
			{ choices: { dual: "Apache-2.0" }, overrides: {} },
		);
		expect(list.map((p) => p.name)).toEqual(["@s/alpha", "dual", "zeta"]);
		expect(list[0]).toEqual({
			name: "@s/alpha",
			version: "1.0.0",
			license: "Apache-2.0",
			chosen: undefined,
			url: "https://alpha.example",
			texts: [
				{ file: "LICENCE.md", text: "Apache text" },
				{ file: "NOTICE", text: "Alpha notice" },
			],
		});
		expect(list[2]?.url).toBe("https://github.com/x/zeta");
		const text = renderNotices(list);
		expect(text).toContain(
			"License: (MPL-2.0 OR Apache-2.0); used under Apache-2.0.",
		);
		expect(text).toContain("### NOTICE\n\n```text\nAlpha notice\n```");
		expect(text.indexOf("## @s/alpha@1.0.0")).toBeLessThan(
			text.indexOf("## zeta@1.0.0"),
		);
	});

	it("fails, naming the packages, when one ships no license text; an override with its text fixes it", () => {
		const bare = pkg("bare", { license: "MIT" }, { "index.js": "" });
		const empty = pkg("empty", { license: "ISC" }, { LICENSE: "  \n" });
		const ids = [join(bare, "index.js"), join(empty, "index.js")];
		expect(() => collectPackages(ids, { overrides: {} })).toThrow(
			"third-party notices: no license text in bare@1.0.0, empty@1.0.0",
		);
		const licenses = join(dir, "licenses");
		mkdirSync(licenses);
		writeFileSync(join(licenses, "bare.txt"), "MIT text from the repo");
		writeFileSync(join(licenses, "empty.txt"), "ISC text from the README");
		const list = collectPackages(ids, {
			overridesDir: licenses,
			overrides: {
				bare: { file: "bare.txt", source: "github.com/x/bare LICENSE" },
				empty: { file: "empty.txt", source: "its README" },
			},
		});
		expect(list[0]?.texts).toEqual([
			{
				file: "bare.txt (github.com/x/bare LICENSE)",
				text: "MIT text from the repo",
			},
		]);
	});

	it("cuts a license file to the package's own part, and fails when the cut no longer fits", () => {
		const v = pkg(
			"bundler",
			{ license: "MIT" },
			{
				"LICENSE.md":
					"# Own\nMIT own\n\n# Licenses of bundled dependencies\nother stuff",
			},
		);
		const cuts = {
			bundler: {
				file: "LICENSE.md",
				before: "# Licenses of bundled dependencies",
			},
		};
		expect(
			collectPackages([join(v, "x.js")], { cuts, overrides: {} })[0]?.texts,
		).toEqual([{ file: "LICENSE.md", text: "# Own\nMIT own" }]);
		writeFileSync(join(v, "LICENSE.md"), "# Own\nMIT own");
		expect(() =>
			collectPackages([join(v, "x.js")], { cuts, overrides: {} }),
		).toThrow("no longer has");
	});

	it("fences a license text that itself has backticks", () => {
		const text = renderNotices([
			{
				name: "t",
				version: "1.0.0",
				license: "MIT",
				texts: [{ file: "LICENSE", text: "a ```` b" }],
			},
		]);
		expect(text).toContain("`````text\na ```` b\n`````");
	});

	it("follows CSS @imports into packages (as Tailwind resolves them itself)", () => {
		const fonts = pkg(
			"@f/font",
			{ style: "index.css" },
			{
				"index.css": "@font-face { src: url(files/a.woff2) }",
				"italic.css": "",
			},
		);
		const tw = pkg(
			"tw",
			{},
			{ "index.css": '@import "./theme.css" layer(theme);', "theme.css": "" },
		);
		const web = join(dir, "src");
		mkdirSync(web);
		writeFileSync(join(dir, "package.json"), "{}");
		// Node resolves bare specifiers from node_modules up the tree.
		for (const [name, root] of [
			["@f/font", fonts],
			["tw", tw],
		] as const) {
			mkdirSync(dirname(join(nm, name)), { recursive: true });
			symlinkSync(root, join(nm, name));
		}
		writeFileSync(join(web, "local.css"), '@import "@f/font/italic.css";');
		writeFileSync(
			join(web, "index.css"),
			'@import "tw";\n@import url("./local.css");\n@import "@f/font";\n@import "https://x/y.css";',
		);
		const files = cssPackageFiles(join(web, "index.css"));
		const roots = new Set(files.map((f) => realpathSync(dirname(f))));
		expect(roots).toEqual(new Set([realpathSync(fonts), realpathSync(tw)]));
	});

	it("the plugin counts emitted assets' original files (a font a stylesheet of ours points at) and writes next to the output", () => {
		const font = pkg(
			"font-pkg",
			{ license: "OFL-1.1" },
			{
				"OFL.txt": "",
				LICENSE: "SIL OPEN FONT LICENSE Version 1.1",
				"files/a.woff2": "",
			},
		);
		const root = join(dir, "web");
		mkdirSync(root);
		mkdirSync(join(dir, "out", "web"), { recursive: true }); // vite makes it
		const plugin = thirdPartyNotices({
			overridesDir: join(dir, "licenses"),
		}) as unknown as {
			configResolved: (c: unknown) => void;
			generateBundle: (this: unknown, o: unknown, b: unknown) => void;
			writeBundle: () => void;
		};
		plugin.configResolved({ root, build: { outDir: "../out/web" } });
		plugin.generateBundle.call(
			{ getModuleIds: () => [][Symbol.iterator]() },
			{},
			{
				"assets/a.woff2": {
					type: "asset",
					originalFileNames: [relative(root, join(font, "files/a.woff2"))],
				},
			},
		);
		plugin.writeBundle();
		const notices = readFileSync(
			join(dir, "out", "THIRD-PARTY-NOTICES.md"),
			"utf8",
		);
		expect(notices).toContain("## font-pkg@1.0.0");
		expect(notices).toContain("SIL OPEN FONT LICENSE");
	});

	it("knows which package a bundled virtual module comes from, and fails on an unknown one", () => {
		expect(
			JSON.parse(
				readFileSync(
					virtualPackageFile("\0vite/preload-helper.js", repoRoot),
					"utf8",
				),
			).name,
		).toBe("vite");
		expect(
			JSON.parse(
				readFileSync(
					virtualPackageFile("\0rolldown/runtime.js", repoRoot),
					"utf8",
				),
			).name,
		).toBe("rolldown");
		expect(() => virtualPackageFile("\0mystery/x.js", repoRoot)).toThrow(
			"unknown virtual module",
		);
	});
});

// The real web build, into a temp dir: what the npm package's
// dist/THIRD-PARTY-NOTICES.md says.
describe("the notices of the real build", { timeout: 180_000 }, () => {
	let out: string;
	afterEach(() => rmSync(out, { recursive: true, force: true }));

	it("lists react, shiki, tailwindcss, dompurify under Apache-2.0, both fonts with the OFL text, and vite's own license only", async () => {
		out = mkdtempSync(join(tmpdir(), "crb-notices-build-"));
		const { build } = await import("vite");
		await build({
			configFile: join(repoRoot, "vite.config.ts"),
			logLevel: "silent",
			build: { outDir: join(out, "web"), emptyOutDir: true },
		});
		const notices = readFileSync(join(out, "THIRD-PARTY-NOTICES.md"), "utf8");
		const section = (name: string) => {
			const at = notices.search(
				new RegExp(`^## ${name.replace(/[/.]/g, "\\$&")}@`, "m"),
			);
			expect(at, name).toBeGreaterThan(-1);
			const next = notices.indexOf("\n## ", at + 1);
			return notices.slice(at, next < 0 ? undefined : next);
		};
		for (const name of [
			"react",
			"react-dom",
			"shiki",
			"tailwindcss",
			"@tanstack/react-query",
		]) {
			expect(section(name)).toContain("License: MIT");
		}
		expect(section("dompurify")).toContain("used under Apache-2.0.");
		for (const font of [
			"@fontsource-variable/outfit",
			"@fontsource-variable/atkinson-hyperlegible-next",
		]) {
			const s = section(font);
			expect(s).toContain("License: OFL-1.1");
			expect(s).toContain("SIL OPEN FONT LICENSE");
			expect(s).toContain("TERMINATION");
		}
		expect(section("vite")).toContain("MIT License");
		expect(section("vite")).not.toContain("Licenses of bundled dependencies");
		section("rolldown");
		// Build-only tools don't ship.
		for (const tool of [
			"typescript",
			"vitest",
			"@biomejs/biome",
			"lightningcss",
		]) {
			expect(notices).not.toMatch(
				new RegExp(`^## ${tool.replace(/[/.]/g, "\\$&")}@`, "m"),
			);
		}
	});
});
