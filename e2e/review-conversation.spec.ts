import type { Page } from "@playwright/test";
import { releaseAcp } from "../test/fake-acp/scenario";
import {
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
	spawnAgent,
	statusDialog,
	test,
} from "./agent-ui";
import { expectNoPageOverflow, openFiles, progress } from "./files-ui";

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

test("no agent attached: the drawer still opens, the question waits, and is answered once one is spawned", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	await pr(fixture);
	const s = await agentCrb({
		spawn: false,
		scenario: { agent: AGENT, answers: [{ text: "Here now." }] },
	});
	await page.goto(s.url);
	await expect(chip(page)).toHaveAttribute("data-state", "off");
	await chip(page).click();
	await send(page, "Is this PR ready?", isMobile);
	const drawer = reviewDrawer(page);
	const waiting = drawer.getByTestId("agent-waiting");
	await expect(waiting).toBeVisible();
	await expect(waiting).toContainText("Spawn or invite an agent");
	await spawnAgent(s.url);
	await expect(drawer.getByTestId("agent-message-ai")).toHaveText([
		"Here now.",
	]);
	await expect(drawer.getByTestId("agent-waiting")).toHaveCount(0);
});

test("no agent, a review conversation already there: the chip and Shift+A open the setup, never the drawer", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	await pr(fixture);
	const s = await agentCrb({ configured: false });
	await askReviewByApi(s.url, "What is the risk in this PR?");
	await page.goto(s.url);
	await expect(chip(page)).toHaveAttribute("data-state", "off");
	await chip(page).click();
	await expect(setupDialog(page)).toBeVisible();
	await expect(reviewDrawer(page)).toHaveCount(0);
	if (isMobile) return;
	await page.keyboard.press("Escape");
	await expect(setupDialog(page)).toHaveCount(0);
	await page.locator("body").press("Shift+A");
	await expect(setupDialog(page)).toBeVisible();
	await expect(reviewDrawer(page)).toHaveCount(0);
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
