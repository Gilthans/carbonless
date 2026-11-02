import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { testGitEnv } from "../test/git-fixture";
import {
	expect,
	OWNER_REPO,
	PR_NUMBER,
	type Pr,
	runCli,
	startServe,
	stopChild,
	test,
} from "./fixtures";

/** A free port, let go of. */
function freePort(): Promise<number> {
	return new Promise((done) => {
		const probe = createServer().listen(0, "127.0.0.1", () => {
			const address = probe.address();
			probe.close(() =>
				done(typeof address === "object" && address ? address.port : 0),
			);
		});
	});
}

/** A second PR (#8, "Second PR") on the same repo and head as #7. */
function addSecondPr(p: Pr): void {
	const head = p.repo.shas.at(-1) ?? "";
	execFileSync("git", ["update-ref", "refs/pull/8/head", head], {
		cwd: p.repo.path,
		env: testGitEnv(),
	});
	p.editScenario((s) => {
		const first = s.prs[PR_NUMBER];
		if (!first) throw new Error("no PR 7");
		s.prs[8] = {
			...first,
			view: {
				...first.view,
				number: 8,
				title: "Second PR",
				url: `https://github.com/${OWNER_REPO}/pull/8`,
			},
		};
	});
}

const title = (page: import("@playwright/test").Page) =>
	page.getByRole("heading", { level: 1 });

test("one server holds two reviews at once", async ({
	context,
	page,
	pr,
	startCrb,
}) => {
	const p = await pr();
	addSecondPr(p);
	const first = await startCrb();
	const second = await startCrb(`${OWNER_REPO}#8`);
	expect(new URL(first.url).port).toBe(new URL(second.url).port);
	expect(first.url).not.toBe(second.url);
	await page.goto(first.url);
	const other = await context.newPage();
	await other.goto(second.url);
	await expect(title(page)).toHaveText("Add widget cache");
	await expect(title(other)).toHaveText("Second PR");
	// Each still its own after the other is used.
	await page.reload();
	await expect(title(page)).toHaveText("Add widget cache");
	await other.close();
});

test("crb <pr> with no server starts one; the next crb <pr> uses it", async ({
	pr,
	workdir,
}) => {
	await pr();
	const port = await freePort();
	mkdirSync(join(workdir, "config", "carbonless"), { recursive: true });
	writeFileSync(
		join(workdir, "config", "carbonless", "config.json"),
		JSON.stringify({ serve: { port } }),
	);
	const stateFile = join(workdir, "state", "carbonless", "server.json");
	let pid = 0;
	try {
		const first = await runCli(workdir, [`${OWNER_REPO}#${PR_NUMBER}`]);
		expect(first.code, first.output).toBe(0);
		// Only the URL on stdout.
		expect(first.stdout).toMatch(
			new RegExp(`^http://127\\.0\\.0\\.1:${port}/r/[0-9a-z]{26}\\n$`),
		);
		pid = JSON.parse(readFileSync(stateFile, "utf8")).pid;
		expect(pid).toBeGreaterThan(0);
		expect(
			readFileSync(join(workdir, "state", "carbonless", "serve.log"), "utf8"),
		).toContain(`carbonless listening on http://127.0.0.1:${port}/`);

		const second = await runCli(workdir, [
			`https://github.com/${OWNER_REPO}/pull/${PR_NUMBER}`,
		]);
		expect(second.code, second.output).toBe(0);
		expect(second.stdout).toBe(first.stdout);
		expect(JSON.parse(readFileSync(stateFile, "utf8")).pid).toBe(pid);
	} finally {
		if (pid) process.kill(pid, "SIGTERM");
	}
});

test("a worktree's private config (port 0): crb <pr> starts a server on a free port, never 4747, and links to it", async ({
	pr,
	workdir,
}) => {
	await pr();
	// What scripts/agent-worktree.sh writes, in the e2e environment's dirs.
	mkdirSync(join(workdir, "config", "carbonless"), { recursive: true });
	writeFileSync(
		join(workdir, "config", "carbonless", "config.json"),
		JSON.stringify({ serve: { port: 0 } }),
	);
	const stateFile = join(workdir, "state", "carbonless", "server.json");
	let pid = 0;
	try {
		const run = await runCli(workdir, [`${OWNER_REPO}#${PR_NUMBER}`]);
		expect(run.code, run.output).toBe(0);
		const state = JSON.parse(readFileSync(stateFile, "utf8"));
		pid = state.pid;
		expect(state.port).not.toBe(4747);
		expect(state.port).toBeGreaterThan(0);
		expect(run.stdout).toMatch(
			new RegExp(`^http://127\\.0\\.0\\.1:${state.port}/r/[0-9a-z]{26}\\n$`),
		);
	} finally {
		if (pid) process.kill(pid, "SIGTERM");
	}
});

