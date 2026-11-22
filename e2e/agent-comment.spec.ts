import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import {
	reviewThread,
	type Scenario,
	threadComment,
} from "../test/fake-gh/scenario";
import { ask, CALC, expect, fixture, openFile, row, test } from "./agent-ui";
import { expectNoPageOverflow, fileSection, marksReady } from "./files-ui";
import type { Pr } from "./fixtures";
import { reviewPage } from "./fixtures";

// Its own crb serve: the agent's config, its fake ACP env and checkouts.
test.use({ crbServer: "own" });

/**
 * The agent suggests a review comment (CAR-83): its answer holds a
 * ```comment block, which shows as an editable box; Add review comment
 * posts the box's text to the fake gh where the conversation sits, once.
 * Desktop and phone, against the fake ACP agent.
 */

const AGENT = { name: "Fake Agent", version: "9.9.9" };
const SUGGESTED = "Why does this add only v1 and v2?";
const ANSWER = `Worth asking the author:\n\n\`\`\`comment\n${SUGGESTED}\n\`\`\``;

/** The fake gh's review threads (its writes are kept in the scenario). */
function storedThreads(p: Pr) {
	const s = JSON.parse(readFileSync(p.scenarioPath, "utf8")) as Scenario;
	return (
		(s.prs[p.number]?.graphql?.reviewThreads ?? []) as {
			path: string;
			line: number;
			comments: { nodes: { body: string }[] };
		}[]
	).map((t) => ({
		path: t.path,
		line: t.line,
		bodies: t.comments.nodes.map((c) => c.body),
	}));
}

/** The fake gh's REST posts of new threads and of replies. */
const newThreadPosts = (p: Pr) =>
	p
		.ghLog()
		.split("\n")
		.filter((l) => /^api -X POST \S+\/pulls\/\d+\/comments /.test(l));
const replyPosts = (p: Pr) =>
	p
		.ghLog()
		.split("\n")
		.filter((l) =>
			/^api -X POST \S+\/pulls\/\d+\/comments\/\d+\/replies /.test(l),
		);

const box = (scope: Locator) => scope.getByTestId("agent-comment");
const addButton = (scope: Locator) =>
	box(scope).getByRole("button", { name: "Add review comment" });

/** The box in Write (it opens in Preview, CAR-202). */
async function write(scope: Locator) {
	await box(scope).getByRole("button", { name: "Write" }).click();
	return box(scope).getByRole("textbox", { name: "Review comment" });
}

/** Asks about calc's line 3 and waits for the answer's box, in Write. */
async function askLine3(page: Page, url: string) {
	const section = await openFile(page, url, CALC);
	const card = await ask(page, section, 3, "Anything to ask the author?");
	const first = box(card).first();
	await expect(first.getByTestId("comment-preview")).toHaveText(SUGGESTED);
	await first.getByRole("button", { name: "Write" }).click();
	await expect(
		first.getByRole("textbox", { name: "Review comment" }),
	).toHaveValue(SUGGESTED);
	return { section, card };
}

/**
 * Line 3's GitHub thread in Files changed, opened from its comment bubble,
 * and its agent panel (where a conversation that posted a block lives,
 * CAR-236), opened.
 */
async function joinedPanel(page: Page, url: string) {
	const section = await openFile(page, url, CALC);
	await row(section, 3)
		.getByRole("button", { name: /^\d+ comments? on line 3/ })
		.click();
	const thread = section.getByTestId("files-thread");
	await expect(thread).toBeVisible();
	// Its agent button names the conversation's messages, never "Ask agent".
	await expect(thread.getByTestId("thread-agent-button")).toHaveAccessibleName(
		/^\d+ agent messages/,
	);
	await thread.getByTestId("thread-agent-button").click();
	const panel = thread.getByTestId("thread-agent-panel");
	await expect(panel).toHaveAttribute("data-open", "true");
	// No agent card or bubble of its own on the line.
	await expect(section.getByTestId("agent-thread")).toHaveCount(0);
	await expect(row(section, 3).getByTestId("agent-bubble")).toHaveCount(0);
	return { section, thread, panel };
}

