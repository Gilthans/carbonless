import type { Locator, Page } from "@playwright/test";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import { fileSection, openFiles, progress, tapHeight } from "./files-ui";
import { expect, PR_NUMBER, type Pr, type PrOptions, test } from "./fixtures";

/**
 * Switching pages and back (tabs, browser back/forward) finds each page as
 * it was left: scroll, open file, loaded context lines, unit, opened thread.
 * Set UX_SHOTS to a directory to save screenshots along the way.
 */

const text = (lines: string[]) => `${lines.join("\n")}\n`;
const short = Array.from({ length: 12 }, (_, i) => `short ${i + 1}`);
const long = Array.from({ length: 300 }, (_, i) => `long ${i + 1}`);

const fixture: PrOptions = {
	overview: { title: "Keep both pages where the reviewer left them" },
	// A description long enough to scroll.
	bodyHTML: Array.from(
		{ length: 60 },
		(_, i) => `<p dir="auto">Paragraph ${i + 1} of the description.</p>`,
	).join("\n"),
	base: {
		"a/one.ts": text(short),
		"b/long.ts": text(long),
		"c/last.ts": text(short),
	},
	files: [
		{
			message: "PR change",
			files: {
				"a/one.ts": text(short.map((l) => `${l} x`)),
				"b/long.ts": text(
					long.map((l, i) =>
						i < 150 ? `${l} changed` : i === 200 ? `${l} later` : l,
					),
				),
				"c/last.ts": text(short.map((l) => `${l} z`)),
			},
		},
	],
};

/**
 * The bot's thread on b/long.ts line 3, written on the PR's head: placed on
 * its line from the start. (A thread the placements' late answer moves,
 * e.g. into the file's header list, shifts the page: 654 px above the
 * reader, which scroll anchoring makes a change of scrollY.)
 */
const botThread = (commit: string) =>
	reviewThread({ path: "b/long.ts", line: 3 }, [
		threadComment({
			login: "lint-bot",
			bot: true,
			text: "Unused import of fs in this module",
			// Long enough to be clipped, with a toggle to show it all.
			html: Array.from(
				{ length: 12 },
				(_, i) =>
					`<p dir="auto">Unused import ${i + 1} of <code class="notranslate">fs</code></p>`,
			).join("\n"),
			commit,
		}),
	]);

/** The PR of `fixture`, with the bot's thread on its head. */
async function openPr(pr: (o: PrOptions) => Promise<Pr>) {
	const p = await pr(fixture);
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((sc) => {
		const graph = sc.prs[PR_NUMBER]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [botThread(head)];
	});
	return p;
}

const shot = async (page: Page, name: string, project: string) => {
	const dir = process.env.UX_SHOTS;
	if (dir) await page.screenshot({ path: `${dir}/ux-${name}-${project}.png` });
};

const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

async function expectScroll(page: Page, y: number) {
	await expect
		.poll(async () => Math.abs((await scrollY(page)) - y))
		.toBeLessThanOrEqual(2);
	// And it stays there (nothing scrolls it again a frame later).
	await page.evaluate(
		() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 100))),
	);
	expect(Math.abs((await scrollY(page)) - y)).toBeLessThanOrEqual(2);
}

const tabLink = (page: Page, name: "Overview" | "Files changed") =>
	page
		.getByRole("navigation", { name: "PR pages" })
		.getByRole("link", { name });

/**
 * Taps a tab where it is on screen, like a person. (Playwright's click
 * would first scroll it "into view": the sticky row sits inside the page's
 * scroll-padding, so that would move the page before the switch.)
 */
const tab = (page: Page, name: "Overview" | "Files changed") => ({
	click: async () => {
		const b = await tabLink(page, name).boundingBox();
		if (!b) throw new Error(`${name} tab not rendered`);
		await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
	},
});

const filesKept = (page: Page) => page.locator('[data-page="/files"]');
const overviewKept = (page: Page) => page.locator('[data-page="/"]');
const whatItDoes = (page: Page) =>
	page.getByRole("region", { name: "What it does" });
/** The bot thread's show more / show less toggle. */
const botPreview = (page: Page) =>
	page
		.getByRole("region", { name: "Bot reviews" })
		.getByRole("button", { name: /^Show (more|less)$/ });

