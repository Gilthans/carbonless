import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import type { Scenario } from "../test/fake-gh/scenario";
import { fileSection, openFiles } from "./files-ui";
import { expect, type Pr, type PrOptions, test } from "./fixtures";

/**
 * Starting threads from Files changed on the fake gh: on a span, on lines
 * picked by their numbers, and on whole files (binary, empty). The viewer
 * is Octo_Cat. src/greet.ts: new line 3 changed, old 10 became new 10–12.
 */
const GREET = "src/greet.ts";
const base = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
const fixture: PrOptions = {
	base: { [GREET]: `${base.join("\n")}\n` },
	files: [
		{
			message: "greet",
			files: {
				[GREET]: `${base
					.flatMap((l, i) =>
						i === 2
							? ["const trimmed = name.trim();"]
							: i === 9
								? ["new a", "new b", "new c"]
								: [l],
					)
					.join("\n")}\n`,
				"empty.txt": "",
			},
			binary: { "logo.png": new Uint8Array([137, 80, 78, 71, 0, 1, 2, 0]) },
		},
	],
};

const PENDING = {
	author: { login: "Octo_Cat", __typename: "User" },
	state: "PENDING",
	submittedAt: null,
	createdAt: "2026-01-03T00:00:00Z",
};

/** Threads the fake gh stores, with their opener's body. */
function stored(p: Pr) {
	const s = JSON.parse(readFileSync(p.scenarioPath, "utf8")) as Scenario;
	return (
		(s.prs[7]?.graphql?.reviewThreads ?? []) as {
			path: string;
			subjectType: string;
			line: number;
			originalStartLine: number | null;
			comments: { nodes: { body: string }[] };
		}[]
	).map((t) => ({ ...t, body: t.comments.nodes[0]?.body ?? "" }));
}

const shots = process.env.DESIGN_SHOTS;
async function shot(page: Page, name: string, isMobile: boolean) {
	if (!shots) return;
	await page.screenshot({
		path: `${shots}/${name}-${isMobile ? "phone" : "desktop"}.png`,
	});
}

async function openFile(page: Page, url: string, path: string) {
	await openFiles(page, url);
	const section = fileSection(page, path);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.getByTestId("diff-line").first()).toBeVisible();
	return section;
}

/** A row by its number on a side. */
const row = (section: Locator, side: "LEFT" | "RIGHT", n: number) =>
	section.locator(
		`tr[data-testid="diff-line"][data-${side === "LEFT" ? "old" : "new"}-no="${n}"]`,
	);

/**
 * Selects characters `from`..`to` of new line `n` (the way a drag would)
 * and lets the pointer go.
 */
async function selectText(
	page: Page,
	path: string,
	n: number,
	from: number,
	to: number,
) {
	await page.evaluate(
		({ path, n, from, to }) => {
			const code = document.querySelector(
				`[data-path="${path}"] tr[data-new-no="${n}"] > [data-code-cell][data-side="RIGHT"] [data-code]`,
			);
			if (!code) throw new Error("no line");
			const at = (col: number): [Node, number] => {
				const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
				let left = col;
				for (let t = walker.nextNode(); t; t = walker.nextNode()) {
					const len = (t as Text).data.length;
					if (left <= len) return [t, left];
					left -= len;
				}
				throw new Error("past the line");
			};
			// Pressing in the code moves focus out of any box; a long press
			// on a touch screen, a mouse press elsewhere.
			(document.activeElement as HTMLElement | null)?.blur();
			const pointerType = navigator.maxTouchPoints > 0 ? "touch" : "mouse";
			document.dispatchEvent(
				new PointerEvent("pointerdown", { bubbles: true, pointerType }),
			);
			const range = document.createRange();
			range.setStart(...at(from));
			range.setEnd(...at(to));
			const selection = document.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			document.dispatchEvent(
				new PointerEvent("pointerup", { bubbles: true, pointerType }),
			);
		},
		{ path, n, from, to },
	);
}

const bar = (page: Page) => page.getByTestId("selection-bar");

