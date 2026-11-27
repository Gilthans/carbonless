import type { Locator, Page } from "@playwright/test";
import {
	expectNoPageOverflow,
	fileSection,
	marksReady,
	openFiles,
	tapHeight,
} from "./files-ui";
import { expect, test } from "./fixtures";
import { GREEN, png as pngImage, RED } from "./images";

/*
 * The view switch's bar stays pinned under its file's sticky header while
 * the file is on screen, so the reviewer can swap mid-file; the swap keeps
 * the reader's place (CAR-317). Full diff, since view, image toolbar.
 */

const DOC = "docs/long.md";
const PNG = "img/tall.png";
const GIT_WAIT = { timeout: 30_000 };

/** Paragraphs, every third one changed by the PR; a long changed code block at the end. */
const paras = (changed: boolean, again = false) =>
	Array.from({ length: 90 }, (_, i) =>
		changed && i % 3 === 0
			? `Para ${i + 1} edited${again ? " again" : ""}.`
			: `Para ${i + 1} stays.`,
	);
const code = (changed: boolean) =>
	Array.from({ length: 60 }, (_, i) =>
		changed ? `const v${i} = ${i} + 1;` : `const v${i} = ${i};`,
	);
const doc = (changed: boolean, again = false) =>
	`# Long\n\n${paras(changed, again).join("\n\n")}\n\n\`\`\`ts\n${code(changed).join("\n")}\n\`\`\`\n`;

const fixture = {
	base: { [DOC]: doc(false) },
	files: [{ message: "edit", files: { [DOC]: doc(true) } }],
};

const viewButton = (section: Locator, name: string) =>
	section
		.getByRole("group", { name: "View" })
		.getByRole("button", { name, exact: true });
const shownAs = (section: Locator, renderer: string) =>
	expect(section).toHaveAttribute("data-renderer", renderer);
const header = (section: Locator) => section.locator(":scope > header");
const bar = (section: Locator) => section.locator("[data-view-bar]");
const bottomOf = async (el: Locator) => {
	const b = await el.boundingBox();
	if (!b) throw new Error("not rendered");
	return b.y + b.height;
};
const topOf = async (el: Locator) => {
	const b = await el.boundingBox();
	if (!b) throw new Error("not rendered");
	return b.y;
};

/** Rendered's one-line block showing `text`, or Text's row. */
const renderedRow = (section: Locator, text: string) =>
	section.locator("[data-new-lines]").filter({ hasText: text });
const textRow = (section: Locator, text: string) =>
	section.getByTestId("diff-line").filter({ hasText: text });

/**
 * Scrolls `row` to just under the stuck header and view bar (its top 2px
 * above their bottom: it is the row being read). Polled, as the stack
 * settles over a few frames (the app header compacts).
 */
async function readAt(section: Locator, row: Locator) {
	await row.scrollIntoViewIfNeeded();
	await expect
		.poll(async () => {
			const stack = await bottomOf(bar(section));
			const delta = (await topOf(row)) - stack + 2;
			if (Math.abs(delta) >= 1)
				await row.page().evaluate((d) => window.scrollBy(0, d), delta);
			return Math.abs(delta);
		})
		.toBeLessThan(1);
}

/** The bar sits right under the header: no gap, never over its buttons. */
async function pinned(section: Locator) {
	await expect
		.poll(async () =>
			Math.abs((await topOf(bar(section))) - (await bottomOf(header(section)))),
		)
		.toBeLessThan(1.5);
	// Pinned, not merely at the file's top: the file's start is far above.
	expect(await topOf(section)).toBeLessThan(-200);
	await expect(bar(section).getByRole("group", { name: "View" })).toBeVisible();
}

/** Switches to `to` mid-file and checks the line read stays where it was. */
async function switchKeepsPlace(
	section: Locator,
	from: Locator,
	to: string,
	toRow: Locator,
	renderer: string,
) {
	await readAt(section, from);
	const was = await topOf(from);
	await viewButton(section, to).click();
	await shownAs(section, renderer);
	await expect
		.poll(async () => Math.abs((await topOf(toRow)) - was))
		.toBeLessThan(2);
	await pinned(section);
}

async function checkDoc(page: Page, section: Locator, isMobile: boolean) {
	await expect(section.getByTestId("md-doc")).toBeVisible(GIT_WAIT);
	await shownAs(section, "markdown");
	// Deep in Rendered: pinned; Text keeps the paragraph read where it was.
	await switchKeepsPlace(
		section,
		renderedRow(section, "Para 50 stays"),
		"Text",
		textRow(section, "Para 50 stays"),
		"text",
	);
	if (isMobile) {
		for (const b of await bar(section).getByRole("button").all())
			expect(await tapHeight(b)).toBeGreaterThanOrEqual(40);
		await expectNoPageOverflow(page);
	}
	// In Text, a long cluster's floating box stays clear of the bar.
	await readAt(section, textRow(section, "const v30 = 30 + 1;"));
	const controls = section.locator(
		'[data-sticky-controls][data-stuck="fixed"]',
	);
	await expect(controls).toHaveCount(1);
	expect(await topOf(controls)).toBeGreaterThanOrEqual(
		(await bottomOf(bar(section))) - 1,
	);
	// And back: Rendered keeps the paragraph read.
	await switchKeepsPlace(
		section,
		textRow(section, "Para 71 stays"),
		"Rendered",
		renderedRow(section, "Para 71 stays"),
		"markdown",
	);
}

test("the view bar pins under the header deep in a file; switching mid-file keeps the line read; full diff and since view", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	let section = fileSection(page, DOC);
	await section.getByRole("button", { name: "Expand file" }).click();
	await checkDoc(page, section, isMobile);

	// The since view: the same.
	await page.evaluate(() => window.scrollTo(0, 0));
	await marksReady(page, section);
	await section
		.getByRole("button", { name: "Mark remaining reviewed" })
		.click();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);
	p.moveHead({ message: "again", files: { [DOC]: doc(true, true) } });
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
	section = fileSection(page, DOC);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.getByTestId("md-doc")).toBeVisible(GIT_WAIT);
	// The since view folds what didn't change since: open every fold.
	const folds = section.getByTestId("md-fold");
	for (let n = await folds.count(); n > 0; n = await folds.count()) {
		await folds.first().click();
		await expect(folds).toHaveCount(n - 1);
	}
	await readAt(section, renderedRow(section, "Para 49 edited again"));
	await pinned(section);
	await switchKeepsPlace(
		section,
		renderedRow(section, "Para 49 edited again"),
		"Text",
		// The change's top: its removed line, then the new one.
		textRow(section, "Para 49 edited.").first(),
		"text",
	);
});

test("the image toolbar pins while a tall image scrolls; Fade from deep in it keeps the toolbar in reach", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await pr({
		baseBinary: { [PNG]: pngImage(60, 3000, RED) },
		files: [
			{
				message: "tall",
				files: {},
				binary: { [PNG]: pngImage(60, 3000, GREEN) },
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, PNG);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.getByTestId("image-view")).toBeVisible();
	await expect(section.locator('[aria-busy="true"]')).toHaveCount(0);
	await section.getByRole("button", { name: "Actual size" }).click();
	await page.evaluate(() => window.scrollBy(0, 1500));
	await pinned(section);
	await viewButton(section, "Fade").click();
	await expect(
		section.getByRole("slider", { name: "Fade before to after" }),
	).toBeVisible();
	await pinned(section);
	if (isMobile) await expectNoPageOverflow(page);
});