/** The agent card on calc's line 3, opened from its bubble after a reload. */
async function reopenLine3(page: Page, url: string) {
	const section = await openFile(page, url, CALC);
	await row(section, 3).getByTestId("agent-bubble").click();
	const card = section
		.getByTestId("agent-thread")
		.filter({ hasText: "Anything to ask the author?" });
	await expect(card).toBeVisible();
	return card;
}

test("a line conversation: edit the suggestion, post it as a new thread on those lines; Posted survives a reload", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	const p = await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: ANSWER }] },
	});
	const { section, card } = await askLine3(page, s.url);
	await expect(box(card).getByTestId("agent-comment-target")).toHaveText("L3");
	const text = box(card).getByRole("textbox", { name: "Review comment" });
	// An edit; `<String>` is a tag GitHub would drop: it goes escaped.
	await text.fill(`${SUGGESTED} A List<String> would do.`);
	await expect(
		box(card).getByRole("button", { name: "Back to the agent's text" }),
	).toBeVisible();
	expect(
		(await addButton(card).boundingBox())?.height ?? 0,
	).toBeGreaterThanOrEqual(40);
	if (isMobile) await expectNoPageOverflow(page);
	await addButton(card).click();
	// Posted, the conversation is the new thread's (CAR-236): its panel opens.
	const joined = section
		.getByTestId("files-thread")
		.getByTestId("thread-agent-panel");
	await expect(joined).toHaveAttribute("data-open", "true");
	await expect(box(joined)).toContainText("Posted");
	await expect(
		box(joined).getByRole("link", { name: "Open on GitHub" }),
	).toHaveAttribute("href", /#discussion_r\d+$/);
	await expect(box(joined)).toContainText("A List<String> would do.");
	// The fake gh got one new thread on line 3, with the edited text, escaped.
	expect(newThreadPosts(p)).toHaveLength(1);
	const [t] = storedThreads(p);
	expect(t).toMatchObject({ path: CALC, line: 3 });
	expect(t?.bodies[0]).toContain(`${SUGGESTED} A List\\<String> would do.`);
	expect(t?.bodies[0]).toMatch(
		/<!-- crb:v1 id=ag\.[0-9a-z]{26}\.[0-9a-z]{26}\.0 -->$/,
	);
	// It shows in the diff like any thread: line 3's comment bubble.
	await expect(
		row(section, 3).getByRole("button", { name: /^1 comment on line 3/ }),
	).toBeVisible();
	if (isMobile) await expectNoPageOverflow(page);
	await page.reload();
	// The conversation is that thread's now (CAR-236).
	const { panel } = await joinedPanel(page, s.url);
	await expect(box(panel)).toContainText("Posted");
	await expect(box(panel).getByRole("textbox")).toHaveCount(0);
	expect(newThreadPosts(p)).toHaveLength(1);
});

test("the record of a post lost: Posted holds across a reload and the record is written then; another device's press finds the comment, never posts twice", async ({
	page,
	pr,
	agentCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/500|Failed to load/);
	const p = await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: ANSWER }] },
	});
	const { card } = await askLine3(page, s.url);
	// The agent ref's record fails: kept in the browser, Posted.
	const RECORD = "**/api/r/*/agent/threads/*/posted";
	await page.route(RECORD, (route) =>
		route.fulfill({ status: 500, body: '{"error":"down"}' }),
	);
	await addButton(card).click();
	await expect(box(card)).toContainText("Posted");
	await page.unroute(RECORD);
	// Reloaded: still Posted (the browser's copy, the record held a moment
	// so it shows on its line first), and the record is written.
	let release = () => {};
	const held = new Promise<void>((r) => {
		release = r;
	});
	await page.route(RECORD, async (route) => {
		await held;
		await route.continue();
	});
	const recorded = page.waitForResponse(
		(r) => /\/agent\/threads\/[^/]+\/posted$/.test(r.url()) && r.ok(),
	);
	await page.reload();
	const again = await reopenLine3(page, s.url);
	await expect(box(again)).toContainText("Posted");
	release();
	await recorded;
	await page.unroute(RECORD);
	expect(newThreadPosts(p)).toHaveLength(1);
	// Recorded: the conversation is its thread's now (CAR-236).
	await expect(again).toHaveCount(0);
	// Another device: nothing kept there, Posted from the record alone.
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await expect(box((await joinedPanel(page, s.url)).panel)).toContainText(
		"Posted",
	);
	expect(newThreadPosts(p)).toHaveLength(1);
	expect(storedThreads(p)).toHaveLength(1);
});

