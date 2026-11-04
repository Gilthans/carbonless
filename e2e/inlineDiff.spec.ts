import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import {
	expectNoPageOverflow,
	fileSection,
	ignoreWhitespace,
	openFiles,
	setSwitch,
	sideBySide,
} from "./files-ui";
import { expect, type PrOptions, reviewPage, test } from "./fixtures";

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

/** A case's first removed and first added line (git's diff of base and case). */
function changed(name: string): { del: string; add: string } {
	const base = read("base", name).split("\n");
	const next = read("case", name).split("\n");
	const at = base.findIndex((l, i) => l !== next[i]);
	return { del: base[at] as string, add: next[at] as string };
}

/**
 * The marked text of a case's lines, once its changed lines show (so an
 * expected "none" can't pass before they render). A whitespace-only row
 * (`ws`) shows only its new text in unified.
 */
async function expectMarks(
	section: Locator,
	name: string,
	expected: { del: string[]; add: string[] },
	ws = false,
) {
	const lines = changed(name);
	const code = section.locator('td[data-testid="code"] [data-code]');
	for (const text of ws ? [lines.add] : [lines.del, lines.add]) {
		await expect(code.filter({ hasText: text }).first()).toBeVisible();
	}
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
			await expectMarks(
				section,
				name,
				EXPECTED[name] as (typeof EXPECTED)[string],
			);
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
				await expectMarks(section, name, { del: [], add: [] }, true);
			} else {
				await expectMarks(
					section,
					name,
					EXPECTED[name] as (typeof EXPECTED)[string],
				);
			}
		}
		await expectNoPageOverflow(page);
	});
}

test("a landing's and a pick's wash show over the word marks, and the landing's fades from them", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "the washes are the same CSS on a phone");
	await pr(fixture);
	const s = await startCrb();
	const path = "inline/01-rename-identifier.ts";
	await page.goto(
		reviewPage(
			s.url,
			"files",
			`?path=${encodeURIComponent(path)}&line=4&side=RIGHT`,
		),
	);
	const section = fileSection(page, path);
	const row = section.locator('tr[data-testid="diff-line"][data-kind="add"]');
	const word = row.locator("[data-word]");
	await expect(word).toHaveText("memberCount");
	/** The wash layered over the mark's tint (index.css, [data-word]). */
	const wash = () =>
		word.evaluate((el) =>
			getComputedStyle(el).getPropertyValue("--wash").trim(),
		);
	const none = await section
		.locator('tr[data-testid="diff-line"][data-kind="del"] [data-word]')
		.evaluate((el) => getComputedStyle(el).getPropertyValue("--wash").trim());
	expect(none).toBe("rgba(0, 0, 0, 0)");
	// Landed: the accent wash reaches the mark...
	await expect(row).toHaveAttribute("data-landed");
	expect(await wash()).not.toBe(none);
	expect(
		await word.evaluate((el) => getComputedStyle(el).backgroundImage),
	).toContain("linear-gradient");
	// ...and fades from it with the row, to nothing.
	await expect(row).not.toHaveAttribute("data-landed", { timeout: 5000 });
	await expect.poll(wash).toBe(none);
	// A pick's wash reaches it too.
	await row.locator('td[data-testid="new"] button').click();
	await expect(row).toHaveAttribute("data-picked");
	await expect.poll(wash).not.toBe(none);
});

/**
 * Hidden-character cases: trailing spaces (07), tabs → spaces (08), CRLF
 * only (22), a zero-width and a no-break space (64), and a visible rename
 * (01) to compare with.
 */
const HIDDEN = [
	"01-rename-identifier.ts",
	"07-trailing-space-only.ts",
	"08-tabs-to-spaces.ts",
	"22-crlf-only.ts",
	"64-hidden-unicode.ts",
];
const hiddenFixture: PrOptions = {
	base: Object.fromEntries(
		HIDDEN.map((name) => [`inline/${name}`, read("base", name)]),
	),
	files: [
		{
			message: "Hidden character cases",
			files: Object.fromEntries(
				HIDDEN.map((name) => [`inline/${name}`, read("case", name)]),
			),
		},
	],
};
const WARNING = "Hidden characters changed. Turn on Show hidden characters";
const warnings = (section: Locator) =>
	section.getByRole("button", { name: new RegExp(`^${WARNING}`) });
