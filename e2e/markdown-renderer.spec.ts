import { readFileSync } from "node:fs";
import type { Locator, Page, Route } from "@playwright/test";
import {
	expectNoPageOverflow,
	fileSection,
	marksReady,
	openFiles,
	progress,
	tapHeight,
	tapWidth,
} from "./files-ui";
import { expect, expectLoadingThen, type Pr, test } from "./fixtures";
import { BLUE, GREEN, png as pngImage, RED } from "./images";

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
	const p = await pr({
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
	// A relative one the review can't load: a still placeholder, no
	// button (a click would load nothing).
	const stills = doc.locator(".md-local-image");
	await expect(stills).toHaveCount(2);
	await expect(stills.first()).toHaveAttribute("title", "Not in this PR");
	await expect(doc.locator("button", { hasText: "x.png" })).toHaveCount(0);
	// Every remote one is a placeholder button, loaded by nothing.
	const holders = doc.locator("button.md-remote-image");
	await expect(holders).toHaveCount(3);
	// A data: one (or any scheme but http(s)) loads nothing on a click.
	await holders.filter({ hasText: "data:" }).click();
	await expect(holders).toHaveCount(3);
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

	// The since view: the same images, the same rules.
	await marksReady(page, section);
	await section
		.getByRole("button", { name: "Mark remaining reviewed" })
		.click();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);
	p.moveHead({
		message: "retitle",
		files: { [README]: IMAGES.replace("# Images", "# Images, again") },
	});
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
	const since = fileSection(page, README);
	await since.getByRole("button", { name: "Expand file" }).click();
	const sinceDoc = since.getByTestId("md-doc");
	await expect(sinceDoc).toBeVisible(GIT_WAIT);
	await shownAs(since, "markdown");
	await expect(since.getByTestId("md-box")).toHaveCount(1);
	// The unchanged images fold: open them.
	for (const fold of await since.getByTestId("md-fold").all()) {
		await fold.click();
	}
	const sinceImgs = sinceDoc.locator("img");
	await expect(sinceImgs).toHaveCount(1);
	const sinceSrc = (await sinceImgs.first().getAttribute("src")) ?? "";
	expect(new URL(sinceSrc, origin).pathname).toMatch(/\/files\/\d+\/blob$/);
	const sinceStills = sinceDoc.locator(".md-local-image");
	await expect(sinceStills).toHaveCount(2);
	await expect(sinceDoc.locator("button", { hasText: "x.png" })).toHaveCount(0);
	await expect(sinceDoc.locator("button.md-remote-image")).toHaveCount(3);
	await sinceDoc
		.locator("button.md-remote-image")
		.filter({ hasText: "data:" })
		.click();
	await expect(sinceImgs).toHaveCount(1);
	expect(offsite.every((u) => u.startsWith("https://remote.example/"))).toBe(
		true,
	);
});

/** An image's frame against a design token's color (both computed). */
async function framedIn(el: Locator, token: string) {
	return el.evaluate((node, t) => {
		const probe = document.createElement("span");
		probe.style.color = `var(${t})`;
		document.body.appendChild(probe);
		const want = getComputedStyle(probe).color;
		probe.remove();
		const style = getComputedStyle(node);
		return {
			match: style.outlineColor === want && style.outlineStyle === "solid",
			opacity: Number(style.opacity),
		};
	}, token);
}

