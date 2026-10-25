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
