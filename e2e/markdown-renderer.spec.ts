import type { Locator, Page, Route } from "@playwright/test";
import {
	expectNoPageOverflow,
	fileSection,
	marksReady,
	openFiles,
	progress,
	tapHeight,
} from "./files-ui";
import { expect, expectLoadingThen, test } from "./fixtures";
import { GREEN, png as pngImage, RED } from "./images";

/*
 * The Markdown renderer's Rendered view (CAR-167, spec "The Rendered
 * view" and "The since view"): a .md file opens rendered with one box per
 * cluster on its block; a tick there is the same tick in Text, in the full
 * diff and the since view; the pick of Text is kept per path; loading
 * shows a skeleton; images load only from the review's files.
 */

const README = "README.md";
const NOTES = "docs/notes.md";

const BASE = `# Widget

Intro old words here.

- one
- two

## Gone

Gone text.

Para A

Para B

Para B2

Para C

Para D
`;

const PS1 = `# Widget

Intro new words here.

- one
- two
- three

Para A

Para B

Para B2

Para C

Para D changed
`;

/** The since view's push: the intro and Para D reworked again. */
const PS2 = PS1.replace("Intro new words", "Intro newer words").replace(
	"Para D changed",
	"Para D changed again",
);

const fixture = {
	base: { [README]: BASE, [NOTES]: "Notes.\n" },
	files: [
		{
			message: "docs",
			files: { [README]: PS1, [NOTES]: "Notes, changed.\n" },
		},
	],
};

const GIT_WAIT = { timeout: 30_000 };

const viewButton = (section: Locator, name: "Rendered" | "Text") =>
	section
		.getByRole("group", { name: "View" })
		.getByRole("button", { name, exact: true });
const shownAs = (section: Locator, renderer: string) =>
	expect(section).toHaveAttribute("data-renderer", renderer);
/** A rendered block's row, by text it shows. */
const block = (section: Locator, text: string) =>
	section.getByTestId("md-block").filter({ hasText: text });
const renderedBox = (section: Locator, text: string) =>
	block(section, text).getByRole("checkbox", { name: "Mark cluster reviewed" });
/** The Text view's box of the cluster holding a line with `text`. */
const textBox = (section: Locator, text: string) =>
	section
		.locator("tbody")
		.filter({
			has: section.page().getByTestId("diff-line").filter({ hasText: text }),
		})
		.getByRole("checkbox", { name: "Mark cluster reviewed" });

/** A screenshot for a design check, with DESIGN_SHOTS set (a directory). */
async function shot(section: Locator, name: string) {
	const dir = process.env.DESIGN_SHOTS;
	if (!dir) return;
	await section.scrollIntoViewIfNeeded();
	await section.screenshot({ path: `${dir}/${name}.png` });
}

async function openRendered(page: Page, path = README) {
	const section = fileSection(page, path);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.getByTestId("md-doc")).toBeVisible();
	return section;
}

test("a .md file opens Rendered; a tick there is the same cluster's in Text and back; a reload keeps Text for that path only", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	let section = await openRendered(page);
	await shownAs(section, "markdown");
	await expect(viewButton(section, "Rendered")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	// One box per cluster, as many as Text shows (below).
	const boxes = section.getByTestId("md-box");
	await expect(boxes.first()).toBeVisible();
	const units = await boxes.count();
	await expect(block(section, "Intro")).toHaveAttribute("data-tone", "changed");
	await expect(block(section, "Intro").locator("ins.md-ins")).toHaveText("new");
	await expect(block(section, "three")).toHaveAttribute("data-tone", "added");
	await expect(block(section, "Gone text")).toHaveAttribute(
		"data-tone",
		"removed",
	);
	await expect(section.getByTestId("md-fold")).toBeVisible();
	await shot(section, `markdown-full-${isMobile ? "phone" : "desktop"}`);

	await renderedBox(section, "Intro").click();
	await expect(renderedBox(section, "Intro")).toBeChecked();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);

	await viewButton(section, "Text").click();
	await shownAs(section, "text");
	await expect(
		section.getByRole("checkbox", { name: "Mark cluster reviewed" }),
	).toHaveCount(units);
	await expect(textBox(section, "Intro new")).toBeChecked();
	await expect(textBox(section, "- three")).not.toBeChecked();
	await viewButton(section, "Rendered").click();
	await shownAs(section, "markdown");
	await expect(renderedBox(section, "Intro")).toBeChecked();
	await expect(renderedBox(section, "three")).not.toBeChecked();

	// Text kept for README only.
	await viewButton(section, "Text").click();
	await page.reload();
	section = fileSection(page, README);
	await shownAs(section, "text");
	await shownAs(fileSection(page, NOTES), "markdown");

	if (isMobile) {
		section = await openRendered(page, NOTES);
		const target = section.getByTestId("cluster-box-target").first();
		await target.scrollIntoViewIfNeeded();
		expect(await tapHeight(target)).toBeGreaterThanOrEqual(40);
		await expectNoPageOverflow(page);
	}
});

