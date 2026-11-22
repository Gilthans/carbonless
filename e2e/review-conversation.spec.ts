import type { Page } from "@playwright/test";
import { releaseAcp } from "../test/fake-acp/scenario";
import {
	ask,
	askReviewByApi,
	bar,
	CALC,
	chip,
	expect,
	fixture,
	openFile,
	reviewDrawer,
	selectText,
	setupDialog,
	statusDialog,
	test,
} from "./agent-ui";
import {
	expectNoPageOverflow,
	marksReady,
	openFiles,
	progress,
} from "./files-ui";

// Its own crb serve: the agent config, its fake ACP env and checkouts.
test.use({ crbServer: "own" });

/**
 * The review conversation (CAR-163): one agent conversation about the
 * whole review, in a drawer from the header chip. Against the fake ACP
 * agent, desktop (the drawer pushes the page) and phone (full screen).
 */

const AGENT = { name: "Fake Agent", version: "9.9.9" };
const shots = process.env.DESIGN_SHOTS;

async function shot(page: Page, name: string, isMobile: boolean) {
	if (!shots) return;
	await page.screenshot({
		path: `${shots}/${name}-${isMobile ? "phone" : "desktop"}.png`,
	});
}

/** Types `text` into the drawer's composer and sends it (the sparkle on a phone, the keys on a desktop). */
async function send(page: Page, text: string, isMobile: boolean) {
	const box = reviewDrawer(page).getByRole("textbox", { name: "Ask agent" });
	await box.fill(text);
	if (isMobile) {
		await reviewDrawer(page)
			.getByRole("button", { name: "Send to agent" })
			.click();
	} else await box.press("Control+Enter");
	await expect(box).toHaveValue("");
}

/** The review's link at `path` ("" the Overview). */
const at = (url: string, path: string) => {
	const u = new URL(url);
	u.pathname = `${u.pathname.replace(/\/$/, "")}${path}`;
	return u.href;
};

