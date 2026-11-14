import type { Locator, Page } from "@playwright/test";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import {
	expectNoPageOverflow,
	fileSection,
	openFiles,
	tapHeight,
} from "./files-ui";
import { expect, type Pr, type PrOptions, test } from "./fixtures";

const APP = "src/app.py";
// Long enough to be cut at 360px.
const FAREWELL =
	'def farewell(self, who, greeting="goodbye", times=1, loud=False):';
const text = (lines: string[]) => `${lines.join("\n")}\n`;
const body = (name: string, n: number) =>
	Array.from({ length: n }, (_, i) => `        ${name}_${i + 1} = ${i + 1}`);

/**
 * A class with two long methods: 1 import, 3 class, 4 def greet, 5–54 its
 * body, 56 def farewell, 57–96 its body. The PR changes lines 10, 66 and 86:
 * hunks 7–13 (in greet), 63–69 and 83–89 (in farewell). Hidden: 1–6 (↑),
 * 14–62 (49 lines: ↓ and ↑), 70–82 (13: ↕) and the tail 90–96 (↓).
 */
const base = [
	"import os",
	"",
	"class Greeter:",
	"    def greet(self, who):",
	...body("g", 50),
	"",
	`    ${FAREWELL}`,
	...body("f", 40),
];
const changed = base.map((line, i) =>
	[10, 66, 86].includes(i + 1) ? `${line}  # changed` : line,
);
const fixture: PrOptions = {
	base: { [APP]: text(base) },
	files: [{ message: "Touch two methods", files: { [APP]: text(changed) } }],
};

async function setup(pr: (opts?: PrOptions) => Promise<Pr>, thread = false) {
	const p = await pr(fixture);
	if (thread) {
		const head = p.repo.shas.at(-1) ?? "";
		p.editScenario((s) => {
			const graph = s.prs[p.number]?.graphql;
			if (!graph) throw new Error("no PR in the scenario");
			graph.reviewThreads = [
				reviewThread({ path: APP, line: 60, subjectType: "LINE" }, [
					threadComment({ login: "rev1", text: "Hidden one", commit: head }),
				]),
			];
		});
	}
	return p;
}

/** A heading that will resolve `settled` when its scroll ends. */
type Settling = HTMLElement & { settled?: Promise<void> };

async function open(page: Page, url: string) {
	await openFiles(page, url);
	const section = fileSection(page, APP);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.getByTestId("hunk-header")).toHaveCount(3);
	return section;
}

const line = (section: Locator, n: number) =>
	section.locator(`tr[data-testid="diff-line"][data-new-no="${n}"]`);
const gapRow = (section: Locator, hidden: string) =>
	section.getByTestId("gap-row").filter({ hasText: hidden });

test("a hunk's function shows once: on the hidden row right above it, else on its @@", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await setup(pr);
	const s = await startCrb();
	const section = await open(page, s.url);
	const headers = section.getByTestId("hunk-header");
	const headings = section.getByTestId("hunk-heading");
	// Each hunk has hidden lines right above it: the heading is there.
	await expect(headings).toHaveCount(3);
	await expect(headers.getByTestId("hunk-heading")).toHaveCount(0);
	await expect(
		gapRow(section, "6 hidden lines").getByTestId("hunk-heading"),
	).toHaveText("def greet(self, who):");
	await expect(
		gapRow(section, "49 hidden lines").getByTestId("hunk-heading"),
	).toHaveText(FAREWELL);
	await expect(
		gapRow(section, "13 hidden lines").getByTestId("hunk-heading"),
	).toHaveText(FAREWELL);
	// The file's tail has no hunk below it.
	await expect(
		gapRow(section, "7 hidden lines").getByTestId("hunk-heading"),
	).toHaveCount(0);
	// The whole 13-line gap loaded: its row goes, the heading moves to @@.
	await gapRow(section, "13 hidden lines")
		.getByRole("button", { name: "Load all 13 lines" })
		.click();
	await expect(line(section, 82)).toBeVisible();
	await expect(headings).toHaveCount(3);
	await expect(headers.nth(2).getByTestId("hunk-heading")).toHaveText(FAREWELL);
	await expect(headers.getByTestId("hunk-heading")).toHaveCount(1);
	// Muted code, on screen.
	const heading = gapRow(section, "49 hidden lines").getByTestId(
		"hunk-heading",
	);
	await expect(heading).toHaveCSS("font-family", /mono/i);
	const box = await heading.boundingBox();
	const width = page.viewportSize()?.width ?? 0;
	expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
	await expectNoPageOverflow(page);
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await headers.nth(0).scrollIntoViewIfNeeded();
		await page.screenshot({
			path: `${shots}/hunk-heading-${isMobile ? "phone" : "desktop"}.png`,
		});
	}
	if (isMobile) {
		// 360px: the heading is cut with an ellipsis, never wider.
		await page.setViewportSize({ width: 360, height: 780 });
		await expectNoPageOverflow(page);
		const cut = await heading.evaluate((el) => ({
			cut: el.scrollWidth > el.clientWidth,
			right: el.getBoundingClientRect().right,
		}));
		expect(cut).toEqual({ cut: true, right: expect.any(Number) });
		expect(cut.right).toBeLessThanOrEqual(360);
		if (shots) {
			await page.screenshot({ path: `${shots}/hunk-heading-360.png` });
		}
	}
});

