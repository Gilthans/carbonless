import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { release } from "../test/fake-gh/scenario";
import {
	ask,
	bar,
	CALC,
	expect,
	fixture,
	openFile,
	row,
	selectText,
	test,
} from "./agent-ui";
import {
	expectNoPageOverflow,
	fileSection,
	marksReady,
	openFiles,
} from "./files-ui";

// Its own crb serve: the agent's config, its fake ACP env and checkouts.
test.use({ crbServer: "own" });

/**
 * Comment on an agent conversation's card: a new GitHub thread on its span
 * (the fake gh), after which the conversation is that thread's, behind its
 * agent button, and no longer a card on the code. On a line and on a whole
 * file, desktop and phone.
 */

const AGENT = { name: "Fake Agent", version: "9.9.9" };

/** Holds every seen mark (the answer stays new; no timer race). */
const holdSeen = (page: Page) =>
	page.route(/\/api\/r\/[^/]+\/agent\/threads\/[^/]+\/seen$/, () => {});

/** Opens the GitHub thread's agent conversation from its agent button. */
async function openConversation(thread: Locator) {
	await thread.getByTestId("thread-agent-button").click();
	const panel = thread.getByTestId("thread-agent-panel");
	await expect(panel).toHaveAttribute("data-open", "true");
	return panel;
}

const BOXES =
	'[data-testid="agent-thread"], [data-testid="new-thread"], [data-testid="files-thread"]';

/**
 * Records the fewest thread boxes `section` holds at any DOM change from
 * now (each commit, before it is painted) until minBoxes reads it.
 */
const watchBoxes = (section: Locator) =>
	section.evaluate((el, sel) => {
		const w = window as unknown as {
			__minBoxes: number;
			__boxes?: MutationObserver;
		};
		const count = () => el.querySelectorAll(sel).length;
		w.__boxes?.disconnect();
		w.__minBoxes = count();
		w.__boxes = new MutationObserver(() => {
			w.__minBoxes = Math.min(w.__minBoxes, count());
		});
		w.__boxes.observe(el, { childList: true, subtree: true });
	}, BOXES);
const minBoxes = (section: Locator) =>
	section.evaluate(() => {
		const w = window as unknown as {
			__minBoxes: number;
			__boxes?: MutationObserver;
		};
		w.__boxes?.disconnect();
		return w.__minBoxes;
	});
const viewportTop = async (l: Locator) =>
	(await l.boundingBox())?.y ?? Number.NaN;

