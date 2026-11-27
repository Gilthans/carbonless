import type { Locator, Page, Route } from "@playwright/test";
import { holdAcp, releaseAcp } from "../test/fake-acp/scenario";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import {
	ask,
	CALC,
	expect,
	fixture,
	inBox,
	openFile,
	resolveWrites,
	row,
	scrollTopTo,
	storedResolved,
	test,
	topIn,
} from "./agent-ui";
import { expectNoPageOverflow } from "./files-ui";
import type { Pr, PrOptions } from "./fixtures";

// Its own crb serve: the agent's config, its fake ACP env and checkouts.
test.use({ crbServer: "own" });

/**
 * The thread agent (CAR-120): a private agent conversation per GitHub
 * thread, behind the agent handle at the thread card's bottom right (CAR-162),
 * sliding over the thread's comments. Against the fake ACP agent and the fake gh,
 * on the Overview and in Files changed, desktop and phone. One GitHub
 * thread by rev1 on src/calc.ts's line 3, open, no reply.
 */

const QUESTION = "Is total right?";
const AGENT = { name: "Fake Agent", version: "9.9.9" };

const shots = process.env.DESIGN_SHOTS;
async function shot(page: Page, name: string, isMobile: boolean) {
	if (!shots) return;
	await page.screenshot({
		path: `${shots}/${name}-${isMobile ? "phone" : "desktop"}.png`,
	});
}

async function setup(pr: (opts?: PrOptions) => Promise<Pr>): Promise<Pr> {
	const p = await pr(fixture);
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((s) => {
		const graph = s.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: CALC, line: 3, subjectType: "LINE" }, [
				threadComment({
					login: "rev1",
					text: QUESTION,
					createdAt: "2026-01-02T09:00:00Z",
					commit: head,
					diffHunk:
						"@@ -1,3 +1,3 @@\n export const v1 = 1;\n export const v2 = 2;\n-export const v3 = 3;\n+export const total = v1 + v2;",
				}),
			]),
		];
	});
	return p;
}

/** The Overview's card of the thread. */
const overviewCard = (page: Page) =>
	page
		.getByRole("region", { name: "Human reviews" })
		.getByTestId("thread")
		.filter({ hasText: QUESTION });

/** Files changed's thread, opened from its bubble on line 3. */
async function filesThread(page: Page, url: string): Promise<Locator> {
	const section = await openFile(page, url, CALC);
	await row(section, 3)
		.getByRole("button", { name: /^1 comment on line 3/ })
		.click();
	const thread = section.getByTestId("files-thread");
	await expect(thread).toBeVisible();
	return thread;
}

const agentButton = (card: Locator) => card.getByTestId("thread-agent-button");
const panel = (card: Locator) => card.getByTestId("thread-agent-panel");

/** Opens the conversation from the agent button: the panel in, the box asks the agent. */
async function openPanel(card: Locator) {
	await agentButton(card).click();
	await expect(panel(card)).toHaveAttribute("data-open", "true");
	await expect(agentButton(card)).toHaveAttribute("aria-pressed", "true");
	await expect(card.getByRole("textbox", { name: "Ask agent" })).toBeFocused();
}

/** The panel out, the thread back: the box replies again, focus on the agent button. */
async function expectClosed(card: Locator) {
	await expect(panel(card)).toHaveAttribute("data-open", "false");
	await expect(agentButton(card)).toHaveAttribute("aria-pressed", "false");
	await expect(card.getByTestId("thread-agent-strip")).toHaveCount(0);
	await expect(card.getByRole("textbox", { name: "Reply" })).toBeVisible();
	await expect(agentButton(card)).toBeFocused();
}

/** Types `text` in the open panel's composer and sends it. */
async function sendToAgent(card: Locator, text: string) {
	const box = card.getByRole("textbox", { name: "Ask agent" });
	await box.fill(text);
	await card.getByRole("button", { name: "Send to agent" }).click();
	await expect(box).toHaveValue("");
}

/** The seen mark's POST (`agent/threads/<id>/seen`). */
const SEEN = /\/agent\/threads\/[^/]+\/seen$/;

/** Holds every seen mark: what is new stays new while the test looks at it. */
async function holdSeen(page: Page) {
	await page.route(SEEN, () => {});
}

test("open a conversation from an Overview thread, get an answer, see the counter", async ({
	page,
	pr,
	agentCrb,
	acpScenario,
}) => {
	const p = await setup(pr);
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [{ text: "Yes: it adds **v1 and v2**.", chunks: 2 }],
			hold: ["prompt"],
		},
	});
	await page.goto(s.url);
	const card = overviewCard(page);
	// No conversation yet: the dashed "Ask agent", the box replies.
	await expect(agentButton(card)).toHaveAccessibleName("Ask agent");
	await expect(panel(card)).toHaveAttribute("data-open", "false");
	await openPanel(card);
	// The header and the composer row stay: the comment counter is a button now.
	await expect(card.getByTestId("thread-counter")).toBeVisible();
	await sendToAgent(card, "Does it add everything?");
	// Held after its first chunk: the question, the answer streaming, Stop.
	await expect(panel(card).getByTestId("agent-message-human")).toHaveText(
		/Does it add everything\?/,
	);
	const answering = panel(card).getByTestId("agent-answering");
	await expect(answering).toBeVisible();
	await expect(answering.getByTestId("agent-stop")).toBeVisible();
	// Asked from the Overview: the snapshot head (no patch set yet).
	await expect(panel(card).getByTestId("agent-view-chip")).toHaveText(
		p.head().slice(0, 7),
	);
	// Its seen mark, written once the answer has been in view a while.
	const seen = page.waitForResponse(
		(r) => SEEN.test(new URL(r.url()).pathname) && r.ok(),
	);
	releaseAcp(acpScenario, "prompt");
	const reply = panel(card).getByTestId("agent-message-ai");
	await expect(reply.locator("strong")).toHaveText("v1 and v2");
	await expect(answering).toHaveCount(0);
	// Two messages, open: the button says so and hides it on a press.
	await expect(agentButton(card)).toHaveAccessibleName(
		"2 agent messages: hide",
	);
	await expect(agentButton(card)).toHaveText("2");
	// Seen while open (the answer in view): the mark is written.
	await seen;
	await agentButton(card).click();
	await expectClosed(card);
	await expect(agentButton(card)).toHaveAccessibleName("2 agent messages");
	await expect(card.getByTestId("agent-unread-dot")).toHaveCount(0);
	// Kept in the agent ref: a reload counts it the same.
	await page.reload();
	await expect(agentButton(overviewCard(page))).toHaveAccessibleName(
		"2 agent messages",
	);
});