/** The hidden page: out of layout, inert, and not in the accessibility tree. */
async function expectHidden(page: Page, kept: Locator, mark: string) {
	await expect(kept).toBeHidden();
	await expect(kept).toHaveAttribute("inert", "");
	await expect(kept).toHaveAttribute("aria-hidden", "true");
	expect(await page.locator("main").ariaSnapshot()).not.toContain(mark);
}

/** Tab through the whole page: focus never enters `kept`. */
async function expectTabSkips(page: Page, kept: Locator) {
	await page.locator("body").focus();
	// Every focus move is recorded in the page, so the 40 presses need no
	// round trip each.
	await kept.evaluate((el) => {
		const w = window as unknown as {
			stops: boolean[];
			watch?: AbortController;
		};
		w.watch?.abort();
		w.watch = new AbortController();
		w.stops = [];
		document.addEventListener(
			"focusin",
			(e) => w.stops.push(el.contains(e.target as Node)),
			{ signal: w.watch.signal },
		);
	});
	for (let i = 0; i < 40; i++) await page.keyboard.press("Tab");
	const stops = await page.evaluate(
		() => (window as unknown as { stops: boolean[] }).stops,
	);
	expect(stops.length).toBeGreaterThan(0);
	expect(stops.indexOf(true), "first tab stop inside").toBe(-1);
}

/** What the Files page looks like, to compare after switching back. */
async function filesState(page: Page) {
	const section = fileSection(page, "b/long.ts");
	return {
		lines: await section.getByTestId("diff-line").count(),
		expanded: await page.getByRole("button", { name: "Collapse file" }).count(),
		unit: await page.getByRole("radio", { name: "Files" }).isChecked(),
		loaded: await section
			.getByTestId("diff-line")
			.filter({ hasText: /long 160$/ })
			.count(),
		sheet: await page.getByRole("dialog", { name: "Files" }).isVisible(),
	};
}

test("switching pages and back puts each one exactly where it was left", async ({
	page,
	pr,
	startCrb,
	isMobile,
}, info) => {
	// Long by nature (both pages, 40 Tab presses on each): a loaded machine
	// needs more than the default 30 s for it.
	test.slow();
	const project = isMobile ? "phone" : "desktop";
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await openPr(pr);
	const s = await startCrb();
	await openFiles(page, s.url, "Files");

	// Open a file, load context lines below its first cluster, scroll deep.
	const section = fileSection(page, "b/long.ts");
	await section.getByRole("button", { name: "Expand file" }).click();
	const before = await section.getByTestId("diff-line").count();
	await section
		.getByRole("button", { name: /^Load \d+ lines below$/ })
		.first()
		.click();
	await expect(
		section.getByTestId("diff-line").filter({ hasText: /long 160$/ }),
	).toHaveCount(1);
	expect(await section.getByTestId("diff-line").count()).toBeGreaterThan(
		before,
	);
	await section
		.getByTestId("diff-line")
		.filter({ hasText: /long 120 changed$/ })
		.scrollIntoViewIfNeeded();
	await page.evaluate(() => window.scrollBy(0, 37));
	const filesY = await scrollY(page);
	expect(filesY).toBeGreaterThan(1000);
	const files = await filesState(page);
	expect(files).toMatchObject({ expanded: 1, unit: true, sheet: false });
	await shot(page, "keepalive-files-left", project);
	// Keyboard focus on the sticky tabs doesn't move the page either.
	await tabLink(page, "Overview").focus();
	await expectScroll(page, filesY);

	// To the overview: it shows from its top; the files page is kept, hidden.
	await tab(page, "Overview").click();
	await expect(whatItDoes(page)).toBeVisible();
	await expectScroll(page, 0);
	await expectHidden(page, filesKept(page), "Review progress");
	await expectTabSkips(page, filesKept(page));
	// Open a thread's preview and scroll down there.
	await botPreview(page).click();
	await expect(botPreview(page)).toHaveAttribute("aria-expanded", "true");
	await page.evaluate(() => window.scrollTo(0, 300));
	const overviewY = await scrollY(page);
	expect(overviewY).toBeGreaterThan(100);
	await shot(page, "keepalive-overview-left", project);

	// Back to the files: same scroll, same open file, same loaded lines.
	await tab(page, "Files changed").click();
	await expect(progress(page)).toBeVisible();
	await expectScroll(page, filesY);
	expect(await filesState(page)).toEqual(files);
	await expectHidden(page, overviewKept(page), "What it does");
	// The cluster's controls float below the open header again.
	await expect(
		section.getByRole("checkbox", { name: "Mark cluster reviewed" }).first(),
	).toBeInViewport();
	await shot(page, "keepalive-files-back", project);
	// (Tabbing scrolls to each focused control; then back to where it was.)
	await expectTabSkips(page, overviewKept(page));
	await page.evaluate((y) => window.scrollTo(0, y), filesY);
	await expectScroll(page, filesY);

	// And the overview again: its scroll and the opened thread.
	await tab(page, "Overview").click();
	await expect(whatItDoes(page)).toBeVisible();
	await expectScroll(page, overviewY);
	await expect(botPreview(page)).toHaveAttribute("aria-expanded", "true");
	await shot(page, "keepalive-overview-back", project);

	// Browser back and forward do the same.
	await page.goBack();
	await expect(page).toHaveURL(/\/files$/);
	await expect(progress(page)).toBeVisible();
	await expectScroll(page, filesY);
	expect(await filesState(page)).toEqual(files);
	await page.goBack();
	await expect(page).toHaveURL(/\/r\/[0-9a-z]{26}$/);
	await expect(whatItDoes(page)).toBeVisible();
	await expectScroll(page, overviewY);
	await expect(botPreview(page)).toHaveAttribute("aria-expanded", "true");
	await page.goForward();
	await expect(page).toHaveURL(/\/files$/);
	await expectScroll(page, filesY);
	expect(await filesState(page)).toEqual(files);
	await expectHidden(page, overviewKept(page), "What it does");
	info.annotations.push({
		type: "scroll",
		description: `files ${filesY}, overview ${overviewY}`,
	});
});

