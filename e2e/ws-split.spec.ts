import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { buildSnapshot } from "../src/server/diff/snapshot";
import { RefStore } from "../src/server/review/refStore";
import { ReviewService } from "../src/server/review/reviews";
import type { Cluster, Snapshot } from "../src/shared/types";
import { homePr } from "../test/fake-gh/scenario";
import {
	expectNoPageOverflow,
	fileSection,
	ignoreWhitespace,
	marksReady,
	openFiles,
	progress,
	sideBySide,
	withTree,
} from "./files-ui";
import {
	type Crb,
	expect,
	OWNER_REPO,
	PR_NUMBER,
	type Pr,
	type PrOptions,
	reviewPage,
	test,
} from "./fixtures";

/**
 * CAR-156: one git hunk of a change (lines 4-5), a whitespace-only change
 * (6-7, re-indented) and a change (8-9) is three clusters, the middle one
 * whitespace-only, in every view.
 */
const PATH = "src/split.ts";
const lines = Array.from({ length: 12 }, (_, i) => `split ${i + 1}`);
const text = (l: string[]) => `${l.join("\n")}\n`;
const fixture: PrOptions = {
	base: { [PATH]: text(lines) },
	files: [
		{
			message: "Change, re-indent, change",
			files: {
				[PATH]: text(
					lines.map((l, i) =>
						i === 3 || i === 4 || i === 7 || i === 8
							? `${l} changed`
							: i === 5 || i === 6
								? `    ${l}`
								: l,
					),
				),
			},
		},
	],
};

const boxes = (section: Locator) =>
	section.getByRole("checkbox", { name: /cluster reviewed$/ });

async function expand(page: Page) {
	const section = fileSection(page, PATH);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.locator("table")).toBeVisible();
	return section;
}

const LEFT_OUT = "1 whitespace-only cluster not counted";
/** The `~` beside the Files page's bar. */
const leftOut = (page: Page) =>
	page
		.locator("[data-page-bar]")
		.locator(`[data-testid="ws-left-out"][aria-label="${LEFT_OUT}"]`);
/** Any `~` on the page (the Overview has only its own). */
const anyLeftOut = (page: Page) => page.getByRole("img", { name: LEFT_OUT });

test("change / whitespace-only / change in one hunk is three clusters; Ignore whitespace leaves the middle one out of progress, and counts it again when off", async ({
	page,
	pr,
	startCrb,
}) => {
	// Both views, the switch twice and the Overview: past the default budget on a loaded machine.
	test.slow();
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const bar = progress(page);
	await expect(bar).toContainText("0 / 3 clusters reviewed");
	await expect(leftOut(page)).toHaveCount(0);

	// Three clusters, three boxes, in both views.
	const section = await expand(page);
	await expect(boxes(section)).toHaveCount(3);
	await sideBySide(page, true);
	await expect(boxes(section)).toHaveCount(3);
	await sideBySide(page, false);
	await expect(boxes(section)).toHaveCount(3);

	// On: the middle one is a quiet `~` row with its own box, and not counted.
	const barHeight = async () =>
		(await page.locator("[data-page-bar]").boundingBox())?.height ?? 0;
	const tall = await barHeight();
	await ignoreWhitespace(page, true);
	const ws = section.getByTestId("ws-cluster");
	await expect(ws).toHaveCount(1);
	await expect(ws).toContainText("Whitespace only · 4 lines");
	await expect(boxes(section)).toHaveCount(3);
	await expect(bar).toContainText("0 / 2 clusters reviewed");
	await expect(leftOut(page)).toBeVisible();
	await expect(leftOut(page)).toHaveText("~");
	// The `~` never grows the bar (a taller bar would move the rows being read).
	expect(await barHeight()).toBe(tall);
	// Side by side too.
	await sideBySide(page, true);
	await expect(ws).toHaveCount(1);
	await expect(boxes(section)).toHaveCount(3);
	await sideBySide(page, false);

	// Ticking the two changes reaches 100%: the file is done and closes.
	await boxes(section).first().click();
	await expect(bar).toContainText("1 / 2 clusters reviewed");
	await boxes(section).last().click();
	await expect(bar).toContainText("100%");
	await expect(bar).toContainText("2 / 2 clusters reviewed");
	await expect(leftOut(page)).toBeVisible();
	await expect(section.locator("header")).toHaveAttribute("data-finished");

	// Off: the middle one counts again, unreviewed, and shows unticked.
	await ignoreWhitespace(page, false);
	await expect(bar).toContainText("2 / 3 clusters reviewed");
	await expect(leftOut(page)).toHaveCount(0);
	await expect(section.locator("header")).not.toHaveAttribute("data-finished");
	if ((await section.locator("table").count()) === 0) await expand(page);
	await expect(boxes(section).nth(0)).toBeChecked();
	await expect(boxes(section).nth(1)).not.toBeChecked();
	await expect(boxes(section).nth(2)).toBeChecked();

	// The Overview's progress follows the switch too, with the same `~`.
	await page.goto(reviewPage(s.url, ""));
	const files = page.getByRole("link", { name: /Review files/ });
	await expect(files).toContainText("2 / 3 clusters");
	await expect(anyLeftOut(page)).toHaveCount(0);
	await ignoreWhitespace(page, true);
	await expect(files).toContainText("2 / 2 clusters · 100%");
	await expect(anyLeftOut(page)).toBeVisible();
});

