import { randomBytes } from "node:crypto";
import type { RecordedSpan, SpanContext } from "../../src/server/trace";

/*
 * A Playwright test result as spans (e2e/trace-reporter.ts writes them):
 * the test, and the steps worth a span (hooks, fixtures, test.step,
 * navigations) with the setup phase each stands for (`crb.phase`).
 * Expects and other API calls are left out: thousands, and their time is
 * the body's.
 */

/** The parts of Playwright's TestStep used here. */
export interface StepLike {
	title: string;
	category: string;
	startTime: Date;
	duration: number;
	steps: StepLike[];
	error?: { message?: string };
}

export interface TestLike {
	/** Spec file, relative to the repo. */
	file: string;
	/** The test's title path, without project and file. */
	title: string;
	project: string;
	worker: number;
	status: string;
	retry: number;
	startTime: Date;
	duration: number;
	steps: StepLike[];
	error?: string;
}

/** Our boxed fixture steps (e2e/fixtures.ts), by title. */
const STEP_PHASES: Record<string, string> = {
	"setup: fixture repo": "setup.fixture",
	"setup: crb serve": "setup.crb_serve",
	"setup: crb open": "setup.crb_open",
	"teardown: crb stop": "teardown.crb_stop",
};

const BROWSER_FIXTURES = new Set([
	'Fixture "browser"',
	'Fixture "context"',
	'Fixture "page"',
]);

function kept(step: StepLike): boolean {
	return (
		step.category === "hook" ||
		step.category === "fixture" ||
		step.category === "test.step" ||
		(step.category === "pw:api" && /^(Navigate|Reload)/.test(step.title))
	);
}

const newId = () => randomBytes(8).toString("hex");

/** The spans of one test result: the test's (ids `context`) first. */
export function testSpans(
	test: TestLike,
	context: SpanContext,
	makeId: () => string = newId,
): RecordedSpan[] {
	const start = test.startTime.getTime();
	const spans: RecordedSpan[] = [
		{
			name: `test: ${test.title}`,
			context,
			parent: null,
			startMs: start,
			endMs: start + Math.max(0, test.duration),
			attrs: {
				"crb.kind": "test",
				"test.file": test.file,
				"test.title": test.title,
				"test.project": test.project,
				"test.worker": test.worker,
				"test.status": test.status,
				"test.retry": test.retry,
			},
			error: test.error,
		},
	];
	let firstLoad = true;
	const walk = (steps: StepLike[], parent: SpanContext, hook: string) => {
		for (const step of steps) {
			if (!kept(step)) continue;
			const inHook = step.category === "hook" ? step.title : hook;
			let phase: string | undefined = STEP_PHASES[step.title];
			if (step.title === "Before Hooks") phase = "setup.other";
			else if (step.title === "After Hooks") phase = "teardown.other";
			else if (inHook === "Before Hooks" && BROWSER_FIXTURES.has(step.title)) {
				phase = "setup.browser";
			} else if (
				step.category === "pw:api" &&
				!inHook &&
				firstLoad &&
				step.title.startsWith("Navigate")
			) {
				firstLoad = false;
				phase = "setup.first_load";
			}
			const ctx = { traceId: context.traceId, spanId: makeId() };
			const s = step.startTime.getTime();
			spans.push({
				name: step.title,
				context: ctx,
				parent,
				startMs: s,
				endMs: s + Math.max(0, step.duration),
				attrs: { "step.category": step.category, "crb.phase": phase },
				error: step.error?.message?.slice(0, 200),
			});
			walk(step.steps, ctx, inHook);
		}
	};
	walk(test.steps, context, "");
	return spans;
}
