import type { Locator, Page, Route } from "@playwright/test";
import {
	barBottom,
	expectNoPageOverflow,
	fileAction,
	fileSection,
	ignoreWhitespace,
	openFiles,
	pickInTree,
	progress,
	setSwitch,
	withTree,
} from "./files-ui";
import { expect, type PrOptions, test } from "./fixtures";

const text = (lines: string[]) => `${lines.join("\n")}\n`;
const numbered = (name: string, n: number) =>
	Array.from({ length: n }, (_, i) => `${name} ${i + 1}`);

const A = "src/a.ts";
const B = "src/b.ts";
const C = "src/c.ts";
const WS = "src/ws.ts";
const NOTES = "docs/notes.md";
const DOC = "docs/saveDraft.md";
const PNG = "assets/saveDraft.png";

/** src/a.ts: line 8 holds "SaveDraft" (another case), in lines 5–6's context. */
const aBase = numbered("a", 20).map((l, i) => (i === 7 ? "SaveDraft 8" : l));
/** src/c.ts: line 2 "onlyHere" (in no hunk), line 15 "saveDraft()" (line 12's context). */
const cBase = numbered("c", 30).map((l, i) =>
	i === 1 ? "onlyHere 2" : i === 14 ? "saveDraft()" : l,
);
/** src/ws.ts: line 4 holds "saveDraft". */
const wsBase = numbered("ws", 8).map((l, i) => (i === 3 ? "saveDraft 4" : l));

/**
 * In tree order: assets/saveDraft.png (binary, a path hit), docs/notes.md
 * (no hit), docs/saveDraft.md (a path hit), src/a.ts (lines 5–6 changed to
 * saveDraft calls, line 8's "SaveDraft" in their context), src/b.ts (line
 * 10 changed to a saveDraft call), src/c.ts (line 12 changed: line 15's
 * "saveDraft()" is in its context, line 2's "onlyHere" in no hunk),
 * src/ws.ts (re-indented wholesale: line 4's "saveDraft" removed and added).
 */
const fixture: PrOptions = {
	base: {
		[A]: text(aBase),
		[B]: text(numbered("b", 20)),
		[C]: text(cBase),
		[WS]: text(wsBase),
		[NOTES]: text(["# Notes", "nothing to find"]),
	},
	files: [
		{
			message: "Find in PR",
			files: {
				[A]: text(
					aBase.map((l, i) =>
						i === 4 ? "saveDraft(x)" : i === 5 ? "saveDraft(y)" : l,
					),
				),
				[B]: text(
					numbered("b", 20).map((l, i) =>
						i === 9 ? "return saveDraft(z)" : l,
					),
				),
				[C]: text(cBase.map((l, i) => (i === 11 ? "c 12 changed" : l))),
				[WS]: text(wsBase.map((l) => `  ${l}`)),
				[NOTES]: text(["# Notes", "nothing to find", "still nothing"]),
				[DOC]: text(["# Drafts", "how drafts are kept"]),
			},
			binary: { [PNG]: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0]) },
		},
	],
};

/**
 * "saveDraft" (any case) before any hunk is in: the two paths, src/a.ts's
 * two added lines, src/b.ts's, src/ws.ts's line 4 removed and added.
 */
const CHANGED = 7;
/** Once every file's hunks are in: src/a.ts's line 8 and src/c.ts's line 15 join. */
const ALL = 9;
/** The hits' places, in order: the PNG's path, the doc's path, then src/a.ts's first line. */
const DOC_HIT = 2;
const A_FIRST = 3;

const bar = (page: Page) => page.getByRole("search", { name: "Find in PR" });
const box = (page: Page) => page.getByTestId("find-box");
const count = (page: Page) => page.getByTestId("find-count");
const spinner = (page: Page) =>
	page.getByRole("status", { name: "Searching files…" });
/** The find bar's bottom edge on screen. */
const findBottom = (page: Page) =>
	bar(page).evaluate((el) => el.getBoundingClientRect().bottom);
/** The find bar's box on screen. */
const barBox = (page: Page) =>
	bar(page).evaluate((el) => {
		const r = el.getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height };
	});
const appHeader = (page: Page) => page.locator("[data-app-header]");
const findButton = (page: Page) =>
	page.getByRole("button", { name: "Find in PR", exact: true });
/** The count as shown: one of its two forms is hidden by width. */
const VISIBLE = { useInnerText: true } as const;
/** "3 of 9" on desktop, "3/9" on a phone. */
const counted = (at: number | string, of: number | string) =>
	new RegExp(`^(${at} of ${of}|${at}/${of})$`);

/** Opens the bar the way each device does: Cmd/Ctrl+F, or the header's button. */
async function openBar(page: Page, isMobile: boolean) {
	if (isMobile) await findButton(page).click();
	else await page.keyboard.press("ControlOrMeta+f");
	await expect(bar(page)).toBeVisible();
	await expect(box(page)).toBeFocused();
}

/** Types `term` and waits for every file's hunks: the count is final. */
async function search(page: Page, term: string) {
	await box(page).fill(term);
	await expect(count(page)).not.toBeEmpty();
	await expect(spinner(page)).toHaveCount(0);
}

const expandToggle = (section: Locator) =>
	section.getByRole("button", { name: /^(Expand|Collapse) file$/ });
/** The paths of the open files (their toggle says Collapse file). */
const openPaths = (page: Page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('button[aria-label="Collapse file"]')].map(
			(b) => b.closest("section")?.getAttribute("aria-label"),
		),
	);
/** The section holding the current hit (a line's or a path's). */
const currentSection = (page: Page) =>
	// The innermost: Files changed's own section holds them all.
	page.locator("section[aria-label]:has([data-find-current])").last();
const currentRow = (page: Page) => page.locator("tr[data-find-current]");

async function expand(page: Page, path: string) {
	const section = fileSection(page, path);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(expandToggle(section)).toHaveAttribute("aria-expanded", "true");
	return section;
}

/** Steps until the current hit is in `path` (at most `max` steps): Enter, or `step`. */
async function stepUntil(
	page: Page,
	path: string,
	max = 12,
	step = () => box(page).press("Enter"),
) {
	for (let i = 0; i < max; i++) {
		if ((await currentSection(page).getAttribute("aria-label")) === path)
			return;
		await step();
	}
	await expect(currentSection(page)).toHaveAttribute("aria-label", path);
}

const BATCH = "**/api/r/*/files/hunks?**";

/**
 * Holds the prefetch's batched hunk requests until `release()`, which lets
 * them and any later ones through.
 */
function holdBatches(page: Page) {
	const routes: Route[] = [];
	let holding = true;
	const ready = page.route(BATCH, async (route) => {
		if (holding) routes.push(route);
		else await route.continue();
	});
	return {
		ready,
		count: () => routes.length,
		async release() {
			await ready;
			holding = false;
			for (const route of routes.splice(0)) await route.continue();
			await page.unroute(BATCH);
		},
	};
}