test("select a span and comment: it posts, and the span is painted after a reload", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	const section = await openFile(page, s.url, GREET);
	// "name.trim()" in "const trimmed = name.trim();".
	await selectText(page, GREET, 3, 16, 27);
	await expect(bar(page)).toBeVisible();
	await shot(page, "new-thread-bar", isMobile);
	await bar(page).getByRole("button", { name: "Comment" }).click();
	const composer = section.getByTestId("new-thread");
	await expect(composer.getByTestId("new-thread-quote")).toHaveText(
		"name.trim()",
	);
	const box = composer.getByRole("textbox", { name: "Comment" });
	await expect(box).toBeFocused();
	await box.fill("Collapse inner whitespace too?");
	await shot(page, "new-thread-composer", isMobile);
	await box.press("Control+Enter");
	const thread = section
		.getByTestId("files-thread")
		.filter({ hasText: "Collapse inner whitespace too?" });
	await expect(thread).toBeVisible();
	await expect(section.getByTestId("new-thread")).toHaveCount(0);
	const painted = () =>
		section
			.locator("[data-span-mark]")
			.evaluateAll((els) => els.map((e) => e.textContent).join(""));
	await expect.poll(painted).toBe("name.trim()");
	await shot(page, "new-thread-posted", isMobile);
	// GitHub got the whole line, and the span in the hidden marker.
	const [t] = stored(p);
	expect(t).toMatchObject({ path: GREET, subjectType: "LINE", line: 3 });
	expect(t?.body).toContain("Collapse inner whitespace too?");
	expect(t?.body).toMatch(/<!-- crb:v1 id=\S+ span=3:16-3:27 -->$/);
	await page.reload();
	const again = await openFile(page, s.url, GREET);
	await expect
		.poll(() =>
			again
				.locator("[data-span-mark]")
				.evaluateAll((els) => els.map((e) => e.textContent).join("")),
		)
		.toBe("name.trim()");
	await expect(row(again, "RIGHT", 3)).toHaveAttribute("data-commented", "");
});

test("pick lines by their numbers and comment on them", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	const section = await openFile(page, s.url, GREET);
	const number = (n: number) => row(section, "RIGHT", n).getByTestId("new");
	if (isMobile) {
		// A second tap extends.
		await number(10).tap();
		await number(12).tap();
	} else {
		await number(10).click();
		await number(12).click({ modifiers: ["Shift"] });
	}
	await expect(section.locator("tr[data-picked]")).toHaveCount(3);
	await shot(page, "new-thread-picked", isMobile);
	await bar(page).getByRole("button", { name: "Comment" }).click();
	await expect(section.locator("tr[data-picked]")).toHaveCount(0);
	const composer = section.getByTestId("new-thread");
	await expect(composer).toContainText("lines 10–12, new");
	await composer.getByRole("textbox", { name: "Comment" }).fill("Three?");
	await composer.getByRole("button", { name: "Comment" }).click();
	await expect(
		section.getByTestId("files-thread").filter({ hasText: "Three?" }),
	).toBeVisible();
	// Exactly the three lines GitHub has.
	await expect(section.locator("tr[data-commented]")).toHaveCount(3);
	expect(stored(p)).toMatchObject([
		{ path: GREET, line: 12, originalStartLine: 10 },
	]);
});

