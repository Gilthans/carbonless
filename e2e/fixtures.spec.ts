import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readRequests, type Span, spansOf } from "../scripts/test-profile/load";
import { tracer } from "../src/server/trace";
import { testSpanContext } from "../test/trace-run";
import {
	CrbExitError,
	CrbStartTimeout,
	clientRequest,
	expect,
	NeedsCliError,
	OWNER_REPO,
	PR_NUMBER,
	runCli,
	startServe,
	stopChild,
	test,
	watchConsoleErrors,
} from "./fixtures";
import { crbEnv } from "./pr-setup";

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
test.describe("the client", () => {
	// The client process traces under the test too.
	test.use({ crbClient: "cli" });

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
});

// startCrb opens over HTTP unless a test asks for the CLI (e2e/crb-open.ts):
// it must open what `crb <pr>` would, and fail as it would.

test("startCrb over HTTP opens the review crb <pr> opens, flags and all", async ({
	pr,
	request,
	startCrb,
	workdir,
}) => {
	// Dated before the cutoff (as in comment-edits.spec.ts).
	const p = await pr({
		baseDate: "2026-01-01T00:00:00Z",
		files: [
			{
				message: "PR change",
				files: { "new.txt": "new\n" },
				date: "2026-01-02T00:00:00Z",
			},
		],
	});
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((sc) => {
		const graphql = sc.prs[p.number]?.graphql;
		if (!graphql) throw new Error("no graphql");
		graphql.commits = [
			{ commit: { oid: head, committedDate: "2026-01-02T00:00:00Z" } },
		];
		sc.commits = { [head]: { contexts: null } };
	});
	const pr7 = `${OWNER_REPO}#${PR_NUMBER}`;
	// What reached the server: the session's cutoff and pinned head, and
	// whether it has an agent (none as of a cutoff or as --viewer someone
	// else; the viewer is in neither the review's id nor the session's info).
	const plain = { asOf: null, pinnedHead: null, agent: 200 };
	const cases = [
		{ arg: pr7, args: [], seen: plain },
		{
			arg: pr7,
			args: ["--viewer", "someone-else"],
			body: { pr: pr7, viewer: "someone-else" },
			seen: { ...plain, agent: 404 },
		},
		{
			arg: pr7,
			args: [
				"--as-of",
				"2026-01-05T00:00:00+00:00",
				"--viewer",
				"someone-else",
			],
			// The client sends the cutoff normalized.
			body: { pr: pr7, asOf: "2026-01-05T00:00:00Z", viewer: "someone-else" },
			seen: { asOf: "2026-01-05T00:00:00Z", pinnedHead: null, agent: 404 },
		},
		{
			arg: pr7,
			args: ["--head", head.slice(0, 7)],
			body: { pr: pr7, head: head.slice(0, 7) },
			seen: { asOf: null, pinnedHead: head, agent: 200 },
		},
		// A URL goes to the server as given, as the client sends it.
		{
			arg: `https://github.com/${OWNER_REPO}/pull/${PR_NUMBER}`,
			args: [],
			seen: plain,
		},
	];
	const urls: string[] = [];
	for (const c of cases) {
		if (c.body) expect(clientRequest(c.arg, c.args)).toEqual(c.body);
		const http = await startCrb(c.arg, c.args);
		const api = `${new URL(http.url).origin}/api/r/${new URL(http.url).pathname.split("/").at(-1)}`;
		const session = await (await request.get(`${api}/session`)).json();
		const agent = (await request.get(`${api}/agent`)).status();
		expect({
			asOf: session.asOf,
			pinnedHead: session.pinnedHead,
			agent,
		}).toEqual(c.seen);
		// The CLI against the same server (it finds it through server.json).
		const cli = await runCli(workdir, [c.arg, ...c.args]);
		expect(cli.code).toBe(0);
		expect(cli.stdout).toBe(`${http.url}\n`);
		urls.push(http.url);
	}
	// The cutoff and the head make reviews of their own; the viewer and the
	// URL form are #7's.
	const [first, viewer, asOf, pinned, url] = urls;
	expect(new Set([first, asOf, pinned]).size).toBe(3);
	expect(viewer).toBe(first);
	expect(url).toBe(first);
});

test("a failed open over HTTP carries the server's error, in the client's words", async ({
	pr,
	startCrb,
	workdir,
}) => {
	await pr();
	const error = await startCrb(`${OWNER_REPO}#99`).catch((e: unknown) => e);
	expect(error).toBeInstanceOf(CrbExitError);
	const exit = error as CrbExitError;
	expect(exit.code).toBe(1);
	const cli = await runCli(workdir, [`${OWNER_REPO}#99`]);
	expect(cli.code).toBe(1);
	expect(cli.output).toMatch(/^crb: .*not found/);
	// The server's log of this open, then what the client would print.
	expect(exit.output.endsWith(cli.output)).toBe(true);
});

test("startCrb over HTTP refuses what only the CLI does, naming crbClient", async ({
	pr,
	startCrb,
}) => {
	await pr();
	for (const [arg, args] of [
		[`${PR_NUMBER}`, []],
		[`${OWNER_REPO}#0`, []],
		[undefined, ["--open"]],
		[undefined, ["--head", "tip"]],
		[undefined, ["--head", "reviewed", "--as-of", "2026-01-01T00:00Z"]],
	] as const) {
		const error = await startCrb(arg, [...args]).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(NeedsCliError);
		expect((error as Error).message).toContain('crbClient: "cli"');
	}
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
	const error = await startServe(workdir, [], crbEnv(workdir), 1).catch(
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
