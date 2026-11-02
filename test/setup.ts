import "@testing-library/jest-dom/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, vi } from "vitest";

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
