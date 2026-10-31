import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import {
	reviewThread,
	type Scenario,
	threadComment,
} from "../test/fake-gh/scenario";
import {
	expectNoPageOverflow,
	fileSection,
	ignoreWhitespace,
	openFiles,
	progress,
	rowTop,
	setSwitch,
	sideBySide,
	underStack,
} from "./files-ui";
import { expect, type Pr, type PrOptions, test } from "./fixtures";

const text = (lines: string[]) => `${lines.join("\n")}\n`;
const greet = Array.from({ length: 10 }, (_, i) => `greet ${i + 1}`);
const mixed = Array.from({ length: 10 }, (_, i) => `mixed ${i + 1}`);
const indent = Array.from({ length: 8 }, (_, i) => `indent ${i + 1}`);
const long = Array.from({ length: 1200 }, (_, i) => `long ${i + 1}`);
/** One 300-character word: it wraps only by breaking anywhere. */
const WIDE = "w".repeat(300);

const GREET = "src/greet.ts";
const MIXED = "src/mixed.ts";
const INDENT = "src/indent.ts";
const LONG = "src/long.ts";

/**
 * Four clusters: src/greet.ts's lines 5–6 become three lines, the third 300
 * characters (2 removed / 3 added); src/mixed.ts's lines 3–6 re-indented
 * with line 4 really changed; src/indent.ts re-indented wholesale
 * (whitespace only); src/long.ts, 1,200 lines, line 1,150 changed.
 */
const fixture: PrOptions = {
	base: {
		[GREET]: text(greet),
		[MIXED]: text(mixed),
		[INDENT]: text(indent),
		[LONG]: text(long),
	},
	files: [
		{
			message: "Side by side",
			files: {
				[GREET]: text([
					...greet.slice(0, 4),
					"greet 5 changed",
					"greet 6 changed",
					WIDE,
					...greet.slice(6),
				]),
				[MIXED]: text(
					mixed.map((l, i) =>
						i < 2 || i > 5 ? l : i === 3 ? "\tmixed 4 changed" : `\t${l}`,
					),
				),
				[INDENT]: text(indent.map((l) => `  ${l}`)),
				[LONG]: text(long.map((l, i) => (i === 1149 ? `${l} changed` : l))),
			},
		},
	],
};

/** The PR with two threads on src/greet.ts: new line 6 and old line 5. */
async function setup(pr: (opts?: PrOptions) => Promise<Pr>) {
	const p = await pr(fixture);
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((s) => {
		const graph = s.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: GREET, line: 6, subjectType: "LINE" }, [
				threadComment({
					login: "rev1",
					text: "New six",
					commit: head,
					diffHunk: "",
				}),
			]),
			reviewThread(
				{ path: GREET, line: 5, diffSide: "LEFT", subjectType: "LINE" },
				[
					threadComment({
						login: "rev2",
						text: "Old five",
						commit: head,
						diffHunk: "",
					}),
				],
			),
		];
	});
	return p;
}

const rows = (section: Locator) => section.locator('[data-testid="diff-line"]');
const pairs = (section: Locator) =>
	section.locator('[data-testid="diff-line"][data-kind="pair"]');
const codeCells = (scope: Locator) => scope.locator('td[data-testid="code"]');
/**
 * A pair row's bubbles on `side`: in that side's code cell, or on a phone
 * in the bubble row under the pair row (its left or right group).
 */
const bubblesOf = (row: Locator, side: "LEFT" | "RIGHT", isMobile: boolean) =>
	(isMobile
		? row
				.locator("xpath=following-sibling::tr[1]")
				.locator(`[data-bubbles="${side}"]`)
		: codeCells(row).nth(side === "LEFT" ? 0 : 1)
	).getByTestId("thread-bubble");
/** What sits under a row: on a phone its bubble row comes first. */
const under = (row: Locator, isMobile: boolean) =>
	row.evaluate((tr, skip) => {
		const next = tr.nextElementSibling;
		return (
			skip && next?.getAttribute("data-testid") === "bubble-row"
				? next.nextElementSibling
				: next
		)?.getAttribute("data-testid");
	}, isMobile);
const table = (section: Locator, view: "unified" | "side-by-side") =>
	section.locator(`table[data-view="${view}"]`);

async function expand(page: Page, path: string) {
	const section = fileSection(page, path);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(rows(section).first()).toBeVisible();
	return section;
}

/** DESIGN_SHOTS=<dir>: also save <name>-{desktop,phone}.png there (side-by-side by default). */
const shots = process.env.DESIGN_SHOTS;
const shot = (page: Page, isMobile: boolean, name = "side-by-side") =>
	shots
		? page.screenshot({
				path: `${shots}/${name}-${isMobile ? "phone" : "desktop"}.png`,
			})
		: Promise.resolve();