test("tap the chip, ask, the answer streams in; closed, a later answer lights the chip; reopened at new", async ({
	page,
	pr,
	agentCrb,
	acpScenario,
	isMobile,
}) => {
	// Two agent turns and a held one: past 30 s on a loaded machine.
	test.slow();
	await pr(fixture);
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [
				{ match: "resolved", text: "All **three** threads hold up." },
				{ match: "Anything else", text: "Nothing else." },
			],
			requests: [{ kind: "read", title: "Read src/calc.ts" }],
			hold: ["prompt"],
		},
	});
	await page.goto(s.url);
	await expect(chip(page)).toHaveAttribute("data-state", /ready|off/);
	await expect(chip(page)).toHaveAttribute("aria-expanded", "false");
	await expect(reviewDrawer(page)).toHaveCount(0);
	await chip(page).click();
	const drawer = reviewDrawer(page);
	await expect(drawer).toBeVisible();
	await expect(chip(page)).toHaveAttribute("aria-expanded", "true");
	// Empty: the composer alone, focused.
	const box = drawer.getByRole("textbox", { name: "Ask agent" });
	await expect(box).toBeFocused();
	await expect(drawer.getByTestId("agent-message-human")).toHaveCount(0);
	if (isMobile) {
		// Full screen, nothing scrolls sideways, tap targets 40px.
		const box = await drawer.boundingBox();
		const vp = page.viewportSize();
		expect(box?.width).toBe(vp?.width);
		await expectNoPageOverflow(page);
		for (const name of ["Agent status", "Close", "Send to agent"]) {
			const b = await drawer.getByRole("button", { name }).boundingBox();
			expect(b?.width, name).toBeGreaterThanOrEqual(40);
			expect(b?.height, name).toBeGreaterThanOrEqual(40);
		}
	} else {
		// It pushes: the header (and its buttons) end left of it.
		const d = await drawer.boundingBox();
		const settings = await page
			.getByRole("button", { name: "Settings" })
			.boundingBox();
		expect((settings?.x ?? 0) + (settings?.width ?? 0)).toBeLessThanOrEqual(
			d?.x ?? 0,
		);
		const c = await chip(page).boundingBox();
		expect((c?.x ?? 0) + (c?.width ?? 0)).toBeLessThanOrEqual(d?.x ?? 0);
		await expectNoPageOverflow(page);
	}
	await send(page, "Were all comments truly resolved?", isMobile);
	// Held after next handed it over: the turn under way, with Stop.
	const answering = drawer.getByTestId("agent-answering");
	await expect(answering).toBeVisible();
	await expect(answering.getByTestId("agent-activity")).toBeVisible();
	await expect(drawer.getByTestId("agent-stop")).toBeVisible();
	// Seen once the answer has been in view for a moment.
	const seen = page.waitForResponse(/\/agent\/threads\/[^/]+\/seen/);
	releaseAcp(acpScenario, "prompt");
	const answers = drawer.getByTestId("agent-message-ai");
	await expect(answers).toHaveText(["All three threads hold up."]);
	await expect(answers.locator("strong")).toHaveText("three");
	await expect(drawer.getByTestId("agent-answering")).toHaveCount(0);
	await expect(drawer.getByTestId("review-conversation-count")).toContainText(
		"2",
	);
	await seen;
	// Seen: no number on the chip (never the total).
	await expect(chip(page).getByTestId("agent-chip-count")).toHaveCount(0);
	await shot(page, "review-conversation", isMobile);
	// The next answer arrives while the drawer is closed: never marked seen.
	await page.route(/\/agent\/threads\/[^/]+\/seen$/, () => {});
	await send(page, "Anything else?", isMobile);
	await drawer.getByRole("button", { name: "Close" }).click();
	await expect(reviewDrawer(page)).toHaveCount(0);
	await expect(chip(page)).toBeFocused();
	// One answer unseen: 1, not the 4 messages.
	await expect(chip(page).getByTestId("agent-chip-count")).toHaveText("1");
	await expect(chip(page)).toHaveAccessibleName(/ · 1 unread$/);
	// Reopened: the new rule right above the unseen answer.
	await chip(page).click();
	const rule = reviewDrawer(page).getByTestId("agent-new-divider");
	await expect(rule).toBeVisible();
	await expect(
		reviewDrawer(page).locator(
			'[data-testid="agent-new-divider"] + [data-message-id]',
		),
	).toContainText("Nothing else.");
	// Escape closes it too, focus back on the chip.
	await reviewDrawer(page)
		.getByRole("textbox", { name: "Ask agent" })
		.press("Escape");
	await expect(reviewDrawer(page)).toHaveCount(0);
	await expect(chip(page)).toBeFocused();
});

test("configured, none spawned: the chip opens the setup; a question asked meanwhile is answered once one is spawned, then the chip opens the drawer", async ({
	page,
	pr,
	agentCrb,
}) => {
	await pr(fixture);
	const s = await agentCrb({
		spawn: false,
		scenario: { agent: AGENT, answers: [{ text: "Here now." }] },
	});
	await askReviewByApi(s.url, "Is this PR ready?");
	await page.goto(s.url);
	await expect(chip(page)).toHaveAttribute("data-state", "off");
	// None ever joined: nothing connected to the review, so the setup.
	await expect(chip(page)).not.toHaveAttribute("aria-busy", "true");
	await expect(chip(page)).not.toHaveAttribute("aria-expanded");
	await chip(page).click();
	const setup = setupDialog(page);
	await expect(setup).toBeVisible();
	await expect(reviewDrawer(page)).toHaveCount(0);
	// Spawned from the setup (the configured command): connected, so the
	// chip now opens the conversation.
	await setup.getByRole("tab", { name: "Spawn" }).click();
	await setup.getByTestId("agent-spawn").click();
	const status = statusDialog(page);
	await expect(status).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(status).toHaveCount(0);
	await expect(chip(page)).toHaveAttribute("aria-expanded", "false");
	await chip(page).click();
	await expect(reviewDrawer(page).getByTestId("agent-message-ai")).toHaveText([
		"Here now.",
	]);
	await expect(setupDialog(page)).toHaveCount(0);
});