/** Asks about the whole of `path` through the API (no page entry for it yet). */
async function askOnFile(
	url: string,
	path: string,
	commit: string,
	text: string,
) {
	const u = new URL(url);
	const id = /^\/r\/([^/]+)/.exec(u.pathname)?.[1];
	const key = u.searchParams.get("key");
	const res = await fetch(
		`${u.origin}/api/r/${id}/agent/threads${key ? `?${new URLSearchParams({ key })}` : ""}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				clientId: "file-q",
				text,
				span: { subject: "file", path, commit },
			}),
		},
	);
	if (!res.ok)
		throw new Error(`Ask answered ${res.status}: ${await res.text()}`);
}

test("Comment on a line's conversation: Cancel keeps it; posted, the GitHub thread's agent button holds it, the card leaves the code, across a reload", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	// An answered question, a Cancel, a post, the agent read again, a reload.
	test.slow();
	await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "It adds v1 and v2." }] },
	});
	await holdSeen(page);
	const section = await openFile(page, s.url, CALC);
	const card = await ask(page, section, 3, "Does total add everything?");
	await expect(card.getByTestId("agent-message-ai")).toHaveText(
		"It adds v1 and v2.",
	);
	const comment = card.getByRole("button", { name: "Comment on GitHub" });
	// One box on the line through it all: the card, the thread it turns
	// into in its place, then GitHub's thread there.
	const boxes = section.locator(
		'[data-testid="agent-thread"], [data-testid="new-thread"], [data-testid="files-thread"]',
	);
	// Measured from line 3's row: the page may scroll the box into view.
	const top = async (l: Locator) =>
		((await l.boundingBox())?.y ?? Number.NaN) -
		((await row(section, 3).boundingBox())?.y ?? Number.NaN);
	await expect(boxes).toHaveCount(1);
	const cardTop = await top(card);
	// Cancel: nothing changes.
	await comment.click();
	const composer = section.getByTestId("new-thread");
	const box = composer.getByRole("textbox", { name: "Comment" });
	await expect(box).toBeFocused();
	await expect(box).toHaveValue("");
	await expect(boxes).toHaveCount(1);
	await expect(card).toHaveCount(0);
	expect(Math.abs((await top(composer)) - cardTop)).toBeLessThan(4);
	// The conversation is the new thread's, open behind its agent handle;
	// it stays a comment (no switch to the agent).
	const pendingPanel = composer.getByTestId("thread-agent-panel");
	await expect(pendingPanel).toHaveAttribute("data-open", "true");
	await expect(pendingPanel.getByTestId("agent-message-ai")).toHaveText(
		"It adds v1 and v2.",
	);
	await expect(composer.getByTestId("thread-agent-button")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(
		composer.getByRole("button", { name: "Ask agent instead" }),
	).toHaveCount(0);
	if (isMobile) await expectNoPageOverflow(page);
	await composer.getByRole("button", { name: "Cancel" }).click();
	await expect(composer).toHaveCount(0);
	await expect(card).toBeVisible();
	await expect(boxes).toHaveCount(1);
	// Posted: GitHub's thread on line 3, the conversation behind its agent button.
	await comment.click();
	await expect(box).toBeFocused();
	await box.fill("Shouldn't total add v3 too?");
	if (isMobile) await expectNoPageOverflow(page);
	const pendingTop = await top(composer);
	// Never a moment with no box on the line while it is handed over.
	await watchBoxes(section);
	await composer.getByTestId("new-thread-post").click();
	const thread = section
		.getByTestId("files-thread")
		.filter({ hasText: "Shouldn't total add v3 too?" });
	await expect(thread).toBeVisible();
	expect(await minBoxes(section)).toBe(1);
	await expect(section.getByTestId("agent-thread")).toHaveCount(0);
	await expect(boxes).toHaveCount(1);
	expect(Math.abs((await top(thread)) - pendingTop)).toBeLessThan(4);
	const panel = await openConversation(thread);
	await expect(panel.getByTestId("agent-message-human")).toHaveText([
		"Does total add everything?",
	]);
	await expect(panel.getByTestId("agent-message-ai")).toHaveText(
		"It adds v1 and v2.",
	);
	// Kept in the agent ref: the same after a reload.
	await page.reload();
	const again = await openFile(page, s.url, CALC);
	await again
		.locator('tr[data-testid="diff-line"][data-new-no="3"]')
		.getByRole("button", { name: /^1 comment on line 3/ })
		.click();
	const reloaded = again
		.getByTestId("files-thread")
		.filter({ hasText: "Shouldn't total add v3 too?" });
	await expect(reloaded).toBeVisible();
	await expect(again.getByTestId("agent-thread")).toHaveCount(0);
	await expect(
		(await openConversation(reloaded)).getByTestId("agent-message-ai"),
	).toHaveText("It adds v1 and v2.");
});

test("Comment on a whole file's conversation: posted on the file, the conversation goes with it", async ({
	page,
	pr,
	agentCrb,
}) => {
	// An answered question, a post GitHub takes, the agent read again.
	test.slow();
	const p = await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "Fine as a whole." }] },
	});
	await holdSeen(page);
	await askOnFile(
		s.url,
		CALC,
		p.repo.shas.at(-1) ?? "",
		"Is this file needed?",
	);
	const section = await openFile(page, s.url, CALC);
	await section
		.getByRole("button", { name: /agent thread.* on this file/ })
		.click();
	const card = section
		.getByTestId("agent-thread")
		.filter({ hasText: "Is this file needed?" });
	await expect(card.getByTestId("agent-message-ai")).toHaveText(
		"Fine as a whole.",
	);
	await card.getByRole("button", { name: "Comment on GitHub" }).click();
	const composer = section.getByTestId("new-thread");
	await expect(composer).toContainText("whole file");
	// In the card's place, the conversation on it: one box, not two.
	await expect(card).toHaveCount(0);
	await expect(composer).toHaveCount(1);
	await expect(
		composer.getByTestId("thread-agent-panel").getByTestId("agent-message-ai"),
	).toHaveText("Fine as a whole.");
	const box = composer.getByRole("textbox", { name: "Comment" });
	await expect(box).toBeFocused();
	await box.fill("Do we need this file?");
	await composer.getByTestId("new-thread-post").click();
	const thread = section
		.getByTestId("file-threads")
		.getByTestId("files-thread")
		.filter({ hasText: "Do we need this file?" });
	await expect(thread).toBeVisible();
	await expect(section.getByTestId("agent-thread")).toHaveCount(0);
	await expect(
		(await openConversation(thread)).getByTestId("agent-message-human"),
	).toHaveText(["Is this file needed?"]);
});

/**
 * Comment on a card, type, post: the GitHub thread shows where the pending
 * one was on screen, though the line lists it first (above what was above
 * the pending thread), and no box on the line ever goes missing.
 */
async function postInPlace(page: Page, section: Locator, card: Locator) {
	await card.getByRole("button", { name: "Comment on GitHub" }).click();
	const composer = section.getByTestId("new-thread");
	const box = composer.getByRole("textbox", { name: "Comment" });
	await expect(box).toBeFocused();
	await box.fill("Posted from the card");
	const before = await section.locator(BOXES).count();
	const pendingTop = await viewportTop(composer);
	await watchBoxes(section);
	// From the keyboard: a click would scroll the button into view first.
	await box.press("Control+Enter");
	const thread = section
		.getByTestId("files-thread")
		.filter({ hasText: "Posted from the card" });
	await expect(thread).toBeVisible();
	await expect(composer).toHaveCount(0);
	expect(await minBoxes(section)).toBeGreaterThanOrEqual(before);
	await expect(section.locator(BOXES)).toHaveCount(before);
	expect(Math.abs((await viewportTop(thread)) - pendingTop)).toBeLessThan(4);
	if (await page.evaluate(() => navigator.maxTouchPoints > 0)) {
		await expectNoPageOverflow(page);
	}
	return thread;
}

test("Comment on a conversation below an open GitHub thread on its line: posted, it stays where the pending thread was", async ({
	page,
	pr,
	agentCrb,
}) => {
	// A comment, an answered question, a post.
	test.slow();
	await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "It adds v1 and v2." }] },
	});
	await holdSeen(page);
	const section = await openFile(page, s.url, CALC);
	await selectText(page, CALC, 3, 0, 6);
	await bar(page).getByRole("button", { name: "Comment" }).click();
	const first = section.getByTestId("new-thread");
	await first.getByRole("textbox", { name: "Comment" }).fill("Already here");
	await first.getByTestId("new-thread-post").click();
	await expect(
		section.getByTestId("files-thread").filter({ hasText: "Already here" }),
	).toBeVisible();
	const card = await ask(page, section, 3, "Does total add everything?");
	await expect(card.getByTestId("agent-message-ai")).toHaveText(
		"It adds v1 and v2.",
	);
	const thread = await postInPlace(page, section, card);
	await expect(section.getByTestId("agent-thread")).toHaveCount(0);
	await expect(
		(await openConversation(thread)).getByTestId("agent-message-human"),
	).toHaveText(["Does total add everything?"]);
});

test("Comment on the second of two conversations on a line: posted, it stays where the pending thread was, the other card untouched", async ({
	page,
	pr,
	agentCrb,
}) => {
	// Two answered questions, a post.
	test.slow();
	await pr(fixture);
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [
				{ match: "First", text: "First answer." },
				{ match: "Second", text: "Second answer." },
			],
		},
	});
	await holdSeen(page);
	const section = await openFile(page, s.url, CALC);
	const one = await ask(page, section, 3, "First question");
	await expect(one.getByTestId("agent-message-ai")).toHaveText("First answer.");
	const two = await ask(page, section, 3, "Second question", [0, 6]);
	await expect(two.getByTestId("agent-message-ai")).toHaveText(
		"Second answer.",
	);
	// The one drawn lower on the line.
	const [a, b] = [await viewportTop(one), await viewportTop(two)];
	const lower = a > b ? one : two;
	const other = a > b ? two : one;
	await postInPlace(page, section, lower);
	await expect(section.getByTestId("agent-thread")).toHaveCount(1);
	await expect(other).toBeVisible();
});

test("Posted while scrolled on past the line: what the reader is looking at stays still as the thread lands", async ({
	page,
	pr,
	agentCrb,
}) => {
	// A comment, an answered question, a held post.
	test.slow();
	const p = await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "It adds v1 and v2." }] },
	});
	await holdSeen(page);
	const section = await openFile(page, s.url, CALC);
	// An open GitHub thread above: the new one lands above it.
	await selectText(page, CALC, 3, 0, 6);
	await bar(page).getByRole("button", { name: "Comment" }).click();
	const first = section.getByTestId("new-thread");
	await first.getByRole("textbox", { name: "Comment" }).fill("Already here");
	await first.getByTestId("new-thread-post").click();
	await expect(
		section.getByTestId("files-thread").filter({ hasText: "Already here" }),
	).toBeVisible();
	const card = await ask(page, section, 3, "Does total add everything?");
	await expect(card.getByTestId("agent-message-ai")).toHaveText(
		"It adds v1 and v2.",
	);
	await card.getByRole("button", { name: "Comment on GitHub" }).click();
	const composer = section.getByTestId("new-thread");
	const box = composer.getByRole("textbox", { name: "Comment" });
	await box.fill("Posted, then read on");
	p.editScenario((sc) => {
		sc.hold = ["comment"];
	});
	await box.press("Control+Enter");
	await expect(composer.getByTestId("new-thread-sending")).toBeVisible();
	// Its panel folded away (the sent comment shows), the box at its size.
	await expect(composer.getByTestId("thread-agent-panel")).toBeHidden();
	// Read on: the pending thread scrolled out above (room below the short
	// file to scroll that far), line 4 in view.
	await page.evaluate(() => {
		document.body.style.paddingBottom = "200vh";
	});
	const at = await composer.boundingBox();
	await page.evaluate(
		(by) => window.scrollBy(0, by),
		(at?.y ?? 0) + (at?.height ?? 0) + 1,
	);
	await expect(composer).not.toBeInViewport();
	const reading = row(section, 4);
	await expect(reading).toBeInViewport();
	const before = await viewportTop(reading);
	release(p.scenarioPath, "comment");
	await expect(
		section
			.getByTestId("files-thread")
			.filter({ hasText: "Posted, then read on" }),
	).toHaveCount(1);
	await expect(composer).toHaveCount(0);
	expect(Math.abs((await viewportTop(reading)) - before)).toBeLessThan(4);
});

/** GitHub's threads in the fake gh's scenario: where each was posted. */
function storedThreads(p: { scenarioPath: string }) {
	const s = JSON.parse(readFileSync(p.scenarioPath, "utf8")) as {
		prs: Record<
			string,
			{
				graphql?: {
					reviewThreads?: {
						path: string;
						line: number;
						diffSide?: string;
						first?: { nodes: { originalCommit?: { oid: string } }[] };
					}[];
				};
			}
		>;
	};
	return Object.values(s.prs).flatMap((pr) =>
		(pr.graphql?.reviewThreads ?? []).map((t) => ({
			path: t.path,
			line: t.line,
			side: t.diffSide,
			originalCommit: t.first?.nodes[0]?.originalCommit?.oid,
		})),
	);
}

test("Comment on a conversation asked on PS1, the PR's new head on screen: the page goes to PS1, the GitHub thread is on PS1's commit and holds the conversation", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	// An answer, a mark, a push, the head's view, a post.
	test.slow();
	const p = await pr(fixture);
	const ps1 = p.repo.shas.at(-1) ?? "";
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "It adds v1 and v2." }] },
	});
	await holdSeen(page);
	const section = await openFile(page, s.url, CALC);
	const card = await ask(page, section, 3, "Asked on PS1");
	await expect(card.getByTestId("agent-message-ai")).toHaveText(
		"It adds v1 and v2.",
	);
	// The mark starts PS1 (the file's only cluster: it closes).
	await marksReady(page, section);
	await section
		.getByRole("checkbox", { name: "Mark cluster reviewed" })
		.first()
		.click();
	await expect(
		section.getByRole("button", { name: "Expand file" }),
	).toBeVisible();
	// Pushed: two lines on top, the asked line is 5 on the new head.
	const lines = (top: string[]) =>
		`${[
			...top,
			...Array.from({ length: 12 }, (_, i) =>
				i === 2
					? "export const total = v1 + v2;"
					: `export const v${i + 1} = ${i + 1};`,
			),
		].join("\n")}\n`;
	const head = p.moveHead({
		message: "two lines on top",
		files: { [CALC]: lines(["// one", "// two"]) },
	});
	await page.reload();
	await expect(page.getByTestId("ps-tail")).toHaveAttribute(
		"data-state",
		"head",
		// The head check's fetch on a loaded machine (rereview.spec's GIT_WAIT).
		{ timeout: 30_000 },
	);
	await page
		.getByTestId("head-toast")
		.getByRole("button", { name: "View" })
		.click();
	// The new head on screen: the conversation traced onto its line 5.
	const onHead = fileSection(page, CALC);
	await onHead.getByRole("button", { name: "Expand file" }).click();
	// The head's diff is built on its first view (git diff and placement
	// against the new head): up to 30 s on a loaded machine, as the head
	// check above (rereview.spec's GIT_WAIT).
	await expect(row(onHead, 5)).toBeVisible({ timeout: 30_000 });
	await row(onHead, 5).getByTestId("agent-bubble").click();
	const traced = onHead
		.getByTestId("agent-thread")
		.filter({ hasText: "Asked on PS1" });
	const comment = traced.getByRole("button", { name: "Comment on GitHub" });
	await expect(comment).not.toHaveAttribute("aria-disabled", "true");
	await comment.click();
	// PS1 on screen (where the conversation's line is), its file open, the
	// composer on PS1's line 3.
	await expect(page).toHaveURL(/[?&]ps=1(&|$)/);
	const onPs1 = fileSection(page, CALC);
	const composer = onPs1.getByTestId("new-thread");
	await expect(composer).toContainText("line 3, new");
	const box = composer.getByRole("textbox", { name: "Comment" });
	await expect(box).toBeFocused();
	await box.fill("Shouldn't total add v3?");
	if (isMobile) await expectNoPageOverflow(page);
	await composer.getByTestId("new-thread-post").click();
	const thread = onPs1
		.getByTestId("files-thread")
		.filter({ hasText: "Shouldn't total add v3?" });
	await expect(thread).toBeVisible();
	// GitHub has it on PS1's commit, not the head's.
	expect(head).not.toBe(ps1);
	expect(storedThreads(p)).toMatchObject([
		{ path: CALC, line: 3, originalCommit: ps1 },
	]);
	// The conversation is the thread's now: behind its agent button.
	await expect(onPs1.getByTestId("agent-thread")).toHaveCount(0);
	const panel = await openConversation(thread);
	await expect(panel.getByTestId("agent-message-human")).toHaveText([
		"Asked on PS1",
	]);
});

test("Comment on a conversation asked in the since view on a line only PS1 had: posted on PS1's commit, the card becomes the thread in place on that row (CAR-264)", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	// A mark, a push, the since view, an answer, a post.
	test.slow();
	const p = await pr(fixture);
	const ps1 = p.repo.shas.at(-1) ?? "";
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "PS2 reworked it." }] },
	});
	await holdSeen(page);
	const section = await openFile(page, s.url, CALC);
	// The mark starts PS1 (the file's only cluster: it closes).
	await marksReady(page, section);
	await section
		.getByRole("checkbox", { name: "Mark cluster reviewed" })
		.first()
		.click();
	await expect(
		section.getByRole("button", { name: "Expand file" }),
	).toBeVisible();
	// PS2 rewrites PS1's line 3: that line is in neither the base nor the head.
	const head = p.moveHead({
		message: "total adds v3",
		files: {
			[CALC]: `${Array.from({ length: 12 }, (_, i) =>
				i === 2
					? "export const total = v1 + v2 + v3;"
					: `export const v${i + 1} = ${i + 1};`,
			).join("\n")}\n`,
		},
	});
	await page.reload();
	await expect(page.getByTestId("ps-tail")).toHaveAttribute(
		"data-state",
		"head",
		// The head check's fetch on a loaded machine (rereview.spec's GIT_WAIT).
		{ timeout: 30_000 },
	);
	await page
		.getByTestId("head-toast")
		.getByRole("button", { name: "View" })
		.click();
	// The since view (PS1 → the head).
	await expect(
		page
			.getByTestId("ps-node-ps1")
			.getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	const since = fileSection(page, CALC);
	await since.getByRole("button", { name: "Expand file" }).click();
	const removed = since.locator(
		'tr[data-testid="diff-line"][data-kind="del"][data-old-no="3"]',
	);
	// Built on its first view: up to 30 s on a loaded machine (GIT_WAIT).
	await expect(removed).toBeVisible({ timeout: 30_000 });
	await expect(removed).toHaveAttribute("data-ps-no", "3");
	const number = removed.getByTestId("old");
	if (isMobile) await number.tap();
	else await number.click();
	await bar(page).getByRole("button", { name: "Ask agent" }).click();
	const asking = since.getByTestId("agent-composer");
	await asking
		.getByRole("textbox", { name: "Ask your agent" })
		.fill("Why was this dropped?");
	await asking.getByTestId("agent-composer-ask").click();
	const card = since
		.getByTestId("agent-thread")
		.filter({ hasText: "Why was this dropped?" });
	await expect(card.getByTestId("agent-message-ai")).toHaveText(
		"PS2 reworked it.",
	);
	const comment = card.getByRole("button", { name: "Comment on GitHub" });
	await expect(comment).not.toHaveAttribute("aria-disabled", "true");
	const boxes = since.locator(BOXES);
	await expect(boxes).toHaveCount(1);
	await comment.click();
	// The card turns into the composer in its place; the page stays.
	const composer = since.getByTestId("new-thread");
	await expect(card).toHaveCount(0);
	await expect(boxes).toHaveCount(1);
	await expect(
		page
			.getByTestId("ps-node-ps1")
			.getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	const box = composer.getByRole("textbox", { name: "Comment" });
	await expect(box).toBeFocused();
	await box.fill("Why add it, then rework it?");
	if (isMobile) await expectNoPageOverflow(page);
	await watchBoxes(since);
	await composer.getByTestId("new-thread-post").click();
	const thread = since
		.getByTestId("files-thread")
		.filter({ hasText: "Why add it, then rework it?" });
	await expect(thread).toBeVisible();
	expect(await minBoxes(since)).toBe(1);
	await expect(since.getByTestId("agent-thread")).toHaveCount(0);
	// On that row, and on GitHub on PS1's commit at its line there.
	await expect(removed).toHaveAttribute("data-commented", "");
	expect(head).not.toBe(ps1);
	expect(storedThreads(p)).toMatchObject([
		{ path: CALC, line: 3, originalCommit: ps1 },
	]);
	// The conversation is the thread's now: behind its agent button.
	const panel = await openConversation(thread);
	await expect(panel.getByTestId("agent-message-human")).toHaveText([
		"Why was this dropped?",
	]);
});

/**
 * CAR-276 (CAR-216's example the other way round, rereview.spec): the
 * base is gallery #58's PS2 and PS2 its base. PS2's diff removes base
 * line 10, a blank that PS1 kept and nobody reviewed: the since view shows
 * it removed, an orphan with no number of PS1's.
 */
const RESULT = "src/result.py";
const pyLines = (lines: string[]) => `${lines.join("\n")}\n`;
const resultHead = pyLines([
	"class Result:",
	"    count: int",
	"",
	"    def total(self):",
	"        return self.count",
]);
const resultPs1 = pyLines([
	"class Result(Base):",
	"    count: int = 0",
	"",
	"    def add(self):",
	"        return 2",
	"",
	"    def total(self):",
	"        return self.count",
]);
const resultBase = pyLines([
	"class Totals:",
	"    count: int",
	"",
	"",
	"class Result(Base):",
	"    count: int = 0",
	"",
	"    def add(self):",
	"        return 3",
	"",
	"    def total(self):",
	"        return self.count",
]);

test("Ask agent on a removed line never reviewed in PS1 (since view), then Comment on GitHub: posted on its base line, LEFT, on the head (CAR-276)", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	// A review of PS1, a push, the since view, an answer, a post.
	test.slow();
	const p = await pr({
		base: { [RESULT]: resultBase },
		files: [{ message: "PS1", files: { [RESULT]: resultPs1 } }],
	});
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "A spacer." }] },
	});
	await holdSeen(page);
	await openFiles(page, s.url);
	const first = fileSection(page, RESULT);
	await first.getByRole("button", { name: "Expand file" }).click();
	await marksReady(page, first);
	const boxes = first.getByRole("checkbox", { name: "Mark cluster reviewed" });
	const n = await boxes.count();
	for (let i = 0; i < n; i++) await boxes.nth(i).click();
	await expect(
		first.getByRole("button", { name: "Expand file" }),
	).toBeVisible();
	// The head check's fetch and the engine's answer on a loaded machine:
	// up to 30 s (rereview.spec's GIT_WAIT).
	const GIT_WAIT = { timeout: 30_000 };
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);
	const head = p.moveHead({ message: "PS2", files: { [RESULT]: resultHead } });
	await page.reload();
	await expect(page.getByTestId("ps-tail")).toHaveAttribute(
		"data-state",
		"head",
		GIT_WAIT,
	);
	await page
		.getByTestId("head-toast")
		.getByRole("button", { name: "View" })
		.click();
	await expect(
		page
			.getByTestId("ps-node-ps1")
			.getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	const since = fileSection(page, RESULT);
	await since.getByRole("button", { name: "Expand file" }).click();
	const orphan = since.locator(
		'tr[data-testid="diff-line"][data-kind="del"][data-base-no="10"]:not([data-old-no])',
	);
	await expect(orphan).toBeVisible(GIT_WAIT);
	if (isMobile) await orphan.getByTestId("old").tap();
	else await orphan.getByRole("button", { name: "Base line 10" }).click();
	await expect(orphan).toHaveAttribute("data-picked", "true");
	await bar(page).getByRole("button", { name: "Ask agent" }).click();
	const asking = since.getByTestId("agent-composer");
	await expect(asking).toContainText("line 10, base");
	await asking
		.getByRole("textbox", { name: "Ask your agent" })
		.fill("Why drop the blank?");
	await asking.getByTestId("agent-composer-ask").click();
	await expect(asking).toHaveCount(0);
	const card = since
		.getByTestId("agent-thread")
		.filter({ hasText: "Why drop the blank?" });
	await expect(card.getByTestId("agent-message-ai")).toHaveText("A spacer.");
	// On its row.
	await expect(orphan.getByTestId("agent-bubble")).toBeVisible();
	const comment = card.getByRole("button", { name: "Comment on GitHub" });
	await expect(comment).not.toHaveAttribute("aria-disabled", "true");
	await comment.click();
	const composer = since.getByTestId("new-thread");
	const box = composer.getByRole("textbox", { name: "Comment" });
	await expect(box).toBeFocused();
	await box.fill("Is the blank needed?");
	if (isMobile) await expectNoPageOverflow(page);
	await composer.getByTestId("new-thread-post").click();
	const thread = since
		.getByTestId("files-thread")
		.filter({ hasText: "Is the blank needed?" });
	await expect(thread).toBeVisible();
	// GitHub has it on the head, LEFT 10 (the base line).
	expect(storedThreads(p)).toMatchObject([
		{ path: RESULT, line: 10, side: "LEFT", originalCommit: head },
	]);
	await expect(orphan).toHaveAttribute("data-commented", "");
	// The conversation is the thread's now: behind its agent button.
	await expect(since.getByTestId("agent-thread")).toHaveCount(0);
	const panel = await openConversation(thread);
	await expect(panel.getByTestId("agent-message-human")).toHaveText([
		"Why drop the blank?",
	]);
});