/** Settings' "Show hidden characters", read without changing it. */
async function hiddenSwitch(page: Page): Promise<boolean> {
	const gear = page.getByRole("button", { name: "Settings" });
	await gear.click();
	const toggle = page.getByRole("switch", { name: "Show hidden characters" });
	const on = (await toggle.getAttribute("aria-checked")) === "true";
	await page.keyboard.press("Escape");
	await expect(toggle).toBeHidden();
	return on;
}
/** The left edge of a cell's code text. */
const codeLeft = (cell: Locator) =>
	cell.locator("[data-code]").evaluate((el) => el.getBoundingClientRect().left);

for (const view of ["unified", "side-by-side"] as const) {
	test(`warns where a change doesn't show with hidden characters off, and turns them on (${view})`, async ({
		page,
		pr,
		startCrb,
		isMobile,
	}) => {
		if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
		await pr(hiddenFixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		await sideBySide(page, view === "side-by-side");
		await setSwitch(page, "Show hidden characters", false);

		// A visible rename: no warning.
		const rename = await expand(page, "01-rename-identifier.ts");
		await expectMarks(rename, "01-rename-identifier.ts", {
			del: ["userCount"],
			add: ["memberCount"],
		});
		await expect(warnings(rename)).toHaveCount(0);

		// The zero-width and no-break spaces show as escapes, tinted: no warning.
		const unicode = await expand(page, "64-hidden-unicode.ts");
		const added = unicode.locator(
			'td[data-testid="code"][data-side="RIGHT"] [data-word]',
		);
		await expect(added).toHaveText(["user\u200BName", "\u00A0"]);
		await expect(added.locator('[data-inv="escape"]')).toHaveCount(2);
		await expect(warnings(unicode)).toHaveCount(0);

		// Tabs → spaces of the same width: both lines warn.
		const tabs = await expand(page, "08-tabs-to-spaces.ts");
		await expect(warnings(tabs)).toHaveCount(2);

		// Trailing spaces: the added line warns, in the sign's place.
		const trailing = await expand(page, "07-trailing-space-only.ts");
		const warning = warnings(trailing);
		await expect(warning).toHaveCount(1);
		await expect(warning).toHaveAccessibleName(
			isMobile ? WARNING : `${WARNING} (h)`,
		);
		const cell = trailing
			.locator('td[data-testid="code"][data-side="RIGHT"]')
			.filter({ hasText: "const ready" });
		await expect(cell.getByRole("button", { name: /^Hidden/ })).toHaveCount(1);
		// The code starts where a line without a warning starts.
		const plain = trailing
			.locator('td[data-testid="code"][data-side="RIGHT"]')
			.filter({ hasText: "after context line 1" });
		expect(await codeLeft(cell)).toBeCloseTo(await codeLeft(plain), 0);
		expect(
			await warning.evaluate((el) => getComputedStyle(el).userSelect),
		).toBe("none");
		if (isMobile) {
			// A finger gets 40px around it.
			const hit = await warning.evaluate((el) => {
				const b = getComputedStyle(el, "::before");
				return [Number.parseFloat(b.width), Number.parseFloat(b.height)];
			});
			for (const side of hit) expect(side).toBeGreaterThanOrEqual(40);
		} else await warning.hover();
		if (!isMobile) {
			await expect(
				page.locator('[role="tooltip"]:not([hidden])', { hasText: WARNING }),
			).toBeVisible();
		}
		await shot(trailing, `hidden-${view}-off`, isMobile);
		await expectNoPageOverflow(page);
		if (isMobile) await warning.tap();
		else await warning.click();
		// On: the icons go, the trailing spaces show as tinted dots.
		await expect(
			page.getByRole("button", { name: /^Hidden characters changed/ }),
		).toHaveCount(0);
		await expect(
			cell.locator('[data-word] [data-inv="space"]'),
		).toHaveAttribute("data-glyph", "···");
		await page.mouse.move(0, 0);
		await shot(trailing, `hidden-${view}-on`, isMobile);
		expect(await hiddenSwitch(page)).toBe(true);
	});
}

// Needs the `\r` mark (Brief C, branch inline-anchor): until then case 22's
// pair has no marks, so nothing to warn about.
test.fixme("a CRLF-only change warns with hidden characters off, and shows a tinted \\r\\n once on", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(hiddenFixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await setSwitch(page, "Show hidden characters", false);
	const crlf = await expand(page, "22-crlf-only.ts");
	const warning = warnings(crlf);
	await expect(warning).toHaveCount(1);
	if (isMobile) await warning.tap();
	else await warning.click();
	await expect(warnings(crlf)).toHaveCount(0);
	await expect(crlf.locator('[data-word] [data-inv="eol"]')).toHaveAttribute(
		"data-glyph",
		"\\r\\n",
	);
});
