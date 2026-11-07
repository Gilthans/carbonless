import type { Locator, Page } from "@playwright/test";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import {
	expectNoPageOverflow,
	fileSection,
	openFiles,
	progress,
	rowTop,
	tapHeight,
} from "./files-ui";
import { expect, expectLoadingThen, type PrOptions, test } from "./fixtures";

/*
 * Re-review after new pushes (docs/superpowers/specs/2026-11-04-re-review-design.md):
 * the patch set graph, the toast, the since view and the carried marks,
 * on desktop and on a phone.
 */

const core = Array.from({ length: 40 }, (_, i) => `core ${i + 1}`);
const util = Array.from({ length: 10 }, (_, i) => `util ${i + 1}`);
const text = (lines: string[]) => `${lines.join("\n")}\n`;
const edit = (lines: string[], at: Record<number, string | null>) =>
	text(
		lines.flatMap((line, i) => {
			const e = at[i + 1];
			return e === undefined ? [line] : e === null ? [] : [e];
		}),
	);

/**
 * Three clusters: core.ts line 5 (A) and line 30 (B), util.ts line 3 (C).
 * The pushes below rework A, add D (util.ts's tail), then undo C.
 */
const fixture: PrOptions = {
	base: { "src/core.ts": text(core), "src/util.ts": text(util) },
	files: [
		{
			message: "PR change",
			files: {
				"src/core.ts": edit(core, {
					5: "core 5 changed",
					30: "core 30 changed",
				}),
				"src/util.ts": edit(util, { 3: "util 3 changed" }),
			},
		},
	],
};

/** Push 2: A reworked, B untouched (carried), a new cluster D in util.ts. */
const rework = {
	message: "rework",
	files: {
		"src/core.ts": edit(core, { 5: "core 5 reworked", 30: "core 30 changed" }),
		"src/util.ts": `${edit(util, { 3: "util 3 changed" })}util 11 new\n`,
	},
};

/** Push 3: C undone (gone), the rest as pushed before. */
const undo = {
	message: "undo util",
	files: { "src/util.ts": `${text(util)}util 11 new\n` },
};

const tail = (page: Page) => page.getByTestId("ps-tail");
const toast = (page: Page) => page.getByTestId("head-toast");
const marker = (page: Page, name: "viewing" | "comparison base") =>
	page.getByRole("button", { name, exact: true });
const node = (page: Page, id: string) => page.getByTestId(`ps-node-${id}`);
const boxes = (section: Locator) =>
	section.getByRole("checkbox", { name: "Mark cluster reviewed" });

async function expand(page: Page, path: string) {
	const section = fileSection(page, path);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.getByTestId("diff-line").first()).toBeVisible();
	return section;
}

/** Marks every cluster of both files reviewed: PS1, fully reviewed. */
async function reviewAll(page: Page) {
	for (const path of ["src/core.ts", "src/util.ts"]) {
		const section = await expand(page, path);
		const all = boxes(section);
		const n = await all.count();
		for (let i = 0; i < n; i++) {
			await all.nth(i).click();
			await expect(all.nth(i)).toBeChecked();
		}
		await section.getByRole("button", { name: "Collapse file" }).click();
	}
	await expect(progress(page)).toHaveAttribute("aria-valuenow", "100");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
}

/** The page's head poll (every 5 minutes) runs now. */
const poll = (page: Page) => page.clock.fastForward("05:01");

/** Drags `handle` onto `target` with the pointer. */
async function drag(page: Page, handle: Locator, target: Locator) {
	const from = await handle.boundingBox();
	const to = await target.boundingBox();
	if (!from || !to) throw new Error("nothing to drag");
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
		steps: 8,
	});
	await page.mouse.up();
}

/** The card a dot or connector shows on hover (a tooltip, hidden from AT). */
const card = (page: Page) => page.locator('[role="tooltip"]:not([hidden])');

