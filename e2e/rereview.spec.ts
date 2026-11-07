import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import { type FixtureCommit, testGitEnv } from "../test/git-fixture";
import {
	expectNoPageOverflow,
	fileSection,
	openFiles,
	progress,
	rowTop,
	tapHeight,
	withTree,
} from "./files-ui";
import {
	expect,
	expectLoadingThen,
	OWNER_REPO,
	type PrOptions,
	test,
} from "./fixtures";

/*
 * Re-review after new pushes (docs/superpowers/specs/2026-11-04-re-review-design.md):
 * the patch set graph, the toast, the since view and the carried marks,
 * on desktop and on a phone.
 */

const core = Array.from({ length: 40 }, (_, i) => `core ${i + 1}`);
const util = Array.from({ length: 10 }, (_, i) => `util ${i + 1}`);
const text = (lines: string[]) => `${lines.join("\n")}\n`;
const edit = (lines: string[], at: Record<number, string | null>) =>
	text(
		lines.flatMap((line, i) => {
			const e = at[i + 1];
			return e === undefined ? [line] : e === null ? [] : [e];
		}),
	);

/**
 * Three clusters: core.ts line 5 (A) and line 30 (B), util.ts line 3 (C).
 * The pushes below rework A, add D (util.ts's tail), then undo C.
 */
const fixture: PrOptions = {
	base: { "src/core.ts": text(core), "src/util.ts": text(util) },
	files: [
		{
			message: "PR change",
			files: {
				"src/core.ts": edit(core, {
					5: "core 5 changed",
					30: "core 30 changed",
				}),
				"src/util.ts": edit(util, { 3: "util 3 changed" }),
			},
		},
	],
};

/** Push 2: A reworked, B untouched (carried), a new cluster D in util.ts. */
const rework = {
	message: "rework",
	files: {
		"src/core.ts": edit(core, { 5: "core 5 reworked", 30: "core 30 changed" }),
		"src/util.ts": `${edit(util, { 3: "util 3 changed" })}util 11 new\n`,
	},
};

/** Push 3: C undone (gone), the rest as pushed before. */
const undo = {
	message: "undo util",
	files: { "src/util.ts": `${text(util)}util 11 new\n` },
};

const tail = (page: Page) => page.getByTestId("ps-tail");
const toast = (page: Page) => page.getByTestId("head-toast");
const marker = (page: Page, name: "viewing" | "comparison base") =>
	page.getByRole("button", { name, exact: true });
const node = (page: Page, id: string) => page.getByTestId(`ps-node-${id}`);
const boxes = (section: Locator) =>
	section.getByRole("checkbox", { name: "Mark cluster reviewed" });

async function expand(page: Page, path: string) {
	const section = fileSection(page, path);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.getByTestId("diff-line").first()).toBeVisible();
	return section;
}

/** Marks every cluster of both files reviewed: PS1, fully reviewed. */
async function reviewAll(page: Page) {
	for (const path of ["src/core.ts", "src/util.ts"]) {
		const section = await expand(page, path);
		const all = boxes(section);
		const n = await all.count();
		for (let i = 0; i < n; i++) {
			await all.nth(i).click();
			await expect(all.nth(i)).toBeChecked();
		}
		await section.getByRole("button", { name: "Collapse file" }).click();
	}
	await expect(progress(page)).toHaveAttribute("aria-valuenow", "100");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
}

/** The page's head poll (every 5 minutes) runs now. */
const poll = (page: Page) => page.clock.fastForward("05:01");

/** Drags `handle` onto `target` with the pointer. */
async function drag(page: Page, handle: Locator, target: Locator) {
	const from = await handle.boundingBox();
	const to = await target.boundingBox();
	if (!from || !to) throw new Error("nothing to drag");
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
		steps: 8,
	});
	await page.mouse.up();
}

/** The card a dot or connector shows on hover (a tooltip, hidden from AT). */
const card = (page: Page) => page.locator('[role="tooltip"]:not([hidden])');

/** Push 2': only core.ts reworked, so util.ts carries whole. */
const reworkCore = {
	message: "rework core",
	files: {
		"src/core.ts": edit(core, { 5: "core 5 reworked", 30: "core 30 changed" }),
	},
};