for (const path of [GREET, "logo.png", "empty.txt"]) {
	test(`comment on a whole file from its bubble: ${path}`, async ({
		page,
		pr,
		startCrb,
		isMobile,
	}) => {
		const p = await pr(fixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		const section = fileSection(page, path);
		// No file comment from a closed file's header.
		await expect(
			section.getByRole("button", { name: "Comment on file" }),
		).toHaveCount(0);
		await section.getByRole("button", { name: "Expand file" }).click();
		// The outline bubble, on the diff's first row.
		const bubble = section.getByRole("button", { name: "Comment on file" });
		await expect(bubble).toBeVisible();
		await expect(
			section.locator("table tr").first().getByTestId("thread-bubble"),
		).toHaveAccessibleName("Comment on file");
		await bubble.click();
		const composer = section.getByTestId("new-thread");
		await expect(composer).toContainText("whole file");
		await composer.getByRole("textbox", { name: "Comment" }).fill("A 2x one?");
		if (path === "logo.png") await shot(page, "new-thread-file", isMobile);
		await composer.getByRole("button", { name: "Comment" }).click();
		await expect(section.getByTestId("new-thread")).toHaveCount(0);
		// Posted: the bubble counts it, its thread open under the first row.
		await expect(
			section.getByRole("button", { name: /1 comment on this file/ }),
		).toHaveAttribute("aria-expanded", "true");
		await expect(
			section.getByTestId("file-threads").getByTestId("files-thread"),
		).toContainText("A 2x one?");
		expect(stored(p)).toMatchObject([{ path, subjectType: "FILE" }]);
	});
}

test("the bar sits by what is selected: just below it, beside it", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await pr(fixture);
	const s = await startCrb();
	const section = await openFile(page, s.url, GREET);
	await selectText(page, GREET, 3, 6, 16);
	await expect(bar(page)).toBeVisible();
	const sel = await page.evaluate(() => {
		const r = document.getSelection()?.getRangeAt(0).getBoundingClientRect();
		return r ? { left: r.left, right: r.right, bottom: r.bottom } : null;
	});
	const line = await row(section, "RIGHT", 3).boundingBox();
	// Settled where it goes (it is placed a frame after it shows).
	await expect
		.poll(async () => (await bar(page).boundingBox())?.y ?? 0)
		.toBeGreaterThanOrEqual(sel?.bottom ?? 0);
	let box = await bar(page).boundingBox();
	if (!sel || !line || !box) throw new Error("no geometry");
	// Below the line, within two lines of it: on a phone a handle's room
	// lower, so the end handle stays grabbable.
	expect(box.y).toBeGreaterThanOrEqual(sel.bottom + (isMobile ? 24 : 0));
	expect(box.y).toBeLessThanOrEqual(sel.bottom + 2 * line.height);
	expect(box.x).toBeLessThanOrEqual(sel.right + 8);
	expect(box.x + box.width).toBeGreaterThanOrEqual(sel.left - 8);
	const inView = async () => {
		const b = await bar(page).boundingBox();
		const v = await page.evaluate(() => ({
			w: window.visualViewport?.width ?? window.innerWidth,
			h: window.visualViewport?.height ?? window.innerHeight,
		}));
		if (!b) throw new Error("no bar");
		expect(b.x).toBeGreaterThanOrEqual(0);
		expect(b.y).toBeGreaterThanOrEqual(0);
		expect(b.x + b.width).toBeLessThanOrEqual(v.w);
		expect(b.y + b.height).toBeLessThanOrEqual(v.h);
	};
	await inView();
	await shot(page, "selection-bar-text", isMobile);
	await page.keyboard.press("Escape");
	await page.evaluate(() => document.getSelection()?.removeAllRanges());
	// Picked lines: by their numbers (room for the bar below them).
	await row(section, "RIGHT", 10).evaluate((el) =>
		el.scrollIntoView({ block: "center" }),
	);
	if (isMobile) {
		// A second tap extends.
		await row(section, "RIGHT", 10).getByTestId("new").tap();
		await row(section, "RIGHT", 12).getByTestId("new").tap();
	} else {
		await row(section, "RIGHT", 10).getByTestId("new").click();
		await row(section, "RIGHT", 12)
			.getByTestId("new")
			.click({ modifiers: ["Shift"] });
	}
	const last = await row(section, "RIGHT", 12).boundingBox();
	const number = await row(section, "RIGHT", 12)
		.getByTestId("new")
		.boundingBox();
	if (!last || !number) throw new Error("no geometry");
	await expect(section.locator("tr[data-picked]")).toHaveCount(3);
	// It moves down with the pick (a frame later).
	await expect
		.poll(async () => (await bar(page).boundingBox())?.y ?? 0)
		.toBeGreaterThanOrEqual(last.y + last.height);
	box = await bar(page).boundingBox();
	if (!box) throw new Error("no bar");
	expect(box.y).toBeLessThanOrEqual(last.y + 2 * last.height);
	// Right beside the number, never over the numbers below it.
	expect(box.x).toBeGreaterThanOrEqual(number.x + number.width);
	expect(box.x).toBeLessThanOrEqual(number.x + number.width + 8);
	await inView();
	await shot(page, "selection-bar-picked", isMobile);
	// The numbers below stay free: a tap (click) on 14 extends the pick.
	const below = row(section, "RIGHT", 14).getByTestId("new");
	if (isMobile) await below.tap();
	else await below.click({ modifiers: ["Shift"] });
	await expect(section.locator("tr[data-picked]")).toHaveCount(5);
});

