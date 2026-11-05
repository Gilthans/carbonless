import type { Locator, Page } from "@playwright/test";
import { fileSection, openFiles } from "./files-ui";
import { expect, type PrOptions, test } from "./fixtures";

/** DESIGN_SHOTS=<dir>: also save inv-{desktop,phone}-{on,off}.png there. */
const shots = process.env.DESIGN_SHOTS;

const base = Array.from({ length: 6 }, (_, i) => `const v${i} = ${i};`);
/** Added lines, by what they show off. */
const FIND: Record<string, string | RegExp> = {
	tabs: "if (a)",
	trailing: "let s",
	crlf: "crlf",
	zwsp: "name",
	nbsp: /const n.= 3/,
	bidi: "access",
};
const ADDED = {
	tabs: "\tif (a) {\t// x\tyz",
	trailing: "let s = 1;   ",
	crlf: "const crlf = true;\r",
	zwsp: "const name\u200B = 2;",
	nbsp: "const n\u00A0= 3;",
	bidi: 'const access = "user\u202E \u2066// admin\u2069 \u2066";',
};

const fixture: PrOptions = {
	base: {
		".editorconfig": "root = true\n[*.ts]\ntab_width = 8\n",
		"src/inv.ts": `${base.join("\n")}\n`,
	},
	files: [
		{
			message: "Invisible characters",
			files: {
				"src/inv.ts": `${[...base.slice(0, 3), ...Object.values(ADDED), ...base.slice(3)].join("\n")}\n`,
			},
		},
	],
};

const codeCell = (section: Locator, text: string | RegExp) =>
	section
		.getByTestId("diff-line")
		.filter({ hasText: text })
		.locator("td")
		.last();

/** Selects a line's code cell and copies it the way a reader would. */
async function copyLine(page: Page, cell: Locator): Promise<string> {
	await cell.evaluate((td) => {
		const range = document.createRange();
		range.selectNodeContents(td);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
	});
	await page.keyboard.press("ControlOrMeta+c");
	return page.evaluate(() => navigator.clipboard.readText());
}

/** The "Show hidden characters" switch, in Settings (opened if closed). */
async function hiddenChars(page: Page): Promise<Locator> {
	const gear = page.getByRole("button", { name: "Settings" });
	if ((await gear.getAttribute("aria-expanded")) !== "true") await gear.click();
	return page.getByRole("switch", { name: "Show hidden characters" });
}

const glyphs = (section: Locator, kind: string) =>
	section
		.locator(`[data-inv="${kind}"]`)
		.evaluateAll((els) =>
			els.map((el) => getComputedStyle(el, "::before").content),
		);

