import type { Page } from "@playwright/test";
import { openFiles } from "./files-ui";
import { expect, type PrOptions, test } from "./fixtures";

const lines = (n: number, tag: string) =>
	`${Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n")}\n`;

/** Three files, one changed line each. */
const fixture: PrOptions = {
	base: {
		"src/a.ts": lines(12, "a"),
		"src/b.ts": lines(12, "b"),
		"docs/c.md": lines(6, "c"),
	},
	files: [
		{
			message: "PR change",
			files: {
				"src/a.ts": lines(12, "a").replace("a 3\n", "a 3 changed\n"),
				"src/b.ts": lines(12, "b").replace("b 5\n", "b 5 changed\n"),
				"docs/c.md": lines(6, "c").replace("c 2\n", "c 2 changed\n"),
			},
		},
	],
};

const DEFAULT = 288;
const MIN = 160;

const handle = (page: Page) =>
	page.getByRole("separator", { name: "Resize file tree" });
/** The sidebar holding the tree. */
const sidebar = (page: Page) =>
	page.locator("aside").filter({ has: page.getByTestId("file-tree") });
const width = async (page: Page) =>
	(await sidebar(page).boundingBox())?.width ?? Number.NaN;
const diffsWidth = (page: Page) =>
	page
		.getByRole("region", { name: "src/a.ts" })
		.evaluate((el) => el.parentElement?.getBoundingClientRect().width ?? 0);

/** Drags the handle by `dx` pixels with the mouse. */
async function drag(page: Page, dx: number) {
	const box = await handle(page).boundingBox();
	if (!box) throw new Error("no handle");
	const x = box.x + box.width / 2;
	const y = box.y + Math.min(box.height / 2, 40);
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + dx / 2, y);
	await page.mouse.move(x + dx, y);
	await page.mouse.up();
}

test.describe("desktop", () => {
	test.skip(({ isMobile }) => isMobile, "the tree is a sheet on a phone");

	test("dragging the handle resizes the tree, and the width survives a reload", async ({
		page,
		pr,
		startCrb,
	}) => {
		await pr(fixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		await expect(handle(page)).toBeVisible();
		await expect(handle(page)).toHaveAttribute("aria-valuenow", `${DEFAULT}`);
		expect(await width(page)).toBeCloseTo(DEFAULT, 0);
		const hit = await handle(page).boundingBox();
		expect(hit?.width ?? 0).toBeGreaterThanOrEqual(12);
		await expect(handle(page)).toHaveCSS("cursor", "col-resize");

		await drag(page, 120);
		await expect(handle(page)).toHaveAttribute(
			"aria-valuenow",
			`${DEFAULT + 120}`,
		);
		expect(await width(page)).toBeCloseTo(DEFAULT + 120, 0);
		// Nothing got selected on the way.
		expect(
			await page.evaluate(() => window.getSelection()?.toString() ?? ""),
		).toBe("");

		await page.reload();
		await expect(handle(page)).toHaveAttribute(
			"aria-valuenow",
			`${DEFAULT + 120}`,
		);
		expect(await width(page)).toBeCloseTo(DEFAULT + 120, 0);

		// Back the other way, past the start.
		await drag(page, -200);
		await expect(handle(page)).toHaveAttribute(
			"aria-valuenow",
			`${DEFAULT - 80}`,
		);
		// A double click resets it.
		await handle(page).dblclick();
		await expect(handle(page)).toHaveAttribute("aria-valuenow", `${DEFAULT}`);
		expect(await width(page)).toBeCloseTo(DEFAULT, 0);
	});

	test("the keyboard resizes the tree: arrows step, Home/End go to the ends, Enter resets", async ({
		page,
		pr,
		startCrb,
	}) => {
		await pr(fixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		const max = await page.evaluate(() => Math.floor(window.innerWidth / 2));
		await handle(page).focus();
		await expect(handle(page)).toBeFocused();
		await expect(handle(page)).toHaveAttribute("aria-valuemin", `${MIN}`);
		await expect(handle(page)).toHaveAttribute("aria-valuemax", `${max}`);
		for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
		await expect(handle(page)).toHaveAttribute(
			"aria-valuenow",
			`${DEFAULT - 48}`,
		);
		expect(await width(page)).toBeCloseTo(DEFAULT - 48, 0);
		await page.keyboard.press("Shift+ArrowRight");
		await expect(handle(page)).toHaveAttribute(
			"aria-valuenow",
			`${DEFAULT + 16}`,
		);
		await page.keyboard.press("End");
		await expect(handle(page)).toHaveAttribute("aria-valuenow", `${max}`);
		expect(await width(page)).toBeCloseTo(max, 0);
		await page.keyboard.press("Home");
		await expect(handle(page)).toHaveAttribute("aria-valuenow", `${MIN}`);
		expect(await width(page)).toBeCloseTo(MIN, 0);
		await page.keyboard.press("Enter");
		await expect(handle(page)).toHaveAttribute("aria-valuenow", `${DEFAULT}`);
		expect(await width(page)).toBeCloseTo(DEFAULT, 0);
		// Still focused, and the tooltip names it.
		await expect(handle(page)).toBeFocused();
		await expect(page.locator('[role="tooltip"]:not([hidden])')).toHaveText(
			"Resize file tree",
		);
	});

	test("the width is clamped: a drag past the half way stops there and the diffs keep their room", async ({
		page,
		pr,
		startCrb,
	}) => {
		await pr(fixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		const viewport = page.viewportSize()?.width ?? 0;
		const max = await page.evaluate(() => Math.floor(window.innerWidth / 2));
		await drag(page, viewport);
		await expect(handle(page)).toHaveAttribute("aria-valuenow", `${max}`);
		expect(await width(page)).toBeCloseTo(max, 0);
		expect(await diffsWidth(page)).toBeGreaterThan(viewport / 3);
		// And a smaller window clamps it again, without forgetting the choice.
		await page.setViewportSize({ width: 800, height: 720 });
		const smaller = await page.evaluate(() =>
			Math.floor(window.innerWidth / 2),
		);
		await expect(handle(page)).toHaveAttribute("aria-valuenow", `${smaller}`);
		expect(await diffsWidth(page)).toBeGreaterThan(800 / 3);
		expect(
			await page.evaluate(() => localStorage.getItem("crb.files.treeWidth")),
		).toBe(`${max}`);
		// Far left stops at the minimum.
		await drag(page, -viewport);
		await expect(handle(page)).toHaveAttribute("aria-valuenow", `${MIN}`);
		expect(await width(page)).toBeCloseTo(MIN, 0);
	});
});
