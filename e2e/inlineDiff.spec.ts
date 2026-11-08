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
/** The tooltip a touch tap on the warning opens. */
const TAPPED = `${WARNING} in Settings`;
const warnings = (section: Locator) =>
	section.getByRole("button", { name: new RegExp(`^${WARNING}`) });
/** Settings' "Show hidden characters", read without changing it. */
async function hiddenSwitch(page: Page): Promise<boolean> {
	const gear = page.getByRole("button", { name: "Settings", exact: true });
	await gear.click();
	const toggle = page.getByRole("switch", { name: "Show hidden characters" });
	const on = (await toggle.getAttribute("aria-checked")) === "true";
	await page.keyboard.press("Escape");
	await expect(toggle).toBeHidden();
	return on;
}
/** Settings' "Show hidden characters", checked off and then turned on, in one visit. */
async function turnOnHidden(page: Page) {
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const toggle = page.getByRole("switch", { name: "Show hidden characters" });
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await page.keyboard.press("Escape");
	await expect(toggle).toBeHidden();
}
/** The left edge of a cell's code text. */
const codeLeft = (cell: Locator) =>
	cell.locator("[data-code]").evaluate((el) => el.getBoundingClientRect().left);

/** Opens Files changed with hidden characters off, in `view`. */
async function hiddenOff(
	page: Page,
	url: string,
	view: "unified" | "side-by-side",
) {
	await openFiles(page, url);
	await sideBySide(page, view === "side-by-side");
	await setSwitch(page, "Show hidden characters", false);
}

test("warns on a tab swapped for spaces, not on a visible rename nor on escaped characters", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(hiddenFixture);
	const s = await startCrb();
	await hiddenOff(page, s.url, "unified");

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
});

// Two warned rows one above the other (unified): each 40px target reaches
// into the other's row, yet a tap on either ⚠ is that row's own.
test("a tap on either of two adjacent warnings opens that one's tooltip", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "taps: the phone project");
	await page.setViewportSize({ width: 360, height: 780 });
	await pr(hiddenFixture);
	const s = await startCrb();
	await hiddenOff(page, s.url, "unified");
	const tabs = await expand(page, "08-tabs-to-spaces.ts");
	const both = warnings(tabs);
	await expect(both).toHaveCount(2);
	// Adjacent rows: the second ⚠ sits one line below the first.
	const [a, b] = await both.evaluateAll((els) =>
		els.map((el) => el.getBoundingClientRect().top),
	);
	expect((b ?? 0) - (a ?? 0)).toBeLessThan(40);
	const tip = page.locator('[role="tooltip"]:not([hidden])', {
		hasText: TAPPED,
	});
	for (const i of [0, 1, 0]) {
		await both.nth(i).tap();
		await expect(both.nth(i)).toBeFocused();
		await expect(tip).toHaveCount(1);
		await expect(tip).toBeVisible();
	}
	await expect(both).toHaveCount(2);
});