/** The bar's box, once it has settled below `y` (it is placed a frame later). */
async function barBelow(page: Page, y: number) {
	await expect
		.poll(async () => (await bar(page).boundingBox())?.y ?? 0)
		.toBeGreaterThanOrEqual(y);
	const box = await bar(page).boundingBox();
	if (!box) throw new Error("no bar");
	return box;
}

/** Inside what the screen shows. */
async function expectInView(page: Page) {
	const b = await bar(page).boundingBox();
	const v = await page.evaluate(() => ({
		w: window.visualViewport?.width ?? window.innerWidth,
		h: window.visualViewport?.height ?? window.innerHeight,
	}));
	if (!b) throw new Error("no bar");
	expect(b.x).toBeGreaterThanOrEqual(0);
	expect(b.y).toBeGreaterThanOrEqual(0);
	expect(b.x + b.width).toBeLessThanOrEqual(v.w);
	expect(b.y + b.height).toBeLessThanOrEqual(v.h);
}

/**
 * Text selected by touch in the last line of the last file, the page
 * scrolled to its end: the bar still goes below it, the handle's room
 * under the line (the page moves up once to make it).
 */
async function lastLine(page: Page, url: string, name: string) {
	const section = await openFile(page, url, GREET);
	// src/greet.ts comes last; new line 15 is its last row shown.
	await page.evaluate(() =>
		window.scrollTo(0, document.documentElement.scrollHeight),
	);
	await selectText(page, GREET, 15, 0, 4);
	await expect(bar(page)).toBeVisible();
	const sel = async () =>
		(await page.evaluate(
			() =>
				document.getSelection()?.getRangeAt(0).getBoundingClientRect().bottom,
		)) ?? 0;
	await expect
		.poll(async () => {
			const b = await bar(page).boundingBox();
			return b ? b.y - (await sel()) : -1;
		})
		.toBeGreaterThanOrEqual(24);
	const line = await row(section, "RIGHT", 15).boundingBox();
	const box = await bar(page).boundingBox();
	expect((box?.y ?? 0) - (await sel())).toBeLessThanOrEqual(
		2 * (line?.height ?? 20) + 8,
	);
	await expectInView(page);
	await shot(page, name, true);
}

test("a selection by touch in the last line of the last file: the bar goes below it", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "touch");
	await pr(fixture);
	const s = await startCrb();
	await lastLine(page, s.url, "selection-bar-last-line");
});

test.describe("a phone in landscape: wide, but touch", () => {
	test.use({ viewport: { width: 915, height: 412 }, hasTouch: true });

	test("the bar under text keeps the handle's room, inside the screen", async ({
		page,
		pr,
		startCrb,
	}, testInfo) => {
		test.skip(testInfo.project.name !== "phone", "the phone project's run");
		await pr(fixture);
		const s = await startCrb();
		const section = await openFile(page, s.url, GREET);
		await row(section, "RIGHT", 3).evaluate((el) =>
			el.scrollIntoView({ block: "center" }),
		);
		await selectText(page, GREET, 3, 6, 16);
		await expect(bar(page)).toBeVisible();
		const sel = await page.evaluate(
			() =>
				document.getSelection()?.getRangeAt(0).getBoundingClientRect().bottom ??
				0,
		);
		const line = await row(section, "RIGHT", 3).boundingBox();
		const box = await barBelow(page, sel + 24);
		expect(box.y).toBeLessThanOrEqual(sel + 2 * (line?.height ?? 20));
		await expectInView(page);
		await shot(page, "selection-bar-landscape", true);
	});

	test("the last line of the last file: below it too", async ({
		page,
		pr,
		startCrb,
	}, testInfo) => {
		test.skip(testInfo.project.name !== "phone", "the phone project's run");
		await pr(fixture);
		const s = await startCrb();
		await lastLine(page, s.url, "selection-bar-last-line-landscape");
	});
});

