import "@testing-library/jest-dom/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";

// No test may touch the reviewer's real clone cache (~/.cache/carbonless),
// and parallel runs (e.g. in two worktrees) must not share one: each test
// file gets its own XDG_CACHE_HOME unless it sets its own.
const cache = mkdtempSync(join(tmpdir(), "crb-unit-cache-"));
process.env.XDG_CACHE_HOME = cache;
afterAll(() => rmSync(cache, { recursive: true, force: true }));

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
