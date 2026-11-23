import type { Locator, Page } from "@playwright/test";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import {
	expectNoPageOverflow,
	fileSection,
	openFiles,
	progress,
} from "./files-ui";
import {
	expect,
	expectLoadingThen,
	type Pr,
	type PrOptions,
	test,
} from "./fixtures";

/*
 * Thread moves (CAR-139; docs/superpowers/specs/2026-11-18-thread-placement-design.md):
 * the reviewer puts a review thread on the line it is about, by drag on a
 * desktop and by move mode (tap the handle, tap a number, Place here) on a
 * phone or by keyboard; the `moved` chip and Undo; a reload keeps it; the
 * next pushes follow it from the moved line; GitHub is never written
 * (a reply goes to the thread as ever); no handle while the placements load.
 */

const core = Array.from({ length: 40 }, (_, i) => `core ${i + 1}`);
const text = (lines: string[]) => `${lines.join("\n")}\n`;
const edit = (lines: string[], at: Record<number, string | null>) =>
	text(
		lines.flatMap((line, i) => {
			const e = at[i + 1];
			return e === undefined ? [line] : e === null ? [] : [e];
		}),
	);
const CORE = "src/core.ts";

/**
 * Two PR commits: core 5, then core 30. The thread is made on the first,
 * so on the head it is traced (a thread opened on the viewed head has no
 * handle: nothing to correct).
 */
const fixture: PrOptions = {
	base: { [CORE]: text(core) },
	files: [
		{
			message: "core 5",
			files: { [CORE]: edit(core, { 5: "core 5 changed" }) },
		},
		{
			message: "core 30",
			files: {
				[CORE]: edit(core, { 5: "core 5 changed", 30: "core 30 changed" }),
			},
		},
	],
};

/** Waits on git in crb's child processes (the tracer, a new head). */
const GIT_WAIT = { timeout: 30_000 };

const row = (section: Locator, n: number) =>
	section.locator(`tr[data-testid="diff-line"][data-new-no="${n}"]`);
const bubbleOn = (section: Locator, n: number) =>
	row(section, n).getByRole("button", { name: /1 comment/ });
const card = (page: Page) =>
	page.getByTestId("files-thread").filter({ hasText: "Why change core 5?" });

async function setup(
	page: Page,
	pr: (o: PrOptions) => Promise<Pr>,
	startCrb: () => Promise<{ url: string }>,
) {
	const threads: ReturnType<typeof reviewThread>[] = [];
	const p = await pr({ ...fixture, threads });
	const first = p.repo.shas.at(-2) as string;
	threads.push(
		reviewThread({ path: CORE, line: 5, subjectType: "LINE" }, [
			threadComment({
				login: "rev1",
				text: "Why change core 5?",
				commit: first,
				diffHunk: "",
			}),
		]),
	);
	p.editScenario((sc) => {
		const graph = sc.prs[p.number]?.graphql;
		if (graph) graph.reviewThreads = threads;
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, CORE);
	await section.getByRole("button", { name: "Expand file" }).click();
	return { p, s, section };
}

/** Opens the thread on line `n` (its bubble) and gives its card. */
async function openOn(section: Locator, page: Page, n: number) {
	const bubble = bubbleOn(section, n);
	await expect(bubble).toBeVisible(GIT_WAIT);
	if ((await bubble.getAttribute("aria-expanded")) !== "true") {
		await bubble.click();
	}
	await expect(card(page)).toBeVisible();
	return card(page);
}

/**
 * Views the PR's new head `oid`: a reload, then the toast's View once it
 * names that head (never a toast still about an earlier one).
 */
async function viewHead(page: Page, oid: string) {
	await page.reload();
	const toast = page.getByTestId("head-toast");
	await expect(toast).toContainText(oid.slice(0, 7), GIT_WAIT);
	await toast.getByRole("button", { name: "View" }).click();
	await expect(
		page.getByRole("button", { name: `head ${oid.slice(0, 7)}` }),
	).toBeVisible(GIT_WAIT);
}

/** Drags `handle` onto `target` with the mouse. */
async function drag(page: Page, handle: Locator, target: Locator) {
	const from = await handle.boundingBox();
	if (!from) throw new Error("no handle");
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(from.x + 30, from.y + 30, { steps: 4 });
	// Mid-screen: near the top or bottom edge, the drag scrolls the page on.
	await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
	const to = await target.boundingBox();
	if (!to) throw new Error("no target");
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
		steps: 8,
	});
	await page.mouse.up();
}

