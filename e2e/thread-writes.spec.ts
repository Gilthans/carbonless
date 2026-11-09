import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { FADE_MS } from "../src/web/threads/threadWrites";
import {
	release,
	reviewThread,
	type Scenario,
	threadComment,
} from "../test/fake-gh/scenario";
import {
	expectNoPageOverflow,
	fileSection,
	openFiles,
	sideBySide,
} from "./files-ui";
import { expect, type Pr, type PrOptions, test } from "./fixtures";

/**
 * Replying and resolving, written to the fake gh (its writes persist in the
 * scenario file, so a reload reads them back). The viewer is Octo_Cat.
 * Two open threads on new.txt (line 1) and a.txt (line 2), by rev1, no
 * replies yet.
 */
const base = "2026-01-01T00:00:00Z";
const fixture: PrOptions = {
	baseDate: base,
	files: [
		{
			message: "PR change",
			files: {
				"a.txt": `${Array.from({ length: 30 }, (_, i) =>
					i === 1 ? "line 2 changed" : `line ${i + 1}`,
				).join("\n")}\n`,
				"new.txt": "new\n",
			},
			date: "2026-01-02T00:00:00Z",
		},
	],
};

async function setup(
	pr: (opts?: PrOptions) => Promise<Pr>,
	scenario: Partial<Scenario> = {},
	reviews: unknown[] = [],
) {
	const p = await pr(fixture);
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((s) => {
		const graph = s.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: "new.txt", line: 1, subjectType: "LINE" }, [
				threadComment({
					login: "rev1",
					text: "Why new?",
					createdAt: "2026-01-02T09:00:00Z",
					commit: head,
					diffHunk: "@@ -0,0 +1 @@\n+new",
				}),
			]),
			reviewThread({ path: "a.txt", line: 2, subjectType: "LINE" }, [
				threadComment({
					login: "rev1",
					text: "Changed how?",
					createdAt: "2026-01-02T08:00:00Z",
					commit: head,
					diffHunk: "@@ -1,2 +1,2 @@\n line 1\n-line 2\n+line 2 changed",
				}),
			]),
		];
		graph.reviews = reviews;
		Object.assign(s, scenario);
	});
	return p;
}

/** Replies to the thread in the fake gh's store, by text. */
function storedReplies(p: Pr, text: string): number {
	const s = JSON.parse(readFileSync(p.scenarioPath, "utf8")) as Scenario;
	const threads = (s.prs[7]?.graphql?.reviewThreads ?? []) as {
		comments: { nodes: { body?: string; bodyText?: string }[] };
	}[];
	return threads
		.flatMap((t) => t.comments.nodes)
		.filter((c) => (c.body ?? c.bodyText) === text).length;
}

/** Whether the fake gh has the thread on `path` resolved. */
function storedResolved(p: Pr, path: string): boolean | undefined {
	const s = JSON.parse(readFileSync(p.scenarioPath, "utf8")) as Scenario;
	const threads = (s.prs[7]?.graphql?.reviewThreads ?? []) as {
		path: string;
		isResolved: boolean;
	}[];
	return threads.find((t) => t.path === path)?.isResolved;
}

const humans = (page: Page) =>
	page.getByRole("region", { name: "Human reviews" });
const card = (page: Page, path: string) =>
	humans(page).getByTestId("thread").filter({ hasText: path });

/** Opens a card's one "Show more": its replies, reply box and Resolve. */
async function openCard(c: Locator) {
	const more = c.getByTestId("thread-more");
	if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
	await expect(more).toHaveAttribute("aria-expanded", "true");
}

/** Opens a card and gives its reply box. */
async function openReply(c: Locator) {
	await openCard(c);
	const box = c.getByRole("textbox", { name: "Reply" });
	await expect(box).toBeVisible();
	return box;
}

/** a.txt's new line 2, where its thread is. */
const line2 = (section: Locator) =>
	section.locator('tr[data-testid="diff-line"][data-new-no="2"]');

const send = (scope: Locator) =>
	scope.getByTestId("reply-box").getByRole("button", { name: "Reply" });

