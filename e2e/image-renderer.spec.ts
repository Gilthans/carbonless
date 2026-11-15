import { readFileSync } from "node:fs";
import type { Locator, Page, Route } from "@playwright/test";
import {
	reviewThread,
	type Scenario,
	threadComment,
} from "../test/fake-gh/scenario";
import {
	expectNoPageOverflow,
	fileActionButton,
	fileProgress,
	fileSection,
	openFiles,
	progress,
	sideBySide,
	tapHeight,
} from "./files-ui";
import {
	expect,
	expectLoadingThen,
	type Pr,
	reviewPage,
	test,
} from "./fixtures";
import { BLUE, bmp as bmpImage, GREEN, png as pngImage, RED } from "./images";

/*
 * Custom renderers (CAR-38, spec "Renderer switch"): an image file's header
 * has a "Show as" chip; the pick is kept per path for this viewer, and
 * only changes the view, never a review state.
 */

const PNG = "img/logo.png";
const BMP = "img/icon.bmp";
const TS = "src/a.ts";

// Image signatures with a NUL in them: git calls them binary.
const png = (n: number) =>
	new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, n]);
const bmp = (n: number) => new Uint8Array([0x42, 0x4d, 0, 0, 0, n]);

const chip = (section: Locator) =>
	section.getByRole("button", { name: /^Show as/ });