test.describe("a review started before the split", () => {
	test.use({ crbServer: "own" });

	test("keeps its mark on the whole hunk: all three pieces open reviewed", async ({
		page,
		pr,
		startCrb,
	}) => {
		// Two crb servers and a review written in between: past the default budget on a loaded machine.
		test.slow();
		const p = await pr(fixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		await expect(progress(page)).toContainText("0 / 3 clusters reviewed");
		await page.goto("about:blank");
		await s.stop();

		// The hunk reviewed as one cluster, under its key from before the
		// split, as an older crb wrote it.
		const clone = s.cloneOf(p.ownerRepo);
		const snap = await buildSnapshot(clone, p.mergeBase, p.head());
		const file = snap.files.find((f) => f.path === PATH);
		const pieces = file?.clusters ?? [];
		expect(pieces.map((c) => c.whitespaceOnly === true)).toEqual([
			false,
			true,
			false,
		]);
		const [first] = pieces;
		const whole: Cluster = {
			key: first?.split?.key as string,
			kind: "lines",
			oldStart: first?.oldStart as number,
			oldCount: pieces.reduce((n, c) => n + c.oldCount, 0),
			newStart: first?.newStart as number,
			newCount: pieces.reduce((n, c) => n + c.newCount, 0),
			removed: pieces.flatMap((c) => c.removed),
			added: pieces.flatMap((c) => c.added),
			lines: pieces.reduce((n, c) => n + c.lines, 0),
		};
		const before: Snapshot = {
			...snap,
			files: snap.files.map((f) =>
				f === file ? { ...f, clusters: [whole] } : f,
			),
		};
		const id = new URL(s.url).pathname.split("/").filter(Boolean).at(-1);
		await new ReviewService(new RefStore(clone)).recordStates(
			id as string,
			"octo-cat",
			before,
			[{ key: whole.key, state: "reviewed" }],
		);

		const again = await startCrb();
		await openFiles(page, again.url);
		await expect(progress(page)).toContainText("3 / 3 clusters reviewed");
		const section = await expand(page);
		await expect(boxes(section)).toHaveCount(3);
		for (let i = 0; i < 3; i++)
			await expect(boxes(section).nth(i)).toBeChecked();
	});
});

/*
 * CAR-184: the verdict, the since view, file rows and file headers follow
 * the switch, with the same `~`; Home doesn't (it never reads a review's
 * view settings).
 */

/** The split file beside a file of one plain change (no whitespace-only cluster). */
const PLAIN = "src/plain.ts";
const plainLines = Array.from({ length: 6 }, (_, i) => `plain ${i + 1}`);
const twoFiles: PrOptions = {
	base: { ...fixture.base, [PLAIN]: text(plainLines) },
	files: [
		{
			message: "Change, re-indent, change; and a plain change",
			files: {
				...fixture.files?.[0]?.files,
				[PLAIN]: text(plainLines.map((l, i) => (i === 2 ? `${l} changed` : l))),
			},
		},
	],
};

const header = (section: Locator) => section.locator("header");
/** The `src` folder's own row (its first button: the files' rows follow). */
const folderRow = (tree: Locator) =>
	tree.locator('[data-folder-group="src"]').getByRole("button").first();

/**
 * The header's `~` slot overlaps none of the header's controls (its 40px
 * touch target lies within it), and on a phone it is that 40px wide.
 */
async function tildeClear(head: Locator, isMobile: boolean) {
	const slot = head.getByTestId("ws-left-out-slot");
	const box = await slot.boundingBox();
	if (isMobile) expect(box?.width).toBeGreaterThanOrEqual(40);
	const overlaps = await head.evaluate((h) => {
		const at = h.querySelector('[data-testid="ws-left-out-slot"]');
		if (!at) return ["no slot"];
		const a = at.getBoundingClientRect();
		return [...h.querySelectorAll('button, [role="progressbar"]')]
			.filter((el) => {
				const b = el.getBoundingClientRect();
				return (
					a.left < b.right &&
					b.left < a.right &&
					a.top < b.bottom &&
					b.top < a.bottom
				);
			})
			.map((el) => el.getAttribute("aria-label") ?? el.textContent ?? "");
	});
	expect(overlaps).toEqual([]);
}
/** A file's tree row. */
const rowOf = (tree: Locator, name: RegExp) =>
	tree.getByRole("button", { name });

test("Ignore whitespace on: the file row reads done, the header and verdict with a `~`; off counts the whitespace-only cluster again; a plain file never shows one", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	// Two files marked, three pages and two switch flips: past the default budget on a loaded machine.
	test.slow();
	await pr(twoFiles);
	const s = await startCrb();
	await openFiles(page, s.url);
	await ignoreWhitespace(page, true);

	// Tick the two changes: the split file reads done, with its `~`.
	const section = await expand(page);
	await boxes(section).first().click();
	await expect(boxes(section).first()).toBeChecked();
	await boxes(section).last().click();
	await expect(header(section)).toHaveAttribute("data-finished");
	await expect(
		header(section).getByRole("img", { name: LEFT_OUT }),
	).toBeVisible();
	await tildeClear(header(section), isMobile);
	if (isMobile) await expectNoPageOverflow(page);
	// The move-on opened the plain file: tick it too.
	const plain = fileSection(page, PLAIN);
	await expect(plain.locator("table")).toBeVisible();
	await marksReady(page, plain);
	await boxes(plain).first().click();
	await expect(header(plain)).toHaveAttribute("data-finished");
	await expect(header(plain).getByRole("img", { name: LEFT_OUT })).toHaveCount(
		0,
	);
	await expect(progress(page)).toContainText("3 / 3 clusters reviewed");
	await expect(leftOut(page)).toBeVisible();
	await withTree(page, async (tree) => {
		const split = rowOf(tree, /split\.ts/);
		// Its row counts as the header does, done; the `~` is the header's
		// alone (owner 2026-11-18), on no file or folder row.
		await expect(split).toHaveAttribute("data-finished");
		await expect(split.getByTestId("ws-left-out")).toHaveCount(0);
		await expect(split).not.toHaveAccessibleName(new RegExp(LEFT_OUT));
		const plainRow = rowOf(tree, /plain\.ts/);
		await expect(plainRow).toHaveAttribute("data-finished");
		await expect(plainRow.getByTestId("ws-left-out")).toHaveCount(0);
		await expect(folderRow(tree).getByTestId("ws-left-out")).toHaveCount(0);
	});

	// The verdict: everything counted is reviewed, with the `~`.
	await page.goto(reviewPage(s.url, "verdict"));
	const info = page.getByTestId("verdict-card-tab").getByTestId("verdict-info");
	await expect(info).toHaveText(/You reviewed (\d+) of \1 lines/);
	await expect(info.getByRole("img", { name: LEFT_OUT })).toBeVisible();
	// Off: the whitespace-only cluster's lines count again, unreviewed.
	await ignoreWhitespace(page, false);
	await expect(info).toHaveText(/You reviewed 10 of 14 lines/);
	await expect(info.getByRole("img", { name: LEFT_OUT })).toHaveCount(0);

	// The Files page off: the split file is open again, the plain one done.
	await openFiles(page, s.url);
	await expect(progress(page)).toContainText("3 / 4 clusters reviewed");
	await expect(leftOut(page)).toHaveCount(0);
	await expect(header(section)).not.toHaveAttribute("data-finished");
	await expect(
		header(section).getByRole("img", { name: LEFT_OUT }),
	).toHaveCount(0);
	await expect(header(plain)).toHaveAttribute("data-finished");
	await withTree(page, async (tree) => {
		const split = rowOf(tree, /split\.ts/);
		await expect(split).not.toHaveAttribute("data-finished");
		await expect(split.getByTestId("ws-left-out")).toHaveCount(0);
		await expect(folderRow(tree).getByTestId("ws-left-out")).toHaveCount(0);
	});
	await expand(page);
	await expect(boxes(section).nth(1)).not.toBeChecked();
});

