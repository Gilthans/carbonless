import type { Locator, Page } from "@playwright/test";
import { fileSection, openFiles } from "./files-ui";
import { expect, type PrOptions, test } from "./fixtures";

/**
 * A diff that scrolls sideways has its horizontal scrollbar within reach
 * whenever any of it is on screen: stuck to the viewport's bottom while
 * the diff's end is below the fold, at the diff's end once that shows.
 */

const text = (lines: string[]) => `${lines.join("\n")}\n`;
const WIDE = "src/wide.ts";
const SHORT = "src/short.ts";
// Taller than any viewport once changed, one line far wider than it.
const lines = Array.from({ length: 80 }, (_, i) =>
	i === 10 ? `const wide11 = "${"wide ".repeat(80)}";` : `wide ${i + 1}`,
);
const short = Array.from({ length: 8 }, (_, i) => `short ${i + 1}`);
const fixture: PrOptions = {
	base: { [WIDE]: text(lines), [SHORT]: text(short) },
	files: [
		{
			message: "PR change",
			files: {
				[WIDE]: text(lines.map((l) => `${l} changed`)),
				[SHORT]: text(short.map((l, i) => (i === 3 ? "short 4 changed" : l))),
			},
		},
	],
};

/** The open file's diff scroller (not its path scroller). */
const diffScroller = (section: Locator) =>
	section.locator("div.overflow-x-auto:has(table)");

/** Waits until the page has stopped scrolling (opening a file scrolls its header up). */
async function settled(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((done) => {
				let last = Number.NaN;
				let still = 0;
				const tick = () => {
					still = window.scrollY === last ? still + 1 : 0;
					last = window.scrollY;
					if (still >= 5) done();
					else requestAnimationFrame(tick);
				};
				tick();
			}),
	);
}

const box = async (l: Locator) => {
	const b = await l.boundingBox();
	if (!b) throw new Error("not rendered");
	return { ...b, bottom: b.y + b.height };
};

test("the diff's horizontal scrollbar stays within reach while any of the diff is on screen", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, WIDE);
	await section.getByRole("button", { name: "Expand file" }).click();
	const scroller = diffScroller(section);
	const bar = section.getByTestId("diff-scrollbar");
	await expect(bar).toBeVisible();
	// One bar: the scroller's own is hidden.
	expect(
		await scroller.evaluate((el) => [
			getComputedStyle(el).scrollbarWidth,
			el.getBoundingClientRect().height - el.clientHeight,
		]),
	).toEqual(["none", 0]);

	// The diff's top on screen, its end below the fold (the 12th row, old
	// line 12, in the middle: 11 rows above it, 148 below): the bar sits at
	// the viewport's bottom (above the phone's floating Files button).
	await section
		.locator('tr[data-testid="diff-line"][data-old-no="12"]')
		.evaluate((el) => el.scrollIntoView({ block: "center" }));
	await settled(page);
	const viewport = page.viewportSize();
	if (!viewport) throw new Error("no viewport");
	const room = viewport.width < 768 ? 80 : 0;
	const diff = await box(scroller);
	expect(diff.y).toBeGreaterThanOrEqual(0);
	expect(diff.bottom).toBeGreaterThan(viewport.height);
	const stuck = await box(bar);
	expect(stuck.height).toBeGreaterThanOrEqual(1);
	expect(Math.abs(stuck.bottom - (viewport.height - room))).toBeLessThan(1);
	expect(stuck.y).toBeGreaterThan(diff.y);

	// It drives the table, and follows it.
	await bar.evaluate((el) => {
		el.scrollLeft = 120;
	});
	await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(120);
	await scroller.evaluate((el) => {
		el.scrollLeft = 40;
	});
	await expect.poll(() => bar.evaluate((el) => el.scrollLeft)).toBe(40);

	// The diff's end in view: the bar sits right under the table.
	await section.getByTestId("diff-line").last().scrollIntoViewIfNeeded();
	await expect
		.poll(async () => {
			const end = await box(scroller);
			const b = await box(bar);
			return Math.abs(b.y - end.bottom) < 1 && b.bottom <= viewport.height;
		})
		.toBe(true);
	expect(await bar.evaluate((el) => el.scrollLeft)).toBe(40);

	// A diff that fits has no bar.
	const other = fileSection(page, SHORT);
	await other.getByRole("button", { name: "Expand file" }).click();
	await expect(other.getByTestId("diff-line").first()).toBeVisible();
	expect(
		await diffScroller(other).evaluate(
			(el) => el.scrollWidth <= el.clientWidth,
		),
	).toBe(true);
	await expect(other.getByTestId("diff-scrollbar")).toHaveCount(0);
});
