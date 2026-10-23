import type { Page } from "@playwright/test";
import { fileSection, openFiles } from "./files-ui";
import { expect, type PrOptions, test } from "./fixtures";

const LONG_DIR = "src/server/review/storage/adapters/git/refs/internal/legacy";
const lines = (n: number, tag: string) =>
	`${Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n")}\n`;

/** Enough files to scroll, one of them on a long path. */
const fixture: PrOptions = {
	base: Object.fromEntries([
		...Array.from({ length: 24 }, (_, i) => [
			`src/f${i}.ts`,
			lines(30, `f${i}`),
		]),
		[`${LONG_DIR}/compatibility.ts`, lines(10, "long")],
	]),
	files: [
		{
			message: "PR change",
			files: Object.fromEntries([
				...Array.from({ length: 24 }, (_, i) => [
					`src/f${i}.ts`,
					lines(30, `f${i}`).replace(`f${i} 5\n`, `f${i} 5 changed\n`),
				]),
				[
					`${LONG_DIR}/compatibility.ts`,
					lines(10, "long").replace("long 2\n", "long 2 changed\n"),
				],
			]),
		},
	],
};

async function expectNoPageOverflow(page: Page) {
	const { scrollWidth, clientWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth,
	}));
	expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test("no horizontal page scroll on the overview and files pages", async ({
	page,
	pr,
	startCrb,
}, testInfo) => {
	await pr(fixture);
	const s = await startCrb();
	const widths =
		testInfo.project.name === "phone"
			? [360, 412]
			: [page.viewportSize()?.width ?? 1280];
	for (const width of widths) {
		await page.setViewportSize({ width, height: 800 });
		await page.goto(s.url);
		await expect(
			page.getByRole("region", { name: "What it does" }),
		).toBeVisible();
		await expectNoPageOverflow(page);
		// Five-digit counts must fit too.
		await page.route("**/api/review", async (route) => {
			const response = await route.fetch();
			const view = await response.json();
			for (const file of view.files) {
				for (const c of file.clusters) c.lines *= 12345;
			}
			view.progress.lines = { total: 98765, reviewed: 12345, crossedOff: 4321 };
			view.progress.clusters = { total: 54321, reviewed: 1234, crossedOff: 0 };
			await route.fulfill({ response, json: view });
		});
		await openFiles(page, s.url, "Lines");
		await expect(page.getByText("12345 / 94444 lines reviewed")).toBeVisible();
		await expectNoPageOverflow(page);
		const header = fileSection(page, "src/f0.ts").getByRole("progressbar", {
			name: "File progress",
		});
		await expect(header).toHaveText(/^0 \/ 24690/);
		const fits = await header
			.locator("span")
			.first()
			.evaluate((el) => el.scrollWidth <= el.clientWidth);
		expect(fits).toBe(true);
		await page.unroute("**/api/review");
		await openFiles(page, s.url);
		const section = fileSection(page, "src/f0.ts");
		await section.getByRole("button", { name: "Expand file" }).click();
		await expect(section.getByTestId("diff-line").first()).toBeVisible();
		await expectNoPageOverflow(page);
	}
});

