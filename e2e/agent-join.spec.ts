import type { Locator, Page } from "@playwright/test";
import { acpLog } from "../test/fake-acp/scenario";
import { ask, CALC, chip, expect, fixture, openFile, test } from "./agent-ui";
import { expectNoPageOverflow } from "./files-ui";

/**
 * A session joins a review through crb's /mcp (CAR-81): the request bar on
 * every page of the review, Approve and Deny, the chip showing the joined
 * session, Disconnect's toast with the ACP buddy left off. The session is
 * this test, speaking MCP's JSON-RPC over HTTP (Streamable HTTP, stateless)
 * with the tool names of the plan (reviews, attach, …).
 */

/** The review's /mcp endpoint, with its access key when it has one. */
function mcpUrl(reviewUrl: string): string {
	const u = new URL(reviewUrl);
	const key = u.searchParams.get("key");
	return `${u.origin}/mcp${key ? `?${new URLSearchParams({ key })}` : ""}`;
}

/** The review's link without its key (as the session would give it). */
const reviewLink = (reviewUrl: string) => {
	const u = new URL(reviewUrl);
	return `${u.origin}${u.pathname}`;
};

/** A JSON-RPC result from a JSON or an SSE (`data: …`) answer. */
async function rpcResult(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!response.ok) throw new Error(`/mcp ${response.status}: ${text}`);
	const json = (response.headers.get("content-type") ?? "").includes(
		"text/event-stream",
	)
		? text
				.split("\n")
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).trim())
				.at(-1)
		: text;
	const message = JSON.parse(json ?? "null") as {
		result?: unknown;
		error?: { message: string };
	};
	if (message.error) throw new Error(message.error.message);
	return message.result;
}

/** Calls MCP tool `name` and returns its result as JSON. */
async function callTool(
	url: string,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const post = (body: unknown) =>
		fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify(body),
		});
	await rpcResult(
		await post({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "e2e", version: "0" },
			},
		}),
	);
	const result = (await rpcResult(
		await post({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	)) as {
		structuredContent?: Record<string, unknown>;
		content?: Array<{ type: string; text?: string }>;
		isError?: boolean;
	};
	if (result.structuredContent) return result.structuredContent;
	const text = result.content?.find((c) => c.type === "text")?.text ?? "{}";
	return JSON.parse(text) as Record<string, unknown>;
}

const SESSION = { name: "carbonless · e2e-branch", machine: "devbox" };

/** The session asks to join: the pending request's id. */
async function attach(reviewUrl: string): Promise<string> {
	const out = await callTool(mcpUrl(reviewUrl), "attach", {
		review: reviewLink(reviewUrl),
		...SESSION,
		harness: "e2e 1.0",
	});
	expect(out.state).toBe("pending");
	expect(String(out.message)).toContain(reviewLink(reviewUrl));
	return String(out.request);
}

const joinBar = (page: Page) =>
	page.getByRole("region", { name: "Join request" });

/** Whether `el`'s centre is on top (not covered by the bar). */
const hittable = (el: Locator) =>
	el.evaluate((node) => {
		const r = node.getBoundingClientRect();
		const top = document.elementFromPoint(
			r.left + r.width / 2,
			r.top + r.height / 2,
		);
		return top !== null && node.contains(top);
	});

test("a session asks to join: the bar on every page of the review pushes the header down; Approve shows the session on the chip", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(fixture);
	const s = await agentCrb();
	await page.goto(s.url);
	await expect(chip(page)).toHaveAttribute("data-state", "ready");
	await expect(joinBar(page)).toHaveCount(0);
	const request = await attach(s.url);
	// On Overview…
	const bar = joinBar(page);
	await expect(bar.getByTestId("join-bar-name")).toHaveText(SESSION.name);
	await expect(bar.getByTestId("join-bar-machine")).toHaveText(SESSION.machine);
	// …pushing the header down, its buttons still on top.
	const header = page.locator("[data-app-header]");
	const barBox = await bar.boundingBox();
	const headerBox = await header.boundingBox();
	expect(headerBox?.y ?? 0).toBeGreaterThanOrEqual(
		(barBox?.y ?? 0) + (barBox?.height ?? 0) - 1,
	);
	for (const name of ["Refresh", "Settings"]) {
		expect(
			await hittable(page.getByRole("button", { name, exact: true })),
		).toBe(true);
	}
	for (const name of ["Deny", "Approve"]) {
		const box = await bar.getByRole("button", { name }).boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
		expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
	}
	await expectNoPageOverflow(page);
	// Approve says it replaces the running ACP agent.
	await expect(
		bar.getByRole("button", { name: "Approve" }),
	).toHaveAccessibleDescription("Replaces Fake Agent");
	// …and on Files changed, pinned while scrolled.
	await page.getByRole("link", { name: "Files changed" }).click();
	await expect(bar.getByTestId("join-bar-name")).toHaveText(SESSION.name);
	await page.evaluate(() => window.scrollBy(0, 600));
	await expect.poll(async () => (await bar.boundingBox())?.y ?? -1).toBe(0);
	expect(
		await hittable(page.getByRole("button", { name: "Settings", exact: true })),
	).toBe(true);
	await bar.getByRole("button", { name: "Approve" }).click();
	await expect(bar).toHaveCount(0);
	const approved = await callTool(mcpUrl(s.url), "attach", {
		review: reviewLink(s.url),
		...SESSION,
		request,
	});
	expect(approved.state).toBe("approved");
	expect(typeof approved.token).toBe("string");
	// The chip: the session, with the plug badge.
	await expect(chip(page)).toHaveAttribute("data-via", "mcp");
	await expect(chip(page).getByTestId("agent-chip-plug")).toBeVisible();
	await expect(chip(page)).toHaveAccessibleName(
		new RegExp(`^Your agent: ${SESSION.name} · `),
	);
	await expectNoPageOverflow(page);
});