test("a GitHub-thread conversation: the box replies to that thread", async ({
	page,
	pr,
	agentCrb,
}) => {
	const p = await pr(fixture);
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((sc) => {
		const graph = sc.prs[p.number]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: CALC, line: 3, subjectType: "LINE" }, [
				threadComment({
					login: "rev1",
					text: "Is total right?",
					createdAt: "2026-01-02T09:00:00Z",
					commit: head,
				}),
			]),
		];
	});
	const reply = "Thanks: could you note why only v1 and v2?";
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [{ text: `A reply:\n\n\`\`\`comment\n${reply}\n\`\`\`` }],
		},
	});
	await page.goto(s.url);
	const card = page
		.getByRole("region", { name: "Human reviews" })
		.getByTestId("thread")
		.filter({ hasText: "Is total right?" });
	await card.getByTestId("thread-agent-button").click();
	const panel = card.getByTestId("thread-agent-panel");
	await expect(panel).toHaveAttribute("data-open", "true");
	await card.getByRole("textbox", { name: "Ask agent" }).fill("Reply for me?");
	await card.getByRole("button", { name: "Send to agent" }).click();
	await expect(box(panel).getByTestId("agent-comment-target")).toHaveText(
		"Reply",
	);
	await addButton(panel).click();
	await expect(box(panel)).toContainText("Posted");
	expect(replyPosts(p)).toHaveLength(1);
	expect(newThreadPosts(p)).toHaveLength(0);
	const [t] = storedThreads(p);
	expect(t?.bodies).toHaveLength(2);
	expect(t?.bodies[1]).toBe(reply);
});

test("a refusal keeps the text and says why; the button works again", async ({
	page,
	pr,
	agentCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/409/);
	const p = await pr({
		...fixture,
		reviews: [
			{
				author: { login: "Octo_Cat", __typename: "User" },
				state: "PENDING",
				submittedAt: null,
				createdAt: "2026-01-03T00:00:00Z",
			},
		],
	});
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: ANSWER }] },
	});
	const { card } = await askLine3(page, s.url);
	const text = box(card).getByRole("textbox", { name: "Review comment" });
	await text.fill("Edited, then refused");
	await addButton(card).click();
	await expect(box(card).getByRole("alert")).toHaveText(
		"A pending review on GitHub blocks comments",
	);
	await expect(text).toHaveValue("Edited, then refused");
	await expect(addButton(card)).toBeEnabled();
	await expect(addButton(card)).not.toHaveAttribute("aria-disabled", "true");
	expect(storedThreads(p)).toEqual([]);
});