test("reply from an Overview card: shown at once, still there after a reload", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	// GitHub answers the reply once the test has seen it sending.
	const p = await setup(pr, { hold: ["reply"] });
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "new.txt");
	const box = await openReply(c);
	// One line until focused, then it grows.
	const closed = (await box.boundingBox())?.height ?? 0;
	await box.click();
	await box.fill("Kept on purpose");
	expect((await box.boundingBox())?.height ?? 0).toBeGreaterThan(closed);
	expect((await send(c).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
	await box.press("Control+Enter");
	await expect(box).toHaveValue("");
	const sending = c.getByTestId("thread-comment-sending");
	await expect(sending).toContainText("Kept on purpose");
	await expect(sending.getByRole("img", { name: "Sending" })).toBeVisible();
	release(p.scenarioPath, "reply");
	// GitHub's answer replaces it.
	await expect(sending).toHaveCount(0);
	await expect(
		c.getByTestId("thread-comment").filter({ hasText: "Kept on purpose" }),
	).toHaveCount(1);
	await expect(c.getByRole("img", { name: "2 comments" })).toBeVisible();
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await c.scrollIntoViewIfNeeded();
		await page.screenshot({
			path: `${shots}/thread-reply-${isMobile ? "phone" : "desktop"}.png`,
		});
	}
	await page.reload();
	const again = card(page, "new.txt");
	await expect(again.getByRole("img", { name: "2 comments" })).toBeVisible();
	await again.getByRole("button", { name: "Show more, 1 reply" }).click();
	await expect(
		again.getByTestId("thread-comment").filter({ hasText: "Kept on purpose" }),
	).toHaveCount(1);
	expect(storedReplies(p, "Kept on purpose")).toBe(1);
});

test("a short card's toggle says Reply; on a phone the closed box and Resolve share a line", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await setup(pr);
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "new.txt");
	const more = c.getByTestId("thread-more");
	// Nothing more to read: it opens only to the box and Resolve.
	await expect(more).toHaveAccessibleName("Reply");
	// Centred in the card, 40px tall.
	const cardBox = await c.boundingBox();
	const moreBox = await more.boundingBox();
	if (!cardBox || !moreBox) throw new Error("not laid out");
	expect(
		Math.abs(moreBox.x + moreBox.width / 2 - (cardBox.x + cardBox.width / 2)),
	).toBeLessThanOrEqual(2);
	expect(moreBox.height).toBeGreaterThanOrEqual(40);
	await more.click();
	await expect(more).toHaveAccessibleName("Hide");
	const box = c.getByRole("textbox", { name: "Reply" });
	const resolve = c.getByRole("button", { name: "Resolve", exact: true });
	const rect = async (l: Locator) => {
		const b = await l.boundingBox();
		if (!b) throw new Error("not laid out");
		return b;
	};
	// Closed and empty: one line, Resolve beside it (desktop and phone).
	let b = await rect(box);
	let r = await rect(resolve);
	expect(r.x).toBeGreaterThanOrEqual(b.x + b.width);
	expect(Math.abs(r.y + r.height - (b.y + b.height))).toBeLessThanOrEqual(2);
	expect(r.height).toBeGreaterThanOrEqual(40);
	expect((await rect(send(c))).height).toBeGreaterThanOrEqual(40);
	const overflow = () =>
		page.evaluate(
			() => document.documentElement.scrollWidth - window.innerWidth,
		);
	expect(await overflow()).toBeLessThanOrEqual(0);
	// Focused: on a phone the box takes the width and Resolve goes below;
	// on a desktop it stays beside.
	await box.click();
	await box.fill("Thinking");
	b = await rect(box);
	r = await rect(resolve);
	if (isMobile) {
		expect(r.y).toBeGreaterThanOrEqual(b.y + b.height);
	} else {
		expect(r.x).toBeGreaterThanOrEqual(b.x + b.width);
	}
	expect(r.height).toBeGreaterThanOrEqual(40);
	expect(await overflow()).toBeLessThanOrEqual(0);
	// A draft keeps it open, focused or not.
	await box.press("Escape");
	expect((await rect(resolve)).y).toBe(r.y);
});