test("Side by side lays clusters out as pairs in place, wraps long lines, and keeps the review and what is open", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await setup(pr);
	const s = await startCrb();
	const hunkRequests: string[] = [];
	page.on("request", (r) => {
		if (r.url().includes("/hunks")) hunkRequests.push(r.url());
	});
	await openFiles(page, s.url);
	const section = await expand(page, GREET);
	await expect(table(section, "unified")).toBeVisible();
	// Three lines of context on each side of the five changed lines.
	await expect(rows(section)).toHaveCount(3 + 5 + 3);
	const url = page.url();
	const fetched = hunkRequests.length;

	// On: laid out again in place, no navigation, no refetch.
	await sideBySide(page, true);
	await expect(table(section, "side-by-side")).toBeVisible();
	expect(page.url()).toBe(url);
	expect(hunkRequests).toHaveLength(fetched);
	await expect(table(section, "unified")).toHaveCount(0);
	// Context on both sides, the cluster as three pairs, the third's left blank.
	const first = rows(section).first();
	await expect(first).toHaveAttribute("data-kind", "context");
	await expect(codeCells(first)).toHaveCount(2);
	await expect(codeCells(first).nth(0)).toHaveAttribute("data-side", "LEFT");
	await expect(codeCells(first).nth(0)).toContainText("greet 2");
	await expect(codeCells(first).nth(1)).toHaveAttribute("data-side", "RIGHT");
	await expect(codeCells(first).nth(1)).toContainText("greet 2");
	const pairRows = pairs(section);
	await expect(pairRows).toHaveCount(3);
	await expect(rows(section)).toHaveCount(3 + 3 + 3);
	await expect(pairRows.nth(0)).toHaveAttribute("data-old-no", "5");
	await expect(pairRows.nth(0)).toHaveAttribute("data-new-no", "5");
	await expect(codeCells(pairRows.nth(0)).nth(0)).toContainText("greet 5");
	await expect(codeCells(pairRows.nth(0)).nth(1)).toContainText(
		"greet 5 changed",
	);
	await expect(pairRows.nth(2)).not.toHaveAttribute("data-old-no");
	await expect(pairRows.nth(2)).toHaveAttribute("data-new-no", "7");
	await expect(pairRows.nth(2).locator("td[data-blank]")).toHaveCount(2);
	await expect(codeCells(pairRows.nth(2))).toHaveCount(2);
	const checkbox = pairRows
		.nth(0)
		.getByRole("checkbox", { name: "Mark cluster reviewed" });
	await expect(checkbox).toBeVisible();
	await expect(
		section.getByRole("checkbox", { name: "Mark cluster reviewed" }),
	).toHaveCount(1);
	// The 300-character line wraps in its cell: nothing scrolls sideways,
	// and its row is taller than one line.
	const wide = codeCells(pairRows.nth(2)).last();
	await expect(wide).toHaveAttribute("data-side", "RIGHT");
	const fits = await wide.evaluate((td) => {
		const scroller = td.closest("table")?.parentElement as HTMLElement;
		return {
			cell: td.scrollWidth <= td.clientWidth,
			scroller: scroller.scrollWidth <= scroller.clientWidth,
		};
	});
	expect(fits).toEqual({ cell: true, scroller: true });
	const tall = await pairRows.nth(2).boundingBox();
	const short = await first.boundingBox();
	expect(tall?.height ?? 0).toBeGreaterThan(2 * (short?.height ?? 0));
	await expectNoPageOverflow(page);
	await shot(page, isMobile);

	// Reviewed from the pair row: both sides fade, progress moves by one.
	await checkbox.click();
	await expect(checkbox).toBeChecked();
	await expect(progress(page)).toContainText("1 / 4 clusters reviewed");
	await expect(pairRows.nth(0)).toHaveAttribute("data-reviewed", "true");
	await expect(codeCells(pairRows.nth(0)).nth(0)).toHaveClass(/bg-del-done/);
	await expect(codeCells(pairRows.nth(0)).nth(1)).toHaveClass(/bg-add-done/);
	await expect(codeCells(pairRows.nth(2)).last()).toHaveClass(/bg-add-done/);

	// A thread's bubble is in the cell of its side (on a phone, that side of
	// the bubble row under the pair); it opens under the pair.
	const row6 = section.locator('tr[data-testid="diff-line"][data-new-no="6"]');
	await expect(row6).toHaveAttribute("data-old-no", "6");
	const bubble = bubblesOf(row6, "RIGHT", isMobile);
	await expect(bubble).toHaveAccessibleName("1 comment on line 6");
	await expect(codeCells(row6).nth(1)).toHaveAttribute("data-commented", "");
	await expect(codeCells(row6).nth(1)).toHaveClass(/thread-mark-cell/);
	// The old side of the pair has no thread: no bubble and no mark there.
	await expect(bubblesOf(row6, "LEFT", isMobile)).toHaveCount(0);
	await expect(codeCells(row6).getByTestId("thread-bubble")).toHaveCount(
		isMobile ? 0 : 1,
	);
	await expect(codeCells(row6).nth(0)).not.toHaveAttribute("data-commented");
	await expect(codeCells(row6).nth(0)).not.toHaveClass(/thread-mark-cell/);
	await expect(row6.getByTestId("old")).not.toHaveClass(/thread-mark-cell/);
	const row5 = section.locator('tr[data-testid="diff-line"][data-old-no="5"]');
	await expect(bubblesOf(row5, "LEFT", isMobile)).toHaveAccessibleName(
		"1 comment on old line 5",
	);
	await bubble.click();
	const threadRow = section.getByTestId("thread-row");
	await expect(threadRow).toHaveCount(1);
	await expect(threadRow).toContainText("New six");
	expect(await under(row6, isMobile)).toBe("thread-row");

	// Off and on again: the open thread stays open (keyed by its line), the
	// cluster stays reviewed, and nothing is fetched again.
	const before = hunkRequests.length;
	await sideBySide(page, false);
	await expect(table(section, "unified")).toBeVisible();
	await expect(rows(section)).toHaveCount(3 + 5 + 3);
	await expect(threadRow).toHaveCount(1);
	await expect(threadRow).toBeVisible();
	await expect(progress(page)).toContainText("1 / 4 clusters reviewed");
	await sideBySide(page, true);
	await expect(table(section, "side-by-side")).toBeVisible();
	await expect(threadRow).toHaveCount(1);
	await expect(pairs(section).nth(0)).toHaveAttribute("data-reviewed", "true");
	expect(hunkRequests).toHaveLength(before);

	// With Ignore whitespace on too: a whitespace-only cluster is still one
	// collapsed row, and expanded it stays so across a switch (one file is
	// open at a time: expanding it closes src/greet.ts).
	await ignoreWhitespace(page, true);
	const indentSection = fileSection(page, INDENT);
	await indentSection.getByRole("button", { name: "Expand file" }).click();
	const collapsed = indentSection.getByTestId("ws-cluster");
	await expect(collapsed).toHaveCount(1);
	await expect(rows(indentSection)).toHaveCount(0);
	await collapsed
		.getByRole("button", { name: "Whitespace only · 16 lines" })
		.click();
	await expect(collapsed).toHaveAttribute("data-expanded", "true");
	await expect(pairs(indentSection)).toHaveCount(8);
	await expect(
		indentSection.locator('td[data-testid="code"][data-kind="ws"]'),
	).toHaveCount(16);
	await sideBySide(page, false);
	await expect(table(indentSection, "unified")).toBeVisible();
	await expect(collapsed).toHaveAttribute("data-expanded", "true");
	await expect(
		indentSection.locator('[data-testid="diff-line"][data-kind="ws"]'),
	).toHaveCount(8);
	await sideBySide(page, true);
	await expect(table(indentSection, "side-by-side")).toBeVisible();
	await expect(collapsed).toHaveAttribute("data-expanded", "true");
	await expect(pairs(indentSection)).toHaveCount(8);

	// A mixed cluster shows `~` pairs between positional pairs.
	const mixedSection = await expand(page, MIXED);
	await expect(pairs(mixedSection)).toHaveCount(4);
	const kinds = (kind: string) =>
		mixedSection.locator(`td[data-testid="code"][data-kind="${kind}"]`);
	await expect(kinds("ws")).toHaveCount(6);
	await expect(kinds("del")).toHaveCount(1);
	await expect(kinds("del")).toContainText("mixed 4");
	await expect(kinds("add")).toHaveCount(1);
	await expect(kinds("add")).toContainText("mixed 4 changed");
	await expect(pairs(mixedSection).nth(1)).toHaveAttribute("data-old-no", "4");
	await expect(pairs(mixedSection).nth(1)).toHaveAttribute("data-new-no", "4");
	await expect(mixedSection.getByTestId("change-count")).toContainText("+4");
	await expectNoPageOverflow(page);
});