const GIT_WAIT = { timeout: 30_000 };

test("the since view follows the switch: its bar, the header and the move-on leave the whitespace-only cluster out, with a `~`", async ({
	page,
	pr,
	startCrb,
}) => {
	// A review, a push, the engine's answer and four marks: past the default budget on a loaded machine.
	test.slow();
	// PS1: line 2 changed, lines 6-7 re-indented, both reviewed. A
	// re-indent since PS1 is whitespace-only only where the reviewer read
	// those lines in PS1 (CAR-218): PS2 indents 6-7 deeper.
	const ps1 = lines.map((l, i) =>
		i === 1 ? `${l} changed` : i === 5 || i === 6 ? `  ${l}` : l,
	);
	const p = await pr({
		base: { [PATH]: text(lines) },
		files: [{ message: "Line 2, re-indent", files: { [PATH]: text(ps1) } }],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page);
	await expect(boxes(section)).toHaveCount(2);
	await boxes(section).first().click();
	await expect(boxes(section).first()).toBeChecked();
	await boxes(section).last().click();
	await expect(progress(page)).toHaveAttribute("aria-valuenow", "100");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	// PS2: line 2 as it was (carried), and change / re-indent / change.
	p.moveHead({
		message: "Change, re-indent, change",
		files: {
			[PATH]: text(
				ps1.map((l, i) =>
					i === 3 || i === 4 || i === 7 || i === 8
						? `${l} changed`
						: i === 5 || i === 6
							? `    ${l}`
							: l,
				),
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
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);
	// Each changed run is two pieces here (its old lines and its new
	// ones): six, two of them whitespace-only since PS1 (the re-indent
	// the reviewer read there).
	await expect(progress(page)).toContainText("0 / 6 clusters reviewed");
	await expect(sinceLeftOut(page)).toHaveCount(0);

	// On: four to read, the `~` says two are left out.
	await ignoreWhitespace(page, true);
	await expect(progress(page)).toContainText("0 / 4 clusters reviewed");
	await expect(sinceLeftOut(page)).toBeVisible();
	const since = await expand(page);
	const pieceBox = (line: string) =>
		since
			.getByRole("row")
			.filter({ has: page.getByRole("button", { name: line, exact: true }) })
			.getByRole("checkbox", { name: /cluster reviewed$/ });
	for (const [i, line] of ["Old line 4", "Old line 8", "Line 4"].entries()) {
		await pieceBox(line).click();
		await expect(progress(page)).toContainText(
			`${i + 1} / 4 clusters reviewed`,
		);
	}
	await pieceBox("Line 8").click();
	await expect(progress(page)).toContainText("4 / 4 clusters reviewed");
	await expect(sinceLeftOut(page)).toBeVisible();
	await expect(header(since)).toHaveAttribute("data-finished");
	await expect(
		header(since).getByRole("img", { name: SINCE_LEFT_OUT }),
	).toBeVisible();

	// Off: the whitespace-only cluster is to read again.
	await ignoreWhitespace(page, false);
	await expect(progress(page)).toContainText("4 / 6 clusters reviewed");
	await expect(sinceLeftOut(page)).toHaveCount(0);
	await expect(header(since)).not.toHaveAttribute("data-finished");
	await expect(
		header(since).getByRole("img", { name: SINCE_LEFT_OUT }),
	).toHaveCount(0);
});

test("the full diff with a comparison open: to read leaves out whitespace-only clusters with the switch on, as the bar does, and counts them with it off (CAR-243)", async ({
	page,
	pr,
	startCrb,
}) => {
	// A review, a push, the engine's answer and marks: past the default budget on a loaded machine.
	test.slow();
	const ps1 = lines.map((l, i) =>
		i === 1 ? `${l} changed` : i === 5 || i === 6 ? `  ${l}` : l,
	);
	const p = await pr({
		base: { [PATH]: text(lines) },
		files: [{ message: "Line 2, re-indent", files: { [PATH]: text(ps1) } }],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page);
	await expect(boxes(section)).toHaveCount(2);
	await boxes(section).first().click();
	await expect(boxes(section).first()).toBeChecked();
	await boxes(section).last().click();
	await expect(progress(page)).toHaveAttribute("aria-valuenow", "100");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	// PS2 re-indents lines 6-7 deeper (whitespace-only against the base,
	// reworked since PS1) and changes lines 4-5 and 8-9.
	p.moveHead({
		message: "Change, re-indent, change",
		files: {
			[PATH]: text(
				ps1.map((l, i) =>
					i === 3 || i === 4 || i === 7 || i === 8
						? `${l} changed`
						: i === 5 || i === 6
							? `    ${l}`
							: l,
				),
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
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);
	// The full diff of the same comparison (the PS1 node is still the base).
	await page.keyboard.press("Control+Shift+[");
	await expect(
		page
			.getByTestId("ps-node-branch")
			.getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	const toRead = page.getByTestId("to-read");
	const bar = progress(page);
	await expect(toRead).toHaveText(/3 to read/, GIT_WAIT);
	await expect(bar).toContainText("1 / 4 clusters reviewed");
	await ignoreWhitespace(page, true);
	await expect(toRead).toHaveText(/2 to read/);
	await expect(bar).toContainText("1 / 3 clusters reviewed");
	await ignoreWhitespace(page, false);
	await expect(toRead).toHaveText(/3 to read/);
});

test("a graph card's to-read count follows the switch: a push that only re-indents reads nothing new with it on, and counts the cluster with it off (CAR-247)", async ({
	page,
	pr,
	startCrb,
}) => {
	test.slow();
	const ps1 = lines.map((l, i) => (i === 1 ? `${l} changed` : l));
	const p = await pr({
		base: { [PATH]: text(lines) },
		files: [{ message: "Line 2", files: { [PATH]: text(ps1) } }],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page);
	await boxes(section).first().click();
	await expect(progress(page)).toHaveAttribute("aria-valuenow", "100");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	// PS2 only re-indents lines 6-7.
	p.moveHead({
		message: "Re-indent",
		files: {
			[PATH]: text(ps1.map((l, i) => (i === 5 || i === 6 ? `    ${l}` : l))),
		},
	});
	await page.reload();
	await expect(page.getByTestId("ps-tail")).toHaveAttribute(
		"data-state",
		"head",
		GIT_WAIT,
	);
	const card = page.locator('[role="tooltip"]:not([hidden])');
	const conn = page.getByTestId("ps-conn-head");
	const says = async (text: string) => {
		await conn.hover();
		await expect(card).toContainText(text, GIT_WAIT);
		await page.mouse.move(0, 0);
	};
	await says("1 file, 1 cluster to read");
	await ignoreWhitespace(page, true);
	await says("nothing new");
	await ignoreWhitespace(page, false);
	await says("1 file, 1 cluster to read");
});

test("the full diff with a comparison open: its connector's card counts as the bar's to read, the switch off and on; the since view's counts its units (CAR-266)", async ({
	page,
	pr,
	startCrb,
}) => {
	// A review, a push, the engine's answer and two views: past the default budget on a loaded machine.
	test.slow();
	const ps1 = lines.map((l, i) => (i === 1 ? `${l} changed` : l));
	const p = await pr({
		base: { [PATH]: text(lines) },
		files: [{ message: "Line 2", files: { [PATH]: text(ps1) } }],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page);
	await boxes(section).first().click();
	await expect(progress(page)).toHaveAttribute("aria-valuenow", "100");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	// PS2 re-indents the changed line, read at PS1. With Ignore whitespace
	// on, the engine's count leaves the re-indent out (judged on the
	// interdiff: the line was read at PS1, CAR-218), while the full diff's
	// bar counts its cluster (not whitespace-only against the base).
	p.moveHead({
		message: "Re-indent line 2",
		files: {
			[PATH]: text(ps1.map((l, i) => (i === 1 ? `    ${l}` : l))),
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
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);
	// The full diff of the same comparison (PS1 → head).
	await page.keyboard.press("Control+Shift+[");
	await expect(
		page
			.getByTestId("ps-node-branch")
			.getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	const toRead = page.getByTestId("to-read");
	const card = page.locator('[role="tooltip"]:not([hidden])');
	const conn = page.getByTestId("ps-conn-head");
	const says = async (text: string) => {
		await conn.hover();
		await expect(card).toContainText(text, GIT_WAIT);
		await page.mouse.move(0, 0);
	};
	await expect(toRead).toHaveText(/1 to read/, GIT_WAIT);
	await says("1 file, 1 cluster to read");
	await ignoreWhitespace(page, true);
	await expect(toRead).toHaveText(/1 to read/);
	await says("1 file, 1 cluster to read");
	await ignoreWhitespace(page, false);
	// The since view (PS1 is the base again): its units, as its bar.
	await page.keyboard.press("Control+Shift+]");
	await expect(
		page
			.getByTestId("ps-node-branch")
			.getByRole("button", { name: "comparison base" }),
	).toHaveCount(0);
	await expect(toRead).toHaveText(/1 to read/, GIT_WAIT);
	await says("1 file, 1 cluster to read");
});

test("the since view: a run mixing a re-indent read in PS1 and a real edit is one piece per stretch, each with its box, the switch off and on", async ({
	page,
	pr,
	startCrb,
}) => {
	// A review, a push, the engine's answer and four marks: past the default budget on a loaded machine.
	test.slow();
	// PS1 adds three lines after line 8 (one cluster), reviewed. PS2
	// re-indents two of them and edits the third: since PS1, each run (the
	// gone PS1 lines, the new ones) is a re-indent piece and an edit piece.
	const ps1 = [...lines.slice(0, 8), "one();", "two();", "three();"];
	ps1.push(...lines.slice(8));
	const p = await pr({
		base: { [PATH]: text(lines) },
		files: [{ message: "Three lines", files: { [PATH]: text(ps1) } }],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page);
	await boxes(section).first().click();
	await expect(progress(page)).toHaveAttribute("aria-valuenow", "100");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	p.moveHead({
		message: "Re-indent two, edit one",
		files: {
			[PATH]: text(
				ps1.map((l) =>
					l === "three();" ? "three!();" : l.endsWith("();") ? `  ${l}` : l,
				),
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
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);
	await expect(progress(page)).toContainText("0 / 4 clusters reviewed");
	const since = await expand(page);
	// Every piece has its box (each its own run of the view).
	await expect(boxes(since)).toHaveCount(4);
	const pieceBox = (line: string) =>
		since
			.getByRole("row")
			.filter({ has: page.getByRole("button", { name: line, exact: true }) })
			.getByRole("checkbox", { name: /cluster reviewed$/ });
	// Off: the edits, PS1's line and PS2's.
	await pieceBox("Old line 11").click();
	await expect(progress(page)).toContainText("1 / 4 clusters reviewed");
	await pieceBox("Line 11").click();
	await expect(progress(page)).toContainText("2 / 4 clusters reviewed");
	// On: the re-indents are left out; still each with its box, to tick.
	// PS2's is a collapsed whitespace-only row (its own flag, CAR-218);
	// PS1's, gone, shows its lines until marked, then is quiet too.
	await ignoreWhitespace(page, true);
	await expect(progress(page)).toContainText("2 / 2 clusters reviewed");
	await expect(boxes(since)).toHaveCount(4);
	const quiet = since.getByTestId("ws-cluster");
	await expect(quiet).toHaveCount(1);
	await pieceBox("Old line 9").click();
	await expect(quiet).toHaveCount(2);
	await expect(
		since.getByRole("checkbox", { name: /cluster reviewed$/, checked: true }),
	).toHaveCount(3);
	// The last box: the file is done and the move-on folds it.
	await since
		.getByRole("checkbox", { name: /cluster reviewed$/, checked: false })
		.click();
	// Off: all four marked, the gone PS1 run's two pieces among them.
	await ignoreWhitespace(page, false);
	await expect(progress(page)).toContainText("4 / 4 clusters reviewed");
	await expect(header(since)).toHaveAttribute("data-finished");
});

// The since view's `~` in the test above: the whitespace-only cluster's
// new lines, and its old ones, a piece of PS1's re-indent (gone in PS2:
// no cluster of PS2's, so a unit of its own; CAR-218).
const SINCE_LEFT_OUT = "2 whitespace-only clusters not counted";
const sinceLeftOut = (page: Page) =>
	page
		.locator("[data-page-bar]")
		.locator(`[data-testid="ws-left-out"][aria-label="${SINCE_LEFT_OUT}"]`);

test("the since view: a change carried, only the indent reworked: the file is nothing else, so its header counts the re-indent, unfinished, with no `~` (B1)", async ({
	page,
	pr,
	startCrb,
}) => {
	// A review, a push and the engine's answer: past the default budget on a loaded machine.
	test.slow();
	// PS1: line 2 changed, lines 6-7 re-indented: a change and a
	// whitespace-only cluster, both reviewed.
	const ps1 = lines.map((l, i) =>
		i === 1 ? `${l} changed` : i === 5 || i === 6 ? `    ${l}` : l,
	);
	const p = await pr({
		base: { [PATH]: text(lines) },
		files: [{ message: "Change and re-indent", files: { [PATH]: text(ps1) } }],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page);
	await expect(boxes(section)).toHaveCount(2);
	await boxes(section).first().click();
	await expect(boxes(section).first()).toBeChecked();
	await boxes(section).last().click();
	await expect(progress(page)).toHaveAttribute("aria-valuenow", "100");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	// PS2: only the indent amount changes; the change is carried.
	p.moveHead({
		message: "Indent by two",
		files: {
			[PATH]: text(
				lines.map((l, i) =>
					i === 1 ? `${l} changed` : i === 5 || i === 6 ? `  ${l}` : l,
				),
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
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);
	await expect(progress(page)).toContainText(/0 \/ \d+ clusters? reviewed/);
	const since = fileSection(page, PATH);
	await expect(header(since)).not.toHaveAttribute("data-finished");

	// On: the file's only since unit is the re-indent (the carried change
	// is none), so the file is nothing else: its header counts it, reads
	// unfinished and shows no `~`; the page bar leaves it out as a whole.
	await ignoreWhitespace(page, true);
	await expect(progress(page)).toContainText("Nothing to read");
	await expect(leftOut(page)).toBeVisible();
	await expect(header(since)).not.toHaveAttribute("data-finished");
	await expect(
		header(since).getByRole("progressbar", { name: "File progress" }),
	).toContainText(/0 \/ \d+ clusters?/);
	await expect(header(since).getByRole("img", { name: LEFT_OUT })).toHaveCount(
		0,
	);

	// Off: the same header, counting the same unit.
	await ignoreWhitespace(page, false);
	await expect(header(since)).not.toHaveAttribute("data-finished");
	await expect(
		header(since).getByRole("progressbar", { name: "File progress" }),
	).toContainText(/0 \/ \d+ clusters?/);
});

/*
 * CAR-218, the since view: PS2 only re-indents a card's markup by two, and
 * the inner `<div>` and `</div>` at PS1's depth equal the outer ones at
 * PS2's, so git cuts the interdiff into three hunks around them. A note's
 * line changes in PS1 and gets a real edit in PS2.
 */
const CARD = "src/card.tsx";
const NOTE = "src/note.ts";
const MARKUP = [
	"<div>",
	"  <div>",
	"    <Title />",
	"  </div>",
	"  <Body />",
	"</div>",
];
/** The card returning its markup at `depth` spaces, or `null`. */
const cardAt = (depth: number | null) =>
	text([
		"export function Card() {",
		...(depth === null
			? ["  return null;"]
			: [
					"  return (",
					...MARKUP.map((l) => `${" ".repeat(depth)}${l}`),
					"  );",
				]),
		"}",
	]);
/** The card's since pieces in the test below (one per run, git's three hunks). */
const CARD_PIECES = 3;
const note = (two: string, seven: string) =>
	text(["one", two, "three", "four", "five", "six", seven]);

/** Opens a file's section, unless the move-on did (it may still be landing). */
async function opened(section: Locator) {
	const expandFile = section.getByRole("button", { name: "Expand file" });
	// The move-on may still be landing: open it until it stays open.
	await expect(async () => {
		if (await expandFile.isVisible()) await expandFile.click();
		await expect(section.locator("table")).toBeVisible({ timeout: 1_000 });
	}).toPass();
}

/**
 * PS1 opened and the given files' clusters ticked, then PS2 pushed and
 * viewed since PS1.
 */
async function sinceReindent(
	page: Page,
	pr: (o: PrOptions) => Promise<Pr>,
	startCrb: () => Promise<Crb>,
	card: { base: number | null; ps1: number; ps2: number },
	mark: string[],
) {
	const p = await pr({
		base: { [CARD]: cardAt(card.base), [NOTE]: note("two", "seven") },
		files: [
			{
				message: "Card markup, note",
				files: { [CARD]: cardAt(card.ps1), [NOTE]: note("two!", "seven") },
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	await expect(progress(page)).toContainText(/0 \/ \d+ clusters reviewed/);
	for (const path of mark) {
		const section = fileSection(page, path);
		// The move-on may have opened it already.
		await opened(section);
		await marksReady(page, section);
		// One cluster per file: ticking it finishes the file.
		await expect(boxes(section)).toHaveCount(1);
		await boxes(section).first().click();
		await expect(header(section)).toHaveAttribute("data-finished");
	}
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	p.moveHead({
		message: "Re-indent the card, edit the note",
		files: { [CARD]: cardAt(card.ps2), [NOTE]: note("two!", "seven!") },
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
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);
}

test("the since view: a re-indent across an accidental unchanged line of markup read in PS1 is quiet with the switch on, its units off the bar, the `~` saying how many", async ({
	page,
	pr,
	startCrb,
}) => {
	// A review, a push and the engine's answer: past the default budget on a loaded machine.
	test.slow();
	// PS1 adds the markup (one change against the base), reviewed.
	await sinceReindent(page, pr, startCrb, { base: null, ps1: 4, ps2: 6 }, [
		CARD,
		NOTE,
	]);
	const bar = progress(page);
	await expect(bar).toContainText("0 / 4 clusters reviewed");
	await expect(page.getByTestId("ws-left-out")).toHaveCount(0);

	await ignoreWhitespace(page, true);
	// On: the card's units, each a re-indent of lines read in PS1, leave
	// the bar; only the note's edit counts, and the `~` says three are
	// left out. The card is nothing else, so its header counts them
	// all, with no `~` of its own.
	await expect(bar).toContainText("0 / 1 cluster reviewed");
	// Its "to read" is the bar's own: the note's edit alone (the card,
	// nothing else, counts nowhere on the bar).
	await expect(page.getByTestId("to-read")).toHaveText(/(^|\s)1 to read$/);
	await expect(
		page
			.locator("[data-page-bar]")
			.locator(
				'[data-testid="ws-left-out"][aria-label="3 whitespace-only clusters not counted"]',
			),
	).toBeVisible();
	const cardSection = fileSection(page, CARD);
	await expect(header(cardSection).getByTestId("ws-left-out")).toHaveCount(0);
	// The block reads quiet across the hunks git cut: each since piece,
	// a re-indent read in PS1, a collapsed whitespace-only row; no added
	// or removed rows.
	await opened(cardSection);
	const quiet = cardSection.getByTestId("ws-cluster");
	await expect(quiet).toHaveCount(CARD_PIECES);
	await expect(quiet.first()).not.toHaveAttribute("data-expanded");
	await expect(
		cardSection.locator('[data-testid="diff-line"][data-kind="add"]'),
	).toHaveCount(0);
	await expect(
		cardSection.locator('[data-testid="diff-line"][data-kind="del"]'),
	).toHaveCount(0);

	// The note's edit, the last unit the bar counts: the move-on skips the
	// card (nothing else, as the full diff skips one) and the verdict rises.
	await cardSection.getByRole("button", { name: "Collapse file" }).click();
	await expect(cardSection.locator("table")).toHaveCount(0);
	const noteSection = fileSection(page, NOTE);
	await opened(noteSection);
	await marksReady(page, noteSection);
	await expect(boxes(noteSection)).toHaveCount(1);
	await boxes(noteSection).first().click();
	await expect(bar).toContainText("1 / 1 cluster reviewed");
	await expect(page.getByTestId("to-read")).toHaveText(/(^|\s)0 to read$/);
	await expect(page.getByTestId("verdict-card-files")).toBeInViewport();
	await expect(page.getByRole("button", { name: "Collapse file" })).toHaveCount(
		0,
	);

	// Off: they count again.
	await ignoreWhitespace(page, false);
	await expect(bar).toContainText("1 / 4 clusters reviewed");
	await expect(page.getByTestId("ws-left-out")).toHaveCount(0);
});

test("the since view: a re-indent of markup nobody marked in PS1 still counts with the switch on (principle 2)", async ({
	page,
	pr,
	startCrb,
}) => {
	// A review, a push and the engine's answer: past the default budget on a loaded machine.
	test.slow();
	// PS1 only re-indents the markup (whitespace only against the base),
	// left unmarked; the note's change is reviewed.
	await sinceReindent(page, pr, startCrb, { base: 2, ps1: 4, ps2: 6 }, [NOTE]);
	const bar = progress(page);
	// The card's lines no interdiff piece shows (PS1's re-indent, never
	// read) are two orphan pieces of their own (CAR-216); placed among the
	// interdiff's rows, they also cut PS1's `<Title />` off as a piece.
	await expect(bar).toContainText("0 / 7 clusters reviewed");
	await ignoreWhitespace(page, true);
	// On: the orphan pieces (a re-indent against the base, as the full
	// diff reads them) are left out, and so is the since piece that only
	// re-indents base lines PS1 left alone (git kept them, byte-equal at
	// PS1's depth: nothing to read there, as in the full diff; owner
	// 2026-11-23); all are the card's one cluster, so the `~` says one.
	// Its other three since pieces, re-indents of lines PS1 changed and
	// nobody marked, still count with the note.
	await expect(bar).toContainText("0 / 4 clusters reviewed");
	await expect(
		page
			.locator("[data-page-bar]")
			.locator(
				'[data-testid="ws-left-out"][aria-label="1 whitespace-only cluster not counted"]',
			),
	).toBeVisible();
	// Nor are the counted ones collapsed: they show, `~` rows open; only
	// the left-alone piece and the two orphans are whitespace-only rows.
	const cardSection = fileSection(page, CARD);
	await opened(cardSection);
	await expect(
		cardSection.locator('[data-testid="diff-line"][data-kind="ws"]').first(),
	).toBeVisible();
	await expect(cardSection.getByTestId("ws-cluster")).toHaveCount(3);
	// Off: everything counts.
	await ignoreWhitespace(page, false);
	await expect(bar).toContainText("0 / 7 clusters reviewed");
	await expect(page.getByTestId("ws-left-out")).toHaveCount(0);
});

test("the since view: a real edit since PS1, in a cluster whitespace-only against the base, is never collapsed with the switch on: its lines show, and count", async ({
	page,
	pr,
	startCrb,
}) => {
	// A review, a push and the engine's answer: past the default budget on a loaded machine.
	test.slow();
	// PS1 changes `load()` for real, reviewed; PS2 only re-indents the
	// base's line: whitespace only against the base, a real edit since.
	const path = "src/loader.ts";
	const at = (line: string) =>
		text(["export function start() {", "  ready();", line, "}"]);
	const p = await pr({
		base: { [path]: at("load();") },
		files: [{ message: "Unload", files: { [path]: at("unload();") } }],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, path);
	await opened(section);
	await marksReady(page, section);
	await expect(boxes(section)).toHaveCount(1);
	await boxes(section).first().click();
	await expect(progress(page)).toHaveAttribute("aria-valuenow", "100");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	p.moveHead({ message: "Load, indented", files: { [path]: at("  load();") } });
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
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);
	const bar = progress(page);
	// One piece since PS1: the edit's run, `unload()` gone, `  load()` new.
	await expect(bar).toContainText("0 / 1 cluster reviewed");

	// On: the edit still counts, and its lines show.
	await ignoreWhitespace(page, true);
	await expect(bar).toContainText("0 / 1 cluster reviewed");
	await expect(page.getByTestId("ws-left-out")).toHaveCount(0);
	const since = fileSection(page, path);
	await opened(since);
	const del = since.locator('[data-testid="diff-line"][data-kind="del"]');
	const add = since.locator('[data-testid="diff-line"][data-kind="add"]');
	await expect(del).toHaveCount(1);
	await expect(del).toContainText("unload();");
	await expect(add).toHaveCount(1);
	await expect(add).toContainText("load();");
	await expect(since.getByTestId("ws-cluster")).toHaveCount(0);
	await expect(boxes(since)).toHaveCount(1);
});

test("the since view: ticking a change never closes the file while a real edit since, in a cluster whitespace-only against the base, is unmarked", async ({
	page,
	pr,
	startCrb,
}) => {
	// A review, a push and the engine's answer: past the default budget on a loaded machine.
	test.slow();
	// PS1 changes `load()` for real, reviewed; PS2 only re-indents the
	// base's line (whitespace only against the base, a real edit since)
	// and changes `alpha()`, far above it: two units, both counted.
	const path = "src/loader.ts";
	const at = (alpha: string, load: string) =>
		text([alpha, ...Array.from({ length: 9 }, (_, i) => `keep${i}();`), load]);
	const p = await pr({
		base: { [path]: at("alpha();", "load();") },
		files: [
			{ message: "Unload", files: { [path]: at("alpha();", "unload();") } },
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, path);
	await opened(section);
	await marksReady(page, section);
	await expect(boxes(section)).toHaveCount(1);
	await boxes(section).first().click();
	await expect(progress(page)).toHaveAttribute("aria-valuenow", "100");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	p.moveHead({
		message: "Alpha, load indented",
		files: { [path]: at("alpha!();", "  load();") },
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
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);
	const bar = progress(page);
	await ignoreWhitespace(page, true);
	await expect(bar).toContainText("0 / 2 clusters reviewed");
	const since = fileSection(page, path);
	await opened(since);
	await marksReady(page, since);
	// Each run is a piece with its box, `alpha()`'s first.
	await expect(boxes(since)).toHaveCount(2);
	// The change: the edit is still to read, so the file stays open.
	await boxes(since).first().click();
	await expect(bar).toContainText("1 / 2 clusters reviewed");
	await expect(since.locator("table")).toBeVisible();
	await expect(header(since)).not.toHaveAttribute("data-finished");
	await expect(
		since.locator('[data-testid="diff-line"][data-kind="add"]', {
			hasText: "load();",
		}),
	).toBeVisible();
	// The edit, the last unit: the file is done and closes.
	await boxes(since).last().click();
	await expect(bar).toContainText("2 / 2 clusters reviewed");
	await expect(since.locator("table")).toHaveCount(0);
	await expect(header(since)).toHaveAttribute("data-finished");
});

test("the since view: a re-indent of a base line PS1 left alone is left out with the switch on, as in the full diff", async ({
	page,
	pr,
	startCrb,
}) => {
	// A review, a push and the engine's answer: past the default budget on a loaded machine.
	test.slow();
	// PS1 changes `alpha()` (reviewed) and leaves `load()` alone; PS2
	// keeps `alpha!()`, edits `keep4()` and only re-indents `load()`:
	// nothing to read there in PS1, so whitespace-only since, as the full
	// diff has it (owner 2026-11-23).
	const path = "src/loader.ts";
	const at = (alpha: string, keep4: string, load: string) =>
		text([
			alpha,
			...Array.from({ length: 9 }, (_, i) => (i === 4 ? keep4 : `keep${i}();`)),
			load,
		]);
	const p = await pr({
		base: { [path]: at("alpha();", "keep4();", "load();") },
		files: [
			{
				message: "Alpha",
				files: { [path]: at("alpha!();", "keep4();", "load();") },
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, path);
	await opened(section);
	await marksReady(page, section);
	await expect(boxes(section)).toHaveCount(1);
	await boxes(section).first().click();
	await expect(progress(page)).toHaveAttribute("aria-valuenow", "100");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	p.moveHead({
		message: "Keep4, load indented",
		files: { [path]: at("alpha!();", "keep4!();", "  load();") },
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
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);
	const bar = progress(page);
	// Off: the edit and the re-indent both count.
	await expect(bar).toContainText("0 / 2 clusters reviewed");
	await expect(page.getByTestId("ws-left-out")).toHaveCount(0);
	// On: only the edit; the `~` says the re-indent is left out.
	await ignoreWhitespace(page, true);
	await expect(bar).toContainText("0 / 1 cluster reviewed");
	await expect(leftOut(page)).toBeVisible();
	const since = fileSection(page, path);
	await opened(since);
	await expect(since.getByTestId("ws-cluster")).toHaveCount(1);
	// Off again: it counts.
	await ignoreWhitespace(page, false);
	await expect(bar).toContainText("0 / 2 clusters reviewed");
	await expect(page.getByTestId("ws-left-out")).toHaveCount(0);
});

test.describe("Home", () => {
	// Its own crb serve: Home reads the config's views.
	test.use({ crbServer: "own" });

	test("doesn't follow a review's Ignore whitespace: it counts the whitespace-only cluster", async ({
		page,
		pr,
		startCrb,
		workdir,
	}) => {
		// Its own crb serve, a review and Home's first read: past the default budget on a loaded machine.
		test.slow();
		const p = await pr({
			...fixture,
			scenario: {
				user: { login: "Octo", avatarUrl: "https://avatars.example/Octo" },
				viewerRepos: [{ name: OWNER_REPO, relation: "COLLABORATOR" }],
			},
		});
		p.editScenario((sc) => {
			sc.repos = {
				[OWNER_REPO]: {
					prs: [
						homePr({
							repo: OWNER_REPO,
							number: PR_NUMBER,
							title: "Split clusters",
							author: "alice",
							requested: ["Octo"],
							head: p.head(),
						}),
					],
				},
			};
		});
		const config = join(workdir, "config", "carbonless");
		mkdirSync(config, { recursive: true });
		writeFileSync(
			join(config, "config.json"),
			JSON.stringify({ views: [{ name: "Mine", repos: [OWNER_REPO] }] }),
		);
		await page.route("https://avatars.example/**", (route) =>
			route.fulfill({
				contentType: "image/svg+xml",
				body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"/>',
			}),
		);
		const s = await startCrb();
		await openFiles(page, s.url);
		await ignoreWhitespace(page, true);
		const section = await expand(page);
		await boxes(section).first().click();
		await expect(boxes(section).first()).toBeChecked();
		await boxes(section).last().click();
		await expect(progress(page)).toContainText("2 / 2 clusters reviewed");
		await expect(page.getByTestId("sync-notices")).toHaveCount(0);

		// Home, with the switch still on: 8 of the 12 lines, the
		// whitespace-only cluster's 4 counted and unreviewed.
		await page.goto(new URL("/", s.url).href);
		// Home's first read of GitHub lists the repo's PRs: up to 30 s on a
		// loaded machine (seen past 10 s).
		const row = page
			.getByTestId(/^home-row/)
			.filter({ hasText: "Split clusters" });
		await expect(
			row.getByRole("img", { name: "8 of 12 lines reviewed" }),
		).toBeVisible({ timeout: 30_000 });
		await expect(anyLeftOut(page)).toHaveCount(0);
	});
});

/** CAR-235: an added file is cut after each run of blank lines. */
const ADDED = "src/added.ts";
const addedFixture: PrOptions = {
	base: { "README.md": "readme\n" },
	files: [
		{
			message: "Add a file",
			files: {
				[ADDED]: text([
					"import { x } from './x';",
					"",
					"export function a() {",
					"  return x;",
					"}",
					"",
					"",
					"export const b = 1;",
				]),
			},
		},
	],
};

test("an added file is one box per blank-line-ended block; ticking each finishes the file", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(addedFixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const bar = progress(page);
	await expect(bar).toContainText("0 / 3 clusters reviewed");
	const section = fileSection(page, ADDED);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.locator("table")).toBeVisible();
	await expect(boxes(section)).toHaveCount(3);
	await boxes(section).nth(0).click();
	await expect(bar).toContainText("1 / 3 clusters reviewed");
	await expect(section.locator("header")).not.toHaveAttribute("data-finished");
	await boxes(section).nth(1).click();
	await expect(bar).toContainText("2 / 3 clusters reviewed");
	await boxes(section).nth(2).click();
	await expect(bar).toContainText("3 / 3 clusters reviewed");
	await expect(bar).toContainText("100%");
	await expect(section.locator("header")).toHaveAttribute("data-finished");
});
