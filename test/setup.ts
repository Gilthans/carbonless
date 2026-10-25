import "@testing-library/jest-dom/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// No test may touch the reviewer's real clone cache (~/.cache/carbonless),
// and parallel runs (e.g. in two worktrees) must not share one: each test
// file gets its own XDG_CACHE_HOME unless it sets its own.
const cache = mkdtempSync(join(tmpdir(), "crb-unit-cache-"));
process.env.XDG_CACHE_HOME = cache;
afterAll(() => rmSync(cache, { recursive: true, force: true }));
