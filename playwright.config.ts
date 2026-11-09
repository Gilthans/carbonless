import { availableParallelism } from "node:os";
import { defineConfig, devices } from "@playwright/test";

// Each test starts its own server on a throwaway git repo (see e2e/fixtures.ts),
// so there is no shared webServer here. Run via `pnpm test:e2e`, which builds first.
export default defineConfig({
	testDir: "e2e",
	fullyParallel: true,
	// A run that holds the machine-wide queue (scripts/queue.mjs) has the
	// machine to itself: a worker per core (the whole suite ~18% faster than
	// Playwright's half). Otherwise other runs may share it: the default.
	workers: process.env.CRB_QUEUE_HELD ? availableParallelism() : undefined,
	forbidOnly: !!process.env.CI,
	// No retries, in CI either: a flaky test must fail visibly to get fixed.
	retries: 0,
	// CI: annotations, a log, and an HTML report the workflow uploads on failure.
	reporter: process.env.CI
		? [["github"], ["list"], ["html", { open: "never" }]]
		: "list",
	// An expect waits for what the page brings: often a chain of requests
	// (a reload reads the overview, then the threads, then the comments),
	// which a machine running several suites stretches past the 5 s default.
	// Speed isn't what these tests check; a missing thing still fails.
	expect: { timeout: 10_000 },
	use: {
		trace: "retain-on-failure",
	},
	// The whole suite runs on desktop and on a phone. Pixel 7 is Chromium, so
	// no other browser needs installing; layout-specific tests skip on `isMobile`.
	// CRB_NO_PHONE=1 leaves the phone out (half the run): for changes that
	// don't touch layout (CLAUDE.md, "Development").
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		...(process.env.CRB_NO_PHONE
			? []
			: [{ name: "phone", use: { ...devices["Pixel 7"] } }]),
	],
});
