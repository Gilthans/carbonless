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

/** Clicks a file header action, opening the compact menu first if it's shown. */
export async function fileAction(section: Locator, name: string) {
	const menu = section.getByRole("button", { name: "File actions" });
	if (await menu.isVisible()) await menu.click();
	await section.getByRole("button", { name, exact: true }).click();
}

export const fileProgress = (section: Locator) =>
	section.getByRole("progressbar", { name: "File progress" });
