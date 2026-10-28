import {
	fileSection,
	openFiles,
	rowTop,
	setSwitch,
	underStack,
} from "./files-ui";
import { expect, type PrOptions, test } from "./fixtures";

const long = Array.from({ length: 1200 }, (_, i) => `long ${i + 1}`);
const text = (lines: string[]) => `${lines.join("\n")}\n`;

/** A 1,200-line file with one changed line, 1,150. */
const fixture: PrOptions = {
	base: { "src/long.ts": text(long) },
	files: [
		{
			message: "Change line 1150",
			files: {
				"src/long.ts": text(
					long.map((l, i) => (i === 1149 ? `${l} changed` : l)),
				),
			},
		},
	],
};

test("the Side by side switch keeps the row being read where it was", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, "src/long.ts");
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.locator("table")).toBeVisible();
	// Room below the file to scroll a row up to the sticky stack.
	await page.addStyleTag({ content: "main { padding-bottom: 200vh; }" });
	// Reading the new line 1,150: the added row, which side by side lays
	// out as one row with the removed line (found again by its new number).
	const row = section.locator('[data-testid="diff-line"][data-new-no="1150"]');
	await expect(row).toContainText("long 1150 changed");
	await underStack(row);
	const header = await section.locator("header").boundingBox();
	const stack = (header?.y ?? 0) + (header?.height ?? 0);
	const before = await rowTop(row);
	expect(Math.abs(before - stack)).toBeLessThanOrEqual(2);
	await setSwitch(page, "Side by side", true);
	expect(Math.abs((await rowTop(row)) - before)).toBeLessThan(2);
	expect(
		await page.evaluate(
			() =>
				document.documentElement.scrollWidth -
				document.documentElement.clientWidth,
		),
	).toBeLessThanOrEqual(0);
});
