// CAR-260: lint enforces CLAUDE.md's test rules (biome-plugins/no-*.grit,
// scoped in biome.json). Each rule fires on a bad sample and stays quiet on
// good code, and on the same code where its scope doesn't reach.
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
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

/** Planted files: path → source. Line numbers below count from 1. */
const planted: Record<string, string> = {
	// no-wait-for-timeout
	"e2e/wait.spec.ts": [
		"test('x', async ({ page }) => {",
		"\tawait page.waitForTimeout(100);",
		"\tawait expect(page.getByText('a')).toBeVisible();",
		"});",
	].join("\n"),
	// no-test-retries
	"playwright.config.ts": [
		"export default defineConfig({",
		"\tretries: process.env.CI ? 2 : 0,",
		"});",
	].join("\n"),
	"vitest.config.ts": [
		"export default defineConfig({ test: { retry: 3 } });",
		"export const ok = defineConfig({ test: { retry: 0 } });",
	].join("\n"),
	"src/retries.test.ts": [
		"it('a', { retry: 2 }, () => {});",
		"test.describe.configure({ retries: 1 });",
		"it('b', async () => {",
		"\tawait post('/x', { retry: true });",
		"\tsend({ retries: 4 });",
		"});",
		"describe('c', { retry: 0 }, () => {});",
		"it('d', () => {}, { retry: 2 });",
		"export const short = defineConfig({ retries });",
		"it('e', () => {}, 10_000);",
	].join("\n"),
	// no-wall-clock-assert
	"src/wall.test.ts": [
		"it('a', async () => {",
		"\tconst started = Date.now();",
		"\tawait run();",
		"\texpect(Date.now() - started).toBeLessThan(1000);",
		"\texpect(performance.now() - started).toBeGreaterThan(5);",
		"\texpect(cpuRatio(a, b)).toBeLessThan(2);",
		"\texpect(end - start).toBe(3);",
		"\tconst old = new Date(Date.now() - 1000);",
		"});",
	].join("\n"),
	// no-sleep-in-tests
	"src/sleep.test.ts": [
		"it('a', async () => {",
		"\tawait new Promise((r) => setTimeout(r, 50));",
		"\tawait new Promise((resolve) => setTimeout(resolve, 20));",
		"\tawait new Promise((done) => setTimeout(() => done('late'), 1000));",
		"\tawait new Promise((r) => setTimeout(r, 0));",
		"\twhile (!ready()) await new Promise((r) => setTimeout(r, 20));",
		"\tfor (let i = 0; i < 9; i++) await new Promise((r) => setTimeout(r, 20));",
		"\tsetTimeout(() => stop.abort(), 100);",
		"\t// biome-ignore lint/plugin/no-sleep-in-tests: a fake's latency",
		"\tawait new Promise((r) => setTimeout(r, 30));",
		"\tawait new Promise<void>((r) => setTimeout(r, 50));",
		"\tawait new Promise((r) => globalThis.setTimeout(r, 50));",
		"\tawait new Promise((r) => window.setTimeout(r, 50));",
		"\tfor (const x of xs) await new Promise((r) => setTimeout(r, 20));",
		"\tdo await new Promise((r) => setTimeout(r, 20)); while (!ready());",
		"\tfor (;;) { if (ready()) break; await new Promise((r) => setTimeout(r, 20)); }",
		"\tawait Promise.race([p, new Promise((d) => setTimeout(() => d(1), 1000))]);",
		"\tawait quietFor(20, 'a second call');",
		"\tawait quietFor(1500, 'a retry');",
		"\tawait quietFor(500, 'a refetch');",
		"});",
		"afterEach(async () => {",
		"\tawait quietFor(5, 'a late save');",
		"});",
	].join("\n"),
	"src/timers.test.ts": [
		'import { setTimeout as sleep } from "node:timers/promises";',
		'import { setTimeout as later } from "timers/promises";',
		'import { setInterval } from "node:timers";',
	].join("\n"),
	// In scope: a helper directly in test/.
	"test/helper.ts": [
		"export const nap = () => new Promise((r) => setTimeout(r, 50));",
	].join("\n"),
	// Out of every test rule's scope: app code, and the fakes.
	"src/server/app.ts": [
		"export async function backoff(page) {",
		"\tawait new Promise((r) => setTimeout(r, 50));",
		"\tawait page.waitForTimeout(1);",
		"\texpect(Date.now() - started).toBeLessThan(1000);",
		"\treturn defineConfig({ retries: 2 });",
		"}",
	].join("\n"),
	"test/fake-gh/slow.ts": [
		"export const slow = () => new Promise((r) => setTimeout(r, 50));",
	].join("\n"),
};