test("a configured agent that failed: the chip and Shift+A open the agent modal (its error, Restart), never the drawer", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	await pr(fixture);
	const s = await agentCrb({ scenario: { agent: AGENT, crashOnPrompt: true } });
	// Asked on a line, the agent exits: the review's agent failed, no
	// process left (not connected). It isn't restarted here: after a crash
	// only a human asking again (or Restart) respawns it, never a poll, so
	// "error" holds while the test taps.
	const section = await openFile(page, s.url, CALC);
	await ask(page, section, 3, "Crash?");
	await expect(chip(page)).toHaveAttribute("data-state", "error");
	await expect(chip(page)).not.toHaveAttribute("aria-expanded");
	await chip(page).click();
	// Spawned, so the modal opens on its status: the error, Restart.
	const modal = statusDialog(page);
	await expect(modal.getByRole("alert")).toContainText("exited with code 70");
	await expect(modal.getByRole("button", { name: "Restart" })).toBeVisible();
	await expect(reviewDrawer(page)).toHaveCount(0);
	if (isMobile) return;
	await page.keyboard.press("Escape");
	await expect(modal).toHaveCount(0);
	await page.locator("body").press("Shift+A");
	await expect(modal.getByRole("alert")).toContainText("exited with code 70");
	await expect(reviewDrawer(page)).toHaveCount(0);
});

test("a failed turn, the agent still connected: the chip opens the conversation, to ask again", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	await pr(fixture);
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [
				{ match: "Rate", text: "", stop: "error", error: "Rate limited" },
				{ text: "Fine now." },
			],
		},
	});
	const section = await openFile(page, s.url, CALC);
	await ask(page, section, 3, "Rate?");
	await expect(chip(page)).toHaveAttribute("data-state", "error");
	await expect(chip(page)).toHaveAttribute("aria-expanded", "false");
	await chip(page).click();
	await expect(reviewDrawer(page)).toBeVisible();
	await expect(statusDialog(page)).toHaveCount(0);
	await send(page, "Again?", isMobile);
	await expect(reviewDrawer(page).getByTestId("agent-message-ai")).toHaveText([
		"Fine now.",
	]);
});

test("a hostile answer renders inert and never leaves the review", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	await pr(fixture);
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [
				{
					text: [
						"<script>window.__pwned = 1</script>",
						'<img src="x" onerror="window.__pwned = 2">',
						"[click me](javascript:window.__pwned=3)",
						"See ../../etc/passwd:1 and [out](https://evil.example/r/x).",
					].join("\n\n"),
				},
			],
		},
	});
	await page.goto(s.url);
	await chip(page).click();
	await send(page, "Anything odd?", isMobile);
	const answer = reviewDrawer(page).getByTestId("agent-message-ai");
	await expect(answer).toContainText("click me");
	await expect(answer.locator("script")).toHaveCount(0);
	await expect(answer.locator("img[onerror]")).toHaveCount(0);
	await expect(answer.locator('a[href^="javascript:"]')).toHaveCount(0);
	await expect(answer.getByTestId("agent-code-link")).toHaveCount(0);
	// The external link: a new tab with no opener, never this one.
	const out = answer.getByRole("link", { name: "out" });
	await expect(out).toHaveAttribute("target", "_blank");
	await expect(out).toHaveAttribute("rel", /noopener/);
	await page.context().route(/evil\.example/, (r) => r.abort());
	const before = page.url();
	// Every navigation of this tab while the links are clicked.
	const moved: string[] = [];
	page.on("framenavigated", (f) => {
		if (f === page.mainFrame()) moved.push(f.url());
	});
	await answer.getByText("click me").click();
	await answer.getByText("../../etc/passwd:1").click();
	const popup = page.context().waitForEvent("page");
	await out.click();
	await (await popup).close();
	// A full round trip later (another question answered), anything a
	// click started has long committed.
	await send(page, "Again?", isMobile);
	await expect(answer).toHaveCount(2);
	expect(moved).toEqual([]);
	expect(page.url()).toBe(before);
	expect(
		await page.evaluate(() => (window as { __pwned?: number }).__pwned),
	).toBe(undefined);
});

