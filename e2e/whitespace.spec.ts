import type { Locator, Page } from "@playwright/test";
import {
	REINDENT_NEW,
	REINDENT_OLD,
	WRAP_ADDED,
	WRAP_NEW,
	WRAP_OLD,
	WRAP_REMOVED,
} from "../test/whitespace-fixture";
import {
	fileSection,
	ignoreWhitespace,
	openFiles,
	progress,
	rowTop,
	sideBySide,
	underStack,
} from "./files-ui";
import { expect, type PrOptions, test } from "./fixtures";

const indent = Array.from({ length: 8 }, (_, i) => `indent ${i + 1}`);
const mixed = Array.from({ length: 10 }, (_, i) => `mixed ${i + 1}`);
const text = (lines: string[]) => `${lines.join("\n")}\n`;

/**
 * Ten clusters: src/indent.ts re-indented wholesale (1), src/mixed.ts with
 * lines 3–6 re-indented and line 4 really changed (1), src/crlf.txt from
 * CRLF to LF (1), src/reindent.ts a re-indent git splits over context lines
 * (5), src/wrap.ts a loop wrapped in an `if` (2).
 */
const fixture: PrOptions = {
	base: {
		"src/indent.ts": text(indent),
		"src/mixed.ts": text(mixed),
		"src/crlf.txt": "one\r\ntwo\r\nthree\r\n",
		"src/reindent.ts": REINDENT_OLD,
		"src/wrap.ts": WRAP_OLD,
	},
	files: [
		{
			message: "Whitespace",
			files: {
				"src/indent.ts": text(indent.map((l) => `  ${l}`)),
				"src/mixed.ts": text(
					mixed.map((l, i) =>
						i < 2 || i > 5 ? l : i === 3 ? "\tmixed 4 changed" : `\t${l}`,
					),
				),
				"src/crlf.txt": "one\ntwo\nthree\n",
				"src/reindent.ts": REINDENT_NEW,
				"src/wrap.ts": WRAP_NEW,
			},
		},
	],
};

const rows = (section: Locator, kind: string) =>
	section.locator(`[data-testid="diff-line"][data-kind="${kind}"]`);

async function expand(page: Page, path: string) {
	const section = fileSection(page, path);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.locator("table")).toBeVisible();
	return section;
}

/** DESIGN_SHOTS=<dir>: also save whitespace-{desktop,phone}-{collapsed,open,mixed}.png there. */
const shots = process.env.DESIGN_SHOTS;
const shot = (page: Page, name: string, isMobile: boolean) =>
	shots
		? page.screenshot({
				path: `${shots}/whitespace-${isMobile ? "phone" : "desktop"}-${name}.png`,
			})
		: Promise.resolve();

const overflow = (page: Page) =>
	page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);

