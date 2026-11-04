import type { Locator } from "@playwright/test";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import { fileSection, openFiles } from "./files-ui";
import { expect, type Pr, type PrOptions, test } from "./fixtures";

/**
 * A long line makes the diff scroll sideways. Only the code scrolls: the
 * cluster's rail, its controls and both line numbers stay at the scroller's
 * left edge, in every kind of row, opaque, and still pick lines there.
 */

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
		const graph = s.prs[7]?.graphql;
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
	// What's on top at each pinned cell is the cell, not the code under it.
	for (const [k, r] of Object.entries(rows)) {
		for (const [name, cell] of Object.entries(r)) {
			const covered = await cell.evaluate((el) => {
				const b = el.getBoundingClientRect();
				const hit = document.elementFromPoint(
					b.left + b.width / 2,
					b.top + b.height / 2,
				);
				return hit !== null && el.contains(hit);
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