for (const view of ["unified", "side-by-side"] as const) {
	test(`warns where trailing spaces changed with hidden characters off, and turns them on (${view})`, async ({
		page,
		pr,
		startCrb,
		isMobile,
	}) => {
		// A phone also measures the 40px target and walks a tap's tooltip, and
		// opens Settings four times (Side by side, hidden characters off, on
		// again after the tap, the final check): past the default under load.
		test.slow(isMobile);
		if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
		await pr(hiddenFixture);
		const s = await startCrb();
		await hiddenOff(page, s.url, view);

		// Trailing spaces: the added line warns, in the sign's place.
		const trailing = await expand(page, "07-trailing-space-only.ts");
		const warning = warnings(trailing);
		await expect(warning).toHaveCount(1);
		await expect(warning).toHaveAccessibleName(
			// No hover: the name says where the switch is, as a tap's tooltip does.
			isMobile ? TAPPED : `${WARNING} (h)`,
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
			// A tap beside the icon hits it; a tap on the line's number, even at
			// its edge, still reaches the number cell (picks the line).
			const hits = await warning.evaluate((el) => {
				el.scrollIntoView({ block: "center" });
				const box = el.getBoundingClientRect();
				const y = box.top + box.height / 2;
				const at = (x: number, dy = 0) =>
					el.contains(document.elementFromPoint(x, y + dy));
				const number = el
					.closest("td")
					?.previousElementSibling?.getBoundingClientRect();
				const onNumber = number
					? document
							.elementFromPoint(number.right - 3, y)
							?.closest('td[data-testid="new"]') !== null
					: false;
				return {
					right: at(box.right + 15),
					below: at(box.left + box.width / 2, 15),
					onNumber,
				};
			});
			expect(hits).toEqual({ right: true, below: true, onNumber: true });
		} else await warning.hover();
		if (!isMobile) {
			await expect(
				page.locator('[role="tooltip"]:not([hidden])', { hasText: WARNING }),
			).toBeVisible();
		}
		await shot(trailing, `hidden-${view}-off`, isMobile);
		await expectNoPageOverflow(page);
		if (isMobile) {
			// A tap only explains (owner, 2026-11-04): the tooltip says where the
			// switch is, nothing changes; a tap elsewhere closes it.
			await warning.tap();
			await expect(
				page.locator('[role="tooltip"]:not([hidden])', { hasText: TAPPED }),
			).toBeVisible();
			await expect(warning).toHaveCount(1);
			await expect(cell.locator('[data-inv="space"]')).toHaveCount(0);
			await plain.tap();
			await expect(
				page.locator('[role="tooltip"]:not([hidden])', { hasText: WARNING }),
			).toHaveCount(0);
			await turnOnHidden(page);
		} else await warning.click();
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

// Case 22: the new line's lone `\r` is marked (owner, 2026-11-04), so it warns.
test("a CRLF-only change warns with hidden characters off, and shows a tinted \\r\\n once on", async ({
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
	if (isMobile) {
		// A tap explains where the switch is and changes nothing.
		await warning.tap();
		await expect(
			page.locator('[role="tooltip"]:not([hidden])', { hasText: TAPPED }),
		).toBeVisible();
		await expect(warning).toHaveCount(1);
		// No "\r\n" label: hidden characters are still off.
		await expect(
			crlf.locator('[data-inv="eol"][data-glyph="\\\\r\\\\n"]'),
		).toHaveCount(0);
		await turnOnHidden(page);
	} else await warning.click();
	await expect(warnings(crlf)).toHaveCount(0);
	await expect(
		crlf.locator('[data-inv="eol"][data-glyph="\\\\r\\\\n"]'),
	).toHaveCount(1);
	await expect(crlf.locator('[data-word] [data-inv="eol"]')).toHaveAttribute(
		"data-glyph",
		"\\r\\n",
	);
});

/**
 * Case 65 (gallery #14, inline/65-emoji-hidden.ts): emoji whose change is a
 * kept selector or joiner. Hidden characters off: a ⚠; on: the `\uFE0F` /
 * `\u200D` labels inside the marks (owner, 2026-11-04).
 */
const EMOJI_BASE = [
	'export const smile = "😀";',
	'export const pets = "🐶🐱";',
	"",
	'export const party = ["🎉", "todo"];',
	"",
].join("\n");
const EMOJI_CASE = [
	'export const smile = "😀\uFE0F";',
	'export const pets = "🐶\u200D🐱";',
	"",
	'export const party = ["🎉\uFE0F", "done"];',
	"",
].join("\n");

test("an emoji's changed selector or joiner warns with hidden characters off, and shows as a label inside its mark once on", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr({
		base: { "inline/65-emoji-hidden.ts": EMOJI_BASE },
		files: [
			{
				message: "Emoji hidden changes",
				files: { "inline/65-emoji-hidden.ts": EMOJI_CASE },
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	await setSwitch(page, "Show hidden characters", false);
	const section = await expand(page, "65-emoji-hidden.ts");
	const added = (name: string) =>
		section
			.locator('td[data-testid="code"][data-side="RIGHT"]')
			.filter({ hasText: `const ${name}` });
	for (const name of ["smile", "pets", "party"]) {
		await expect(
			added(name).getByRole("button", { name: /^Hidden characters/ }),
			name,
		).toHaveCount(1);
		// The emoji stay whole: no label anywhere.
		await expect(added(name).locator('[data-inv="escape"]')).toHaveCount(0);
	}
	await expectNoPageOverflow(page);
	// A phone has no shortcuts: Settings' switch there (tapping the ⚠ on
	// adjacent rows is another change's).
	if (isMobile) await setSwitch(page, "Show hidden characters", true);
	else await page.keyboard.press("h");
	await expect(warnings(section)).toHaveCount(0);
	const labels = (name: string) =>
		added(name).locator('[data-word] [data-inv="escape"]');
	await expect(labels("smile")).toHaveAttribute("data-glyph", "\\uFE0F");
	await expect(labels("pets")).toHaveAttribute("data-glyph", "\\u200D");
	await expect(labels("party")).toHaveAttribute("data-glyph", "\\uFE0F");
	await expect(labels("smile")).toBeVisible();
	// Only inside the marks: the removed lines keep their emoji whole.
	await expect(
		section.locator(
			'td[data-testid="code"][data-side="LEFT"] [data-inv="escape"]',
		),
	).toHaveCount(0);
	// The visible change beside it is marked as before.
	await expect(added("party").locator("[data-word]")).toHaveText([
		"\uFE0F",
		"done",
	]);
	// A copy gives back the raw characters.
	expect(
		await added("pets")
			.locator("[data-code]")
			.evaluate((el) => el.textContent),
	).toBe('export const pets = "🐶\u200D🐱";');
	await shot(section, "emoji-hidden-on", isMobile);
	await expectNoPageOverflow(page);
});
