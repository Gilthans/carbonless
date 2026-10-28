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
const table = (section: Locator, view: "unified" | "side-by-side") =>
	section.locator(`table[data-view="${view}"]`);

async function expand(page: Page, path: string) {
	const section = fileSection(page, path);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(rows(section).first()).toBeVisible();
	return section;
}

/** DESIGN_SHOTS=<dir>: also save side-by-side-{desktop,phone}.png there. */
const shots = process.env.DESIGN_SHOTS;
const shot = (page: Page, isMobile: boolean) =>
	shots
		? page.screenshot({
				path: `${shots}/side-by-side-${isMobile ? "phone" : "desktop"}.png`,
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

	// A thread's bubble is in the cell of its side; it opens under the pair.
	const row6 = section.locator('tr[data-testid="diff-line"][data-new-no="6"]');
	await expect(row6).toHaveAttribute("data-old-no", "6");
	const bubble = codeCells(row6).nth(1).getByTestId("thread-bubble");
	await expect(bubble).toHaveAccessibleName("1 comment on line 6");
	await expect(codeCells(row6).nth(1)).toHaveAttribute("data-commented", "");
	await expect(codeCells(row6).nth(1)).toHaveClass(/thread-mark-cell/);
	// The old side of the pair has no thread: no bubble and no mark there.
	await expect(codeCells(row6).nth(0).getByTestId("thread-bubble")).toHaveCount(
		0,
	);
	await expect(codeCells(row6).nth(0)).not.toHaveAttribute("data-commented");
	await expect(codeCells(row6).nth(0)).not.toHaveClass(/thread-mark-cell/);
	await expect(row6.getByTestId("old")).not.toHaveClass(/thread-mark-cell/);
	const row5 = section.locator('tr[data-testid="diff-line"][data-old-no="5"]');
	await expect(
		codeCells(row5).nth(0).getByTestId("thread-bubble"),
	).toHaveAccessibleName("1 comment on old line 5");
	await bubble.click();
	const threadRow = section.getByTestId("thread-row");
	await expect(threadRow).toHaveCount(1);
	await expect(threadRow).toContainText("New six");
	expect(
		await row6.evaluate((tr) =>
			tr.nextElementSibling?.getAttribute("data-testid"),
		),
	).toBe("thread-row");

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
	// and two four-digit number cells, in two equal halves: 80px each at 360px.
	const widths = await codeCells(row).evaluateAll((cells) =>
		cells.map((td) => td.getBoundingClientRect().width),
	);
	expect(widths).toHaveLength(2);
	expect(Math.abs((widths[0] ?? 0) - (widths[1] ?? 0))).toBeLessThanOrEqual(1);
	for (const width of widths) expect(width).toBeGreaterThanOrEqual(80);
	// The controls keep their touch targets.
	const target = await section.getByTestId("cluster-box-target").boundingBox();
	if (isMobile) {
		expect(target?.width).toBeGreaterThanOrEqual(40);
		expect(target?.height).toBeGreaterThanOrEqual(40);
	}
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
