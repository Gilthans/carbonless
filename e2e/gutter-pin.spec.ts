import type { Locator } from "@playwright/test";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import {
	expectNoPageOverflow,
	fileSection,
	openFiles,
	setSwitch,
	sideBySide,
	tapHeight,
	tapWidth,
} from "./files-ui";
import { expect, type Pr, type PrOptions, test } from "./fixtures";

/**
 * A long line makes the diff scroll sideways. Only the code scrolls: the
 * cluster's rail, its controls and both line numbers stay at the scroller's
 * left edge, in every kind of row, opaque, and still pick lines there.
 */

/** DESIGN_SHOTS=<dir>: also save gutter-{chromium,phone}-*.png there. */
const shots = process.env.DESIGN_SHOTS;

const text = (lines: string[]) => `${lines.join("\n")}\n`;
const WIDE = "src/wide.ts";
// Renamed in the PR: a file cluster's label row above its hunk.
const WIDE_WAS = "src/old-wide.ts";
const lines = Array.from({ length: 14 }, (_, i) =>
	i === 4 ? `const wide5 = "${"wide ".repeat(80)}";` : `wide ${i + 1}`,
);
const SHORT = "src/short.ts";
const short = Array.from({ length: 8 }, (_, i) => `short ${i + 1}`);
const fixture: PrOptions = {
	base: { [WIDE_WAS]: text(lines), [SHORT]: text(short) },
	files: [
		{
			message: "PR change",
			rename: { [WIDE_WAS]: WIDE },
			files: {
				[WIDE]: text(lines.map((l, i) => (i === 2 ? "wide 3 changed" : l))),
				[SHORT]: text(short.map((l, i) => (i === 3 ? "short 4 changed" : l))),
			},
		},
	],
};

/** The fixture's PR with one thread on new line 4 of the wide file, on the head. */
async function setup(pr: (opts?: PrOptions) => Promise<Pr>) {
	const p = await pr(fixture);
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((s) => {
		const graph = s.prs[p.number]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: WIDE, line: 4, subjectType: "LINE" }, [
				threadComment({
					login: "ann",
					text: "Why four?",
					commit: head,
					diffHunk: "",
				}),
			]),
		];
	});
	return p;
}

/** The open file's diff scroller (not its path scroller). */
const diffScroller = (section: Locator) =>
	section.locator("div.overflow-x-auto:has(table)");

const x = async (l: Locator) => {
	const b = await l.boundingBox();
	if (!b) throw new Error("not rendered");
	return b.x;
};

/** Every cell's x, in table order, by the names given. */
async function xs(cells: Record<string, Locator>) {
	const out: Record<string, number> = {};
	for (const [name, cell] of Object.entries(cells)) out[name] = await x(cell);
	return out;
}

/** The row's cells start where the one before ends: no gap, no overlap. */
async function expectAdjacent(row: Locator) {
	const gaps = await row.evaluate((tr) => {
		const rects = [...tr.children].map((td) => td.getBoundingClientRect());
		return rects.slice(1).map((r, i) => r.left - (rects[i]?.right ?? 0));
	});
	for (const gap of gaps) expect(Math.abs(gap)).toBeLessThan(0.5);
}

const expectOpaque = async (cell: Locator, name: string) => {
	const bg = await cell.evaluate((el) => getComputedStyle(el).backgroundColor);
	expect(bg, name).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
};