test("on code, with the viewer on the second tint (after rev1), the agent's answers stand apart from their messages (CAR-270)", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	// rev1 spoke first: the viewer gets person-2 (before CAR-270 a teal
	// next to the agent's).
	await setup(pr);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "Only v1 and v2." }] },
	});
	const section = await openFile(page, s.url, CALC);
	const card = await ask(page, section, 2, "What does total add?");
	const reply = card.getByTestId("agent-message-ai");
	await expect(reply).toHaveText("Only v1 and v2.");
	await shot(page, "agent-card-person-2", isMobile);
	const mine = card.getByTestId("agent-message-human");
	await expect(mine).toHaveClass(/\bbg-person-2\b/);
	const look = (l: typeof reply) =>
		l.evaluate((el) => {
			const st = getComputedStyle(el);
			return {
				bg: st.backgroundColor,
				left: st.borderLeftWidth,
				leftColor: st.borderLeftColor,
				top: st.borderTopColor,
			};
		});
	const [answer, human] = [await look(reply), await look(mine)];
	// The answer: a railed box, its own ground and edge, never the viewer's.
	expect(answer.left).toBe("3px");
	expect(answer.leftColor).not.toBe(answer.top);
	expect(human.left).toBe("1px");
	expect(answer.bg).not.toBe(human.bg);
	expect(answer.top).not.toBe(human.top);
});

test("a failed read: the panel keeps the error with a spinner in Retry's slot while it reads again, Send waits, never an empty conversation (CAR-124)", async ({
	page,
	pr,
	agentCrb,
	expectConsoleError,
}) => {
	// The failed reads (500s) Chromium logs.
	expectConsoleError(/500/);
	await setup(pr);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "Stored answer." }] },
	});
	await holdSeen(page);
	await page.goto(s.url);
	let card = overviewCard(page);
	await openPanel(card);
	await sendToAgent(card, "Anything?");
	await expect(panel(card).getByTestId("agent-message-ai")).toContainText(
		"Stored answer.",
	);
	// From here, the threads' GETs fail, are held, or pass, as the test says.
	let mode: "fail" | "hold" | "pass" = "fail";
	const held: Route[] = [];
	const fail = (route: Route) =>
		route.fulfill({ status: 500, body: '{"error":"boom"}' });
	await page.route(/\/agent\/threads(\?.*)?$/, async (route) => {
		if (route.request().method() !== "GET" || mode === "pass") {
			await route.continue();
			return;
		}
		if (mode === "fail") {
			await fail(route);
			return;
		}
		held.push(route);
	});
	// The status reads held too: a status that moves refetches the threads
	// (useAgentSync), and only the presses below may ask for them.
	const statusHeld: Route[] = [];
	await page.route(/\/agent(\?.*)?$/, async (route) => {
		if (route.request().method() !== "GET") {
			await route.continue();
			return;
		}
		statusHeld.push(route);
	});
	try {
		await page.reload();
		card = overviewCard(page);
		const button = agentButton(card);
		await expect(button).toHaveAttribute("data-failed", "true");
		const failed = panel(card).getByRole("alert");
		const retry = failed.getByRole("button", { name: "Retry" });
		const messages = panel(card).getByTestId("agent-message-human");
		const send = card.getByRole("button", { name: "Send to agent" });
		// Pressed, it opens the panel and reads again (held): the error
		// stays, with a spinner in Retry's slot; no empty conversation.
		mode = "hold";
		await button.click();
		await expect(panel(card)).toHaveAttribute("data-open", "true");
		await expect.poll(() => held.length).toBe(1);
		await expect(failed).toContainText("Agent messages couldn't load");
		await expect(failed).toHaveAttribute("aria-busy", "true");
		await expect(
			failed.getByRole("status", { name: "Loading agent messages" }),
		).toBeVisible();
		await expect(retry).toHaveAttribute("aria-disabled", "true");
		await expect(messages).toHaveCount(0);
		// Nothing known of the thread's conversation: a draft, no Send.
		await card.getByRole("textbox", { name: "Ask agent" }).fill("Again?");
		await expect(send).toBeDisabled();
		// That read fails too: the same error, Retry live.
		for (const route of held.splice(0)) await fail(route);
		await expect(failed).toHaveAttribute("aria-busy", "false");
		await expect(retry).toHaveAttribute("aria-disabled", "false");
		await expect(messages).toHaveCount(0);
		// One press of Retry asks once (held): the spinner in its slot, then
		// the conversation.
		await retry.click();
		await expect.poll(() => held.length).toBe(1);
		await expect(failed).toHaveAttribute("aria-busy", "true");
		await expect(messages).toHaveCount(0);
		mode = "pass";
		for (const route of held.splice(0)) await route.continue();
		await expect(panel(card).getByTestId("agent-message-ai")).toContainText(
			"Stored answer.",
		);
		await expect(messages).toHaveCount(1);
		await expect(failed).toHaveCount(0);
		await expect(send).toBeEnabled();
	} finally {
		await page.unroute(/\/agent(\?.*)?$/);
		for (const route of statusHeld.splice(0)) {
			await route.continue().catch(() => {});
		}
	}
});

