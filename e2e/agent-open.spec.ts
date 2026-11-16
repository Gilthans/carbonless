import type { Locator, Page } from "@playwright/test";
import { acpLog } from "../test/fake-acp/scenario";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import { ask, CALC, expect, fixture, openFile, test } from "./agent-ui";
import { expectNoPageOverflow } from "./files-ui";
import { installClock, type Pr, type PrOptions } from "./fixtures";

// Its own crb serve: the agent's config, its fake ACP env and checkouts.
test.use({ crbServer: "own" });

/**
 * The agent opens conversations (CAR-80): while answering a request, the
 * spawned fake agent calls `open` on lines and on a GitHub thread, then
 * replies citing them. Desktop and phone. One GitHub thread by rev1 on
 * src/calc.ts's line 3.
 */

const AGENT = { name: "Fake Agent", version: "9.9.9" };
const REQUEST = "Where else is a constant added?";
const THREAD_Q = "Is total right?";

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
					text: THREAD_Q,
					createdAt: "2026-01-02T09:00:00Z",
					commit: head,
				}),
			]),
		];
	});
	return p;
}

/** The answer to REQUEST: open on lines 5–6 and on the GitHub thread, then cite both. */
const OPENING = {
	match: "Where else",
	text: "Two more: {{cite:0}} and {{cite:1}}.",
	open: [
		{
			code: { path: CALC, startLine: 5, line: 6 },
			text: "This is such a case: v5 and v6.",
			key: "lines",
		},
		{ ghThread: 0, text: "This thread is one too.", key: "thread" },
	],
};

/** Holds every seen mark: what is new stays new while the test looks at it. */
async function holdSeen(page: Page) {
	await page.route(/\/agent\/threads\/[^/]+\/seen$/, () => {});
}

const overviewCard = (page: Page) =>
	page
		.getByRole("region", { name: "Human reviews" })
		.getByTestId("thread")
		.filter({ hasText: THREAD_Q });

/** Each control of the Re row is at least 40px both ways. */
async function expectTargets(re: Locator) {
	for (const id of ["agent-re-more", "agent-re-go", "agent-re-list"]) {
		const box = await re.getByTestId(id).boundingBox();
		expect(box?.width, id).toBeGreaterThanOrEqual(40);
		expect(box?.height, id).toBeGreaterThanOrEqual(40);
	}
}

test("the agent opens on lines and on a thread while answering; the citations, the Re row, Go to your request and the lists lead between them", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	// Two or three agent turns and as many page moves: past 30 s on a
	// loaded machine (agent.spec.ts does the same).
	test.slow();
	await setup(pr);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [OPENING, { text: "ok" }] },
	});
	await holdSeen(page);
	// The landed outline fades on a timer: the clock pauses while it is checked.
	await installClock(page);
	const section = await openFile(page, s.url, CALC);
	const request = await ask(page, section, 3, REQUEST);
	await expect(request).toHaveAttribute("aria-label", "Agent thread, answered");
	const links = request.getByTestId("agent-conversation-link");
	await expect(links).toHaveText(["src/calc.ts:5–6", /^Thread · /]);
	// The request: Started 2, both unread.
	const started = request.getByTestId("agent-started");
	const requestCard = request.filter({
		has: page.getByTestId("agent-started"),
	});
	await expect(started).toHaveAccessibleName("Started 2, 2 unread");

	// The citation on lines: Files changed, its card open, Re row on top.
	await links.first().click();
	const opened = page
		.getByTestId("agent-thread")
		.filter({ hasText: "This is such a case" });
	await expect(opened).toBeVisible();
	await expect(opened.getByTestId("agent-opened-this")).toBeVisible();
	const re = opened.getByTestId("agent-re");
	await expect(re.getByTestId("agent-re-text")).toHaveText(`“${REQUEST}”`);
	const more = re.getByTestId("agent-re-more");
	await more.click();
	await expect(more).toHaveAttribute("aria-expanded", "true");
	if (isMobile) {
		await expectNoPageOverflow(page);
		await expectTargets(re);
	}
	// The list: both conversations, this one marked.
	await re.getByTestId("agent-re-list").click();
	const rows = re.getByTestId("agent-started-item");
	await expect(rows).toHaveCount(2);
	await expect(rows.first()).toHaveAttribute("aria-current", "true");
	await expect(rows.nth(1)).toContainText("This thread is one too.");

	// Go to your request: its card, the message outlined (the clock held,
	// so the outline's fade can't end before it is seen).
	await page.clock.pauseAt(Date.now() + 1000);
	await re.getByTestId("agent-re-go").click();
	const landedMessage = requestCard
		.locator('[data-landed="true"]')
		.getByTestId("agent-message-human");
	await expect(landedMessage).toHaveText(REQUEST);
	// The card's frames run (the clock holds them while paused), well
	// within the outline: the message stays in view, centred, not the
	// card's top scrolled under the bars.
	await page.clock.runFor(200);
	await expect(landedMessage).toHaveText(REQUEST);
	await expect(landedMessage).toBeInViewport();
	await page.clock.resume();

	// From the request's list, the GitHub thread: the Overview, its panel open.
	// (The opened card quotes the request too: the request's card is the
	// one with Started.)
	await started.click();
	await requestCard
		.getByTestId("agent-started-list")
		.getByTestId("agent-started-item")
		.filter({ hasText: "This thread is one too." })
		.click();
	const card = overviewCard(page);
	const panel = card.getByTestId("thread-agent-panel");
	await expect(panel).toHaveAttribute("data-open", "true");
	await expect(panel.getByTestId("agent-re-text")).toHaveText(`“${REQUEST}”`);
	await expect(panel.getByTestId("agent-message-ai")).toHaveText(
		"This thread is one too.",
	);
	if (isMobile) await expectNoPageOverflow(page);
});