test.describe("phone", () => {
	test.skip(({ isMobile }) => !isMobile, "phone layout only");

	test("the floating Files button opens the tree; picking a file closes it and scrolls there", async ({
		page,
		pr,
		startCrb,
	}) => {
		await pr(fixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		const tree = page.getByTestId("file-tree");
		await expect(tree).toBeHidden();
		const button = page.getByRole("button", { name: "Files", exact: true });
		await button.click();
		const sheet = page.getByRole("dialog", { name: "Files" });
		await expect(sheet).toBeVisible();
		await expect(sheet.getByTestId("file-tree")).toBeVisible();

		// Escape closes it, and focus goes back to the button.
		await page.keyboard.press("Escape");
		await expect(sheet).toBeHidden();
		await expect(button).toBeFocused();

		await button.click();
		const target = fileSection(page, "src/f23.ts");
		await expect(target).not.toBeInViewport();
		await sheet.getByRole("button", { name: /f23\.ts/ }).click();
		await expect(sheet).toBeHidden();
		await expect(target).toBeInViewport();
		await expect(
			target.getByRole("button", { name: "Expand file" }),
		).toBeFocused();
	});

	test("the sheet locks the page scroll and closes when the screen widens", async ({
		page,
		pr,
		startCrb,
	}) => {
		await pr(fixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		await page.getByRole("button", { name: "Files", exact: true }).click();
		const sheet = page.getByRole("dialog", { name: "Files" });
		await expect(sheet).toBeVisible();
		expect(
			await page.evaluate(() => document.documentElement.style.overflow),
		).toBe("hidden");
		await page.setViewportSize({ width: 1024, height: 800 });
		await expect(sheet).toHaveCount(0);
		expect(
			await page.evaluate(() => document.documentElement.style.overflow),
		).toBe("");
		await page.setViewportSize({ width: 412, height: 800 });
		await expect(
			page.getByRole("button", { name: "Files", exact: true }),
		).toBeVisible();
		await expect(page.getByRole("dialog", { name: "Files" })).toBeHidden();
	});

	test("cluster controls have separate 40px touch targets", async ({
		page,
		pr,
		startCrb,
	}) => {
		await pr(fixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		const section = fileSection(page, "src/f0.ts");
		const expand = section.getByRole("button", { name: "Expand file" });
		const expandBox = await expand.boundingBox();
		expect(expandBox?.width).toBeGreaterThanOrEqual(40);
		expect(expandBox?.height).toBeGreaterThanOrEqual(40);
		await expand.click();
		const box = await section.getByTestId("cluster-box-target").boundingBox();
		const toggle = await section
			.getByRole("button", { name: "Cross off cluster" })
			.boundingBox();
		if (!box || !toggle) throw new Error("controls not rendered");
		for (const b of [box, toggle]) {
			expect(b.width).toBeGreaterThanOrEqual(40);
			expect(b.height).toBeGreaterThanOrEqual(40);
		}
		const overlap =
			box.x < toggle.x + toggle.width &&
			toggle.x < box.x + box.width &&
			box.y < toggle.y + toggle.height &&
			toggle.y < box.y + box.height;
		expect(overlap).toBe(false);
		// Tapping the box's target checks the box, not the toggle.
		await page.touchscreen.tap(box.x + 4, box.y + box.height / 2);
		await expect(
			section.getByRole("checkbox", { name: "Mark cluster reviewed" }),
		).toBeChecked();
	});

	test("a long path starts scrolled to the file name", async ({
		page,
		pr,
		startCrb,
	}) => {
		await pr(fixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		const path = fileSection(page, `${LONG_DIR}/compatibility.ts`).getByTestId(
			"file-path",
		);
		await expect(path).toHaveAttribute("title", `${LONG_DIR}/compatibility.ts`);
		await expect
			.poll(() =>
				path.evaluate((el) => ({
					scrolled: el.scrollLeft > 0,
					atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
				})),
			)
			.toEqual({ scrolled: true, atEnd: true });
		await expect(
			fileSection(page, `${LONG_DIR}/compatibility.ts`).getByTestId(
				"path-fade",
			),
		).toBeVisible();
		await path.focus();
		await expect(path).toBeFocused();
		// The rest of the path is reachable by scrolling left.
		await path.evaluate((el) => {
			el.scrollLeft = 0;
		});
		expect(await path.evaluate((el) => el.scrollLeft)).toBe(0);
	});

	test("file actions sit behind a compact menu", async ({
		page,
		pr,
		startCrb,
	}) => {
		await pr(fixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		const section = fileSection(page, "src/f0.ts");
		const mark = section.getByRole("button", {
			name: "Mark remaining reviewed",
		});
		await expect(mark).toBeHidden();
		const menu = section.getByRole("button", { name: "File actions" });
		const box = await menu.boundingBox();
		expect(box?.height).toBeGreaterThanOrEqual(40);
		await menu.click();
		await expect(mark).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(mark).toBeHidden();
	});
});

test("desktop keeps the file tree in a sidebar", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "desktop layout only");
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await expect(page.getByTestId("file-tree")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Files", exact: true }),
	).toHaveCount(0);
	await expect(
		fileSection(page, "src/f0.ts").getByRole("button", {
			name: "Mark remaining reviewed",
		}),
	).toBeVisible();
});
