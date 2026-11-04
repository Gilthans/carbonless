import { execFileSync } from "node:child_process";
import type { Locator, Page } from "@playwright/test";
import {
	barBottom,
	expectNoPageOverflow,
	fileSection,
	openFiles,
	progress,
	sideBySide,
	tapHeight,
} from "./files-ui";
import {
	expect,
	OWNER_REPO,
	PR_NUMBER,
	type PrOptions,
	test,
} from "./fixtures";

const text = (lines: string[]) => `${lines.join("\n")}\n`;
const short = Array.from({ length: 12 }, (_, i) => `short ${i + 1}`);
const long = Array.from({ length: 300 }, (_, i) => `long ${i + 1}`);

/** b/long.ts: a 150-line cluster, then a one-line cluster 50 lines later. */
const fixture: PrOptions = {
	overview: { title: "Make the review header sticky" },
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

const box = async (locator: Locator) => {
	const b = await locator.boundingBox();
	if (!b) throw new Error("not rendered");
	return { top: b.y, bottom: b.y + b.height, height: b.height, width: b.width };
};

const appHeader = (page: Page) => page.locator("body header").first();
const appRow = (page: Page) => page.getByTestId("app-header-row");
const compactTitle = (page: Page) => page.getByTestId("compact-title");
/** The pill around the compact title: what fades in as the header sticks. */
const compactPill = (page: Page) => page.getByTestId("compact-title-pill");

/** Scrolls deep into the long cluster of b/long.ts, opened. */
async function deepInLongCluster(page: Page, open = true) {
	const section = fileSection(page, "b/long.ts");
	if (open) await section.getByRole("button", { name: "Expand file" }).click();
	await section
		.getByTestId("diff-line")
		.filter({ hasText: /long 90 changed$/ })
		.scrollIntoViewIfNeeded();
	return section;
}

test("the app header compacts after scrolling and its tabs work from deep down", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	// At the top: the full header, no small title.
	await expect(page.getByRole("heading", { level: 1 })).toBeInViewport();
	await expect(compactPill(page)).toHaveCSS("opacity", "0");
	const full = await box(appHeader(page));

	await deepInLongCluster(page);
	// Only the compact row is left, stuck at the top, with the small title.
	await expect
		.poll(async () => (await box(appHeader(page))).bottom)
		.toBe((await box(appRow(page))).bottom + 1);
	const header = await box(appHeader(page));
	// The whole row shows: nothing clipped at the top; its border below it.
	expect((await box(appRow(page))).top).toBe(0);
	expect(header.bottom).toBeLessThan(full.bottom);
	expect(header.bottom).toBeLessThanOrEqual(isMobile ? 48 : 56);
	await expect(page.getByRole("heading", { level: 1 })).not.toBeInViewport();
	await expect(compactPill(page)).toHaveCSS("opacity", "1");
	await expect(compactPill(page)).toContainText("#7");
	await expectNoPageOverflow(page);

	// The stack lines up, no gaps or overlaps: header, bar, file header.
	const bar = await barBottom(page);
	const barTop = (
		await box(
			progress(page).locator(
				"xpath=ancestor::div[contains(@class,'sticky')][1]",
			),
		)
	).top;
	expect(Math.abs(barTop - header.bottom)).toBeLessThanOrEqual(1);
	const fileHeader = await box(
		fileSection(page, "b/long.ts").locator("header"),
	);
	expect(Math.abs(fileHeader.top - bar)).toBeLessThanOrEqual(1);

	// The small title has the full one as its tooltip and takes you back
	// to the top, focusing the full title.
	// Keyboard focus (a key press first marks the input as the keyboard).
	await page.keyboard.press("Shift");
	await compactTitle(page).focus();
	// (Not its description: the name already says it.)
	await expect(page.locator("[role=tooltip]:not([hidden])")).toHaveText(
		"Make the review header sticky",
	);
	await compactTitle(page).click();
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
	await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
	await expect(compactPill(page)).toHaveCSS("opacity", "0");
	await deepInLongCluster(page, false);

	// One tap back to the overview, and back to the files.
	await page.getByRole("link", { name: "Overview" }).click();
	await expect(
		page.getByRole("region", { name: "What it does" }),
	).toBeVisible();
	await page.getByRole("link", { name: "Files changed" }).click();
	await expect(progress(page)).toBeVisible();
});

