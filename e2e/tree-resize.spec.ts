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
/** The sliver either side may be squeezed to. */
const SLIVER = 24;

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
/** The widest the tree may be: its row less the handle, less the diffs' sliver. */
const maxWidth = (page: Page) =>
	handle(page).evaluate((el, sliver) => {
		const row = el.parentElement?.parentElement;
		if (!row) throw new Error("no row");
		const width = (e: Element) => e.getBoundingClientRect().width;
		return Math.floor(width(row) - width(el)) - sliver;
	}, SLIVER);
/** The handle is wholly on screen, so the tree can always be brought back. */
async function expectHandleInView(page: Page) {
	await expect(handle(page)).toBeVisible();
	const box = await handle(page).boundingBox();
	const viewport = page.viewportSize()?.width ?? 0;
	expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
	expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport);
}

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

	test("a tree taller than the window ends in view: before the page scrolls, and stuck", async ({
		page,
		pr,
		startCrb,
	}) => {
		// More files than the window holds rows, each long enough to scroll.
		const names = Array.from(
			{ length: 60 },
			(_, i) => `src/f${String(i).padStart(2, "0")}.ts`,
		);
		await pr({
			base: Object.fromEntries(names.map((n) => [n, lines(20, n)])),
			files: [
				{
					message: "PR change",
					files: Object.fromEntries(
						names.map((n) => [n, lines(20, n).replace(" 3\n", " 3 x\n")]),
					),
				},
			],
		});
		const s = await startCrb();
		await openFiles(page, s.url);
		await expect(handle(page)).toBeVisible();
		const column = handle(page).locator("..");
		const bottom = () =>
			column.evaluate((el) => ({
				bottom: el.getBoundingClientRect().bottom,
				window: window.innerHeight,
				scrolls: el.querySelector("aside")
					? (el.querySelector("aside") as HTMLElement).scrollHeight >
						(el.querySelector("aside") as HTMLElement).clientHeight
					: false,
			}));
		const inView = async () => {
			await expect
				.poll(async () => {
					const b = await bottom();
					return b.bottom <= b.window;
				})
				.toBe(true);
		};
		const last = page
			.getByTestId("file-tree")
			.getByRole("button", { name: /f59\.ts/ });
		await expect(last).toBeAttached();
		// At the top of the page the column sits below the bars: its bottom
		// still ends in the window, and the tree scrolls inside it.
		expect(await page.evaluate(() => window.scrollY)).toBe(0);
		await inView();
		expect((await bottom()).scrolls).toBe(true);
		// The last file's row can be reached by scrolling the tree alone.
		await sidebar(page).evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await expect(last).toBeInViewport({ ratio: 1 });
		// Fold all / Open all stay on top, at the column's top edge.
		const toolbar = page.getByRole("toolbar", { name: "Folders" });
		await expect(toolbar).toBeInViewport({ ratio: 1 });
		const top = async (l: typeof toolbar) => (await l.boundingBox())?.y ?? -1;
		expect(
			Math.abs((await top(toolbar)) - (await top(sidebar(page)))),
		).toBeLessThanOrEqual(1.5);
		// Stuck, after the page scrolls, it still ends in view.
		await page.evaluate(() => window.scrollBy(0, 2000));
		await inView();
		await page.evaluate(() => window.scrollBy(0, 40));
		await inView();
	});

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
		const max = await maxWidth(page);
		expect(max).toBeGreaterThan(DEFAULT * 2);
		await handle(page).focus();
		await expect(handle(page)).toBeFocused();
		// The tooltip names it (it closes later, when a move takes it far away).
		await expect(page.locator('[role="tooltip"]:not([hidden])')).toHaveText(
			"Resize file tree",
		);
		await expect(handle(page)).toHaveAttribute("aria-valuemin", `${SLIVER}`);
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
		await expectHandleInView(page);
		await page.keyboard.press("Home");
		await expect(handle(page)).toHaveAttribute("aria-valuenow", `${SLIVER}`);
		expect(await width(page)).toBeCloseTo(SLIVER, 0);
		await expectHandleInView(page);
		await page.keyboard.press("Enter");
		await expect(handle(page)).toHaveAttribute("aria-valuenow", `${DEFAULT}`);
		expect(await width(page)).toBeCloseTo(DEFAULT, 0);
		// Still focused.
		await expect(handle(page)).toBeFocused();
	});

	test("either side squeezes to a sliver: a far drag stops with the handle in view", async ({
		page,
		pr,
		startCrb,
	}) => {
		await pr(fixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		const viewport = page.viewportSize()?.width ?? 0;
		const max = await maxWidth(page);
		await drag(page, viewport);
		await expect(handle(page)).toHaveAttribute("aria-valuenow", `${max}`);
		expect(await width(page)).toBeCloseTo(max, 0);
		// The diffs keep their sliver (the row's fraction of a pixel at most on top).
		const diffs = await diffsWidth(page);
		expect(diffs).toBeGreaterThanOrEqual(SLIVER);
		expect(diffs).toBeLessThan(SLIVER + 1);
		await expectHandleInView(page);
		// A smaller window clamps it again, without forgetting the choice.
		await page.setViewportSize({ width: 800, height: 720 });
		const smaller = await maxWidth(page);
		expect(smaller).toBeLessThan(max);
		await expect(handle(page)).toHaveAttribute("aria-valuenow", `${smaller}`);
		await expectHandleInView(page);
		expect(
			await page.evaluate(() => localStorage.getItem("crb.files.treeWidth")),
		).toBe(`${max}`);
		// Far left stops at the tree's sliver.
		await drag(page, -viewport);
		await expect(handle(page)).toHaveAttribute("aria-valuenow", `${SLIVER}`);
		expect(await width(page)).toBeCloseTo(SLIVER, 0);
		await expectHandleInView(page);
		// And a double click brings the default back.
		await handle(page).dblclick();
		await expect(handle(page)).toHaveAttribute("aria-valuenow", `${DEFAULT}`);
	});
});
