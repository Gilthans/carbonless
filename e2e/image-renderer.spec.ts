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
	placedBox,
	reviewPage,
	test,
} from "./fixtures";
import { BLUE, bmp as bmpImage, GREEN, png as pngImage, RED } from "./images";

/*
 * Custom renderers (CAR-38, spec "Renderer switch"): a file with more than
 * one renderer has a view switch (Slider, Fade, Text, Binary) in its view's
 * toolbar; the pick is kept per path for this viewer, and only changes the
 * view, never a review state.
 */

const PNG = "img/logo.png";
const BMP = "img/icon.bmp";
const TS = "src/a.ts";

/** The view switch in `section` (renderers/ViewSwitch). */
const viewSwitch = (section: Locator) =>
	section.getByRole("group", { name: "View" });
/** A view's button; "Image" is the first image one (Slider, or Image). */
const viewButton = (section: Locator, name: string) =>
	viewSwitch(section).getByRole("button", {
		name: name === "Image" ? /^(Slider|Image)$/ : name,
		exact: name !== "Image",
	});
const pickView = (section: Locator, name: string) =>
	viewButton(section, name).click();
/** How `section`'s body shows the file (FileDiff's data-renderer). */
const shownAs = (section: Locator, renderer: string) =>
	expect(section).toHaveAttribute("data-renderer", renderer);

/** The view switch's buttons' names, in order. */
const viewNames = (section: Locator) =>
	viewSwitch(section)
		.getByRole("button")
		.evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label")));

/** On a phone: every button of the switch is a 40px tap target. */
async function tapSized(section: Locator, isMobile: boolean) {
	if (!isMobile) return;
	for (const button of await viewSwitch(section).getByRole("button").all())
		expect(await tapHeight(button)).toBeGreaterThanOrEqual(40);
}