test("reply and resolve from Files changed", async ({ page, pr, startCrb }) => {
	const p = await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, "a.txt");
	await section.getByRole("button", { name: "Expand file" }).click();
	const bubble = line2(section).getByRole("button", {
		name: /^1 comment on line 2/,
	});
	await bubble.click();
	const thread = section.getByTestId("files-thread");
	const box = thread.getByRole("textbox", { name: "Reply" });
	await box.fill("From the diff");
	await send(thread).click();
	await expect(
		thread.getByTestId("thread-comment").filter({ hasText: "From the diff" }),
	).toHaveCount(1);
	await thread.getByRole("button", { name: "Resolve" }).click();
	// Closed down to its bubble, which says resolved and has the focus.
	await expect(thread).toHaveCount(0);
	const resolvedBubble = section.getByRole("button", {
		name: /^2 comments on line 2, resolved/,
	});
	await expect(resolvedBubble).toBeFocused();
	await resolvedBubble.click();
	await expect(thread).toHaveAttribute("aria-label", /^Resolved thread/);
	await expect(thread.getByRole("button", { name: "Unresolve" })).toBeVisible();
	await expect.poll(() => storedReplies(p, "From the diff")).toBe(1);
	// On GitHub before the reload reads it back.
	await expect.poll(() => storedResolved(p, "a.txt")).toBe(true);
	await page.reload();
	await fileSection(page, "a.txt")
		.getByRole("button", { name: "Expand file" })
		.click();
	await expect(
		line2(fileSection(page, "a.txt")).getByRole("button", {
			name: /^2 comments on line 2, resolved/,
		}),
	).toBeVisible();
	// And back.
	await line2(fileSection(page, "a.txt"))
		.getByRole("button", { name: /^2 comments on line 2/ })
		.click();
	await fileSection(page, "a.txt")
		.getByTestId("files-thread")
		.getByRole("button", { name: "Unresolve" })
		.click();
	await expect(
		line2(fileSection(page, "a.txt")).getByRole("button", {
			name: /^2 comments on line 2, resolved/,
		}),
	).toHaveCount(0);
	await expect.poll(() => storedResolved(p, "a.txt")).toBe(false);
	await page.reload();
	await fileSection(page, "a.txt")
		.getByRole("button", { name: "Expand file" })
		.click();
	await expect(
		line2(fileSection(page, "a.txt")).getByRole("button", {
			name: /^2 comments on line 2/,
		}),
	).toBeVisible();
	await expect(
		line2(fileSection(page, "a.txt")).getByRole("button", {
			name: /^2 comments on line 2, resolved/,
		}),
	).toHaveCount(0);
});

for (const view of ["unified", "side-by-side"] as const) {
	test(`Resolve in Files changed closes the thread to its bubble (${view})`, async ({
		page,
		pr,
		startCrb,
		isMobile,
	}) => {
		if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
		// The resolve's read-back waits: closed before GitHub's answer is in.
		const p = await setup(pr, { hold: ["thread"] });
		const s = await startCrb();
		await openFiles(page, s.url);
		if (view === "side-by-side") await sideBySide(page, true);
		const section = fileSection(page, "a.txt");
		await section.getByRole("button", { name: "Expand file" }).click();
		// Side by side on a phone, a row's bubbles sit in a row of their own.
		const bubble = section
			.getByRole("button", { name: /^1 comment on line 2/ })
			.last();
		await bubble.click();
		const thread = section.getByTestId("files-thread");
		await expect(thread).toHaveAttribute("aria-label", /^Unresolved thread/);
		const resolve = thread.getByRole("button", {
			name: "Resolve",
			exact: true,
		});
		// Measured once the click's own scroll (into view) is done.
		await resolve.scrollIntoViewIfNeeded();
		const top = (await bubble.boundingBox())?.y ?? Number.NaN;
		await resolve.click();
		await expect(thread).toHaveCount(0);
		const closed = section
			.getByRole("button", { name: /^1 comment on line 2, resolved/ })
			.last();
		await expect(closed).toHaveAttribute("aria-expanded", "false");
		await expect(closed).toBeFocused();
		// The bubble stays where it was: the page didn't jump.
		expect((await closed.boundingBox())?.y).toBeCloseTo(top, 0);
		await expectNoPageOverflow(page);
		await expect.poll(() => storedResolved(p, "a.txt")).toBe(true);
		release(p.scenarioPath, "thread");
		// Opened again: the thread, resolved.
		await closed.click();
		await expect(thread).toHaveAttribute("aria-label", /^Resolved thread/);
		await expect(
			thread.getByRole("button", { name: "Unresolve" }),
		).toBeVisible();
		// Unresolve closes nothing.
		await thread.getByRole("button", { name: "Unresolve" }).click();
		await expect(thread).toHaveAttribute("aria-label", /^Unresolved thread/);
		await expect.poll(() => storedResolved(p, "a.txt")).toBe(false);
	});
}