test("line numbers and the gutter stay put while the code scrolls sideways", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, WIDE);
	await section.getByRole("button", { name: "Expand file" }).click();
	const line = (n: number) =>
		section.locator(`tr[data-testid="diff-line"][data-new-no="${n}"]`);
	const context = line(4);
	const added = section.locator('tr[data-testid="diff-line"][data-kind="add"]');
	await expect(added).toHaveCount(1);
	// The added line's row is the cluster's first: it holds the checkbox.
	const cellsOf = (row: Locator) => ({
		rail: row.locator("td").first(),
		controls: row.locator("td").nth(1),
		old: row.getByTestId("old"),
		new: row.getByTestId("new"),
	});
	const rows = { context: cellsOf(context), added: cellsOf(added) };
	const code = {
		context: context.getByTestId("code"),
		added: added.getByTestId("code"),
	};
	// The file cluster's label row: rail, controls, then the label's cell.
	const clusterRow = section.locator("tbody.group > tr").first();
	const cluster = {
		rail: clusterRow.locator("td").first(),
		controls: clusterRow.locator("td").nth(1),
	};
	await expect(clusterRow).toContainText(`Renamed from ${WIDE_WAS}`);
	// A row's words stay in view too: the label, the hunk header, a gap's count.
	const words = {
		label: clusterRow.getByText(`Renamed from ${WIDE_WAS}`),
		hunk: section.getByTestId("hunk-header").getByText(/^@@ /),
		gap: section.getByTestId("gap-row").getByText(/hidden lines$/),
	};
	const before = {
		context: await xs(rows.context),
		added: await xs(rows.added),
		cluster: await xs(cluster),
		words: await xs(words),
		code: await xs(code),
	};
	const scroller = diffScroller(section);
	const width = await scroller.evaluate((el) => el.clientWidth);
	// Unscrolled, nothing moved: the cells lie in table order, each starting
	// where the one before it ends.
	await expectAdjacent(context);
	await expectAdjacent(added);
	await expectAdjacent(clusterRow);

	await scroller.evaluate((el) => {
		el.scrollLeft = 120;
	});
	await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(120);
	const after = {
		context: await xs(rows.context),
		added: await xs(rows.added),
		cluster: await xs(cluster),
		words: await xs(words),
		code: await xs(code),
	};
	// The code moved, the leading cells did not.
	for (const k of ["context", "added"] as const) {
		expect(after.code[k], `${k} code`).toBeCloseTo(
			(before.code[k] ?? Number.NaN) - 120,
			0,
		);
		expect(after[k], k).toEqual(before[k]);
	}
	expect(after.cluster).toEqual(before.cluster);
	expect(after.words).toEqual(before.words);
	// Opaque: the row's own tint, never the code showing through.
	for (const [k, r] of Object.entries(rows)) {
		for (const [name, cell] of Object.entries(r)) {
			await expectOpaque(cell, `${k} ${name}`);
		}
	}
	await expectOpaque(cluster.controls, "cluster controls");
	// What's on top at each pinned cell is the cell (or, over a controls
	// cell on touch, the cluster's stacked controls reaching down from its
	// first row), never the code under it.
	for (const [k, r] of Object.entries(rows)) {
		for (const [name, cell] of Object.entries(r)) {
			const covered = await cell.evaluate((el) => {
				const b = el.getBoundingClientRect();
				const hit = document.elementFromPoint(
					b.left + b.width / 2,
					b.top + b.height / 2,
				);
				if (!hit) return false;
				return (
					el.contains(hit) ||
					((el as HTMLTableCellElement).cellIndex === 1 &&
						hit.closest("[data-sticky-controls]") !== null)
				);
			});
			expect(covered, `${k} ${name} on top`).toBe(true);
		}
	}

	// Picking by number works where the number is pinned.
	if (isMobile) await rows.context.new.tap();
	else await rows.context.new.click();
	await expect(context).toHaveAttribute("data-picked", "true");
	await expect(section.locator("tr[data-picked]")).toHaveCount(1);
	expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(120);
	await page.keyboard.press("Escape");
	await expect(section.locator("tr[data-picked]")).toHaveCount(0);

	// The checkbox still marks the cluster from its pinned cell (on the
	// cluster's first row, the deleted line; the file cluster's is above).
	const checkbox = section
		.locator('tr[data-testid="diff-line"]')
		.getByRole("checkbox", { name: "Mark cluster reviewed" });
	await checkbox.click();
	await expect(checkbox).toBeChecked();
	await expect(added).toHaveAttribute("data-reviewed", "true");
	expect(await xs(rows.added)).toEqual(before.added);
	await expectOpaque(rows.added.old, "reviewed old");
	await checkbox.click();
	await expect(checkbox).not.toBeChecked();

	// An opened thread's row stays in view at the scroller's width, as before.
	await context.getByRole("button", { name: /1 comment on line 4/ }).click();
	const card = section.getByTestId("thread-row").locator("div.sticky");
	await expect(card).toBeVisible();
	const cardBox = await card.boundingBox();
	const scrollerBox = await scroller.boundingBox();
	if (!cardBox || !scrollerBox) throw new Error("not rendered");
	expect(cardBox.x).toBeCloseTo(scrollerBox.x, 0);
	expect(cardBox.width).toBeLessThanOrEqual(width);
	expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(120);
	expect(await xs(rows.context)).toEqual(before.context);

	// A file that doesn't scroll lays its cells out as before: no gap.
	const other = fileSection(page, SHORT);
	await other.getByRole("button", { name: "Expand file" }).click();
	const otherRow = other.locator(
		'tr[data-testid="diff-line"][data-kind="add"]',
	);
	await expect(otherRow).toHaveCount(1);
	expect(
		await diffScroller(other).evaluate(
			(el) => el.scrollWidth <= el.clientWidth,
		),
	).toBe(true);
	await expectAdjacent(otherRow);
	await expectAdjacent(other.locator("tbody.group > tr").first());
});