test("the same from Files changed", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	const p = await setup(pr);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "Only v1 and v2." }] },
	});
	await holdSeen(page);
	const thread = await filesThread(page, s.url);
	await expect(agentButton(thread)).toHaveAccessibleName("Ask agent");
	await openPanel(thread);
	await sendToAgent(thread, "What does total add?");
	await expect(panel(thread).getByTestId("agent-message-ai")).toHaveText(
		"Only v1 and v2.",
	);
	await expect(agentButton(thread)).toHaveAccessibleName(
		"2 agent messages: hide",
	);
	// The question names the comparison it was asked in: the head viewed.
	await expect(panel(thread).getByTestId("agent-view-chip")).toHaveText(
		p.head().slice(0, 7),
	);
	await shot(page, "thread-agent-panel", isMobile);
	await agentButton(thread).click();
	await expectClosed(thread);
	// Its seen mark held: the answer is still new.
	await expect(agentButton(thread)).toHaveAccessibleName(
		"2 agent messages, 1 new",
	);
	// The thread's agent conversation is never an agent card or bubble of its own.
	const section = page.locator(`[data-path="${CALC}"]`);
	await expect(section.getByTestId("agent-thread")).toHaveCount(0);
	await expect(row(section, 3).getByTestId("agent-bubble")).toHaveCount(0);
	// Deleted on GitHub: after Refresh the conversation is a span on its
	// lines, never shown nowhere.
	p.editScenario((sc) => {
		const graph = sc.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [];
	});
	await page.getByRole("button", { name: "Refresh" }).first().click();
	await expect(
		row(section, 3).getByRole("button", { name: /^1 comment on line 3/ }),
	).toHaveCount(0);
	// Its answer still new (the seen mark held).
	await expect(
		row(section, 3).getByTestId("agent-bubble"),
	).toHaveAccessibleName("1 agent thread on line 3, 1 new");
});

test("opens scrolled to its end; closes from the strip, the comment counter and the agent button", async ({
	page,
	pr,
	agentCrb,
}) => {
	await setup(pr);
	const long = Array.from(
		{ length: 40 },
		(_, i) => `Line ${i + 1} of the answer.`,
	).join("\n\n");
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: `${long}\n\nThe end.` }] },
	});
	await holdSeen(page);
	let thread = await filesThread(page, s.url);
	await openPanel(thread);
	await sendToAgent(thread, "Tell me everything");
	await expect(panel(thread).getByTestId("agent-message-ai")).toContainText(
		"The end.",
	);
	// A fresh page: the conversation opens at its end, the latest answer in sight.
	await page.reload();
	thread = await filesThread(page, s.url);
	await openPanel(thread);
	const scroller = panel(thread).getByTestId("thread-agent-scroll");
	await expect(panel(thread).getByText("The end.")).toBeInViewport();
	const fits = await scroller.evaluate((el) => ({
		scrolls: el.scrollHeight > el.clientHeight,
	}));
	expect(fits.scrolls).toBe(true);
	// The three boxes in one layout.
	const { box, end, first } = await scroller.evaluate((el) => {
		const ai = [
			...el.querySelectorAll("[data-testid=agent-message-ai] *"),
		].find((n) => n.childElementCount === 0 && n.textContent === "The end.");
		const human = el.querySelector("[data-testid=agent-message-human]");
		const y = (n: Element | null | undefined) => {
			if (!n) throw new Error("no box");
			const r = n.getBoundingClientRect();
			return { y: r.y, height: r.height };
		};
		return { box: y(el), end: y(ai), first: y(human) };
	});
	// The end inside the scroller's box, the question above it (scrolled past).
	expect(end.y + end.height).toBeLessThanOrEqual(box.y + box.height + 1);
	expect(end.y).toBeGreaterThanOrEqual(box.y - 1);
	expect(first.y).toBeLessThan(box.y);
	// The strip: the comments' avatar column, at least 40px, brings them back.
	const strip = thread.getByRole("button", { name: "Back to the thread" });
	const stripBox = await strip.boundingBox();
	expect(stripBox?.width ?? 0).toBeGreaterThanOrEqual(40);
	await strip.click();
	await expectClosed(thread);
	// The comment counter.
	await openPanel(thread);
	await thread.getByTestId("thread-counter").click();
	await expectClosed(thread);
	// The agent button again.
	await openPanel(thread);
	await agentButton(thread).click();
	await expectClosed(thread);
	// The thread's comments are back, in reach.
	await expect(thread.getByText(QUESTION)).toBeVisible();
});