const phone = async (page: Page, isMobile: boolean) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
};

test("Cmd+F opens the bar focused; typing counts and marks without scrolling or opening a file", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "Cmd+F needs a keyboard: the header's button is tested");
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await pickInTree(page, /\sa\.ts\s/);
	const a = fileSection(page, A);
	await expect(a.getByTestId("diff-line").first()).toBeVisible();
	await page.evaluate(() => window.scrollTo(0, 120));
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(120);
	const line = a.getByTestId("diff-line").first();
	const at = async () => (await line.boundingBox())?.y ?? Number.NaN;
	const was = await at();

	await openBar(page, isMobile);
	// Opening pushes the page down by the bar, and scrolls by as much: the
	// line read stays where it was; typing moves nothing.
	await expect.poll(async () => Math.abs((await at()) - was)).toBeLessThan(1);
	const y = await page.evaluate(() => window.scrollY);
	await page.keyboard.type("saveDraft");
	await expect(count(page)).toHaveText(/^\d+ of \d+$/, VISIBLE);
	await expect(count(page)).toHaveText(counted(A_FIRST, "\\d+"), VISIBLE);
	await expect(spinner(page)).toHaveCount(0);
	await expect(count(page)).toHaveText(counted(A_FIRST, ALL), VISIBLE);
	expect(await page.evaluate(() => window.scrollY)).toBe(y);
	await expect.poll(() => openPaths(page)).toEqual([A]);
	// The caret: src/a.ts's first hit, painted but not scrolled to.
	await expect(currentSection(page)).toHaveAttribute("aria-label", A);
	await expect(currentRow(page)).toHaveAttribute("data-new-no", "5");
	await expect(a.locator(".find-current")).toHaveText("saveDraft");
	await expect(page.locator(".find-mark").first()).toBeVisible();
});

test("Next (Enter, or ↓ on a phone) moves on from a caret already in view, then steps into another file, which opens with the row below the sticky stack; Previous goes back; the end wraps", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await phone(page, isMobile);
	// Enter / Shift+Enter in the box on desktop; the bar's ↓/↑ on a phone.
	const next = () =>
		isMobile
			? bar(page).getByRole("button", { name: /^Next/ }).click()
			: box(page).press("Enter");
	const previous = () =>
		isMobile
			? bar(page)
					.getByRole("button", { name: /^Previous/ })
					.click()
			: box(page).press("Shift+Enter");
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await pickInTree(page, /\sa\.ts\s/);
	await expect(
		fileSection(page, A).getByTestId("diff-line").first(),
	).toBeVisible();
	await openBar(page, isMobile);
	await search(page, "saveDraft");
	await expect(count(page)).toHaveText(counted(A_FIRST, ALL), VISIBLE);

	/** The current row sits below the sticky stack (with the file's stuck header) and the find bar. */
	const belowStack = async () => {
		const top = await barBottom(page);
		const find = await findBottom(page);
		const { row, header } = await currentRow(page).evaluate((el) => ({
			row: el.getBoundingClientRect().top,
			header: el.closest("section")?.querySelector("header")?.offsetHeight ?? 0,
		}));
		return Math.min(row - (top + header), row - find);
	};

	// The caret, line 5, is already in view: the first step moves on.
	await expect(currentRow(page)).toHaveAttribute("data-new-no", "5");
	await expect(currentRow(page)).toBeInViewport();
	await next();
	await expect(count(page)).toHaveText(counted(A_FIRST + 1, ALL), VISIBLE);
	await expect(currentRow(page)).toHaveAttribute("data-new-no", "6");
	await expect.poll(belowStack).toBeGreaterThanOrEqual(0);
	await expect(currentRow(page)).toBeInViewport();

	await stepUntil(page, B, 12, next);
	await expect(count(page)).toHaveText(counted(A_FIRST + 3, ALL), VISIBLE);
	await expect(expandToggle(fileSection(page, B))).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	await expect(expandToggle(fileSection(page, A))).toHaveAttribute(
		"aria-expanded",
		"false",
	);
	await expect(currentRow(page)).toHaveAttribute("data-new-no", "10");
	await expect.poll(belowStack).toBeGreaterThanOrEqual(0);
	await expect(currentRow(page)).toBeInViewport();

	// Back into src/a.ts: its last hit, line 8's "SaveDraft".
	await previous();
	await expect(currentSection(page)).toHaveAttribute("aria-label", A);
	await expect(count(page)).toHaveText(counted(A_FIRST + 2, ALL), VISIBLE);
	await expect(currentRow(page)).toHaveAttribute("data-new-no", "8");
	await expect(expandToggle(fileSection(page, A))).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	await expect(currentRow(page)).toBeInViewport();

	// On to the end, then round to the first.
	for (let at = A_FIRST + 3; at <= ALL; at++) {
		await next();
		await expect(count(page)).toHaveText(counted(at, ALL), VISIBLE);
	}
	await next();
	await expect(count(page)).toHaveText(counted(1, ALL), VISIBLE);
	await expect(currentSection(page)).toHaveAttribute("aria-label", PNG);
});

test("a term with no hit in the open file says the next file's hit and opens nothing until Enter", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await expand(page, NOTES);
	await openBar(page, isMobile);
	await search(page, "saveDraft");
	// docs/saveDraft.md's path: the first hit after docs/notes.md.
	await expect(count(page)).toHaveText(counted(DOC_HIT, ALL), VISIBLE);
	await expect.poll(() => openPaths(page)).toEqual([NOTES]);

	if (isMobile) await bar(page).getByRole("button", { name: /^Next/ }).click();
	else await box(page).press("Enter");
	await expect.poll(() => openPaths(page)).toEqual([DOC]);
	await expect(count(page)).toHaveText(counted(DOC_HIT, ALL), VISIBLE);
});

test("the header button opens and closes the bar", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	// Elsewhere it goes to Files changed with the bar open.
	await page.goto(s.url);
	await expect(findButton(page)).toBeVisible();
	await expect(findButton(page)).not.toHaveAttribute("aria-expanded");
	await findButton(page).click();
	await expect(page).toHaveURL(/\/files/);
	await expect(bar(page)).toBeVisible();
	await expect(box(page)).toBeFocused();
	// A phone's header (and its button) is hidden while the bar is open.
	if (isMobile) await expect(findButton(page)).toBeHidden();
	else await expect(findButton(page)).toHaveAttribute("aria-expanded", "true");

	// A phone's header is hidden while the bar is open: its ✕ closes it.
	if (isMobile)
		await bar(page).getByRole("button", { name: "Close (Esc)" }).click();
	else await findButton(page).click();
	await expect(bar(page)).toHaveCount(0);
	await expect(findButton(page)).toHaveAttribute("aria-expanded", "false");
	await expect(findButton(page)).toBeFocused();
	await findButton(page).click();
	await expect(bar(page)).toBeVisible();
	await expect(box(page)).toBeFocused();
	if (!isMobile)
		await expect(findButton(page)).toHaveAttribute("aria-expanded", "true");
	if (isMobile)
		await bar(page).getByRole("button", { name: "Close (Esc)" }).click();
	const size = await findButton(page).boundingBox();
	expect(size?.width).toBeGreaterThanOrEqual(40);
	expect(size?.height).toBeGreaterThanOrEqual(40);
});

