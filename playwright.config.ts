import { defineConfig, devices } from "@playwright/test";

// Each test starts its own server on a throwaway git repo (see e2e/fixtures.ts),
// so there is no shared webServer here. Run via `pnpm test:e2e`, which builds first.
export default defineConfig({
	testDir: "e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: process.env.CI ? "github" : "list",
	use: {
		trace: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