test("a thread that already has a conversation: the agent's message goes at its end, with its own Re row", async ({
	page,
	pr,
	agentCrb,
}) => {
	// Two or three agent turns and as many page moves: past 30 s on a
	// loaded machine (agent.spec.ts does the same).
	test.slow();
	await setup(pr);
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [
				{ match: "fixed", text: "Yes, fixed." },
				{
					match: "Where else",
					text: "Here: {{cite:0}}.",
					open: [{ ghThread: 0, text: "Same case here." }],
				},
				{ text: "ok" },
			],
		},
	});
	await page.goto(s.url);
	const card = overviewCard(page);
	await card.getByTestId("thread-agent-button").click();
	const panel = card.getByTestId("thread-agent-panel");
	await expect(panel).toHaveAttribute("data-open", "true");
	const box = card.getByRole("textbox", { name: "Ask agent" });
	await box.fill("Is it fixed?");
	await card.getByRole("button", { name: "Send to agent" }).click();
	await expect(panel.getByTestId("agent-message-ai")).toHaveText([
		"Yes, fixed.",
	]);
	const section = await openFile(page, s.url, CALC);
	const request = await ask(page, section, 5, REQUEST);
	await expect(request.getByTestId("agent-conversation-link")).toHaveText([
		/^Thread · /,
	]);
	await request.getByTestId("agent-conversation-link").click();
	await expect(panel).toHaveAttribute("data-open", "true");
	await expect(panel.getByTestId("agent-message-ai")).toHaveText([
		"Yes, fixed.",
		"Same case here.",
	]);
	// One Re row, on the agent's message from the request only.
	await expect(panel.getByTestId("agent-re")).toHaveCount(1);
	await expect(panel.getByTestId("agent-message-human")).toHaveText([
		"Is it fixed?",
	]);
});

test("a whole-file conversation: its citation opens the file's header threads, its card and its Re row", async ({
	page,
	pr,
	agentCrb,
}) => {
	// Two agent turns' worth of setup and a page move: past 30 s on a
	// loaded machine (agent.spec.ts does the same).
	test.slow();
	await setup(pr);
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [
				{
					match: "Where else",
					text: "The whole file: {{cite:0}}.",
					open: [{ code: { path: CALC }, text: "Every line here is one." }],
				},
				{ text: "ok" },
			],
		},
	});
	const section = await openFile(page, s.url, CALC);
	const request = await ask(page, section, 3, REQUEST);
	const link = request.getByTestId("agent-conversation-link");
	await expect(link).toHaveText(CALC);
	await link.click();
	const opened = section
		.getByTestId("agent-thread")
		.filter({ hasText: "Every line here is one." });
	await expect(opened).toBeVisible();
	await expect(opened.getByTestId("agent-re-text")).toHaveText(`“${REQUEST}”`);
});

test("a reply in a conversation the agent opened is a question it gets, with the request it came from", async ({
	page,
	pr,
	agentCrb,
	acpLogPath,
}) => {
	// Two or three agent turns and as many page moves: past 30 s on a
	// loaded machine (agent.spec.ts does the same).
	test.slow();
	await setup(pr);
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [
				OPENING,
				{ match: "Why these", text: "Both add constants." },
				{ text: "ok" },
			],
		},
	});
	const section = await openFile(page, s.url, CALC);
	const request = await ask(page, section, 3, REQUEST);
	await request.getByTestId("agent-conversation-link").first().click();
	const opened = page
		.getByTestId("agent-thread")
		.filter({ hasText: "This is such a case" });
	await expect(opened).toHaveAttribute("aria-label", "Agent thread, answered");
	await opened
		.getByRole("textbox", { name: "Reply to your agent" })
		.fill("Why these two?");
	await opened.getByTestId("agent-reply-ask").click();
	await expect(opened.getByTestId("agent-message-ai")).toHaveText([
		"This is such a case: v5 and v6.",
		"Both add constants.",
	]);
	// next handed the reply out with the request's text on the opening message.
	const handed = acpLog(acpLogPath)
		.filter((e) => e.method === "mcp/next")
		.map(
			(e) =>
				(
					e.response as {
						value: { envelope?: { messages: { text: string; re?: string }[] } };
					}
				).value.envelope?.messages,
		)
		.find((m) => m?.at(-1)?.text === "Why these two?");
	expect(handed?.[0]).toMatchObject({
		text: "This is such a case: v5 and v6.",
		re: REQUEST,
	});
});