test("a thread link lands on one cell of a pair row", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await setup(pr);
	const s = await startCrb();
	await page.addInitScript(() => {
		// The initial blank document has no storage: the app's own does.
		try {
			localStorage.setItem("crb.diff.sideBySide", "on");
		} catch {}
	});
	const land = (line: number, side: "LEFT" | "RIGHT") =>
		page.goto(
			new URL(
				`/files?path=${encodeURIComponent(GREET)}&line=${line}&side=${side}`,
				s.url,
			).href,
		);
	await land(6, "RIGHT");
	const section = fileSection(page, GREET);
	await expect(table(section, "side-by-side")).toBeVisible();
	const landed = section.locator('tr[data-testid="diff-line"][data-landed]');
	await expect(landed).toHaveCount(1);
	await expect(landed).toHaveAttribute("data-kind", "pair");
	await expect(landed).toHaveAttribute("data-new-no", "6");
	const cell = landed.locator('td[data-testid="code"][data-landed]');
	await expect(cell).toHaveCount(1);
	await expect(cell).toHaveAttribute("data-side", "RIGHT");
	await expect(cell).toContainText("greet 6 changed");
	await expect(section.getByTestId("landing-hint")).toHaveCount(0);
	// The old side of the pair above it.
	await land(5, "LEFT");
	await expect(landed).toHaveCount(1);
	await expect(landed).toHaveAttribute("data-old-no", "5");
	await expect(cell).toHaveCount(1);
	await expect(cell).toHaveAttribute("data-side", "LEFT");
	await expect(cell).toContainText("greet 5");
	await expect(cell).not.toContainText("changed");
});

test("a four-digit file side by side fits a phone: no page overflow, readable code cells", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	await sideBySide(page, true);
	const section = await expand(page, LONG);
	await expect(table(section, "side-by-side")).toBeVisible();
	const row = section.locator(
		'tr[data-testid="diff-line"][data-new-no="1150"]',
	);
	await expect(row).toHaveAttribute("data-kind", "pair");
	await expect(row).toHaveAttribute("data-old-no", "1150");
	await row.scrollIntoViewIfNeeded();
	await expect(row.getByTestId("old")).toHaveText("1150");
	await expect(row.getByTestId("new")).toHaveText("1150");
	await expectNoPageOverflow(page);
	// What is left after the page's gutters, the rail, the 80px touch controls
	// and two number cells (four digits, 48px kept on touch), in two equal
	// halves: 77px each at 360px.
	const widths = await codeCells(row).evaluateAll((cells) =>
		cells.map((td) => td.getBoundingClientRect().width),
	);
	expect(widths).toHaveLength(2);
	expect(Math.abs((widths[0] ?? 0) - (widths[1] ?? 0))).toBeLessThanOrEqual(1);
	for (const width of widths) expect(width).toBeGreaterThanOrEqual(76);
	// The controls keep their touch targets.
	const target = await section.getByTestId("cluster-box-target").boundingBox();
	if (isMobile) {
		expect(target?.width).toBeGreaterThanOrEqual(40);
		expect(target?.height).toBeGreaterThanOrEqual(40);
	}
});

test("a four-digit file side by side on a phone: a thread's bubble takes no room from the code, in a row of its own", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	const p = await setup(pr);
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((sc) => {
		const graph = sc.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			...(graph.reviewThreads ?? []),
			reviewThread({ path: LONG, line: 1150, subjectType: "LINE" }, [
				threadComment({
					login: "rev1",
					text: "Long one",
					commit: head,
					diffHunk: "",
				}),
			]),
		];
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	await sideBySide(page, true);
	const section = await expand(page, LONG);
	await expect(table(section, "side-by-side")).toBeVisible();
	const row = section.locator(
		'tr[data-testid="diff-line"][data-new-no="1150"]',
	);
	await expect(row).toHaveAttribute("data-kind", "pair");
	await row.scrollIntoViewIfNeeded();
	const bubble = section.getByRole("button", {
		name: "1 comment on line 1150",
	});
	await expect(bubble).toBeVisible();
	// Clear of the floating Files button, for the shot.
	await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
	await shot(page, isMobile, "bubbles");
	// Each code cell's text box: what is left of it inside its padding.
	const boxes = await codeCells(row).evaluateAll((cells) =>
		cells.map((td) => {
			const css = getComputedStyle(td);
			return (
				td.clientWidth -
				Number.parseFloat(css.paddingLeft) -
				Number.parseFloat(css.paddingRight)
			);
		}),
	);
	const [left = 0, right = 0] = boxes;
	if (isMobile) {
		// The right cell, with the thread, keeps as much room as the left,
		// without one: the bubble sits in the row under the pair row.
		expect(right).toBeGreaterThanOrEqual(left - 1);
		expect(right).toBeGreaterThanOrEqual(60);
		const bubbles = row.locator("xpath=following-sibling::tr[1]");
		await expect(bubbles).toHaveAttribute("data-testid", "bubble-row");
		await expect(bubbles.getByTestId("thread-bubble")).toHaveCount(1);
		await expect(codeCells(row).getByTestId("thread-bubble")).toHaveCount(0);
		// The bubble's touch target stays 40px.
		const box = await bubble.boundingBox();
		expect(box?.width).toBeGreaterThanOrEqual(40);
		expect(box?.height).toBeGreaterThanOrEqual(40);
	} else {
		// A wide screen keeps it in its cell, as before.
		await expect(section.getByTestId("bubble-row")).toHaveCount(0);
		await expect(
			codeCells(row).nth(1).getByTestId("thread-bubble"),
		).toHaveCount(1);
	}
	await bubble.click();
	await expect(bubble).toHaveAttribute("aria-expanded", "true");
	const opened = section.getByTestId("thread-row");
	await expect(opened).toContainText("Long one");
	await expect(bubble).toHaveAttribute(
		"aria-controls",
		(await opened.getAttribute("id")) ?? "",
	);
	await expectNoPageOverflow(page);
	await bubble.click();
	await expect(section.getByTestId("thread-row")).toHaveCount(0);
});