test("renderer switch: Image ↔ Binary persists across reload; a .ts file has no chip", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await pr({
		base: { [TS]: "one\ntwo\n" },
		baseBinary: { [PNG]: png(1), [BMP]: bmp(1) },
		files: [
			{
				message: "images changed",
				binary: { [PNG]: png(2), [BMP]: bmp(2) },
				files: { [TS]: "one\nTWO\n" },
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const image = fileSection(page, PNG);
	const other = fileSection(page, BMP);
	await expect(chip(image)).toHaveAccessibleName("Show as: Image");
	await expect(chip(other)).toHaveAccessibleName("Show as: Image");
	await expect(fileSection(page, TS)).toBeVisible();
	await expect(chip(fileSection(page, TS))).toHaveCount(0);

	// Image (no ImageView yet): the binary row and its box, no lines read.
	await image.getByRole("button", { name: "Expand file" }).click();
	await expect(
		image.getByRole("checkbox", { name: "Mark cluster reviewed" }),
	).toBeVisible();

	await chip(image).click();
	const menu = page.getByRole("menu", { name: "Show as" });
	const items = menu.getByRole("menuitemradio");
	await expect(items).toHaveText(["Image", "Binary"]);
	await expect(
		menu.getByRole("menuitemradio", { name: "Image" }),
	).toHaveAttribute("aria-checked", "true");
	if (isMobile) {
		expect(await tapHeight(chip(image))).toBeGreaterThanOrEqual(40);
		for (const item of await items.all()) {
			expect(await tapHeight(item)).toBeGreaterThanOrEqual(40);
		}
	}
	await expectNoPageOverflow(page);
	await menu.getByRole("menuitemradio", { name: "Binary" }).click();
	await expect(menu).toHaveCount(0);
	await expect(chip(image)).toHaveAccessibleName("Show as: Binary");
	// Today's binary rows; the box is still unticked (a pick writes nothing).
	const box = image.getByRole("checkbox", { name: "Mark cluster reviewed" });
	await expect(box).toBeVisible();
	await expect(box).not.toBeChecked();
	await expect(image.getByText("Binary file changed")).toBeVisible();
	await expect(chip(other)).toHaveAccessibleName("Show as: Image");

	await page.reload();
	await expect(chip(fileSection(page, PNG))).toHaveAccessibleName(
		"Show as: Binary",
	);
	await expect(chip(fileSection(page, BMP))).toHaveAccessibleName(
		"Show as: Image",
	);
	await expect(
		fileSection(page, PNG).getByRole("progressbar", { name: "File progress" }),
	).toHaveText(/0 \/ 1/);

	// And back.
	await chip(fileSection(page, PNG)).click();
	await page
		.getByRole("menu", { name: "Show as" })
		.getByRole("menuitemradio", { name: "Image" })
		.click();
	await expect(chip(fileSection(page, PNG))).toHaveAccessibleName(
		"Show as: Image",
	);
	await page.reload();
	await expect(chip(fileSection(page, PNG))).toHaveAccessibleName(
		"Show as: Image",
	);
	await expectNoPageOverflow(page);
});

/*
 * The image views (spec "Unified view", "Side-by-side view", "Edge cases"):
 * real PNGs and BMPs made in code (images.ts).
 */

const stageOf = (section: Locator) => section.getByTestId("image-stage");
const splitOf = (section: Locator) =>
	section.getByRole("slider", { name: "Before/after split" });

/** Opens `path`'s file and waits for its stage to finish loading. */
async function openImage(page: Page, path: string) {
	const section = fileSection(page, path);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(stageOf(section).first()).toBeVisible();
	await expect(section.locator('[aria-busy="true"]')).toHaveCount(0);
	return section;
}

/** A changed BMP and PNG, same size, and nothing else. */
const changed = {
	baseBinary: { [BMP]: bmpImage(120, 80, RED), [PNG]: pngImage(120, 80, RED) },
	files: [
		{
			message: "images changed",
			files: {},
			binary: {
				[BMP]: bmpImage(120, 80, GREEN),
				[PNG]: pngImage(120, 80, GREEN),
			},
		},
	],
};

test("slider drags and moves with arrow keys", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await pr(changed);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await openImage(page, BMP);
	await expect(section.getByRole("button", { name: "Slider" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(section.getByTestId("image-dims")).toHaveText(
		/120×80\s*→\s*to\s*120×80\s*· 28 → 28 KB/,
	);
	const split = splitOf(section);
	await expect(split).toHaveValue("50");
	await expect(split).toHaveCSS("touch-action", "pan-y");
	// Drag anywhere on the stage: the split follows.
	const box = await stageOf(section).boundingBox();
	if (!box) throw new Error("no stage");
	const y = box.y + box.height / 2;
	await page.mouse.move(box.x + box.width / 2, y);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width * 0.2, y, { steps: 5 });
	await page.mouse.up();
	const dragged = Number(await split.inputValue());
	expect(dragged).toBeLessThan(35);
	await expect(section.getByTestId("image-before-layer")).toHaveCSS(
		"clip-path",
		`inset(0px ${100 - dragged}% 0px 0px)`,
	);
	// Keys move it one step at a time.
	await split.focus();
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("ArrowRight");
	await expect(split).toHaveValue(String(dragged + 2));
	// Tags in the top corners; the controls are tap-sized.
	await expect(stageOf(section).getByText("before")).toBeVisible();
	await expect(stageOf(section).getByText("after")).toBeVisible();
	if (isMobile) {
		for (const name of ["Slider", "Fade", "Actual size"]) {
			expect(
				await tapHeight(section.getByRole("button", { name })),
			).toBeGreaterThanOrEqual(40);
		}
	}
	// Still unreviewed: the view writes nothing.
	await expect(
		section.getByRole("checkbox", { name: "Mark cluster reviewed" }),
	).not.toBeChecked();
	await expectNoPageOverflow(page);
});

test("fade, and the mode is remembered across reload", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(changed);
	const s = await startCrb();
	await openFiles(page, s.url);
	let section = await openImage(page, PNG);
	await section.getByRole("button", { name: "Fade" }).click();
	await expect(section.getByRole("button", { name: "Fade" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(splitOf(section)).toHaveCount(0);
	const fade = section.getByRole("slider", { name: "Fade before to after" });
	await fade.fill("80");
	await expect(section.getByTestId("image-before-layer")).toHaveCSS(
		"opacity",
		"0.2",
	);
	await expectNoPageOverflow(page);

	await page.reload();
	section = await openImage(page, PNG);
	await expect(section.getByRole("button", { name: "Fade" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(
		section.getByRole("slider", { name: "Fade before to after" }),
	).toBeVisible();
	// Another image follows the same remembered mode.
	await expect(
		(await openImage(page, BMP)).getByRole("button", { name: "Fade" }),
	).toHaveAttribute("aria-pressed", "true");
});

test("side-by-side: two single versions, stacked on a phone", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await pr(changed);
	const s = await startCrb();
	await openFiles(page, s.url);
	await sideBySide(page, true);
	const section = await openImage(page, BMP);
	const sbs = section.getByTestId("image-side-by-side");
	await expect(sbs.getByTestId("image-stage")).toHaveCount(2);
	await expect(section.getByRole("group", { name: "Compare" })).toHaveCount(0);
	await expect(sbs.locator("figcaption").first()).toHaveText(
		/before\s*120×80 · 28 KB/,
	);
	await expect(sbs.locator("figcaption").last()).toHaveText(
		/after\s*120×80 · 28 KB/,
	);
	const [before, after] = await Promise.all(
		[0, 1].map((i) => sbs.getByTestId("image-stage").nth(i).boundingBox()),
	);
	if (!before || !after) throw new Error("no stages");
	if (isMobile) {
		expect(after.y).toBeGreaterThanOrEqual(before.y + before.height);
	} else {
		expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
		expect(after.x).toBeGreaterThan(before.x + before.width);
	}
	await expectNoPageOverflow(page);
});

test("added and deleted labels", async ({ page, pr, startCrb }) => {
	const ADDED = "img/new.png";
	const DELETED = "img/old.bmp";
	await pr({
		baseBinary: { [DELETED]: bmpImage(30, 20, BLUE) },
		files: [
			{
				message: "swap images",
				files: {},
				delete: [DELETED],
				binary: { [ADDED]: pngImage(40, 30, GREEN) },
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const added = await openImage(page, ADDED);
	await expect(added.getByText("added", { exact: true })).toBeVisible();
	await expect(added.getByRole("img", { name: "Added image" })).toBeVisible();
	await expect(added.getByRole("group", { name: "Compare" })).toHaveCount(0);
	await expect(added.getByTestId("image-dims")).toHaveText(
		/^40×30\s*· \d+ (B|KB)$/,
	);
	const deleted = await openImage(page, DELETED);
	await expect(deleted.getByText("deleted", { exact: true })).toBeVisible();
	await expect(
		deleted.getByRole("img", { name: "Deleted image" }),
	).toBeVisible();
	await expect(deleted.getByTestId("image-dims")).toHaveText(
		/^30×20\s*· \d+ (B|KB)$/,
	);
	await expectNoPageOverflow(page);
});

test("size changed: stage is max w × max h, images top-left", async ({
	page,
	pr,
	startCrb,
}) => {
	const P = "img/resized.png";
	await pr({
		baseBinary: { [P]: pngImage(300, 200, RED) },
		files: [
			{
				message: "resize",
				files: {},
				binary: { [P]: pngImage(200, 300, GREEN) },
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await openImage(page, P);
	await expect(section.getByTestId("image-dims")).toHaveText(
		/300×200\s*→\s*to\s*200×300/,
	);
	const stage = await stageOf(section).boundingBox();
	const before = await section
		.getByRole("img", { name: "Before" })
		.boundingBox();
	const after = await section.getByRole("img", { name: "After" }).boundingBox();
	if (!stage || !before || !after) throw new Error("no boxes");
	// 300 × 300, scaled to fit (never enlarged).
	expect(Math.abs(stage.width - stage.height)).toBeLessThanOrEqual(1);
	expect(stage.width).toBeLessThanOrEqual(300.5);
	const scale = stage.width / 300;
	for (const [img, w, h] of [
		[before, 300, 200],
		[after, 200, 300],
	] as const) {
		expect(Math.abs(img.x - stage.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(img.y - stage.y)).toBeLessThanOrEqual(1);
		expect(Math.abs(img.width - w * scale)).toBeLessThanOrEqual(1);
		expect(Math.abs(img.height - h * scale)).toBeLessThanOrEqual(1);
	}
	// Slider at 50%: left of the handle, below the before image's height,
	// is the checkerboard, never the after image showing through.
	const stack = await page.evaluate(
		([x, y]) =>
			document
				.elementsFromPoint(x, y)
				.map((el) => el.getAttribute("alt") ?? el.getAttribute("data-testid")),
		[stage.x + stage.width * 0.25, stage.y + 250 * scale] as const,
	);
	expect(stack).toContain("image-stage");
	expect(stack).not.toContain("After");
	expect(stack).not.toContain("Before");
	// Right of the handle, the after image (and not the before).
	const right = await page.evaluate(
		([x, y]) =>
			document.elementsFromPoint(x, y).map((el) => el.getAttribute("alt")),
		[stage.x + stage.width * 0.6, stage.y + 50 * scale] as const,
	);
	expect(right).toContain("After");
	expect(right).not.toContain("Before");
	await expectNoPageOverflow(page);
});

test("undecodable .tiff with Show as Image falls back to binary rows", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	// The <img> and its HEAD probe: no raster signature (sniff=1).
	expectConsoleError(/status of 415/);
	const TIFF = "img/scan.tiff";
	// A TIFF header: no raster signature crb sniffs, and NULs (binary).
	const tiff = (n: number) =>
		new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0, 0, n]);
	await pr({
		baseBinary: { [TIFF]: tiff(1) },
		files: [{ message: "scan", files: {}, binary: { [TIFF]: tiff(2) } }],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, TIFF);
	await expect(chip(section)).toHaveAccessibleName("Show as: Binary");
	await section.getByRole("button", { name: "Expand file" }).click();
	await chip(section).click();
	await page
		.getByRole("menu", { name: "Show as" })
		.getByRole("menuitemradio", { name: "Image" })
		.click();
	await expect(chip(section)).toHaveAccessibleName("Show as: Image");
	await expect(
		section.getByRole("img", { name: "Can't show this as an image" }),
	).toBeVisible();
	await expect(stageOf(section)).toHaveCount(0);
	await expect(section.getByTestId("image-dims")).toHaveText("10 → 10 B");
	await expect(section.getByText("Binary file changed")).toBeVisible();
	const box = section.getByRole("checkbox", { name: "Mark cluster reviewed" });
	await expect(box).toBeVisible();
	await expect(box).not.toBeChecked();
});

test("loading shows a spinner, never a blank stage", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(changed);
	const s = await startCrb();
	await openFiles(page, s.url);
	// Hold every blob until the test has seen the loading state.
	const held: Route[] = [];
	let holding = true;
	await page.route("**/files/*/blob?*", (route) => {
		if (holding) held.push(route);
		else void route.continue();
	});
	const section = fileSection(page, PNG);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expectLoadingThen({
		loading: section.getByRole("status", { name: "Loading image" }),
		empty: [section.locator('[data-image-state="fallback"]')],
		release: async () => {
			await expect(stageOf(section)).toHaveAttribute("aria-busy", "true");
			await expect.poll(() => held.length).toBeGreaterThanOrEqual(2);
			// The dimensions wait too, as a skeleton: never 0×0.
			await expect(section.getByTestId("image-dims")).not.toContainText("×");
			holding = false;
			for (const route of held.splice(0)) await route.continue();
		},
		result: splitOf(section),
	});
	await expect(stageOf(section)).not.toHaveAttribute("aria-busy");
	await expect(section.getByTestId("image-dims")).toContainText("120×80");
});

test("stale image shows refresh, not binary fallback", async ({
	page,
	context,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/409/);
	const p = await pr(changed);
	const s = await startCrb();
	await openFiles(page, s.url);
	// Another tab moves the review to a new snapshot.
	p.moveHead({ message: "more", files: { "b.txt": "b\n" } });
	const other = await context.newPage();
	await other.goto(s.url);
	await other.getByRole("button", { name: "Refresh" }).click();
	await expect(other.getByRole("link", { name: /Review files/ })).toContainText(
		"0 / 3",
	);
	await other.close();
	// This tab's review read after the 409 waits for the test.
	const held: Route[] = [];
	let holding = true;
	await page.route("**/api/r/*/review", (route) => {
		if (holding) held.push(route);
		else void route.continue();
	});
	const section = fileSection(page, PNG);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(
		section.getByText("The review moved to a new snapshot; reloaded."),
	).toBeVisible();
	await expect(section.locator('[data-image-state="fallback"]')).toHaveCount(0);
	await expect.poll(() => held.length).toBeGreaterThanOrEqual(1);
	holding = false;
	for (const route of held.splice(0)) await route.continue();
	// The page moved to the new snapshot (which opens with its files
	// closed), and its image loads.
	await expect(progress(page)).toContainText("0 / 3");
	const reopened = await openImage(page, PNG);
	await expect(splitOf(reopened)).toBeVisible();
	await expect(reopened.locator('[data-image-state="fallback"]')).toHaveCount(
		0,
	);
});

test("svg without intrinsic size", async ({ page, pr, startCrb }) => {
	const SVG = "img/icon.svg";
	const svg = (fill: string) =>
		`<svg xmlns="http://www.w3.org/2000/svg">\n<rect width="40" height="30" fill="${fill}"/>\n</svg>\n`;
	await pr({
		base: { [SVG]: svg("red") },
		files: [{ message: "recolor", files: { [SVG]: svg("green") } }],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await openImage(page, SVG);
	const box = await stageOf(section).boundingBox();
	if (!box) throw new Error("no stage");
	// Fit to width at a 4:3 placeholder: not collapsed.
	expect(box.width).toBeGreaterThan(100);
	expect(Math.abs(box.height - (box.width * 3) / 4)).toBeLessThanOrEqual(1);
	await expect(section.getByTestId("image-dims")).not.toContainText("0×0");
	await expect(section.getByTestId("image-dims")).toHaveText(/^\d+ → \d+ B$/);
	await expect(splitOf(section)).toBeVisible();
	await expectNoPageOverflow(page);
});

test("wide image on phone: no page overflow; at 1:1 a swipe scrolls, the grip drags", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	const WIDE = "img/banner.png";
	await pr({
		baseBinary: { [WIDE]: pngImage(2000, 60, RED) },
		files: [
			{
				message: "banner",
				files: {},
				binary: { [WIDE]: pngImage(2000, 60, GREEN) },
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await openImage(page, WIDE);
	// Fit: inside the window.
	const viewport = page.viewportSize()?.width ?? 0;
	const fit = await stageOf(section).boundingBox();
	expect(fit?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(viewport);
	await expectNoPageOverflow(page);
	// 1:1 scrolls inside the stage's frame, never the page.
	await section.getByRole("button", { name: "Actual size" }).click();
	await expect(
		section.getByRole("button", { name: "Actual size" }),
	).toHaveAttribute("aria-pressed", "true");
	await expect
		.poll(async () => (await stageOf(section).boundingBox())?.width ?? 0)
		.toBeGreaterThan(1999);
	const frame = section.getByTestId("image-stage-frame");
	const { scrollWidth, clientWidth } = await frame.evaluate((el) => ({
		scrollWidth: el.scrollWidth,
		clientWidth: el.clientWidth,
	}));
	expect(scrollWidth).toBeGreaterThan(clientWidth);
	await expectNoPageOverflow(page);
	const split = splitOf(section);
	await expect(split).toHaveAttribute("aria-valuetext", "50% before");
	if (isMobile) {
		// A swipe away from the handle scrolls the image, not the split.
		await frame.scrollIntoViewIfNeeded();
		const box = await frame.boundingBox();
		if (!box) throw new Error("no frame");
		const cdp = await page.context().newCDPSession(page);
		const y = Math.round(box.y + box.height / 2);
		const x0 = Math.round(box.x + box.width - 40);
		const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number) =>
			cdp.send("Input.dispatchTouchEvent", {
				type,
				touchPoints: type === "touchEnd" ? [] : [{ x, y }],
			});
		await touch("touchStart", x0);
		for (let step = 1; step <= 10; step++)
			await touch("touchMove", x0 - step * 25);
		await touch("touchEnd", x0 - 250);
		await expect
			.poll(() => frame.evaluate((el) => el.scrollLeft))
			.toBeGreaterThan(50);
		await expect(split).toHaveValue("50");
		await expectNoPageOverflow(page);
	}
	// The grip on the handle still drags it.
	const grip = section.getByTestId("image-split-grip");
	await grip.scrollIntoViewIfNeeded();
	const g = await grip.boundingBox();
	if (!g) throw new Error("no grip");
	expect(g.width).toBeGreaterThanOrEqual(40);
	const gy = g.y + Math.min(g.height, 40) / 2;
	await page.mouse.move(g.x + g.width / 2, gy);
	await page.mouse.down();
	await page.mouse.move(g.x + g.width / 2 + 100, gy, { steps: 5 });
	await page.mouse.up();
	await expect
		.poll(async () => Number(await split.inputValue()))
		.toBeGreaterThan(50);
});

test("renamed with no content change shows the image once", async ({
	page,
	pr,
	startCrb,
}) => {
	const OLD = "img/old-name.png";
	const NEW = "img/new-name.png";
	await pr({
		baseBinary: { [OLD]: pngImage(50, 40, BLUE) },
		files: [{ message: "rename", files: {}, rename: { [OLD]: NEW } }],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await openImage(page, NEW);
	await expect(section.getByRole("img", { name: "Image" })).toBeVisible();
	await expect(section.getByRole("img", { name: "Before" })).toHaveCount(0);
	await expect(section.getByRole("group", { name: "Compare" })).toHaveCount(0);
	await expect(
		section.getByTestId("image-view").getByText(/added|deleted/),
	).toHaveCount(0);
	await expect(section.getByTestId("image-dims")).toHaveText(
		/^50×40\s*· \d+ B$/,
	);
	await expect(section.getByText(`Renamed from ${OLD}`)).toBeVisible();
});

/*
 * Review and comments in the image view (CAR-38 task 5): the header's
 * whole-file action is the image view's review control; file comments
 * post as GitHub file comments; an SVG's line threads list under the
 * header in Image view and sit on their lines in Text view.
 */

/** Threads the fake gh stores, with their opener's body. */
function stored(p: Pr) {
	const s = JSON.parse(readFileSync(p.scenarioPath, "utf8")) as Scenario;
	return (
		(s.prs[p.number]?.graphql?.reviewThreads ?? []) as {
			path: string;
			subjectType: string;
			comments: { nodes: { body: string }[] };
		}[]
	).map((t) => ({ ...t, body: t.comments.nodes[0]?.body ?? "" }));
}

/** The stored "Show as" picks (path → renderer), this viewer's. */
const storedPicks = (page: Page) =>
	page.evaluate(() => localStorage.getItem("crb.files.renderer"));

const SVG = "img/badge.svg";
/** An SVG: line 3's fill becomes "lime", and a line is added after it. */
const badge = (fill: string, extra: string[] = []) =>
	`${[
		'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30">',
		"<title>badge</title>",
		`<rect width="40" height="30" fill="${fill}"/>`,
		...extra,
		"</svg>",
	].join("\n")}\n`;
const svgPr = {
	base: { [SVG]: badge("red") },
	files: [
		{
			message: "recolor",
			files: {
				[SVG]: badge("lime", ['<circle cx="10" cy="10" r="4" fill="blue"/>']),
			},
		},
	],
};
const svgRow = (section: Locator, n: number) =>
	section.locator(`tr[data-testid="diff-line"][data-new-no="${n}"]`);

test("review tick on a BMP marks the file reviewed and survives reload", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(changed);
	const s = await startCrb();
	await openFiles(page, s.url);
	let section = await openImage(page, BMP);
	await expect(fileProgress(section)).toHaveText(/0 \/ 1/);
	await fileActionButton(section, "Mark remaining reviewed").click();
	await expect(fileActionButton(section, "Unmark reviewed")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(fileProgress(section)).toHaveText(/1 \/ 1/);
	// Only this file: the PNG is still to read.
	await expect(progress(page)).toContainText("1 / 2");
	await page.reload();
	section = fileSection(page, BMP);
	await expect(fileProgress(section)).toHaveText(/1 \/ 1/);
	await expect(fileActionButton(section, "Unmark reviewed")).toBeVisible();
	await expect(progress(page)).toContainText("1 / 2");
	section = await openImage(page, BMP);
	await expect(
		section.getByRole("checkbox", { name: "Mark cluster reviewed" }),
	).toBeChecked();
	await expect(fileProgress(fileSection(page, PNG))).toHaveText(/0 \/ 1/);
});

test("comment on file from the image view posts a file comment", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	const p = await pr(changed);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await openImage(page, PNG);
	const bubble = section.getByRole("button", { name: "Comment on file" });
	await expect(bubble).toBeVisible();
	if (isMobile) expect(await tapHeight(bubble)).toBeGreaterThanOrEqual(40);
	await bubble.click();
	const composer = section.getByTestId("new-thread");
	await expect(composer).toContainText("whole file");
	await composer.getByRole("textbox", { name: "Comment" }).fill("Darker?");
	await expectNoPageOverflow(page);
	await composer.getByRole("button", { name: "Comment" }).click();
	await expect(section.getByTestId("new-thread")).toHaveCount(0);
	await expect(
		section.getByTestId("file-threads").getByTestId("files-thread"),
	).toContainText("Darker?");
	// Still the image view, and nothing reviewed by commenting.
	await expect(stageOf(section)).toBeVisible();
	await expect(fileProgress(section)).toHaveText(/0 \/ 1/);
	expect(stored(p)).toMatchObject([
		// crb's own marker follows the text.
		{
			path: PNG,
			subjectType: "FILE",
			body: expect.stringMatching(/^Darker\?/),
		},
	]);
});

test("SVG line threads show under the header in Image view and on lines in Text view", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	const p = await pr(svgPr);
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((sc) => {
		const graph = sc.prs[p.number]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: SVG, line: 3, subjectType: "LINE" }, [
				threadComment({ login: "rev1", text: "Too bright?", commit: head }),
			]),
		];
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await openImage(page, SVG);
	await expect(chip(section)).toHaveAccessibleName("Show as: Image");
	// Image view: listed with the file's own threads, never dropped.
	const bubble = section.getByRole("button", {
		name: /^1 comment on this file.*line not in this diff/,
	});
	await expect(bubble).toBeVisible();
	await bubble.click();
	await expect(
		section.getByTestId("file-threads").getByTestId("files-thread"),
	).toContainText("Too bright?");
	await expect(section.getByTestId("diff-line")).toHaveCount(0);
	await expectNoPageOverflow(page);
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await section.scrollIntoViewIfNeeded();
		await page.screenshot({
			path: `${shots}/svg-image-line-thread-${isMobile ? "phone" : "desktop"}.png`,
		});
	}
	// Text view: on its line.
	await chip(section).click();
	await page
		.getByRole("menu", { name: "Show as" })
		.getByRole("menuitemradio", { name: "Text" })
		.click();
	await expect(chip(section)).toHaveAccessibleName("Show as: Text");
	await expect(
		svgRow(section, 3).getByRole("button", { name: /^1 comment on line 3/ }),
	).toBeVisible();
	await expectNoPageOverflow(page);
});

test("find in an SVG in Image view: stepping to a line hit switches that file to Text for the view (the pick is unchanged) and lands on the line", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await pr(svgPr);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, SVG);
	await expect(chip(section)).toHaveAccessibleName("Show as: Image");
	if (isMobile)
		await page.getByRole("button", { name: "Find in PR", exact: true }).click();
	else await page.keyboard.press("ControlOrMeta+f");
	const box = page.getByTestId("find-box");
	await expect(box).toBeFocused();
	await box.fill("lime");
	await expect(
		page.getByRole("status", { name: "Searching files…" }),
	).toHaveCount(0);
	await box.press("Enter");
	// Text for this view, on the hit's line.
	await expect(chip(section)).toHaveAccessibleName("Show as: Text");
	const current = section.locator("tr[data-find-current]");
	await expect(current).toHaveAttribute("data-new-no", "3");
	await expect(current).toBeInViewport();
	await expect(stageOf(section)).toHaveCount(0);
	expect(await storedPicks(page)).toBeNull();
	await expectNoPageOverflow(page);
	// Image again: the image, still nothing stored.
	await chip(section).click();
	await page
		.getByRole("menu", { name: "Show as" })
		.getByRole("menuitemradio", { name: "Image" })
		.click();
	await expect(chip(section)).toHaveAccessibleName("Show as: Image");
	await expect(stageOf(section)).toBeVisible();
	expect(await storedPicks(page)).toBeNull();

	// A thread link to the line works the same way, and lasts the view only.
	await page.goto(
		reviewPage(s.url, "files", `?path=${encodeURIComponent(SVG)}&line=3`),
	);
	const landed = fileSection(page, SVG);
	await expect(chip(landed)).toHaveAccessibleName("Show as: Text");
	await expect(svgRow(landed, 3)).toHaveAttribute("data-landed");
	await expect(svgRow(landed, 3)).toBeInViewport();
	expect(await storedPicks(page)).toBeNull();
	await page.reload();
	await expect(chip(fileSection(page, SVG))).toHaveAccessibleName(
		"Show as: Image",
	);
});