/** Move mode: the handle pressed, a number picked, Place here. */
async function placeByPick(
	page: Page,
	card: Locator,
	section: Locator,
	n: number,
) {
	await card.getByTestId("move-handle").click();
	const bar = page.getByTestId("move-bar");
	await expect(bar).toBeVisible();
	await expect(bar).toContainText("Pick a line");
	await expect(page.getByTestId("move-bar-words")).toHaveText(
		"Why change core 5?",
	);
	await expect(card).toHaveAttribute("data-move-source", "");
	await row(section, n).getByTestId("new").click();
	const place = page
		.getByTestId("selection-bar")
		.getByRole("button", { name: "Place here" });
	await expect(place).toBeVisible();
	expect((await place.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
	await place.click();
	await expect(bar).toHaveCount(0);
}

test("a review thread moved to its line: drag (desktop) or move mode (phone), the chip, a reload keeps it, Undo brings back the tracer's place; coverage and GitHub untouched", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.setTimeout(120_000);
	const { p, section } = await setup(page, pr, startCrb);
	const c = await openOn(section, page, 5);
	const handle = c.getByTestId("move-handle");
	await expect(handle).toBeVisible(GIT_WAIT);
	await expect(handle).toHaveAccessibleName("Move thread");
	const done = await progress(page).getAttribute("aria-valuenow");
	const log = p.ghLog();
	if (isMobile) {
		expect((await handle.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
			40,
		);
		await placeByPick(page, c, section, 30);
	} else {
		await drag(page, handle, row(section, 30));
	}
	// On line 30 now, the moved chip and Undo on its card; gone from 5.
	await expect(bubbleOn(section, 30)).toBeVisible();
	await expect(bubbleOn(section, 5)).toHaveCount(0);
	const moved = card(page);
	await expect(moved.getByTestId("moved-chip")).toHaveText("moved");
	const undo = moved.getByRole("button", { name: "Undo move" });
	await expect(undo).toBeVisible();
	// Focus goes to Undo after the place.
	await expect(undo).toBeFocused();
	expect((await undo.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
	// Nothing about the move counts or goes to GitHub.
	await expect(progress(page)).toHaveAttribute("aria-valuenow", done ?? "");
	await expectNoPageOverflow(page);
	// A reload keeps it.
	await page.reload();
	const again = fileSection(page, CORE);
	await again.getByRole("button", { name: "Expand file" }).click();
	const reopened = await openOn(again, page, 30);
	await expect(reopened.getByTestId("moved-chip")).toBeVisible();
	// Undo: back where the tracer had it.
	await reopened.getByRole("button", { name: "Undo move" }).click();
	await expect(bubbleOn(again, 5)).toBeVisible(GIT_WAIT);
	await expect(bubbleOn(again, 30)).toHaveCount(0);
	await expect(page.getByTestId("moved-chip")).toHaveCount(0);
	const sent = p
		.ghLog()
		.slice(log.length)
		.split("\n")
		.filter((l) => /mutation|-X (POST|PATCH|PUT|DELETE)/.test(l));
	expect(sent).toEqual([]);
});

test("by keyboard and by tap: move mode places on the picked lines; Escape and ✕ write nothing; at 360px the bar never scrolls the page sideways", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.setTimeout(120_000);
	const { p, section } = await setup(page, pr, startCrb);
	const c = await openOn(section, page, 5);
	const handle = c.getByTestId("move-handle");
	await expect(handle).toBeVisible(GIT_WAIT);
	const log = p.ghLog();
	// Pressed: move mode; Escape leaves it.
	if (isMobile) await handle.click();
	else {
		await handle.focus();
		await page.keyboard.press("Enter");
	}
	await expect(page.getByTestId("move-bar")).toBeVisible();
	if (isMobile) {
		const size = page.viewportSize();
		await page.setViewportSize({ width: 360, height: size?.height ?? 740 });
		await expectNoPageOverflow(page);
		const cancel = page.getByRole("button", { name: "Cancel move" });
		expect((await cancel.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
			40,
		);
		await cancel.click();
		if (size) await page.setViewportSize(size);
	} else {
		await page.keyboard.press("Escape");
	}
	await expect(page.getByTestId("move-bar")).toHaveCount(0);
	await expect(bubbleOn(section, 5)).toBeVisible();
	// Line 32: context beside core 30's hunk, shown without expanding.
	await placeByPick(page, card(page), section, 32);
	await expect(bubbleOn(section, 32)).toBeVisible();
	await expect(card(page).getByTestId("moved-chip")).toBeVisible();
	expect(p.ghLog().slice(log.length)).not.toMatch(/mutation|-X POST/);
});

test("the next pushes follow a moved thread from its moved line; once that line is deleted it is unplaced with its fate; a reply still goes to its thread", async ({
	page,
	pr,
	startCrb,
}) => {
	test.setTimeout(150_000);
	const { p, section } = await setup(page, pr, startCrb);
	const c = await openOn(section, page, 5);
	await placeByPick(page, c, section, 30);
	await expect(bubbleOn(section, 30)).toBeVisible();
	// Push: two lines on top. The page's head is the one it opened on
	// until the reviewer views the new one.
	const h2 = p.moveHead({
		message: "two on top",
		files: {
			[CORE]: text([
				"top 1",
				"top 2",
				...edit(core, { 5: "core 5 changed", 30: "core 30 changed" })
					.trimEnd()
					.split("\n"),
			]),
		},
	});
	await viewHead(page, h2);
	const pushed = fileSection(page, CORE);
	await pushed.getByRole("button", { name: "Expand file" }).click();
	const followed = await openOn(pushed, page, 32);
	const chip = followed.getByTestId("moved-chip");
	await expect(chip).toBeVisible();
	await chip.hover();
	await expect(page.getByRole("tooltip")).toContainText(
		"followed here · GitHub: line",
	);
	// A reply goes to that thread (GitHub's reply to its first comment), as
	// on any thread, and nothing else is sent.
	const log = p.ghLog();
	const box = followed.getByRole("textbox", { name: "Reply" });
	await box.fill("Still here");
	await followed
		.getByTestId("reply-box")
		.getByRole("button", { name: "Reply" })
		.click();
	await expect(followed.getByText("Still here")).toBeVisible(GIT_WAIT);
	// The card shows the reply at once; the gh call may log a moment later.
	const writes = () =>
		p
			.ghLog()
			.slice(log.length)
			.split("\n")
			.filter((l) => /mutation|-X (POST|PATCH|PUT|DELETE)/.test(l));
	await expect.poll(() => writes().length, GIT_WAIT).toBe(1);
	const sent = writes();
	expect(sent[0]).toMatch(
		new RegExp(`-X POST repos/[^ ]+/pulls/${p.number}/comments/\\d+/replies `),
	);
	// Push: the moved-to line deleted.
	const h3 = p.moveHead({
		message: "drop core 30",
		files: {
			[CORE]: text([
				"top 1",
				"top 2",
				...edit(core, { 5: "core 5 changed", 30: null }).trimEnd().split("\n"),
			]),
		},
	});
	await viewHead(page, h3);
	const gone = fileSection(page, CORE);
	await gone.getByRole("button", { name: "Expand file" }).click();
	const unplaced = gone
		.getByTestId("unplaced-thread")
		.filter({ hasText: "Why change core 5?" });
	await expect(unplaced).toHaveAttribute("data-fate", "deleted", GIT_WAIT);
	await expect(unplaced.getByTestId("near-line")).toHaveText("near 31");
	await expect(unplaced.getByTestId("moved-chip")).toBeVisible();
	await expect(
		unplaced.getByRole("button", { name: "Undo move" }),
	).toBeVisible();
	await expect(unplaced.getByTestId("move-handle")).toBeVisible();
});

test("no handle and no chip while the placements are on their way, for a moved thread too; then they land", async ({
	page,
	pr,
	startCrb,
}) => {
	test.setTimeout(90_000);
	const { section } = await setup(page, pr, startCrb);
	await placeByPick(page, await openOn(section, page, 5), section, 30);
	await expect(card(page).getByTestId("moved-chip")).toBeVisible();
	let release = () => {};
	const held = new Promise<void>((r) => {
		release = r;
	});
	await page.route("**/api/r/*/placements?*", async (route) => {
		await held;
		await route.continue();
	});
	await page.reload();
	const again = fileSection(page, CORE);
	await again.getByRole("button", { name: "Expand file" }).click();
	try {
		await expectLoadingThen({
			loading: page.getByRole("status", { name: "Placing threads" }).first(),
			empty: [
				page.getByTestId("move-handle"),
				page.getByTestId("moved-chip"),
				bubbleOn(again, 30),
				bubbleOn(again, 5),
			],
			release: async () => {
				await expect(row(again, 30)).toBeVisible();
				release();
			},
			result: bubbleOn(again, 30),
			...GIT_WAIT,
		});
	} finally {
		release();
	}
	const c = await openOn(again, page, 30);
	await expect(c.getByTestId("move-handle")).toBeVisible();
	await expect(c.getByTestId("moved-chip")).toBeVisible();
});

test("in the since view (PS1 → head) too: the handle on a carried thread, a drag (desktop) or move mode (phone) onto a new line; the full diff shows it there, moved, with Undo", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	// Past the 30 s default: a push, then up to six GIT_WAIT (30 s) waits on
	// crb's git (the new head, the engine's since view, the tracer) on a
	// loaded machine, as the other push tests here. It ran in 7 to 8 s here.
	test.setTimeout(120_000);
	const { p, section } = await setup(page, pr, startCrb);
	// PS1: the first mark starts it on this head.
	await expect(bubbleOn(section, 5)).toBeVisible(GIT_WAIT);
	const box = section
		.getByRole("checkbox", { name: "Mark cluster reviewed" })
		.first();
	await box.click();
	await expect(box).toBeChecked();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	// Push: core 7 changed too. Core 5 and 30 read as PS1 had them, so the
	// since view's one hunk is core 7's, its context lines 4 to 10: the
	// thread's line 5 among them, unchanged since PS1.
	const h2 = p.moveHead({
		message: "core 7",
		files: {
			[CORE]: edit(core, {
				5: "core 5 changed",
				7: "core 7 changed",
				30: "core 30 changed",
			}),
		},
	});
	await viewHead(page, h2);
	await expect(
		page
			.getByTestId("ps-node-ps1")
			.getByRole("button", { name: "comparison base" }),
	).toBeVisible(GIT_WAIT);
	const since = fileSection(page, CORE);
	await since.getByRole("button", { name: "Expand file" }).click();
	await expect(row(since, 7)).toHaveAttribute("data-kind", "add", GIT_WAIT);
	const c = await openOn(since, page, 5);
	const handle = c.getByTestId("move-handle");
	await expect(handle).toBeVisible(GIT_WAIT);
	const log = p.ghLog();
	if (isMobile) await placeByPick(page, c, since, 7);
	else await drag(page, handle, row(since, 7));
	await expect(bubbleOn(since, 7)).toBeVisible(GIT_WAIT);
	await expect(bubbleOn(since, 5)).toHaveCount(0);
	await expect(card(page).getByTestId("moved-chip")).toBeVisible();
	await expect(
		card(page).getByRole("button", { name: "Undo move" }),
	).toBeVisible();
	await expectNoPageOverflow(page);
	// The full diff (base on the branch) shows it on the same line.
	const url = new URL(page.url());
	url.searchParams.set("from", "branch");
	await page.goto(url.toString());
	const full = fileSection(page, CORE);
	await full.getByRole("button", { name: "Expand file" }).click();
	const there = await openOn(full, page, 7);
	await expect(there.getByTestId("moved-chip")).toBeVisible();
	await expect(there.getByRole("button", { name: "Undo move" })).toBeVisible();
	await expect(bubbleOn(full, 5)).toHaveCount(0);
	expect(p.ghLog().slice(log.length)).not.toMatch(/mutation|-X POST/);
});