test("a reload while an unresolve is read back shows it unresolved at once", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await setup(pr);
	p.editScenario((s) => {
		const t = s.prs[7]?.graphql?.reviewThreads?.[1] as
			| { isResolved: boolean }
			| undefined;
		if (t) t.isResolved = true;
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = () => fileSection(page, "a.txt");
	await section().getByRole("button", { name: "Expand file" }).click();
	const resolvedBubble = () =>
		line2(section()).getByRole("button", {
			name: /^1 comment on line 2, resolved/,
		});
	await resolvedBubble().click();
	const unresolve = section()
		.getByTestId("files-thread")
		.getByRole("button", { name: "Unresolve" });
	await expect(unresolve).toBeVisible();
	// The page's comments are in: from here only the write's re-read reads them.
	await expect(
		section().getByTestId("thread-comment").filter({ hasText: "Changed how?" }),
	).toHaveCount(1);
	const contentReads = () => (p.ghLog().match(/nodes\(ids: \[/g) ?? []).length;
	const before = contentReads();
	p.editScenario((x) => {
		x.hold = ["threadContent"];
	});
	await unresolve.click();
	// GitHub has it and the server's read-back of the thread is out, held.
	await expect.poll(contentReads).toBe(before + 1);
	expect(storedResolved(p, "a.txt")).toBe(false);
	await page.reload();
	await section().getByRole("button", { name: "Expand file" }).click();
	// Answered without waiting for the read-back.
	await expect(
		line2(section()).getByRole("button", { name: /^1 comment on line 2/ }),
	).toBeVisible();
	await expect(resolvedBubble()).toHaveCount(0);
	release(p.scenarioPath, "threadContent");
});

test("resolve from an Overview card fades, then moves; unresolve brings it back", async ({
	page,
	pr,
	startCrb,
}) => {
	await setup(pr);
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "new.txt");
	// Closed, the card has no Resolve: it's inside Show more.
	await expect(c.getByRole("button", { name: "Resolve" })).toHaveCount(0);
	await openCard(c);
	const resolve = c.getByRole("button", { name: "Resolve", exact: true });
	await expect(resolve).toHaveText("Resolve");
	const size = await resolve.boundingBox();
	expect(size?.height ?? 0).toBeGreaterThanOrEqual(40);
	// The bigger action next to Send.
	const sendSize = await send(c).boundingBox();
	expect(size?.width ?? 0).toBeGreaterThan(sendSize?.width ?? 0);
	const el = await c.elementHandle();
	await resolve.click();
	await expect(c).toHaveAttribute("data-fading", "true");
	// The fade runs over FADE_MS: a hold at full opacity, then down to 0 by
	// 85%, so the card is fully faded before it's removed.
	const fade = await c.evaluate((node) => {
		const a = node
			.getAnimations()
			.find((x) => (x as CSSAnimation).animationName === "thread-fade");
		const effect = a?.effect as KeyframeEffect | null | undefined;
		const frames = effect?.getKeyframes() ?? [];
		return {
			duration: effect?.getTiming().duration,
			frames: frames.map((f) => ({
				offset: f.computedOffset,
				opacity: Number(f.opacity),
			})),
		};
	});
	expect(fade.duration).toBe(FADE_MS);
	expect(fade.frames[0]).toEqual({ offset: 0, opacity: 1 });
	const zero = fade.frames.find((f: { opacity: number }) => f.opacity === 0);
	expect(zero?.offset ?? 1).toBeLessThanOrEqual(0.9);
	expect(fade.frames.at(-1)?.opacity).toBe(0);
	// And on screen: the last frame it was drawn in was (all but) invisible.
	const last = el?.evaluate(
		(node) =>
			new Promise<number>((done) => {
				let seen = 1;
				const tick = () => {
					if (!node.isConnected) return done(seen);
					seen = Number(getComputedStyle(node).opacity);
					requestAnimationFrame(tick);
				};
				tick();
			}),
	);
	await expect(c.getByTestId("thread-head")).toContainText("Resolved thread");
	// Still in place, the toggle there to undo; then gone to the other list.
	await expect(c.getByRole("button", { name: "Unresolve" })).toBeVisible();
	await expect(c).toHaveCount(0, { timeout: 8000 });
	expect(await last).toBeLessThanOrEqual(0.05);
	await humans(page)
		.getByRole("radiogroup", { name: "Threads shown" })
		.getByText("1 resolved")
		.click();
	const back = card(page, "new.txt");
	await openCard(back);
	await back.getByRole("button", { name: "Unresolve" }).click();
	await expect(back).toHaveAttribute("data-fading", "true");
	await expect(back).toHaveCount(0, { timeout: 8000 });
	await page.reload();
	await expect(
		humans(page).getByRole("radio", { name: "0 resolved" }),
	).toBeVisible();
	await expect(card(page, "new.txt")).toBeVisible();
});

test("undo during the fade keeps the card", async ({ page, pr, startCrb }) => {
	await setup(pr);
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "new.txt");
	await openCard(c);
	await c.getByRole("button", { name: "Resolve" }).click();
	await c.getByRole("button", { name: "Unresolve" }).click();
	await expect(c).not.toHaveAttribute("data-fading");
	await page.waitForTimeout(4500);
	await expect(card(page, "new.txt")).toBeVisible();
	await expect(c.getByTestId("thread-head")).toContainText("Unresolved thread");
});

test("switching to Resolved during the fade: the card is there at once, not fading", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await setup(pr);
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "new.txt");
	await openCard(c);
	await c.getByRole("button", { name: "Resolve", exact: true }).click();
	await expect(c).toHaveAttribute("data-fading", "true");
	const choice = humans(page).getByRole("radiogroup", {
		name: "Threads shown",
	});
	await choice.getByText(/^\d+ resolved$/).click();
	const done = humans(page).getByRole("list", { name: "Resolved threads" });
	const moved = done.getByTestId("thread").filter({ hasText: "new.txt" });
	await expect(moved).toBeVisible({ timeout: 1000 });
	await expect(moved).not.toHaveAttribute("data-fading");
	await expect(moved.getByTestId("thread-head")).toContainText(
		"Resolved thread",
	);
	// And back the same way.
	await openCard(moved);
	await moved.getByRole("button", { name: "Unresolve" }).click();
	await expect(moved).toHaveAttribute("data-fading", "true");
	await choice.getByText(/^\d+ unresolved$/).click();
	const back = humans(page)
		.getByRole("list", { name: "Unresolved threads" })
		.getByTestId("thread")
		.filter({ hasText: "new.txt" });
	await expect(back).toBeVisible({ timeout: 1000 });
	await expect(back).not.toHaveAttribute("data-fading");
});