test("lines gone in a new push: the button is off and says why; the box stays", async ({
	page,
	pr,
	agentCrb,
}) => {
	test.slow();
	const OTHER = "src/other.ts";
	const five = Array.from({ length: 5 }, (_, i) => `other ${i + 1}`);
	const p = await pr({
		base: { ...fixture.base, [OTHER]: `${five.join("\n")}\n` },
		files: [
			{
				message: "calc and other",
				files: {
					...fixture.files?.[0]?.files,
					[OTHER]: `${five.map((l, i) => (i === 1 ? "other 2 changed" : l)).join("\n")}\n`,
				},
			},
		],
	});
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: ANSWER }] },
	});
	await askLine3(page, s.url);
	// calc.ts back to the base: the PR no longer changes it.
	p.moveHead({
		message: "revert calc",
		files: { [CALC]: fixture.base?.[CALC] ?? "" },
	});
	const refreshed = page.waitForResponse(
		(r) => r.url().endsWith("/refresh") && r.ok(),
	);
	await page.getByRole("button", { name: "Refresh" }).click();
	await refreshed;
	await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
	await openFile(page, s.url, OTHER);
	const card = page
		.getByTestId("agent-not-in-comparison")
		.getByTestId("agent-outside")
		.filter({ hasText: "Anything to ask the author?" });
	await expect(card).toBeVisible();
	await expect(addButton(card)).toHaveAttribute("aria-disabled", "true");
	await expect(addButton(card)).toHaveAccessibleDescription(
		"These lines are gone in the latest push",
	);
	const text = await write(card);
	await expect(text).toHaveValue(SUGGESTED);
	await expect(text).toBeEditable();
	// A press on the off button sends nothing: past a reload (a post it
	// started would be out by then), crb and the fake gh got none.
	let posts = 0;
	page.on("request", (r) => {
		if (r.method() === "POST" && /\/api\/r\/[^/]+\/threads$/.test(r.url())) {
			posts++;
		}
	});
	await addButton(card).click({ force: true });
	await page.reload();
	await expect(
		page
			.getByTestId("agent-not-in-comparison")
			.getByTestId("agent-outside")
			.filter({ hasText: "Anything to ask the author?" }),
	).toBeVisible();
	expect(posts).toBe(0);
	expect(newThreadPosts(p)).toHaveLength(0);
});

test("Write / Preview: the box opens on the agent's markdown rendered; an edit shows in Preview, and Add posts it", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	const p = await pr(fixture);
	const md = "Why **only** v1 and v2?\n\n- `v3` missing";
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [{ text: `Ask:\n\n\`\`\`comment\n${md}\n\`\`\`` }],
		},
	});
	const section = await openFile(page, s.url, CALC);
	const card = await ask(page, section, 3, "Anything to ask the author?");
	const preview = box(card).getByTestId("comment-preview");
	await expect(preview.locator("strong")).toHaveText("only");
	await expect(preview.locator("li code")).toHaveText("v3");
	const toggle = box(card).getByTestId("preview-toggle");
	for (const name of ["Write", "Preview"]) {
		const b = toggle.getByRole("button", { name });
		const r = await b.boundingBox();
		expect(r?.width ?? 0).toBeGreaterThanOrEqual(40);
		expect(r?.height ?? 0).toBeGreaterThanOrEqual(40);
	}
	await expect(toggle.getByRole("button", { name: "Preview" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	if (isMobile) await expectNoPageOverflow(page);
	// Short content: switching never moves what's below (the button).
	const text = await write(card);
	await expect(text).toHaveValue(md);
	await text.fill("Short _one_");
	const before = await addButton(card).boundingBox();
	await toggle.getByRole("button", { name: "Preview" }).click();
	await expect(preview.locator("em")).toHaveText("one");
	const after = await addButton(card).boundingBox();
	expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
	if (isMobile) await expectNoPageOverflow(page);
	await addButton(card).click();
	await expect(box(card)).toContainText("Posted");
	const [t] = storedThreads(p);
	expect(t?.bodies[0]).toContain("Short _one_");
});

const SECOND = "And is v3 dropped on purpose?";
const TWO = `Two to ask:\n\n\`\`\`comment\n${SUGGESTED}\n\`\`\`\n\nAnd:\n\n\`\`\`comment\n${SECOND}\n\`\`\``;

test("a posted block joins its conversation to the new thread: one thread on the line, the next block replies, one after a reload", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	const p = await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: TWO }] },
	});
	const { section, card } = await askLine3(page, s.url);
	await expect(box(card)).toHaveCount(2);
	await addButton(card).first().click();
	// One thread on line 3: GitHub's, opened with the conversation in it.
	const thread = section.getByTestId("files-thread");
	await expect(thread).toHaveCount(1);
	const panel = thread.getByTestId("thread-agent-panel");
	await expect(panel).toHaveAttribute("data-open", "true");
	await expect(panel).toContainText("Anything to ask the author?");
	await expect(section.getByTestId("agent-thread")).toHaveCount(0);
	await expect(row(section, 3).getByTestId("agent-bubble")).toHaveCount(0);
	await expect(box(panel).first()).toContainText("Posted");
	if (isMobile) await expectNoPageOverflow(page);
	// The second block replies to that thread.
	const second = box(panel).filter({ has: page.getByRole("textbox") });
	await expect(second.getByTestId("agent-comment-target")).toHaveText("Reply");
	await addButton(panel).click();
	await expect(box(panel).nth(1)).toContainText("Posted");
	expect(newThreadPosts(p)).toHaveLength(1);
	expect(replyPosts(p)).toHaveLength(1);
	const stored = storedThreads(p);
	expect(stored).toHaveLength(1);
	expect(stored[0]?.bodies).toHaveLength(2);
	expect(stored[0]?.bodies[1]).toBe(SECOND);
	await page.reload();
	const again = await joinedPanel(page, s.url);
	await expect(again.thread).toHaveCount(1);
	await expect(box(again.panel)).toHaveCount(2);
	await expect(box(again.panel).nth(0)).toContainText("Posted");
	await expect(box(again.panel).nth(1)).toContainText("Posted");
	expect(newThreadPosts(p)).toHaveLength(1);
	expect(replyPosts(p)).toHaveLength(1);
});

