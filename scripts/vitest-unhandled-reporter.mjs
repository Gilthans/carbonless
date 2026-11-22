// A Vitest reporter for CI's failure labels (docs/ci-flakes.md): Vitest's
// JSON report leaves out unhandled errors (a rejection or a timer after a
// test ended), which fail a run whose every test passed. This writes them,
// each with the test file it came from when Vitest knows it, next to the
// JSON report ($CRB_TEST_JSON + ".unhandled.json"), for
// scripts/test-outcomes.mjs. vitest.config.ts adds it with the JSON reporter.
//
// Vitest may call this before the JSON reporter has made the report's
// folder, so it makes it (CAR-214). It is diagnostics only: a failed write
// is logged, never thrown, as Vitest would fail a green run over it.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export default class UnhandledReporter {
	onTestRunEnd(_modules, errors) {
		const report = process.env.CRB_TEST_JSON;
		if (!report) return;
		const out = (errors ?? []).map((e) => ({
			message: String(e?.message ?? e),
			file: e?.VITEST_TEST_PATH ?? null,
		}));
		const file = `${report}.unhandled.json`;
		try {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, JSON.stringify({ errors: out }));
		} catch (e) {
			console.warn(
				`vitest-unhandled-reporter: couldn't write ${file}: ${e?.message ?? e}`,
			);
		}
	}
}