test("a failing reply keeps its text, with Retry", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/403/);
	const p = await setup(pr, { failNext: { op: "reply", status: 403 } });
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "new.txt");
	const box = await openReply(c);
	await box.fill("Try again");
	await send(c).click();
	const notice = page.getByTestId("refused-write");
	await expect(notice).toContainText("Reply · new.txt:1");
	await expect(box).toHaveValue("Try again");
	const drop = notice.getByRole("button", { name: "Drop reply" });
	const size = await drop.boundingBox();
	expect(size?.height ?? 0).toBeGreaterThanOrEqual(40);
	expect(size?.width ?? 0).toBeGreaterThanOrEqual(40);
	await notice.getByRole("button", { name: "Retry reply" }).click();
	await expect(notice).toHaveCount(0);
	await expect(page.getByTestId("refused-bar")).toHaveCount(0);
	await expect(box).toHaveValue("");
	await expect(
		c.getByTestId("thread-comment").filter({ hasText: "Try again" }),
	).toHaveCount(1);
	expect(storedReplies(p, "Try again")).toBe(1);
});

test("a pending review shows the warning and refuses replies with the link", async ({
	page,
	pr,
	startCrb,
	isMobile,
	expectConsoleError,
}) => {
	expectConsoleError(/409/);
	const p = await setup(pr, {}, [
		{
			author: { login: "Octo_Cat", __typename: "User" },
			state: "PENDING",
			submittedAt: null,
			createdAt: "2026-01-03T00:00:00Z",
		},
	]);
	const s = await startCrb();
	await page.goto(s.url);
	const who = page.getByRole("region", { name: "Who's on it" });
	const warning = who.getByTestId("pending-review-warning");
	await expect(warning).toContainText("Pending review on GitHub");
	await expect(
		warning.getByRole("link", { name: "Open on GitHub" }),
	).toHaveAttribute("href", "https://github.com/acme/widget/pull/7/files");
	const c = card(page, "new.txt");
	const box = await openReply(c);
	await box.fill("Blocked");
	await send(c).click();
	const notice = page.getByTestId("refused-write");
	await expect(notice).toContainText(
		"A pending review on GitHub blocks replies",
	);
	await expect(
		notice.getByRole("link", { name: "Open on GitHub" }),
	).toHaveAttribute("href", "https://github.com/acme/widget/pull/7/files");
	await expect(box).toHaveValue("Blocked");
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await page.screenshot({
			path: `${shots}/thread-pending-review-${isMobile ? "phone" : "desktop"}.png`,
		});
	}
	expect(storedReplies(p, "Blocked")).toBe(0);
});