test("a path hit opens the file at its header with the path marked, and the tree shows counts", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await openBar(page, isMobile);
	await search(page, "saveDraft");
	await expect(count(page)).toHaveText(counted(1, ALL), VISIBLE);
	const next = bar(page).getByRole("button", { name: /^Next/ });
	await next.click();
	await expect(count(page)).toHaveText(counted(1, ALL), VISIBLE);
	await next.click();
	await expect(count(page)).toHaveText(counted(DOC_HIT, ALL), VISIBLE);

	const doc = fileSection(page, DOC);
	await expect(expandToggle(doc)).toHaveAttribute("aria-expanded", "true");
	await expect(
		doc.getByTestId("file-path").locator(".find-current"),
	).toHaveText("saveDraft");
	await expect(
		doc.getByTestId("file-path").locator("[data-find-current]"),
	).toHaveCount(1);
	// Its header right under the sticky bar.
	await expect
		.poll(async () => {
			const top = await barBottom(page);
			const header = await doc.locator("header").first().boundingBox();
			return Math.abs((header?.y ?? Number.NaN) - top);
		})
		.toBeLessThan(2);

	await withTree(page, async (tree) => {
		const row = (name: string) =>
			tree.getByRole("button").filter({
				has: page.getByTestId("tree-name").filter({
					hasText: new RegExp(`^${name.replace(".", "\\.")}$`),
				}),
			});
		const chip = (r: Locator) => r.getByRole("img", { name: /\d+ match(es)?/ });
		await expect(chip(row("a.ts"))).toHaveAccessibleName("3 matches");
		await expect(chip(row("b.ts"))).toHaveAccessibleName("1 match");
		await expect(chip(row("c.ts"))).toHaveAccessibleName("1 match");
		await expect(chip(row("ws.ts"))).toHaveAccessibleName("2 matches");
		await expect(chip(row("saveDraft.md"))).toHaveAccessibleName("1 match");
		await expect(chip(row("saveDraft.png"))).toHaveAccessibleName("1 match");
		await expect(chip(row("notes.md"))).toHaveCount(0);
		await expect(chip(tree.locator('button[data-folder="src"]'))).toHaveText(
			"7",
		);
		await expect(chip(tree.locator('button[data-folder="docs"]'))).toHaveText(
			"1",
		);
		// The names are marked too.
		await expect(
			row("saveDraft.md").getByTestId("tree-name").locator(".find-current"),
		).toHaveText("saveDraft");
		// A row's tooltip says what its count is.
		if (!isMobile) {
			await row("a.ts").hover();
			await expect(
				page.locator('[role="tooltip"]:not([hidden])'),
			).toContainText("3 matches for “saveDraft”");
			await tree.locator('button[data-folder="src"]').hover();
			await expect(
				page.locator('[role="tooltip"]:not([hidden])'),
			).toContainText("7 matches for “saveDraft” in this folder");
		}
	});
});

test("context hits join once the prefetch lands, with the spinner meanwhile", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	const held = holdBatches(page);
	await held.ready;
	try {
		await openFiles(page, s.url);
		await expand(page, NOTES);
		await openBar(page, isMobile);
		await box(page).fill("saveDraft");
		await expect(spinner(page)).toBeVisible();
		await expect.poll(() => held.count()).toBeGreaterThan(0);
		// The paths and changed lines count at once; context lines wait.
		await expect(count(page)).toHaveText(counted(DOC_HIT, CHANGED), VISIBLE);
		await expect(spinner(page)).toBeVisible();
	} finally {
		await held.release();
	}
	await expect(spinner(page)).toHaveCount(0);
	await expect(count(page)).toHaveText(counted(DOC_HIT, ALL), VISIBLE);
	// src/c.ts's line 15 is a hit while the file stays closed.
	await expect.poll(() => openPaths(page)).toEqual([NOTES]);
	await withTree(page, async (tree) => {
		await expect(
			tree
				.getByRole("button")
				.filter({
					has: page.getByTestId("tree-name").filter({ hasText: /^c\.ts$/ }),
				})
				.getByRole("img", { name: /\d+ match(es)?/ }),
		).toHaveAccessibleName("1 match");
	});
});

test("a line the diff doesn't show is found once its context is expanded", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await openBar(page, isMobile);
	await search(page, "onlyHere");
	await expect(count(page)).toHaveText(counted(0, 0), VISIBLE);

	const c = await expand(page, C);
	await c
		.getByRole("button", { name: /^Load \d+ lines? above$/ })
		.first()
		.click();
	await expect(
		c.getByTestId("diff-line").filter({ hasText: "onlyHere 2" }),
	).toHaveCount(1);
	await expect(count(page)).toHaveText(counted(1, 1), VISIBLE);
	await expect(c.locator(".find-current")).toHaveText("onlyHere");

	// Closed, the expansion is kept: still found.
	await c.getByRole("button", { name: "Collapse file" }).click();
	await expect(expandToggle(c)).toHaveAttribute("aria-expanded", "false");
	await expect(count(page)).toHaveText(counted(1, 1), VISIBLE);
});

test("side by side and ignore whitespace keep the count and the current hit (a phone: ignore whitespace)", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await ignoreWhitespace(page, true);
	await openBar(page, isMobile);
	await search(page, "saveDraft");
	const next = bar(page).getByRole("button", { name: /^Next/ });
	// src/ws.ts's line 4, removed then added: the last two hits.
	await expect(count(page)).toHaveText(counted(1, ALL), VISIBLE);
	for (let at = 1; at <= ALL - 1; at++) {
		await next.click();
		await expect(count(page)).toHaveText(counted(at, ALL), VISIBLE);
	}
	const ws = fileSection(page, WS);
	await expect(currentSection(page)).toHaveAttribute("aria-label", WS);
	// The whitespace-only cluster opens to show it: line 4's row, washed
	// (its old side's hit lands on the one row a ws line has).
	await expect(currentRow(page)).toBeVisible();
	await expect(currentRow(page)).toHaveAttribute("data-new-no", "4");
	await next.click();
	await expect(count(page)).toHaveText(counted(ALL, ALL), VISIBLE);
	await expect(currentRow(page)).toHaveAttribute("data-new-no", "4");
	await expect(ws.locator(".find-current")).toBeVisible();
	await expect(ws.locator(".find-current")).toHaveText("saveDraft");
	const before = await count(page).innerText();
	expect(before).toMatch(counted("\\d+", "\\d+"));
	// A phone's Settings are in the header, hidden while the bar is open.
	if (isMobile) return;

	await setSwitch(page, "Side by side", true);
	await expect(ws.locator('table[data-view="side-by-side"]')).toBeVisible();
	await expect(count(page)).toHaveText(before, VISIBLE);
	await expect(ws.locator(".find-current")).toBeVisible();
	await expect(ws.locator(".find-current")).toHaveText("saveDraft");
	await expect(ws.locator("[data-find-current]").first()).toBeVisible();
});

