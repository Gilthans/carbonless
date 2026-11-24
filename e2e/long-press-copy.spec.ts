import type { Locator, Page } from "@playwright/test";
import { COPIED_MS, LONG_PRESS_MS } from "../src/web/longPress";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import { CALC, expect, fixture, openFile, row, test } from "./agent-ui";
import { installClock, type Pr, type PrOptions } from "./fixtures";

// Its own crb serve: the agent's config, its fake ACP env and checkouts.
test.use({ crbServer: "own" });

/**
 * A long press on a message, on a phone (CAR-280): Copy message copies
 * its Markdown source, over plain http too (no Clipboard API, as on a
 * tailnet address); a drag or a mouse opens nothing. And a selection begun
 * in a thread card stays out of the code lines on touch.
 */

/** As written on github.com: two lines, CRLF (the textarea copy turns it into LF). */
const BODY = "Is **total** right?\r\nOr just v1 + v2.";
const COPIED = BODY.replace(/\r\n/g, "\n");
const SHOWN = "Is total right?\nOr just v1 + v2.";
const ANSWER = "Yes: it adds **v1 and v2**.";

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
					text: SHOWN,
					body: BODY,
					html: '<p dir="auto">Is <strong>total</strong> right?<br>\nOr just v1 + v2.</p>',
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

/** As over plain http: no Clipboard API; the test keeps its own handle to read it. */
async function noClipboardApi(page: Page) {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.addInitScript(() => {
		const c = navigator.clipboard;
		const w = window as unknown as Record<string, unknown>;
		w.__readClipboard = () => c.readText();
		w.__writeClipboard = (t: string) => c.writeText(t);
		Object.defineProperty(Navigator.prototype, "clipboard", {
			configurable: true,
			get: () => undefined,
		});
	});
}

const clipboard = (page: Page) =>
	page.evaluate(() =>
		(
			(window as unknown as Record<string, unknown>)
				.__readClipboard as () => Promise<string>
		)(),
	);

const setClipboard = (page: Page, text: string) =>
	page.evaluate(
		(t) =>
			(
				(window as unknown as Record<string, unknown>).__writeClipboard as (
					t: string,
				) => Promise<void>
			)(t),
		text,
	);

/** Files changed's thread on line 3, opened from its bubble. */
async function filesThread(page: Page, url: string): Promise<Locator> {
	const section = await openFile(page, url, CALC);
	await row(section, 3)
		.getByRole("button", { name: /^1 comment on line 3/ })
		.click();
	const thread = section.getByTestId("files-thread");
	await expect(thread).toBeVisible();
	return thread;
}

/**
 * A finger on `target`'s first text (left, middle), resting LONG_PRESS_MS
 * on the page's clock (paused) after moving `move` px down, then lifted.
 */
async function longPress(page: Page, target: Locator, move = 0) {
	await target.scrollIntoViewIfNeeded();
	const box = await target.boundingBox();
	if (!box) throw new Error("no box");
	const x = Math.round(box.x + 20);
	const y = Math.round(box.y + box.height / 2);
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Input.dispatchTouchEvent", {
		type: "touchStart",
		touchPoints: [{ x, y }],
	});
	if (move) {
		for (let dy = 4; dy <= move; dy += 4) {
			await cdp.send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [{ x, y: y + dy }],
			});
		}
	}
	await page.clock.fastForward(LONG_PRESS_MS);
	await cdp.send("Input.dispatchTouchEvent", {
		type: "touchEnd",
		touchPoints: [],
	});
	await cdp.detach();
}

/** Pauses the page's clock a moment ahead of its own time (it may run ahead of the test's). */
async function pause(page: Page) {
	const now = await page.evaluate(() => Date.now());
	await page.clock.pauseAt(now + 1000);
}

const menu = (page: Page) => page.getByRole("menu", { name: "Message" });