/**
 * The open overview scrolled to its end: the header stuck, cheaply (no
 * diff to expand), for the compact row's own tests.
 */
async function stuckOnOverview(page: Page) {
	await expect(
		page.getByRole("region", { name: "What it does" }),
	).toBeVisible();
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	await expect(compactPill(page)).toHaveCSS("opacity", "1");
	await expect(compactTitle(page)).not.toHaveAttribute("inert");
}

test("once stuck, the compact mark goes Home and the number to the PR on GitHub", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(fixture);
	const s = await startCrb();
	await page.goto(s.url);
	const home = page.getByTestId("compact-home-link");
	const number = page.getByTestId("compact-pr-link");
	// At the top, out of reach like the title: neither focusable nor clickable.
	await expect(compactTitle(page)).toHaveAttribute("inert");
	await expect(home).toHaveAttribute("inert");
	await expect(number).toHaveAttribute("inert");

	await stuckOnOverview(page);
	await expect(home).not.toHaveAttribute("inert");
	if (isMobile) {
		// At 360px the pill's column holds the clamped title alone: the
		// number goes rather than squeeze the title out, nothing overflows,
		// and the title is still a tap target.
		await expect(compactTitle(page)).toBeVisible();
		await expect(number).toBeHidden();
		await expectNoPageOverflow(page);
		expect(await tapHeight(compactTitle(page))).toBeGreaterThanOrEqual(40);
		await page.setViewportSize({ width: 412, height: 780 });
	}
	await expect(number).toBeVisible();
	await expect(number).not.toHaveAttribute("inert");
	await expect(home).toHaveAccessibleName("Home");
	await expect(home).toHaveAttribute("href", "/");
	await expect(number).toHaveAccessibleName("#7 on GitHub");
	await expect(number).toHaveAttribute(
		"href",
		"https://github.com/acme/widget/pull/7",
	);
	await expect(number).toHaveAttribute("target", "_blank");
	await expect(number).toHaveAttribute("rel", "noreferrer");
	// Title and number share the pill: one title to the eye.
	const pill = compactPill(page);
	await expect(pill.getByTestId("compact-title")).toHaveText(
		"Make the review header sticky",
	);
	await expect(pill.getByTestId("compact-pr-link")).toHaveText("#7");
	await expect(compactTitle(page)).toHaveAccessibleName(
		"Back to top: Make the review header sticky",
	);
	for (const el of [home, compactTitle(page), number]) {
		expect(await tapHeight(el)).toBeGreaterThanOrEqual(40);
	}
	// Beside the number the title keeps a tap's width.
	expect((await box(compactTitle(page))).width).toBeGreaterThanOrEqual(40);
	await expectNoPageOverflow(page);

	// The mark goes Home.
	await home.click();
	await expect(page).toHaveURL(`${new URL(s.url).origin}/`);
});

test("the compact row's keyboard order: mark, tabs, title, number, Refresh", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	// Wide enough for the number (the 360px floor is the test above's).
	if (isMobile) await page.setViewportSize({ width: 412, height: 780 });
	await pr(fixture);
	const s = await startCrb();
	await page.goto(s.url);
	await stuckOnOverview(page);
	const home = page.getByTestId("compact-home-link");
	const number = page.getByTestId("compact-pr-link");
	// Keyboard focus (a key press first marks the input as the keyboard).
	await page.keyboard.press("Shift");
	await home.focus();
	await expect(home).toBeFocused();
	await expect(page.locator("[role=tooltip]:not([hidden])")).toHaveText("Home");
	for (const name of ["Overview", "Files changed", "Final Verdict"]) {
		await page.keyboard.press("Tab");
		await expect(page.getByRole("link", { name })).toBeFocused();
	}
	await page.keyboard.press("Tab");
	await expect(compactTitle(page)).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(number).toBeFocused();
	await expect(page.locator("[role=tooltip]:not([hidden])")).toHaveText(
		"Open on GitHub",
	);
	await page.keyboard.press("Tab");
	await expect(page.getByRole("button", { name: "Refresh" })).toBeFocused();
	// None of that moved the page: the row is stuck.
	expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
	await expect(compactPill(page)).toHaveCSS("opacity", "1");
});