/** The review's refs in crb's clone (the progress ref and the patch set pins), one per line. */
const reviewRefs = (workdir: string) => {
	const [owner, repo] = OWNER_REPO.split("/") as [string, string];
	return execFileSync(
		"git",
		["for-each-ref", "--format=%(refname) %(objectname)", "refs/crb/reviews/"],
		{
			cwd: join(workdir, "cache", "carbonless", "repos", owner, `${repo}.git`),
			encoding: "utf8",
			env: testGitEnv(),
		},
	)
		.split("\n")
		.filter((l) => l.includes("/reviewers/"))
		.sort()
		.join("\n");
};

const chips = (section: Locator) =>
	section.locator('[data-testid="since-chips"] [data-testid="kind-chip"]');
const kindRows = (section: Locator) => section.getByTestId("cluster-kind");
const toRead = (page: Page) => page.getByTestId("to-read");

/**
 * PS1 fully reviewed, then `push`, the page reloaded on PS1 with the head
 * newer. Returns the refs as they stand (nothing may change them but a mark).
 */
async function pushed(
	page: Page,
	workdir: string,
	s: { url: string },
	p: { moveHead: (c: FixtureCommit) => string },
	push: FixtureCommit = rework,
) {
	await openFiles(page, s.url);
	await reviewAll(page);
	const refs = reviewRefs(workdir);
	expect(refs).toContain("/patchsets/1 ");
	p.moveHead(push);
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head");
	return refs;
}