test("code shows invisible characters, and copying gives back the original", async ({
	page,
	context,
	pr,
	startCrb,
	isMobile,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.setViewportSize(
		isMobile ? { width: 360, height: 780 } : { width: 1280, height: 860 },
	);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, "src/inv.ts");
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.getByTestId("diff-line").first()).toBeVisible();
	const toggle = await hiddenChars(page);
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await page.keyboard.press("Escape");
	await expect(toggle).toBeHidden();

	// Markers are generated content (CSS alt text keeps them out of screen readers).
	expect(await glyphs(section, "tab")).toContain('"\\\\t" / ""');
	expect(await glyphs(section, "space")).toContain('"·" / ""');
	// A lone space between printing characters has no dot; a trailing run does.
	expect(
		await glyphs(
			section.getByTestId("diff-line").filter({ hasText: "let s" }),
			"space",
		),
	).toEqual(['"···" / ""']);
	expect(await glyphs(section, "eol")).toEqual(
		expect.arrayContaining(['"\\\\n" / ""', '"\\\\r\\\\n" / ""']),
	);
	const escapes = await glyphs(section, "escape");
	expect(escapes).toEqual(
		expect.arrayContaining(['"\\\\u200B" / ""', '"\\\\u00A0" / ""']),
	);
	expect(await glyphs(section, "bidi")).toEqual(
		expect.arrayContaining(['"\\\\u202E" / ""', '"\\\\u2066" / ""']),
	);
	// Each escape is named, and a hover or tap shows the name.
	const bidiMarker = section.locator('[data-inv="bidi"]').first();
	await expect(bidiMarker).toHaveAccessibleName(/right-to-left override/);
	if (isMobile) await bidiMarker.tap();
	else await bidiMarker.hover();
	await expect(
		page.locator('[role="tooltip"]:not([hidden])', {
			hasText: /right-to-left override/,
		}),
	).toBeVisible();
	await page.keyboard.press("Escape");
	// The .editorconfig's 8 columns: a leading tab is 8 characters wide.
	const tab = section.locator('[data-inv="tab"]').first();
	const ch = await tab.evaluate((el) => {
		const probe = document.createElement("span");
		probe.textContent = "0000000000";
		el.parentElement?.append(probe);
		const width = probe.getBoundingClientRect().width / 10;
		probe.remove();
		return el.getBoundingClientRect().width / width;
	});
	expect(ch).toBeCloseTo(8, 1);

	// The override can't flip the text after it: "user" still reads left to right.
	const order = await codeCell(section, "access")
		.first()
		.evaluate((td) => {
			const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
			const xs: Record<string, number> = {};
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				const i = n.textContent?.indexOf("admin") ?? -1;
				if (i < 0) continue;
				const range = document.createRange();
				range.setStart(n, i);
				range.setEnd(n, i + 1);
				xs.a = range.getBoundingClientRect().x;
				range.setStart(n, i + 4);
				range.setEnd(n, i + 5);
				xs.n = range.getBoundingClientRect().x;
			}
			return xs;
		});
	expect(order.a).toBeLessThan(order.n as number);

	for (const [label, text] of Object.entries(ADDED)) {
		const cell = codeCell(section, FIND[label] as string | RegExp).first();
		expect(await copyLine(page, cell), label).toBe(text);
	}

	const overflow = () =>
		page.evaluate(
			() =>
				document.documentElement.scrollWidth -
				document.documentElement.clientWidth,
		);
	expect(await overflow()).toBeLessThanOrEqual(0);
	const device = isMobile ? "phone" : "desktop";
	if (shots) {
		await page.evaluate(() => window.getSelection()?.removeAllRanges());
		await section.scrollIntoViewIfNeeded();
		await page.screenshot({ path: `${shots}/inv-${device}-on.png` });
	}

	// Hidden characters off: whitespace and endings go, what would print as nothing stays.
	await (await hiddenChars(page)).click();
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await page.keyboard.press("Escape");
	await expect(toggle).toBeHidden();
	expect(await glyphs(section, "space")).toEqual([]);
	expect(await glyphs(section, "tab")).not.toContain('"\\\\t" / ""');
	expect(await glyphs(section, "escape")).toEqual(
		expect.arrayContaining(['"\\\\u200B" / ""', '"\\\\u00A0" / ""']),
	);
	expect(await glyphs(section, "bidi")).toContain('"\\\\u202E" / ""');
	for (const [label, text] of Object.entries(ADDED)) {
		const cell = codeCell(section, FIND[label] as string | RegExp).first();
		expect(await copyLine(page, cell), label).toBe(text);
	}
	expect(await overflow()).toBeLessThanOrEqual(0);
	// Hidden zero-size characters don't make their lines taller.
	const heights = await section
		.getByTestId("diff-line")
		.evaluateAll((rows) =>
			rows
				.filter((r) => !r.querySelector("input"))
				.map((r) => Math.round(r.getBoundingClientRect().height)),
		);
	expect(new Set(heights).size).toBe(1);
	if (shots) {
		await page.evaluate(() => window.getSelection()?.removeAllRanges());
		await page.screenshot({ path: `${shots}/inv-${device}-off.png` });
	}

	// Remembered across a reload.
	await page.reload();
	await expect(await hiddenChars(page)).toHaveAttribute(
		"aria-checked",
		"false",
	);
});

test("h flips Show hidden characters from the keyboard; the switch reads it and shows the key", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "no keyboard shortcuts on a phone");
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, "src/inv.ts");
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.locator('[data-inv="space"]').first()).toBeAttached();
	await page.keyboard.press("h");
	await expect(section.locator('[data-inv="space"]')).toHaveCount(0);
	const toggle = await hiddenChars(page);
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await expect(toggle.locator("kbd")).toHaveText("h");
	await page.keyboard.press("Escape");
	await expect(toggle).toBeHidden();
	await page.keyboard.press("h");
	await expect(section.locator('[data-inv="space"]').first()).toBeAttached();
	expect(await glyphs(section, "eol")).toContain('"\\\\r\\\\n" / ""');
	await expect(await hiddenChars(page)).toHaveAttribute("aria-checked", "true");
});
