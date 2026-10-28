import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures";

/** Files page helpers that work on desktop and phone layouts alike. */

export const progress = (page: Page) =>
	page.getByRole("progressbar", { name: "Review progress" });

export type UnitName = "Lines" | "Clusters" | "Files";

/** Opens the Files page and counts in `unit`. */
export async function openFiles(
	page: Page,
	url: string,
	unit: UnitName = "Clusters",
) {
	await page.goto(new URL("/files", url).href);
	await expect(progress(page)).toBeVisible();
	await chooseUnit(page, unit);
}

export async function chooseUnit(page: Page, unit: UnitName) {
	// The radio itself is visually hidden: tap its label like a person would.
	await page
		.getByRole("group", { name: "Count progress in" })
		.getByText(unit, { exact: true })
		.click();
	await expect(
		page.getByRole("radio", { name: unit, exact: true }),
	).toBeChecked();
}

export const fileSection = (page: Page, path: string) =>
	page.getByRole("region", { name: path });

/**
 * Runs `use` with the file tree: the sidebar on desktop, the sheet behind the
 * floating Files button on a phone (closed again afterwards).
 */
export async function withTree(
	page: Page,
	use: (tree: Locator) => Promise<void>,
) {
	const button = page.getByRole("button", { name: "Files", exact: true });
	const sheet = await button.isVisible();
	if (sheet) await button.click();
	const tree = page.getByTestId("file-tree");
	await expect(tree).toBeVisible();
	await use(tree);
	if (sheet) {
		await page
			.getByRole("dialog", { name: "Files" })
			.getByRole("button", { name: "Close" })
			.click();
		await expect(page.getByRole("dialog", { name: "Files" })).toBeHidden();
	}
}

/** Picks a file in the tree (from the sheet on a phone, which then closes). */
export async function pickInTree(page: Page, name: RegExp) {
	const button = page.getByRole("button", { name: "Files", exact: true });
	if (await button.isVisible()) await button.click();
	await page.getByTestId("file-tree").getByRole("button", { name }).click();
	await expect(page.getByRole("dialog", { name: "Files" })).toBeHidden();
}

/** Clicks a file header action (always inline icons). */
export async function fileAction(section: Locator, name: string) {
	await section.getByRole("button", { name, exact: true }).click();
}

/** A file header action, for checking its state. */
export const fileActionButton = (section: Locator, name: string) =>
	section.getByRole("button", { name, exact: true });

export const fileProgress = (section: Locator) =>
	section.getByRole("progressbar", { name: "File progress" });

/** A tree row's exact numbers (the end of its accessible name). */
export const treeNumbers = (tree: Locator, name: RegExp) =>
	tree.getByRole("button", { name }).getByTestId("tree-numbers");

/** The sticky page progress bar's bottom edge, in viewport px. */
export const barBottom = (page: Page) =>
	page.evaluate(
		() =>
			document
				.querySelector('[role="progressbar"][aria-label="Review progress"]')
				?.closest(".sticky")
				?.getBoundingClientRect().bottom ?? Number.NaN,
	);

/**
 * Scrolls `row` a pixel under the stuck file header: the first row below
 * the sticky stack, which is what a switch keeps where it is. Polled: the
 * header sticks once the row is near the top, and the app header compacts
 * a moment after a scroll, so the stack's bottom settles over a few frames.
 */
export async function underStack(row: Locator) {
	await expect
		.poll(() =>
			row.evaluate((el) => {
				const header = el.closest("section")?.querySelector("header");
				const bottom = header?.getBoundingClientRect().bottom ?? 0;
				const delta = el.getBoundingClientRect().top - bottom + 1;
				if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
				return Math.abs(delta);
			}),
		)
		.toBeLessThan(1);
}

/** The row's viewport top. */
export const rowTop = async (row: Locator) =>
	(await row.boundingBox())?.y ?? Number.NaN;

/** Sets a Settings switch (by its label) and closes Settings again. */
export async function setSwitch(page: Page, label: string, on: boolean) {
	const gear = page.getByRole("button", { name: "Settings" });
	if ((await gear.getAttribute("aria-expanded")) !== "true") await gear.click();
	const toggle = page.getByRole("switch", { name: label });
	if ((await toggle.getAttribute("aria-checked")) !== String(on)) {
		await toggle.click();
	}
	await expect(toggle).toHaveAttribute("aria-checked", String(on));
	await page.keyboard.press("Escape");
	await expect(toggle).toBeHidden();
}

/** Settings' "Ignore whitespace". */
export const ignoreWhitespace = (page: Page, on: boolean) =>
	setSwitch(page, "Ignore whitespace", on);

/** Settings' "Side by side". */
export const sideBySide = (page: Page, on: boolean) =>
	setSwitch(page, "Side by side", on);

/** The page never scrolls sideways (principle 5). */
export async function expectNoPageOverflow(page: Page) {
	const { scrollWidth, clientWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth,
	}));
	expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}