test("Match case changes the count and survives a reload", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await openBar(page, isMobile);
	await search(page, "savedraft");
	await expect(count(page)).toHaveText(counted(1, ALL), VISIBLE);
	const matchCase = bar(page).getByRole("button", { name: "Match case" });
	await expect(matchCase).toHaveAttribute("aria-pressed", "false");
	await matchCase.click();
	await expect(matchCase).toHaveAttribute("aria-pressed", "true");
	await expect(count(page)).toHaveText(counted(0, 0), VISIBLE);
	await expect(page.locator(".find-mark, .find-current")).toHaveCount(0);

	await page.reload();
	await expect(progress(page)).toBeVisible();
	await openBar(page, isMobile);
	await expect(matchCase).toHaveAttribute("aria-pressed", "true");
	await search(page, "saveDraft");
	// "SaveDraft" on src/a.ts's line 8 isn't one.
	await expect(count(page)).toHaveText(counted(1, ALL - 1), VISIBLE);
});

test("Escape closes and clears the marks; reopening starts empty", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await expand(page, A);
	await openBar(page, isMobile);
	await search(page, "saveDraft");
	await expect(page.locator(".find-mark, .find-current").first()).toBeVisible();

	if (isMobile)
		await bar(page).getByRole("button", { name: "Close (Esc)" }).click();
	else await box(page).press("Escape");
	await expect(bar(page)).toHaveCount(0);
	await expect(page.locator(".find-mark, .find-current")).toHaveCount(0);
	await expect(findButton(page)).toBeFocused();

	await openBar(page, isMobile);
	await expect(box(page)).toHaveValue("");
	await expect(count(page)).toBeEmpty();
	await expect(page.locator(".find-mark, .find-current")).toHaveCount(0);
});

test("leaving Files changed clears the search: back there the bar is closed, and reopens empty", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	// From the Overview, so the browser's back goes there.
	await page.goto(s.url);
	await page.getByRole("link", { name: "Files changed" }).click();
	await expect(progress(page)).toBeVisible();
	await openBar(page, isMobile);
	await search(page, "saveDraft");
	// Another tab: a phone's header (its tabs) is hidden while the bar is
	// open, so the browser's back.
	if (isMobile) await page.goBack();
	else await page.getByRole("link", { name: "Overview" }).click();
	await expect(page).not.toHaveURL(/\/files/);
	await expect(bar(page)).toHaveCount(0);
	await page.getByRole("link", { name: "Files changed" }).click();
	await expect(progress(page)).toBeVisible();
	await expect(bar(page)).toHaveCount(0);
	await expect(page.locator(".find-mark, .find-current")).toHaveCount(0);
	await expect(findButton(page)).toHaveAttribute("aria-expanded", "false");
	await openBar(page, isMobile);
	await expect(box(page)).toHaveValue("");

	// A reload starts closed too.
	await search(page, "saveDraft");
	await page.reload();
	await expect(progress(page)).toBeVisible();
	await expect(bar(page)).toHaveCount(0);
	await openBar(page, isMobile);
	await expect(box(page)).toHaveValue("");
});

test("the bar stays put: opening, stepping three times and across files never move it", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await phone(page, isMobile);
	const next = () =>
		isMobile
			? bar(page).getByRole("button", { name: /^Next/ }).click()
			: box(page).press("Enter");
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await openBar(page, isMobile);
	const opened = await barBox(page);
	await search(page, "saveDraft");
	expect(await barBox(page)).toEqual(opened);
	for (let i = 0; i < 3; i++) {
		await next();
		await expect(count(page)).toHaveText(counted(i + 1, ALL), VISIBLE);
		expect(await barBox(page)).toEqual(opened);
	}
	// Into src/a.ts (another file, opened by the step) and on to src/b.ts.
	await stepUntil(page, B, 12, next);
	await expect(currentRow(page)).toBeInViewport();
	expect(await barBox(page)).toEqual(opened);
	// Pinned at the top of the page, the sticky stack under it.
	expect(opened.y).toBe(0);
	expect(await barBottom(page)).toBeGreaterThan(opened.height);
});

test("on a phone the open bar hides the app header; ✕ brings it back", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "the phone layout");
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await expect(appHeader(page)).toBeVisible();
	await openBar(page, isMobile);
	await expect(appHeader(page)).toBeHidden();
	await expect(findButton(page)).toBeHidden();
	await search(page, "saveDraft");
	// Stepped rows land below the bar.
	await bar(page).getByRole("button", { name: /^Next/ }).click();
	await bar(page).getByRole("button", { name: /^Next/ }).click();
	await expect(currentSection(page)).toHaveAttribute("aria-label", DOC);
	await stepUntil(page, A, 6, () =>
		bar(page).getByRole("button", { name: /^Next/ }).click(),
	);
	await expect
		.poll(async () => {
			const row = await currentRow(page).boundingBox();
			return (row?.y ?? 0) - (await findBottom(page));
		})
		.toBeGreaterThanOrEqual(0);
	await expectNoPageOverflow(page);
	await bar(page).getByRole("button", { name: "Close (Esc)" }).click();
	await expect(bar(page)).toHaveCount(0);
	await expect(appHeader(page)).toBeVisible();
	await expect(findButton(page)).toBeFocused();
});

/** The progress bar's sticky box on screen (the files bar). */
const filesBarBox = (page: Page) =>
	page.evaluate(() => {
		const r = document
			.querySelector('[role="progressbar"][aria-label="Review progress"]')
			?.closest(".sticky")
			?.getBoundingClientRect();
		return r ? { y: r.y, bottom: r.bottom } : null;
	});
/**
 * The first thing under the app header on Files changed: the patch set
 * graph when it shows, else the files bar.
 */
const firstBelowBox = (page: Page) =>
	page.evaluate(() => {
		const el =
			document.querySelector('[aria-label="Patch sets"]') ??
			document
				.querySelector('[role="progressbar"][aria-label="Review progress"]')
				?.closest(".sticky");
		const r = el?.getBoundingClientRect();
		return r ? { y: r.y, bottom: r.bottom } : null;
	});
/** The find float's box on screen. */
const floatBox = (page: Page) =>
	page.locator("[data-find-float]").evaluate((el) => {
		const r = el.getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height };
	});