test("view switch: PNG → Binary → Fade, kept across reloads; a .ts file has no switch", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await pr({
		base: { [TS]: "one\ntwo\n" },
		baseBinary: {
			[PNG]: pngImage(120, 80, RED),
			[BMP]: bmpImage(120, 80, RED),
		},
		files: [
			{
				message: "images changed",
				files: { [TS]: "one\nTWO\n" },
				binary: {
					[PNG]: pngImage(120, 80, GREEN),
					[BMP]: bmpImage(120, 80, GREEN),
				},
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	// One renderer: no switch, no row of its own.
	const ts = fileSection(page, TS);
	await ts.getByRole("button", { name: "Expand file" }).click();
	await expect(ts.getByTestId("diff-line").first()).toBeVisible();
	await shownAs(ts, "text");
	await expect(viewSwitch(ts)).toHaveCount(0);
	await expect(ts.getByTestId("view-bar")).toHaveCount(0);

	let image = await openImage(page, PNG);
	await shownAs(image, "image");
	expect(await viewNames(image)).toEqual(["Slider", "Fade", "Binary"]);
	await expect(viewButton(image, "Slider")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await tapSized(image, isMobile);
	await expectNoPageOverflow(page);

	await pickView(image, "Binary");
	await shownAs(image, "binary");
	await expect(viewButton(image, "Binary")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	// Binary's row holds just the switch.
	await expect(image.getByTestId("view-bar")).toBeVisible();
	await expect(image.getByTestId("image-dims")).toHaveCount(0);
	await expect(image.getByRole("button", { name: "Actual size" })).toHaveCount(
		0,
	);
	// An edited binary still says so; a pick writes no review state.
	await expect(image.getByText("Binary file changed")).toBeVisible();
	const box = image.getByRole("checkbox", { name: "Mark cluster reviewed" });
	await expect(box).not.toBeChecked();
	await shownAs(fileSection(page, BMP), "image");
	await tapSized(image, isMobile);
	await expectNoPageOverflow(page);

	await page.reload();
	image = fileSection(page, PNG);
	await shownAs(image, "binary");
	await shownAs(fileSection(page, BMP), "image");
	await image.getByRole("button", { name: "Expand file" }).click();
	// Fade from Binary: back to Image, in Fade.
	await pickView(image, "Fade");
	await shownAs(image, "image");
	await expect(viewButton(image, "Fade")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(
		image.getByRole("slider", { name: "Fade before to after" }),
	).toBeVisible();
	await page.reload();
	image = await openImage(page, PNG);
	await shownAs(image, "image");
	await expect(viewButton(image, "Fade")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
});

test("view switch: SVG Image → Text → Slider, kept across a reload", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await pr(svgPr);
	const s = await startCrb();
	await openFiles(page, s.url);
	let section = await openImage(page, SVG);
	expect(await viewNames(section)).toEqual(["Slider", "Fade", "Text"]);
	await expect(viewButton(section, "Slider")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await tapSized(section, isMobile);
	await expectNoPageOverflow(page);
	const shots = process.env.DESIGN_SHOTS;
	const shot = async (name: string) => {
		if (!shots) return;
		await section.scrollIntoViewIfNeeded();
		await page.screenshot({
			path: `${shots}/${name}-${isMobile ? "phone" : "desktop"}.png`,
		});
	};
	await shot("svg-toolbar-image");

	await pickView(section, "Text");
	await shownAs(section, "text");
	await expect(viewButton(section, "Text")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(svgRow(section, 3)).toBeVisible();
	await expect(section.getByTestId("image-dims")).toHaveCount(0);
	await tapSized(section, isMobile);
	await expectNoPageOverflow(page);
	await shot("svg-toolbar-text");

	await page.reload();
	section = fileSection(page, SVG);
	await shownAs(section, "text");
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(svgRow(section, 3)).toBeVisible();
	await pickView(section, "Slider");
	await shownAs(section, "image");
	await expect(stageOf(section)).toBeVisible();
	await expect(viewButton(section, "Slider")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await page.reload();
	await shownAs(fileSection(page, SVG), "image");
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
	// A small stage (120×80): the tags sit above it; the controls are
	// tap-sized.
	await expect(section.getByTestId("image-tags")).toHaveText(/before\s*after/);
	await expect(stageOf(section).getByText("before")).toHaveCount(0);
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
	expect(await viewNames(section)).toEqual(["Image", "Binary"]);
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
	expect(await viewNames(added)).toEqual(["Image", "Binary"]);
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
	expect(await viewNames(deleted)).toEqual(["Image", "Binary"]);
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
	// A stage this size keeps its tags in its top corners.
	await expect(stageOf(section).getByText("before")).toBeVisible();
	await expect(stageOf(section).getByText("after")).toBeVisible();
	await expect(section.getByTestId("image-tags")).toHaveCount(0);
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

test("undecodable .tiff shown as Image falls back to binary rows", async ({
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
	await shownAs(section, "binary");
	await section.getByRole("button", { name: "Expand file" }).click();
	await pickView(section, "Image");
	await shownAs(section, "image");
	await expect(
		section.getByRole("img", { name: "Can't show this as an image" }),
	).toBeVisible();
	await expect(stageOf(section)).toHaveCount(0);
	await expect(section.getByTestId("image-dims")).toHaveText("10 → 10 B");
	await expect(section.getByText("Binary file changed")).toBeVisible();
	const box = section.getByRole("checkbox", { name: "Mark cluster reviewed" });
	await expect(box).toBeVisible();
	await expect(box).not.toBeChecked();
	// The way back, in the toolbar.
	await expect(viewButton(section, "Image")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await pickView(section, "Binary");
	await shownAs(section, "binary");
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
	const cdp = isMobile ? await page.context().newCDPSession(page) : null;
	const touch = (
		type: "touchStart" | "touchMove" | "touchEnd",
		x: number,
		y: number,
	) =>
		cdp?.send("Input.dispatchTouchEvent", {
			type,
			touchPoints: type === "touchEnd" ? [] : [{ x, y }],
		});
	if (isMobile) {
		// A swipe away from the handle scrolls the image, not the split.
		await frame.scrollIntoViewIfNeeded();
		const box = await frame.boundingBox();
		if (!box) throw new Error("no frame");
		const y = Math.round(box.y + box.height / 2);
		const x0 = Math.round(box.x + box.width - 40);
		// The swipe's fling keeps scrolling the frame after the finger
		// lifts, and can outlast any scroll into view (CAR-238): listen for
		// its end before it starts.
		await frame.evaluate((el) => {
			(el as HTMLElement & { scrollEnded?: Promise<void> }).scrollEnded =
				new Promise<void>((done) =>
					el.addEventListener("scrollend", () => done(), { once: true }),
				);
		});
		await touch("touchStart", x0, y);
		for (let step = 1; step <= 10; step++)
			await touch("touchMove", x0 - step * 25, y);
		await touch("touchEnd", x0 - 250, y);
		await frame.evaluate(
			(el) => (el as HTMLElement & { scrollEnded?: Promise<void> }).scrollEnded,
		);
		expect(await frame.evaluate((el) => el.scrollLeft)).toBeGreaterThan(50);
		await expect(split).toHaveValue("50");
		await expectNoPageOverflow(page);
	}
	// The grip on the handle still drags it: by touch on a phone.
	const grip = section.getByTestId("image-split-grip");
	const pressAt = (b: {
		x: number;
		y: number;
		width: number;
		height: number;
	}) => ({
		x: Math.round(b.x + b.width / 2),
		y: Math.round(b.y + Math.min(b.height, 40) / 2),
	});
	// Pressed only once the grip rests where the press lands.
	const g = await placedBox(grip, pressAt);
	expect(g.width).toBeGreaterThanOrEqual(40);
	const at = pressAt(g);
	if (isMobile) {
		await touch("touchStart", at.x, at.y);
		for (let step = 1; step <= 5; step++)
			await touch("touchMove", at.x + step * 20, at.y);
		await touch("touchEnd", at.x + 100, at.y);
	} else {
		await page.mouse.move(at.x, at.y);
		await page.mouse.down();
		await page.mouse.move(at.x + 100, at.y, { steps: 5 });
		await page.mouse.up();
	}
	await expect
		.poll(async () => Number(await split.inputValue()))
		.toBeGreaterThan(50);
});

test("renamed with no content change shows the image once, and says no binary change", async ({
	page,
	pr,
	startCrb,
	isMobile,
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
	expect(await viewNames(section)).toEqual(["Image", "Binary"]);
	await expect(
		section.getByTestId("image-view").getByText(/added|deleted/),
	).toHaveCount(0);
	await expect(section.getByTestId("image-dims")).toHaveText(
		/^50×40\s*· \d+ B$/,
	);
	await expect(section.getByText(`Renamed from ${OLD}`)).toBeVisible();
	// Only moved: nothing says its bytes changed, and it is still a unit to
	// tick.
	await expect(section.getByText(/binary file changed/i)).toHaveCount(0);
	const box = section.getByRole("checkbox", { name: "Mark cluster reviewed" });
	await expect(box).not.toBeChecked();
	await box.click();
	// Ticked, the file is fully reviewed and folds away: its progress says so.
	await expect(fileProgress(section)).toHaveText(/1 \/ 1/);
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await page.screenshot({
			path: `${shots}/pure-rename-${isMobile ? "phone" : "desktop"}.png`,
		});
	}
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

/** The stored renderer picks (path → renderer), this viewer's. */
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
	await shownAs(section, "image");
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
	await pickView(section, "Text");
	await shownAs(section, "text");
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
	await shownAs(section, "image");
	if (isMobile)
		await page.getByRole("button", { name: "Find in PR", exact: true }).click();
	else await page.keyboard.press("ControlOrMeta+f");
	const box = page.getByTestId("find-box");
	await expect(box).toBeFocused();
	await box.fill("lime");
	// Every hit is in (the SVG's one) before the step.
	await expect(page.getByTestId("find-count")).toHaveText(/^(1 of 1|1\/1)$/, {
		useInnerText: true,
	});
	await box.press("Enter");
	// Text for this view, on the hit's line.
	await shownAs(section, "text");
	const current = section.locator("tr[data-find-current]");
	await expect(current).toHaveAttribute("data-new-no", "3");
	await expect(current).toBeInViewport();
	await expect(stageOf(section)).toHaveCount(0);
	expect(await storedPicks(page)).toBeNull();
	await expectNoPageOverflow(page);
	// Image again: the image, still nothing stored.
	await pickView(section, "Image");
	await shownAs(section, "image");
	await expect(stageOf(section)).toBeVisible();
	expect(await storedPicks(page)).toBeNull();

	// A thread link to the line works the same way, and lasts the view only.
	await page.goto(
		reviewPage(s.url, "files", `?path=${encodeURIComponent(SVG)}&line=3`),
	);
	const landed = fileSection(page, SVG);
	await shownAs(landed, "text");
	await expect(svgRow(landed, 3)).toHaveAttribute("data-landed");
	await expect(svgRow(landed, 3)).toBeInViewport();
	expect(await storedPicks(page)).toBeNull();
	// Image again: the link isn't replayed on the image (no "not in this
	// diff" hint; the unit test checks it doesn't scroll either).
	await pickView(landed, "Image");
	await expect(stageOf(landed)).toBeVisible();
	await expect(landed.locator('[aria-busy="true"]')).toHaveCount(0);
	await expect(landed.getByTestId("landing-hint")).toHaveCount(0);
	await page.reload();
	await shownAs(fileSection(page, SVG), "image");
});

test("a tiny image's before/after tags sit above it, never over it", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	const TINY = "img/dot.png";
	await pr({
		baseBinary: { [TINY]: pngImage(40, 30, RED) },
		files: [
			{
				message: "dot",
				files: {},
				binary: { [TINY]: pngImage(40, 30, GREEN) },
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await openImage(page, TINY);
	const tags = section.getByTestId("image-tags");
	await expect(tags).toBeVisible();
	const image = await section
		.getByRole("img", { name: "Before" })
		.boundingBox();
	if (!image) throw new Error("no image");
	for (const name of ["before", "after"]) {
		const tag = await tags.getByText(name, { exact: true }).boundingBox();
		if (!tag) throw new Error(`no ${name} tag`);
		const apart =
			tag.x + tag.width <= image.x ||
			image.x + image.width <= tag.x ||
			tag.y + tag.height <= image.y ||
			image.y + image.height <= tag.y;
		expect(apart, `${name} tag clear of the image`).toBe(true);
	}
	await expect(stageOf(section).getByText(/before|after/)).toHaveCount(0);
	await expectNoPageOverflow(page);
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await section.scrollIntoViewIfNeeded();
		await page.screenshot({
			path: `${shots}/tiny-image-tags-${isMobile ? "phone" : "desktop"}.png`,
		});
	}
});