test("the joined thread deleted on GitHub: the conversation shows on its lines again", async ({
	page,
	pr,
	agentCrb,
}) => {
	const p = await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: ANSWER }] },
	});
	const { section, card } = await askLine3(page, s.url);
	await addButton(card).click();
	await expect(
		section.getByTestId("files-thread").getByTestId("thread-agent-panel"),
	).toHaveAttribute("data-open", "true");
	await expect(row(section, 3).getByTestId("agent-bubble")).toHaveCount(0);
	p.editScenario((sc) => {
		const graph = sc.prs[p.number]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [];
	});
	await page.getByRole("button", { name: "Refresh" }).first().click();
	await expect(section.getByTestId("files-thread")).toHaveCount(0);
	await expect(
		row(section, 3).getByRole("button", { name: /comments? on line 3/ }),
	).toHaveCount(0);
	// Back on line 3, its messages and its Posted box kept.
	const back = await reopenLine3(page, s.url);
	await expect(back).toContainText("Anything to ask the author?");
	await expect(box(back)).toContainText("Posted");
});

/** crb's new-thread POST (`/api/r/<id>/threads`), held until released. */
async function holdNewThread(page: Page) {
	let release = () => {};
	const held = new Promise<void>((r) => {
		release = r;
	});
	let hits = 0;
	await page.route(/\/api\/r\/[^/]+\/threads$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		hits++;
		await held;
		await route.fallback();
	});
	return { release, hits: () => hits };
}

test("two blocks pressed back to back: the second waits for the first, then replies to its thread; one new thread", async ({
	page,
	pr,
	agentCrb,
}) => {
	const p = await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: TWO }] },
	});
	const { section, card } = await askLine3(page, s.url);
	const held = await holdNewThread(page);
	await addButton(card).first().click();
	await expect.poll(held.hits).toBe(1);
	// The first on its way: the second can't start a thread of its own.
	const second = box(card).nth(1);
	const button = second.getByRole("button", { name: "Add review comment" });
	await expect(button).toHaveAttribute("aria-disabled", "true");
	await expect(button).toHaveAttribute("aria-busy", "true");
	await expect(button).toHaveAccessibleDescription(
		"Waiting for this conversation's other comment",
	);
	await button.click({ force: true });
	held.release();
	// Joined: the second replies to the first's thread.
	const panel = section
		.getByTestId("files-thread")
		.getByTestId("thread-agent-panel");
	await expect(panel).toHaveAttribute("data-open", "true");
	await expect(box(panel).nth(0)).toContainText("Posted");
	await expect(
		box(panel).nth(1).getByTestId("agent-comment-target"),
	).toHaveText("Reply");
	await addButton(panel).click();
	await expect(box(panel).nth(1)).toContainText("Posted");
	expect(held.hits()).toBe(1);
	expect(newThreadPosts(p)).toHaveLength(1);
	expect(replyPosts(p)).toHaveLength(1);
	expect(storedThreads(p)).toHaveLength(1);
});