test("a five-digit PR number never crushes the compact title: it shows beside a tap-wide title or not at all", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 412, height: 780 });
	const p = await pr(fixture);
	// The same PR under a five-digit number: its ref, and gh's answers.
	const big = 12345;
	execFileSync(
		"git",
		["update-ref", `refs/pull/${big}/head`, `refs/pull/${PR_NUMBER}/head`],
		{ cwd: p.repo.path },
	);
	p.editScenario((sc) => {
		const seven = sc.prs[String(PR_NUMBER)];
		if (!seven) throw new Error("fixture PR missing");
		sc.prs[String(big)] = {
			...seven,
			view: {
				...seven.view,
				number: big,
				url: `https://github.com/${OWNER_REPO}/pull/${big}`,
			},
		};
	});
	const s = await startCrb(`${OWNER_REPO}#${big}`);
	await page.goto(s.url);
	await stuckOnOverview(page);
	const number = page.getByTestId("compact-pr-link");
	await expect(number).toHaveAttribute(
		"href",
		`https://github.com/${OWNER_REPO}/pull/${big}`,
	);
	const title = await box(compactTitle(page));
	if (await number.isVisible()) {
		await expect(number).toHaveText("#12345");
		expect(title.width).toBeGreaterThanOrEqual(40);
		expect(await tapHeight(number)).toBeGreaterThanOrEqual(40);
	} else {
		await expect(number).toBeHidden();
	}
	expect(title.width).toBeGreaterThanOrEqual(40);
	// Wide, it always shows.
	if (!isMobile) await expect(number).toBeVisible();
	await expectNoPageOverflow(page);
});

test("the overview's header compacts too", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(fixture);
	const s = await startCrb();
	await page.goto(s.url);
	await expect(
		page.getByRole("region", { name: "What it does" }),
	).toBeVisible();
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	await expect(compactPill(page)).toHaveCSS("opacity", "1");
	const header = await box(appHeader(page));
	expect(header.top).toBeLessThan(0);
	expect(header.bottom).toBeGreaterThan(0);
	await expect(
		page.getByRole("link", { name: "Files changed" }),
	).toBeInViewport();
	await expectNoPageOverflow(page);
});

test("a long cluster's checkbox and cross-off stay below the file header", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await deepInLongCluster(page);
	const first = section
		.getByTestId("diff-line")
		.filter({ hasText: /long 1 changed$/ });
	await expect(first).not.toBeInViewport();
	const checkbox = section
		.getByRole("checkbox", { name: "Mark cluster reviewed" })
		.first();
	const cross = section
		.getByRole("button", { name: "Cross off cluster" })
		.first();
	await expect(checkbox).toBeInViewport();
	await expect(cross).toBeInViewport();
	// Directly below the file header: its tap target touches the header.
	const header = await box(section.locator("header"));
	const target = await box(section.getByTestId("cluster-box-target").first());
	expect(target.top).toBeGreaterThanOrEqual(header.bottom - 1);
	expect(target.top - header.bottom).toBeLessThanOrEqual(isMobile ? 4 : 8);
	if (isMobile) expect(target.height).toBeGreaterThanOrEqual(40);
	// Floating changes no line's place.
	const line = section
		.getByTestId("diff-line")
		.filter({ hasText: /long 95 changed$/ });
	const lineTop = (await box(line)).top;

	// Still operable there: it marks its own cluster, not the next one.
	await checkbox.click();
	await expect(checkbox).toBeChecked();
	const later = section
		.getByRole("checkbox", { name: "Mark cluster reviewed" })
		.nth(1);
	await expect(later).not.toBeChecked();
	await expect((await box(line)).top).toBe(lineTop);
	await expect(
		section.getByRole("progressbar", { name: "File progress" }),
	).toHaveAttribute("aria-valuetext", /1 of 2 clusters reviewed/);
	await checkbox.click();
	await expect(checkbox).not.toBeChecked();

	// Past the cluster's end, its controls scroll away with it (room
	// below the last file to scroll that far).
	await page.addStyleTag({ content: "main { padding-bottom: 150vh; }" });
	const after = section
		.getByTestId("diff-line")
		.filter({ hasText: /long 151$/ });
	await page.evaluate(
		(by) => window.scrollBy(0, by),
		(await box(after)).top - (await box(section.locator("header"))).bottom,
	);
	await expect
		.poll(async () => (await box(checkbox)).bottom)
		.toBeLessThanOrEqual((await box(section.locator("header"))).bottom);
	await expectNoPageOverflow(page);
});