test("View lands on the since view: the reworked and new clusters with their chips, carried ones absent here and marked in the full diff, nothing written; the first mark starts PS2 with the carries", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	const refs = await pushed(page, workdir, s, p);
	await toast(page).getByRole("button", { name: "View" }).click();
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);
	await expect(
		node(page, "head").getByRole("button", { name: "viewing" }),
	).toBeVisible();
	await expect(
		node(page, "ps1").getByRole("button", { name: "comparison base" }),
	).toBeVisible();

	// The engine's answer: the header chips and the to-read count (spinners
	// until then, never 0).
	const coreS = fileSection(page, "src/core.ts");
	const utilS = fileSection(page, "src/util.ts");
	await expect(chips(coreS).filter({ hasText: "1 reworked" })).toBeVisible();
	await expect(chips(coreS).filter({ hasText: "1 carried" })).toBeVisible();
	await expect(chips(utilS).filter({ hasText: "1 new" })).toBeVisible();
	await expect(chips(utilS).filter({ hasText: "1 carried" })).toBeVisible();
	await expect(toRead(page)).toHaveText(/2 to read/);
	// The progress bar counts the viewed snapshot with its provisional carries.
	await expect(progress(page)).toContainText("2 / 4 clusters reviewed");
	await expectNoPageOverflow(page);
	// On the narrowest phone the chips take a row of their own: the path
	// keeps its width (principle 5).
	if (isMobile) {
		await page.setViewportSize({ width: 360, height: 740 });
		const path = await coreS.getByTestId("file-path").boundingBox();
		const chipRow = await coreS.getByTestId("since-chips").boundingBox();
		if (!path || !chipRow) throw new Error("no geometry");
		expect(path.width).toBeGreaterThan(60);
		// A row of its own, under the path, however many chips there are.
		expect(chipRow.y).toBeGreaterThanOrEqual(path.y + path.height - 1);
	}
	await expect(coreS.getByTestId("file-path")).toBeVisible();
	await expectNoPageOverflow(page);

	// The since view: core.ts shows the reworked cluster alone, as a plain
	// diff of what the author changed.
	await coreS.getByRole("button", { name: "Expand file" }).click();
	await expect(kindRows(coreS)).toHaveCount(1);
	await expect(kindRows(coreS)).toHaveAttribute("data-kind", "reworked");
	await expect(
		coreS.getByTestId("diff-line").filter({ hasText: "core 5 changed" }),
	).toHaveAttribute("data-kind", "del");
	await expect(
		coreS.getByTestId("diff-line").filter({ hasText: "core 5 reworked" }),
	).toHaveAttribute("data-kind", "add");
	await expect(
		coreS.getByTestId("diff-line").filter({ hasText: "core 30" }),
	).toHaveCount(0);
	await expect(boxes(coreS)).toHaveCount(1);
	await expect(boxes(coreS)).not.toBeChecked();
	await coreS.getByRole("button", { name: "Collapse file" }).click();
	await utilS.getByRole("button", { name: "Expand file" }).click();
	await expect(kindRows(utilS)).toHaveAttribute("data-kind", "new");
	await expect(
		utilS.getByTestId("diff-line").filter({ hasText: "util 11 new" }),
	).toHaveAttribute("data-kind", "add");
	await expect(
		utilS.getByTestId("diff-line").filter({ hasText: "util 3" }),
	).toHaveCount(0);
	await utilS.getByRole("button", { name: "Collapse file" }).click();
	// Nothing written: viewing is not a lasting action.
	expect(reviewRefs(workdir)).toBe(refs);

	// The full diff (the base on the branch dot): the carried clusters
	// green and marked, with their chip; the others unreviewed.
	await page.keyboard.press("Control+Shift+[");
	await expect(
		node(page, "branch").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	await coreS.getByRole("button", { name: "Expand file" }).click();
	await expect(boxes(coreS)).toHaveCount(2);
	await expect(boxes(coreS).first()).not.toBeChecked();
	await expect(boxes(coreS).last()).toBeChecked();
	await expect(
		kindRows(coreS).filter({ has: page.locator('[data-kind="carried"]') }),
	).toHaveCount(1);
	await expect(
		coreS.getByTestId("diff-line").filter({ hasText: "core 30 changed" }),
	).toHaveAttribute("data-reviewed", "true");
	await expect(toRead(page)).toHaveText(/2 to read/);
	expect(reviewRefs(workdir)).toBe(refs);

	// The first mark starts PS2 with the carries: the rail gains PS2 (viewed,
	// up to date), the refs a second patch set; the carried marks stay.
	await boxes(coreS).first().click();
	await expect(boxes(coreS).first()).toBeChecked();
	await expect(
		node(page, "ps2").getByRole("button", { name: "viewing" }),
	).toBeVisible();
	await expect(tail(page)).toHaveAttribute("data-state", "up-to-date");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	const after = reviewRefs(workdir);
	expect(after).not.toBe(refs);
	expect(after).toContain("/patchsets/2 ");
	expect(after).toContain("/patchsets/2-base ");
	await expect(progress(page)).toContainText("3 / 4 clusters reviewed");
	// The base is on the branch: a plain full diff of PS2, no comparison
	// to count what is to read. The address names PS2 now.
	await expect(toRead(page)).toHaveCount(0);
	await expect(page).toHaveURL(/ps=2/);
	await expect(page).not.toHaveURL(/head=/);
	await expect(toast(page)).toHaveCount(0);

	// Unticking a carried cluster is the reviewer's own event; it survives a reload.
	await boxes(coreS).last().click();
	await expect(boxes(coreS).last()).not.toBeChecked();
	await expect(progress(page)).toContainText("2 / 4 clusters reviewed");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	await page.reload();
	await expect(progress(page)).toContainText("2 / 4 clusters reviewed");
	await expect(
		node(page, "ps2").getByRole("button", { name: "viewing" }),
	).toBeVisible();
	// The since view and the full diff share one state: PS1 → PS2 shows
	// the reworked cluster marked, as it was in the full diff.
	await page.keyboard.press("Control+Shift+]");
	await expect(
		node(page, "ps1").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	await expect(chips(coreS).filter({ hasText: "1 reworked" })).toBeVisible();
	await expect(toRead(page)).toHaveText(/1 to read/);
	await coreS.getByRole("button", { name: "Expand file" }).click();
	await expect(boxes(coreS)).toHaveCount(1);
	await expect(boxes(coreS)).toBeChecked();
});