test("leaving the files page with the tree sheet open closes it", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "the sheet is the phone's tree");
	await openPr(pr);
	const s = await startCrb();
	await page.goto(s.url);
	await tab(page, "Files changed").click();
	await expect(progress(page)).toBeVisible();
	await page.getByRole("button", { name: "Files", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "Files" })).toBeVisible();
	await page.goBack();
	await expect(whatItDoes(page)).toBeVisible();
	// The overview is usable: nothing modal left over it.
	await tab(page, "Files changed").click();
	await expect(progress(page)).toBeVisible();
	await expect(page.getByRole("dialog", { name: "Files" })).toBeHidden();
	await expect(
		page.evaluate(() => document.documentElement.style.overflow),
	).resolves.toBe("");
});

test("the compact title is centered between the tabs and the header's next button (Find in PR, before Refresh), on a pill", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	const project = isMobile ? "phone" : "desktop";
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await openPr(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	await fileSection(page, "b/long.ts")
		.getByRole("button", { name: "Expand file" })
		.click();
	await page.evaluate(() => window.scrollTo(0, 1500));
	const title = page.getByTestId("compact-title");
	await expect(page.getByTestId("compact-title-pill")).toHaveCSS(
		"opacity",
		"1",
	);
	const box = async (l: Locator) => {
		const b = await l.boundingBox();
		if (!b) throw new Error("not rendered");
		return b;
	};
	const nav = await box(page.getByRole("navigation", { name: "PR pages" }));
	// The title's gap ends at the first button after it: Find in PR, then Refresh.
	const find = await box(
		page.getByRole("button", { name: "Find in PR", exact: true }),
	);
	const refresh = await box(page.getByRole("button", { name: "Refresh" }));
	expect(find.x + find.width).toBeLessThanOrEqual(refresh.x);
	const pill = await box(page.getByTestId("compact-title-pill"));
	const gapCenter = (nav.x + nav.width + find.x) / 2;
	expect(Math.abs(pill.x + pill.width / 2 - gapCenter)).toBeLessThanOrEqual(4);
	expect(pill.x).toBeGreaterThanOrEqual(nav.x + nav.width);
	expect(pill.x + pill.width).toBeLessThanOrEqual(find.x);
	expect(await tapHeight(title)).toBeGreaterThanOrEqual(40);
	const bg = await page
		.getByTestId("compact-title-pill")
		.evaluate((el) => getComputedStyle(el).backgroundColor);
	expect(bg).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
	const { scrollWidth, clientWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth,
	}));
	expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
	const dir = process.env.UX_SHOTS;
	if (dir) {
		await page.screenshot({
			path: `${dir}/ux-title-centered-${project}.png`,
			clip: {
				x: 0,
				y: 0,
				width: page.viewportSize()?.width ?? 360,
				height: 160,
			},
		});
	}
});