test("on a phone, a long press on a GitHub comment and on an agent answer copies its Markdown; a refused copy says so; a drag opens nothing", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "touch only");
	// An agent turn and several presses: past 30 s on a loaded machine.
	test.slow();
	await setup(pr);
	const s = await agentCrb({
		scenario: {
			agent: { name: "Fake Agent", version: "9.9.9" },
			answers: [{ text: ANSWER }],
		},
	});
	await noClipboardApi(page);
	await installClock(page);
	const thread = await filesThread(page, s.url);
	const comment = thread.getByTestId("thread-comment-body").first();
	await expect(comment).toHaveText(/^Is total right\?\s*Or just v1 \+ v2\.$/);
	await setClipboard(page, "before");
	await pause(page);

	// A drag (a scroll, a selection) never opens it.
	await longPress(page, comment, 24);
	await expect(menu(page)).toHaveCount(0);

	await longPress(page, comment);
	await expect(menu(page)).toBeVisible();
	const copy = menu(page).getByRole("menuitem", { name: "Copy message" });
	await expect(copy).toBeVisible();
	const box = await copy.boundingBox();
	expect(box?.height).toBeGreaterThanOrEqual(40);
	await copy.click();
	await expect(
		menu(page)
			.getByRole("menuitem", { name: "Copied" })
			.locator(".octicon-check"),
	).toBeVisible();
	await expect.poll(() => clipboard(page)).toBe(COPIED);
	await page.clock.fastForward(COPIED_MS);
	await expect(menu(page)).toHaveCount(0);

	// A copy the browser didn't make: Copy failed, the message selected to
	// copy by hand, the clipboard as it was.
	await page.evaluate(() => {
		const t = HTMLTextAreaElement.prototype;
		const w = window as unknown as Record<string, unknown>;
		w.__textarea = {
			focus: t.focus,
			select: t.select,
			setSelectionRange: t.setSelectionRange,
		};
		t.focus = () => {};
		t.select = () => {};
		t.setSelectionRange = () => {};
	});
	await setClipboard(page, "before");
	await longPress(page, comment);
	await menu(page).getByRole("menuitem", { name: "Copy message" }).click();
	const failed = menu(page).getByRole("menuitem", { name: "Copy failed" });
	await expect(failed.locator(".octicon-x")).toBeVisible();
	await page.clock.fastForward(COPIED_MS * 2);
	await expect(failed).toBeVisible();
	expect(
		await page.evaluate(() => document.getSelection()?.toString()),
	).toMatch(/^Is total right\?\s*Or just v1 \+ v2\.$/);
	expect(await clipboard(page)).toBe("before");
	await page.keyboard.press("Escape");
	await expect(menu(page)).toHaveCount(0);
	await page.evaluate(() => {
		const w = window as unknown as Record<string, unknown>;
		Object.assign(HTMLTextAreaElement.prototype, w.__textarea);
		document.getSelection()?.removeAllRanges();
	});
	// The agent's turn runs on the page's timers.
	await page.clock.resume();

	// An agent answer in the thread's conversation.
	const again = thread;
	await again.getByTestId("thread-agent-button").click();
	const panel = again.getByTestId("thread-agent-panel");
	await expect(panel).toHaveAttribute("data-open", "true");
	await again
		.getByRole("textbox", { name: "Ask agent" })
		.fill("Does it add everything?");
	await again.getByRole("button", { name: "Send to agent" }).click();
	const answer = panel.getByTestId("agent-message-ai");
	await expect(answer).toHaveText("Yes: it adds v1 and v2.");
	await pause(page);
	await longPress(page, answer);
	await menu(page).getByRole("menuitem", { name: "Copy message" }).click();
	await expect.poll(() => clipboard(page)).toBe(ANSWER);

	// Select text: the word under the finger selected, for the phone's own handles.
	await page.clock.fastForward(COPIED_MS);
	const question = panel.getByTestId("agent-message-human");
	await longPress(page, question);
	await menu(page).getByRole("menuitem", { name: "Select text" }).click();
	await expect(menu(page)).toHaveCount(0);
	expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(
		"Does",
	);
});

test("with a mouse, holding the button on a comment opens nothing", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	test.skip(isMobile, "desktop only");
	await setup(pr);
	const s = await agentCrb({ spawn: false });
	await installClock(page);
	const thread = await filesThread(page, s.url);
	const comment = thread.getByTestId("thread-comment-body").first();
	const box = await comment.boundingBox();
	if (!box) throw new Error("no box");
	await pause(page);
	await page.mouse.move(box.x + 20, box.y + box.height / 2);
	await page.mouse.down();
	await page.clock.fastForward(LONG_PRESS_MS * 2);
	await page.mouse.up();
	await expect(menu(page)).toHaveCount(0);
});

test("on touch, a selection begun in a thread card stays out of the code lines (the diff never scrolls sideways under it)", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "touch only");
	await setup(pr);
	const s = await agentCrb({ spawn: false });
	const thread = await filesThread(page, s.url);
	const comment = thread.getByTestId("thread-comment-body").first();
	const section = page.locator(`[data-path="${CALC}"]`);
	const table = section.locator("table[data-view]");
	const code = row(section, 4).getByTestId("code");
	await expect(code).toHaveCSS("user-select", "auto");
	// A selection in the comment.
	await comment.evaluate((el) => {
		const text = el.querySelector("p")?.firstChild;
		if (!text) throw new Error("no text");
		document.getSelection()?.setBaseAndExtent(text, 0, text, 2);
	});
	await expect(table).toHaveAttribute("data-card-selecting", "");
	await expect(code).toHaveCSS("user-select", "none");
	await expect(comment).not.toHaveCSS("user-select", "none");
	// A drag from the comment down into the lines selects no code.
	const from = await comment.boundingBox();
	const to = await row(section, 5).getByTestId("code").boundingBox();
	if (!from || !to) throw new Error("no box");
	await page.evaluate(() => document.getSelection()?.removeAllRanges());
	await page.mouse.move(from.x + 10, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(from.x + 40, from.y + from.height / 2, { steps: 4 });
	await page.mouse.move(to.x + to.width - 4, to.y + to.height / 2, {
		steps: 8,
	});
	await page.mouse.up();
	const selected = await page.evaluate(() =>
		document.getSelection()?.toString(),
	);
	expect(selected).not.toContain("export const");
	// Gone with the selection.
	await page.evaluate(() => document.getSelection()?.removeAllRanges());
	await expect(table).not.toHaveAttribute("data-card-selecting");
	await expect(code).toHaveCSS("user-select", "auto");
});