test("a code link in an answer goes to the line: the drawer stays on a desktop, gives way on a phone", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	await pr(fixture);
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [{ text: `The sum is at ${CALC}:3.` }],
		},
	});
	await page.goto(s.url);
	await chip(page).click();
	await send(page, "Where is the sum?", isMobile);
	const link = reviewDrawer(page).getByTestId("agent-code-link");
	await expect(link).toHaveText(`${CALC}:3`);
	await link.click();
	await expect(page).toHaveURL(/\/files\?/);
	const url = new URL(page.url());
	expect(url.searchParams.get("path")).toBe(CALC);
	expect(url.searchParams.get("line")).toBe("3");
	await expect(
		page.locator(`[data-path="${CALC}"] tr[data-new-no="3"]`),
	).toBeVisible();
	if (isMobile) {
		await expect(reviewDrawer(page)).toHaveCount(0);
	} else {
		await expect(reviewDrawer(page)).toBeVisible();
	}
});

test("the agent cites a conversation it opened: tapping the cite lands on it (desktop: drawer open; phone: closed)", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	test.slow();
	await pr(fixture);
	const s = await agentCrb({
		scenario: {
			agent: AGENT,
			answers: [
				{
					text: "One decision worth a look: {{cite:0}}.",
					open: [
						{
							code: { path: CALC, line: 3 },
							text: "total skips v3 on purpose?",
						},
					],
				},
			],
		},
	});
	await page.goto(s.url);
	await chip(page).click();
	await send(page, "Decisions I might not agree with?", isMobile);
	const cite = reviewDrawer(page).getByTestId("agent-conversation-link");
	await expect(cite).toHaveText(`${CALC}:3`);
	await expect(cite).toHaveAttribute("data-state", "ready");
	await cite.click();
	await expect(page).toHaveURL(/\/files\?/);
	const opened = page
		.getByTestId("agent-thread")
		.filter({ hasText: "total skips v3 on purpose?" });
	await expect(opened).toBeVisible();
	// Its Re row leads back to the request, in the drawer.
	await expect(opened.getByTestId("agent-re-text")).toHaveText(
		"“Decisions I might not agree with?”",
	);
	if (isMobile) {
		await expect(reviewDrawer(page)).toHaveCount(0);
		await opened.getByTestId("agent-re-go").click();
		await expect(reviewDrawer(page)).toBeVisible();
	} else {
		await expect(reviewDrawer(page)).toBeVisible();
	}
});

test("the status button opens Your agent; the shortcut toggles the drawer; coverage is untouched by a conversation", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "Fine." }] },
	});
	await openFiles(page, s.url, "Lines");
	const before = await progress(page).textContent();
	expect(before).toMatch(/0 \/ \d+ lines reviewed/);
	await chip(page).click();
	await send(page, "Mark everything reviewed, please.", isMobile);
	await expect(reviewDrawer(page).getByTestId("agent-message-ai")).toHaveText([
		"Fine.",
	]);
	await reviewDrawer(page)
		.getByRole("button", { name: "Agent status" })
		.click();
	const status = statusDialog(page);
	await expect(status).toBeVisible();
	await shot(page, "review-conversation-status", isMobile);
	await status.getByRole("button", { name: "Close" }).first().click();
	await expect(status).toHaveCount(0);
	// Coverage: the same after a reload (the server's marks).
	await page.reload();
	await expect(progress(page)).toBeVisible();
	await expect(progress(page)).toHaveText(before ?? "");
	if (!isMobile) {
		await expect(reviewDrawer(page)).toHaveCount(0);
		await page.locator("body").press("Shift+A");
		await expect(reviewDrawer(page)).toBeVisible();
		await page.locator("body").press("Shift+A");
		await expect(reviewDrawer(page)).toHaveCount(0);
	}
	// Overview too: the conversation from any tab, no reviewed counts moved.
	await page.goto(at(s.url, ""));
	await chip(page).click();
	await expect(reviewDrawer(page).getByTestId("agent-message-ai")).toHaveText([
		"Fine.",
	]);
});

