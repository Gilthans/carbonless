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
import { expect, type PrOptions, test } from "./fixtures";

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

/**
 * Its own crb serve, so its PR is #7: these place a short PR number in the
 * compact row at phone widths (a shared test's is #1xx), and one goes Home.
 */
const ownTest = test.extend({ crbServer: "own" as const });

test("the app header compacts after scrolling and its tabs work from deep down", async ({
	page,
	pr,
	prNumber,
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
	await expect(compactPill(page)).toContainText(`#${prNumber}`);
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
	// to the top, focusing the full title. (At 360px, beside the agent
	// chip, it has no room: a wider phone shows it.)
	if (isMobile) await page.setViewportSize({ width: 430, height: 780 });
	await expect(compactTitle(page)).toBeVisible();
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

ownTest(
	"once stuck, the compact mark goes Home and the number to the PR on GitHub",
	async ({ page, pr, startCrb, isMobile }) => {
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
			// At 360px, beside the agent chip, the pill's column can't hold a
			// tap-wide title: the pill goes rather than cover the buttons, and
			// nothing overflows.
			await expect(compactPill(page)).toBeHidden();
			await expectNoPageOverflow(page);
			// At 420px it holds the clamped title alone: the number goes rather
			// than squeeze the title out, and the title is still a tap target.
			await page.setViewportSize({ width: 420, height: 780 });
			await expect(compactTitle(page)).toBeVisible();
			await expect(number).toBeHidden();
			await expectNoPageOverflow(page);
			expect(await tapHeight(compactTitle(page))).toBeGreaterThanOrEqual(40);
			expect((await box(compactTitle(page))).width).toBeGreaterThanOrEqual(40);
			await page.setViewportSize({ width: 460, height: 780 });
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
	},
);

const shots = process.env.DESIGN_SHOTS;

/**
 * Scrolls from the top in 6px steps until the header sticks: at each step
 * exactly one agent chip, wholly on screen below `below` (the find bar's
 * bottom, if open), and the Overview tab at `tabX`.
 */
async function scrollToStick(page: Page, tabX: number | undefined, below = 0) {
	const overview = page.getByRole("link", { name: "Overview" });
	const stuckAt = await appRow(page).evaluate(
		(r) => (r as HTMLElement).offsetTop,
	);
	const top = await page.evaluate(() => window.scrollY);
	for (let y = top; y <= top + stuckAt + 8; y += 6) {
		await page.evaluate((y) => window.scrollTo(0, y), y);
		await expect
			.poll(() =>
				page.evaluate((below) => {
					const all = document.querySelectorAll('[data-testid="agent-chip"]');
					if (all.length !== 1) return `${all.length} chips`;
					const r = all[0]?.getBoundingClientRect();
					if (!r) return "no chip";
					return r.top >= below - 0.5 && r.bottom <= window.innerHeight
						? "in sight"
						: `at ${r.top}`;
				}, below),
			)
			.toBe("in sight");
		expect((await overview.boundingBox())?.x).toBe(tabX);
	}
}

test("the tabs and the title never move as the agent loads: the chip's place is kept from the first paint", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(fixture);
	const s = await startCrb();
	// The overview (whether there is an agent) and the agent's status,
	// each held until let go.
	const held = (pattern: RegExp) => {
		let release = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		return {
			route: page.route(pattern, async (route) => {
				await gate;
				await route.continue();
			}),
			release: () => release(),
		};
	};
	const overview = held(/\/api\/r\/[^/]+\/overview/);
	const agent = held(/\/api\/r\/[^/]+\/agent$/);
	await overview.route;
	await agent.route;
	await page.goto(s.url);
	const files = page.getByRole("link", { name: "Files changed" });
	await expect(files).toBeVisible();
	const at = async () => ({
		tab: await files.boundingBox(),
		title: (await page.getByTestId("header-title").boundingBox())?.x,
	});
	const first = await at();
	// Its place, spinning, by the logo (soft: the tabs are what's checked).
	await expect.soft(page.getByTestId("agent-chip-pending")).toBeVisible();
	overview.release();
	await expect(page.getByTestId("agent-chip")).toHaveAttribute(
		"aria-busy",
		"true",
	);
	expect(await at()).toEqual(first);
	agent.release();
	await expect(page.getByTestId("agent-chip-icon")).toBeVisible();
	expect(await at()).toEqual(first);
});

test("a long title wrapping over several lines: the chip stays by the logo, then in sight as the header sticks", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr({
		...fixture,
		overview: {
			title:
				"Make the review header sticky, keep the agent chip in sight beside the logo, and never let the tabs jump while it moves",
		},
	});
	const s = await startCrb();
	await page.goto(s.url);
	await expect(
		page.getByRole("region", { name: "What it does" }),
	).toBeVisible();
	const h1 = await box(page.getByRole("heading", { level: 1 }));
	// Two lines on desktop, more on a phone.
	expect(h1.height).toBeGreaterThan(40);
	const chip = page.getByTestId("agent-chip");
	await expect(page.getByTestId("agent-chip-slot").locator(chip)).toBeVisible();
	const tabX = (
		await page.getByRole("link", { name: "Overview" }).boundingBox()
	)?.x;
	await scrollToStick(page, tabX);
	await expect(appRow(page).locator(chip)).toBeVisible();
	await expectNoPageOverflow(page);
});

test("with Find in PR open above the header, the chip docks under the bar, and the tabs don't move", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "a phone's find bar takes the header's place");
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await page.getByRole("button", { name: "Find in PR", exact: true }).click();
	const bar = page.getByRole("search", { name: "Find in PR" });
	await expect(bar).toBeVisible();
	// Back to the top with the bar open, the header under it.
	await page.evaluate(() => window.scrollTo(0, 0));
	const chip = page.getByTestId("agent-chip");
	await expect(page.getByTestId("agent-chip-slot").locator(chip)).toBeVisible();
	// The header sits under the bar's slot (the bar and its own rows).
	const below = (await box(page.locator("[data-find-slot]"))).bottom;
	expect(below).toBeGreaterThanOrEqual((await box(bar)).bottom);
	expect((await box(chip)).top).toBeGreaterThanOrEqual(below);
	const tabX = (
		await page.getByRole("link", { name: "Overview" }).boundingBox()
	)?.x;
	await scrollToStick(page, tabX, below);
	await expect(appRow(page).locator(chip)).toBeVisible();
	// Deeper down, stuck under the bar, the chip in it below the bar.
	await page.evaluate(() => window.scrollBy(0, 600));
	await expect
		.poll(async () => (await box(appRow(page))).top)
		.toBeGreaterThanOrEqual(below - 0.5);
	expect((await box(chip)).top).toBeGreaterThanOrEqual(below - 0.5);
	await expect(appRow(page).locator(chip)).toBeInViewport();
});