test("resolving the GitHub thread folds the conversation", async ({
	page,
	pr,
	agentCrb,
}) => {
	const p = await setup(pr);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "Not fixed yet." }] },
	});
	await holdSeen(page);
	const thread = await filesThread(page, s.url);
	await openPanel(thread);
	await sendToAgent(thread, "Fixed?");
	await expect(panel(thread).getByTestId("agent-message-ai")).toHaveText(
		"Not fixed yet.",
	);
	// The card's Resolve, the GitHub action, with the conversation open.
	await thread.getByRole("button", { name: "Resolve", exact: true }).click();
	await expect.poll(() => storedResolved(p)).toBe(true);
	// Closed down to its bubble, as a resolved thread is.
	const section = page.locator(`[data-path="${CALC}"]`);
	const bubble = row(section, 3).getByRole("button", {
		name: /^1 comment on line 3, resolved/,
	});
	await expect(bubble).toBeVisible();
	await bubble.click();
	const resolved = section.getByTestId("files-thread");
	await expect(resolved).toHaveAttribute("aria-label", /^Resolved thread/);
	// Folded with it: closed, still counted, still readable, no composer.
	await expect(panel(resolved)).toHaveAttribute("data-open", "false");
	await expect(agentButton(resolved)).toHaveAccessibleName(
		"2 agent messages, 1 new",
	);
	await agentButton(resolved).click();
	await expect(panel(resolved)).toHaveAttribute("data-open", "true");
	await expect(panel(resolved).getByTestId("agent-message-ai")).toHaveText(
		"Not fixed yet.",
	);
	await expect(
		resolved.getByRole("textbox", { name: "Ask agent" }),
	).toHaveCount(0);
	// Unresolving it (with the conversation open) brings the composer back.
	await resolved.getByRole("button", { name: "Unresolve" }).click();
	await expect.poll(() => storedResolved(p)).toBe(false);
	await expect(
		resolved.getByRole("textbox", { name: "Ask agent" }),
	).toBeVisible();
	// Resolved on GitHub by someone else while it is open: the next read
	// (Refresh) folds it too.
	p.editScenario((sc) => {
		const t = sc.prs[7]?.graphql?.reviewThreads?.[0] as
			| {
					isResolved: boolean;
					viewerCanResolve?: boolean;
					viewerCanUnresolve?: boolean;
			  }
			| undefined;
		if (!t) throw new Error("no thread in the scenario");
		// As GitHub has it after someone resolves: the viewer may unresolve.
		Object.assign(t, {
			isResolved: true,
			viewerCanResolve: false,
			viewerCanUnresolve: true,
		});
	});
	await page.getByRole("button", { name: "Refresh" }).first().click();
	await expect(bubble).toBeVisible();
	await expect(resolved).toHaveAttribute("aria-label", /^Resolved thread/);
	await expect(panel(resolved)).toHaveAttribute("data-open", "false");
	await expect(
		resolved.getByRole("textbox", { name: "Ask agent" }),
	).toHaveCount(0);
	// Unresolving brings back the conversation the resolve folded.
	await resolved.getByRole("button", { name: "Unresolve" }).click();
	await expect.poll(() => storedResolved(p)).toBe(false);
	await expect(panel(resolved)).toHaveAttribute("data-open", "true");
	await expect(
		resolved.getByRole("textbox", { name: "Ask agent" }),
	).toBeVisible();
});

test("Resolve By Agent Suggestion resolves the GitHub thread (the fake gh records the write) and hides", async ({
	page,
	pr,
	agentCrb,
}) => {
	const p = await setup(pr);
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [{ text: "Fixed here, in PS 1.\n[suggest-resolve]" }],
		},
	});
	await page.goto(s.url);
	const card = overviewCard(page);
	await openPanel(card);
	await sendToAgent(card, "Is this resolved?");
	const reply = panel(card).getByTestId("agent-message-ai");
	// The reply's text, then its own button.
	await expect(reply).toHaveText(
		/^Fixed here, in PS 1\.\s*Resolve By Agent Suggestion$/,
	);
	// The marker is data, never text.
	await expect(panel(card)).not.toContainText("[suggest-resolve]");
	// Part of the reply: inside its box.
	const suggest = panel(card)
		.getByTestId("agent-message-ai")
		.last()
		.getByRole("button", { name: "Resolve By Agent Suggestion" });
	await expect(suggest).toBeVisible();
	// The agent resolved nothing: GitHub still has it open, no write made.
	expect(storedResolved(p)).toBe(false);
	expect(resolveWrites(p)).toBe(0);
	// The composer's Resolve rings in ok while the suggestion stands.
	const resolve = card.getByRole("button", { name: "Resolve", exact: true });
	await expect(resolve).toHaveClass(/ring-ok/);
	await suggest.click();
	// A human's press: the same GitHub resolve as the card's.
	await expect.poll(() => storedResolved(p)).toBe(true);
	expect(resolveWrites(p)).toBe(1);
	await expect(suggest).toHaveCount(0);
	await expect(card.getByTestId("thread-head")).toContainText(
		"Resolved thread",
	);
});