test("a long cluster's controls float over it side by side too", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await sideBySide(page, true);
	const section = await deepInLongCluster(page);
	await expect(
		section.locator('table[data-view="side-by-side"]'),
	).toBeVisible();
	const first = section
		.getByTestId("diff-line")
		.filter({ hasText: /long 1 changed$/ });
	await expect(first).toHaveAttribute("data-kind", "pair");
	await expect(first).not.toBeInViewport();
	const checkbox = section
		.getByRole("checkbox", { name: "Mark cluster reviewed" })
		.first();
	const cross = section
		.getByRole("button", { name: "Cross off cluster" })
		.first();
	await expect(checkbox).toBeInViewport();
	await expect(cross).toBeInViewport();
	await expect(section.locator("[data-stuck]")).toHaveCount(1);
	const header = await box(section.locator("header"));
	const target = await box(section.getByTestId("cluster-box-target").first());
	expect(target.top).toBeGreaterThanOrEqual(header.bottom - 1);
	expect(target.top - header.bottom).toBeLessThanOrEqual(isMobile ? 4 : 8);
	if (isMobile) expect(target.height).toBeGreaterThanOrEqual(40);
	const line = section
		.getByTestId("diff-line")
		.filter({ hasText: /long 95 changed$/ });
	const lineTop = (await box(line)).top;
	// Still operable there: it marks its own cluster, both sides fading.
	await checkbox.click();
	await expect(checkbox).toBeChecked();
	await expect(
		section.getByRole("checkbox", { name: "Mark cluster reviewed" }).nth(1),
	).not.toBeChecked();
	await expect(line).toHaveAttribute("data-reviewed", "true");
	await expect(line.locator('td[data-testid="code"]').first()).toHaveClass(
		/bg-del-done/,
	);
	await expect(line.locator('td[data-testid="code"]').last()).toHaveClass(
		/bg-add-done/,
	);
	await expect((await box(line)).top).toBe(lineTop);
	await expect(
		section.getByRole("progressbar", { name: "File progress" }),
	).toHaveAttribute("aria-valuetext", /1 of 2 clusters reviewed/);
	await expectNoPageOverflow(page);
});

test("every sticky layer is opaque: the diff never shows through", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await deepInLongCluster(page);
	await expect(
		section.getByRole("checkbox", { name: "Mark cluster reviewed" }).first(),
	).toBeInViewport();
	const layers = {
		app: appHeader(page),
		bar: progress(page).locator(
			"xpath=ancestor::div[contains(@class,'sticky')][1]",
		),
		file: section.locator("header"),
		controls: section.locator("[data-stuck=fixed]"),
	};
	for (const [name, layer] of Object.entries(layers)) {
		// What's on top at points spread over the layer is part of it.
		const misses = await layer.evaluate((el) => {
			const r = el.getBoundingClientRect();
			const out: string[] = [];
			for (const fx of [0.05, 0.3, 0.5, 0.7, 0.95]) {
				for (const fy of [0.2, 0.5, 0.8]) {
					const x = r.left + r.width * fx;
					const y = Math.max(0, r.top) + (r.bottom - Math.max(0, r.top)) * fy;
					const hit = document.elementFromPoint(x, y);
					if (!hit || !el.contains(hit)) {
						out.push(
							`${Math.round(x)},${Math.round(y)}: ${hit?.textContent?.slice(0, 30)}`,
						);
					}
				}
			}
			return out;
		});
		expect(misses, name).toEqual([]);
		// And it paints a solid background.
		const bg = await layer.evaluate(
			(el) => getComputedStyle(el).backgroundColor,
		);
		expect(bg, name).not.toMatch(/\/|rgba|transparent/);
	}
});
