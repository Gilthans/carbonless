import { connect } from "node:net";
import { CrbExitError, expect, test } from "./fixtures";

async function exitOf(promise: Promise<unknown>): Promise<CrbExitError> {
	const error = await promise.then(
		() => {
			throw new Error("crb started but should have exited");
		},
		(e: unknown) => e,
	);
	if (!(error instanceof CrbExitError)) throw error;
	return error;
}

test("rejects an argument that is not a PR", async ({ pr, startCrb }) => {
	await pr();
	const exit = await exitOf(startCrb("not-a-pr"));
	expect(exit.code).toBe(1);
	expect(exit.output).toContain("crb: Not a PR");
});

test("says when gh is not logged in", async ({ pr, startCrb }) => {
	await pr({ scenario: { loggedOut: true } });
	const exit = await exitOf(startCrb());
	expect(exit.code).toBe(1);
	expect(exit.output).toContain("gh is not logged in");
});

test("says when the PR does not exist", async ({ pr, startCrb }) => {
	await pr();
	const exit = await exitOf(startCrb("acme/widget#99"));
	expect(exit.code).toBe(1);
	expect(exit.output).toMatch(/crb: .*not found/);
});

test("a non-loopback host needs the access key", async ({
	page,
	pr,
	request,
	startCrb,
}) => {
	await pr();
	const s = await startCrb(undefined, ["--host", "0.0.0.0"]);
	expect(s.url).toContain("?key=");
	const url = new URL(s.url);
	const port = url.port;
	const bare = await request.get(`http://127.0.0.1:${port}/api/session`);
	expect(bare.status()).toBe(401);
	await page.goto(s.url.replace("0.0.0.0", "127.0.0.1"));
	await expect(
		page.getByRole("region", { name: "What it does" }),
	).toBeVisible();
});

test("the access key leaves the address bar once loaded, and Overview is the current tab", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr();
	const s = await startCrb(undefined, ["--host", "0.0.0.0"]);
	await page.goto(s.url.replace("0.0.0.0", "127.0.0.1"));
	const overview = page.getByRole("link", { name: "Overview" });
	await expect(overview).toHaveAttribute("aria-current", "page");
	await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/$/);
	// The cookie carries the key from here on.
	await page.reload();
	await expect(
		page.getByRole("region", { name: "What it does" }),
	).toBeVisible();
	await expect(overview).toHaveAttribute("aria-current", "page");
	await page.getByRole("link", { name: "Files changed" }).click();
	await expect(page).toHaveURL(/\/files$/);
	await page.reload();
	await expect(
		page.getByRole("link", { name: "Files changed" }),
	).toHaveAttribute("aria-current", "page");
});

test("can be restarted on the same PR", async ({ page, pr, startCrb }) => {
	await pr();
	const first = await startCrb();
	await first.stop();
	expect(first.output()).toContain("crb: cloning acme/widget…\n");
	expect(first.output()).toContain("crb: fetching PR #7…\n");
	const second = await startCrb();
	expect(second.output()).not.toContain("cloning");
	expect(second.output()).toContain("crb: fetching PR #7…\n");
	await page.goto(second.url);
	await expect(
		page.getByRole("region", { name: "What it does" }),
	).toBeVisible();
});

test("exits promptly on SIGTERM while a page is open", async ({
	expectConsoleError,
	page,
	pr,
	startCrb,
}) => {
	// The open page keeps polling the stopped server.
	expectConsoleError(/Failed to load resource: net::ERR_/);
	const p = await pr();
	// A read of GitHub stays under way: shutdown mustn't wait for it either.
	p.editScenario((sc) => {
		sc.hold = ["threads"];
	});
	const s = await startCrb();
	const threadsAsked = page.waitForRequest(
		(r) => new URL(r.url()).pathname === "/api/threads",
	);
	await page.goto(new URL("/files", s.url).href);
	await expect(
		page.getByRole("progressbar", { name: "Review progress" }),
	).toBeVisible();
	await threadsAsked;
	// Browsers also keep preconnected sockets that never send a request.
	const { hostname, port } = new URL(s.url);
	const preconnect = connect(Number(port), hostname);
	preconnect.on("error", () => {});
	await new Promise((done) => preconnect.once("connect", done));
	// stop() fails the test unless crb exits within STOP_GRACE_MS, far short
	// of the minute a wait for these sockets would take; the held read is
	// never released, so a shutdown waiting on it never ends.
	const exit = await s.stop();
	preconnect.destroy();
	expect(exit?.code).toBe(0);
});

test("--as-of needs an ISO time with a zone, and stays out of the usage", async ({
	pr,
	startCrb,
}) => {
	await pr();
	const exit = await exitOf(startCrb(undefined, ["--as-of", "2026-01-03"]));
	expect(exit.code).toBe(1);
	expect(exit.output).toMatch(/crb: Invalid --as-of: 2026-01-03/);
	const help = await exitOf(startCrb(undefined, ["--help"]));
	expect(help.output).toContain("Usage: crb");
	expect(help.output).not.toContain("as-of");
	expect(help.output).not.toContain("viewer");
});