test("on a phone the open bar takes the header's place in the page, pushing it down: nothing covered, no blank band; closing restores the header", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "the phone layout");
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	expect(await page.evaluate(() => window.scrollY)).toBe(0);
	const header = await appHeader(page).boundingBox();
	const files = await filesBarBox(page);
	await openBar(page, isMobile);
	// The header leaves the layout (not just unseen).
	await expect(appHeader(page)).toBeHidden();
	expect(
		await appHeader(page).evaluate((el) => getComputedStyle(el).display),
	).toBe("none");
	// The bar starts the page, full width, just as tall as its two rows.
	const opened = await floatBox(page);
	expect(opened.y).toBe(0);
	expect(opened.x).toBe(0);
	expect(opened.width).toBe(360);
	expect(
		await page
			.locator("[data-find-float]")
			.evaluate((el) => getComputedStyle(el).minHeight),
	).toMatch(/^(0px|auto)$/);
	expect(opened.height).toBeLessThan(120);
	// The page follows right under it (the patch set graph, else the
	// files bar): no gap, no overlap.
	await expect
		.poll(async () => ((await firstBelowBox(page))?.y ?? 0) - opened.height)
		.toBeGreaterThanOrEqual(-0.5);
	expect(((await firstBelowBox(page))?.y ?? 0) - opened.height).toBeLessThan(1);
	// Focus scrolling clears the bar and the files bar stuck under it (the
	// box, focused, has none: index.css). At the top the patch set graph
	// can sit between them: the files bar's own height counts.
	await box(page).evaluate((el) => (el as HTMLElement).blur());
	const filesNow = await filesBarBox(page);
	const files2 = {
		bottom: opened.height + (filesNow?.bottom ?? 0) - (filesNow?.y ?? 0),
	};
	await expect
		.poll(() =>
			page.evaluate(() =>
				Number.parseFloat(
					getComputedStyle(document.documentElement).scrollPaddingTop,
				),
			),
		)
		.toBeGreaterThanOrEqual(files2.bottom - 1);
	// The box takes the first row, full width; the buttons the second.
	const boxAt = await box(page).boundingBox();
	const nextAt = await bar(page)
		.getByRole("button", { name: /^Next/ })
		.boundingBox();
	expect(boxAt?.width ?? 0).toBeGreaterThan(300);
	expect(nextAt?.y ?? 0).toBeGreaterThan(boxAt?.y ?? 0);
	await expectNoPageOverflow(page);
	// ✕: the header is back where it was, the files bar too.
	await bar(page).getByRole("button", { name: "Close (Esc)" }).click();
	await expect(bar(page)).toHaveCount(0);
	await expect(appHeader(page)).toBeVisible();
	expect(await appHeader(page).boundingBox()).toEqual(header);
	expect(await filesBarBox(page)).toEqual(files);
	// Reopened: the same layout.
	await openBar(page, isMobile);
	await expect(appHeader(page)).toBeHidden();
	expect(await floatBox(page)).toEqual(opened);
});

/** The review read (Files changed's data): `/api/r/<id>/review`. */
const reviewRead = (url: URL) => url.pathname.endsWith("/review");

test("on a phone the header stays, tabs and all, until the bar shows: while the review is read, then swapped", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "the phone layout");
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	const held: Route[] = [];
	let holding = true;
	await page.route(reviewRead, async (route) => {
		if (holding) held.push(route);
		else await route.continue();
	});
	await page.goto(s.url);
	// From Overview: the button opens the bar and goes to Files changed.
	await findButton(page).click();
	await expect(page).toHaveURL(/\/files/);
	await expect.poll(() => held.length).toBeGreaterThan(0);
	await expect(bar(page)).toHaveCount(0);
	await expect(appHeader(page)).toBeVisible();
	await expect(
		page.getByRole("navigation", { name: "PR pages" }),
	).toBeVisible();
	await expect(findButton(page)).toBeVisible();
	holding = false;
	for (const route of held.splice(0)) await route.continue();
	await expect(bar(page)).toBeVisible();
	await expect(appHeader(page)).toBeHidden();
	expect((await floatBox(page)).y).toBe(0);
});

test("on a phone a failed review read keeps the header, and its button closes the find", async ({
	page,
	pr,
	startCrb,
	isMobile,
	expectConsoleError,
}) => {
	test.skip(!isMobile, "the phone layout");
	expectConsoleError(/500/);
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	await page.route(reviewRead, (route) =>
		route.fulfill({ status: 500, body: "the review read failed" }),
	);
	await page.goto(s.url);
	await findButton(page).click();
	await expect(page).toHaveURL(/\/files/);
	await expect(
		page.getByRole("region", { name: "Files changed" }).getByRole("alert"),
	).toBeVisible();
	await expect(bar(page)).toHaveCount(0);
	await expect(appHeader(page)).toBeVisible();
	await expect(
		page.getByRole("navigation", { name: "PR pages" }),
	).toBeVisible();
	await expect(findButton(page)).toHaveAttribute("aria-expanded", "true");
	await findButton(page).click();
	await expect(findButton(page)).toHaveAttribute("aria-expanded", "false");
});

test("on a phone the bar stays at the top while scrolling and stepping, the files bar stuck right under it and each hit below both", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "the phone layout");
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await openBar(page, isMobile);
	const opened = await floatBox(page);
	await page.evaluate(() => window.scrollTo(0, 400));
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(400);
	expect(await floatBox(page)).toEqual(opened);
	const stuckUnder = async () =>
		((await filesBarBox(page))?.y ?? Number.NaN) - opened.height;
	await expect.poll(stuckUnder).toBeGreaterThanOrEqual(-0.5);
	expect(await stuckUnder()).toBeLessThan(1);
	await search(page, "saveDraft");
	const next = () => bar(page).getByRole("button", { name: /^Next/ }).click();
	/** The current row's top less the stack's bottom (files bar, the file's stuck header). */
	const belowStack = async () => {
		const files = (await filesBarBox(page))?.bottom ?? Number.NaN;
		const { row, header } = await currentRow(page).evaluate((el) => ({
			row: el.getBoundingClientRect().top,
			header: el.closest("section")?.querySelector("header")?.offsetHeight ?? 0,
		}));
		return row - Math.max(files + header, opened.y + opened.height);
	};
	// Into src/a.ts, then src/b.ts: another file each time.
	for (const path of [A, B]) {
		await stepUntil(page, path, 12, next);
		await expect(currentRow(page)).toBeInViewport();
		await expect.poll(belowStack).toBeGreaterThanOrEqual(0);
		expect(await floatBox(page)).toEqual(opened);
		await expect.poll(stuckUnder).toBeGreaterThanOrEqual(-0.5);
		expect(await stuckUnder()).toBeLessThan(1);
	}
	await next();
	expect(await floatBox(page)).toEqual(opened);
	await expectNoPageOverflow(page);
	for (const target of [
		box(page),
		bar(page).getByRole("button", { name: "Match case" }),
		bar(page).getByRole("button", { name: /^Previous/ }),
		bar(page).getByRole("button", { name: /^Next/ }),
		bar(page).getByRole("button", { name: "Close (Esc)" }),
	])
		expect((await target.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
			40,
		);
});