test("Disconnect from the chip: the toast says it left, the question waits, the ACP buddy stays off", async ({
	page,
	pr,
	agentCrb,
	acpLogPath,
}) => {
	await pr(fixture);
	const s = await agentCrb();
	const section = await openFile(page, s.url, CALC);
	await expect(chip(page)).toHaveAttribute("data-state", "ready");
	const request = await attach(s.url);
	await joinBar(page).getByRole("button", { name: "Approve" }).click();
	await callTool(mcpUrl(s.url), "attach", {
		review: reviewLink(s.url),
		...SESSION,
		request,
	});
	await expect(chip(page)).toHaveAttribute("data-via", "mcp");
	// Asked while joined: the session (this test) doesn't answer.
	const card = await ask(page, section, 3, "Why total?");
	await expect(card.getByTestId("agent-waiting")).toBeVisible();
	await chip(page).click();
	const pop = page.getByTestId("agent-popover");
	await expect(pop.getByTestId("agent-pop-name")).toHaveText(SESSION.name);
	await expect(pop).toContainText(SESSION.machine);
	await pop.getByTestId("agent-disconnect").click();
	const toast = page.getByTestId("join-toast");
	await expect(toast).toContainText(`${SESSION.name} left`);
	await expect(chip(page)).toHaveAttribute("data-state", "off");
	await expect(chip(page)).not.toHaveAttribute("data-via", "mcp");
	// Two status polls later the ACP buddy is still off: the question waits
	// and the fake agent was never prompted.
	for (let i = 0; i < 2; i++) {
		await page.waitForResponse((r) =>
			/\/api\/r\/[^/]+\/agent$/.test(new URL(r.url()).pathname),
		);
	}
	await expect(card.getByTestId("agent-waiting")).toBeVisible();
	await expect(chip(page)).toHaveAttribute("data-state", "off");
	expect(
		acpLog(acpLogPath).filter((e) => e.method === "session/prompt"),
	).toHaveLength(0);
	// Start in the chip brings it back, and it answers.
	await chip(page).click();
	await page.getByTestId("agent-popover").getByTestId("agent-start").click();
	await expect(card).toHaveAttribute("aria-label", "Agent thread, answered");
});

test("Deny: the bar goes in every tab of the review, and the session hears denied", async ({
	page,
	context,
	pr,
	agentCrb,
}) => {
	await pr(fixture);
	const s = await agentCrb();
	await page.goto(s.url);
	const other = await context.newPage();
	await other.goto(s.url);
	const request = await attach(s.url);
	await expect(joinBar(page)).toBeVisible();
	await expect(joinBar(other)).toBeVisible();
	await joinBar(page).getByRole("button", { name: "Deny" }).click();
	await expect(joinBar(page)).toHaveCount(0);
	// The other tab's next poll.
	await expect(joinBar(other)).toHaveCount(0);
	const out = await callTool(mcpUrl(s.url), "attach", {
		review: reviewLink(s.url),
		...SESSION,
		request,
	});
	expect(out.state).toBe("denied");
	await expect(chip(page)).not.toHaveAttribute("data-via", "mcp");
});