/** A cell's width and left padding, in px. */
const metrics = (cell: Locator) =>
	cell.evaluate((el) => {
		const css = getComputedStyle(el);
		return {
			width: el.getBoundingClientRect().width,
			pad: Number.parseFloat(css.paddingLeft),
		};
	});

test("a narrow diff (the tree dragged wide) tightens the leading columns; with room they stay roomy", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "a phone is cramped by itself (the next test)");
	await setup(pr);
	const s = await startCrb();
	const cells = async () => {
		const section = fileSection(page, WIDE);
		await section.getByRole("button", { name: "Expand file" }).click();
		const row = section.locator('tr[data-testid="diff-line"][data-new-no="4"]');
		await expect(row).toBeVisible();
		return {
			section,
			row,
			controls: row.locator("td").nth(1),
			old: row.getByTestId("old"),
			new: row.getByTestId("new"),
			sign: row.getByTestId("code").locator("> span[aria-hidden]").first(),
		};
	};
	// With room (the default tree width): the roomy layout.
	await openFiles(page, s.url);
	const roomy = await cells();
	expect(await metrics(roomy.controls)).toEqual({ width: 44, pad: 4 });
	const roomyNumber = await metrics(roomy.old);
	expect(roomyNumber.pad).toBe(8);
	expect(await metrics(roomy.new)).toEqual(roomyNumber);
	expect(
		await roomy.sign.evaluate((el) => getComputedStyle(el).marginRight),
	).toBe("8px");
	expect(
		await roomy.section.locator("table").getAttribute("data-tight"),
	).toBeNull();

	// The tree dragged wide: the diff's box is narrow, so the columns tighten.
	await page.evaluate(() => localStorage.setItem("crb.files.treeWidth", "700"));
	await page.reload();
	await expect(fileSection(page, WIDE)).toBeVisible();
	const tight = await cells();
	const scroller = diffScroller(tight.section);
	expect(await scroller.evaluate((el) => el.clientWidth)).toBeLessThan(640);
	await expect(tight.section.locator("table")).toHaveAttribute(
		"data-tight",
		"true",
	);
	expect(await metrics(tight.controls)).toEqual({ width: 38, pad: 2 });
	const tightNumber = await metrics(tight.old);
	expect(tightNumber.pad).toBe(4);
	expect(tightNumber.width).toBeCloseTo(roomyNumber.width - 8, 0);
	expect(await metrics(tight.new)).toEqual(tightNumber);
	expect(
		await tight.sign.evaluate((el) => getComputedStyle(el).marginRight),
	).toBe("4px");
	// Pinned at the new sums: nothing moves but the code.
	const pinned = {
		rail: tight.row.locator("td").first(),
		controls: tight.controls,
		old: tight.old,
		new: tight.new,
	};
	await expectAdjacent(tight.row);
	const before = await xs(pinned);
	const codeBefore = await x(tight.row.getByTestId("code"));
	await scroller.evaluate((el) => {
		el.scrollLeft = 120;
	});
	await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(120);
	expect(await xs(pinned)).toEqual(before);
	expect(await x(tight.row.getByTestId("code"))).toBeCloseTo(
		codeBefore - 120,
		0,
	);
});

