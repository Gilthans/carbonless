import { existsSync, readFileSync } from "node:fs";
import { ghIdle } from "../src/server/gh";
import { writeFileAtomic } from "./fake-gh/atomic.mjs";
import type { Scenario } from "./fake-gh/scenario";

/** How long a fixture's cleanup waits for gh calls still running. */
export const GH_SETTLE_MS = 8000;

/**
 * Before a fixture takes the fake gh off PATH: opens every gate the
 * scenario at `scenarioPath` still holds (a test that failed before its
 * release()), then waits for the gh calls still running, so none ends on
 * the real gh. Fails naming the calls when they don't end in GH_SETTLE_MS.
 */
export async function settleGh(scenarioPath?: string): Promise<void> {
	if (scenarioPath && existsSync(scenarioPath)) {
		const s = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;
		if (s.hold?.length) {
			s.hold = [];
			writeFileAtomic(scenarioPath, JSON.stringify(s, null, "\t"));
		}
	}
	await ghIdle(GH_SETTLE_MS);
}