test("an unread dot appears for an answer that lands while closed and clears after viewing", async ({
	page,
	pr,
	agentCrb,
	acpScenario,
}) => {
	await setup(pr);
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [{ text: "Answered while you looked away.", chunks: 2 }],
			hold: ["prompt"],
		},
	});
	const thread = await filesThread(page, s.url);
	await openPanel(thread);
	await sendToAgent(thread, "Take your time");
	await expect(panel(thread).getByTestId("agent-answering")).toBeVisible();
	// Closed while the agent answers.
	await agentButton(thread).click();
	await expectClosed(thread);
	await expect(thread.getByTestId("agent-unread-dot")).toHaveCount(0);
	releaseAcp(acpScenario, "prompt");
	await expect(thread.getByTestId("agent-unread-dot")).toBeVisible();
	await expect(agentButton(thread)).toHaveAccessibleName(
		"2 agent messages, 1 new",
	);
	// Opened: the "new" divider above the answer; seen once it was in view.
	const seen = page.waitForResponse(
		(r) => SEEN.test(new URL(r.url()).pathname) && r.ok(),
	);
	await agentButton(thread).click();
	await expect(panel(thread)).toHaveAttribute("data-open", "true");
	await expect(
		panel(thread).getByRole("separator", { name: "new" }),
	).toBeVisible();
	await seen;
	// The divider stays until it closes.
	await expect(
		panel(thread).getByRole("separator", { name: "new" }),
	).toBeVisible();
	await agentButton(thread).click();
	await expectClosed(thread);
	await expect(thread.getByTestId("agent-unread-dot")).toHaveCount(0);
	await expect(agentButton(thread)).toHaveAccessibleName("2 agent messages");
	// Seen in the agent ref: a reload (or the other device) agrees.
	await page.reload();
	const again = await filesThread(page, s.url);
	await expect(agentButton(again)).toHaveAccessibleName("2 agent messages");
	await expect(again.getByTestId("agent-unread-dot")).toHaveCount(0);
	await agentButton(again).click();
	await expect(
		panel(again).getByRole("separator", { name: "new" }),
	).toHaveCount(0);
});

