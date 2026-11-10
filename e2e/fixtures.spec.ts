import { readRequests, type Span, spansOf } from "../scripts/test-profile/load";
import { tracer } from "../src/server/trace";
import { testSpanContext } from "../test/trace-run";
import { expect, test, watchConsoleErrors } from "./fixtures";

// The harness itself: console errors fail a test unless declared.

test("a declared console error passes", async ({
	page,
	expectConsoleError,
}) => {
	expectConsoleError(/expected boom/);
	await page.evaluate(() => console.error("expected boom"));
});

test("an undeclared console error is reported", async ({ context }) => {
	// A second page: the auto fixture watches only `page`, so this test sees
	// what the watcher reports without failing (no test.fail(), whose expected
	// failure prints a ✘ on every run).
	const other = await context.newPage();
	const watch = watchConsoleErrors(other);
	watch.expect(/expected boom/);
	await other.evaluate(() => {
		console.error("expected boom");
		console.error("surprise");
		setTimeout(() => {
			throw new Error("uncaught");
		});
	});
	await expect.poll(() => watch.unexpected()).toEqual(["surprise", "uncaught"]);
});

// Test traces (docs/test-profiling.md): what a test starts lands under its
// span, whose ids the reporter derives the same way. The reporter's own
// spans (the test, its setup phases) come after the test: see
// scripts/test-profile/test-profile.test.ts.
test("a test's crb, fake gh and fixture gits trace under its span", async ({
	pr,
	startCrb,
}, info) => {
	const dir = process.env.CRB_TRACE_DIR;
	const run = process.env.CRB_TRACE_RUN;
	test.skip(!dir || !run, "test traces are off (CRB_TEST_TRACES=0)");
	const ctx = testSpanContext(
		run as string,
		info.testId,
		info.retry,
		info.repeatEachIndex,
	);
	await pr();
	const crb = await startCrb();
	// Its file is written as it exits; the worker's on flush.
	await crb.stop();
	tracer().flush();

	const spans = spansOf(readRequests(dir as string, ctx.traceId));
	const byId = new Map(spans.map((s) => [s.spanId, s]));
	const under = (s: Span, ancestor: string): boolean => {
		for (let p = s.parent; p; p = byId.get(p)?.parent ?? null) {
			if (p === ancestor) return true;
		}
		return false;
	};
	const serve = spans.find(
		(s) => s.service === "crb" && s.name === "crb serve",
	);
	expect(serve?.parent).toBe(ctx.spanId);
	expect(
		spans.find((s) => s.service === "crb-client" && s.name === "crb <pr>")
			?.parent,
	).toBe(ctx.spanId);
	const gits = spans.filter(
		(s) => s.service === "crb" && s.name.startsWith("git "),
	);
	expect(gits.length).toBeGreaterThan(0);
	for (const git of gits) expect(under(git, serve?.spanId ?? "")).toBe(true);
	const fakes = spans.filter((s) => s.service === "fake-gh");
	expect(fakes.length).toBeGreaterThan(0);
	for (const fake of fakes) {
		expect(byId.get(fake.parent ?? "")?.name).toMatch(/^gh /);
		expect(under(fake, serve?.spanId ?? "")).toBe(true);
	}
	const fixtureGits = spans.filter(
		(s) => s.service === "playwright-worker" && s.attrs["crb.fixture"],
	);
	expect(fixtureGits.map((s) => s.name)).toContain("git init");
	for (const git of fixtureGits) expect(git.parent).toBe(ctx.spanId);
});