test("a newer head fills the rail's last slot and shows the toast; nothing below the rail moves, nothing takes focus", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	await page.clock.install();
	await openFiles(page, s.url);
	await reviewAll(page);
	await expect(tail(page)).toHaveAttribute("data-state", "up-to-date");
	await expect(tail(page)).toContainText("up to date");
	await expect(toast(page)).toHaveCount(0);
	const slot = tail(page);
	const width = (await slot.boundingBox())?.width ?? 0;
	expect(width).toBeGreaterThan(0);
	const header = fileSection(page, "src/core.ts").locator("header");
	const before = await rowTop(header);
	const focused = () =>
		page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60));
	const focusBefore = await focused();

	p.moveHead(rework);
	await poll(page);
	await expect(tail(page)).toHaveAttribute("data-state", "head");
	await expect(toast(page)).toContainText("1 new commit");
	await expect(toast(page)).toHaveAttribute("role", "status");
	await expect(node(page, "head")).toBeVisible();
	await expect(page.getByTestId("ps-conn-head")).toContainText("1");
	// The same width, so nothing below moved; the toast took no focus.
	expect((await slot.boundingBox())?.width).toBe(width);
	expect(await rowTop(header)).toBe(before);
	expect(await focused()).toBe(focusBefore);
	await expect(toast(page).getByRole("button", { name: "View" })).toBeVisible();
	await expect(marker(page, "viewing")).toBeVisible();
	await expect(
		node(page, "ps1").getByRole("button", { name: "viewing" }),
	).toBeVisible();

	// Dismissed, it stays dismissed for that head.
	await toast(page).getByRole("button", { name: "Dismiss" }).click();
	await expect(toast(page)).toHaveCount(0);

	// Moved twice (Review focus 4): a force-push back to PS1's head. The
	// slot keeps its width through "up to date" again; no toast for a head
	// the reviewer has (the dots never move).
	p.rewindHead(p.repo.shas.at(-1) ?? "");
	await poll(page);
	await expect(tail(page)).toHaveAttribute("data-state", "up-to-date");
	expect((await slot.boundingBox())?.width).toBe(width);
	expect(await rowTop(header)).toBe(before);
	await expect(toast(page)).toHaveCount(0);

	// And forward again, to a head that descends from neither (S4c): the
	// toast counts the new head's commits, the card says the shape.
	p.forceHead({ ...rework, message: "rework, force-pushed" });
	await poll(page);
	await expect(tail(page)).toHaveAttribute("data-state", "head");
	await expect(toast(page)).toContainText("1 new commit");
	expect((await slot.boundingBox())?.width).toBe(width);
	await page.getByTestId("ps-conn-head").hover();
	await expect(card(page)).toContainText(/Rebased/);
});

test("the head connector's card spins in its to-read slot until the engine answers, then says the line", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await reviewAll(page);
	p.moveHead(rework);
	// The engine's answer is held at the page's door until released.
	let release = () => {};
	const held = new Promise<void>((r) => {
		release = r;
	});
	await page.route("**/api/rereview?*", async (route) => {
		await held;
		await route.continue();
	});
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head");
	const conn = page.getByTestId("ps-conn-head");
	// The count comes from git at once.
	await expect(conn).toContainText("1");
	await conn.hover();
	await expectLoadingThen({
		loading: page.getByTestId("rereview-pending"),
		empty: [
			card(page).getByText(/nothing new/),
			card(page).getByText(/0 files/),
		],
		release: () => {
			release();
			return page.unroute("**/api/rereview?*");
		},
		result: card(page).getByText("1 new commit · 2 files, 2 clusters to read"),
	});
	await expect(conn).toHaveAttribute("data-tone", "warn");
});

