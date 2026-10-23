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
	await pr();
	const s = await startCrb();
	await page.goto(new URL("/files", s.url).href);
	await expect(
		page.getByRole("progressbar", { name: "Clusters" }),
	).toBeVisible();
	// Browsers also keep preconnected sockets that never send a request.
	const { hostname, port } = new URL(s.url);
	const preconnect = connect(Number(port), hostname);
	preconnect.on("error", () => {});
	await new Promise((done) => preconnect.once("connect", done));
	const exit = await s.stop();
	preconnect.destroy();
	expect(exit?.code).toBe(0);
	expect(exit?.ms).toBeLessThan(2_000);
});