test("the Side by side switch keeps the row being read where it was", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, LONG);
	// Room below the file to scroll a row up to the sticky stack.
	await page.addStyleTag({ content: "main { padding-bottom: 200vh; }" });
	// Reading the new line 1,150: the added row, which side by side lays
	// out as one row with the removed line (found again by its new number).
	const row = section.locator('[data-testid="diff-line"][data-new-no="1150"]');
	await expect(row).toContainText("long 1150 changed");
	await underStack(row);
	const header = await section.locator("header").boundingBox();
	const stack = (header?.y ?? 0) + (header?.height ?? 0);
	const before = await rowTop(row);
	expect(Math.abs(before - stack)).toBeLessThanOrEqual(3);
	await setSwitch(page, "Side by side", true);
	await expect(section.locator("table")).toHaveAttribute(
		"data-view",
		"side-by-side",
	);
	expect(Math.abs((await rowTop(row)) - before)).toBeLessThan(2);
	await expectNoPageOverflow(page);
});

test("s and w flip Side by side and Ignore whitespace from the keyboard, the row being read where it was; ? lists them", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "no keyboard shortcuts on a phone");
	await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, LONG);
	await page.addStyleTag({ content: "main { padding-bottom: 200vh; }" });
	const row = section.locator('[data-testid="diff-line"][data-new-no="1150"]');
	await expect(row).toContainText("long 1150 changed");
	await underStack(row);
	const before = await rowTop(row);
	await page.keyboard.press("s");
	await expect(section.locator("table")).toHaveAttribute(
		"data-view",
		"side-by-side",
	);
	expect(Math.abs((await rowTop(row)) - before)).toBeLessThan(2);
	// The switch reads on, with its key beside the label; w's too.
	await page.getByRole("button", { name: "Settings" }).click();
	const split = page.getByRole("switch", { name: "Side by side" });
	await expect(split).toHaveAttribute("aria-checked", "true");
	await expect(split.locator("kbd")).toHaveText("s");
	const ws = page.getByRole("switch", { name: "Ignore whitespace" });
	await expect(ws).toHaveAttribute("aria-checked", "false");
	await expect(ws.locator("kbd")).toHaveText("w");
	await page.keyboard.press("Escape");
	await expect(split).toBeHidden();
	// w on the whitespace-only file (open alone now): its cluster collapses.
	const reindented = await expand(page, INDENT);
	await page.keyboard.press("w");
	await expect(reindented.getByTestId("ws-cluster")).toHaveCount(1);
	await page.getByRole("button", { name: "Settings" }).click();
	await expect(ws).toHaveAttribute("aria-checked", "true");
	await page.keyboard.press("Escape");
	await expect(ws).toBeHidden();
	// Back again from the keyboard.
	await page.keyboard.press("s");
	await expect(reindented.locator("table")).toHaveAttribute(
		"data-view",
		"unified",
	);
	await page.keyboard.press("w");
	await expect(reindented.getByTestId("ws-cluster")).toHaveCount(0);
	await expect(rows(reindented)).toHaveCount(16);
	// The help lists both under Files changed.
	await page.keyboard.press("Shift+Slash");
	const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
	await expect(help).toBeVisible();
	const files = help.getByRole("region", { name: "Files changed" });
	await expect(files).toContainText("Ignore whitespace");
	await expect(files).toContainText("Side by side");
	const entries = files.locator("li");
	await expect(
		entries.filter({ hasText: "Ignore whitespace" }).locator("kbd"),
	).toHaveText("w");
	await expect(
		entries.filter({ hasText: "Side by side" }).locator("kbd"),
	).toHaveText("s");
	await page.keyboard.press("Escape");
	await expect(help).toBeHidden();
	await expectNoPageOverflow(page);
});

test("a text selection stays on one side, and Copy gives that side only", async ({
	page,
	context,
	pr,
	startCrb,
	isMobile,
}) => {
	// Desktop project only: the phone project is Chromium too, but a native
	// touch selection (long-press, handles) isn't scriptable.
	test.skip(isMobile, "native touch selection isn't scriptable");
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await sideBySide(page, true);
	const section = await expand(page, GREET);
	await expect(table(section, "side-by-side")).toBeVisible();
	const cluster = pairs(section);
	await expect(cluster).toHaveCount(3);
	const cell = (i: number, side: "LEFT" | "RIGHT") =>
		cluster
			.nth(i)
			.locator(`td[data-testid="code"]`)
			.nth(side === "LEFT" ? 0 : 1);
	const newLines = ["greet 5 changed", "greet 6 changed", WIDE];
	const oldLines = ["greet 5", "greet 6"];
	/** Drags from the start of the first new line to a point in `to`. */
	const dragTo = async (to: Locator, at: "middle" | "end", steps = 12) => {
		const from = await cell(0, "RIGHT").boundingBox();
		const box = await to.boundingBox();
		if (!from || !box) throw new Error("a cell has no box");
		await page.mouse.move(from.x + 4, from.y + from.height / 2);
		await page.mouse.down();
		// A person's drag spans frames: the caret the mouse down placed sends
		// its (collapsed) selectionchange before the first move arrives.
		await page.evaluate(
			() =>
				new Promise((done) =>
					requestAnimationFrame(() => requestAnimationFrame(done)),
				),
		);
		await page.mouse.move(
			at === "middle" ? box.x + box.width / 2 : box.x + box.width - 4,
			at === "middle" ? box.y + box.height / 2 : box.y + box.height - 4,
			{ steps },
		);
		await page.mouse.up();
	};
	const selected = () => page.evaluate(() => getSelection()?.toString() ?? "");
	const copy = async () => {
		await page.keyboard.press("Control+C");
		return page.evaluate(() => navigator.clipboard.readText());
	};
	const lines = (text: string) => text.replace(/\n$/, "").split("\n");

	// Across the table, from the first row's new text to the third row's old
	// side: the old cells in between (one with text, one blank) are skipped.
	await dragTo(cell(2, "LEFT"), "middle");
	await expect(section.locator("table")).toHaveAttribute(
		"data-selecting",
		"new",
	);
	for (const line of oldLines)
		expect(lines(await selected())).not.toContain(line);
	expect(lines(await selected())).toEqual(newLines.slice(0, 2));
	// The pointer is up: Copy still gives one side.
	const across = await copy();
	for (const line of oldLines) expect(lines(across)).not.toContain(line);
	expect(lines(across)).toEqual(newLines.slice(0, 2));

	// To the end of the third row's new text: the new side's three lines, nothing else.
	await dragTo(cell(2, "RIGHT"), "end");
	expect(lines(await selected())).toEqual(newLines);
	expect(lines(await copy())).toEqual(newLines);

	// A click collapses the selection: the mark goes, both sides selectable again.
	await cell(1, "RIGHT").click();
	await expect(section.locator("table")).not.toHaveAttribute("data-selecting");
	await dragTo(cell(1, "LEFT"), "end");
	await expect(section.locator("table")).toHaveAttribute(
		"data-selecting",
		"new",
	);

	// A fast drag (one move) across to the second row's old text: the caret's
	// selectionchange must not have let the old side back in before the move,
	// so the selection's focus (what the Range says, not only its text) is on
	// the new side. (The third row's old cell is blank, with no side: it takes
	// the focus either way.)
	await cell(1, "RIGHT").click();
	await expect(section.locator("table")).not.toHaveAttribute("data-selecting");
	await dragTo(cell(1, "LEFT"), "middle", 1);
	await expect(section.locator("table")).toHaveAttribute(
		"data-selecting",
		"new",
	);
	expect(
		await page.evaluate(() => {
			const focus = getSelection()?.focusNode;
			const el = focus instanceof Element ? focus : focus?.parentElement;
			return el?.closest("td[data-side]")?.getAttribute("data-side");
		}),
	).toBe("RIGHT");
	expect(lines(await selected())).toEqual(newLines.slice(0, 1));
});