test("a gone cluster is a red block with its chip, not markable and not counted; an old patch set opens read-only with its marks", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	await pushed(page, workdir, s, p);
	await toast(page).getByRole("button", { name: "View" }).click();
	const utilS = fileSection(page, "src/util.ts");
	await expect(chips(utilS).filter({ hasText: "1 new" })).toBeVisible();
	await utilS.getByRole("button", { name: "Expand file" }).click();
	await boxes(utilS).click();
	await expect(
		node(page, "ps2").getByRole("button", { name: "viewing" }),
	).toBeVisible();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	await expect(progress(page)).toContainText("3 / 4 clusters reviewed");
	// util.ts's first cluster carried into PS2: mark it by hand too (untick,
	// tick), so PS2 holds the reviewer's own state for it.
	await page.keyboard.press("Control+Shift+[");
	await expect(boxes(utilS)).toHaveCount(2);
	await boxes(utilS).first().click();
	await expect(boxes(utilS).first()).not.toBeChecked();
	await boxes(utilS).first().click();
	await expect(boxes(utilS).first()).toBeChecked();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	await expect(progress(page)).toContainText("3 / 4 clusters reviewed");
	const refs = reviewRefs(workdir);

	// Push 3 undoes util.ts's first cluster: gone since PS2.
	p.moveHead(undo);
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head");
	await toast(page).getByRole("button", { name: "View" }).click();
	await expect(
		node(page, "ps2").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	await expect(chips(utilS).filter({ hasText: "1 gone" })).toBeVisible();
	await expect(chips(utilS).filter({ hasText: "1 carried" })).toBeVisible();
	await utilS.getByRole("button", { name: "Expand file" }).click();
	const goneBlock = utilS.locator("tbody[data-gone]");
	await expect(goneBlock).toHaveCount(1);
	await expect(goneBlock.getByTestId("cluster-kind")).toHaveAttribute(
		"data-kind",
		"gone",
	);
	await expect(
		goneBlock.getByTestId("diff-line").filter({ hasText: "util 3 changed" }),
	).toHaveAttribute("data-kind", "del");
	await expect(goneBlock.getByRole("checkbox")).toHaveCount(0);
	await expect(boxes(utilS)).toHaveCount(0);
	// Not counted: the viewed snapshot has three clusters, two carried and
	// the reworked one (never reviewed) still to read.
	await expect(progress(page)).toContainText("2 / 3 clusters reviewed");
	await expect(toRead(page)).toHaveText(/1 to read/);
	expect(reviewRefs(workdir)).toBe(refs);
	await expectNoPageOverflow(page);

	// Back to PS1 (two steps left): as reviewed, read-only, every box
	// checked and locked; Back to PS2 is the way back.
	await page.keyboard.press("Control+[");
	await page.keyboard.press("Control+[");
	await expect(
		node(page, "ps1").getByRole("button", { name: "viewing" }),
	).toBeVisible();
	await expect(page).toHaveURL(/ps=1/);
	const note = page.getByTestId("read-only-note");
	await expect(note).toContainText("PS1 · as reviewed · read-only");
	await expect(progress(page)).toContainText("3 / 3 clusters reviewed");
	const coreS = fileSection(page, "src/core.ts");
	await coreS.getByRole("button", { name: "Expand file" }).click();
	await expect(boxes(coreS)).toHaveCount(2);
	for (const box of await boxes(coreS).all()) {
		await expect(box).toBeChecked();
		await expect(box).toBeDisabled();
	}
	await expect(
		coreS.getByRole("button", { name: "Cross off cluster" }).first(),
	).toBeDisabled();
	await expect(
		coreS.getByRole("button", { name: "Mark remaining reviewed" }),
	).toBeDisabled();
	await expect(
		coreS.getByTestId("diff-line").filter({ hasText: "core 5 changed" }),
	).toBeVisible();
	await note.getByRole("button", { name: "Back to PS2" }).click();
	await expect(
		node(page, "ps2").getByRole("button", { name: "viewing" }),
	).toBeVisible();
	await expect(page.getByTestId("read-only-note")).toHaveCount(0);
	expect(reviewRefs(workdir)).toBe(refs);
});