test("with no agent (--viewer): no chip and no space for it, by the logo or in the row; the compact title as before", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(fixture);
	const s = await startCrb(undefined, ["--viewer", "someone-else"]);
	await page.goto(s.url);
	await expect(
		page.getByRole("region", { name: "What it does" }),
	).toBeVisible();
	await expect(page.getByTestId("agent-chip")).toHaveCount(0);
	await expect(page.getByTestId("agent-chip-slot")).toBeHidden();
	await expect(page.getByTestId("agent-chip-row-slot")).toBeHidden();
	// The title right after the logo, one gap between them.
	const logo = await page.getByTestId("home-link").boundingBox();
	const title = await page.getByTestId("header-title").boundingBox();
	if (!logo || !title) throw new Error("not rendered");
	expect(title.x - (logo.x + logo.width)).toBe(isMobile ? 8 : 12);
	// The tabs right after the mark's slot.
	const row = await box(appRow(page));
	const rowX = (await appRow(page).boundingBox())?.x ?? 0;
	const overviewX =
		(await page.getByRole("link", { name: "Overview" }).boundingBox())?.x ?? 0;
	expect(overviewX - rowX).toBe((isMobile ? 8 : 24) + 28);
	expect(row.height).toBeGreaterThan(0);
	// Stuck at 360px, the compact title shows: no chip to give way to.
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	await expect(page.getByTestId("compact-home-link")).not.toHaveAttribute(
		"inert",
	);
	await expect(compactPill(page)).toBeVisible();
	await expect(compactTitle(page)).toBeVisible();
	await expectNoPageOverflow(page);
});