test("Ignore whitespace pairs whitespace-only lines and collapses whitespace-only clusters", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const bar = progress(page);
	await expect(bar).toContainText("0 / 10 clusters");

	// Off: plain add/del rows, as always.
	let section = await expand(page, "src/indent.ts");
	await expect(rows(section, "del")).toHaveCount(8);
	await expect(rows(section, "add")).toHaveCount(8);
	await expect(rows(section, "ws")).toHaveCount(0);
	await expect(section.getByTestId("ws-cluster")).toHaveCount(0);
	const counts = section.getByTestId("change-count");
	await expect(counts).toContainText("+8");
	await expect(counts).toContainText("−8");

	// On: the re-indented file is one collapsed row with the cluster's
	// controls; the counts don't move.
	await ignoreWhitespace(page, true);
	const collapsed = section.getByTestId("ws-cluster");
	await expect(collapsed).toHaveCount(1);
	await expect(collapsed).toContainText("Whitespace only · 16 lines");
	await expect(section.getByTestId("diff-line")).toHaveCount(0);
	await expect(counts).toContainText("+8");
	await expect(counts).toContainText("−8");
	// The chevron and the words are one disclosure button, named by its
	// text; clicking the words opens the rows.
	const show = collapsed.getByRole("button", {
		name: "Whitespace only · 16 lines",
	});
	await expect(show).toHaveAttribute("aria-expanded", "false");
	await expect(show).toHaveAttribute("aria-controls", /./);
	if (isMobile) {
		expect((await show.boundingBox())?.height).toBeGreaterThanOrEqual(40);
		expect((await show.boundingBox())?.width).toBeGreaterThanOrEqual(40);
	}
	await shot(page, "collapsed", isMobile);
	await show.getByText("Whitespace only · 16 lines").click();
	await expect(show).toHaveAttribute("aria-expanded", "true");
	await expect(collapsed).toHaveAttribute("data-expanded", "true");
	await expect(rows(section, "ws")).toHaveCount(8);
	await shot(page, "open", isMobile);
	await expect(rows(section, "add")).toHaveCount(0);
	await expect(rows(section, "del")).toHaveCount(0);
	const third = rows(section, "ws").nth(2);
	await expect(third).toHaveAttribute("data-old-no", "3");
	await expect(third).toHaveAttribute("data-new-no", "3");
	await expect(third).toContainText("indent 3");
	await expect(
		third.getByRole("img", { name: "Whitespace only" }),
	).toBeAttached();
	// The chevron collapses them again.
	await show.locator("svg").click();
	await expect(show).toHaveAttribute("aria-expanded", "false");
	await expect(collapsed).not.toHaveAttribute("data-expanded");
	await expect(section.getByTestId("diff-line")).toHaveCount(0);
	expect(await overflow(page)).toBeLessThanOrEqual(0);

	// Reviewed from the collapsed row: progress moves by one cluster.
	const box = collapsed.getByRole("checkbox", {
		name: "Mark cluster reviewed",
	});
	await expect(box).not.toBeChecked();
	await box.click();
	await expect(box).toBeChecked();
	await expect(collapsed).toHaveAttribute("data-reviewed", "true");
	await expect(bar).toContainText("1 / 10 clusters reviewed");

	// A mixed cluster keeps its real change as add/del rows among the
	// whitespace-only ones.
	section = await expand(page, "src/mixed.ts");
	await expect(section.getByTestId("ws-cluster")).toHaveCount(0);
	await expect(rows(section, "ws")).toHaveCount(3);
	await expect(rows(section, "del")).toHaveCount(1);
	await expect(rows(section, "del")).toContainText("mixed 4");
	await expect(rows(section, "add")).toHaveCount(1);
	await expect(rows(section, "add")).toContainText("mixed 4 changed");
	await expect(
		section.getByRole("checkbox", { name: "Mark cluster reviewed" }),
	).toHaveCount(1);
	await expect(section.getByTestId("change-count")).toContainText("+4");
	await expect(section.getByTestId("change-count")).toContainText("−4");
	expect(await overflow(page)).toBeLessThanOrEqual(0);
	await shot(page, "mixed", isMobile);

	// CRLF to LF is whitespace only.
	section = await expand(page, "src/crlf.txt");
	await expect(section.getByTestId("ws-cluster")).toContainText(
		"Whitespace only · 6 lines",
	);

	// A re-indent git split over context lines (five clusters): nothing
	// but whitespace, as `git diff -w` shows.
	section = await expand(page, "src/reindent.ts");
	await expect(section.getByTestId("ws-cluster")).toHaveCount(5);
	await expect(rows(section, "add")).toHaveCount(0);
	await expect(rows(section, "del")).toHaveCount(0);
	await expect(section.getByTestId("change-count")).toContainText("+15");
	await expect(section.getByTestId("change-count")).toContainText("−15");
	expect(await overflow(page)).toBeLessThanOrEqual(0);

	// A loop wrapped in an `if`: the `if`, its `}` and the `log` line that
	// crossed an unchanged `}` stay changes; the body is whitespace-only.
	section = await expand(page, "src/wrap.ts");
	await expect(rows(section, "add")).toHaveCount(WRAP_ADDED.length);
	for (const [i, text] of WRAP_ADDED.entries()) {
		await expect(rows(section, "add").nth(i)).toContainText(text.trim());
	}
	await expect(rows(section, "del")).toHaveCount(1);
	await expect(rows(section, "del")).toContainText(
		(WRAP_REMOVED[0] as string).trim(),
	);
	await expect(rows(section, "ws")).toHaveCount(6);
	await expect(section.locator('[data-ws="pair"]')).toHaveCount(6);
	await expect(section.getByTestId("ws-cluster")).toHaveCount(0);

	// Off again: the mixed file shows every line as it is.
	await ignoreWhitespace(page, false);
	section = await expand(page, "src/mixed.ts");
	await expect(rows(section, "del")).toHaveCount(4);
	await expect(rows(section, "add")).toHaveCount(4);
	await expect(rows(section, "ws")).toHaveCount(0);
	await expect(bar).toContainText("1 / 10 clusters reviewed");
});

