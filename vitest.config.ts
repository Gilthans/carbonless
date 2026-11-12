import { availableParallelism } from "node:os";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { queuedWorkers, requireQueue } from "./scripts/queue-guard.mjs";
import { SlowFirstSequencer } from "./scripts/test-profile/sequencer";

// Interactive watch mode (`pnpm test:watch` in a terminal) runs unqueued; a
// one-shot run (`vitest run`, or any run without a TTY) takes its turn.
const watching =
	process.stdin.isTTY &&
	!process.env.CI &&
	!process.argv.some((a) => a === "run" || a === "--run");
if (!watching) requireQueue("pnpm test [files...]");

export default defineConfig({
	plugins: [react()],
	test: {
		include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
		setupFiles: ["test/setup.ts"],
		// Puts a trap in front of the real gh; the run fails if it is called.
		// Then the run's trace directory (docs/test-profiling.md).
		globalSetup: ["test/real-gh-trap.ts", "test/trace-setup.ts"],
		// Components opt into a browser-like environment with a
		// `// @vitest-environment jsdom` comment at the top of the file.
		environment: "node",
		// In the queue: the cores its slot gets (scripts/queue-guard.mjs).
		maxWorkers: queuedWorkers(availableParallelism()),
		// The slowest files start first, from Vitest's duration cache or,
		// in a fresh tree or CI, a checked-in list (docs/test-profiling.md).
		sequence: { sequencer: SlowFirstSequencer },
	},
});