test("the tree's dots say which files need eyes; the needs-eyes filter hides fully carried files, never a cluster", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	await pushed(page, workdir, s, p, reworkCore);
	await toast(page).getByRole("button", { name: "View" }).click();
	const coreS = fileSection(page, "src/core.ts");
	const utilS = fileSection(page, "src/util.ts");
	await expect(chips(coreS).filter({ hasText: "1 reworked" })).toBeVisible();
	await expect(chips(utilS).filter({ hasText: "1 carried" })).toBeVisible();
	await expect(toRead(page)).toHaveText(/1 to read/);
	await withTree(page, async (tree) => {
		await expect(
			tree.getByRole("button", { name: /core\.ts/ }).getByTestId("tree-eyes"),
		).toHaveAttribute("data-eyes", "read");
		await expect(
			tree.getByRole("button", { name: /util\.ts/ }).getByTestId("tree-eyes"),
		).toHaveAttribute("data-eyes", "carried");
		await expect(
			tree.getByRole("button", { name: /util\.ts/ }),
		).toHaveAccessibleName(/carried/);
		const filter = page.getByTestId("needs-eyes");
		await expect(filter).toHaveAttribute("aria-pressed", "false");
		await filter.click();
		await expect(filter).toHaveAttribute("aria-pressed", "true");
		await expect(tree.getByRole("button", { name: /util\.ts/ })).toHaveCount(0);
		await expect(tree.getByRole("button", { name: /core\.ts/ })).toBeVisible();
	});
	await expect(utilS).toHaveCount(0);
	await expect(coreS).toBeVisible();
	// The hidden file hides no cluster: its only cluster is carried, counted
	// as reviewed; the bar still counts everything.
	await expect(progress(page)).toContainText("2 / 3 clusters reviewed");
	// Unticking a carried mark makes the file need eyes again: marking
	// starts PS2 first, then the file is back.
	await withTree(page, async () => {
		await page.getByTestId("needs-eyes").click();
	});
	await expect(utilS).toBeVisible();
	await utilS.getByRole("button", { name: "Expand file" }).click();
	await expect(utilS.getByTestId("since-empty")).toHaveText(
		"Nothing to read since PS1 · 1 carried",
	);
	await page.keyboard.press("Control+Shift+[");
	await expect(boxes(utilS)).toHaveCount(1);
	await boxes(utilS).click();
	await expect(boxes(utilS)).not.toBeChecked();
	await expect(
		node(page, "ps2").getByRole("button", { name: "viewing" }),
	).toBeVisible();
	// Back in the since view (PS1 → PS2): the unticked file needs eyes
	// (the dot follows the reviewer's mark; "to read" counts what the
	// author changed, still the reworked cluster alone).
	await page.keyboard.press("Control+Shift+]");
	await expect(
		node(page, "ps1").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	await expect(toRead(page)).toHaveText(/1 to read/);
	await withTree(page, async (tree) => {
		await expect(
			tree.getByRole("button", { name: /util\.ts/ }).getByTestId("tree-eyes"),
		).toHaveAttribute("data-eyes", "read");
	});
});

test("an empty since view says so once the engine has answered, with a spinner until then", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	// An empty commit: a new head with the same tree, everything carries.
	await pushed(page, workdir, s, p, { message: "empty", files: {} });
	let release = () => {};
	const held = new Promise<void>((r) => {
		release = r;
	});
	await page.route("**/api/rereview?*", async (route) => {
		await held;
		await route.continue();
	});
	await toast(page).getByRole("button", { name: "View" }).click();
	await expectLoadingThen({
		loading: toRead(page).getByRole("status", {
			name: "Counting what is to read",
		}),
		empty: [
			page.getByTestId("since-empty-all"),
			toRead(page).getByText(/0 to read/),
			fileSection(page, "src/core.ts").getByText(/carried/),
		],
		release: () => {
			release();
			return page.unroute("**/api/rereview?*");
		},
		result: page.getByTestId("since-empty-all"),
	});
	await expect(page.getByTestId("since-empty-all")).toHaveText(
		"Nothing to read since PS1 · 3 carried",
	);
	await expect(toRead(page)).toHaveText(/0 to read/);
	await expect(progress(page)).toContainText("3 / 3 clusters reviewed");
	await expect(page.getByTestId("ps-conn-head")).toHaveAttribute(
		"data-tone",
		"ok",
	);
});

