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
	},
});