/** Threads the fake gh stores: where each one is anchored. */
function stored(p: Pr) {
	const s = JSON.parse(readFileSync(p.scenarioPath, "utf8")) as Scenario;
	return (s.prs[7]?.graphql?.reviewThreads ?? []) as {
		path: string;
		subjectType: string;
		line: number;
		originalStartLine: number | null;
		diffSide: string;
		startDiffSide: string | null;
	}[];
}

const selectionBar = (page: Page) => page.getByTestId("selection-bar");

test("side by side, a text selection dragged across the table comments on the new side's line", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "a mouse drag");
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await sideBySide(page, true);
	const section = await expand(page, GREET);
	await expect(table(section, "side-by-side")).toBeVisible();
	const cluster = pairs(section);
	await expect(cluster).toHaveCount(3);
	const cell = (i: number, side: "LEFT" | "RIGHT") =>
		codeCells(cluster.nth(i)).nth(side === "LEFT" ? 0 : 1);
	// From the start of the first pair's new text to the middle of the
	// second pair's old cell: the selection is the new side's first line.
	const from = await cell(0, "RIGHT").boundingBox();
	const to = await cell(1, "LEFT").boundingBox();
	if (!from || !to) throw new Error("a cell has no box");
	await page.mouse.move(from.x + 4, from.y + from.height / 2);
	await page.mouse.down();
	await page.evaluate(
		() =>
			new Promise((done) =>
				requestAnimationFrame(() => requestAnimationFrame(done)),
			),
	);
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
		steps: 12,
	});
	await page.mouse.up();
	await expect(section.locator("table")).toHaveAttribute(
		"data-selecting",
		"new",
	);
	expect(
		(await page.evaluate(() => getSelection()?.toString() ?? "")).trim(),
	).toBe("greet 5 changed");
	await expect(selectionBar(page)).toBeVisible();
	await selectionBar(page).getByRole("button", { name: "Comment" }).click();
	const composer = section.getByTestId("new-thread");
	await expect(composer).toContainText("line 5, new");
	await expect(composer.getByTestId("new-thread-quote")).toHaveText(
		"greet 5 changed",
	);
	const box = composer.getByRole("textbox", { name: "Comment" });
	await box.fill("Right side?");
	await box.press("Control+Enter");
	await expect(
		section.getByTestId("files-thread").filter({ hasText: "Right side?" }),
	).toBeVisible();
	// Painted on the new side's cell only.
	await expect(
		section.locator('td[data-testid="code"][data-commented]'),
	).toHaveCount(1);
	await expect(cell(0, "RIGHT")).toHaveAttribute("data-commented", "");
	await expect(cell(0, "LEFT")).not.toHaveAttribute("data-commented");
	expect(stored(p)).toMatchObject([
		{ path: GREET, line: 5, diffSide: "RIGHT" },
	]);
});

test("side by side, lines picked from an old number to a new one comment across sides", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await sideBySide(page, true);
	const section = await expand(page, GREET);
	await expect(table(section, "side-by-side")).toBeVisible();
	const cluster = pairs(section);
	await expect(cluster).toHaveCount(3);
	const oldFive = cluster.nth(0).getByTestId("old");
	const newSix = cluster.nth(1).getByTestId("new");
	if (isMobile) {
		// A second tap extends.
		await oldFive.tap();
		await newSix.tap();
	} else {
		await oldFive.click();
		await newSix.click({ modifiers: ["Shift"] });
	}
	// Both rows, every cell between the two numbers in the order shown.
	await expect(section.locator("tr[data-picked]")).toHaveCount(2);
	await expect(
		section.locator('td[data-testid="code"][data-picked]'),
	).toHaveCount(4);
	await expect(oldFive).toHaveAttribute("data-picked", "true");
	await expect(newSix).toHaveAttribute("data-picked", "true");
	await selectionBar(page).getByRole("button", { name: "Comment" }).click();
	await expect(section.locator("tr[data-picked]")).toHaveCount(0);
	const composer = section.getByTestId("new-thread");
	await expect(composer).toContainText("old 5 – new 6");
	// Under the pair row the range ends on.
	expect(
		await composer.evaluate((el) =>
			el.closest("tr")?.previousElementSibling?.getAttribute("data-new-no"),
		),
	).toBe("6");
	await composer.getByRole("textbox", { name: "Comment" }).fill("Both?");
	await composer.getByRole("button", { name: "Comment" }).click();
	await expect(
		section.getByTestId("files-thread").filter({ hasText: "Both?" }),
	).toBeVisible();
	// GitHub's range old 5 … new 6 covers both sides of both pairs.
	await expect(section.locator("tr[data-commented]")).toHaveCount(2);
	await expect(
		section.locator('td[data-testid="code"][data-commented]'),
	).toHaveCount(4);
	expect(stored(p)).toMatchObject([
		{
			path: GREET,
			line: 6,
			originalStartLine: 5,
			diffSide: "RIGHT",
			startDiffSide: "LEFT",
		},
	]);
	await expectNoPageOverflow(page);
});