test("a review's address still works after the server restarts", async ({
	expectConsoleError,
	page,
	pr,
	startCrb,
	workdir,
}) => {
	// The page polls the stopped server; the unknown id is a 404.
	expectConsoleError(/net::ERR_|status of 404/);
	await pr();
	const s = await startCrb();
	await page.goto(s.url);
	await expect(title(page)).toHaveText("Add widget cache");
	await s.stop();
	await page.goto("about:blank");
	// The same port, a new process that never opened the review: a bookmark.
	const again = await startServe(workdir, ["--port", new URL(s.url).port]);
	try {
		await page.goto(s.url);
		await expect(title(page)).toHaveText("Add widget cache");
		await page.goto(`${s.url}/files`);
		await expect(
			page.getByRole("progressbar", { name: "Review progress" }),
		).toBeVisible();
		// An id no clone has: not found, and the way Home.
		const origin = new URL(s.url).origin;
		await page.goto(`${origin}/r/01zzzzzzzzzzzzzzzzzzzzzzzz`);
		await expect(page.getByTestId("not-found")).toHaveText("No such review.");
		await page.getByRole("link", { name: "Home" }).click();
		await expect(page).toHaveURL(`${origin}/`);
	} finally {
		await page.goto("about:blank");
		await stopChild(again.child);
	}
});

test("the logo goes Home", async ({ page, pr, startCrb }) => {
	await pr();
	const s = await startCrb();
	await page.goto(s.url);
	const home = page.getByRole("link", { name: "Home" });
	await expect(home).toBeVisible();
	await home.click();
	await expect(page).toHaveURL(`${new URL(s.url).origin}/`);
	// And back: the review as it was.
	await page.goBack();
	await expect(title(page)).toHaveText("Add widget cache");
});

test("/pr/<owner>/<repo>/<n> opens the PR's review, or says why it can't", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	// The page asks the server to open #99, which refuses (409).
	expectConsoleError(/409/);
	await pr();
	const s = await startCrb();
	const origin = new URL(s.url).origin;
	await page.goto(`${origin}/pr/acme/widget/7`);
	await expect(page).toHaveURL(s.url);
	await expect(title(page)).toHaveText("Add widget cache");
	await page.goto(`${origin}/pr/acme/widget/99`);
	await expect(page.getByTestId("not-found")).toContainText("not found");
	await expect(
		page.getByRole("main").getByRole("link", { name: "Home" }),
	).toBeVisible();
});

test("refuses a crb of another build, and says which runs", async ({
	pr,
	request,
	startCrb,
	workdir,
}) => {
	await pr();
	const s = await startCrb();
	const origin = new URL(s.url).origin;
	const build = JSON.parse(
		readFileSync(new URL("../dist/build-info.json", import.meta.url), "utf8"),
	);
	const res = await request.post(`${origin}/api/reviews`, {
		data: { pr: `${OWNER_REPO}#${PR_NUMBER}` },
		headers: {
			"x-crb-version": JSON.stringify({
				version: "0.0.1",
				commit: "abc1234".padEnd(40, "0"),
			}),
		},
	});
	expect(res.status()).toBe(409);
	const body = await res.json();
	expect(body.code).toBe("version-mismatch");
	expect(body.server).toEqual(build);
	expect(body.error).toContain(
		`server runs ${build.version} (${build.commit.slice(0, 7)}`,
	);
	expect(body.error).toContain("this crb is 0.0.1 (abc1234)");
	expect(await (await request.get(`${origin}/api/version`)).json()).toEqual(
		build,
	);
	const version = await runCli(workdir, ["--version"]);
	expect(version.stdout.trim()).toBe(
		`${build.version} (${build.commit.slice(0, 7)}${build.commit.endsWith("-dirty") ? "-dirty" : ""})`,
	);
});

test("each option goes with its command", async ({ workdir }) => {
	const serve = await runCli(workdir, ["serve", "--open"]);
	expect(serve.code).toBe(1);
	expect(serve.output).toContain("crb: --open belongs to crb <pr>");
	const client = await runCli(workdir, ["acme/widget#7", "--port", "1"]);
	expect(client.code).toBe(1);
	expect(client.output).toContain("crb: --port belongs to crb serve");
});
