import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import {
	expectNoPageOverflow,
	fileSection,
	ignoreWhitespace,
	openFiles,
	sideBySide,
} from "./files-ui";
import { expect, type PrOptions, test } from "./fixtures";

/**
 * A handful of the gallery's inline-diff cases (Gilthans/carbonless-gallery
 * #14, the unit fixture test/fixtures/inline-diff): each file changes one
 * block.
 */
const CASES = [
	"01-rename-identifier.ts",
	"04-reindent-and-change.ts",
	"05-whitespace-indent-only.ts",
	"44-block-1x3-match-third.ts",
	"60-len-1023.ts",
	"60-len-1024.ts",
];
const read = (side: "base" | "case", name: string) =>
	readFileSync(
		new URL(
			`../test/fixtures/inline-diff/${side}/inline/${name}`,
			import.meta.url,
		),
		"utf8",
	);
const fixture: PrOptions = {
	base: Object.fromEntries(
		CASES.map((name) => [`inline/${name}`, read("base", name)]),
	),
	files: [
		{
			message: "Inline diff cases",
			files: Object.fromEntries(
				CASES.map((name) => [`inline/${name}`, read("case", name)]),
			),
		},
	],
};

/** Each marked run's text on a side's code cells (del: LEFT, add: RIGHT), in order. */
const marked = (section: Locator, side: "LEFT" | "RIGHT") =>
	section
		.locator(`td[data-testid="code"][data-side="${side}"] [data-word]`)
		.allTextContents();

/** What each case's removed and added lines show marked. */
const EXPECTED: Record<string, { del: string[]; add: string[] }> = {
	"01-rename-identifier.ts": { del: ["userCount"], add: ["memberCount"] },
	// The 4 added indent spaces and the `>` → `>=`.
	"04-reindent-and-change.ts": { del: [], add: ["    ", "="] },
	"05-whitespace-indent-only.ts": { del: [], add: ["    "] },
	// 1 removed, 3 added: no pairs.
	"44-block-1x3-match-third.ts": { del: [], add: [] },
	"60-len-1023.ts": { del: ["s"], add: ["t"] },
	// 1,024 characters: plain.
	"60-len-1024.ts": { del: [], add: [] },
};

async function expand(page: Page, name: string) {
	const section = fileSection(page, `inline/${name}`);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.locator("table")).toBeVisible();
	return section;
}

async function expectMarks(
	section: Locator,
	expected: { del: string[]; add: string[] },
) {
	await expect.poll(() => marked(section, "LEFT")).toEqual(expected.del);
	await expect.poll(() => marked(section, "RIGHT")).toEqual(expected.add);
}

/** DESIGN_SHOTS=<dir>: also save inline-diff-{desktop,phone}-{unified,side-by-side}.png there. */
const shots = process.env.DESIGN_SHOTS;
const shot = (section: Locator, name: string, isMobile: boolean) =>
	shots
		? section.screenshot({
				path: `${shots}/inline-diff-${isMobile ? "phone" : "desktop"}-${name}.png`,
			})
		: Promise.resolve();

for (const view of ["unified", "side-by-side"] as const) {
	test(`marks the changed tokens of paired lines, GitHub's way (${view})`, async ({
		page,
		pr,
		startCrb,
		isMobile,
	}) => {
		if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
		await pr(fixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		await sideBySide(page, view === "side-by-side");
		// One file open at a time: each is opened and checked in turn.
		for (const name of CASES) {
			const section = await expand(page, name);
			await expect(section.locator(`table[data-view="${view}"]`)).toBeVisible();
			await expectMarks(section, EXPECTED[name] as (typeof EXPECTED)[string]);
			if (name.startsWith("01-")) {
				// A tint on the line's own text: its code is all there.
				await expect(
					section.locator(
						'td[data-testid="code"][data-side="RIGHT"] [data-code]',
						{ hasText: "memberCount" },
					),
				).toHaveText("const memberCount = getUsers(db).length + offset;");
				await shot(section, `${view}-rename`, isMobile);
			}
			if (name.startsWith("04-")) await shot(section, view, isMobile);
			await expectNoPageOverflow(page);
		}

		// Ignore whitespace: the whitespace-only pair is a quiet ~ row with
		// no marks; every other pair keeps its marks, whitespace included.
		await ignoreWhitespace(page, true);
		for (const name of CASES) {
			const section = await expand(page, name);
			if (name.startsWith("05-")) {
				await section.getByRole("button", { name: /Whitespace only/ }).click();
				await expect(
					section.locator('[data-testid="diff-line"]').first(),
				).toBeVisible();
				await expectMarks(section, { del: [], add: [] });
			} else {
				await expectMarks(section, EXPECTED[name] as (typeof EXPECTED)[string]);
			}
		}
		await expectNoPageOverflow(page);
	});
}
