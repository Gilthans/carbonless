import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import UnhandledReporter from "./vitest-unhandled-reporter.mjs";

// The reporter leans on Vitest's reporter API (`onTestRunEnd`'s unhandled
// errors, each with VITEST_TEST_PATH): a Vitest that changes either must
// fail here, not quietly turn every unhandled error into "non-test"
// (docs/ci-flakes.md).
describe("vitest-unhandled-reporter", () => {
	let dir = "";
	const saved = process.env.CRB_TEST_JSON;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
		if (saved === undefined) delete process.env.CRB_TEST_JSON;
		else process.env.CRB_TEST_JSON = saved;
	});

	it("writes each error with its test file next to the JSON report", () => {
		dir = mkdtempSync(join(tmpdir(), "unhandled-"));
		process.env.CRB_TEST_JSON = join(dir, "report.json");
		new UnhandledReporter().onTestRunEnd(
			[],
			[
				Object.assign(new Error("late"), { VITEST_TEST_PATH: "/r/a.test.ts" }),
				"a string",
			],
		);
		expect(
			JSON.parse(readFileSync(join(dir, "report.json.unhandled.json"), "utf8")),
		).toEqual({
			errors: [
				{ message: "late", file: "/r/a.test.ts" },
				{ message: "a string", file: null },
			],
		});
	});

	it("a real Vitest run with a late rejection: the error and its file", () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "unhandled-")));
		// No imports in the fixture (globals): it runs from a temp dir with
		// no node_modules, under a config of its own (not this repo's).
		writeFileSync(
			join(dir, "late.test.mjs"),
			`it("passes, then rejects after it ended", () => {
	setTimeout(() => Promise.reject(new Error("late boom")), 0);
});
it("waits for the rejection", () => new Promise((r) => setTimeout(r, 50)));
`,
		);
		writeFileSync(
			join(dir, "vitest.config.mjs"),
			`export default { test: { globals: true, include: ["*.test.mjs"], reporters: ["default", ${JSON.stringify(join(import.meta.dirname, "vitest-unhandled-reporter.mjs"))}] } };\n`,
		);
		const report = join(dir, "report.json");
		const r = spawnSync(
			process.execPath,
			[
				join(import.meta.dirname, "../node_modules/vitest/vitest.mjs"),
				"run",
				"--root",
				dir,
				"--config",
				join(dir, "vitest.config.mjs"),
			],
			{
				cwd: dir,
				encoding: "utf8",
				// Not this worker's Vitest state: a run of its own.
				env: {
					...Object.fromEntries(
						Object.entries(process.env).filter(
							([k]) => !k.startsWith("VITEST"),
						),
					),
					CRB_TEST_JSON: report,
					GITHUB_ACTIONS: "",
				},
				timeout: 120_000,
			},
		);
		// The unhandled error fails the run with every test passed.
		expect(r.status, r.stdout + r.stderr).toBe(1);
		const out = JSON.parse(readFileSync(`${report}.unhandled.json`, "utf8"));
		expect(out.errors).toEqual([
			{
				message: expect.stringContaining("late boom"),
				file: join(dir, "late.test.mjs"),
			},
		]);
	});
});