test("a newer head fills the rail's last slot and shows the toast; nothing below the rail moves, nothing takes focus", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	await page.clock.install();
	await openFiles(page, s.url);
	await reviewAll(page);
	await expect(tail(page)).toHaveAttribute("data-state", "up-to-date");
	await expect(tail(page)).toContainText("up to date");
	await expect(toast(page)).toHaveCount(0);
	const slot = tail(page);
	const width = (await slot.boundingBox())?.width ?? 0;
	expect(width).toBeGreaterThan(0);
	const header = fileSection(page, "src/core.ts").locator("header");
	const before = await rowTop(header);
	const focused = () =>
		page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60));
	const focusBefore = await focused();

	p.moveHead(rework);
	await poll(page);
	await expect(tail(page)).toHaveAttribute("data-state", "head");
	await expect(toast(page)).toContainText("1 new commit");
	await expect(toast(page)).toHaveAttribute("role", "status");
	await expect(node(page, "head")).toBeVisible();
	await expect(page.getByTestId("ps-conn-head")).toContainText("1");
	// The same width, so nothing below moved; the toast took no focus.
	expect((await slot.boundingBox())?.width).toBe(width);
	expect(await rowTop(header)).toBe(before);
	expect(await focused()).toBe(focusBefore);
	await expect(toast(page).getByRole("button", { name: "View" })).toBeVisible();
	await expect(marker(page, "viewing")).toBeVisible();
	await expect(
		node(page, "ps1").getByRole("button", { name: "viewing" }),
	).toBeVisible();

	// Dismissed, it stays dismissed for that head.
	await toast(page).getByRole("button", { name: "Dismiss" }).click();
	await expect(toast(page)).toHaveCount(0);

	// Moved twice (Review focus 4): a force-push back to PS1's head. The
	// slot keeps its width through "up to date" again; no toast for a head
	// the reviewer has (the dots never move).
	p.rewindHead(p.repo.shas.at(-1) ?? "");
	await poll(page);
	await expect(tail(page)).toHaveAttribute("data-state", "up-to-date");
	expect((await slot.boundingBox())?.width).toBe(width);
	expect(await rowTop(header)).toBe(before);
	await expect(toast(page)).toHaveCount(0);

	// And forward again, to a head that descends from neither (S4c): the
	// toast counts the new head's commits, the card says the shape.
	p.forceHead({ ...rework, message: "rework, force-pushed" });
	await poll(page);
	await expect(tail(page)).toHaveAttribute("data-state", "head");
	await expect(toast(page)).toContainText("1 new commit");
	expect((await slot.boundingBox())?.width).toBe(width);
	await page.getByTestId("ps-conn-head").hover();
	await expect(card(page)).toContainText(/Rebased/);
});

test("the head connector's card spins in its to-read slot until the engine answers, then says the line", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await reviewAll(page);
	p.moveHead(rework);
	// The engine's answer is held at the page's door until released.
	let release = () => {};
	const held = new Promise<void>((r) => {
		release = r;
	});
	await page.route("**/api/rereview?*", async (route) => {
		await held;
		await route.continue();
	});
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head");
	const conn = page.getByTestId("ps-conn-head");
	// The count comes from git at once.
	await expect(conn).toContainText("1");
	await conn.hover();
	await expectLoadingThen({
		loading: page.getByTestId("rereview-pending"),
		empty: [
			card(page).getByText(/nothing new/),
			card(page).getByText(/0 files/),
		],
		release: () => {
			release();
			return page.unroute("**/api/rereview?*");
		},
		result: card(page).getByText("1 new commit · 2 files, 2 clusters to read"),
	});
	await expect(conn).toHaveAttribute("data-tone", "warn");
});