test("the agent chip sits by the logo, and stays in sight and in reach as the header sticks", async ({
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
	const chip = page.getByTestId("agent-chip");
	const overview = page.getByRole("link", { name: "Overview" });
	// At the top: right after the logo, centred on it, before the title.
	await expect(page.getByTestId("agent-chip-slot").locator(chip)).toBeVisible();
	const logo = await page.getByTestId("home-link").boundingBox();
	const at = await chip.boundingBox();
	const title = await page.getByTestId("header-title").boundingBox();
	if (!logo || !at || !title) throw new Error("not rendered");
	expect(at.x).toBeGreaterThanOrEqual(logo.x + logo.width);
	expect(at.x - (logo.x + logo.width)).toBeLessThanOrEqual(12);
	expect(at.x + at.width).toBeLessThanOrEqual(title.x);
	expect(
		Math.abs(at.y + at.height / 2 - (logo.y + logo.height / 2)),
	).toBeLessThanOrEqual(2);
	const tabX = (await overview.boundingBox())?.x;
	await expectNoPageOverflow(page);
	if (shots)
		await page.screenshot({
			path: `${shots}/chip-top-${isMobile ? "phone" : "desktop"}.png`,
		});

	// Scrolled bit by bit until the header sticks: one chip, never off
	// screen, the tabs never moving.
	await scrollToStick(page, tabX);

	// Stuck: beside the compact mark, in the row at the top.
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	await expect(page.getByTestId("compact-home-link")).not.toHaveAttribute(
		"inert",
	);
	await expect(appRow(page).locator(chip)).toBeVisible();
	expect((await box(appRow(page))).top).toBe(0);
	const mark = await page.getByTestId("compact-home-link").boundingBox();
	const docked = await chip.boundingBox();
	if (!mark || !docked) throw new Error("not rendered");
	expect(docked.x).toBeGreaterThan(mark.x);
	expect(docked.x + docked.width).toBeLessThanOrEqual(
		(await overview.boundingBox())?.x ?? 0,
	);
	expect((await overview.boundingBox())?.x).toBe(tabX);
	await expect(chip).toHaveAccessibleName(/^Your agent: /);
	// It reads as a button: a 28px circle with a control's border, the
	// sparkle inside; a 40px tap target.
	const face = page.getByTestId("agent-chip-face");
	const ring = await face.evaluate((el) => {
		const c = getComputedStyle(el);
		const r = el.getBoundingClientRect();
		return {
			width: r.width,
			height: r.height,
			border: c.borderTopWidth,
			color: c.borderTopColor,
		};
	});
	expect(ring).toMatchObject({ width: 28, height: 28, border: "1px" });
	expect(ring.color).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
	expect(
		(await page.getByTestId("agent-chip-icon").locator("svg").boundingBox())
			?.width,
	).toBe(18);
	expect(await tapHeight(chip)).toBeGreaterThanOrEqual(40);
	if (isMobile) {
		expect(await tapHeight(chip)).toBeGreaterThanOrEqual(40);
		// The whole row fits: Refresh and Settings still on screen.
		for (const name of ["Refresh", "Settings"]) {
			const b = await appRow(page).getByRole("button", { name }).boundingBox();
			expect((b?.x ?? 0) + (b?.width ?? 0)).toBeLessThanOrEqual(360);
		}
	}
	await expectNoPageOverflow(page);
	if (shots)
		await page.screenshot({
			path: `${shots}/chip-stuck-${isMobile ? "phone" : "desktop"}.png`,
		});

	// In reach: it opens the agent setup, and focus comes back to it.
	await chip.click();
	const setup = page.getByRole("dialog", { name: "Your agent" });
	await expect(setup).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(setup).toHaveCount(0);
	await expect(chip).toBeFocused();

	// The setup open from the docked chip, the page behind it scrolled to
	// the top (the chip back by the logo): closing it still gives the chip
	// its focus back.
	await chip.click();
	await expect(setup).toBeVisible();
	await page.evaluate(() => window.scrollTo(0, 0));
	await expect(page.getByTestId("agent-chip-slot").locator(chip)).toHaveCount(
		1,
	);
	await page.keyboard.press("Escape");
	await expect(setup).toHaveCount(0);
	await expect(chip).toBeFocused();

	// Docked again with focus on it, then back at the top: by the logo
	// again; still one, still focused.
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	await expect(appRow(page).locator(chip)).toBeVisible();
	await expect(chip).toBeFocused();
	await page.evaluate(() => window.scrollTo(0, 0));
	await expect(page.getByTestId("agent-chip-slot").locator(chip)).toBeVisible();
	await expect(chip).toHaveCount(1);
	// The move kept the keyboard on it.
	await expect(chip).toBeFocused();
	expect((await overview.boundingBox())?.x).toBe(tabX);
});

ownTest(
	"the compact row's keyboard order: mark, agent chip, tabs, title, number, Find in PR, Refresh",
	async ({ page, pr, startCrb, isMobile }) => {
		// Wide enough for the number (the narrower floors are the test above's).
		if (isMobile) await page.setViewportSize({ width: 460, height: 780 });
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
		await expect(page.locator("[role=tooltip]:not([hidden])")).toHaveText(
			"Home",
		);
		await page.keyboard.press("Tab");
		await expect(page.getByTestId("agent-chip")).toBeFocused();
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
		await expect(
			page.getByRole("button", { name: "Find in PR" }),
		).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(page.getByRole("button", { name: "Refresh" })).toBeFocused();
		// None of that moved the page: the row is stuck.
		expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
		await expect(compactPill(page)).toHaveCSS("opacity", "1");
	},
);

test("a five-digit PR number never crushes the compact title: it shows beside a tap-wide title or not at all", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 440, height: 780 });
	const p = await pr(fixture);
	// The same PR under a five-digit number: its ref, and gh's answers.
	const big = 12345;
	execFileSync(
		"git",
		["update-ref", `refs/pull/${big}/head`, `refs/pull/${p.number}/head`],
		{ cwd: p.repo.path },
	);
	p.editScenario((sc) => {
		const seven = sc.prs[String(p.number)];
		if (!seven) throw new Error("fixture PR missing");
		sc.prs[String(big)] = {
			...seven,
			view: {
				...seven.view,
				number: big,
				url: `https://github.com/${p.ownerRepo}/pull/${big}`,
			},
		};
	});
	const s = await startCrb(`${p.ownerRepo}#${big}`);
	await page.goto(s.url);
	await stuckOnOverview(page);
	const number = page.getByTestId("compact-pr-link");
	await expect(number).toHaveAttribute(
		"href",
		`https://github.com/${p.ownerRepo}/pull/${big}`,
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
