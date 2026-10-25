import type { Locator, Page } from "@playwright/test";
import { barBottom, fileSection, openFiles, progress } from "./files-ui";
import { expect, type PrOptions, test } from "./fixtures";

const text = (lines: string[]) => `${lines.join("\n")}\n`;
const short = Array.from({ length: 12 }, (_, i) => `short ${i + 1}`);
const long = Array.from({ length: 300 }, (_, i) => `long ${i + 1}`);

/** b/long.ts: a 150-line cluster, then a one-line cluster 50 lines later. */
const fixture: PrOptions = {
	base: {
		"a/one.ts": text(short),
		"b/long.ts": text(long),
		"c/last.ts": text(short),
	},
	files: [
		{
			message: "PR change",
			files: {
				"a/one.ts": text(short.map((l) => `${l} x`)),
				"b/long.ts": text(
					long.map((l, i) =>
						i < 150 ? `${l} changed` : i === 200 ? `${l} later` : l,
					),
				),
				"c/last.ts": text(short.map((l) => `${l} z`)),
			},
		},
	],
};

const box = async (locator: Locator) => {
	const b = await locator.boundingBox();
	if (!b) throw new Error("not rendered");
	return { top: b.y, bottom: b.y + b.height, height: b.height };
};

const appHeader = (page: Page) => page.locator("body header").first();
const appRow = (page: Page) => page.getByTestId("app-header-row");
const compactTitle = (page: Page) => page.getByTestId("compact-title");

async function expectNoPageOverflow(page: Page) {
	const { scrollWidth, clientWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth,
	}));
	expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

/** Scrolls deep into the long cluster of b/long.ts, opened. */
async function deepInLongCluster(page: Page) {
	const section = fileSection(page, "b/long.ts");
	await section.getByRole("button", { name: "Expand file" }).click();
	await section
		.getByTestId("diff-line")
		.filter({ hasText: /long 90 changed$/ })
		.scrollIntoViewIfNeeded();
	return section;
}

test("the app header compacts after scrolling and its tabs work from deep down", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	// At the top: the full header, no small title.
	await expect(page.getByRole("heading", { level: 1 })).toBeInViewport();
	await expect(compactTitle(page)).toHaveCSS("opacity", "0");
	const full = await box(appHeader(page));

	await deepInLongCluster(page);
	// Only the compact row is left, stuck at the top, with the small title.
	await expect
		.poll(async () => (await box(appHeader(page))).bottom)
		.toBe((await box(appRow(page))).bottom + 1);
	const header = await box(appHeader(page));
	expect(header.bottom).toBeLessThan(full.bottom);
	expect(header.bottom).toBeLessThanOrEqual(isMobile ? 48 : 56);
	await expect(page.getByRole("heading", { level: 1 })).not.toBeInViewport();
	await expect(compactTitle(page)).toHaveCSS("opacity", "1");
	await expect(compactTitle(page)).toContainText("#7");
	await expectNoPageOverflow(page);

	// The stack lines up, no gaps or overlaps: header, bar, file header.
	const bar = await barBottom(page);
	const barTop = (
		await box(
			progress(page).locator(
				"xpath=ancestor::div[contains(@class,'sticky')][1]",
			),
		)
	).top;
	expect(Math.abs(barTop - header.bottom)).toBeLessThanOrEqual(1);
	const fileHeader = await box(
		fileSection(page, "b/long.ts").locator("header"),
	);
	expect(Math.abs(fileHeader.top - bar)).toBeLessThanOrEqual(1);

	// One tap back to the overview, and back to the files.
	await page.getByRole("link", { name: "Overview" }).click();
	await expect(
		page.getByRole("region", { name: "What it does" }),
	).toBeVisible();
	await page.getByRole("link", { name: "Files changed" }).click();
	await expect(progress(page)).toBeVisible();
});

test("the overview's header compacts too", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(fixture);
	const s = await startCrb();
	await page.goto(s.url);
	await expect(
		page.getByRole("region", { name: "What it does" }),
	).toBeVisible();
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	await expect(compactTitle(page)).toHaveCSS("opacity", "1");
	const header = await box(appHeader(page));
	expect(header.top).toBeLessThan(0);
	expect(header.bottom).toBeGreaterThan(0);
	await expect(
		page.getByRole("link", { name: "Files changed" }),
	).toBeInViewport();
	await expectNoPageOverflow(page);
});

test("a long cluster's checkbox and cross-off stay below the file header", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await deepInLongCluster(page);
	const first = section
		.getByTestId("diff-line")
		.filter({ hasText: /long 1 changed$/ });
	await expect(first).not.toBeInViewport();
	const checkbox = section
		.getByRole("checkbox", { name: "Mark cluster reviewed" })
		.first();
	const cross = section
		.getByRole("button", { name: "Cross off cluster" })
		.first();
	await expect(checkbox).toBeInViewport();
	await expect(cross).toBeInViewport();
	// Directly below the file header: its tap target touches the header.
	const header = await box(section.locator("header"));
	const target = await box(section.getByTestId("cluster-box-target").first());
	expect(target.top).toBeGreaterThanOrEqual(header.bottom - 1);
	expect(target.top - header.bottom).toBeLessThanOrEqual(isMobile ? 4 : 8);
	if (isMobile) expect(target.height).toBeGreaterThanOrEqual(40);
	// Floating changes no line's place.
	const line = section
		.getByTestId("diff-line")
		.filter({ hasText: /long 95 changed$/ });
	const lineTop = (await box(line)).top;

	// Still operable there.
	await checkbox.click();
	await expect(checkbox).toBeChecked();
	await expect((await box(line)).top).toBe(lineTop);
	await expect(
		section.getByRole("progressbar", { name: "File progress" }),
	).toHaveAttribute("aria-valuetext", /1 of 2 clusters reviewed/);
	await checkbox.click();
	await expect(checkbox).not.toBeChecked();

	// Past the cluster's end, its controls scroll away with it (room
	// below the last file to scroll that far).
	await page.addStyleTag({ content: "main { padding-bottom: 150vh; }" });
	const after = section
		.getByTestId("diff-line")
		.filter({ hasText: /long 151$/ });
	await page.evaluate(
		(by) => window.scrollBy(0, by),
		(await box(after)).top - (await box(section.locator("header"))).bottom,
	);
	await expect
		.poll(async () => (await box(checkbox)).bottom)
		.toBeLessThanOrEqual((await box(section.locator("header"))).bottom);
	await expectNoPageOverflow(page);
});
