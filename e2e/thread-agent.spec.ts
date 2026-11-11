import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { releaseAcp } from "../test/fake-acp/scenario";
import {
	reviewThread,
	type Scenario,
	threadComment,
} from "../test/fake-gh/scenario";
import { CALC, expect, fixture, openFile, row, test } from "./agent-ui";
import { expectNoPageOverflow } from "./files-ui";
import type { Pr, PrOptions } from "./fixtures";

/**
 * The thread agent (CAR-120): a private agent conversation per GitHub
 * thread, behind the agent button in the thread card's header, sliding
 * over the thread's comments. Against the fake ACP agent and the fake gh,
 * on the Overview and in Files changed, desktop and phone. One GitHub
 * thread by rev1 on src/calc.ts's line 3, open, no reply.
 */

const QUESTION = "Is total right?";
const AGENT = { name: "Fake Agent", version: "9.9.9" };

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

/** Whether the fake gh has the thread resolved (its writes are kept in the scenario). */
function storedResolved(p: Pr): boolean | undefined {
	const s = JSON.parse(readFileSync(p.scenarioPath, "utf8")) as Scenario;
	const threads = (s.prs[7]?.graphql?.reviewThreads ?? []) as {
		isResolved: boolean;
	}[];
	return threads[0]?.isResolved;
}

/** The fake gh's resolve mutations so far. */
const resolveWrites = (p: Pr) =>
	(p.ghLog().match(/\bresolveReviewThread\(/g) ?? []).length;

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

test("the same from Files changed", async ({ page, pr, agentCrb }) => {
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
	const box = await scroller.boundingBox();
	const end = await panel(thread).getByText("The end.").boundingBox();
	const first = await panel(thread)
		.getByTestId("agent-message-human")
		.boundingBox();
	if (!box || !end || !first) throw new Error("no boxes");
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
	await expect(reply).toHaveText("Fixed here, in PS 1.");
	// The marker is data, never text.
	await expect(panel(card)).not.toContainText("[suggest-resolve]");
	const suggest = panel(card).getByRole("button", {
		name: "Resolve By Agent Suggestion",
	});
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
	// The header's agent button and comment counter: 40px tall at this width.
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
