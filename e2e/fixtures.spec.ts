import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readRequests, type Span, spansOf } from "../scripts/test-profile/load";
import { tracer } from "../src/server/trace";
import { testSpanContext } from "../test/trace-run";
import {
	CrbStartTimeout,
	expect,
	startServe,
	stopChild,
	test,
	watchConsoleErrors,
} from "./fixtures";
import { CLI, crbEnv } from "./pr-setup";

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

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("a crb serve that prints no URL in time is killed, not left running", async ({
	workdir,
}) => {
	// 1 ms: no crb listens that soon, so the start timer fires.
	const error = await startServe(workdir, [], crbEnv(workdir), CLI, 1).catch(
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(CrbStartTimeout);
	const pid = (error as CrbStartTimeout).pid as number;
	try {
		await expect.poll(() => alive(pid)).toBe(false);
	} finally {
		if (alive(pid)) process.kill(pid, "SIGKILL");
	}
});

/** Files under `dir`, 0 when it doesn't exist. */
const filesIn = (dir: string) => {
	try {
		return readdirSync(dir, { recursive: true }).length;
	} catch {
		return 0;
	}
};

test("crb's compile cache: the run's shared one (global-setup.ts), else its own under XDG_CACHE_HOME", async ({
	workdir,
}) => {
	const shared = process.env.NODE_COMPILE_CACHE;
	expect(shared).toBeTruthy();
	const own = (dir: string) =>
		join(dir, "cache", "carbonless", "compile-cache");
	const start = async (dir: string, env: NodeJS.ProcessEnv) => {
		mkdirSync(dir);
		const served = await startServe(dir, [], env);
		return served;
	};
	// The harness's crb: the shared cache, none of its own.
	const a = join(workdir, "a");
	const first = await start(a, crbEnv(a));
	await stopChild(first.child);
	expect(filesIn(own(a))).toBe(0);
	expect(filesIn(shared as string)).toBeGreaterThan(0);
	// Without the variable (as it ships): crb's own default path fills.
	const b = join(workdir, "b");
	const env = crbEnv(b);
	delete env.NODE_COMPILE_CACHE;
	const second = await start(b, env);
	try {
		await expect.poll(() => filesIn(own(b))).toBeGreaterThan(0);
	} finally {
		await stopChild(second.child);
	}
});