test("side by side, a context row's old number picks its line, and the comment goes to GitHub on RIGHT", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "the desktop pick");
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await sideBySide(page, true);
	const section = await expand(page, GREET);
	await expect(table(section, "side-by-side")).toBeVisible();
	const context = section.locator('tr[data-kind="context"][data-old-no="4"]');
	const oldFour = context.getByTestId("old");
	await oldFour.click();
	await expect(oldFour.getByRole("button", { name: "Line 4" })).toBeFocused();
	// One line shown twice: both its cells are picked.
	await expect(
		context.locator('td[data-testid="code"][data-picked]'),
	).toHaveCount(2);
	await selectionBar(page).getByRole("button", { name: "Comment" }).click();
	const composer = section.getByTestId("new-thread");
	await composer.getByRole("textbox", { name: "Comment" }).fill("Context?");
	await composer.getByRole("button", { name: "Comment" }).click();
	await expect(
		section.getByTestId("files-thread").filter({ hasText: "Context?" }),
	).toBeVisible();
	expect(stored(p)).toMatchObject([
		{ path: GREET, line: 4, diffSide: "RIGHT" },
	]);
});

test("side by side, a pick anchored on a new number and extended to an old one goes to GitHub in its order", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await sideBySide(page, true);
	const section = await expand(page, GREET);
	await expect(table(section, "side-by-side")).toBeVisible();
	const cluster = pairs(section);
	await expect(cluster).toHaveCount(3);
	// New 5 first, then old 6 (the pair below's left side): shown that way
	// round it would be new 5 → old 6, which GitHub refuses as backwards;
	// in GitHub's order it is old 6 → new 5.
	const newFive = cluster.nth(0).getByTestId("new");
	const oldSix = cluster.nth(1).getByTestId("old");
	if (isMobile) {
		await newFive.tap();
		await oldSix.tap();
	} else {
		await newFive.click();
		await oldSix.click({ modifiers: ["Shift"] });
	}
	// Just the two lines, each on its own side.
	await expect(section.locator("tr[data-picked]")).toHaveCount(2);
	const pickedCells = section.locator('td[data-testid="code"][data-picked]');
	await expect(pickedCells).toHaveCount(2);
	await expect(pickedCells.nth(0)).toHaveAttribute("data-side", "RIGHT");
	await expect(pickedCells.nth(1)).toHaveAttribute("data-side", "LEFT");
	const comment = selectionBar(page).getByRole("button", { name: "Comment" });
	await expect(comment).not.toHaveAttribute("aria-disabled", "true");
	await comment.click();
	const composer = section.getByTestId("new-thread");
	await expect(composer).toContainText("old 6 – new 5");
	await composer.getByRole("textbox", { name: "Comment" }).fill("Either way");
	await composer.getByRole("button", { name: "Comment" }).click();
	await expect(
		section.getByTestId("files-thread").filter({ hasText: "Either way" }),
	).toBeVisible();
	await expect(
		section.locator('td[data-testid="code"][data-commented]'),
	).toHaveCount(2);
	expect(stored(p)).toMatchObject([
		{
			path: GREET,
			line: 5,
			originalStartLine: 6,
			diffSide: "RIGHT",
			startDiffSide: "LEFT",
		},
	]);
});

/** A locator's left and right edges (viewport px). */
const edges = async (locator: Locator) => {
	const b = await locator.boundingBox();
	if (!b) throw new Error("not rendered");
	return { left: b.x, right: b.x + b.width, width: b.width };
};

const sideShot = (page: Page, isMobile: boolean, name: string) =>
	shots
		? page.screenshot({
				path: `${shots}/thread-side-${name}-${isMobile ? "phone" : "desktop"}.png`,
			})
		: Promise.resolve();

test("side by side, an opened thread and the composer sit under their side", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	await sideBySide(page, true);
	const section = await expand(page, GREET);
	await expect(table(section, "side-by-side")).toBeVisible();
	const row6 = section.locator('tr[data-testid="diff-line"][data-new-no="6"]');
	const row5 = section.locator('tr[data-testid="diff-line"][data-old-no="5"]');
	const oldNo = await edges(row6.getByTestId("old"));
	const oldCode = await edges(codeCells(row6).nth(0));
	const newNo = await edges(row6.getByTestId("new"));
	const newCode = await edges(codeCells(row6).nth(1));
	// A card under its side: within the new number and code cells' edges
	// for a RIGHT one, within the old ones' for a LEFT one. On a phone it
	// spans the table, from before the old number to past the new one (half
	// of 360px is unreadable).
	const acrossTable = async (card: Locator) => {
		const c = await edges(card);
		expect(c.left).toBeLessThan(oldNo.left);
		expect(c.right).toBeGreaterThan(newNo.right);
	};
	const underRight = async (card: Locator) => {
		if (isMobile) return acrossTable(card);
		const c = await edges(card);
		expect(c.left).toBeGreaterThanOrEqual(newNo.left - 1);
		expect(c.right).toBeLessThanOrEqual(newCode.right + 1);
	};
	const underLeft = async (card: Locator) => {
		if (isMobile) return acrossTable(card);
		const c = await edges(card);
		expect(c.left).toBeGreaterThanOrEqual(oldNo.left - 1);
		expect(c.right).toBeLessThanOrEqual(oldCode.right + 1);
	};
	/** The numbers of the line row a card's row sits under (past any thread rows). */
	const lineAbove = (card: Locator) =>
		card.evaluate((el) => {
			let row = el.closest("tr")?.previousElementSibling ?? null;
			while (row && row.getAttribute("data-testid") !== "diff-line") {
				row = row.previousElementSibling;
			}
			return [
				row?.getAttribute("data-old-no"),
				row?.getAttribute("data-new-no"),
			];
		});

	// The thread on new 6, under the right side.
	await bubblesOf(row6, "RIGHT", isMobile).click();
	const rightRow = section.getByTestId("thread-row");
	await expect(rightRow).toHaveCount(1);
	const rightCard = rightRow.getByTestId("files-thread");
	await expect(rightCard).toContainText("New six");
	await underRight(rightCard);
	await expect(rightRow.getByTestId("thread-rail")).toHaveClass(
		/bg-unreviewed/,
	);
	await sideShot(page, isMobile, "right");

	// The thread on old 5, under the left side, above the first.
	await bubblesOf(row5, "LEFT", isMobile).click();
	const rows = section.getByTestId("thread-row");
	await expect(rows).toHaveCount(2);
	const leftCard = rows.nth(0).getByTestId("files-thread");
	await expect(leftCard).toContainText("Old five");
	await underLeft(leftCard);
	await underRight(rows.nth(1).getByTestId("files-thread"));
	await sideShot(page, isMobile, "left");

	// A comment started on a right-side line: its composer under the right;
	// one on an old line under the left.
	const comment = () =>
		selectionBar(page).getByRole("button", { name: "Comment" }).click();
	if (isMobile) await row6.getByTestId("new").tap();
	else await row6.getByTestId("new").click();
	await comment();
	const composers = section.getByTestId("new-thread");
	await expect(composers).toHaveCount(1);
	await underRight(composers.nth(0));
	expect(await lineAbove(composers.nth(0))).toEqual(["6", "6"]);
	if (isMobile) await row5.getByTestId("old").tap();
	else await row5.getByTestId("old").click();
	await comment();
	await expect(composers).toHaveCount(2);
	// Under row 5 (first in the table), after its opened thread.
	await underLeft(composers.nth(0));
	expect(await lineAbove(composers.nth(0))).toEqual(["5", "5"]);
	await underRight(composers.nth(1));
	expect(await lineAbove(composers.nth(1))).toEqual(["6", "6"]);
	await sideShot(page, isMobile, "composer");
	await expectNoPageOverflow(page);
});