test("a phone is cramped: a narrow pinned block whose controls and numbers still take a tap while scrolled", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "touch targets");
	await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, WIDE);
	await section.getByRole("button", { name: "Expand file" }).click();
	const row = section.locator('tr[data-testid="diff-line"][data-new-no="4"]');
	await expect(row).toBeVisible();
	await expect(section.locator("table")).toHaveAttribute("data-tight", "true");
	// Rail, controls and both numbers of a 3-digit file: well under 120px.
	const rail = await row.locator("td").first().boundingBox();
	const last = await row.getByTestId("new").boundingBox();
	if (!rail || !last) throw new Error("not rendered");
	expect(last.x + last.width - rail.x).toBeLessThan(120);
	// The numbers together are the pick's target, 40px wide at least.
	const old = await row.getByTestId("old").boundingBox();
	if (!old) throw new Error("not rendered");
	expect(last.x + last.width - old.x).toBeGreaterThanOrEqual(40);

	const scroller = diffScroller(section);
	await scroller.evaluate((el) => {
		el.scrollLeft = 120;
	});
	await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(120);
	// The two controls' 40px targets, by what a tap would hit.
	// On the cluster's first row, the deleted line (the file cluster above
	// has its own).
	const lines = section.locator('tr[data-testid="diff-line"]');
	const boxTarget = lines.getByTestId("cluster-box-target");
	const cross = lines.getByRole("button", { name: "Cross off cluster" });
	for (const target of [boxTarget, cross]) {
		expect(await tapWidth(target)).toBeGreaterThanOrEqual(40);
		expect(await tapHeight(target)).toBeGreaterThanOrEqual(40);
	}
	const b = await boxTarget.boundingBox();
	if (!b) throw new Error("not rendered");
	await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
	await expect(
		lines.getByRole("checkbox", { name: "Mark cluster reviewed" }),
	).toBeChecked();
	// A tap on either number picks the line.
	await row.getByTestId("old").tap();
	await expect(row).toHaveAttribute("data-picked", "true");
	await page.keyboard.press("Escape");
	await expect(section.locator("tr[data-picked]")).toHaveCount(0);
	await row.getByTestId("new").tap();
	await expect(row).toHaveAttribute("data-picked", "true");
	expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(120);
	await expectNoPageOverflow(page);
});

/**
 * The code cell's own furniture scrolls under the pinned cells like its
 * text: a pair's word marks, and the ⚠ of a change that only shows with
 * hidden characters (a positioned button with a 40px touch target) never
 * paint over a pinned number or take its tap. A gap's stacked arrows keep
 * the controls column's width.
 */
const MARKS = "src/marks.ts";
const tail = "mark ".repeat(80);
const marksBase = Array.from({ length: 60 }, (_, i) =>
	i === 4 || i === 44 ? `const w${i + 1} = "${tail}";` : `mark ${i + 1}`,
);
const marksFixture: PrOptions = {
	base: { [MARKS]: text(marksBase) },
	files: [
		{
			message: "Marks",
			files: {
				[MARKS]: text(
					marksBase.map((l, i) =>
						i === 4
							? `const v5 = "${tail}";`
							: // A byte order mark: a change nothing shows.
								i === 44
								? `const w\uFEFF45 = "${tail}";`
								: l,
					),
				),
			},
		},
	],
};

