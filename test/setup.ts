import "@testing-library/jest-dom/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeEach, expect, vi } from "vitest";
import { traceparent, tracer } from "../src/server/trace";

// No test may touch the reviewer's real clone cache (~/.cache/carbonless),
// config or running server's state, and parallel runs (e.g. in two
// worktrees) must not share them: each test file gets its own
// XDG_CACHE_HOME, XDG_STATE_HOME and XDG_CONFIG_HOME unless it sets its own.
const xdg = mkdtempSync(join(tmpdir(), "crb-unit-xdg-"));
process.env.XDG_CACHE_HOME = join(xdg, "cache");
process.env.XDG_STATE_HOME = join(xdg, "state");
process.env.XDG_CONFIG_HOME = join(xdg, "config");
afterAll(() => rmSync(xdg, { recursive: true, force: true }));

// Names the running test for the real gh trap (test/real-gh-trap.ts): a call
// that reaches it was started by this test or one before it in this file.
process.env.CRB_TEST_FILE = expect.getState().testPath ?? "?";
beforeEach((ctx) => {
	process.env.CRB_TEST_NAME = ctx.task.name;
});

// Test traces (docs/test-profiling.md): a trace per file, a span per test,
// and what a test runs in this process (crb's git and gh, fixture gits)
// under its test's span.
const traced = tracer("vitest");
if (traced.enabled) {
	// Forward slashes on every OS: the unit-durations list's keys.
	const path = relative(
		process.cwd(),
		expect.getState().testPath ?? "?",
	).replaceAll("\\", "/");
	const file = traced.start(
		`file: ${path}`,
		{ "crb.kind": "file", "test.file": path },
		{ parent: null },
	);
	traced.setDefaultParent(file.context);
	beforeEach((ctx) => {
		const span = traced.start(
			`test: ${ctx.task.name}`,
			{
				"crb.kind": "test",
				"test.file": path,
				// fullName starts with the file's path: dropped.
				"test.title": (ctx.task.fullName ?? ctx.task.name).replace(
					`${path} > `,
					"",
				),
			},
			{ parent: file.context },
		);
		traced.setDefaultParent(span.context);
		if (span.context) process.env.TRACEPARENT = traceparent(span.context);
		ctx.onTestFinished(({ task }) => {
			span.end({ "test.status": task.result?.state ?? "unknown" });
			traced.setDefaultParent(file.context);
			delete process.env.TRACEPARENT;
		});
	});
	afterAll(() => {
		file.end();
		traced.flush();
	});
}

// Component tests render whole pages in jsdom and drive them with
// user-event: CPU-bound work that, on a machine running several suites at
// once, takes several times as long. findBy* and waitFor wait for what a
// fetch or an effect brings (Testing Library's default: 1 s), and a test
// gets 20 s (vitest's: 5 s). Either still fails when the thing never comes.
if (typeof document !== "undefined") {
	const { configure } = await import("@testing-library/react");
	configure({ asyncUtilTimeout: 4000 });
	vi.setConfig({ testTimeout: 20_000 });
}