test("a pick from a removed line extends to its added replacement: the bar never covers the numbers below", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	const section = await openFile(page, s.url, GREET);
	const removed = row(section, "LEFT", 10).and(
		section.locator('tr[data-kind="del"]'),
	);
	await removed.evaluate((el) => el.scrollIntoView({ block: "center" }));
	if (isMobile) {
		await removed.getByTestId("old").tap();
		await row(section, "RIGHT", 10).getByTestId("new").tap();
	} else {
		await removed.getByTestId("old").click();
		await expect(bar(page)).toBeVisible();
		// The bar is up; the added line's number is still free to click.
		await row(section, "RIGHT", 10)
			.getByTestId("new")
			.click({ modifiers: ["Shift"], trial: true });
		await row(section, "RIGHT", 10)
			.getByTestId("new")
			.click({ modifiers: ["Shift"] });
	}
	await expect(section.locator("tr[data-picked]")).toHaveCount(2);
	await bar(page).getByRole("button", { name: "Comment" }).click();
	const composer = section.getByTestId("new-thread");
	await composer.getByRole("textbox", { name: "Comment" }).fill("Why?");
	await composer.getByRole("button", { name: "Comment" }).click();
	await expect(
		section.getByTestId("files-thread").filter({ hasText: "Why?" }),
	).toBeVisible();
	expect(stored(p)).toMatchObject([{ path: GREET, line: 10 }]);
});

test("a comment's draft survives a reload and counts in Drafts", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(fixture);
	const s = await startCrb();
	const section = await openFile(page, s.url, GREET);
	await selectText(page, GREET, 11, 0, 5);
	await bar(page).getByRole("button", { name: "Comment" }).click();
	await section
		.getByTestId("new-thread")
		.getByRole("textbox", { name: "Comment" })
		.fill("Half a thought");
	// Kept, it loses nothing: the reload doesn't ask.
	const asked: string[] = [];
	page.on("dialog", (d) => {
		asked.push(d.type());
		void d.accept();
	});
	await page.reload();
	expect(asked).toEqual([]);
	await page.goto(s.url);
	await expect(page.getByTestId("drafts-filter")).toContainText("1 draft");
	const again = await openFile(page, s.url, GREET);
	await expect(
		again.getByTestId("new-thread").getByRole("textbox", { name: "Comment" }),
	).toHaveValue("Half a thought");
	// Painted while it's written.
	await expect(row(again, "RIGHT", 11)).toHaveAttribute("data-commented", "");
});

test("a pending review refuses it with the link, the draft kept", async ({
	page,
	pr,
	startCrb,
	isMobile,
	expectConsoleError,
}) => {
	expectConsoleError(/409/);
	const p = await pr({ ...fixture, reviews: [PENDING] });
	const s = await startCrb();
	const section = await openFile(page, s.url, GREET);
	await selectText(page, GREET, 3, 0, 5);
	await bar(page).getByRole("button", { name: "Comment" }).click();
	const composer = section.getByTestId("new-thread");
	const box = composer.getByRole("textbox", { name: "Comment" });
	await box.fill("Blocked");
	await box.press("Control+Enter");
	const notice = page.getByTestId("write-failed");
	await expect(notice).toContainText(
		"A pending review on GitHub blocks comments",
	);
	await expect(notice).toContainText(`${GREET}:3`);
	await expect(
		notice.getByRole("link", { name: "Open on GitHub" }),
	).toHaveAttribute("href", "https://github.com/acme/widget/pull/7/files");
	await expect(composer.getByTestId("new-thread-error")).toBeVisible();
	await expect(box).toHaveValue("Blocked");
	// The notice and the Files button leave the box and its button clear.
	const post = composer.getByRole("button", { name: "Comment" });
	const apart = async (a: Locator, b: Locator) => {
		const x = await a.boundingBox();
		const y = await b.boundingBox();
		if (!x || !y) return true;
		return (
			x.y + x.height <= y.y ||
			y.y + y.height <= x.y ||
			x.x + x.width <= y.x ||
			y.x + y.width <= x.x
		);
	};
	await expect.poll(() => apart(notice, box)).toBe(true);
	await expect.poll(() => apart(notice, post)).toBe(true);
	await expect(
		page.getByRole("button", { name: "Files", exact: true }),
	).toBeHidden();
	await shot(page, "new-thread-pending-review", isMobile);
	expect(stored(p)).toEqual([]);
});

test("the bar doesn't break copying: the clipboard gets the selection", async ({
	page,
	context,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "no keyboard copy on a phone");
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await pr(fixture);
	const s = await startCrb();
	await openFile(page, s.url, GREET);
	await selectText(page, GREET, 3, 6, 27);
	await expect(bar(page)).toBeVisible();
	// Pressing the bar (its edge, not a button) keeps the selection too.
	const box = await bar(page).boundingBox();
	expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(
		"trimmed = name.trim()",
	);
	await page.mouse.move(
		(box?.x ?? 0) + 2,
		(box?.y ?? 0) + (box?.height ?? 0) / 2,
	);
	await page.mouse.down();
	await page.mouse.up();
	const selected = await page.evaluate(() =>
		document.getSelection()?.toString(),
	);
	expect(selected).toBe("trimmed = name.trim()");
	await page.keyboard.press("Control+c");
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		selected,
	);
});