test("a pinned head shows neither the head dot nor the toast", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr(fixture);
	const then = p.head();
	const now = p.moveHead(rework);
	p.editScenario((s) => {
		const graphql = s.prs[p.number]?.graphql;
		if (!graphql) throw new Error("no graphql");
		graphql.reviews = [
			{
				author: { login: "Octo_Cat", __typename: "User" },
				state: "CHANGES_REQUESTED",
				submittedAt: "2026-01-02T00:00:00Z",
				commit: { oid: then },
			},
			{
				author: { login: "rev1", __typename: "User" },
				state: "APPROVED",
				submittedAt: "2026-01-04T00:00:00Z",
				commit: { oid: now },
			},
		];
		graphql.reviewThreads = [
			reviewThread({ path: "src/util.ts", line: 3, subjectType: "LINE" }, [
				threadComment({
					login: "Octo_Cat",
					text: "On the reviewed commit",
					createdAt: "2026-01-02T00:00:00Z",
					commit: then,
					diffHunk: "",
				}),
			]),
		];
	});
	const s = await startCrb(undefined, ["--head", "reviewed"]);
	await openFiles(page, s.url);
	await expect(tail(page)).toHaveAttribute("data-state", "none");
	await expect(tail(page)).toHaveText("pinned");
	await expect(toast(page)).toHaveCount(0);
	await expect(node(page, "head")).toHaveCount(0);
});

test("the rail on a phone: 40px targets, no page overflow, a tap opens the sheet with View and Compare from here", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "the sheet is the phone's way");
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await reviewAll(page);
	p.moveHead(rework);
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head");
	await expectNoPageOverflow(page);
	for (const el of [
		node(page, "head"),
		node(page, "ps1"),
		marker(page, "viewing"),
		marker(page, "comparison base"),
	]) {
		expect(await tapHeight(el)).toBeGreaterThanOrEqual(40);
	}
	// A phone connector shows the bare count.
	await expect(page.getByTestId("ps-conn-head")).toHaveText("1");
	await expect(marker(page, "comparison base")).toHaveText("comp. base");

	await node(page, "ps1").click();
	const sheet = page.getByTestId("dot-sheet");
	await expect(sheet).toBeVisible();
	await expect(sheet).toContainText("PS1");
	// PS1 is viewed: it can't be its own comparison base.
	await expect(
		sheet.getByRole("button", { name: "Compare from here" }),
	).toBeDisabled();
	await sheet.getByRole("button", { name: "View" }).click();
	await expect(sheet).toBeHidden();

	await node(page, "head").click();
	await expect(sheet).toContainText("head");
	await sheet.getByRole("button", { name: "View" }).click();
	await expect(sheet).toBeHidden();
	await expect(
		node(page, "head").getByRole("button", { name: "viewing" }),
	).toBeVisible();
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);
	await expectNoPageOverflow(page);
});

test("the markers move by drag and by Ctrl+[ / Ctrl+]; nothing moves on a bare key", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await reviewAll(page);
	p.moveHead(rework);
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head");

	await drag(page, marker(page, "viewing"), node(page, "head"));
	await expect(
		node(page, "head").getByRole("button", { name: "viewing" }),
	).toBeVisible();
	await expect(
		node(page, "ps1").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);

	// A bare bracket is nothing; Ctrl+[ goes back to PS1.
	await page.keyboard.press("[");
	await expect(
		node(page, "head").getByRole("button", { name: "viewing" }),
	).toBeVisible();
	await page.keyboard.press("Control+[");
	await expect(
		node(page, "ps1").getByRole("button", { name: "viewing" }),
	).toBeVisible();
	await expect(page).toHaveURL(/ps=1/);
	// The base followed back to the branch (it was "the previous").
	await expect(
		node(page, "branch").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	// Ctrl+] past the newest patch set views the head; the base follows to PS1.
	await page.keyboard.press("Control+]");
	await expect(
		node(page, "head").getByRole("button", { name: "viewing" }),
	).toBeVisible();
	await expect(
		node(page, "ps1").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	// Ctrl+Shift+[ moves the base to the branch: the full diff.
	await page.keyboard.press("Control+Shift+[");
	await expect(
		node(page, "branch").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	await expect(page).toHaveURL(/from=branch/);
	// Dragging the base onto the viewed dot is refused.
	await drag(page, marker(page, "comparison base"), node(page, "head"));
	await expect(
		node(page, "branch").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
});