test("the first post's record lost: the next block replies to its thread, never a second one; then they join", async ({
	page,
	pr,
	agentCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/500|Failed to load/);
	const p = await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: TWO }] },
	});
	const { section, card } = await askLine3(page, s.url);
	const RECORD = "**/api/r/*/agent/threads/*/posted";
	await page.route(RECORD, (route) =>
		route.fulfill({ status: 500, body: '{"error":"down"}' }),
	);
	await addButton(card).first().click();
	// Posted, kept in the browser: still on its line, its card not opened.
	await expect(box(card).nth(0)).toContainText("Posted");
	await expect(
		section.getByTestId("files-thread").getByTestId("thread-agent-panel"),
	).toHaveCount(0);
	await page.unroute(RECORD);
	const second = box(card).nth(1);
	await expect(second.getByTestId("agent-comment-target")).toHaveText("Reply");
	await second.getByRole("button", { name: "Add review comment" }).click();
	// Recorded: the conversation is the thread's, its card open with both.
	const panel = section
		.getByTestId("files-thread")
		.getByTestId("thread-agent-panel");
	await expect(panel).toHaveAttribute("data-open", "true");
	await expect(box(panel).nth(0)).toContainText("Posted");
	await expect(box(panel).nth(1)).toContainText("Posted");
	expect(newThreadPosts(p)).toHaveLength(1);
	expect(replyPosts(p)).toHaveLength(1);
	expect(storedThreads(p)).toHaveLength(1);
	expect(storedThreads(p)[0]?.bodies).toHaveLength(2);
});

test("the Threads tab after a post: one People row for the thread, one AI row that opens the same card with the conversation", async ({
	page,
	pr,
	agentCrb,
}) => {
	await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: ANSWER }] },
	});
	const { section, card } = await askLine3(page, s.url);
	await addButton(card).click();
	const thread = section.getByTestId("files-thread");
	const panel = thread.getByTestId("thread-agent-panel");
	await expect(panel).toHaveAttribute("data-open", "true");
	// The conversation closed; the Threads tab's AI row opens it again.
	await thread.getByTestId("thread-agent-button").click();
	await expect(panel).toHaveAttribute("data-open", "false");
	const narrow = (page.viewportSize()?.width ?? 1280) < 768;
	let side = page.locator("body");
	if (narrow) {
		await page.getByRole("button", { name: "Files", exact: true }).click();
		side = page.getByRole("dialog", { name: "Files" });
	}
	await side
		.getByRole("tablist", { name: "Sidebar" })
		.getByRole("tab", { name: /^Threads/ })
		.click();
	const people = side.getByRole("region", { name: "People", exact: true });
	const ai = side.getByRole("region", { name: "AI", exact: true });
	await expect(people.getByTestId("threads-count")).toHaveText("1");
	await expect(ai.getByTestId("threads-count")).toHaveText("1");
	await expect(ai.getByTestId("threads-row-blurb")).toHaveText(
		"Anything to ask the author?",
	);
	await ai.getByRole("button", { name: /^src\/calc\.ts:3/ }).click();
	await expect(thread).toHaveCount(1);
	await expect(panel).toHaveAttribute("data-open", "true");
	await expect(panel).toContainText("Anything to ask the author?");
});

test("the page can't read GitHub's threads: the joined conversation shows on its lines, its blocks and box off", async ({
	page,
	pr,
	agentCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/502|Failed to load/);
	await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: TWO }] },
	});
	const { section, card } = await askLine3(page, s.url);
	await addButton(card).first().click();
	await expect(
		section.getByTestId("files-thread").getByTestId("thread-agent-panel"),
	).toHaveAttribute("data-open", "true");
	await page.route("**/api/r/*/threads?*", (route) =>
		route.fulfill({ status: 502, body: '{"error":"GitHub is down"}' }),
	);
	await page.reload();
	const back = await reopenLine3(page, s.url);
	await expect(back).toContainText("Anything to ask the author?");
	await expect(box(back).nth(0)).toContainText("Posted");
	const off = box(back)
		.nth(1)
		.getByRole("button", { name: "Add review comment" });
	await expect(off).toHaveAttribute("aria-disabled", "true");
	await expect(off).toHaveAccessibleDescription(
		"Couldn't read GitHub's threads",
	);
	await expect(
		back.getByRole("textbox", { name: "Reply to your agent" }),
	).toBeDisabled();
});