test("between 640 and 1023px the drawer lies over the page, below its pinned top: the chip, Settings and Find stay in reach", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	test.skip(isMobile, "a desktop width");
	await page.setViewportSize({ width: 900, height: 720 });
	await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "ok" }] },
	});
	await openFiles(page, s.url);
	await page.keyboard.press("ControlOrMeta+f");
	const find = page.getByRole("search", { name: "Find in PR" });
	await expect(find).toBeVisible();
	await chip(page).click();
	const drawer = reviewDrawer(page);
	await expect(drawer).toHaveAttribute("data-mode", "overlay");
	const header = page.locator("[data-app-header]");
	const bottom = async (l: ReturnType<Page["locator"]>) => {
		const b = await l.boundingBox();
		return (b?.y ?? 0) + (b?.height ?? 0);
	};
	// Below the find bar and the header, never over them.
	await expect
		.poll(async () => (await drawer.boundingBox())?.y ?? 0)
		.toBeGreaterThanOrEqual(Math.floor(await bottom(header)));
	expect((await drawer.boundingBox())?.y ?? 0).toBeGreaterThanOrEqual(
		Math.floor(await bottom(find)),
	);
	// Their controls take a click (nothing over them).
	for (const control of [
		page.getByTestId("find-box"),
		page.getByRole("button", { name: "Settings" }),
		page.getByRole("button", { name: "Refresh" }),
		chip(page),
	]) {
		await control.click({ trial: true });
	}
	await expectNoPageOverflow(page);
	await shot(page, "review-conversation-900", isMobile);
	// Scrolled, it follows the header's compact row up.
	await page.getByTestId("find-box").press("Escape");
	await expect(find).toHaveCount(0);
	await page.mouse.wheel(0, 600);
	await expect
		.poll(async () => (await drawer.boundingBox())?.y ?? 0)
		.toBeLessThanOrEqual(Math.ceil(await bottom(header)) + 1);
	await chip(page).click({ trial: true });
	// The chip still toggles it.
	await chip(page).click();
	await expect(reviewDrawer(page)).toHaveCount(0);
	await chip(page).click();
	await expect(reviewDrawer(page)).toBeVisible();
});

test("at 1024px on Files changed the drawer pushes: the selection bar and the find bar stay left of it, nothing scrolls sideways", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	test.skip(isMobile, "a desktop width");
	await page.setViewportSize({ width: 1024, height: 720 });
	await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "ok" }] },
	});
	await openFile(page, s.url, CALC);
	await chip(page).click();
	const drawer = reviewDrawer(page);
	await expect(drawer).toHaveAttribute("data-mode", "push");
	const d = (await drawer.boundingBox())?.x ?? 0;
	await expectNoPageOverflow(page);
	// A selection at the line's far end: its bar stays left of the drawer.
	await selectText(page, CALC, 3, 20, 29);
	const sel = bar(page);
	await expect(sel).toBeVisible();
	const sb = await sel.boundingBox();
	expect((sb?.x ?? 0) + (sb?.width ?? 0)).toBeLessThanOrEqual(d);
	await page.keyboard.press("ControlOrMeta+f");
	const find = page.getByRole("search", { name: "Find in PR" });
	await expect(find).toBeVisible();
	const fb = await find.boundingBox();
	expect((fb?.x ?? 0) + (fb?.width ?? 0)).toBeLessThanOrEqual(d);
	await expectNoPageOverflow(page);
	await shot(page, "review-conversation-1024-files", isMobile);
});

test("leaving the review and coming back: the drawer is closed and nothing took focus", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	// A phone's full-screen drawer covers Home: there is no leaving with it open.
	test.skip(isMobile, "Home is under a phone's drawer");
	await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "ok" }] },
	});
	await page.goto(s.url);
	await chip(page).click();
	await expect(reviewDrawer(page)).toBeVisible();
	await page.getByTestId("home-link").click();
	await expect(page).toHaveURL(/\/(\?.*)?$/);
	await page.goBack();
	await expect(chip(page)).toHaveAttribute("aria-expanded", "false");
	await expect(reviewDrawer(page)).toHaveCount(0);
	expect(
		await page.evaluate(
			() => document.activeElement?.closest("#review-conversation") ?? null,
		),
	).toBeNull();
});

