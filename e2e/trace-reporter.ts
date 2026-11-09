import { relative } from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { compactRun } from "../scripts/test-profile/load";
import { testSpans } from "../scripts/test-profile/spans";
import { createTracer, type Tracer } from "../src/server/trace";
import { testSpanContext } from "../test/trace-run";

/**
 * Writes a span per test, with its setup phases and steps, to the run's
 * trace directory (docs/test-profiling.md). Ids match the worker's
 * (e2e/fixtures.ts `_trace`), so crb and the fake gh nest under it.
 */
export default class TraceReporter implements Reporter {
	#tracer: Tracer | null = null;
	#run = "";
	onBegin(): void {
		const dir = process.env.CRB_TRACE_DIR;
		this.#run = process.env.CRB_TRACE_RUN ?? "";
		if (!dir || !this.#run) return;
		this.#tracer = createTracer({
			dir,
			service: "e2e",
			resource: { "crb.run": this.#run },
		});
	}

	onTestEnd(test: TestCase, result: TestResult): void {
		const tracer = this.#tracer;
		if (!tracer) return;
		const [, project = "", , ...titles] = test.titlePath();
		const context = testSpanContext(
			this.#run,
			test.id,
			result.retry,
			test.repeatEachIndex,
		);
		const spans = testSpans(
			{
				file: relative(process.cwd(), test.location.file),
				title: titles.join(" › "),
				project,
				worker: result.workerIndex,
				status: result.status,
				retry: result.retry,
				startTime: result.startTime,
				duration: result.duration,
				steps: result.steps,
				error: result.error?.message?.slice(0, 200),
			},
			context,
		);
		const [own] = spans;
		if (own) own.attrs = { ...own.attrs, "crb.run": this.#run };
		for (const span of spans) tracer.record(span);
	}

	onEnd(): void {
		this.#tracer?.flush();
		// Packs the files of processes that are done (thousands of fake-gh ones).
		const dir = process.env.CRB_TRACE_DIR;
		if (this.#tracer && dir) compactRun(dir);
	}

	printsToStdio(): boolean {
		return false;
	}
}
