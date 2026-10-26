import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	test: {
		include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
		setupFiles: ["test/setup.ts"],
		// Components opt into a browser-like environment with a
		// `// @vitest-environment jsdom` comment at the top of the file.
		environment: "node",
	},
});
