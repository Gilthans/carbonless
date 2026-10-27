import type { Locator, Page } from "@playwright/test";
import {
	REINDENT_NEW,
	REINDENT_OLD,
	WRAP_ADDED,
	WRAP_NEW,
	WRAP_OLD,
	WRAP_REMOVED,
} from "../test/whitespace-fixture";
import { fileSection, openFiles, progress } from "./files-ui";
import { expect, type PrOptions, test } from "./fixtures";

const indent = Array.from({ length: 8 }, (_, i) => `indent ${i + 1}`);
const mixed = Array.from({ length: 10 }, (_, i) => `mixed ${i + 1}`);
const text = (lines: string[]) => `${lines.join("\n")}\n`;

/**
 * Ten clusters: src/indent.ts re-indented wholesale (1), src/mixed.ts with
 * lines 3–6 re-indented and line 4 really changed (1), src/crlf.txt from
 * CRLF to LF (1), src/reindent.ts a re-indent git splits over context lines
 * (5), src/wrap.ts a loop wrapped in an `if` (2).
 */
const fixture: PrOptions = {
	base: {
		"src/indent.ts": text(indent),
		"src/mixed.ts": text(mixed),
		"src/crlf.txt": "one\r\ntwo\r\nthree\r\n",
		"src/reindent.ts": REINDENT_OLD,
		"src/wrap.ts": WRAP_OLD,
	},
	files: [
		{
			message: "Whitespace",
			files: {
				"src/indent.ts": text(indent.map((l) => `  ${l}`)),
				"src/mixed.ts": text(
					mixed.map((l, i) =>
						i < 2 || i > 5 ? l : i === 3 ? "\tmixed 4 changed" : `\t${l}`,
					),
				),
				"src/crlf.txt": "one\ntwo\nthree\n",
				"src/reindent.ts": REINDENT_NEW,
				"src/wrap.ts": WRAP_NEW,
			},
		},
	],
};

/** Sets the "Ignore whitespace" switch in Settings and closes it again. */
async function ignoreWhitespace(page: Page, on: boolean) {
	const gear = page.getByRole("button", { name: "Settings" });
	if ((await gear.getAttribute("aria-expanded")) !== "true") await gear.click();
	const toggle = page.getByRole("switch", { name: "Ignore whitespace" });
	if ((await toggle.getAttribute("aria-checked")) !== String(on)) {
		await toggle.click();
	}
	await expect(toggle).toHaveAttribute("aria-checked", String(on));
	await page.keyboard.press("Escape");
	await expect(toggle).toBeHidden();
}

const rows = (section: Locator, kind: string) =>
	section.locator(`[data-testid="diff-line"][data-kind="${kind}"]`);

async function expand(page: Page, path: string) {
	const section = fileSection(page, path);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.locator("table")).toBeVisible();
	return section;
}

/** DESIGN_SHOTS=<dir>: also save whitespace-{desktop,phone}-{collapsed,open,mixed}.png there. */
const shots = process.env.DESIGN_SHOTS;
const shot = (page: Page, name: string, isMobile: boolean) =>
	shots
		? page.screenshot({
				path: `${shots}/whitespace-${isMobile ? "phone" : "desktop"}-${name}.png`,
			})
		: Promise.resolve();

const overflow = (page: Page) =>
	page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);

