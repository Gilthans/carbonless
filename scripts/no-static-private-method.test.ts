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
					"\tstatic run(): number { A.#d = 1; void A.#b(); return A.#a() + A.#c; }",
					"}",
					"",
				].join("\n"),
			);
			expect(status).not.toBe(0);
			expect(lines).toEqual([2, 3, 4, 5]);
			expect(out).toContain("compile cache");
			expect(out).toContain("private static name()");
		},
		TIMEOUT,
	);

	it(
		"passes TS-private statics, static #fields and instance #methods",
		() => {
			const { status, out } = lint(
				[
					"export class A {",
					"\tstatic #e = 1;",
					"\tprivate static g(): number { return A.#e; }",
					"\t#f(): number { return A.g(); }",
					"\tget f(): number { return this.#f(); }",
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
// "Receiver must be class #…" or a segfault. Once every supported Node
// passes here, the lint rule can be dropped.
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
		const env: NodeJS.ProcessEnv = {
			...process.env,
			NODE_COMPILE_CACHE: join(dir, "cache"),
		};
		delete env.NODE_DISABLE_COMPILE_CACHE;
		const run = () =>
			spawnSync(process.execPath, [join(dir, "c.mjs")], {
				env,
				encoding: "utf8",
			});
		const first = run();
		expect(first.stdout.trim()).toBe("42");
		const second = run();
		const [major = 0, minor = 0] = process.versions.v8.split(".").map(Number);
		const fixed = major > 13 || (major === 13 && minor >= 7);
		if (fixed) {
			expect(second.stdout.trim()).toBe("42");
		} else {
			expect(second.status).not.toBe(0);
		}
	},
	TIMEOUT,
);