test("no reply box or resolve toggle as of a cutoff", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await setup(pr);
	p.editScenario((sc) => {
		const graph = sc.prs[7]?.graphql;
		if (graph) {
			graph.commits = [
				{
					commit: {
						oid: p.repo.shas.at(-1),
						committedDate: "2026-01-02T00:00:00Z",
					},
				},
			];
		}
		sc.commits = { [p.repo.shas.at(-1) ?? ""]: { contexts: null } };
	});
	const s = await startCrb(undefined, ["--as-of", "2026-01-05T00:00:00Z"]);
	await page.goto(s.url);
	const c = card(page, "new.txt");
	await expect(c).toBeVisible();
	await expect(c.getByRole("button", { name: "Resolve" })).toHaveCount(0);
	await expect(c.getByRole("button", { name: "Reply" })).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "Reply" })).toHaveCount(0);
});

test("a reload with an unconfirmed reply posts it once", async ({
	page,
	pr,
	startCrb,
}) => {
	// The post stays out until after the reload.
	const p = await setup(pr, { hold: ["reply"] });
	const s = await startCrb();
	await page.goto(s.url);
	const asked: string[] = [];
	page.on("dialog", (d) => {
		asked.push(d.type());
		void d.accept();
	});
	const c = card(page, "new.txt");
	const box = await openReply(c);
	await box.fill("Survives a reload");
	await send(c).click();
	await expect(c.getByTestId("thread-comment-sending")).toBeVisible();
	await page.reload();
	// It didn't ask: its draft keeps it, and this page resends it.
	expect(asked).toEqual([]);
	release(p.scenarioPath, "reply");
	const again = card(page, "new.txt");
	await expect(again.getByRole("img", { name: "2 comments" })).toBeVisible({
		timeout: 10_000,
	});
	await expect.poll(() => storedReplies(p, "Survives a reload")).toBe(1);
	await page.waitForTimeout(3000);
	expect(storedReplies(p, "Survives a reload")).toBe(1);
});

test("the Drafts filter lists a thread with a draft, kept across a reload", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await setup(pr);
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "a.txt");
	const box = await openReply(c);
	await box.fill("Thinking about it");
	await box.press("Escape");
	const chip = humans(page).getByTestId("drafts-filter");
	await expect(chip).toHaveText("1 draft");
	// A kept draft loses nothing: the reload doesn't ask.
	const asked: string[] = [];
	page.on("dialog", (d) => {
		asked.push(d.type());
		void d.accept();
	});
	await page.reload();
	expect(asked).toEqual([]);
	await humans(page).getByTestId("drafts-filter").click();
	const list = humans(page).getByRole("list", { name: "Threads with a draft" });
	await expect(list.getByTestId("thread")).toHaveCount(1);
	await expect(list.getByRole("textbox", { name: "Reply" })).toHaveValue(
		"Thinking about it",
	);
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await page.screenshot({
			path: `${shots}/thread-drafts-${isMobile ? "phone" : "desktop"}.png`,
		});
	}
	// No horizontal page scroll with a box open.
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});
