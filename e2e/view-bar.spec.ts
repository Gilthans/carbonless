import type { Locator, Page, Route } from "@playwright/test";
import {
	expectNoPageOverflow,
	fileSection,
	marksReady,
	openFiles,
	tapHeight,
} from "./files-ui";
import { expect, reviewPage, test } from "./fixtures";
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

const TS = "src/long.ts";
const SVG = "img/tall.svg";
/** A .ts file changed on every line: its rows are what a stack without a view bar does. */
const tsLines = (changed: boolean) =>
	`${Array.from({ length: 200 }, (_, i) => `long ${i + 1}${changed ? " x" : ""}`).join("\n")}\n`;

/** `row`'s top below `stack`'s bottom, once it settles. */
async function below(row: Locator, stack: Locator) {
	await expect(row).toBeInViewport();
	let last = Number.NaN;
	await expect
		.poll(async () => {
			const now = (await topOf(row)) - (await bottomOf(stack));
			const steady = Math.abs(now - last) < 0.5;
			last = now;
			return steady;
		})
		.toBe(true);
	return last;
}

test("a find step and a line landing put the row below the pinned view bar, as far as a file without one puts it below its header", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await pr({
		base: { [DOC]: doc(false), [TS]: tsLines(false) },
		files: [
			{ message: "edit", files: { [DOC]: doc(true), [TS]: tsLines(true) } },
		],
	});
	const s = await startCrb();

	// A landing: on a .ts line, then on a .md line (Text for the view).
	await page.goto(reviewPage(s.url, "files", `?path=${TS}&line=150`));
	const ts = fileSection(page, TS);
	const tsRow = ts.locator('[data-testid=diff-line][data-new-no="150"]');
	const tsGap = await below(tsRow, header(ts));
	await page.goto(reviewPage(s.url, "files", `?path=${DOC}&line=101`));
	let md = fileSection(page, DOC);
	await shownAs(md, "text");
	await pinned(md);
	const mdRow = md.locator('[data-testid=diff-line][data-new-no="101"]');
	expect(Math.abs((await below(mdRow, bar(md))) - tsGap)).toBeLessThan(2);

	// A find step into the .md file shown as Text.
	await openFiles(page, s.url);
	md = fileSection(page, DOC);
	await md.getByRole("button", { name: "Expand file" }).click();
	await viewButton(md, "Text").click();
	await shownAs(md, "text");
	if (isMobile)
		await page.getByRole("button", { name: "Find in PR", exact: true }).click();
	else await page.keyboard.press("ControlOrMeta+f");
	const box = page.getByTestId("find-box");
	const searched = page.getByRole("status", { name: "Searching files…" });
	/** A fresh search for `term` (one hit), then a step onto it. */
	async function step(term: string) {
		await box.fill(term);
		await expect(page.getByTestId("find-count")).toHaveText(/^(1 of 1|1\/1)$/, {
			useInnerText: true,
		});
		await expect(searched).toHaveCount(0);
		await box.press("Enter");
	}
	// Into the .md file first, its view bar pinned over the hit's row.
	await step("Para 80 stays");
	const mdHit = md.locator("tr[data-find-current]");
	await pinned(md);
	const mdGap = await below(mdHit, bar(md));
	await step("long 150 x");
	const tsHit = fileSection(page, TS).locator("tr[data-find-current]");
	const tsFindGap = await below(tsHit, header(fileSection(page, TS)));
	expect(Math.abs(mdGap - tsFindGap)).toBeLessThan(2);
});

test("a click while the switch waits for its view ends the hold: the view lands where the reader left it, not snapped back", async ({
	page,
	pr,
	startCrb,
}) => {
	const OTHER = "docs/other.md";
	await pr({
		base: { [DOC]: doc(false), [OTHER]: doc(false) },
		files: [
			{ message: "edit", files: { [DOC]: doc(true), [OTHER]: doc(true) } },
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	// Both shown as Text (kept per path), so Rendered reads its document anew.
	for (const path of [DOC, OTHER]) {
		const section = fileSection(page, path);
		await section.getByRole("button", { name: "Expand file" }).click();
		await viewButton(section, "Text").click();
		await shownAs(section, "text");
	}
	await page.reload();
	const held: Route[] = [];
	await page.route("**/files/*/context?*", (route) => {
		held.push(route);
	});
	const release = async () => {
		await expect.poll(() => held.length).toBeGreaterThanOrEqual(1);
		for (const route of held.splice(0)) await route.continue();
	};

	/** Deep in Text, picks Rendered; its document is held until `release`. */
	async function pickHeld(path: string) {
		const section = fileSection(page, path);
		await section.getByRole("button", { name: "Expand file" }).click();
		await expect(textRow(section, "Para 71 stays")).toBeVisible();
		await readAt(section, textRow(section, "Para 71 stays"));
		const was = await topOf(textRow(section, "Para 71 stays"));
		await viewButton(section, "Rendered").click();
		await expect(section.getByTestId("md-loading")).toHaveAttribute(
			"aria-busy",
			"true",
		);
		return { section, was };
	}

	// Untouched, the hold waits out the load and keeps the place.
	const kept = await pickHeld(DOC);
	await release();
	await expect(kept.section.getByTestId("md-doc")).toBeVisible();
	await expect
		.poll(async () =>
			Math.abs(
				(await topOf(renderedRow(kept.section, "Para 71 stays"))) - kept.was,
			),
		)
		.toBeLessThan(2);
	await kept.section.getByRole("button", { name: "Collapse file" }).click();

	// A click meanwhile: the reader's, so the view stays where they are.
	const left = await pickHeld(OTHER);
	const box = await left.section.getByTestId("md-loading").boundingBox();
	if (!box) throw new Error("no skeleton");
	await page.mouse.click(box.x + 4, box.y + box.height / 2);
	await release();
	await expect(left.section.getByTestId("md-doc")).toBeVisible();
	await expect(left.section.locator('[aria-busy="true"]')).toHaveCount(0);
	expect(
		Math.abs(
			(await topOf(renderedRow(left.section, "Para 71 stays"))) - left.was,
		),
	).toBeGreaterThan(50);
});

test("Text to Image deep in a long SVG: the toolbar goes back to where it was pinned, the image's start under it", async ({
	page,
	pr,
	startCrb,
}) => {
	const svg = (fill: string) =>
		`${[
			'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300">',
			...Array.from(
				{ length: 200 },
				(_, i) =>
					`<rect x="0" y="${i}" width="200" height="1" fill="${fill}" data-n="${i}"/>`,
			),
			"</svg>",
		].join("\n")}\n`;
	await pr({
		base: { [SVG]: svg("red") },
		files: [{ message: "recolor", files: { [SVG]: svg("green") } }],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, SVG);
	await section.getByRole("button", { name: "Expand file" }).click();
	await viewButton(section, "Text").click();
	await shownAs(section, "text");
	const deep = section
		.getByTestId("diff-line")
		.filter({ hasText: 'data-n="150"' })
		.last();
	await readAt(section, deep);
	await pinned(section);
	await viewButton(section, "Slider").click();
	await shownAs(section, "image");
	await expect(section.getByTestId("image-view")).toBeVisible();
	await expect
		.poll(async () =>
			Math.abs(
				(await topOf(section.getByTestId("image-view"))) -
					(await bottomOf(header(section))),
			),
		)
		.toBeLessThan(1.5);
});