test("a changed image: the removed one framed red and faded from the old side, the added one framed green; an alt-only change shows both alts; full diff and since view (CAR-167 QA)", async ({
	page,
	pr,
	startCrb,
}) => {
	const doc = (shot: string, map: string) =>
		`# Images\n\n![Screen](img/${shot}.png)\n\n![${map}](img/route-map.png)\n\nEnd.\n`;
	const p = await pr({
		base: { [README]: doc("departures", "Route map of the three ports") },
		baseBinary: {
			"img/departures.png": pngImage(40, 20, RED),
			"img/route-map.png": pngImage(40, 20, RED),
		},
		files: [
			{
				message: "push 1",
				files: { [README]: doc("timetable-export", "Route map: Strandkaien") },
				binary: {
					"img/departures.png": pngImage(30, 20, GREEN),
					"img/timetable-export.png": pngImage(20, 20, BLUE),
				},
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const check = async (section: Locator, from?: string) => {
		const row = section
			.getByTestId("md-block")
			.filter({ has: page.locator("del.md-del img") });
		const removed = row.locator("del.md-del img");
		const added = row.locator("ins.md-ins img");
		await expect(removed).toHaveCount(1);
		await expect(added).toHaveCount(1);
		const params = async (img: Locator) =>
			new URL((await img.getAttribute("src")) ?? "", "http://x").searchParams;
		const was = await params(removed);
		expect(was.get("side")).toBe("old");
		expect(was.get("from")).toBe(from ?? null);
		expect((await params(added)).get("side")).toBe("new");
		// The old side really is served: the image loads.
		await expect
			.poll(() => removed.evaluate((i) => (i as HTMLImageElement).naturalWidth))
			.toBeGreaterThan(0);
		const red = await framedIn(removed, "--color-bad");
		expect(red.match).toBe(true);
		expect(red.opacity).toBeLessThan(1);
		const green = await framedIn(added, "--color-ok");
		expect(green.match).toBe(true);
		expect(green.opacity).toBe(1);
		// The route map isn't in the PR: placeholders, each with its alt.
		const maps = section.getByTestId("md-block").locator(".md-local-image");
		await expect(maps).toHaveCount(2);
		expect((await framedIn(maps.first(), "--color-bad")).match).toBe(true);
		expect((await framedIn(maps.last(), "--color-ok")).match).toBe(true);
		return maps;
	};

	const section = await openRendered(page);
	const maps = await check(section);
	await expect(maps.first().locator(".md-image-alt")).toHaveText(
		"Route map of the three ports",
	);
	await expect(maps.last().locator(".md-image-alt")).toHaveText(
		"Route map: Strandkaien",
	);
	await shot(section, "md-images-full");

	// The since view: push 2 puts the departures screen back, and retitles
	// the map again. The removed image is push 1's (the base lacks it).
	await marksReady(page, section);
	await section
		.getByRole("button", { name: "Mark remaining reviewed" })
		.click();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);
	p.moveHead({
		message: "push 2",
		files: { [README]: doc("departures", "Route map: Nordnes") },
	});
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
	const since = fileSection(page, README);
	await since.getByRole("button", { name: "Expand file" }).click();
	await expect(since.getByTestId("md-doc")).toBeVisible(GIT_WAIT);
	const sinceMaps = await check(since, "1");
	await expect(sinceMaps.first().locator(".md-image-alt")).toHaveText(
		"Route map: Strandkaien",
	);
	await expect(sinceMaps.last().locator(".md-image-alt")).toHaveText(
		"Route map: Nordnes",
	);
	await shot(since, "md-images-since");
});

test("phone: a short changed block (a table's header row) grows only to its targets, its bar running the row; full diff and since view (CAR-167 QA)", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "the touch gutter");
	const fares = (head: string) =>
		`# Fares\n\n| ${head} | Adult | Child |\n|:-------|------:|------:|\n| Single | 46 | 23 |\n| Return | 84 | 42 |\n\nEnd.\n`;
	const p = await pr({
		base: { [README]: fares("Ticket") },
		files: [{ message: "fares", files: { [README]: fares("Ticket type") } }],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const check = async (section: Locator, head: string) => {
		const row = section
			.getByTestId("md-block")
			.filter({ has: page.getByRole("checkbox") })
			.filter({ hasText: head });
		await expect(row).toHaveCount(1);
		const box = async (el: Locator) => {
			const b = await el.boundingBox();
			if (!b) throw new Error("not shown");
			return b;
		};
		const rowBox = await box(row);
		const body = await box(row.locator(".md-body"));
		// Three 40px targets in an 84px gutter: two rows of them, no more.
		expect(rowBox.height).toBeLessThanOrEqual(81);
		// The block's bar runs the row: no empty band above the next row.
		expect(Math.abs(body.height - rowBox.height)).toBeLessThanOrEqual(1);
		const targets = [
			row.getByTestId("cluster-box-target"),
			row.getByRole("button", { name: "Cross off cluster" }),
			row.getByTestId("md-comment"),
		];
		for (const t of targets) {
			expect(await tapHeight(t)).toBeGreaterThanOrEqual(40);
			expect(await tapWidth(t)).toBeGreaterThanOrEqual(40);
		}
		// The comment button's target starts where the box's ends.
		const tick = await box(targets[0] as Locator);
		const comment = await box(targets[2] as Locator);
		expect(comment.y).toBeGreaterThanOrEqual(tick.y + tick.height - 0.5);
		await expectNoPageOverflow(page);
	};

	const section = await openRendered(page);
	await check(section, "Ticket type");
	await shot(section, "md-short-block-full");

	await marksReady(page, section);
	await section
		.getByRole("button", { name: "Mark remaining reviewed" })
		.click();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);
	p.moveHead({ message: "again", files: { [README]: fares("Ticket class") } });
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
	const since = fileSection(page, README);
	await since.getByRole("button", { name: "Expand file" }).click();
	await expect(since.getByTestId("md-doc")).toBeVisible(GIT_WAIT);
	await check(since, "class");
	await shot(since, "md-short-block-since");
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

/*
 * Comments and threads on blocks (CAR-167, spec "Comments" and "Threads"):
 * a block's comment button comments on its last cluster's changed lines;
 * the posted thread shows under that block; an unchanged block has no
 * button; the file comment stays in the header. In the since view too.
 */
const COMMENTED = "docs/guide.md";
const guide = (words: [string, string, string]) => `# Doc

Para A

Para B

Para C

Para D

## Changes
${words[0]} x
${words[1]} y
${words[2]} z

Para F
`;

/** The GitHub threads the fake holds: where each was posted. */
const postedThreads = (p: Pr) =>
	(
		(
			JSON.parse(readFileSync(p.scenarioPath, "utf8")) as {
				prs: Record<
					number,
					{
						graphql?: {
							reviewThreads?: {
								originalLine: number | null;
								originalStartLine: number | null;
								diffSide: string;
								first: { nodes: { originalCommit: { oid: string } }[] };
								comments: { nodes: { body: string }[] };
							}[];
						};
					}
				>;
			}
		).prs[p.number]?.graphql?.reviewThreads ?? []
	).map((t) => ({
		startLine: t.originalStartLine,
		line: t.originalLine,
		side: t.diffSide,
		commit: t.first.nodes[0]?.originalCommit.oid,
		body: t.comments.nodes[0]?.body ?? "",
	}));

/** Comments on `text`'s block from its button; the thread shows under it. */
async function commentOnBlock(section: Locator, text: string, body: string) {
	const row = block(section, text);
	await row.getByRole("button", { name: "Comment on block" }).click();
	const composer = row.getByTestId("new-thread");
	await expect(composer).toContainText("lines 12–14, new");
	await composer.getByRole("textbox", { name: "Comment" }).fill(body);
	await composer.getByRole("button", { name: "Comment" }).click();
	await expect(row.getByTestId("new-thread")).toHaveCount(0);
	await expect(
		row.getByTestId("files-thread").filter({ hasText: body }),
	).toBeVisible(GIT_WAIT);
}

test("a block's comment goes on its last cluster's changed lines and its thread shows under the block; an unchanged block has none; the file comment stays in the header", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	const p = await pr({
		base: { [COMMENTED]: guide(["First old", "second old", "third old"]) },
		files: [
			{
				message: "docs",
				files: {
					[COMMENTED]: guide(["First new", "second new", "third new"]),
				},
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await openRendered(page, COMMENTED);
	// Unchanged blocks take no comment (GitHub takes them only in the diff).
	await expect(
		block(section, "Para F").getByRole("button", { name: "Comment on block" }),
	).toHaveCount(0);
	await expect(
		block(section, "Changes").getByRole("button", { name: "Comment on block" }),
	).toHaveCount(0);
	// The file's own bubble is in the header, not on a block.
	await expect(
		section.locator('[data-testid="thread-bubble"][data-file]'),
	).toHaveCount(1);
	await expect(
		section
			.getByTestId("md-doc")
			.locator('[data-testid="thread-bubble"][data-file]'),
	).toHaveCount(0);
	if (isMobile) {
		const button = block(section, "second").getByRole("button", {
			name: "Comment on block",
		});
		expect(await tapHeight(button)).toBeGreaterThanOrEqual(40);
	}
	// The changed paragraph (its words marked: "First oldnew x").
	await commentOnBlock(section, "second", "Why these three?");
	expect(postedThreads(p)).toEqual([
		expect.objectContaining({
			startLine: 12,
			line: 14,
			side: "RIGHT",
			commit: p.head(),
			body: expect.stringContaining("Why these three?"),
		}),
	]);
	// After a reload, under its block, behind its bubble.
	await page.reload();
	const again = fileSection(page, COMMENTED);
	const expand = again.getByRole("button", { name: "Expand file" });
	await expect(expand.or(again.getByTestId("md-doc"))).toBeVisible(GIT_WAIT);
	if (await expand.isVisible()) await expand.click();
	const bubble = block(again, "second").getByTestId("thread-bubble");
	await expect(bubble).toBeVisible(GIT_WAIT);
	await bubble.click();
	await expect(
		block(again, "second")
			.getByTestId("files-thread")
			.filter({ hasText: "Why these three?" }),
	).toBeVisible();
	await shot(again, `markdown-comment-${isMobile ? "phone" : "desktop"}`);
	// Resolve closes it down to its bubble, as in the line view; opened
	// again, it shows resolved.
	await block(again, "second").getByRole("button", { name: "Resolve" }).click();
	await expect(block(again, "second").getByTestId("files-thread")).toHaveCount(
		0,
	);
	await expect(bubble).toHaveAttribute("aria-expanded", "false");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);
	await bubble.click();
	await expect(
		block(again, "second").getByRole("article", { name: /^Resolved thread/ }),
	).toBeVisible(GIT_WAIT);
	await expectNoPageOverflow(page);
});

test("the since view: a block's comment goes on the head's changed lines and shows under the block", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr({
		base: { [COMMENTED]: guide(["First old", "second old", "third old"]) },
		files: [
			{
				message: "docs",
				files: {
					[COMMENTED]: guide(["First new", "second new", "third new"]),
				},
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	let section = await openRendered(page, COMMENTED);
	await marksReady(page, section);
	await section
		.getByRole("button", { name: "Mark remaining reviewed" })
		.click();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);
	p.moveHead({
		message: "rework",
		files: {
			[COMMENTED]: guide(["First newer", "second newer", "third newer"]),
		},
	});
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
	section = fileSection(page, COMMENTED);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.getByTestId("md-doc")).toBeVisible(GIT_WAIT);
	await shownAs(section, "markdown");
	await commentOnBlock(section, "second", "And now?");
	expect(postedThreads(p)).toEqual([
		expect.objectContaining({
			startLine: 12,
			line: 14,
			side: "RIGHT",
			commit: p.head(),
			body: expect.stringContaining("And now?"),
		}),
	]);
	await expectNoPageOverflow(page);
});

/** Gallery #61 tables.md and inline.md, cut down. */
const TABLES = "docs/tables.md";
const tablesDoc = (weekday: string[], vessels: string[], csv: string) =>
	[
		"# Timetable",
		"",
		"| Route | First | Last | Every |",
		"|-------|-------|------|-------|",
		...weekday,
		"",
		"Times are local.",
		"",
		...vessels,
		"",
		csv,
		"",
	].join("\n");
const WEEKDAY = [
	"| Strandkaien – Askøy | 06:10 | 23:40 | 30 min |",
	"| Strandkaien – Nordnes | 06:30 | 22:00 | 20 min |",
	"| Nordnes – Askøy | 07:00 | 21:00 | 60 min |",
];
const VESSELS_OLD = [
	"| Name | Built | Seats | Cars |",
	"|------|-------|-------|------|",
	"| MF Sølvberg | 2009 | 290 | 60 |",
];
const VESSELS_NEW = [
	"| Name | Built | Seats | Cars | Electric |",
	"|------|-------|-------|------|----------|",
	"| MF Sølvberg | 2009 | 290 | 60 | Landstrømanleggstrandkaien |",
];
const CSV_OLD = "The old CSV export is still available for partners.";
const CSV_NEW =
	"The old CSV export is ~~still available for partners~~ retired since March.";
const PS1_WEEKDAY = [
	WEEKDAY[0] as string,
	"| Strandkaien – Nordnes | 06:30 | 22:00 | 15 min |",
	WEEKDAY[2] as string,
	"| Askøy – Kleppestø | 06:45 | 22:15 | 45 min |",
];
const PS2_WEEKDAY = [
	PS1_WEEKDAY[0] as string,
	PS1_WEEKDAY[1] as string,
	"| Nordnes – Askøy | 07:00 | 21:00 | 45 min, weekdays only |",
	PS1_WEEKDAY[3] as string,
];

/**
 * The left edge of each column of the route table's row tables, per
 * column: one value each when the columns line up (within a pixel).
 */
const routeColumns = (section: Locator) =>
	section.getByTestId("md-doc").evaluate((doc) => {
		const tables = [...doc.querySelectorAll(".md-content table")].filter((t) =>
			/Askøy|Nordnes|Route/.test(t.textContent ?? ""),
		);
		const cols: number[][] = [];
		for (const t of tables) {
			const cells = t.querySelector("tr")?.children ?? [];
			[...cells].forEach((c, k) => {
				const xs = cols[k] ?? [];
				xs.push(Math.round(c.getBoundingClientRect().left));
				cols[k] = xs;
			});
		}
		return {
			tables: tables.length,
			spread: cols.map((xs) => Math.max(...xs) - Math.min(...xs)),
		};
	});

/** Words a cell broke across two lines (none: it wraps between words, or at a hyphen). */
const brokenWords = (section: Locator) =>
	section.getByTestId("md-doc").evaluate((doc) => {
		const out: string[] = [];
		for (const cell of doc.querySelectorAll(".md-content :is(td, th)")) {
			const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				const text = n.textContent ?? "";
				for (const m of text.matchAll(/[^\s\-–]+/g)) {
					const r = document.createRange();
					r.setStart(n, m.index);
					r.setEnd(n, m.index + m[0].length);
					const tops = new Set(
						[...r.getClientRects()].map((x) => Math.round(x.top)),
					);
					if (tops.size > 1) out.push(m[0]);
				}
			}
		}
		return out;
	});

/**
 * In a row with removed words and struck content (~~x~~): removed words
 * red, tinted, a thick red line; struck content its own color and a thin
 * line in it, never the removed words' nor the added words' look.
 */
async function expectStrikeApart(row: Locator) {
	const styles = await row.evaluate((el) => {
		const of = (e: Element | null) => {
			const c = e ? getComputedStyle(e) : null;
			return (
				c && {
					color: c.color,
					background: c.backgroundColor,
					line: c.textDecorationColor,
					thickness: c.textDecorationThickness,
				}
			);
		};
		return {
			removed: of(el.querySelector("del.md-del")),
			added: of(el.querySelector("ins.md-ins")),
			content: of(el.querySelector(".md-content del:not(.md-del)")),
		};
	});
	expect(styles.removed).not.toBeNull();
	expect(styles.content).not.toBeNull();
	expect(styles.content?.color).not.toBe(styles.removed?.color);
	expect(styles.content?.color).not.toBe(styles.added?.color);
	expect(styles.content?.background).not.toBe(styles.removed?.background);
	expect(styles.content?.line).not.toBe(styles.removed?.line);
	expect(styles.content?.thickness).not.toBe(styles.removed?.thickness);
}

test("a table's rows line up as one table, scroll in their own box on a phone and never break a word, in the full diff and the since view; an added ~~strikethrough~~ reads apart from removed words", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	const p = await pr({
		base: { [TABLES]: tablesDoc(WEEKDAY, VESSELS_OLD, CSV_OLD) },
		files: [
			{
				message: "tables",
				files: { [TABLES]: tablesDoc(PS1_WEEKDAY, VESSELS_NEW, CSV_NEW) },
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	let section = await openRendered(page, TABLES);
	// Same, changed and added rows: 1 header + 4 rows, one column edge each.
	const full = await routeColumns(section);
	expect(full.tables).toBeGreaterThanOrEqual(5);
	expect(full.spread.filter((d) => d > 1)).toEqual([]);
	expect(await brokenWords(section)).toEqual([]);
	if (isMobile) {
		// The wide vessels table scrolls inside its block.
		const wide = await section
			.getByTestId("md-doc")
			.evaluate((doc) =>
				[...doc.querySelectorAll(".md-content .md-table")].some(
					(t) => t.scrollWidth > t.clientWidth,
				),
			);
		expect(wide).toBe(true);
		await expectNoPageOverflow(page);
	}
	// The content's own strikethrough isn't the diff's removed mark.
	await expectStrikeApart(block(section, "CSV"));
	await shot(section, `markdown-tables-${isMobile ? "phone" : "desktop"}`);

	// The since view: the same.
	await marksReady(page, section);
	await section
		.getByRole("button", { name: "Mark remaining reviewed" })
		.click();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);
	p.moveHead({
		message: "rework",
		files: {
			[TABLES]: tablesDoc(
				PS2_WEEKDAY,
				VESSELS_NEW,
				CSV_NEW.replace("March", "April"),
			),
		},
	});
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
	section = fileSection(page, TABLES);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.getByTestId("md-doc")).toBeVisible(GIT_WAIT);
	await shownAs(section, "markdown");
	await expect(section.getByTestId("md-box")).toHaveCount(2);
	await expectStrikeApart(block(section, "CSV"));
	const since = await routeColumns(section);
	// The unchanged rows above fold away: the shown ones line up.
	expect(since.tables).toBeGreaterThanOrEqual(3);
	expect(since.spread.filter((d) => d > 1)).toEqual([]);
	expect(await brokenWords(section)).toEqual([]);
	if (isMobile) await expectNoPageOverflow(page);
});