test("at phone width the Rendered view never scrolls the page and its boxes are 40px", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "the phone project's layout");
	await pr({
		base: {
			[README]: `${BASE}\n| a | b |\n|---|---|\n| 1 | 2 |\n\n\`\`\`\nshort\n\`\`\`\n`,
		},
		files: [
			{
				message: "wide",
				files: {
					[README]: `${PS1}\n| a | b |\n|---|---|\n| ${"wide-cell-".repeat(20)} | 2 |\n\n\`\`\`\n${"long_code_line_".repeat(20)}\n\`\`\`\n`,
				},
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await openRendered(page);
	for (const target of await section.getByTestId("cluster-box-target").all()) {
		await target.scrollIntoViewIfNeeded();
		expect(await tapHeight(target)).toBeGreaterThanOrEqual(40);
	}
	// Both 40px targets sit in the gutter, never over the block or off it.
	const overlaps = await section.getByTestId("md-block").evaluateAll((rows) =>
		rows.flatMap((row) => {
			const gutter = row.querySelector(".md-gutter")?.getBoundingClientRect();
			const body = row.querySelector(".md-body")?.getBoundingClientRect();
			if (!gutter || !body) return [];
			return [
				...row.querySelectorAll(
					'[data-testid="cluster-box-target"], button[aria-label="Cross off cluster"]',
				),
			].flatMap((el) => {
				const r = el.getBoundingClientRect();
				return r.left < gutter.left - 0.5 || r.right > body.left + 0.5
					? [`${Math.round(r.left)}..${Math.round(r.right)}`]
					: [];
			});
		}),
	);
	expect(overlaps).toEqual([]);
	await expect(section.getByTestId("md-fold")).toBeVisible();
	await section.getByTestId("md-fold").scrollIntoViewIfNeeded();
	expect(
		await section
			.getByTestId("md-fold")
			.evaluate((b) => b.getBoundingClientRect().height),
	).toBeGreaterThanOrEqual(40);
	await expectNoPageOverflow(page);
});

test("loading shows the skeleton while the hunks are held, never an empty document", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const held: Route[] = [];
	let holding = true;
	await page.route("**/files/*/hunks?*", (route) => {
		if (holding) held.push(route);
		else void route.continue();
	});
	const section = fileSection(page, README);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expectLoadingThen({
		loading: section.getByTestId("md-loading"),
		empty: [section.getByTestId("md-doc"), section.getByTestId("since-empty")],
		release: async () => {
			await expect(section.getByTestId("md-loading")).toHaveAttribute(
				"aria-busy",
				"true",
			);
			await expect.poll(() => held.length).toBeGreaterThanOrEqual(1);
			holding = false;
			for (const route of held.splice(0)) await route.continue();
		},
		result: section.getByTestId("md-block"),
	});
});

test("images load only from the review's own files; a remote one on a click, http(s) only; nothing else leaves the review's blob route", async ({
	page,
	pr,
	startCrb,
}) => {
	const IMAGES = `# Images

![ok](img/logo.png)

![up](../../../x.png)

![root](/.//evil.example/p.png)

![enc](%2F%2Fevil.example/q.png)

![data](data:image/png;base64,iVBORw0KGgo=)

![remote](https://remote.example/r.png)
`;
	await pr({
		base: { [README]: "# Images\n" },
		baseBinary: { "img/logo.png": pngImage(40, 20, RED) },
		files: [
			{
				message: "images",
				files: { [README]: IMAGES },
				binary: { "img/logo.png": pngImage(40, 20, GREEN) },
			},
		],
	});
	const s = await startCrb();
	const origin = new URL(s.url).origin;
	const offsite: string[] = [];
	page.on("request", (r) => {
		const url = r.url();
		if (!url.startsWith(origin) && !url.startsWith("data:")) offsite.push(url);
	});
	const remote: Route[] = [];
	await page.route("https://remote.example/**", (route) => {
		remote.push(route);
		void route.fulfill({
			contentType: "image/png",
			body: Buffer.from(pngImage(10, 10, GREEN)),
		});
	});
	await openFiles(page, s.url);
	const section = await openRendered(page);
	const doc = section.getByTestId("md-doc");
	// The changed image: through the review's blob route, by index.
	const imgs = doc.locator("img");
	await expect(imgs).toHaveCount(1);
	const src = (await imgs.first().getAttribute("src")) ?? "";
	expect(new URL(src, origin).pathname).toMatch(/\/files\/\d+\/blob$/);
	expect(src).not.toContain("logo");
	// Every other one is a placeholder, loaded by nothing.
	const holders = doc.locator("button.md-remote-image");
	await expect(holders).toHaveCount(5);
	// A data: one (or any scheme but http(s)) loads nothing on a click.
	await holders.filter({ hasText: "data:" }).click();
	await expect(holders).toHaveCount(5);
	await expect(imgs).toHaveCount(1);
	expect(offsite).toEqual([]);
	// The http(s) one loads on a click, and only then.
	expect(remote).toHaveLength(0);
	await holders.filter({ hasText: "remote.example" }).click();
	await expect(imgs).toHaveCount(2);
	await expect.poll(() => remote.length).toBe(1);
	expect(offsite.every((u) => u.startsWith("https://remote.example/"))).toBe(
		true,
	);
});

test("the since view: one box per piece on its block; a tick in Rendered is the same piece's tick in Text", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	// PS1: everything reviewed, from the Rendered view.
	for (const path of [README, NOTES]) {
		const section = fileSection(page, path);
		const expand = section.getByRole("button", { name: "Expand file" });
		if (await expand.isVisible()) await expand.click();
		await expect(section.getByTestId("md-doc")).toBeVisible();
		// A file the move-on opened takes marks a moment later.
		await marksReady(page, section);
		await section
			.getByRole("button", { name: "Mark remaining reviewed" })
			.click();
		await expect(expand).toBeVisible();
	}
	await expect(progress(page)).toHaveAttribute("aria-valuenow", "100");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);
	p.moveHead({ message: "rework", files: { [README]: PS2 } });
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
	const section = fileSection(page, README);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.getByTestId("md-doc")).toBeVisible(GIT_WAIT);
	await shownAs(section, "markdown");
	// The pieces since PS1: the reworked intro and Para D, chipped.
	await expect(section.getByTestId("md-box")).toHaveCount(2);
	const intro = block(section, "Intro");
	await expect(intro).toHaveAttribute("data-tone", "changed");
	await expect(intro.locator("ins.md-ins")).toHaveText("newer");
	await expect(intro.locator('[data-kind="reworked"]')).toBeVisible();
	await shot(section, "markdown-since");
	await renderedBox(section, "Intro").click();
	await expect(renderedBox(section, "Intro")).toBeChecked();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);
	await viewButton(section, "Text").click();
	await shownAs(section, "text");
	await expect(textBox(section, "Intro newer")).toBeChecked();
	await viewButton(section, "Rendered").click();
	await expect(renderedBox(section, "Intro")).toBeChecked();
	await expectNoPageOverflow(page);
});