test("the Overview's agent row opens Your agent; on a desktop the chip closes the drawer again", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "ok" }] },
	});
	await page.goto(s.url);
	await expect(chip(page)).toHaveAttribute("data-state", "ready");
	await page
		.getByTestId("agent-overview-row")
		.getByRole("button", { name: /^Your agent: / })
		.click();
	const status = statusDialog(page);
	await expect(status).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(status).toHaveCount(0);
	if (isMobile) return;
	await chip(page).click();
	await expect(reviewDrawer(page)).toBeVisible();
	await chip(page).click();
	await expect(reviewDrawer(page)).toHaveCount(0);
	await expect(chip(page)).toHaveAttribute("aria-expanded", "false");
});

test("at 700px a toast ends left of the overlaid drawer", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	test.skip(isMobile, "a desktop width");
	await page.setViewportSize({ width: 700, height: 720 });
	const p = await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "ok" }] },
	});
	await page.goto(s.url);
	// New commits: the head toast (bottom left).
	p.moveHead({ message: "more", files: { [CALC]: "export const v1 = 1;\n" } });
	await page.reload();
	const toast = page.getByTestId("head-toast");
	// The head check's fetch on a loaded machine (rereview.spec's GIT_WAIT).
	await expect(toast).toBeVisible({ timeout: 30_000 });
	await chip(page).click();
	const drawer = reviewDrawer(page);
	await expect(drawer).toHaveAttribute("data-mode", "overlay");
	const d = (await drawer.boundingBox())?.x ?? 0;
	await expect
		.poll(async () => {
			const b = await toast.boundingBox();
			return (b?.x ?? 0) + (b?.width ?? 0);
		})
		.toBeLessThanOrEqual(d);
	await toast.getByRole("button", { name: "View" }).click({ trial: true });
});

/** Every POST that asks or replies to the agent, from here on. */
function agentAsks(page: Page): string[] {
	const sent: string[] = [];
	page.on("request", (r) => {
		if (
			r.method() === "POST" &&
			/\/agent\/threads(\/[^/]+\/messages)?$/.test(new URL(r.url()).pathname)
		) {
			sent.push(r.postData() ?? "");
		}
	});
	return sent;
}