test("no sideways page scroll at 360px with the bar and the composer open", async ({
	page,
	pr,
	startCrb,
}) => {
	await page.setViewportSize({ width: 360, height: 740 });
	await pr(fixture);
	const s = await startCrb();
	const section = await openFile(page, s.url, GREET);
	await selectText(page, GREET, 3, 16, 27);
	await expect(bar(page)).toBeVisible();
	const wide = () =>
		page.evaluate(
			() =>
				document.documentElement.scrollWidth -
				document.documentElement.clientWidth,
		);
	expect(await wide()).toBeLessThanOrEqual(0);
	const b = await bar(page)
		.getByRole("button", { name: "Comment" })
		.boundingBox();
	expect(b?.width ?? 0).toBeGreaterThanOrEqual(40);
	expect(b?.height ?? 0).toBeGreaterThanOrEqual(40);
	await bar(page).getByRole("button", { name: "Comment" }).click();
	await expect(section.getByTestId("new-thread")).toBeVisible();
	await section
		.getByRole("textbox", { name: "Comment" })
		.fill("x ".repeat(200));
	await selectText(page, GREET, 12, 0, 3);
	await expect(bar(page)).toBeVisible();
	expect(await wide()).toBeLessThanOrEqual(0);
});

/** The viewport point at column `col` of new line `n`'s text. */
async function charPoint(page: Page, path: string, n: number, col: number) {
	return page.evaluate(
		({ path, n, col }) => {
			const code = document.querySelector(
				`[data-path="${path}"] tr[data-new-no="${n}"] > [data-code-cell][data-side="RIGHT"] [data-code]`,
			);
			if (!code) throw new Error("no line");
			const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
			let left = col;
			for (let t = walker.nextNode(); t; t = walker.nextNode()) {
				const len = (t as Text).data.length;
				if (left < len) {
					const r = document.createRange();
					r.setStart(t, left);
					r.setEnd(t, left + 1);
					const box = r.getBoundingClientRect();
					return { x: box.left + 1, y: box.top + box.height / 2 };
				}
				left -= len;
			}
			throw new Error("past the line");
		},
		{ path, n, col },
	);
}

test("a real mouse drag over the code comments on exactly what was dragged over", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "a mouse drag");
	await pr(fixture);
	const s = await startCrb();
	const section = await openFile(page, s.url, GREET);
	const from = await charPoint(page, GREET, 3, 16);
	// The left half of the character after the span's end.
	const to = await charPoint(page, GREET, 3, 27);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x - 1, to.y, { steps: 8 });
	await page.mouse.up();
	await expect(bar(page)).toBeVisible();
	const selected = await page.evaluate(() =>
		document.getSelection()?.toString(),
	);
	expect(selected).toBe("name.trim()");
	// Tab goes to the bar first, the selection kept.
	await page.keyboard.press("Tab");
	await expect(
		bar(page).getByRole("button", { name: "Comment" }),
	).toBeFocused();
	expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(
		selected,
	);
	await page.keyboard.press("Enter");
	await expect(section.getByTestId("new-thread-quote")).toHaveText(
		"name.trim()",
	);
	await expect(section.getByTestId("new-thread")).toContainText("line 3, new");
});

test("a triple click picks the whole line: no columns", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "a mouse triple click");
	await pr(fixture);
	const s = await startCrb();
	const section = await openFile(page, s.url, GREET);
	const p = await charPoint(page, GREET, 11, 2);
	await page.mouse.click(p.x, p.y, { clickCount: 3 });
	await expect(bar(page)).toBeVisible();
	await bar(page).getByRole("button", { name: "Comment" }).click();
	const composer = section.getByTestId("new-thread");
	await expect(composer).toContainText("line 11, new");
	// Whole lines: the quote is the line, not painted as a span.
	await expect(composer.getByTestId("new-thread-quote")).toHaveText("new b");
	await expect(section.locator("[data-span-mark]")).toHaveCount(0);
});
