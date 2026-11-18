import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import {
	reviewThread,
	type Scenario,
	threadComment,
} from "../test/fake-gh/scenario";
import { ask, CALC, expect, fixture, openFile, row, test } from "./agent-ui";
import { expectNoPageOverflow } from "./files-ui";
import type { Pr } from "./fixtures";

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

/** Asks about calc's line 3 and waits for the answer's box. */
async function askLine3(page: Page, url: string) {
	const section = await openFile(page, url, CALC);
	const card = await ask(page, section, 3, "Anything to ask the author?");
	await expect(
		box(card).getByRole("textbox", { name: "Review comment" }),
	).toHaveValue(SUGGESTED);
	return { section, card };
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
	await expect(box(card)).toContainText("Posted");
	await expect(
		box(card).getByRole("link", { name: "Open on GitHub" }),
	).toHaveAttribute("href", /#discussion_r\d+$/);
	await expect(box(card)).toContainText("A List<String> would do.");
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
	const again = await reopenLine3(page, s.url);
	await expect(box(again)).toContainText("Posted");
	await expect(box(again).getByRole("textbox")).toHaveCount(0);
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
	// Reloaded: still Posted (the browser's copy), and the record is written.
	const recorded = page.waitForResponse(
		(r) => /\/agent\/threads\/[^/]+\/posted$/.test(r.url()) && r.ok(),
	);
	await page.reload();
	const again = await reopenLine3(page, s.url);
	await expect(box(again)).toContainText("Posted");
	await recorded;
	expect(newThreadPosts(p)).toHaveLength(1);
	// Another device: nothing kept there, Posted from the record alone.
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await expect(box(await reopenLine3(page, s.url))).toContainText("Posted");
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
	const text = box(card).getByRole("textbox", { name: "Review comment" });
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