test("word marks and a hidden change's ⚠ scroll under the pinned cells; a gap's arrows keep the column", async ({
	page,
	pr,
	startCrb,
	isMobile,
}, testInfo) => {
	await pr(marksFixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, MARKS);
	await section.getByRole("button", { name: "Expand file" }).click();
	// Hidden characters off: the BOM draws nothing, its line warns.
	await setSwitch(page, "Show hidden characters", false);
	await page.keyboard.press("Escape");
	const shot = async (name: string) => {
		if (shots) {
			await section.screenshot({
				path: `${shots}/gutter-${testInfo.project.name}-${name}.png`,
			});
		}
	};
	const marked = section.locator(
		'tr[data-testid="diff-line"][data-kind="add"][data-new-no="5"]',
	);
	await expect(marked.locator("[data-word]")).not.toHaveCount(0);
	const warned = section.locator(
		'tr[data-testid="diff-line"][data-kind="add"][data-new-no="45"]',
	);
	const warning = warned.locator("[data-hidden-change]");
	await expect(warning).toBeVisible();
	// The gaps: their arrows (stacked where there are two or three) in the
	// rail and controls, the columns after them start where every line's do.
	const lineNumberX = await x(marked.getByTestId("old"));
	const gaps = await section.getByTestId("gap-row").evaluateAll((rows) =>
		rows.map((tr) => ({
			arrows: tr.querySelectorAll("button[data-glyph]").length,
			end: tr.children[0]?.getBoundingClientRect().right ?? Number.NaN,
		})),
	);
	expect(Math.max(...gaps.map((g) => g.arrows))).toBeGreaterThan(1);
	for (const g of gaps) expect(g.end).toBeCloseTo(lineNumberX, 0);
	await shot("unscrolled");

	// Scroll the ⚠ right under the new number's centre.
	const scroller = diffScroller(section);
	const number = warned.getByTestId("new");
	const centre = async (l: Locator) => {
		const b = await l.boundingBox();
		if (!b) throw new Error("not rendered");
		return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	};
	const by = Math.round((await centre(warning)).x - (await centre(number)).x);
	await scroller.evaluate((el, left) => {
		el.scrollLeft = left;
	}, by);
	await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(by);
	await shot("scrolled");
	// Clear of what floats at the viewport's bottom (the diff's own
	// scrollbar, the phone's Files button) and of the sticky header.
	await warned.evaluate((el) => el.scrollIntoView({ block: "center" }));
	// What's on top at the number, all across it, is the number: else what
	// is, named.
	const over = await number.evaluate((el) => {
		const b = el.getBoundingClientRect();
		const y = b.top + b.height / 2;
		const out: string[] = [];
		for (let at = b.left + 1; at < b.right - 1; at += 2) {
			const hit = document.elementFromPoint(at, y);
			if (hit === null || !el.contains(hit)) {
				out.push(
					`${Math.round(at)}: ${hit?.tagName ?? "nothing"} ${hit?.getAttribute("data-testid") ?? ""} ${hit?.className ?? ""}`,
				);
			}
		}
		return out;
	});
	expect(over, "the number, not the ⚠, on top").toEqual([]);
	for (const row of [marked, warned]) {
		for (const cell of [row.getByTestId("old"), row.getByTestId("new")]) {
			const covered = await cell.evaluate((el) => {
				const b = el.getBoundingClientRect();
				const hit = document.elementFromPoint(
					b.left + b.width / 2,
					b.top + b.height / 2,
				);
				return hit !== null && el.contains(hit);
			});
			expect(covered).toBe(true);
		}
	}
	// A tap or click on the number picks the line; hidden characters stay off.
	if (isMobile) await number.tap();
	else await number.click();
	await expect(warned).toHaveAttribute("data-picked", "true");
	await expect(warning).toBeVisible();
	await page.keyboard.press("Escape");
	await expectNoPageOverflow(page);

	// Focused while under the numbers (in the scroller's box, so the
	// browser wouldn't scroll, but behind the pinned cells), the ⚠ scrolls
	// out from under them, not left hidden there.
	await scroller.evaluate((el, left) => {
		el.scrollLeft = left;
	}, by);
	await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(by);
	await warning.evaluate((el) => (el as HTMLElement).focus());
	await expect
		.poll(async () => {
			const w = await warning.boundingBox();
			const n = await number.boundingBox();
			return w && n ? Math.round(w.x - (n.x + n.width)) : Number.NaN;
		})
		.toBeGreaterThanOrEqual(0);

	// Side by side, for the eyes (DESIGN_SHOTS).
	if (shots) {
		await sideBySide(page, true);
		await page.keyboard.press("Escape");
		await expect(
			section.locator('table[data-view="side-by-side"]'),
		).toBeVisible();
		await shot("side-by-side");
		await sideBySide(page, false);
	}
});

/**
 * On touch a cluster's cross-off is stacked under its box, reaching into
 * the rows below its line: never over an opened thread's card there.
 */