test("no horizontal page scroll at 360px with the panel open", async ({
	page,
	pr,
	agentCrb,
}) => {
	await page.setViewportSize({ width: 360, height: 760 });
	await setup(pr);
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [
				{
					text: `A long line: ${"x".repeat(200)}\n\n\`\`\`ts\nexport const total = v1 + v2 + v3 + v4 + v5 + v6 + v7 + v8 + v9 + v10;\n\`\`\``,
				},
			],
		},
	});
	await holdSeen(page);
	await page.goto(s.url);
	const card = overviewCard(page);
	await openPanel(card);
	await sendToAgent(card, "Wide answer?");
	await expect(panel(card).getByTestId("agent-message-ai")).toContainText(
		"A long line",
	);
	await expectNoPageOverflow(page);
	// The agent handle and the header's comment counter: 40px tall at this width.
	for (const el of [agentButton(card), card.getByTestId("thread-counter")]) {
		expect((await el.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
	}
	const thread = await filesThread(page, s.url);
	await agentButton(thread).click();
	await expect(panel(thread)).toHaveAttribute("data-open", "true");
	await expect(panel(thread).getByTestId("agent-message-ai")).toContainText(
		"A long line",
	);
	await expectNoPageOverflow(page);
	const strip = thread.getByRole("button", { name: "Back to the thread" });
	expect((await strip.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(40);
});

/** A box's edges. */
type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
	a.x < b.x + b.width &&
	b.x < a.x + a.width &&
	a.y < b.y + b.height &&
	b.y < a.y + a.height;

/**
 * Waits for the card's agent panel to rest: open and slid in, or closed
 * and gone with the cover's height (which it keeps until the slide out
 * ends, then the card shrinks). Geometry read before that mixes layouts.
 * It waits on the state, not the page clock (installClock): this spec's
 * agent polls and held answers would stall under a fake clock.
 */
async function expectPanelAtRest(card: Locator) {
	const p = panel(card);
	if ((await p.count()) === 0) return;
	if ((await p.getAttribute("data-open")) === "true") {
		await expect(p).toHaveClass(/(^|\s)translate-x-0(\s|$)/);
		await expect
			.poll(() => p.evaluate((el) => el.getAnimations().length))
			.toBe(0);
	} else {
		await expect(p).toBeHidden();
	}
}

/**
 * The boxes of `card` and of what each selector finds in it (the first
 * visible match, null for none), read in one layout: one evaluate, so a
 * reflow between reads can't put two boxes in different frames.
 */
async function boxesIn<K extends string>(
	card: Locator,
	selectors: Record<K, string>,
): Promise<{ card: Box } & Record<K, Box | null>> {
	const boxes = await card.evaluate(
		(el, sel): Record<string, Box | null> => {
			const box = (n: Element): Box => {
				const r = n.getBoundingClientRect();
				return { x: r.x, y: r.y, width: r.width, height: r.height };
			};
			const out: Record<string, Box | null> = { card: box(el) };
			for (const [k, s] of Object.entries(sel)) {
				const n = [...el.querySelectorAll(s)].find((m) =>
					m.checkVisibility({ visibilityProperty: true }),
				);
				out[k] = n ? box(n) : null;
			}
			return out;
		},
		selectors as Record<string, string>,
	);
	return boxes as { card: Box } & Record<K, Box | null>;
}

/**
 * Asserts the agent opener is the card's bottom handle: at the right end of
 * the actions row beside Resolve (at the card's bottom when that row is
 * closed, beside the closed card's Resolve where it has one), a finger's
 * size, covering nothing, and the thread keeping its full width (no
 * gutter kept for it). Read once the panel rests, every box
 * in one layout.
 */
async function expectBottomHandle(card: Locator, page: Page) {
	const handle = agentButton(card);
	await expectPanelAtRest(card);
	await handle.scrollIntoViewIfNeeded();
	await expect(handle).toBeInViewport();
	const g = await card.evaluate((el) => {
		const box = (n: Element) => {
			const r = n.getBoundingClientRect();
			return { x: r.x, y: r.y, width: r.width, height: r.height };
		};
		const t = el.querySelector("[data-testid=thread-agent-button]");
		const cover = el.querySelector("[data-testid=agent-cover]");
		// Beside Resolve: the actions row's, or the closed card's Show more row's.
		const resolve = el.querySelector("[data-testid=resolve-button]");
		const others = [
			...el.querySelectorAll(
				"[data-testid=thread-comment-body], [data-testid=thread-counter], textarea, button:not([data-testid=thread-agent-button])",
			),
		]
			.filter((o) => o.checkVisibility({ visibilityProperty: true }))
			.map((o) => ({ box: box(o), html: o.outerHTML.slice(0, 80) }));
		return {
			c: box(el),
			t: t && box(t),
			cover: cover && box(cover),
			r: resolve?.checkVisibility({ visibilityProperty: true })
				? box(resolve)
				: null,
			others,
		};
	});
	const { c, t, r, cover } = g;
	if (!t) throw new Error("no handle");
	if (r) {
		// On Resolve's row, just right of it.
		expect(
			Math.abs(t.y + t.height / 2 - (r.y + r.height / 2)),
		).toBeLessThanOrEqual(4);
		expect(t.x).toBeGreaterThanOrEqual(r.x + r.width - 1);
		expect(t.x - (r.x + r.width)).toBeLessThanOrEqual(16);
	} else {
		// The actions row closed: at the card's bottom.
		expect(c.y + c.height - (t.y + t.height)).toBeLessThanOrEqual(20);
	}
	// At the right end of the card's content.
	expect(c.x + c.width - (t.x + t.width)).toBeLessThanOrEqual(16);
	// A finger's target: 40px each way on a phone.
	const phone = (page.viewportSize()?.width ?? 1000) < 640;
	expect(t.height).toBeGreaterThanOrEqual(40);
	if (phone) expect(t.width).toBeGreaterThanOrEqual(40);
	// No width kept for it: the comments reach the card's right as without an agent.
	if (!cover) throw new Error("no agent cover");
	expect(c.x + c.width - (cover.x + cover.width)).toBeLessThanOrEqual(16);
	// It covers no comment, reply box or other button.
	for (const o of g.others) {
		if (o.box.width === 0 && o.box.height === 0) continue;
		expect(overlaps(t, o.box), o.html).toBe(false);
	}
}

test("the agent opener is a handle at the card's bottom beside Resolve, the panel's handle while open", async ({
	page,
	pr,
	agentCrb,
	acpScenario,
}) => {
	await setup(pr);
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [{ text: "Answered while you looked away.", chunks: 2 }],
			hold: ["prompt"],
		},
	});
	await holdSeen(page);
	await page.goto(s.url);
	const card = overviewCard(page);
	// Ask agent: the dashed handle, at the card's bottom.
	await expect(agentButton(card)).toHaveAccessibleName("Ask agent");
	await expectBottomHandle(card, page);
	await openPanel(card);
	await sendToAgent(card, "Take your time");
	await expect(panel(card).getByTestId("agent-answering")).toBeVisible();
	// Open: beside Resolve, under the panel's right edge, pressed.
	await expectBottomHandle(card, page);
	const { handle: handleBox, panel: panelBox } = await boxesIn(card, {
		handle: "[data-testid=thread-agent-button]",
		panel: "[data-testid=thread-agent-panel]",
	});
	if (!handleBox || !panelBox) throw new Error("no boxes");
	expect(
		Math.abs(handleBox.x + handleBox.width - (panelBox.x + panelBox.width)),
	).toBeLessThanOrEqual(2);
	await agentButton(card).click();
	await expectClosed(card);
	releaseAcp(acpScenario, "prompt");
	// Closed with an unread answer: the count and the dot on the handle.
	await expect(card.getByTestId("agent-unread-dot")).toBeVisible();
	await expect(agentButton(card)).toHaveAccessibleName(
		"2 agent messages, 1 new",
	);
	await expect(agentButton(card)).toHaveText("2");
	await expectBottomHandle(card, page);
	// A fresh page: the card closed, its handle at the Show more row's end,
	// sunk as the toggle is, neither it nor its dot reaching into the content above.
	await page.reload();
	const fresh = overviewCard(page);
	await expect(fresh.getByTestId("agent-unread-dot")).toBeVisible();
	await expect(fresh.getByTestId("thread-actions")).toHaveCount(0);
	await expectBottomHandle(fresh, page);
	const moreRow = fresh.getByTestId("thread-more-row");
	await expect(moreRow.getByTestId("thread-agent-button")).toBeVisible();
	const { above, dot, h, toggle } = await boxesIn(fresh, {
		// What is right above the Show more row.
		above: ":has(+ [data-testid=thread-more-row])",
		dot: "[data-testid=agent-unread-dot]",
		h: "[data-testid=thread-agent-button]",
		toggle: "[data-testid=thread-more]",
	}).then((b) => ({ ...b, above: (b.above?.y ?? 0) + (b.above?.height ?? 0) }));
	if (!dot || !h || !toggle) throw new Error("no boxes");
	expect(h.y).toBeGreaterThanOrEqual(above);
	expect(dot.y).toBeGreaterThanOrEqual(above);
	expect(
		Math.abs(h.y + h.height - (toggle.y + toggle.height)),
	).toBeLessThanOrEqual(1);
	// In Files changed too.
	const thread = await filesThread(page, s.url);
	await expect(thread.getByTestId("agent-unread-dot")).toBeVisible();
	await expectBottomHandle(thread, page);
	await agentButton(thread).click();
	await expect(panel(thread)).toHaveAttribute("data-open", "true");
	await expectNoPageOverflow(page);
});