test("a click anywhere on a hidden-lines row loads its lines", async ({
	page,
	pr,
	startCrb,
}) => {
	await setup(pr);
	const s = await startCrb();
	const section = await open(page, s.url);
	// One arrow (↓): the tail.
	await expect(line(section, 96)).toHaveCount(0);
	const tail = gapRow(section, "7 hidden lines");
	await expect(tail).toHaveCSS("cursor", "pointer");
	await tail.getByText("7 hidden lines").click();
	await expect(line(section, 96)).toBeVisible();
	// ↕: the whole 13-line gap, from its blank far end.
	const both = gapRow(section, "13 hidden lines");
	const box = await both.boundingBox();
	if (!box) throw new Error("no row");
	await both.click({ position: { x: box.width - 30, y: box.height / 2 } });
	await expect(line(section, 70)).toBeVisible();
	await expect(line(section, 82)).toBeVisible();
	await expect(gapRow(section, "13 hidden lines")).toHaveCount(0);
});

test("two arrows stack: the row's top half loads ↓, its bottom half ↑, hover lights the arrow", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await setup(pr);
	const s = await startCrb();
	const section = await open(page, s.url);
	const gap = gapRow(section, "49 hidden lines");
	const down = gap.getByRole("button", { name: "Load 20 lines below" });
	const up = gap.getByRole("button", { name: "Load 20 lines above" });
	const [d, u] = [await down.boundingBox(), await up.boundingBox()];
	// ↓ on top of ↑, on the left.
	expect((u?.y ?? 0) >= (d?.y ?? 0) + (d?.height ?? 0) - 1).toBe(true);
	expect(Math.abs((u?.x ?? 0) - (d?.x ?? 0))).toBeLessThan(2);
	const box = await gap.boundingBox();
	if (!box) throw new Error("no row");
	if (isMobile) {
		// Each half and each arrow is a 40px tap target.
		expect(box.height).toBeGreaterThanOrEqual(80);
		expect(await tapHeight(down)).toBeGreaterThanOrEqual(40);
		expect(await tapHeight(up)).toBeGreaterThanOrEqual(40);
	} else {
		const bg = (el: Locator) =>
			el.evaluate((n) => getComputedStyle(n).backgroundColor);
		const idle = await bg(down);
		await page.mouse.move(box.x + box.width - 40, box.y + 4);
		await expect(gap).toHaveAttribute("data-hot", "down");
		await expect.poll(() => bg(down)).not.toBe(idle);
		expect(await bg(up)).toBe(idle);
		await page.mouse.move(box.x + box.width - 40, box.y + box.height - 4);
		await expect(gap).toHaveAttribute("data-hot", "up");
		await expect.poll(() => bg(up)).not.toBe(idle);
		expect(await bg(down)).toBe(idle);
	}
	// Top half: lines 14–33 under the hunk above.
	await gap.click({ position: { x: box.width - 40, y: 4 } });
	await expect(line(section, 14)).toBeVisible();
	await expect(line(section, 33)).toBeVisible();
	await expect(line(section, 34)).toHaveCount(0);
	// The rest (34–62) keeps both arrows: its bottom half loads 43–62 over
	// the hunk below.
	const rest = gapRow(section, "29 hidden lines");
	const box2 = await rest.boundingBox();
	if (!box2) throw new Error("no row");
	await rest.click({ position: { x: box2.width - 40, y: box2.height - 4 } });
	await expect(line(section, 43)).toBeVisible();
	await expect(line(section, 62)).toBeVisible();
	await expect(line(section, 42)).toHaveCount(0);
	await expect(gapRow(section, "9 hidden lines")).toHaveCount(1);
});