test("a touch cluster's cross-off never covers the thread card under its line", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "the stacked controls are touch only");
	const p = await pr(fixture);
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((sc) => {
		const graph = sc.prs[p.number]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			// On the deleted line: the cluster's first row, where its controls are.
			reviewThread(
				{ path: WIDE, line: 3, diffSide: "LEFT", subjectType: "LINE" },
				[
					threadComment({
						login: "ann",
						text: "Why three?",
						commit: head,
						diffHunk: "",
					}),
				],
			),
		];
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, WIDE);
	await section.getByRole("button", { name: "Expand file" }).click();
	const first = section.locator(
		'tr[data-testid="diff-line"][data-kind="del"][data-old-no="3"]',
	);
	await expect(first.getByTestId("cluster-box-target")).toBeVisible();
	await first.getByRole("button", { name: /1 comment on/ }).tap();
	const card = section.getByTestId("thread-row");
	await expect(card).toBeVisible();
	// The cross-off reaches into the card's rows...
	const cross = await first
		.getByRole("button", { name: "Cross off cluster" })
		.boundingBox();
	const box = await card.boundingBox();
	if (!cross || !box) throw new Error("not rendered");
	expect(cross.y + cross.height).toBeGreaterThan(box.y);
	// ...but where they meet, the card is on top.
	const under = await card.evaluate(
		(el, c) => {
			const out: string[] = [];
			const top = el.getBoundingClientRect().top;
			for (let y = top + 1; y < c.y + c.height; y += 4) {
				for (let x = c.x + 2; x < c.x + c.width; x += 6) {
					const hit = document.elementFromPoint(x, y);
					if (!hit || !el.contains(hit)) {
						out.push(`${x},${y}: ${hit?.tagName ?? "nothing"}`);
					}
				}
			}
			return out;
		},
		{ x: cross.x, y: cross.y, width: cross.width, height: cross.height },
	);
	expect(under).toEqual([]);
});

/**
 * Side by side on a phone, the bubbles get rows of their own: while a
 * cluster's controls float over its lines, those rows pass under them.
 */
const MANY = "src/many.ts";
const manyFixture: PrOptions = {
	base: { [MANY]: text(["many 0"]) },
	files: [
		{
			message: "Many",
			files: {
				[MANY]: text([
					"many 0",
					...Array.from({ length: 40 }, (_, i) => `many ${i + 1}`),
				]),
			},
		},
	],
};

test("side by side on a phone, the floating cluster controls stay above the bubble rows", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "bubble rows are a phone's");
	const p = await pr(manyFixture);
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((sc) => {
		const graph = sc.prs[p.number]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		// A thread on every added line: a bubble row under each.
		graph.reviewThreads = Array.from({ length: 40 }, (_, i) =>
			reviewThread({ path: MANY, line: i + 2, subjectType: "LINE" }, [
				threadComment({
					login: "ann",
					text: `Line ${i + 2}?`,
					commit: head,
					diffHunk: "",
				}),
			]),
		);
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	await sideBySide(page, true);
	await page.keyboard.press("Escape");
	const section = fileSection(page, MANY);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.getByTestId("bubble-row")).toHaveCount(40);
	// The cluster's first line scrolled under the header: its controls float.
	await section
		.locator('tr[data-testid="diff-line"][data-new-no="20"]')
		.evaluate((el) => el.scrollIntoView({ block: "start" }));
	const controls = section.locator("[data-sticky-controls][data-stuck]");
	await expect(controls).toHaveAttribute("data-stuck", "fixed");
	const c = await controls.boundingBox();
	if (!c) throw new Error("not rendered");
	// A bubble row passes under them...
	const rows = await section.getByTestId("bubble-row").evaluateAll((trs) =>
		trs.map((tr) => {
			const r = tr.getBoundingClientRect();
			return { top: r.top, bottom: r.bottom };
		}),
	);
	expect(rows.some((r) => r.top < c.y + c.height && r.bottom > c.y)).toBe(true);
	// ...and all over the floating box, the controls are on top.
	const off = await controls.evaluate((el) => {
		const r = el.getBoundingClientRect();
		const out: string[] = [];
		for (let y = r.top + 2; y < r.bottom - 1; y += 4) {
			for (let x = r.left + 2; x < r.right - 1; x += 6) {
				const hit = document.elementFromPoint(x, y);
				if (!hit || !el.contains(hit)) {
					out.push(`${x},${y}: ${hit?.tagName ?? "nothing"}`);
				}
			}
		}
		return out;
	});
	expect(off).toEqual([]);
});