const WIDE_PATH = "w/a/rather/deep/directory/for/the/wide/file/wide.ts";
const wideLine = (i: number) => `const line${i} = "${"wide ".repeat(60)}";`;
const wide = Array.from({ length: 6 }, (_, i) => wideLine(i + 1));
const wideFixture: PrOptions = {
	...fixture,
	base: { ...fixture.base, [WIDE_PATH]: text(wide) },
	files: [
		{
			message: "PR change",
			files: {
				...fixture.files?.[0]?.files,
				[WIDE_PATH]: text(wide.map((l) => l.replace("wide ", "WIDE "))),
			},
		},
	],
};

/** The open file's diff scroller (not its path scroller). */
const diffScroller = (section: Locator) =>
	section.locator("div.overflow-x-auto:has(table)");

/** Every path scroller is pinned fully right (the file name shows). */
async function expectPathsPinned(page: Page) {
	const offsets = await page
		.getByTestId("file-path")
		.evaluateAll((els) =>
			els.map((el) => el.scrollWidth - el.clientWidth - el.scrollLeft),
		);
	expect(offsets.length).toBeGreaterThan(0);
	for (const gap of offsets) expect(Math.abs(gap)).toBeLessThanOrEqual(1);
}

test("a diff scrolled sideways is still scrolled there after visiting the overview", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(wideFixture);
	const s = await startCrb();
	// Land on the files first: the overview mounts later, before it in the DOM.
	await openFiles(page, s.url);
	const section = fileSection(page, WIDE_PATH);
	await section.getByRole("button", { name: "Expand file" }).click();
	const scroller = diffScroller(section);
	await scroller.evaluate((el) => {
		el.scrollLeft = 120;
	});
	await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(120);
	await tab(page, "Overview").click();
	await expect(whatItDoes(page)).toBeVisible();
	await tab(page, "Files changed").click();
	await expect(progress(page)).toBeVisible();
	await page.evaluate(
		() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 100))),
	);
	expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(120);
	await expectPathsPinned(page);
});

test("a new snapshot loaded from the overview shows the files from the top", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	const p = await pr(wideFixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	// Room to scroll even with every file closed, so a stale offset would show.
	await page.addStyleTag({ content: "main { padding-bottom: 300vh; }" });
	const section = fileSection(page, WIDE_PATH);
	await section.getByRole("button", { name: "Expand file" }).click();
	await diffScroller(section).evaluate((el) => {
		el.scrollLeft = 120;
	});
	const long = fileSection(page, "b/long.ts");
	await long.getByRole("button", { name: "Expand file" }).click();
	await long
		.getByTestId("diff-line")
		.filter({ hasText: /long 120 changed$/ })
		.scrollIntoViewIfNeeded();
	expect(await scrollY(page)).toBeGreaterThan(1000);

	await tab(page, "Overview").click();
	await expect(whatItDoes(page)).toBeVisible();
	p.moveHead({
		message: "later push",
		files: { "c/last.ts": text(short.map((l) => `${l} pushed`)) },
	});
	const reviewed = page.waitForResponse(
		(r) => r.url().endsWith("/review") && r.ok(),
	);
	await page.getByRole("button", { name: "Refresh" }).click();
	await reviewed;

	await tab(page, "Files changed").click();
	await expect(progress(page)).toBeVisible();
	await expectScroll(page, 0);
	// A new snapshot starts with every file closed; nothing keeps an old offset.
	await expect(page.getByRole("button", { name: "Collapse file" })).toHaveCount(
		0,
	);
	await section.getByRole("button", { name: "Expand file" }).click();
	expect(await diffScroller(section).evaluate((el) => el.scrollLeft)).toBe(0);
	await expectPathsPinned(page);
});
