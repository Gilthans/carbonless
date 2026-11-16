// A Vitest reporter for CI's failure labels (docs/ci-flakes.md): Vitest's
// JSON report leaves out unhandled errors (a rejection or a timer after a
// test ended), which fail a run whose every test passed. This writes them,
// each with the test file it came from when Vitest knows it, next to the
// JSON report ($CRB_TEST_JSON + ".unhandled.json"), for
// scripts/test-outcomes.mjs. vitest.config.ts adds it with the JSON reporter.
import { writeFileSync } from "node:fs";

export default class UnhandledReporter {
	onTestRunEnd(_modules, errors) {
		const report = process.env.CRB_TEST_JSON;
		if (!report) return;
		const out = (errors ?? []).map((e) => ({
			message: String(e?.message ?? e),
			file: e?.VITEST_TEST_PATH ?? null,
		}));
		writeFileSync(`${report}.unhandled.json`, JSON.stringify({ errors: out }));
	}
}