test("opening and closing the bar while scrolled keeps the diff line in view where it was", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	// Without the browser's own scroll anchoring (Safari has none): the
	// page keeps the place itself.
	await page.addStyleTag({
		content: "* { overflow-anchor: none !important; }",
	});
	await expand(page, A);
	await expand(page, B);
	const row = fileSection(page, B).getByTestId("diff-line").nth(4);
	// That line mid-screen, the header stuck above.
	await row.evaluate((el) => {
		const top = el.getBoundingClientRect().top + window.scrollY;
		window.scrollTo(0, top - window.innerHeight / 2);
	});
	await expect
		.poll(() => page.evaluate(() => window.scrollY))
		.toBeGreaterThan(200);
	const at = async () => (await row.boundingBox())?.y ?? Number.NaN;
	const before = await at();
	await openBar(page, isMobile);
	if (isMobile) await expect(appHeader(page)).toBeHidden();
	await expect
		.poll(async () => Math.abs((await at()) - before))
		.toBeLessThan(1);
	await bar(page).getByRole("button", { name: "Close (Esc)" }).click();
	await expect(bar(page)).toHaveCount(0);
	await expect(appHeader(page)).toBeVisible();
	await expect
		.poll(async () => Math.abs((await at()) - before))
		.toBeLessThan(1);
});

test("at the top of the page the Settings gear is on top where it shows (bar closed)", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "the desktop layout");
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	expect(await page.evaluate(() => window.scrollY)).toBe(0);
	const gear = page.getByRole("button", { name: "Settings", exact: true });
	expect(
		await gear.evaluate((el) => {
			const r = el.getBoundingClientRect();
			const top = document.elementFromPoint(
				r.left + r.width / 2,
				r.top + r.height / 2,
			);
			return top !== null && el.contains(top);
		}),
	).toBe(true);
});

test("the first step goes to a caret that isn't in view (under the sticky stack), and moves on from one that is", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(
		isMobile,
		"Enter needs a keyboard: the phone's ↓ runs the same step",
	);
	// A short window, so line 5 can scroll up under the sticky stack.
	await page.setViewportSize({ width: 1280, height: 360 });
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await pickInTree(page, /\sa\.ts\s/);
	const a = fileSection(page, A);
	await expect(a.getByTestId("diff-line").first()).toBeVisible();
	await openBar(page, isMobile);
	await search(page, "saveDraft");
	await expect(currentRow(page)).toHaveAttribute("data-new-no", "5");
	// Line 5 scrolled up under the sticky stack: not in view.
	const under = async () => {
		const row = await currentRow(page).evaluate(
			(el) => el.getBoundingClientRect().top,
		);
		return row - (await barBottom(page));
	};
	await page.evaluate((by) => window.scrollBy(0, by), (await under()) + 10);
	await expect.poll(under).toBeLessThan(0);
	await box(page).press("Enter");
	await expect(count(page)).toHaveText(counted(A_FIRST, ALL), VISIBLE);
	await expect(currentRow(page)).toHaveAttribute("data-new-no", "5");
	await expect.poll(under).toBeGreaterThan(0);
	// Typing again puts the caret back, unshown, on line 5, in view now.
	await box(page).fill("saveDraf");
	await expect(count(page)).toHaveText(counted(A_FIRST, ALL), VISIBLE);
	await box(page).press("Shift+Enter");
	// In view: Shift+Enter goes to the hit before it.
	await expect(count(page)).toHaveText(counted(DOC_HIT, ALL), VISIBLE);
});

test("Settings stay reachable over the open bar: a switch flips", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(
		isMobile,
		"a phone's header (and Settings) is hidden while the bar is open",
	);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await openBar(page, isMobile);
	await search(page, "saveDraft");
	// Scrolled by the steps: the header stuck, the bar right under the stack.
	for (let i = 0; i < 4; i++) await box(page).press("Enter");
	await expect
		.poll(() => page.evaluate(() => window.scrollY))
		.toBeGreaterThan(0);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const toggle = page.getByRole("switch", { name: "Show hidden characters" });
	// Nothing lies over it: the topmost element at its centre is the switch.
	expect(
		await toggle.evaluate((el) => {
			const r = el.getBoundingClientRect();
			const top = document.elementFromPoint(
				r.left + r.width / 2,
				r.top + r.height / 2,
			);
			return top !== null && el.contains(top);
		}),
	).toBe(true);
	const was = await toggle.getAttribute("aria-checked");
	await toggle.click();
	await expect(toggle).toHaveAttribute(
		"aria-checked",
		was === "true" ? "false" : "true",
	);
	await expect(bar(page)).toBeVisible();
});

test("the shortcuts help lists Find in PR, Next match and Previous match under Files changed", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "no keyboard on a phone: the help isn't offered");
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await page.keyboard.press("Shift+Slash");
	const files = page
		.getByRole("dialog", { name: "Keyboard shortcuts" })
		.getByRole("region", { name: "Files changed" });
	for (const label of ["Find in PR", "Next match", "Previous match"])
		await expect(files.getByText(label, { exact: true }).first()).toBeVisible();
});

test("a failed batch is reported and Retry asks again", async ({
	page,
	pr,
	startCrb,
	isMobile,
	expectConsoleError,
}) => {
	expectConsoleError(/500/);
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	await page.route(
		"**/api/r/*/files/hunks?**",
		(route) => route.fulfill({ status: 500, body: "{}" }),
		{ times: 1 },
	);
	await openFiles(page, s.url);
	await openBar(page, isMobile);
	await box(page).fill("saveDraft");
	const retry = bar(page).getByRole("button", {
		name: /files? couldn't be searched · Retry/,
	});
	await expect(retry).toBeVisible();
	await expect(spinner(page)).toHaveCount(0);
	await expect(count(page)).toHaveText(counted(1, CHANGED), VISIBLE);
	await page.unroute("**/api/r/*/files/hunks?**");

	await retry.click();
	await expect(retry).toHaveCount(0);
	await expect(spinner(page)).toHaveCount(0);
	await expect(count(page)).toHaveText(counted(1, ALL), VISIBLE);
});