type Hit = { rule: string; line: number };
let dir: string;
let run: { status: number | null; out: string };
let hits: Record<string, Hit[]>;
let messages: string[];

beforeAll(() => {
	// The repo's own biome.json and plugins, in a throwaway tree (no git, so
	// no ignore file), linting the planted files.
	dir = mkdtempSync(join(tmpdir(), "crb-rule-plugins-"));
	const config = JSON.parse(readFileSync(join(root, "biome.json"), "utf8"));
	config.vcs = { enabled: false };
	config.files = { includes: ["**"] };
	writeFileSync(join(dir, "biome.json"), JSON.stringify(config));
	cpSync(join(root, "biome-plugins"), join(dir, "biome-plugins"), {
		recursive: true,
	});
	for (const [path, source] of Object.entries(planted)) {
		mkdirSync(join(dir, dirname(path)), { recursive: true });
		writeFileSync(join(dir, path), `${source}\n`);
	}
	const lint = spawnSync(
		join(root, "node_modules/.bin/biome"),
		[
			"lint",
			"--only=plugin",
			"--reporter=json",
			"--max-diagnostics=none",
			...Object.keys(planted),
		],
		{ cwd: dir, encoding: "utf8" },
	);
	run = { status: lint.status, out: lint.stdout + lint.stderr };
	const report = JSON.parse(lint.stdout) as {
		diagnostics: {
			message: string;
			location: { path: string; start: { line: number } };
		}[];
	};
	hits = {};
	messages = report.diagnostics.map((d) => d.message);
	for (const d of report.diagnostics) {
		const rule = d.message.split(":")[0] ?? "";
		const list = hits[d.location.path] ?? [];
		list.push({ rule, line: d.location.start.line });
		hits[d.location.path] = list;
	}
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const linesOf = (path: string, rule: string) =>
	(hits[path] ?? [])
		.filter((h) => h.rule === rule)
		.map((h) => h.line)
		.sort((a, b) => a - b);

describe("lint: the test rules", () => {
	it("every plugin loads (a broken .grit only logs, it fails nothing)", () => {
		expect(run.out).not.toMatch(/errored/);
		expect(run.status).not.toBe(0);
	});

	it("each message names its rule and points to CLAUDE.md's test rules", () => {
		expect(messages.length).toBeGreaterThan(0);
		for (const message of messages) {
			expect(message).toMatch(/^no-[a-z-]+: /);
			expect(message).toContain("CLAUDE.md test rules");
		}
	});

	it("no-wait-for-timeout: page.waitForTimeout in e2e", () => {
		expect(linesOf("e2e/wait.spec.ts", "no-wait-for-timeout")).toEqual([2]);
	});

	it("no-test-retries: a config's or a test's retries, not 0 and not app data", () => {
		expect(linesOf("playwright.config.ts", "no-test-retries")).toEqual([2]);
		expect(linesOf("vitest.config.ts", "no-test-retries")).toEqual([1]);
		expect(linesOf("src/retries.test.ts", "no-test-retries")).toEqual([
			1, 2, 8, 9,
		]);
	});

	it("no-wall-clock-assert: elapsed Date.now()/performance.now() in expect", () => {
		expect(linesOf("src/wall.test.ts", "no-wall-clock-assert")).toEqual([4, 5]);
	});

	it("no-sleep-in-tests: a fixed sleep in any form, a counted loop of them, a race against one, timers/promises, quietFor in a hook or over 500 ms; not a 0 timer, a poll loop, a timer that isn't awaited, or an ignore", () => {
		expect(linesOf("src/sleep.test.ts", "no-sleep-in-tests")).toEqual([
			2, 3, 4, 7, 11, 12, 13, 14, 17, 19, 23,
		]);
		expect(linesOf("src/timers.test.ts", "no-sleep-in-tests")).toEqual([1, 2]);
		expect(linesOf("test/helper.ts", "no-sleep-in-tests")).toEqual([1]);
	});

	it("app code and the fakes are out of scope", () => {
		expect(hits["src/server/app.ts"]).toBeUndefined();
		expect(hits["test/fake-gh/slow.ts"]).toBeUndefined();
	});

	it("nothing else fires", () => {
		const expected = new Set([
			"e2e/wait.spec.ts",
			"playwright.config.ts",
			"vitest.config.ts",
			"src/retries.test.ts",
			"src/wall.test.ts",
			"src/sleep.test.ts",
			"src/timers.test.ts",
			"test/helper.ts",
		]);
		for (const [path, list] of Object.entries(hits)) {
			expect(expected.has(path), `${path}: ${JSON.stringify(list)}`).toBe(true);
			const rules = new Set(list.map((h) => h.rule));
			expect(rules.size, `${path}: ${JSON.stringify(list)}`).toBe(1);
		}
	});
});