test("at 360px a long Show more toggle and a two-digit handle share their row without overlapping", async ({
	page,
	pr,
	agentCrb,
}) => {
	await page.setViewportSize({ width: 360, height: 780 });
	const p = await pr(fixture);
	const head = p.repo.shas.at(-1) ?? "";
	const at = (m: number) => `2026-01-02T09:0${m}:00Z`;
	p.editScenario((s) => {
		const graph = s.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: CALC, line: 3, subjectType: "LINE" }, [
				threadComment({
					login: "rev1",
					text: QUESTION,
					createdAt: at(0),
					commit: head,
				}),
				threadComment({ login: "rev2", text: "Agreed.", createdAt: at(1) }),
				threadComment({ login: "rev1", text: "Fixing.", createdAt: at(2) }),
				threadComment({ login: "rev2", text: "Thanks.", createdAt: at(3) }),
				threadComment({ login: "Octo_Cat", text: "My draft", pending: true }),
			]),
		];
	});
	const s = await agentCrb({ scenario: { agent: AGENT, answers: [] } });
	// Twelve agent messages on the thread, the last one unseen.
	const messages = Array.from({ length: 12 }, (_, i) => ({
		id: `m${i + 1}`,
		by: i % 2 ? "ai" : "human",
		at: `2026-01-03T10:${String(i).padStart(2, "0")}:00Z`,
		text: `Message ${i + 1}`,
	}));
	await page.route(/\/agent\/threads$/, (route) =>
		route.request().method() === "GET"
			? route.fulfill({
					json: {
						threads: [
							{
								id: "A1",
								anchor: {
									subject: "thread",
									// The fake gh's id for PR 7's first thread.
									thread: "T7-0",
									path: CALC,
									commit: head,
									side: "RIGHT",
									line: 3,
									startSide: "RIGHT",
									startLine: 3,
								},
								openedBy: "human",
								at: messages[0]?.at,
								messages,
								resolved: false,
								waiting: false,
								unread: true,
								seenUpTo: "m10",
							},
						],
					},
				})
			: route.fallback(),
	);
	await page.goto(s.url);
	const card = overviewCard(page);
	const toggle = card.getByTestId("thread-more");
	await expect(toggle).toHaveAccessibleName(/^Show more, 4 replies, 1 pending/);
	const handle = agentButton(card);
	await expect(handle).toHaveText("12");
	await expectBottomHandle(card, page);
	const { toggle: t, handle: h } = await boxesIn(card, {
		toggle: "[data-testid=thread-more]",
		handle: "[data-testid=thread-agent-button]",
	});
	if (!t || !h) throw new Error("no boxes");
	// Side by side on the row's bottom, the toggle clear of the handle.
	expect(t.x + t.width).toBeLessThanOrEqual(h.x);
	expect(Math.abs(t.y + t.height - (h.y + h.height))).toBeLessThanOrEqual(1);
	expect(h.width).toBeGreaterThanOrEqual(40);
	await expectNoPageOverflow(page);
});

/** `n` paragraphs, then `end`: an answer taller than the panel. */
const tall = (end: string, n = 30) =>
	[...Array.from({ length: n }, (_, i) => `Paragraph ${i + 1}.`), end].join(
		"\n\n",
	);

test("scrolled up, an answer streaming in keeps what you read in place; at the end, the newest stays in sight (CAR-316)", async ({
	page,
	pr,
	agentCrb,
	acpScenario,
}) => {
	// Four agent turns, three of them held: past 30 s on a loaded machine.
	test.slow();
	await setup(pr);
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [
				{ match: "second", text: tall("End two."), chunks: 4 },
				{ match: "fourth", text: tall("End four."), chunks: 4 },
				{ match: "third", text: tall("End three.") },
				{ text: tall("End one.") },
			],
			hold: ["prompt"],
		},
	});
	await holdSeen(page);
	await page.goto(s.url);
	const card = overviewCard(page);
	await openPanel(card);
	const scroller = panel(card).getByTestId("thread-agent-scroll");
	const answers = panel(card).getByTestId("agent-message-ai");
	const answering = panel(card).getByTestId("agent-answering");
	await sendToAgent(card, "A first question");
	await expect(answering).toBeVisible();
	releaseAcp(acpScenario, "prompt");
	await expect(answers.first()).toContainText("End one.");
	await expect(answering).toHaveCount(0);

	// At the end: the answer streams in, the box keeps to its newest line.
	await scroller.evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	holdAcp(acpScenario, "prompt");
	await sendToAgent(card, "A second question");
	await expect(answering).toBeVisible();
	releaseAcp(acpScenario, "prompt");
	await expect(answers.nth(1)).toContainText("End two.");
	await expect(answering).toHaveCount(0);
	const endTwo = answers.nth(1).getByText("End two.", { exact: true });
	await expect.poll(() => inBox(endTwo, scroller)).toBe(true);

	// Scrolled up, a question sent: it and its answer land below what is in
	// sight, which stays put.
	const p5 = answers.nth(1).getByText("Paragraph 5.", { exact: true });
	await scrollTopTo(p5, scroller, 40);
	await expect.poll(() => inBox(p5, scroller)).toBe(true);
	const sent = await topIn(p5, scroller);
	await sendToAgent(card, "A third question");
	await expect(answers.nth(2)).toContainText("End three.");
	await expect(answering).toHaveCount(0);
	expect(Math.abs((await topIn(p5, scroller)) - sent)).toBeLessThanOrEqual(2);

	// Scrolled up while it streams: the paragraph in sight stays put as the
	// rest of the answer lands and the turn ends.
	holdAcp(acpScenario, "prompt");
	await sendToAgent(card, "A fourth question");
	await expect(answering).toBeVisible();
	const paragraph = answers.nth(1).getByText("Paragraph 10.", { exact: true });
	await scrollTopTo(paragraph, scroller, 40);
	await expect.poll(() => inBox(paragraph, scroller)).toBe(true);
	const before = await topIn(paragraph, scroller);
	releaseAcp(acpScenario, "prompt");
	await expect(answers.nth(3)).toContainText("End four.");
	await expect(answering).toHaveCount(0);
	const after = await topIn(paragraph, scroller);
	expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
	await expectNoPageOverflow(page);
});