test("the bar fits 360px with 40px controls and no page overflow", async ({
	page,
	pr,
	startCrb,
	isMobile,
	expectConsoleError,
}) => {
	test.skip(!isMobile, "the phone layout");
	expectConsoleError(/500/);
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await openBar(page, isMobile);
	await search(page, "saveDraft");
	await expectNoPageOverflow(page);
	const controls = [
		box(page),
		bar(page).getByRole("button", { name: "Match case" }),
		bar(page).getByRole("button", { name: /^Previous/ }),
		bar(page).getByRole("button", { name: /^Next/ }),
		bar(page).getByRole("button", { name: "Close (Esc)" }),
	];
	for (const control of controls) {
		const r = await control.boundingBox();
		expect(r?.height).toBeGreaterThanOrEqual(40);
		expect((r?.x ?? -1) >= 0 && (r?.x ?? 0) + (r?.width ?? 0) <= 360).toBe(
			true,
		);
	}

	// The spinner and a Retry at once still fit: src/a.ts's own request
	// fails while the batch is held.
	await bar(page).getByRole("button", { name: "Close (Esc)" }).click();
	await expect(bar(page)).toHaveCount(0);
	const held = holdBatches(page);
	await held.ready;
	await page.route(
		"**/api/r/*/files/*/hunks?**",
		(route) => route.fulfill({ status: 500, body: "{}" }),
		{ times: 1 },
	);
	try {
		await page.reload();
		await expect(progress(page)).toBeVisible();
		await expand(page, A);
		await openBar(page, isMobile);
		await box(page).fill("saveDraft");
		await expect(spinner(page)).toBeVisible();
		const retry = bar(page).getByRole("button", {
			name: /files? couldn't be searched · Retry/,
		});
		await expect(retry).toBeVisible();
		await expectNoPageOverflow(page);
		for (const control of [...controls, retry, spinner(page)]) {
			const r = await control.boundingBox();
			expect(r).not.toBeNull();
			expect((r?.x ?? -1) >= 0 && (r?.x ?? 0) + (r?.width ?? 0) <= 360).toBe(
				true,
			);
		}
		// Two rows (the box, then the count and buttons), never a third.
		const height = (await bar(page).boundingBox())?.height ?? 0;
		expect(height).toBeLessThan(100);
	} finally {
		await held.release();
	}
	await expect(spinner(page)).toHaveCount(0);
});

/**
 * Stands in for the browser's visualViewport: `window.__vv(top, scale)` pans
 * it (or zooms it) and tells its listeners, as the soft keyboard (or a
 * pinch) does.
 */
const fakeVisualViewport = (page: Page) =>
	page.addInitScript(() => {
		const target = new EventTarget();
		const state = { top: 0, scale: 1 };
		const props: Record<string, () => number> = {
			offsetTop: () => state.top,
			offsetLeft: () => 0,
			scale: () => state.scale,
			width: () => window.innerWidth,
			height: () => window.innerHeight - state.top,
			pageTop: () => window.scrollY + state.top,
			pageLeft: () => window.scrollX,
		};
		for (const [key, get] of Object.entries(props))
			Object.defineProperty(target, key, { get });
		Object.defineProperty(window, "visualViewport", {
			configurable: true,
			get: () => target,
		});
		(window as unknown as Record<string, unknown>).__vv = (
			top: number,
			scale: number,
		) => {
			state.top = top;
			state.scale = scale;
			target.dispatchEvent(new Event("scroll"));
		};
	});

test("on a phone the bar stays at the top at any scroll, and keeps to the visual viewport's top as the keyboard pans it (not a pinch zoom)", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "the phone layout");
	await phone(page, isMobile);
	await fakeVisualViewport(page);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	// Android's keyboard shrinks the layout viewport: native sticky holds.
	expect(
		await page.locator('meta[name="viewport"]').getAttribute("content"),
	).toContain("interactive-widget=resizes-content");
	await expand(page, A);
	await expand(page, B);
	await openBar(page, isMobile);
	const opened = await floatBox(page);
	expect(opened.y).toBe(0);
	for (const by of [50, 300]) {
		await page.evaluate((b) => window.scrollBy(0, b), by);
		expect(await floatBox(page)).toEqual(opened);
		await expect(bar(page)).toBeInViewport({ ratio: 1 });
	}
	await page.evaluate(() =>
		window.scrollTo(0, document.documentElement.scrollHeight),
	);
	expect(await floatBox(page)).toEqual(opened);
	await expect(bar(page)).toBeInViewport({ ratio: 1 });
	/** The bar's top, and the files bar's top less the bar's bottom. */
	const tops = () =>
		page.evaluate(() => {
			const float = document
				.querySelector("[data-find-float]")
				?.getBoundingClientRect();
			const files = document
				.querySelector('[role="progressbar"][aria-label="Review progress"]')
				?.closest(".sticky")
				?.getBoundingClientRect();
			return {
				bar: Math.round(float?.top ?? Number.NaN),
				files: Math.round((files?.top ?? Number.NaN) - (float?.bottom ?? 0)),
			};
		});
	const pan = (top: number, scale: number) =>
		page.evaluate(
			([t, z]) =>
				(window as unknown as { __vv: (t: number, z: number) => void }).__vv(
					t,
					z,
				),
			[top, scale] as const,
		);
	// iOS's keyboard leaves the layout viewport as it is and pans the visual
	// one down a scroll: the bar and the files bar keep to its top.
	await page.evaluate(() => window.scrollTo(0, 300));
	await pan(150, 1);
	await expect.poll(tops).toEqual({ bar: 150, files: 0 });
	await pan(40, 1);
	await expect.poll(tops).toEqual({ bar: 40, files: 0 });
	// A pinch zoom isn't followed: the bar stays at the page's top.
	await pan(150, 2);
	await expect.poll(tops).toEqual({ bar: 0, files: 0 });
	await pan(0, 1);
	await expect.poll(tops).toEqual({ bar: 0, files: 0 });
});

test("the bar never shows on another page: opened from Overview, it shows only once Files changed does", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await phone(page, isMobile);
	await pr(fixture);
	const s = await startCrb();
	// Files changed visited, so it is kept mounted (hidden) on Overview.
	await openFiles(page, s.url);
	await page.getByRole("link", { name: "Overview" }).click();
	await expect(page).not.toHaveURL(/\/files/);
	await expect(findButton(page)).toBeVisible();
	// Every strip put in the slot: was Files changed showing then?
	await page.evaluate(() => {
		const seen: boolean[] = [];
		(window as unknown as { __strips: boolean[] }).__strips = seen;
		const slot = document.querySelector("[data-find-slot]");
		if (!slot) throw new Error("no slot");
		new MutationObserver((records) => {
			for (const r of records)
				for (const node of r.addedNodes) {
					if (!(node instanceof Element)) continue;
					const files = document
						.querySelector('section[aria-label="Files changed"]')
						?.closest("[data-page]");
					seen.push(
						files !== null &&
							files !== undefined &&
							!files.hasAttribute("hidden"),
					);
				}
		}).observe(slot, { childList: true });
	});
	await findButton(page).click();
	await expect(page).toHaveURL(/\/files/);
	await expect(bar(page)).toBeVisible();
	const strips = await page.evaluate(
		() => (window as unknown as { __strips: boolean[] }).__strips,
	);
	expect(strips.length).toBeGreaterThan(0);
	expect(strips.every(Boolean)).toBe(true);
});