test("Ignore whitespace pairs whitespace-only lines and collapses whitespace-only clusters", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const bar = progress(page);
	await expect(bar).toContainText("0 / 10 clusters");

	// Off: plain add/del rows, as always.
	let section = await expand(page, "src/indent.ts");
	await expect(rows(section, "del")).toHaveCount(8);
	await expect(rows(section, "add")).toHaveCount(8);
	await expect(rows(section, "ws")).toHaveCount(0);
	await expect(section.getByTestId("ws-cluster")).toHaveCount(0);
	const counts = section.getByTestId("change-count");
	await expect(counts).toContainText("+8");
	await expect(counts).toContainText("−8");

	// On: the re-indented file is one collapsed row with the cluster's
	// controls; the counts don't move.
	await ignoreWhitespace(page, true);
	const collapsed = section.getByTestId("ws-cluster");
	await expect(collapsed).toHaveCount(1);
	await expect(collapsed).toContainText("Whitespace only · 16 lines");
	await expect(section.getByTestId("diff-line")).toHaveCount(0);
	await expect(counts).toContainText("+8");
	await expect(counts).toContainText("−8");
	const show = collapsed.getByRole("button", {
		name: "Show whitespace-only lines",
	});
	await expect(show).toHaveAttribute("aria-expanded", "false");
	if (isMobile) {
		expect((await show.boundingBox())?.height).toBeGreaterThanOrEqual(40);
		expect((await show.boundingBox())?.width).toBeGreaterThanOrEqual(40);
	}
	await shot(page, "collapsed", isMobile);
	await show.click();
	await expect(rows(section, "ws")).toHaveCount(8);
	await shot(page, "open", isMobile);
	await expect(rows(section, "add")).toHaveCount(0);
	await expect(rows(section, "del")).toHaveCount(0);
	const third = rows(section, "ws").nth(2);
	await expect(third).toHaveAttribute("data-old-no", "3");
	await expect(third).toHaveAttribute("data-new-no", "3");
	await expect(third).toContainText("indent 3");
	await expect(
		third.getByRole("img", { name: "Whitespace only" }),
	).toBeAttached();
	await collapsed
		.getByRole("button", { name: "Hide whitespace-only lines" })
		.click();
	await expect(section.getByTestId("diff-line")).toHaveCount(0);
	expect(await overflow(page)).toBeLessThanOrEqual(0);

	// Reviewed from the collapsed row: progress moves by one cluster.
	const box = collapsed.getByRole("checkbox", {
		name: "Mark cluster reviewed",
	});
	await expect(box).not.toBeChecked();
	await box.click();
	await expect(box).toBeChecked();
	await expect(collapsed).toHaveAttribute("data-reviewed", "true");
	await expect(bar).toContainText("1 / 10 clusters reviewed");

	// A mixed cluster keeps its real change as add/del rows among the
	// whitespace-only ones.
	section = await expand(page, "src/mixed.ts");
	await expect(section.getByTestId("ws-cluster")).toHaveCount(0);
	await expect(rows(section, "ws")).toHaveCount(3);
	await expect(rows(section, "del")).toHaveCount(1);
	await expect(rows(section, "del")).toContainText("mixed 4");
	await expect(rows(section, "add")).toHaveCount(1);
	await expect(rows(section, "add")).toContainText("mixed 4 changed");
	await expect(
		section.getByRole("checkbox", { name: "Mark cluster reviewed" }),
	).toHaveCount(1);
	await expect(section.getByTestId("change-count")).toContainText("+4");
	await expect(section.getByTestId("change-count")).toContainText("−4");
	expect(await overflow(page)).toBeLessThanOrEqual(0);
	await shot(page, "mixed", isMobile);

	// CRLF to LF is whitespace only.
	section = await expand(page, "src/crlf.txt");
	await expect(section.getByTestId("ws-cluster")).toContainText(
		"Whitespace only · 6 lines",
	);

	// A re-indent git split over context lines (five clusters): nothing
	// but whitespace, as `git diff -w` shows.
	section = await expand(page, "src/reindent.ts");
	await expect(section.getByTestId("ws-cluster")).toHaveCount(5);
	await expect(rows(section, "add")).toHaveCount(0);
	await expect(rows(section, "del")).toHaveCount(0);
	await expect(section.getByTestId("change-count")).toContainText("+15");
	await expect(section.getByTestId("change-count")).toContainText("−15");
	expect(await overflow(page)).toBeLessThanOrEqual(0);

	// A loop wrapped in an `if`: the `if`, its `}` and the `log` line that
	// crossed an unchanged `}` stay changes; the body is whitespace-only.
	section = await expand(page, "src/wrap.ts");
	await expect(rows(section, "add")).toHaveCount(WRAP_ADDED.length);
	for (const [i, text] of WRAP_ADDED.entries()) {
		await expect(rows(section, "add").nth(i)).toContainText(text.trim());
	}
	await expect(rows(section, "del")).toHaveCount(1);
	await expect(rows(section, "del")).toContainText(
		(WRAP_REMOVED[0] as string).trim(),
	);
	await expect(rows(section, "ws")).toHaveCount(6);
	await expect(section.locator('[data-ws="pair"]')).toHaveCount(6);
	await expect(section.getByTestId("ws-cluster")).toHaveCount(0);

	// Off again: the mixed file shows every line as it is.
	await ignoreWhitespace(page, false);
	section = await expand(page, "src/mixed.ts");
	await expect(rows(section, "del")).toHaveCount(4);
	await expect(rows(section, "add")).toHaveCount(4);
	await expect(rows(section, "ws")).toHaveCount(0);
	await expect(bar).toContainText("1 / 10 clusters reviewed");
});

/** A 120-line file re-indented wholesale: one whitespace-only cluster. */
const long = Array.from({ length: 120 }, (_, i) => `long ${i + 1}`);
const longFixture: PrOptions = {
	base: { "src/long.ts": text(long) },
	files: [
		{
			message: "Re-indent",
			files: { "src/long.ts": text(long.map((l) => `    ${l}`)) },
		},
	],
};

test("an expanded whitespace-only cluster's controls float below the file header", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(longFixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await ignoreWhitespace(page, true);
	const section = await expand(page, "src/long.ts");
	const collapsed = section.getByTestId("ws-cluster");
	await collapsed
		.getByRole("button", { name: "Show whitespace-only lines" })
		.click();
	await expect(rows(section, "ws")).toHaveCount(120);
	await rows(section, "ws")
		.filter({ hasText: /long 90$/ })
		.scrollIntoViewIfNeeded();
	await expect(collapsed).not.toBeInViewport();
	const checkbox = section.getByRole("checkbox", {
		name: "Mark cluster reviewed",
	});
	await expect(checkbox).toBeInViewport();
	await expect(section.locator("[data-stuck]")).toHaveCount(1);
	// Directly below the file header, as any long cluster's.
	const header = await section.locator("header").boundingBox();
	const target = await section.getByTestId("cluster-box-target").boundingBox();
	expect(target?.y).toBeGreaterThanOrEqual(
		(header?.y ?? 0) + (header?.height ?? 0) - 1,
	);
	if (isMobile) expect(target?.height).toBeGreaterThanOrEqual(40);
	// Still operable there.
	await checkbox.click();
	await expect(checkbox).toBeChecked();
	await expect(progress(page)).toContainText("1 / 1 cluster reviewed");
	expect(await overflow(page)).toBeLessThanOrEqual(0);
});
