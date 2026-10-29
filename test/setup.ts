import "@testing-library/jest-dom/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// No test may touch the reviewer's real clone cache (~/.cache/carbonless),
// config or running server's state, and parallel runs (e.g. in two
// worktrees) must not share them: each test file gets its own
// XDG_CACHE_HOME, XDG_STATE_HOME and XDG_CONFIG_HOME unless it sets its own.
const xdg = mkdtempSync(join(tmpdir(), "crb-unit-xdg-"));
process.env.XDG_CACHE_HOME = join(xdg, "cache");
process.env.XDG_STATE_HOME = join(xdg, "state");
process.env.XDG_CONFIG_HOME = join(xdg, "config");
afterAll(() => rmSync(xdg, { recursive: true, force: true }));