test("an earlier patch set that doesn't list the joined thread shows the conversation where it was asked", async ({
	page,
	pr,
	agentCrb,
}) => {
	test.slow();
	const p = await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: ANSWER }] },
	});
	const section = await openFile(page, s.url, CALC);
	const asked = await ask(page, section, 3, "Anything to ask the author?");
	await expect(box(asked)).toHaveCount(1);
	// A mark starts PS1.
	await marksReady(page, section);
	await section
		.getByRole("checkbox", { name: "Mark cluster reviewed" })
		.first()
		.click();
	await expect(
		section.getByRole("button", { name: "Expand file" }),
	).toBeVisible();
	// A push that leaves calc.ts alone, viewed: a comment there starts PS2.
	const NEW = "src/new.ts";
	p.moveHead({
		message: "new file",
		files: { [NEW]: "export const n = 1;\n" },
	});
	await page.reload();
	await expect(page.getByTestId("ps-tail")).toHaveAttribute(
		"data-state",
		"head",
		{ timeout: 30_000 },
	);
	await page
		.getByTestId("head-toast")
		.getByRole("button", { name: "View" })
		.click();
	const since = fileSection(page, NEW);
	await since.getByRole("button", { name: "Expand file" }).click();
	const number = row(since, 1).getByTestId("new");
	if (await page.evaluate(() => navigator.maxTouchPoints > 0)) {
		await number.tap();
	} else await number.click();
	await page
		.getByTestId("selection-bar")
		.getByRole("button", { name: "Comment" })
		.click();
	const composer = since.getByTestId("new-thread");
	await composer.getByRole("textbox", { name: "Comment" }).fill("Starts PS2");
	await composer.getByRole("button", { name: "Comment" }).click();
	await expect(page.getByTestId("ps-node-ps2")).toBeVisible({
		timeout: 30_000,
	});
	// PS2's start is in the review ref (its time is the cutoff PS1 lists
	// threads by), and the clock is past it: the block's thread is newer.
	const ps2Start = async () =>
		page.evaluate(async () => {
			const id = /\/r\/([^/]+)/.exec(location.pathname)?.[1];
			const r = await fetch(`/api/r/${id}/session${location.search}`);
			const s = (await r.json()) as {
				patchsets?: { number: number; startedAt: number }[];
			};
			return s.patchsets?.find((p) => p.number === 2)?.startedAt ?? null;
		});
	await expect.poll(ps2Start, { timeout: 30_000 }).not.toBeNull();
	const started = (await ps2Start()) as number;
	await expect.poll(() => Date.now()).toBeGreaterThan(started + 1000);
	// Now the block: a new thread on calc.ts's line 3, after PS2 started.
	// calc.ts has no change in this view: the hidden lines' bubble holds it.
	const calc = fileSection(page, CALC);
	await calc
		.getByRole("button", { name: /^1 agent thread in this file/ })
		.click();
	await calc
		.getByRole("button", { name: /^1 agent thread on hidden lines/ })
		.click();
	const onHead = calc
		.getByTestId("agent-thread")
		.filter({ hasText: "Anything to ask the author?" });
	await expect(onHead).toBeVisible();
	await addButton(onHead).click();
	await expect.poll(() => newThreadPosts(p).length).toBe(2);
	// PS1 lists only threads published before PS2 started: not the joined
	// one, so the conversation shows where it was asked, Posted.
	await page.goto(reviewPage(s.url, "files", "ps=1"));
	const ps1 = fileSection(page, CALC);
	await ps1.getByRole("button", { name: "Expand file" }).click();
	await expect(
		row(ps1, 3).getByRole("button", { name: /comments? on line 3/ }),
	).toHaveCount(0);
	await row(ps1, 3).getByTestId("agent-bubble").click();
	const card = ps1
		.getByTestId("agent-thread")
		.filter({ hasText: "Anything to ask the author?" });
	await expect(card).toBeVisible();
	await expect(box(card)).toContainText("Posted");
});