test("side by side, a cluster's floating controls stop above a thread opened under the right side", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	const lines = Array.from({ length: 80 }, (_, i) => `x ${i + 1}`);
	const p = await pr({
		base: { [LONG]: text(lines) },
		files: [
			{
				message: "long",
				files: {
					[LONG]: text(
						lines.map((l, i) => (i >= 5 && i < 65 ? `${l} changed` : l)),
					),
				},
			},
		],
	});
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((sc) => {
		const graph = sc.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: LONG, line: 15, subjectType: "LINE" }, [
				threadComment({ login: "rev1", text: "Midway", commit: head }),
			]),
		];
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	await sideBySide(page, true);
	const section = await expand(page, LONG);
	await expect(table(section, "side-by-side")).toBeVisible();
	const row15 = section.locator(
		'tr[data-testid="diff-line"][data-new-no="15"]',
	);
	// On a phone the bubble is in the bubble row under row 15: the controls
	// pass it by and still stop at the thread's row.
	await bubblesOf(row15, "RIGHT", isMobile).click();
	const threadRow = section.getByTestId("thread-row");
	await expect(threadRow.getByTestId("thread-comment")).toHaveCount(1);
	const newNo = await edges(row15.getByTestId("new"));
	const card = await edges(threadRow.getByTestId("files-thread"));
	if (!isMobile) expect(card.left).toBeGreaterThanOrEqual(newNo.left - 1);
	// Scroll so the thread's row is just under the file header (the stack
	// above compacts on the way, so correct until it is): too close for
	// the controls to float there, they ride up and stop above it.
	await expect
		.poll(() =>
			threadRow.evaluate((el) => {
				const header = el.closest("section")?.querySelector("header");
				const top = header?.getBoundingClientRect().bottom ?? 0;
				const off = el.getBoundingClientRect().top - top - 4;
				if (Math.abs(off) > 1) window.scrollBy(0, off);
				return Math.abs(off);
			}),
		)
		.toBeLessThanOrEqual(1);
	await page.evaluate(
		() =>
			new Promise<void>((done) =>
				requestAnimationFrame(() => requestAnimationFrame(() => done())),
			),
	);
	const controls = section.locator("[data-sticky-controls]").first();
	await expect(controls).toHaveAttribute("data-stuck", "end");
	const c = await controls.boundingBox();
	const t = await threadRow.boundingBox();
	if (!c || !t) throw new Error("not rendered");
	expect(c.y + c.height).toBeLessThanOrEqual(t.y);
	await expectNoPageOverflow(page);
});

test("side by side, Up/Down on the number buttons stay in their column and Left/Right switch sides, Shift extending", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "no keyboard on a phone");
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await sideBySide(page, true);
	const section = await expand(page, GREET);
	await expect(table(section, "side-by-side")).toBeVisible();
	const cluster = pairs(section);
	await expect(cluster).toHaveCount(3);
	const button = (name: string) =>
		section.getByRole("button", { name, exact: true });
	// A click on old 5 picks it and puts its button in focus.
	await cluster.nth(0).getByTestId("old").click();
	await expect(button("Old line 5")).toBeFocused();
	// Down: the next old line, not this row's new one.
	await page.keyboard.press("ArrowDown");
	await expect(button("Old line 6")).toBeFocused();
	// Right: the same row's new number; Left: back.
	await page.keyboard.press("ArrowRight");
	await expect(button("Line 6")).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(button("Old line 6")).toBeFocused();
	// Down from old 6: the third pair has no old line (new 7 alone), so on
	// to the context row's old number (old 7 / new 8, one line named by its
	// new number); Right is its new one; Up from there comes back to old 6.
	const context = section.locator('tr[data-kind="context"][data-old-no="7"]');
	await page.keyboard.press("ArrowDown");
	await expect(context.getByTestId("old").getByRole("button")).toBeFocused();
	await expect(
		context.getByTestId("old").getByRole("button"),
	).toHaveAccessibleName("Line 8");
	await page.keyboard.press("ArrowRight");
	await expect(context.getByTestId("new").getByRole("button")).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("ArrowUp");
	await expect(button("Old line 6")).toBeFocused();
	// Shift+Right extends the pick across, old 5 → new 6 in GitHub's
	// order: both old lines and both new ones.
	await page.keyboard.press("Shift+ArrowRight");
	await expect(button("Line 6")).toBeFocused();
	const picked = section.locator('td[data-testid="code"][data-picked]');
	await expect(picked).toHaveCount(4);
	await expect(picked.nth(0)).toHaveAttribute("data-side", "LEFT");
	await expect(picked.nth(3)).toHaveAttribute("data-side", "RIGHT");
	await expect(selectionBar(page)).toBeVisible();
	await expect(
		selectionBar(page).getByRole("button", { name: "Comment" }),
	).not.toHaveAttribute("aria-disabled", "true");
	await expectNoPageOverflow(page);
});

