import { compactRun } from "../scripts/test-profile/load";
import { startTraceRun } from "./trace-run";

/**
 * Vitest global setup: the run's trace directory (test/trace-run.ts), set
 * in the main process so every worker and what it starts write there. At
 * the end, the files of processes that are done are packed into one.
 */
export default function setup() {
	const dir = startTraceRun("unit");
	return () => {
		if (dir) compactRun(dir);
	};
}
