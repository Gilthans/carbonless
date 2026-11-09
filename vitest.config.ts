import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	test: {
		include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
		setupFiles: ["test/setup.ts"],
		// Puts a trap in front of the real gh; the run fails if it is called.
		globalSetup: ["test/real-gh-trap.ts"],
		// Components opt into a browser-like environment with a
		// `// @vitest-environment jsdom` comment at the top of the file.
		environment: "node",
		// A safety net: a teardown that never settles ends the run here
		// rather than leaving it up. It can't end a microtask loop (a waitFor
		// callback that writes the DOM wakes its own MutationObserver, so
		// timers never fire); only not writing does (test/markable.ts). CI
		// adds a wall-clock limit per test step (.github/workflows/ci.yml).
		teardownTimeout: 10_000,
	},
});
