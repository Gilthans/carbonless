// CAR-136: lint forbids `static #method()` (biome-plugins/
// no-static-private-method.grit), because V8 before 13.7 reads one back
// wrong from a code cache, and crb serve turns Node's compile cache on.
import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
// Each test spawns biome or node several times; a loaded machine slows them.
const TIMEOUT = 60_000;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "crb-static-private-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("lint: no static #private methods", () => {
	// The repo's own biome.json and plugin, in a throwaway tree (no git, so
	// no ignore file), linting one planted file.
	const lint = (source: string) => {
		const config = JSON.parse(readFileSync(join(root, "biome.json"), "utf8"));
		config.vcs = { enabled: false };
		config.files = { includes: ["**"] };
		writeFileSync(join(dir, "biome.json"), JSON.stringify(config));
		cpSync(join(root, "biome-plugins"), join(dir, "biome-plugins"), {
			recursive: true,
		});
		mkdirSync(join(dir, "src/server"), { recursive: true });
		writeFileSync(join(dir, "src/server/planted.ts"), source);
		const run = spawnSync(
			join(root, "node_modules/.bin/biome"),
			["lint", "--only=plugin", "--colors=off", "src/server/planted.ts"],
			{ cwd: dir, encoding: "utf8" },
		);
		const out = run.stdout + run.stderr;
		const lines = [...out.matchAll(/planted\.ts:(\d+):\d+ plugin/g)].map((m) =>
			Number(m[1]),
		);
		return { status: run.status, out, lines };
	};

	it(
		"fails on static #methods and accessors, and says why and what instead",
		() => {
			const { status, out, lines } = lint(
				[
					"export class A {",
					"\tstatic #a(): number { return 1; }",
					"\tstatic async #b(): Promise<number> { return 2; }",
					"\tstatic get #c(): number { return 3; }",
					"\tstatic set #d(_v: number) {}",
					"\tstatic accessor #e = 5;",
					"\tstatic run(): number { A.#d = 1; void A.#b(); return A.#a() + A.#c + A.#e; }",
					"}",
					"",
				].join("\n"),
			);
			expect(status).not.toBe(0);
			expect(lines).toEqual([2, 3, 4, 5, 6]);
			expect(out).toContain("compile cache");
			expect(out).toContain("private static name()");
		},
		TIMEOUT,
	);

	it(
		"passes TS-private statics, static #fields, instance #methods and #accessors",
		() => {
			const { status, out } = lint(
				[
					"export class A {",
					"\tstatic #e = 1;",
					"\tprivate static g(): number { return A.#e; }",
					"\t#f(): number { return A.g(); }",
					"\taccessor #h = 2;",
					"\tget f(): number { return this.#f() + this.#h; }",
					"}",
					"",
				].join("\n"),
			);
			expect(out).not.toContain("plugin");
			expect(status).toBe(0);
		},
		TIMEOUT,
	);
});

// Why the rule exists, and when it can go: a class with 80 private methods
// and a static #method, run twice with the compile cache. V8 before 13.7
// (crbug 409512701; all of Node 24) fails the second, cached run with
// "Receiver must be class #…" or a segfault: almost always, as the bug
// hits only when the cached run's hash seed moves the class's name in a
// rehashed table, so up to 5 tries, each with a fresh cache, must see one
// failure. None failing on an older V8 means the fix reached this Node
// anyway (a backport, with no V8 minor bump): the test then fails to say
// so. Once every supported Node is fixed, the lint rule and this go.
it(
	"a static #method in a class of many private names survives the compile cache only on V8 13.7+",
	() => {
		const methods = Array.from(
			{ length: 80 },
			(_, i) => `\t#m${i}() { return ${i}; }`,
		);
		const source = [
			"class C {",
			...methods,
			"\tstatic #s(x) { return x + 1; }",
			"\tstatic run(x) { return C.#s(x); }",
			"}",
			"console.log(C.run(41));",
			"",
		].join("\n");
		writeFileSync(join(dir, "c.mjs"), source);
		const run = (cache: string) => {
			const env: NodeJS.ProcessEnv = {
				...process.env,
				NODE_COMPILE_CACHE: join(dir, cache),
			};
			delete env.NODE_DISABLE_COMPILE_CACHE;
			return spawnSync(process.execPath, [join(dir, "c.mjs")], {
				cwd: dir,
				env,
				encoding: "utf8",
			});
		};
		// One try: a fresh cache, filled by the first run, read by the second.
		const cachedRunFails = (cache: string) => {
			const first = run(cache);
			expect(first.stdout.trim()).toBe("42");
			const second = run(cache);
			if (second.status === 0) expect(second.stdout.trim()).toBe("42");
			return second.status !== 0;
		};
		const [major = 0, minor = 0] = process.versions.v8.split(".").map(Number);
		const fixed = major > 13 || (major === 13 && minor >= 7);
		if (fixed) {
			expect(cachedRunFails("cache")).toBe(false);
			return;
		}
		let failed = false;
		for (let i = 0; i < 5 && !failed; i++) failed = cachedRunFails(`cache${i}`);
		expect(
			failed,
			`V8 ${process.versions.v8} ran a cached static #method fine 5 times: the fix (crbug 409512701) seems to have reached this Node, maybe as a backport without a V8 minor bump. The no-static-private-method lint rule and this canary can go.`,
		).toBe(true);
	},
	TIMEOUT,
);