test("side by side, the file bubble sits in the first row's right cell (a pair row once the gap above is loaded) and the pick bar by the side picked", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await sideBySide(page, true);
	const section = await expand(page, GREET);
	await expect(table(section, "side-by-side")).toBeVisible();
	// The diff's first row is the hidden line 1's gap row: the bubble is there.
	const bubble = section.getByRole("button", { name: "Comment on file" });
	await expect(section.getByTestId("gap-row").first()).toContainText(
		"1 hidden line",
	);
	await expect(
		section.getByTestId("gap-row").first().getByTestId("thread-bubble"),
	).toHaveAccessibleName("Comment on file");
	// Loaded, the first row is line 1's pair row: the bubble in its right cell.
	await section.getByRole("button", { name: "Load 1 line above" }).click();
	const first = rows(section).first();
	await expect(first).toHaveAttribute("data-new-no", "1");
	await expect(first).toHaveAttribute("data-kind", "context");
	// The gap above is gone; the one left is below the hunk, without the bubble.
	await expect(section.getByTestId("gap-row")).toHaveCount(1);
	await expect(
		section.getByTestId("gap-row").getByTestId("thread-bubble"),
	).toHaveCount(0);
	// (On a phone, the right of the bubble row under it.)
	await expect(bubblesOf(first, "RIGHT", isMobile)).toHaveAccessibleName(
		"Comment on file",
	);
	await expect(bubblesOf(first, "LEFT", isMobile)).toHaveCount(0);
	await expect(codeCells(first).getByTestId("thread-bubble")).toHaveCount(
		isMobile ? 0 : 1,
	);
	// Its row opens right under the pair row (and its bubble row), across
	// all six columns.
	await bubble.click();
	const fileRow = section.getByTestId("file-threads");
	await expect(fileRow).toBeVisible();
	expect(await under(first, isMobile)).toBe("file-threads");
	expect(await fileRow.evaluate((el) => el.querySelector("td")?.colSpan)).toBe(
		6,
	);
	const composer = section.getByTestId("new-thread");
	await expect(composer).toContainText("whole file");
	// Across the row while written, as the thread is once posted (not in
	// the left half): all but the rail and controls columns and the card's
	// padding.
	const tableBox = await table(section, "side-by-side").boundingBox();
	const written = await composer.boundingBox();
	if (!tableBox || !written) throw new Error("no geometry");
	expect(written.width).toBeGreaterThanOrEqual(tableBox.width - 64);
	await composer.getByRole("textbox", { name: "Comment" }).fill("The file?");
	await composer.getByRole("button", { name: "Comment" }).click();
	await expect(section.getByTestId("new-thread")).toHaveCount(0);
	await expect(
		section.getByRole("button", { name: /1 comment on this file/ }),
	).toHaveAttribute("aria-expanded", "true");
	const posted = fileRow
		.getByTestId("files-thread")
		.filter({ hasText: "The file?" });
	await expect(posted).toBeVisible();
	const saved = await posted.boundingBox();
	if (!saved) throw new Error("no geometry");
	expect(saved.x).toBeCloseTo(written.x, 0);
	expect(saved.width).toBeCloseTo(written.width, 0);
	expect(stored(p)).toMatchObject([{ path: GREET, subjectType: "FILE" }]);
	await expectNoPageOverflow(page);
	// A pick on an old number: the bar sits by the left side, just right of
	// the old number (never over a number column); on a new number, just
	// right of the new number. On a phone it stays on screen.
	const pair = pairs(section).nth(0);
	const oldFive = pair.getByTestId("old");
	const newFive = pair.getByTestId("new");
	await oldFive.scrollIntoViewIfNeeded();
	if (isMobile) {
		for (const number of [oldFive, newFive]) {
			await number.tap();
			await expect(selectionBar(page)).toBeVisible();
			const bar = await selectionBar(page).boundingBox();
			const width = page.viewportSize()?.width ?? 0;
			if (!bar) throw new Error("no geometry");
			expect(bar.x).toBeGreaterThanOrEqual(0);
			expect(bar.x + bar.width).toBeLessThanOrEqual(width);
			await expectNoPageOverflow(page);
			await page.keyboard.press("Escape");
			await expect(selectionBar(page)).toBeHidden();
		}
		return;
	}
	const row = await pair.boundingBox();
	const oldNumber = await oldFive.boundingBox();
	const newNumber = await newFive.boundingBox();
	if (!row || !oldNumber || !newNumber) throw new Error("no geometry");
	const barBox = async () => {
		await expect(selectionBar(page)).toBeVisible();
		const bar = await selectionBar(page).boundingBox();
		if (!bar) throw new Error("no geometry");
		expect(bar.y).toBeGreaterThanOrEqual(row.y + row.height);
		expect(bar.y).toBeLessThanOrEqual(row.y + 2 * row.height);
		return bar;
	};
	await oldFive.click();
	const left = await barBox();
	expect(left.x).toBeGreaterThanOrEqual(oldNumber.x + oldNumber.width);
	expect(left.x).toBeLessThanOrEqual(oldNumber.x + oldNumber.width + 8);
	expect(left.x + left.width).toBeLessThanOrEqual(newNumber.x);
	// The same row's new number: the bar moves to the right side.
	await newFive.click();
	const right = await barBox();
	expect(right.x).toBeGreaterThanOrEqual(newNumber.x + newNumber.width);
	expect(right.x).toBeLessThanOrEqual(newNumber.x + newNumber.width + 8);
	// Extended from the new number back to an old one: by the left again.
	await pairs(section)
		.nth(1)
		.getByTestId("old")
		.click({ modifiers: ["Shift"] });
	await expect(section.locator("tr[data-picked]")).toHaveCount(2);
	await expect(async () => {
		const bar = await selectionBar(page).boundingBox();
		expect(bar?.x).toBeGreaterThanOrEqual(oldNumber.x + oldNumber.width);
		expect(bar?.x).toBeLessThanOrEqual(oldNumber.x + oldNumber.width + 8);
	}).toPass();
	// A context line by its old number (a RIGHT line to GitHub): by the left.
	const context = section.locator(
		'[data-testid="diff-line"][data-kind="context"][data-new-no="4"]',
	);
	const contextOld = context.getByTestId("old");
	await contextOld.click();
	await expect(section.locator("tr[data-picked]")).toHaveCount(1);
	await expect(context).toHaveAttribute("data-picked", "true");
	const contextNumbers = {
		old: await contextOld.boundingBox(),
		new: await context.getByTestId("new").boundingBox(),
	};
	if (!contextNumbers.old || !contextNumbers.new) {
		throw new Error("no geometry");
	}
	const { old: cOld, new: cNew } = contextNumbers;
	await expect(async () => {
		const bar = await selectionBar(page).boundingBox();
		if (!bar) throw new Error("no bar");
		expect(bar.x).toBeGreaterThanOrEqual(cOld.x + cOld.width);
		expect(bar.x).toBeLessThanOrEqual(cOld.x + cOld.width + 8);
		expect(bar.x + bar.width).toBeLessThanOrEqual(cNew.x);
	}).toPass();
});