test("on desktop the open bar pushes the app header down: nothing covered at the top, the header stuck under it once scrolled, back at the top on close", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "the desktop layout");
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	expect((await appHeader(page).boundingBox())?.y).toBe(0);
	await openBar(page, isMobile);
	const opened = await floatBox(page);
	expect(opened.y).toBe(0);
	expect(opened.x).toBe(0);
	expect(opened.height).toBeLessThan(80);
	// The header, buttons and all, right under the bar.
	await expect
		.poll(async () => (await appHeader(page).boundingBox())?.y)
		.toBe(opened.height);
	const gear = page.getByRole("button", { name: "Settings", exact: true });
	expect((await gear.boundingBox())?.y ?? 0).toBeGreaterThanOrEqual(
		opened.height,
	);
	expect(
		await gear.evaluate((el) => {
			const r = el.getBoundingClientRect();
			const top = document.elementFromPoint(
				r.left + r.width / 2,
				r.top + r.height / 2,
			);
			return top !== null && el.contains(top);
		}),
	).toBe(true);
	await expect(findButton(page)).toHaveAttribute("aria-expanded", "true");
	// Stepping scrolls: the bar stays, the header's row sticks under it, the
	// files bar under that, each hit below them all.
	await search(page, "saveDraft");
	const row = page.getByTestId("app-header-row");
	const headerBottom = async () => {
		const h = await appHeader(page).boundingBox();
		return (h?.y ?? 0) + (h?.height ?? 0);
	};
	for (const path of [A, B]) {
		await stepUntil(page, path);
		expect(await floatBox(page)).toEqual(opened);
		await expect
			.poll(async () => (await row.boundingBox())?.y ?? 0)
			.toBeGreaterThanOrEqual(opened.height - 0.5);
		await expect
			.poll(async () =>
				Math.round(
					(await headerBottom()) - ((await filesBarBox(page))?.y ?? 0),
				),
			)
			.toBe(0);
		await expect
			.poll(async () => {
				const r = await currentRow(page).evaluate((el) => ({
					row: el.getBoundingClientRect().top,
					header:
						el.closest("section")?.querySelector("header")?.offsetHeight ?? 0,
				}));
				return r.row - ((await barBottom(page)) + r.header);
			})
			.toBeGreaterThanOrEqual(0);
	}
	// Scrolled: the stuck header's row right under the bar.
	expect((await row.boundingBox())?.y ?? 0).toBeLessThanOrEqual(
		opened.height + 1,
	);
	// Focus scrolling clears the bar and the stack.
	await box(page).evaluate((el) => (el as HTMLElement).blur());
	expect(
		await page.evaluate(() =>
			Number.parseFloat(
				getComputedStyle(document.documentElement).scrollPaddingTop,
			),
		),
	).toBeGreaterThanOrEqual(((await filesBarBox(page))?.bottom ?? 0) - 1);
	await page.evaluate(() => window.scrollTo(0, 0));
	await findButton(page).click();
	await expect(bar(page)).toHaveCount(0);
	await expect
		.poll(async () => (await appHeader(page).boundingBox())?.y)
		.toBe(0);
});

/** The since view's git steps (the head check's fetch, the engine): rereview.spec's GIT_WAIT. */
const GIT_WAIT = { timeout: 30_000 };
const core = numbered("core", 40);
const util = numbered("util", 10);
/** PS1: five lines on top of core.ts, line 20 "earlyTerm"; util.ts line 3. */
const ps1Core = [
	...numbered("top", 5),
	...core.map((l, i) => (i === 19 ? "earlyTerm 20" : l)),
];

test("the since view searches the interdiff: nothing changed only before it, its own lines at its numbers; the full diff finds the earlier change again", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	const p = await pr({
		base: { "src/core.ts": text(core), "src/util.ts": text(util) },
		files: [
			{
				message: "PS1",
				files: {
					"src/core.ts": text(ps1Core),
					"src/util.ts": text(util.map((l, i) => (i === 2 ? "util 3 v1" : l))),
				},
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	await phone(page, isMobile);
	// PS1, fully reviewed.
	for (const path of ["src/core.ts", "src/util.ts"]) {
		await fileAction(fileSection(page, path), "Mark remaining reviewed");
		await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	}
	// PS2: core.ts's line 30 (PS1's 35) rewritten, util.ts's line 8.
	p.moveHead({
		message: "PS2",
		files: {
			"src/core.ts": text(
				ps1Core.map((l) => (l === "core 30" ? "laterTerm 30" : l)),
			),
			"src/util.ts": text(
				util.map((l, i) => (i === 2 ? "util 3 v1" : i === 7 ? "util 8 v2" : l)),
			),
		},
	});
	await page.reload();
	await expect(page.getByTestId("ps-tail")).toHaveAttribute(
		"data-state",
		"head",
		GIT_WAIT,
	);
	await page
		.getByTestId("head-toast")
		.getByRole("button", { name: "View" })
		.click();
	// A mark on the head starts PS2; then the since view PS1 → PS2.
	const util2 = fileSection(page, "src/util.ts");
	await expect(
		util2
			.locator('[data-testid="since-chips"] [data-testid="kind-chip"]')
			.first(),
	).toBeVisible(GIT_WAIT);
	await fileAction(util2, "Mark remaining reviewed");
	await expect(page).toHaveURL(/ps=2/);
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	const since = new URL(page.url());
	since.searchParams.set("from", "1");
	await page.goto(since.toString());
	await expect(
		page
			.getByTestId("ps-node-ps1")
			.getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	const coreS = fileSection(page, "src/core.ts");
	await expect(
		coreS
			.locator('[data-testid="since-chips"] [data-testid="kind-chip"]')
			.first(),
	).toBeVisible(GIT_WAIT);

	// Changed before PS1 only: no hit in the interdiff.
	await openBar(page, isMobile);
	await search(page, "earlyTerm");
	await expect(count(page)).toHaveText(counted(0, 0), VISIBLE);
	// Changed in PS2: its old line at PS1's number, its new one at PS2's;
	// a step opens core.ts and scrolls to each row.
	await search(page, "core 30");
	await expect(count(page)).toHaveText(counted(1, 1), VISIBLE);
	await box(page).press("Enter");
	await expect(expandToggle(coreS)).toHaveAttribute("aria-expanded", "true");
	await expect(currentRow(page)).toHaveAttribute("data-old-no", "35");
	await expect(currentRow(page)).toHaveAttribute("data-kind", "del");
	await expect(currentRow(page)).toBeInViewport();
	await search(page, "laterTerm");
	await expect(count(page)).toHaveText(counted(1, 1), VISIBLE);
	await box(page).press("Enter");
	await expect(currentRow(page)).toHaveAttribute("data-new-no", "35");
	await expect(currentRow(page)).toHaveAttribute("data-kind", "add");
	await expect(currentRow(page)).toBeInViewport();
	await expectNoPageOverflow(page);

	// The full diff (base on the branch): the earlier change is found again.
	const full = new URL(page.url());
	full.searchParams.set("from", "branch");
	await page.goto(full.toString());
	await expect(
		page
			.getByTestId("ps-node-branch")
			.getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	await openBar(page, isMobile);
	await search(page, "earlyTerm");
	await expect(count(page)).toHaveText(counted(1, 1), VISIBLE);
	await box(page).press("Enter");
	await expect(currentRow(page)).toHaveAttribute("data-new-no", "25");
	await expect(currentRow(page)).toBeInViewport();
});