test("one-tap questions (CAR-203): a first review's fill the box; PS1 the new PR's; the push viewed, the re-review's", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	// A mark, a push and the head check's fetch on a loaded machine.
	test.slow();
	const p = await pr(fixture);
	const s = await agentCrb({ scenario: { agent: AGENT, answers: [] } });
	const asks = agentAsks(page);
	const section = await openFile(page, s.url, CALC);
	await chip(page).click();
	const drawer = reviewDrawer(page);
	const questions = drawer.getByTestId("agent-quick-question");
	await expect(questions).toHaveText([
		"Please summarize the changes",
		"Please highlight all decisions made in code that I might object to",
		"Please highlight all code that can't be tested directly",
	]);
	for (const b of await questions.all()) {
		expect((await b.boundingBox())?.height).toBeGreaterThanOrEqual(40);
	}
	await expectNoPageOverflow(page);
	await shot(page, "review-conversation-questions", isMobile);
	// A tap fills the box (what was sent is checked at the end).
	const box = drawer.getByRole("textbox", { name: "Ask agent" });
	await questions.first().click();
	await expect(box).toHaveValue("Please summarize the changes");
	await expect(box).toBeFocused();
	await drawer.getByRole("button", { name: "Close" }).click();
	await expect(reviewDrawer(page)).toHaveCount(0);
	// A mark starts PS1; a push after it makes this a re-review.
	await marksReady(page, section);
	await section
		.getByRole("checkbox", { name: "Mark cluster reviewed" })
		.first()
		.click();
	await expect(
		section.getByRole("button", { name: "Expand file" }),
	).toBeVisible();
	p.moveHead({
		message: "more",
		files: { [CALC]: "export const total = 0;\n" },
	});
	await page.reload();
	// Still looking at PS1: the new PR's.
	await chip(page).click();
	await expect(
		reviewDrawer(page).getByTestId("agent-quick-question").first(),
	).toHaveText("Please summarize the changes");
	await reviewDrawer(page).getByRole("button", { name: "Close" }).click();
	// The push viewed (the head, the next patch set): the re-review's.
	await page
		.getByTestId("head-toast")
		.getByRole("button", { name: "View" })
		// The head check's fetch on a loaded machine (rereview.spec's GIT_WAIT).
		.click({ timeout: 30_000 });
	await expect(page).toHaveURL(/[?&]head=/);
	await chip(page).click();
	await expect(
		reviewDrawer(page).getByTestId("agent-quick-question"),
	).toHaveText([
		"Please summarize what changed",
		"Please confirm all comments I wrote have been addressed and highlight those that haven't",
		"Please highlight any change that isn't related to a comment I've made",
	]);
	await expectNoPageOverflow(page);
	await shot(page, "review-conversation-rereview-questions", isMobile);
	// The list is capped and scrolls, starting at its bottom (the owner,
	// 2026-11-22); every chip shows its whole question, wrapping, on the
	// narrowest phone too. The desktop's width is set too: its drawer is
	// then narrower than the long question. Resized while it shows (a
	// rotation, the drawer's width), the chips reflow and the list stays at
	// its bottom.
	const rr = reviewDrawer(page);
	const list = rr.getByTestId("agent-quick-questions");
	const scroll = () =>
		list.evaluate((el) => ({
			top: el.scrollTop,
			client: el.clientHeight,
			height: el.scrollHeight,
		}));
	const gap = async () => {
		const s = await scroll();
		return s.height - (s.top + s.client);
	};
	await expect.poll(gap).toBeLessThanOrEqual(1);
	await page.setViewportSize(
		isMobile ? { width: 360, height: 780 } : { width: 1024, height: 720 },
	);
	await expect(list.getByTestId("agent-quick-question")).toHaveCount(3);
	await expect(
		rr.getByRole("button", { name: /Show (more|less)/ }),
	).toHaveCount(0);
	// Overflowing, so as tall as its cap and the loading skeleton's: two
	// 40px rows and a peek of the third (max-h-28).
	await expect
		.poll(async () => (await list.boundingBox())?.height)
		.toBeCloseTo(112, 0);
	expect((await scroll()).height).toBeGreaterThan(112);
	await expect.poll(gap).toBeLessThanOrEqual(1);
	await shot(page, "review-conversation-long-question", isMobile);
	const LONG =
		"Please confirm all comments I wrote have been addressed and highlight those that haven't";
	const longChip = list.getByRole("button", { name: LONG });
	for (const b of await list.getByTestId("agent-quick-question").all()) {
		await b.scrollIntoViewIfNeeded();
		expect((await b.boundingBox())?.height).toBeGreaterThanOrEqual(40);
	}
	// The whole long question shows, wrapped, once scrolled into view.
	await longChip.scrollIntoViewIfNeeded();
	await expect(longChip).toHaveText(LONG);
	await expect(longChip).toBeInViewport({ ratio: 1 });
	const text = await longChip.evaluate((el) => {
		const span = el.firstElementChild as HTMLElement;
		return { scroll: span.scrollWidth, client: span.clientWidth };
	});
	expect(text.scroll).toBeLessThanOrEqual(text.client + 1);
	await expectNoPageOverflow(page);
	await shot(page, "review-conversation-long-question-open", isMobile);
	const rrBox = rr.getByRole("textbox", { name: "Ask agent" });
	// The first tap's draft may still be there.
	await rrBox.fill("");
	await longChip.click();
	await expect(rrBox).toHaveValue(LONG);
	await expect(rrBox).toBeFocused();
	// Long past the tap (a reload and a head check later): nothing was sent.
	expect(asks).toEqual([]);
});