test("the Ignore whitespace switch keeps the row being read where it was", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	// Room below the last file to scroll a row up to the sticky stack and
	// keep it there once the rows above it change.
	await page.addStyleTag({ content: "main { padding-bottom: 200vh; }" });

	// The mixed cluster: reading the added `mixed 6`, three rows up once
	// the whitespace-only lines pair up (it becomes the ~ row of line 6,
	// a new row the browser's own scroll anchoring loses track of).
	let section = await expand(page, "src/mixed.ts");
	const added = section.locator('[data-testid="diff-line"][data-new-no="6"]');
	await expect(added).toHaveAttribute("data-kind", "add");
	await underStack(added);
	const header = await section.locator("header").boundingBox();
	const stack = (header?.y ?? 0) + (header?.height ?? 0);
	const before = await rowTop(added);
	expect(Math.abs(before - stack)).toBeLessThanOrEqual(3);
	await ignoreWhitespace(page, true);
	await expect(added).toHaveAttribute("data-kind", "ws");
	expect(Math.abs((await rowTop(added)) - before)).toBeLessThan(2);
	// And back: the ~ row of line 6 is found again as the removed line
	// (the old number first), where the ~ row was.
	await ignoreWhitespace(page, false);
	const removed = section.locator(
		'[data-testid="diff-line"][data-old-no="6"]:not([data-new-no])',
	);
	await expect(removed).toHaveAttribute("data-kind", "del");
	expect(Math.abs((await rowTop(removed)) - before)).toBeLessThan(2);

	// A context row between clusters that collapse: put too.
	section = await expand(page, "src/reindent.ts");
	const context = section
		.getByTestId("diff-line")
		.filter({ hasText: /export function average/ });
	await expect(context).toHaveAttribute("data-old-no", "18");
	await underStack(context);
	const contextBefore = await rowTop(context);
	await ignoreWhitespace(page, true);
	await expect(section.getByTestId("ws-cluster")).toHaveCount(5);
	expect(Math.abs((await rowTop(context)) - contextBefore)).toBeLessThan(2);
	expect(await overflow(page)).toBeLessThanOrEqual(0);
});

/** A 120-line file re-indented wholesale: one whitespace-only cluster. */
const long = Array.from({ length: 120 }, (_, i) => `long ${i + 1}`);
const longFixture: PrOptions = {
	base: { "src/long.ts": text(long) },
	files: [
		{
			message: "Re-indent",
			files: { "src/long.ts": text(long.map((l) => `    ${l}`)) },
		},
	],
};

test("an expanded whitespace-only cluster's controls float below the file header", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(longFixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await ignoreWhitespace(page, true);
	const section = await expand(page, "src/long.ts");
	const collapsed = section.getByTestId("ws-cluster");
	await collapsed
		.getByRole("button", { name: "Whitespace only · 240 lines" })
		.click();
	await expect(rows(section, "ws")).toHaveCount(120);
	await rows(section, "ws")
		.filter({ hasText: /long 90$/ })
		.scrollIntoViewIfNeeded();
	await expect(collapsed).not.toBeInViewport();
	const checkbox = section.getByRole("checkbox", {
		name: "Mark cluster reviewed",
	});
	await expect(checkbox).toBeInViewport();
	await expect(section.locator("[data-stuck]")).toHaveCount(1);
	// Directly below the file header, as any long cluster's.
	const header = await section.locator("header").boundingBox();
	const target = await section.getByTestId("cluster-box-target").boundingBox();
	expect(target?.y).toBeGreaterThanOrEqual(
		(header?.y ?? 0) + (header?.height ?? 0) - 1,
	);
	if (isMobile) expect(target?.height).toBeGreaterThanOrEqual(40);
	// Still operable there.
	await checkbox.click();
	await expect(checkbox).toBeChecked();
	await expect(progress(page)).toContainText("1 / 1 cluster reviewed");
	expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test("copying across a collapsed whitespace-only cluster takes the code alone: no cross-off, no words, in both views", async ({
	page,
	context,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "a mouse drag and a keyboard copy");
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await ignoreWhitespace(page, true);
	const section = await expand(page, "src/reindent.ts");
	await expect(section.getByTestId("ws-cluster")).toHaveCount(5);
	/** The RIGHT code cell of the context row numbered `n`. */
	const cell = (n: number) =>
		section.locator(
			`tr[data-testid="diff-line"][data-new-no="${n}"] > td[data-testid="code"][data-side="RIGHT"]`,
		);
	/** Drags from the start of line 1's text to the end of line 5's. */
	const copyAcross = async () => {
		// A press on selected text would drag it: start from none.
		await page.evaluate(() => getSelection()?.removeAllRanges());
		const from = await cell(1).boundingBox();
		const to = await cell(5).boundingBox();
		if (!from || !to) throw new Error("a cell has no box");
		await page.mouse.move(from.x + 4, from.y + from.height / 2);
		await page.mouse.down();
		await page.evaluate(
			() =>
				new Promise((done) =>
					requestAnimationFrame(() => requestAnimationFrame(done)),
				),
		);
		await page.mouse.move(to.x + to.width - 4, to.y + to.height / 2, {
			steps: 12,
		});
		await page.mouse.up();
		await page.keyboard.press("Control+C");
		return page.evaluate(() => navigator.clipboard.readText());
	};
	for (const view of ["unified", "side-by-side"] as const) {
		if (view === "side-by-side") await sideBySide(page, true);
		await expect(section.locator("table")).toHaveAttribute("data-view", view);
		// The first cluster's row (its controls and words) lies between them.
		const copied = await copyAcross();
		expect(copied, view).toContain("export interface Item {");
		expect(copied, view).toContain("}");
		expect(copied, view).not.toContain("⊘");
		expect(copied, view).not.toContain("Whitespace only");
	}
});