test("a pinned head shows neither the head dot nor the toast", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr(fixture);
	const then = p.head();
	const now = p.moveHead(rework);
	p.editScenario((s) => {
		const graphql = s.prs[p.number]?.graphql;
		if (!graphql) throw new Error("no graphql");
		graphql.reviews = [
			{
				author: { login: "Octo_Cat", __typename: "User" },
				state: "CHANGES_REQUESTED",
				submittedAt: "2026-01-02T00:00:00Z",
				commit: { oid: then },
			},
			{
				author: { login: "rev1", __typename: "User" },
				state: "APPROVED",
				submittedAt: "2026-01-04T00:00:00Z",
				commit: { oid: now },
			},
		];
		graphql.reviewThreads = [
			reviewThread({ path: "src/util.ts", line: 3, subjectType: "LINE" }, [
				threadComment({
					login: "Octo_Cat",
					text: "On the reviewed commit",
					createdAt: "2026-01-02T00:00:00Z",
					commit: then,
					diffHunk: "",
				}),
			]),
		];
	});
	const s = await startCrb(undefined, ["--head", "reviewed"]);
	await openFiles(page, s.url);
	await expect(tail(page)).toHaveAttribute("data-state", "none");
	await expect(tail(page)).toHaveText("pinned");
	await expect(toast(page)).toHaveCount(0);
	await expect(node(page, "head")).toHaveCount(0);
});

test("the rail on a phone: 40px targets, no page overflow, a tap opens the sheet with View and Compare from here", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "the sheet is the phone's way");
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await reviewAll(page);
	p.moveHead(rework);
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head");
	await expectNoPageOverflow(page);
	for (const el of [
		node(page, "head"),
		node(page, "ps1"),
		marker(page, "viewing"),
		marker(page, "comparison base"),
	]) {
		expect(await tapHeight(el)).toBeGreaterThanOrEqual(40);
	}
	// A phone connector shows the bare count.
	await expect(page.getByTestId("ps-conn-head")).toHaveText("1");
	await expect(marker(page, "comparison base")).toHaveText("comp. base");

	await node(page, "ps1").click();
	const sheet = page.getByTestId("dot-sheet");
	await expect(sheet).toBeVisible();
	await expect(sheet).toContainText("PS1");
	// PS1 is viewed: it can't be its own comparison base.
	await expect(
		sheet.getByRole("button", { name: "Compare from here" }),
	).toBeDisabled();
	await sheet.getByRole("button", { name: "View" }).click();
	await expect(sheet).toBeHidden();

	await node(page, "head").click();
	await expect(sheet).toContainText("head");
	await sheet.getByRole("button", { name: "View" }).click();
	await expect(sheet).toBeHidden();
	await expect(
		node(page, "head").getByRole("button", { name: "viewing" }),
	).toBeVisible();
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);
	await expectNoPageOverflow(page);
});

test("the markers move by drag and by Ctrl+[ / Ctrl+]; nothing moves on a bare key", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await reviewAll(page);
	p.moveHead(rework);
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head");

	await drag(page, marker(page, "viewing"), node(page, "head"));
	await expect(
		node(page, "head").getByRole("button", { name: "viewing" }),
	).toBeVisible();
	await expect(
		node(page, "ps1").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);

	// A bare bracket is nothing; Ctrl+[ goes back to PS1.
	await page.keyboard.press("[");
	await expect(
		node(page, "head").getByRole("button", { name: "viewing" }),
	).toBeVisible();
	await page.keyboard.press("Control+[");
	await expect(
		node(page, "ps1").getByRole("button", { name: "viewing" }),
	).toBeVisible();
	await expect(page).toHaveURL(/ps=1/);
	// The base followed back to the branch (it was "the previous").
	await expect(
		node(page, "branch").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	// Ctrl+] past the newest patch set views the head; the base follows to PS1.
	await page.keyboard.press("Control+]");
	await expect(
		node(page, "head").getByRole("button", { name: "viewing" }),
	).toBeVisible();
	await expect(
		node(page, "ps1").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	// Ctrl+Shift+[ moves the base to the branch: the full diff.
	await page.keyboard.press("Control+Shift+[");
	await expect(
		node(page, "branch").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	await expect(page).toHaveURL(/from=branch/);
	// Dragging the base onto the viewed dot is refused.
	await drag(page, marker(page, "comparison base"), node(page, "head"));
	await expect(
		node(page, "branch").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
});