test("a thread bubble on a hidden-lines row opens its thread only; the lines stay hidden", async ({
	page,
	pr,
	startCrb,
}) => {
	await setup(pr, true);
	const s = await startCrb();
	const section = await open(page, s.url);
	const gap = gapRow(section, "49 hidden lines");
	const bubble = gap.getByRole("button", { name: /^1 comment on hidden line/ });
	await bubble.click();
	await expect(section.getByText("Hidden one")).toBeVisible();
	await expect(bubble).toHaveAttribute("aria-expanded", "true");
	// The row stays as it was: no line loaded, the same 49 hidden.
	await expect(line(section, 60)).toHaveCount(0);
	await expect(gapRow(section, "49 hidden lines")).toHaveCount(1);
	// Closing it leaves the row as it was.
	await bubble.click();
	await expect(section.getByText("Hidden one")).toHaveCount(0);
	await expect(bubble).toHaveAttribute("aria-expanded", "false");
	await expect(line(section, 60)).toHaveCount(0);
	// By keyboard, the same.
	await bubble.focus();
	await page.keyboard.press("Enter");
	await expect(section.getByText("Hidden one")).toBeVisible();
	await expect(line(section, 60)).toHaveCount(0);
	await expect(gapRow(section, "49 hidden lines")).toHaveCount(1);
	// The row's own control still shows the lines, the thread open on 60.
	await gap.getByRole("button", { name: "Load 20 lines above" }).click();
	await expect(line(section, 60)).toBeVisible();
	await expect(
		line(section, 60).getByRole("button", { name: "1 comment on line 60" }),
	).toHaveAttribute("aria-expanded", "true");
	await expect(section.getByText("Hidden one")).toHaveCount(1);
});

test("on a phone a cut heading scrolls sideways in place, and only a tap loads", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "touch only: the desktop has the tooltip");
	await setup(pr);
	const s = await startCrb();
	await page.setViewportSize({ width: 360, height: 780 });
	const section = await open(page, s.url);
	const lines = section.getByTestId("diff-line");
	const cdp = await page.context().newCDPSession(page);
	// The 13-line gap loaded: the third hunk's heading is on its @@ row.
	await gapRow(section, "13 hidden lines")
		.getByRole("button", { name: "Load all 13 lines" })
		.click();
	await expect(line(section, 82)).toBeVisible();
	const headings = [
		section.getByTestId("hunk-header").nth(2).getByTestId("hunk-heading"),
		gapRow(section, "49 hidden lines").getByTestId("hunk-heading"),
	];
	for (const heading of headings) {
		// Mid-screen: clear of the floating Files button at the bottom.
		await heading.evaluate((el) => el.scrollIntoView({ block: "center" }));
		const before = await lines.count();
		const size = await heading.evaluate((el) => ({
			scroll: el.scrollWidth,
			client: el.clientWidth,
			left: el.scrollLeft,
		}));
		expect(size.scroll).toBeGreaterThan(size.client);
		expect(size.left).toBe(0);
		const box = await heading.boundingBox();
		if (!box) throw new Error("no heading");
		// A finger dragging the heading to the left.
		const x = Math.round(box.x + box.width - 10);
		const y = Math.round(box.y + box.height / 2);
		const touch = (type: "touchStart" | "touchMove" | "touchEnd", at: number) =>
			cdp.send("Input.dispatchTouchEvent", {
				type,
				touchPoints: type === "touchEnd" ? [] : [{ x: at, y }],
			});
		// The drag ends in a fling: the heading coasts on after the finger
		// lifts, and a tap during it only stops it (Chrome, as on a phone):
		// no click. Wait for the scroll to end, by its event.
		await heading.evaluate((el) => {
			(el as Settling).settled = new Promise((done) =>
				el.addEventListener("scrollend", () => done(), { once: true }),
			);
		});
		await touch("touchStart", x);
		for (let dx = 10; dx <= 150; dx += 10) await touch("touchMove", x - dx);
		await touch("touchEnd", x - 150);
		await heading.evaluate((el) => (el as Settling).settled);
		expect(await heading.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
		expect(await lines.count()).toBe(before);
		// A load would come later: the hidden rows still count their lines,
		// none loading.
		await expect(gapRow(section, "49 hidden lines")).toHaveCount(1);
		await expect(
			section.getByRole("status", { name: "Loading lines" }),
		).toHaveCount(0);
		expect(await lines.count()).toBe(before);
		await expectNoPageOverflow(page);
	}
	// A tap on a heading is a tap on its row: on the 49-line gap's heading
	// (mid-row), just above the middle is the top half, ↓: lines 14–33.
	const gapHeading = gapRow(section, "49 hidden lines").getByTestId(
		"hunk-heading",
	);
	await gapHeading.evaluate((el) => el.scrollIntoView({ block: "center" }));
	const row = await gapRow(section, "49 hidden lines").boundingBox();
	const at = await gapHeading.boundingBox();
	if (!row || !at) throw new Error("no gap row");
	expect(at.y + 2).toBeLessThan(row.y + row.height / 2);
	await gapHeading.tap({ position: { x: 20, y: 2 } });
	await expect(line(section, 14)).toBeVisible();
	await expect(line(section, 33)).toBeVisible();
	await expect(line(section, 34)).toHaveCount(0);
	await expectNoPageOverflow(page);
});
