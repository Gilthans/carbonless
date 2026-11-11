import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
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

/** Approves `request` in the page and collects the approved attach. */
async function approve(page: Page, reviewUrl: string, request: string) {
	await joinBar(page).getByRole("button", { name: "Approve" }).click();
	const out = await callTool(mcpUrl(reviewUrl), "attach", {
		review: reviewLink(reviewUrl),
		...SESSION,
		request,
	});
	expect(out.state).toBe("approved");
	return out as { token: string; watch: string; waiting: number };
}

const hasCurl = (() => {
	try {
		execFileSync("sh", ["-c", "command -v curl"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

/** A running watcher: the session's background command. */
interface Watcher {
	/** Its exit: code and what it printed. */
	done: Promise<{ code: number | null; out: string }>;
	/** Drops it as a lost network would (no line, no exit code of crb's). */
	drop: () => void;
}

/**
 * Runs the watch command `attach` returned, as the session would in the
 * background: the very line under `sh` with the real curl. Without curl
 * on PATH, the same request streamed with fetch.
 */
function startWatcher(watch: string, token: string): Watcher {
	const w = spawnWatcher(watch, token);
	running.add(w);
	return w;
}

/** Every watcher a test started: afterEach kills them, whatever the test did. */
const running = new Set<Watcher>();

test.afterEach(() => {
	for (const w of running) w.drop();
	running.clear();
});

function spawnWatcher(watch: string, token: string): Watcher {
	if (hasCurl) {
		// Its own process group, so a drop takes curl down with sh.
		const child: ChildProcess = spawn("sh", ["-c", watch], {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout?.on("data", (b: Buffer) => {
			out += b.toString();
		});
		const done = new Promise<{ code: number | null; out: string }>((res) =>
			// close, not exit: stdout may still be delivering crb's line at exit.
			child.on("close", (code) => res({ code, out })),
		);
		return {
			done,
			drop: () => {
				if (child.pid && child.exitCode === null) {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {}
				}
			},
		};
	}
	const url = watch.match(/'(https?:\/\/[^']+\/mcp\/watch\/[^']+)'/)?.[1];
	if (!url) throw new Error(`no watch URL in ${watch}`);
	const abort = new AbortController();
	const done = (async () => {
		try {
			const r = await fetch(url, {
				headers: { authorization: `Bearer ${token}` },
				signal: abort.signal,
			});
			const text = await r.text();
			const line = text.split("\n").find((l) => l.startsWith("carbonless:"));
			return { code: line ? 0 : 1, out: line ? `${line}\n` : "" };
		} catch {
			return { code: null, out: "" };
		}
	})();
	return { done, drop: () => abort.abort() };
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

test("the full loop: the watcher wakes the session for a question, its reply lands under its name; a dropped watcher reconnects, then leaves as disconnected", async ({
	page,
	pr,
	agentCrb,
	acpLogPath,
}) => {
	// Test-only: the grace window ends when this file exists (a gate on the
	// test's cue), not after the real minute.
	const gate = test.info().outputPath("grace-gate");
	// Five waits ride on the chip's 5 s status poll (ready, busy, ready,
	// reconnecting, the toast): over the default 30 s on a loaded machine.
	test.setTimeout(60_000);
	await pr(fixture);
	const s = await agentCrb({ env: { CRB_JOIN_GRACE_GATE: gate } });
	const section = await openFile(page, s.url, CALC);
	await expect(chip(page)).toHaveAttribute("data-state", "ready");
	const request = await attach(s.url);
	const approved = await approve(page, s.url, request);
	expect(approved.waiting).toBe(0);
	// The session runs the watch line in the background at once, as the
	// instructions say (the grace window runs from the Approve): listening.
	const first = startWatcher(approved.watch, approved.token);
	await expect(chip(page)).toHaveAttribute("data-via", "mcp");
	await expect(chip(page)).toHaveAttribute("data-state", "ready");
	// A question asked in the page wakes it: crb's one line, exit 0.
	const card = await ask(page, section, 3, "Why total?");
	const woke = await first.done;
	expect(woke.code).toBe(0);
	expect(woke.out.trim()).toMatch(
		/^carbonless: a question is waiting on [^\n]+#\d+\. Call crb's next tool/,
	);
	expect(woke.out.trim().split("\n")).toHaveLength(1);
	// next hands it the question; reply lands the answer in the card.
	const next = await callTool(mcpUrl(s.url), "next", {
		token: approved.token,
	});
	expect(next.thread).toEqual(expect.any(String));
	expect(JSON.stringify(next.envelope)).toContain("Why total?");
	await expect(chip(page)).toHaveAttribute("data-state", "busy");
	const replied = await callTool(mcpUrl(s.url), "reply", {
		token: approved.token,
		thread: next.thread,
		replyTo: next.replyTo,
		text: "Because the **sum** is needed.",
	});
	expect(replied.ok).toBe(true);
	// It runs the watch line again at once (the grace runs from the reply).
	const second = startWatcher(approved.watch, approved.token);
	await expect(card).toHaveAttribute("aria-label", "Agent thread, answered");
	await expect(card.getByTestId("agent-message-ai")).toHaveText(
		"Because the sum is needed.",
	);
	await expect(card).toContainText(SESSION.name);
	// The ACP buddy never answered: it was off from the Approve.
	expect(
		acpLog(acpLogPath).filter((e) => e.method === "session/prompt"),
	).toHaveLength(0);
	// Listening again.
	await expect(chip(page)).toHaveAttribute("data-state", "ready");
	// The watcher drops (no line, not crb's doing): reconnecting at once…
	second.drop();
	await expect(chip(page)).toHaveAttribute("data-state", "reconnecting");
	await expect(chip(page)).toHaveAttribute("data-via", "mcp");
	// …and once the grace window ends (the gate opens), it has left as lost.
	writeFileSync(gate, "");
	const toast = page.getByTestId("join-toast");
	await expect(toast).toContainText(`${SESSION.name} disconnected`);
	await expect(chip(page)).toHaveAttribute("data-state", "off");
	await expect(chip(page)).not.toHaveAttribute("data-via", "mcp");
	// Its token is dead: a watcher run now gets 410, and the line exits 3.
	const late = startWatcher(approved.watch, approved.token);
	if (hasCurl) expect((await late.done).code).toBe(3);
});