test("a suggested comment mid-view stays put through Write, typing and Preview (CAR-316)", async ({
	page,
	pr,
	agentCrb,
}) => {
	await setup(pr);
	const comment = Array.from(
		{ length: 3 },
		(_, i) => `Suggested line ${i + 1}.`,
	).join("\n");
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [
				{
					text: `${tall("Before.", 20)}\n\n\`\`\`comment\n${comment}\n\`\`\`\n\n${tall("After.", 20)}`,
				},
			],
		},
	});
	await holdSeen(page);
	await page.goto(s.url);
	const card = overviewCard(page);
	await openPanel(card);
	await sendToAgent(card, "What should I ask?");
	const box = panel(card).getByTestId("agent-comment");
	const preview = box.getByTestId("comment-preview");
	await expect(preview).toContainText("Suggested line 3.");
	await expect(panel(card).getByText("After.", { exact: true })).toBeAttached();
	const scroller = panel(card).getByTestId("thread-agent-scroll");
	await scrollTopTo(box, scroller, 10);
	const top = await topIn(box, scroller);
	expect(Math.abs(top - 10)).toBeLessThanOrEqual(2);
	const stays = async () =>
		expect(Math.abs((await topIn(box, scroller)) - top)).toBeLessThanOrEqual(2);
	await box.getByRole("button", { name: "Write" }).click();
	const text = box.getByRole("textbox", { name: "Review comment" });
	await expect(text).toBeVisible();
	await stays();
	await text.click();
	await page.keyboard.press("ControlOrMeta+End");
	for (let i = 0; i < 4; i++) {
		await page.keyboard.press("Enter");
		await page.keyboard.type(`More ${i + 1}`);
		await stays();
	}
	await expect(text).toHaveValue(/More 4$/);
	await box.getByRole("button", { name: "Preview" }).click();
	await expect(preview).toContainText("More 4");
	await stays();
	await box.getByRole("button", { name: "Write" }).click();
	await expect(text).toBeVisible();
	await stays();
	// Its top scrolled out, the line typed on in sight: it grows upward,
	// what is below it stays put.
	await scrollTopTo(text, scroller, -30);
	const bottom = () =>
		topIn(text, scroller).then(
			async (top) =>
				top + (await text.evaluate((e) => e.getBoundingClientRect().height)),
		);
	await text.click({ position: { x: 20, y: 50 } });
	await page.keyboard.press("ControlOrMeta+End");
	const was = await bottom();
	for (let i = 0; i < 3; i++) {
		await page.keyboard.press("Enter");
		await page.keyboard.type(`Again ${i + 1}`);
		expect(Math.abs((await bottom()) - was)).toBeLessThanOrEqual(2);
	}
	await expect(text).toHaveValue(/Again 3$/);
});

test("scrolled up, the resolve suggestion going from an earlier answer keeps what you read in place (CAR-316)", async ({
	page,
	pr,
	agentCrb,
	acpScenario,
}) => {
	await setup(pr);
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [
				{ match: "follow-up", text: "Not yet." },
				{ text: `${tall("Fixed here.")}\n[suggest-resolve]` },
			],
			hold: ["prompt"],
		},
	});
	await holdSeen(page);
	await page.goto(s.url);
	const card = overviewCard(page);
	await openPanel(card);
	await sendToAgent(card, "Is this resolved?");
	releaseAcp(acpScenario, "prompt");
	const suggest = panel(card).getByRole("button", {
		name: "Resolve By Agent Suggestion",
	});
	await expect(suggest).toBeVisible();
	// The follow-up held after its first chunk: the suggestion still stands
	// under the first answer, above the follow-up's question.
	holdAcp(acpScenario, "prompt");
	// A long question: mid-view, with more below it than the box shows.
	const lines = Array.from({ length: 8 }, (_, i) => `Line ${i + 1}.`);
	await sendToAgent(card, ["A follow-up question", ...lines].join("\n"));
	const answering = panel(card).getByTestId("agent-answering");
	await expect(answering).toBeVisible();
	await expect(suggest).toBeVisible();
	const scroller = panel(card).getByTestId("thread-agent-scroll");
	const question = panel(card)
		.getByTestId("agent-message-human")
		.filter({ hasText: "A follow-up question" });
	await scrollTopTo(question, scroller, 40);
	const before = await topIn(question, scroller);
	expect(Math.abs(before - 40)).toBeLessThanOrEqual(2);
	// Not at the end: the pin isn't what keeps it.
	expect(
		await scroller.evaluate(
			(el) => el.scrollHeight - el.clientHeight - el.scrollTop,
		),
	).toBeGreaterThan(20);
	// Stored, the answer retracts the suggestion above what is in sight.
	releaseAcp(acpScenario, "prompt");
	await expect(answering).toHaveCount(0);
	await expect(suggest).toHaveCount(0);
	const after = await topIn(question, scroller);
	expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
});
