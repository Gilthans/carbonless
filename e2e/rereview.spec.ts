import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import { type FixtureCommit, testGitEnv } from "../test/git-fixture";
import {
	expectNoPageOverflow,
	fileSection,
	marksReady,
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
	type Pr,
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
const marker = (page: Page, name: "comparison target" | "comparison base") =>
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

/**
 * Marks every cluster of both files reviewed: PS1, fully reviewed. The last
 * mark of a file closes it and opens the next one with something left
 * (FilesPage's move-on), whose marks wait a moment.
 */
async function reviewAll(page: Page) {
	for (const path of ["src/core.ts", "src/util.ts"]) {
		const section = fileSection(page, path);
		const expandButton = section.getByRole("button", { name: "Expand file" });
		if (await expandButton.isVisible()) await expand(page, path);
		else {
			await expect(section.getByTestId("diff-line").first()).toBeVisible();
			await marksReady(page, section);
		}
		const all = boxes(section);
		const n = await all.count();
		for (let i = 0; i < n - 1; i++) {
			await all.nth(i).click();
			await expect(all.nth(i)).toBeChecked();
		}
		await all.nth(n - 1).click();
		// Finished: it closes.
		await expect(expandButton).toBeVisible();
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

/**
 * For a step that waits on git in crb's child processes: the head check's
 * fetch of a new head, or the engine's answer (merge-tree, the interdiff,
 * a diff per patch set). On a loaded machine these pass the expects'
 * 10 s default (a flake-check under four busy loops did once); a missing
 * answer still fails.
 */
const GIT_WAIT = { timeout: 30_000 };
/** The engine's answer, as a page bound to a review asks it (reviewApiPath). */
const REREVIEW = "**/api/r/*/rereview?*";

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
	await expect(tail(page)).toHaveAttribute("data-state", "head", GIT_WAIT);
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
		node(page, "head").getByRole("button", { name: "comparison target" }),
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
	// The since view's bar counts its pieces: the reworked and the new one.
	await expect(progress(page)).toContainText("0 / 2 clusters reviewed");
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
	// It finishes core.ts, which closes (the page moves on to util.ts).
	await boxes(coreS).first().click();
	await expect(
		coreS.getByRole("button", { name: "Expand file" }),
	).toBeVisible();
	await expect(
		node(page, "ps2").getByRole("button", { name: "comparison target" }),
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
	await coreS.getByRole("button", { name: "Expand file" }).click();
	await expect(boxes(coreS).first()).toBeChecked();
	await boxes(coreS).last().click();
	await expect(boxes(coreS).last()).not.toBeChecked();
	await expect(progress(page)).toContainText("2 / 4 clusters reviewed");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	await page.reload();
	await expect(progress(page)).toContainText("2 / 4 clusters reviewed");
	await expect(
		node(page, "ps2").getByRole("button", { name: "comparison target" }),
	).toBeVisible();
	// The since view and the full diff share one state: PS1 → PS2 shows
	// the reworked cluster marked, as it was in the full diff.
	await page.keyboard.press("Control+Shift+]");
	await expect(
		node(page, "ps1").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	// The chips count what is left to read: the marked reworked one is not;
	// the carried cluster unticked above is (principle 2), with util.ts's new one.
	await expect(toRead(page)).toHaveText(/2 to read/);
	await expect(chips(coreS).filter({ hasText: "reworked" })).toHaveCount(0);
	await coreS.getByRole("button", { name: "Expand file" }).click();
	await expect(boxes(coreS)).toHaveCount(1);
	await expect(boxes(coreS)).toBeChecked();
});

test("a gone cluster is a red block with its chip, markable on its own (reverted) and to read until marked; an old patch set opens read-only with its marks", async ({
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
	// Nothing left to read in util.ts: it closes (the page moves on).
	await boxes(utilS).click();
	await expect(
		utilS.getByRole("button", { name: "Expand file" }),
	).toBeVisible();
	await expect(
		node(page, "ps2").getByRole("button", { name: "comparison target" }),
	).toBeVisible();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	// The since view counts its two pieces; the new one is marked.
	await expect(progress(page)).toContainText("1 / 2 clusters reviewed");
	// util.ts's first cluster carried into PS2: mark it by hand too (untick,
	// tick), so PS2 holds the reviewer's own state for it.
	await page.keyboard.press("Control+Shift+[");
	await utilS.getByRole("button", { name: "Expand file" }).click();
	await expect(boxes(utilS)).toHaveCount(2);
	await boxes(utilS).first().click();
	await expect(boxes(utilS).first()).not.toBeChecked();
	// Ticked again it finishes util.ts again, which closes.
	await boxes(utilS).first().click();
	await expect(
		utilS.getByRole("button", { name: "Expand file" }),
	).toBeVisible();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	await expect(progress(page)).toContainText("3 / 4 clusters reviewed");
	const refs = reviewRefs(workdir);

	// Push 3 undoes util.ts's first cluster: gone since PS2.
	p.moveHead(undo);
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head", GIT_WAIT);
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
	// Markable on its own, with its cross-off; chipped reverted (back to the base).
	await expect(goneBlock.getByRole("checkbox")).toHaveCount(1);
	await expect(
		goneBlock.getByRole("button", { name: "Cross off cluster" }),
	).toHaveCount(1);
	await expect(
		goneBlock.getByTestId("kind-chip").filter({ hasText: "reverted" }),
	).toBeVisible();
	// The since view counts its pieces: the reworked one (never reviewed)
	// and the gone one, both to read.
	await expect(progress(page)).toContainText("0 / 2 clusters reviewed");
	await expect(toRead(page)).toHaveText(/2 to read/);
	expect(reviewRefs(workdir)).toBe(refs);
	await expectNoPageOverflow(page);

	// Back to PS1 (two steps left): as reviewed, read-only, every box
	// checked and locked; Back to PS2 is the way back.
	await page.keyboard.press("Control+[");
	await page.keyboard.press("Control+[");
	await expect(
		node(page, "ps1").getByRole("button", { name: "comparison target" }),
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
	// Finished, so its ✓ is the reset: locked too.
	await expect(
		coreS.getByRole("button", { name: "Unmark reviewed" }),
	).toBeDisabled();
	await expect(
		coreS.getByTestId("diff-line").filter({ hasText: "core 5 changed" }),
	).toBeVisible();
	await note.getByRole("button", { name: "Back to PS2" }).click();
	await expect(
		node(page, "ps2").getByRole("button", { name: "comparison target" }),
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
	// The hidden file hides no piece: its only cluster is carried, not in
	// the since view; the bar counts the since view's one piece.
	await expect(progress(page)).toContainText("0 / 1 cluster reviewed");
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
		node(page, "ps2").getByRole("button", { name: "comparison target" }),
	).toBeVisible();
	// Back in the since view (PS1 → PS2): the unticked cluster counts again
	// (principle 2): the bar and "to read" go up by one, the dot says read.
	await page.keyboard.press("Control+Shift+]");
	await expect(
		node(page, "ps1").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	await expect(toRead(page)).toHaveText(/2 to read/);
	await expect(progress(page)).toContainText("0 / 2 clusters reviewed");
	await expect(utilS.getByTestId("since-unshown")).toContainText(
		"1 to read · only in the full diff",
	);
	await withTree(page, async (tree) => {
		await expect(
			tree.getByRole("button", { name: /util\.ts/ }).getByTestId("tree-eyes"),
		).toHaveAttribute("data-eyes", "read");
	});
});

test("a since view the engine can't count says so in the bar, never the full diff's numbers", async ({
	page,
	workdir,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/500/);
	const p = await pr(fixture);
	const s = await startCrb();
	// Every engine answer fails, the head connector's (read on the reload) too.
	let asked = 0;
	await page.route(REREVIEW, (route) => {
		asked++;
		return route.fulfill({
			status: 500,
			body: JSON.stringify({ error: "boom" }),
		});
	});
	await pushed(page, workdir, s, p);
	await toast(page).getByRole("button", { name: "View" }).click();
	await expect(progress(page)).toHaveAttribute(
		"data-state",
		"failed",
		GIT_WAIT,
	);
	await expect(progress(page)).toHaveText("Not counted");
	// The failure really was the engine's answer, not a path that missed.
	expect(asked).toBeGreaterThan(0);
	await page.unroute(REREVIEW);
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
	let asked = 0;
	let passed = 0;
	await page.route(REREVIEW, async (route) => {
		asked++;
		await held;
		await route.continue();
		passed++;
	});
	await toast(page).getByRole("button", { name: "View" }).click();
	await expectLoadingThen({
		...GIT_WAIT,
		loading: toRead(page).getByRole("status", {
			name: "Counting what is to read",
		}),
		empty: [
			page.getByTestId("since-empty-all"),
			toRead(page).getByText(/0 to read/),
			fileSection(page, "src/core.ts").getByText(/carried/),
		],
		release: async () => {
			// The hold really held the engine's answer: a path that no
			// longer matches fails here instead of passing vacuously.
			await expect
				.poll(() => asked, { message: "the hold saw the rereview call" })
				.toBeGreaterThan(0);
			release();
			// Unrouted mid-flight, the call would be let through by unroute and
			// continue() would throw: let the held calls go first.
			await expect.poll(() => passed).toBe(asked);
			await page.unroute(REREVIEW);
		},
		result: page.getByTestId("since-empty-all"),
	});
	await expect(page.getByTestId("since-empty-all")).toHaveText(
		"Nothing to read since PS1 · 3 carried",
	);
	// The since view's own empty state, never the full diff's numbers.
	await expect(progress(page)).toHaveText("Nothing to read");
	await expect(progress(page)).toHaveAttribute("data-state", "empty");
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
	// The move-on to the verdict (a frame on the installed clock, then its
	// scroll and rise) settles; then back to the top, where the toast's
	// arrival is measured.
	await page.clock.runFor(1_000);
	await page.waitForFunction(() => document.getAnimations().length === 0);
	await page.evaluate(() => window.scrollTo(0, 0));
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
	await expect(tail(page)).toHaveAttribute("data-state", "head", GIT_WAIT);
	await expect(toast(page)).toContainText("1 new commit");
	await expect(toast(page)).toHaveAttribute("role", "status");
	await expect(node(page, "head")).toBeVisible();
	await expect(page.getByTestId("ps-conn-head")).toContainText("1");
	// The same width, so nothing below moved; the toast took no focus.
	expect((await slot.boundingBox())?.width).toBe(width);
	expect(await rowTop(header)).toBe(before);
	expect(await focused()).toBe(focusBefore);
	await expect(toast(page).getByRole("button", { name: "View" })).toBeVisible();
	await expect(marker(page, "comparison target")).toBeVisible();
	await expect(
		node(page, "ps1").getByRole("button", { name: "comparison target" }),
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
	await expect(tail(page)).toHaveAttribute("data-state", "head", GIT_WAIT);
	await expect(toast(page)).toContainText("1 new commit");
	expect((await slot.boundingBox())?.width).toBe(width);
	await page.getByTestId("ps-conn-head").hover();
	await expect(card(page)).toContainText(/Rebased/, GIT_WAIT);
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
	let asked = 0;
	let passed = 0;
	await page.route(REREVIEW, async (route) => {
		asked++;
		await held;
		await route.continue();
		passed++;
	});
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head", GIT_WAIT);
	const conn = page.getByTestId("ps-conn-head");
	// The count comes from git at once.
	await expect(conn).toContainText("1");
	await conn.hover();
	await expectLoadingThen({
		...GIT_WAIT,
		loading: page.getByTestId("rereview-pending"),
		empty: [
			card(page).getByText(/nothing new/),
			card(page).getByText(/0 files/),
		],
		release: async () => {
			// The hold really held the engine's answer: a path that no
			// longer matches fails here instead of passing vacuously.
			await expect
				.poll(() => asked, { message: "the hold saw the rereview call" })
				.toBeGreaterThan(0);
			release();
			// Unrouted mid-flight, the call would be let through by unroute and
			// continue() would throw: let the held calls go first.
			await expect.poll(() => passed).toBe(asked);
			await page.unroute(REREVIEW);
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

/** A dot of the rail: its label and its dot, one button. */
const dot = (page: Page, id: string) => page.getByTestId(`ps-dot-${id}`);
const sticky = (page: Page, name: string) =>
	page.getByRole("dialog", { name: `${name} details` });

test("a click on a dot moves nothing: its card goes sticky, and its Comparison Base and Comparison Target move the markers", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	// A review, a push and seven card presses: past the default under load.
	test.setTimeout(120_000);
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await reviewAll(page);
	p.moveHead(rework);
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head", GIT_WAIT);
	const url = page.url();
	const sections = page.getByRole("region", { name: /^src\// });
	const rows = await sections.allTextContents();

	// A click on PS1's label (one element with its dot): its card, sticky.
	await node(page, "ps1").getByTestId("ps-dot-label").click();
	const ps1 = sticky(page, "PS1");
	await expect(ps1).toBeVisible();
	await expect(dot(page, "ps1")).toHaveAttribute("aria-expanded", "true");
	await expect(ps1).toContainText("Patch Set 1");
	await expect(ps1).toContainText("Reviewed starting");
	await expect(ps1).toContainText("Against main at");
	// Nothing moved: the address, the markers, the rows.
	expect(page.url()).toBe(url);
	await expect(
		node(page, "ps1").getByRole("button", { name: "comparison target" }),
	).toBeVisible();
	expect(await sections.allTextContents()).toEqual(rows);
	// PS1 is viewed: it can't be the target again; its Base would push the
	// target onto the head.
	await expect(
		ps1.getByRole("button", { name: "Comparison Target" }),
	).toHaveAttribute("aria-disabled", "true");
	await expect(
		ps1.getByRole("button", { name: "Comparison Base" }),
	).not.toHaveAttribute("aria-disabled");
	await page.keyboard.press("Escape");
	await expect(ps1).toBeHidden();
	await expect(dot(page, "ps1")).toBeFocused();

	// The head: a click shows its card, only its Target views it.
	await dot(page, "head").click();
	const head = sticky(page, "head");
	await expect(head).toContainText("Head");
	await expect(head).toContainText("Not reviewed yet");
	await expect(head).toContainText("1 commit since PS1");
	expect(page.url()).toBe(url);
	if (isMobile) {
		// Inside the viewport, its buttons 40px, nothing overflows.
		const box = await head.boundingBox();
		const width = page.viewportSize()?.width ?? 0;
		expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
		for (const name of ["Comparison Base", "Comparison Target"]) {
			const b = await head.getByRole("button", { name }).boundingBox();
			expect(b?.height ?? 0).toBeGreaterThanOrEqual(40);
		}
		await expectNoPageOverflow(page);
	}
	await expect(
		head.getByRole("button", { name: "Comparison Base" }),
	).toHaveAttribute("aria-disabled", "true");
	await head.getByRole("button", { name: "Comparison Target" }).click();
	await expect(head).toBeHidden();
	await expect(
		node(page, "head").getByRole("button", { name: "comparison target" }),
	).toBeVisible();
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);

	// The branch: Comparison Base puts the base there (the full diff).
	await dot(page, "branch").click();
	const branch = sticky(page, "main");
	await expect(
		branch.getByRole("button", { name: "Comparison Target" }),
	).toHaveAttribute("aria-disabled", "true");
	await branch.getByRole("button", { name: "Comparison Base" }).click();
	await expect(
		node(page, "branch").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	await expect(page).toHaveURL(/from=branch/);

	// A click outside closes a sticky card; so does its dot again.
	await dot(page, "ps1").click();
	await expect(sticky(page, "PS1")).toBeVisible();
	// Outside it: the rail's own corner (the page's heading re-renders
	// under load, and a click on it waited for a detached element).
	await page.getByTestId("psrail").click({ position: { x: 2, y: 2 } });
	await expect(sticky(page, "PS1")).toBeHidden();
	await dot(page, "ps1").click();
	await dot(page, "ps1").click();
	await expect(sticky(page, "PS1")).toBeHidden();
});

test("Comparison Base on a dot right of the target moves both markers side by side, and the address follows; the ends are disabled with why", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	// A review, two pushes and a second patch set: each waits on git.
	test.setTimeout(120_000);
	const p = await pr(fixture);
	const s = await startCrb();
	await pushed(page, workdir, s, p);
	// The first mark on the head starts PS2.
	await toast(page).getByRole("button", { name: "View" }).click();
	const utilS = fileSection(page, "src/util.ts");
	await utilS.getByRole("button", { name: "Expand file" }).click();
	await boxes(utilS).first().click();
	await expect(
		node(page, "ps2").getByRole("button", { name: "comparison target" }),
	).toBeVisible(GIT_WAIT);
	p.moveHead(undo);
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head", GIT_WAIT);
	const on = (id: string, role: "comparison target" | "comparison base") =>
		node(page, id).getByRole("button", { name: role, exact: true });
	const press = async (
		id: string,
		name: string,
		button: "Comparison Base" | "Comparison Target",
	) => {
		await dot(page, id).click();
		await sticky(page, name).getByRole("button", { name: button }).click();
		await expect(sticky(page, name)).toBeHidden();
	};

	// The target back on PS1: the base just left of it, on the branch.
	await press("ps1", "PS1", "Comparison Target");
	await expect(on("ps1", "comparison target")).toBeVisible();
	await expect(on("branch", "comparison base")).toBeVisible();
	await expect(page).toHaveURL(/[?&]ps=1(&|$)/);

	// Comparison Base on PS2, right of the target: the base goes there, the
	// target just right of it, on the head.
	await press("ps2", "PS2", "Comparison Base");
	await expect(on("ps2", "comparison base")).toBeVisible();
	await expect(on("head", "comparison target")).toBeVisible();
	await expect(on("ps1", "comparison target")).toHaveCount(0);
	await expect(page).toHaveURL(/[?&]head=[0-9a-f]{40}/);
	expect(new URL(page.url()).searchParams.has("ps")).toBe(false);
	// Next to each other: the base is the default, no `from`.
	expect(new URL(page.url()).searchParams.has("from")).toBe(false);

	// The rightmost dot can't be the base: disabled, with why.
	await dot(page, "head").click();
	const headBase = sticky(page, "head").getByRole("button", {
		name: "Comparison Base",
	});
	await expect(headBase).toHaveAttribute("aria-disabled", "true");
	await expect(headBase).toHaveAccessibleDescription(
		"Nothing right of it for the comparison target",
	);
	await page.keyboard.press("Escape");

	// Comparison Base on PS1 (left of the target): only the base moves.
	await press("ps1", "PS1", "Comparison Base");
	await expect(on("ps1", "comparison base")).toBeVisible();
	await expect(on("head", "comparison target")).toBeVisible();
	await expect(page).toHaveURL(/[?&]from=1(&|$)/);

	// Comparison Target on PS1 (on the base): the base just left of it.
	await press("ps1", "PS1", "Comparison Target");
	await expect(on("ps1", "comparison target")).toBeVisible();
	await expect(on("branch", "comparison base")).toBeVisible();
	await expect(page).toHaveURL(/[?&]ps=1(&|$)/);
	// The leftmost dot can't be the target: disabled, with why.
	await dot(page, "branch").click();
	const branchTarget = sticky(page, "main").getByRole("button", {
		name: "Comparison Target",
	});
	await expect(branchTarget).toHaveAttribute("aria-disabled", "true");
	await expect(branchTarget).toHaveAccessibleDescription(
		"Nothing left of it for the comparison base",
	);
	await expectNoPageOverflow(page);
});

test("the label and the dot open the same card on hover", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "hover is the mouse's");
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await reviewAll(page);
	await node(page, "ps1").getByTestId("ps-dot-label").hover();
	await expect(card(page)).toContainText("Patch Set 1");
	await expect(card(page)).toHaveCount(1);
	await page.mouse.move(0, 0);
	await expect(card(page)).toHaveCount(0);
	await dot(page, "ps1").locator("span").last().hover();
	await expect(card(page)).toContainText("Patch Set 1");
	await expect(card(page)).toHaveCount(1);
});

test("the branch → PS1 connector counts PS1's commits after a spinner", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await reviewAll(page);
	// The session's count is held unknown at the page's door until released.
	let hold = true;
	await page.route(/\/api\/r\/[^/]+\/(session|head)$/, async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		if (hold) {
			body.patchsets = body.patchsets.map((ps: object) => ({
				...ps,
				commits: null,
			}));
		}
		await route.fulfill({ response, json: body });
	});
	await page.reload();
	const conn = page.getByTestId("ps-conn-ps1");
	await expectLoadingThen({
		loading: conn.getByTestId("ps-conn-counting"),
		empty: [conn.getByText(/^0/)],
		release: () => {
			hold = false;
		},
		result: conn
			.getByTestId("ps-conn-label")
			.getByText(isMobile ? /^1$/ : "1 commit", { exact: true }),
	});
	await expect(conn).toHaveAccessibleName("main to PS1: 1 commit");
});

test("the rail on a phone: 40px targets, no page overflow at 360px", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "the phone's sizes");
	await page.setViewportSize({ width: 360, height: 740 });
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await reviewAll(page);
	p.moveHead(rework);
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head", GIT_WAIT);
	await expectNoPageOverflow(page);
	for (const el of [
		dot(page, "head"),
		dot(page, "ps1"),
		marker(page, "comparison target"),
		marker(page, "comparison base"),
	]) {
		expect(await tapHeight(el)).toBeGreaterThanOrEqual(40);
	}
	// A phone connector shows the bare count.
	await expect(page.getByTestId("ps-conn-head")).toHaveText("1");
	await expect(marker(page, "comparison base")).toHaveText("comp. base");
	await expect(marker(page, "comparison target")).toHaveText("comp. target");
	// A tap: the sticky card, inside the viewport.
	await dot(page, "head").tap();
	const head = sticky(page, "head");
	await expect(head).toBeVisible();
	const box = await head.boundingBox();
	expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
	expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
	await expectNoPageOverflow(page);
	await head.getByRole("button", { name: "Comparison Target" }).tap();
	await expect(
		node(page, "head").getByRole("button", { name: "comparison target" }),
	).toBeVisible();
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);
});

test("the markers move by drag and by Ctrl+[ / Ctrl+]; the base dragged or keyed onto the target pushes it; nothing moves on a bare key", async ({
	page,
	pr,
	startCrb,
}) => {
	// A review, a push and nine moves, each a navigation: past the default
	// under four busy loops (a flake-check timed out at ~50 s).
	test.setTimeout(120_000);
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await reviewAll(page);
	p.moveHead(rework);
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head", GIT_WAIT);

	await drag(page, marker(page, "comparison target"), node(page, "head"));
	await expect(
		node(page, "head").getByRole("button", { name: "comparison target" }),
	).toBeVisible();
	await expect(
		node(page, "ps1").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);

	// A bare bracket is nothing; Ctrl+[ goes back to PS1.
	await page.keyboard.press("[");
	await expect(
		node(page, "head").getByRole("button", { name: "comparison target" }),
	).toBeVisible();
	await page.keyboard.press("Control+[");
	await expect(
		node(page, "ps1").getByRole("button", { name: "comparison target" }),
	).toBeVisible();
	await expect(page).toHaveURL(/ps=1/);
	// The base followed back to the branch (it was "the previous").
	await expect(
		node(page, "branch").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	// Ctrl+] past the newest patch set views the head; the base follows to PS1.
	await page.keyboard.press("Control+]");
	await expect(
		node(page, "head").getByRole("button", { name: "comparison target" }),
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
	const on = (id: string, role: "comparison target" | "comparison base") =>
		node(page, id).getByRole("button", { name: role, exact: true });
	// While dragged, the base's label follows the mouse along the rail.
	const baseMarker = marker(page, "comparison base");
	const start = await baseMarker.boundingBox();
	const ps1Box = await node(page, "ps1").boundingBox();
	if (!start || !ps1Box) throw new Error("no marker");
	await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
	await page.mouse.down();
	const dx = (ps1Box.x + ps1Box.width / 2 - (start.x + start.width / 2)) / 2;
	await page.mouse.move(
		start.x + start.width / 2 + dx,
		start.y + start.height / 2,
		{
			steps: 4,
		},
	);
	await expect
		.poll(async () => ((await baseMarker.boundingBox())?.x ?? 0) - start.x)
		.toBeGreaterThan(dx - 4);
	// Escape: back on its dot, nothing moved.
	await page.keyboard.press("Escape");
	await page.mouse.up();
	await expect
		.poll(async () => Math.round((await baseMarker.boundingBox())?.x ?? 0))
		.toBe(Math.round(start.x));
	await expect(on("branch", "comparison base")).toBeVisible();
	// The head is the rightmost dot: dragging the base there is refused.
	await drag(page, marker(page, "comparison base"), node(page, "head"));
	await expect(
		node(page, "branch").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	// The base dragged onto the target pushes the target just right of it.
	await page.keyboard.press("Control+[");
	await expect(on("ps1", "comparison target")).toBeVisible();
	await expect(on("branch", "comparison base")).toBeVisible();
	await drag(page, marker(page, "comparison base"), node(page, "ps1"));
	await expect(on("ps1", "comparison base")).toBeVisible();
	await expect(on("head", "comparison target")).toBeVisible();
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);
	// So does Ctrl+Shift+] onto the target.
	await page.keyboard.press("Control+[");
	await expect(on("ps1", "comparison target")).toBeVisible();
	await expect(on("branch", "comparison base")).toBeVisible();
	await page.keyboard.press("Control+Shift+]");
	await expect(on("ps1", "comparison base")).toBeVisible();
	await expect(on("head", "comparison target")).toBeVisible();
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);
});

/*
 * Threads (Task 5.3): placed, changed and unplaced threads with their
 * fates, the trailing "Not in this comparison" group, a placement by
 * drag, and the Overview's chips.
 */

/** A thread made on `commit` at `path:line` (RIGHT), by rev1. */
const threadOn = (commit: string, path: string, line: number, text: string) =>
	reviewThread({ path, line, subjectType: "LINE" }, [
		threadComment({ login: "rev1", text, commit, diffHunk: "" }),
	]);

/** Push 2 for the threads: A rewritten, B's line deleted, util.ts untouched. */
const rewriteAndDelete = {
	message: "rewrite and delete",
	files: {
		"src/core.ts": edit(core, { 5: "core 5 reworked", 30: null }),
	},
};

const unplacedRows = (section: Locator) =>
	section.getByTestId("unplaced-thread");

test("threads: a rewritten line is changed with its old lines, a deleted one unplaced under its file with its code, in both views; a drag places it and a reload keeps it; the Overview's chips", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	// A review, a push, both views, a patch set, a reload and the Overview:
	// each step waits on git (GIT_WAIT), so the whole takes longer than 30 s.
	test.setTimeout(120_000);
	const threads: ReturnType<typeof reviewThread>[] = [];
	const p = await pr({ ...fixture, threads });
	const h1 = p.head();
	// A reply on it: behind Show more on its unplaced row.
	const core30 = reviewThread(
		{ path: "src/core.ts", line: 30, subjectType: "LINE" },
		[
			threadComment({
				login: "rev1",
				text: "Is core 30 needed?",
				commit: h1,
				diffHunk: "",
			}),
			threadComment({
				login: "Octo_Cat",
				text: "Yes, for the cache",
				commit: h1,
				diffHunk: "",
			}),
		],
	);
	threads.push(
		threadOn(h1, "src/core.ts", 5, "Why change core 5?"),
		core30,
		threadOn(h1, "src/util.ts", 3, "util 3 looks fine"),
	);
	p.editScenario((sc) => {
		const graph = sc.prs[7]?.graphql;
		if (graph) graph.reviewThreads = threads;
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	await reviewAll(page);
	p.moveHead(rewriteAndDelete);
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head", GIT_WAIT);
	await toast(page).getByRole("button", { name: "View" }).click();
	await expect(
		node(page, "head").getByRole("button", { name: "comparison target" }),
	).toBeVisible();

	// The since view (PS1 → the head): core.ts's rewritten line carries its
	// thread, changed; the deleted line's thread is listed under the header.
	const coreS = fileSection(page, "src/core.ts");
	await coreS.getByRole("button", { name: "Expand file" }).click();
	const checkCore = async () => {
		const rewritten = coreS
			.getByTestId("diff-line")
			.filter({ hasText: "core 5 reworked" });
		const bubble = rewritten.getByRole("button", { name: /1 comment/ });
		await expect(bubble).toBeVisible(GIT_WAIT);
		// Opened once, it stays open across the views (by its line).
		if ((await bubble.getAttribute("aria-expanded")) !== "true") {
			await bubble.click();
		}
		const card = coreS
			.getByTestId("files-thread")
			.filter({ hasText: "Why change core 5?" });
		await expect(card.getByTestId("placement-changed")).toHaveText(
			"changed since",
		);
		await expect(card.getByTestId("placement-changed-line")).toHaveText([
			/core 5 changed/,
			/core 5 reworked/,
		]);
		await expect(card.getByTestId("placement-fate-line")).toContainText(
			"Line rewritten since PS1",
		);
		await expect(card.getByRole("link", { name: "See on PS1" })).toBeVisible();
		const row = unplacedRows(coreS);
		await expect(row).toHaveCount(1);
		await expect(row).toHaveAttribute("data-fate", "deleted");
		// The fate in a sentence on the top row.
		await expect(row.getByTestId("unplaced-fate")).toHaveText(
			"Commented line has been deleted since the review",
		);
		// The first comment at once, the reply behind Show more.
		await expect(row.getByTestId("thread-body")).toContainText(
			"Is core 30 needed?",
		);
		await expect(row.getByText("Yes, for the cache")).toHaveCount(0);
		const more = row.getByRole("button", { name: /^Show more/ });
		await expect(more).toContainText("1 reply");
		await more.click();
		await expect(row.getByText("Yes, for the cache")).toBeVisible();
		await row.getByRole("button", { name: "Show less" }).click();
		await expect(row.getByText("Yes, for the cache")).toHaveCount(0);
		// The code in its titled box.
		await expect(row.getByTestId("original-code-title")).toHaveText(
			"Original Reviewed Change",
		);
		await expect(row.getByTestId("original-code-label")).toHaveText(
			"PS1 · src/core.ts · line 30",
		);
		await expect(
			row
				.getByTestId("original-code-line")
				.filter({ hasText: "core 30 changed" }),
		).toHaveAttribute("data-marked", "true");
		await expect(row.getByTestId("original-code-line")).toHaveCount(5);
		await expect(row.getByTestId("near-line")).toHaveText("near 29");
		// No handle on a head that is no patch set yet.
		await expect(row.getByTestId("place-handle")).toHaveCount(0);
	};
	await checkCore();
	await expectNoPageOverflow(page);
	if (isMobile) {
		// At 360px: no page overflow, the sentence on one line.
		const size = page.viewportSize();
		await page.setViewportSize({ width: 360, height: size?.height ?? 740 });
		await expectNoPageOverflow(page);
		const fate = unplacedRows(coreS).getByTestId("unplaced-fate");
		expect((await fate.boundingBox())?.height ?? 99).toBeLessThan(24);
		if (size) await page.setViewportSize(size);
	}
	// The full diff shows them the same way.
	await page.keyboard.press("Control+Shift+[");
	await expect(
		node(page, "branch").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	await checkCore();

	// The first mark starts PS2; a drag puts the deleted line's thread on
	// core 4, written, and a reload keeps it there.
	await boxes(coreS).first().click();
	await expect(
		node(page, "ps2").getByRole("button", { name: "comparison target" }),
	).toBeVisible();
	const row = unplacedRows(coreS);
	const handle = row.getByTestId("place-handle");
	await expect(handle).toBeVisible(GIT_WAIT);
	// The since view numbers its old side by the interdiff, no file's: no
	// drag there (the row stays, its handle goes); back in the full diff.
	await baseOn(page, "ps1", "]");
	await expect(row).toHaveCount(1);
	await expect(row).toContainText("Is core 30 needed?");
	await expect(row.getByTestId("place-handle")).toHaveCount(0);
	await baseOn(page, "branch", "[");
	await expect(handle).toBeVisible();
	if (isMobile) {
		expect((await handle.boundingBox())?.height).toBeGreaterThanOrEqual(40);
		expect((await row.boundingBox())?.height).toBeGreaterThanOrEqual(40);
	}
	const target = coreS
		.getByTestId("diff-line")
		.filter({ hasText: /^.*core 4$/ });
	// The handle and the line both on screen (the first hunk sits right
	// under the list, below the row's code and first comment): the handle
	// a third of the way down, clear of the sticky headers.
	await handle.evaluate((el) => {
		const top = el.getBoundingClientRect().top;
		window.scrollBy(0, top - window.innerHeight * 0.3);
	});
	await expect(target).toBeInViewport();
	await drag(page, handle, target);
	await expect(unplacedRows(coreS)).toHaveCount(0);
	await expect(
		target.getByRole("button", { name: /2 comments/ }),
	).toBeVisible();
	await page.reload();
	const reloaded = fileSection(page, "src/core.ts");
	await reloaded.getByRole("button", { name: "Expand file" }).click();
	await expect(
		reloaded
			.getByTestId("diff-line")
			.filter({ hasText: /^.*core 4$/ })
			.getByRole("button", { name: /2 comments/ }),
	).toBeVisible(GIT_WAIT);
	await expect(unplacedRows(reloaded)).toHaveCount(0);
	await expectNoPageOverflow(page);

	// The Overview: the opened-on chip, the changed chip and its fate line.
	await page.getByRole("link", { name: "Overview" }).click();
	const card = page
		.getByTestId("thread")
		.filter({ hasText: "Why change core 5?" });
	await expect(card.getByTestId("opened-on")).toHaveText("PS1", GIT_WAIT);
	await expect(card.getByTestId("placement-changed")).toHaveText(
		"changed since",
	);
	await expect(card.getByTestId("placement-fate-line")).toContainText(
		"Line rewritten since PS1",
	);
	const fine = page
		.getByTestId("thread")
		.filter({ hasText: "util 3 looks fine" });
	await expect(fine.getByTestId("opened-on")).toHaveText("PS1");
	await expect(fine.getByTestId("placement-changed")).toHaveCount(0);
	await expectNoPageOverflow(page);
});

/** Moves the comparison base onto dot `id` (Ctrl+Shift+[ / ]), as many steps as it takes. */
async function baseOn(page: Page, id: string, key: "[" | "]") {
	const base = node(page, id).getByRole("button", { name: "comparison base" });
	await expect(async () => {
		if ((await base.count()) === 0) {
			await page.keyboard.press(`Control+Shift+${key}`);
		}
		await expect(base).toBeVisible({ timeout: 1000 });
	}).toPass();
}

/** Views the newer head from the toast and marks its first cluster: the next patch set. */
async function startNext(page: Page, n: number, path: string) {
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head", GIT_WAIT);
	await toast(page).getByRole("button", { name: "View" }).click();
	// The comparison base onto the branch: the full diff.
	await baseOn(page, "branch", "[");
	const section = fileSection(page, path);
	await section.getByRole("button", { name: "Expand file" }).click();
	const box = boxes(section).first();
	await box.click();
	await expect(
		node(page, `ps${n}`).getByRole("button", { name: "comparison target" }),
	).toBeVisible(GIT_WAIT);
	// A mark that finished the file closed it already (the page moved on).
	const collapse = section.getByRole("button", { name: "Collapse file" });
	if (await collapse.isVisible()) await collapse.click();
}

test("a thread of a file deleted two patch sets earlier is under Not in this comparison on PS3 and PS4, in both views; a quiet line once resolved, back once unresolved", async ({
	page,
	pr,
	startCrb,
}) => {
	// Four patch sets, each a push the head check fetches and a first mark
	// the engine answers (GIT_WAIT each), then two Refreshes.
	test.setTimeout(180_000);
	const threads: ReturnType<typeof reviewThread>[] = [];
	const p = await pr({
		...fixture,
		files: [
			{
				message: "PR change",
				files: {
					"src/core.ts": edit(core, { 5: "core 5 changed" }),
					"src/legacy.ts": text(["one", "two", "three", "four", "five"]),
				},
			},
		],
		threads,
	});
	threads.push(
		threadOn(p.head(), "src/legacy.ts", 3, "Clear the timer here too"),
	);
	p.editScenario((sc) => {
		const graph = sc.prs[7]?.graphql;
		if (graph) graph.reviewThreads = threads;
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	// PS1: one mark starts it.
	const coreS = await expand(page, "src/core.ts");
	// Its one cluster: the mark finishes the file, which closes.
	await boxes(coreS).first().click();
	await expect(
		coreS.getByRole("button", { name: "Expand file" }),
	).toBeVisible();
	// PS2 deletes the file; PS3 and PS4 change core.ts again.
	p.moveHead({
		message: "drop legacy",
		files: { "src/core.ts": edit(core, { 5: "core 5 changed", 7: "core 7" }) },
		delete: ["src/legacy.ts"],
	});
	await startNext(page, 2, "src/core.ts");
	p.moveHead({
		message: "again",
		files: {
			"src/core.ts": edit(core, {
				5: "core 5 changed",
				7: "core 7",
				9: "core 9",
			}),
		},
	});
	await startNext(page, 3, "src/core.ts");
	const group = page.getByTestId("not-in-comparison");
	const expectGroup = async () => {
		await expect(group).toBeVisible(GIT_WAIT);
		await expect(group).toContainText("Not in this comparison");
		await expect(group).toContainText("1 thread");
		const row = group.getByTestId("unplaced-thread");
		await expect(row).toHaveAttribute("data-fate", "file-gone");
		await expect(row).toContainText("src/legacy.ts");
		await expect(row.getByTestId("unplaced-fate")).toHaveText(
			"Commented file has been deleted since the review",
		);
		await expect(row).toContainText("Clear the timer here too");
		await expect(row.getByTestId("original-code-label")).toHaveText(
			"PS1 · src/legacy.ts · line 3",
		);
		await expectNoPageOverflow(page);
	};
	// PS3, full diff and since PS2.
	await expectGroup();
	await baseOn(page, "ps2", "]");
	await expectGroup();
	p.moveHead({
		message: "and again",
		files: {
			"src/core.ts": edit(core, {
				5: "core 5 changed",
				7: "core 7",
				9: "core 9",
				11: "core 11",
			}),
		},
	});
	await startNext(page, 4, "src/core.ts");
	await expectGroup();
	await baseOn(page, "ps3", "]");
	await expectGroup();
	// Its first comment shows at once; Show more opens the rest.
	const legacy = group.getByTestId("unplaced-thread");
	await expect(legacy.getByTestId("thread-body")).toContainText(
		"Clear the timer here too",
	);
	await legacy.getByRole("button", { name: /^Show more/ }).click();
	await expect(legacy.getByRole("button", { name: "Show less" })).toBeVisible();

	// Resolved on GitHub: a quiet line in the group, counted nowhere;
	// unresolved: the full row again.
	const setResolved = (resolved: boolean) =>
		p.editScenario((sc) => {
			const t = sc.prs[7]?.graphql?.reviewThreads?.[0] as
				| { isResolved: boolean }
				| undefined;
			if (t) t.isResolved = resolved;
		});
	setResolved(true);
	await page.getByRole("button", { name: "Refresh" }).first().click();
	await expect(group.getByTestId("unplaced-collapsed")).toBeVisible(GIT_WAIT);
	await expect(group.getByTestId("unplaced-collapsed")).toHaveText(
		"File deleted · src/legacy.ts · rev1",
	);
	await expect(group).not.toContainText("1 thread");
	await expect(group.getByTestId("original-code")).toHaveCount(0);
	setResolved(false);
	await page.getByRole("button", { name: "Refresh" }).first().click();
	await expectGroup();
});

/** PS1 reviewed with threads on it, then pushed: viewing the head in the full diff. */
test("a resolved thread keeps carrying: on a later head it shows on its traced line, muted", async ({
	page,
	pr,
	startCrb,
}) => {
	// A review, a push and the placements: each waits on git.
	test.setTimeout(120_000);
	const threads: ReturnType<typeof reviewThread>[] = [];
	const p = await pr({ ...fixture, threads });
	const settled = threadOn(p.head(), "src/util.ts", 3, "Settled already");
	settled.isResolved = true;
	p.editScenario((sc) => {
		const graph = sc.prs[7]?.graphql;
		if (graph) graph.reviewThreads = [settled];
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	await reviewAll(page);
	// util 3 untouched by the push: the thread's line is traced to the head.
	p.moveHead(rework);
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head", GIT_WAIT);
	await toast(page).getByRole("button", { name: "View" }).click();
	await baseOn(page, "branch", "[");
	const utilS = fileSection(page, "src/util.ts");
	await utilS.getByRole("button", { name: "Expand file" }).click();
	const bubble = utilS
		.getByTestId("diff-line")
		.filter({ hasText: "util 3 changed" })
		.getByTestId("thread-bubble");
	await expect(bubble).toHaveAccessibleName(
		/^1 comment.*, resolved$/,
		GIT_WAIT,
	);
	// Muted: the resolved look, no attention colour.
	await expect(bubble.locator("span").first()).toHaveClass(/text-muted/);
	await bubble.click();
	await expect(
		utilS.getByTestId("files-thread").filter({ hasText: "Settled already" }),
	).toContainText("Resolved");
	// Nowhere else: not unplaced, not out of the comparison.
	await expect(unplacedRows(utilS)).toHaveCount(0);
	await expect(page.getByTestId("not-in-comparison")).toHaveCount(0);
});

async function threadsPushed(
	page: Page,
	pr: (o: PrOptions) => Promise<Pr>,
	startCrb: () => Promise<{ url: string }>,
	/** The opening texts of the PS1 threads resolved on GitHub. */
	resolved: string[] = [],
) {
	const threads: ReturnType<typeof reviewThread>[] = [];
	const p = await pr({ ...fixture, threads });
	const h1 = p.head();
	threads.push(
		threadOn(h1, "src/core.ts", 5, "Why change core 5?"),
		threadOn(h1, "src/core.ts", 30, "Is core 30 needed?"),
	);
	const s = await startCrb();
	await openFiles(page, s.url);
	await reviewAll(page);
	const h2 = p.moveHead(rewriteAndDelete);
	// One thread made on the new head itself: it shows at once.
	threads.push(threadOn(h2, "src/util.ts", 3, "On the head"));
	for (const t of threads) {
		if (resolved.some((text) => JSON.stringify(t).includes(text)))
			t.isResolved = true;
	}
	p.editScenario((sc) => {
		const graph = sc.prs[7]?.graphql;
		if (graph) graph.reviewThreads = threads;
	});
	// A fresh read of GitHub (the page reuses a recent one): the new thread in.
	const url = new URL(s.url);
	const id = url.pathname.split("/r/")[1]?.replace(/\/.*/, "") ?? "";
	const fresh = await page.request.get(
		`${url.origin}/api/r/${id}/overview?maxAge=0${url.search.replace("?", "&")}`,
	);
	expect(fresh.ok()).toBe(true);
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head", GIT_WAIT);
	return p;
}

test("resolving an unplaced thread from its row folds it into one quiet line, kept after a reload; expanded and unresolved, it is the full row again", async ({
	page,
	pr,
	startCrb,
}) => {
	// A review, a push, the engine, two writes and three reloads.
	test.setTimeout(150_000);
	const p = await threadsPushed(page, pr, startCrb);
	// On GitHub before a reload reads it back.
	const stored = () => {
		const sc = JSON.parse(readFileSync(p.scenarioPath, "utf8")) as {
			prs: Record<string, { graphql?: { reviewThreads?: unknown[] } }>;
		};
		const t = (sc.prs[7]?.graphql?.reviewThreads ?? []).find((x) =>
			JSON.stringify(x).includes("Is core 30 needed?"),
		) as { isResolved?: boolean } | undefined;
		return t?.isResolved;
	};
	await toast(page).getByRole("button", { name: "View" }).click();
	await baseOn(page, "branch", "[");
	const open = async () => {
		const coreS = fileSection(page, "src/core.ts");
		const toggle = coreS
			.getByRole("button", { name: /^(Expand|Collapse) file$/ })
			.first();
		await expect(toggle).toBeVisible(GIT_WAIT);
		if ((await toggle.getAttribute("aria-label")) === "Expand file")
			await toggle.click();
		const row = unplacedRows(coreS).filter({ hasText: /core 30|Line deleted/ });
		await expect(row).toHaveCount(1, GIT_WAIT);
		return row;
	};
	let row = await open();
	await expect(row.getByTestId("unplaced-fate")).toBeVisible();
	await row.getByRole("button", { name: /^Show more/ }).click();
	await row.getByRole("button", { name: "Resolve", exact: true }).click();
	// One quiet line: no code, no comment.
	const quiet = row.getByTestId("unplaced-collapsed");
	await expect(quiet).toBeVisible();
	await expect(quiet).toHaveText("Line deleted · rev1");
	await expect(row.getByTestId("original-code")).toHaveCount(0);
	await expect(row.getByTestId("unplaced-opener")).toHaveCount(0);
	await expectNoPageOverflow(page);
	// Kept after a reload (GitHub has it resolved now).
	await expect.poll(stored).toBe(true);
	await page.reload();
	row = await open();
	await expect(row.getByTestId("unplaced-collapsed")).toBeVisible();
	// Expanded: the full row, and its Unresolve.
	await row.getByTestId("unplaced-collapsed").click();
	await expect(row.getByTestId("original-code-title")).toBeVisible();
	await expect(row.getByTestId("thread-body")).toContainText(
		"Is core 30 needed?",
	);
	await row.getByRole("button", { name: /^Show more/ }).click();
	await row.getByRole("button", { name: "Unresolve", exact: true }).click();
	await expect(row.getByTestId("unplaced-fate")).toHaveText(
		"Commented line has been deleted since the review",
	);
	await expect(row.getByTestId("unplaced-collapse")).toHaveCount(0);
	await expect.poll(stored).toBe(false);
	await page.reload();
	row = await open();
	await expect(row.getByTestId("unplaced-fate")).toBeVisible();
	await expect(row.getByTestId("unplaced-collapsed")).toHaveCount(0);
});

test("until the placements arrive a card spins in its chip slot and no thread reads as unplaced or outside; then they land", async ({
	page,
	pr,
	startCrb,
}) => {
	// A review, a push, the engine and the held placements: longer than 30 s.
	test.setTimeout(120_000);
	await threadsPushed(page, pr, startCrb);
	let release = () => {};
	const held = new Promise<void>((r) => {
		release = r;
	});
	await page.route("**/api/r/*/placements?*", async (route) => {
		await held;
		await route.continue();
	});
	await toast(page).getByRole("button", { name: "View" }).click();
	await baseOn(page, "branch", "[");
	const coreS = fileSection(page, "src/core.ts");
	const utilS = fileSection(page, "src/util.ts");
	await coreS.getByRole("button", { name: "Expand file" }).click();
	await expectLoadingThen({
		loading: page.getByTestId("not-in-comparison-loading"),
		empty: [
			page.getByTestId("unplaced-thread"),
			page.getByTestId("not-in-comparison"),
			coreS.getByTestId("placement-changed"),
		],
		release: async () => {
			// The head's own thread shows where it was made, its chip slot spinning.
			await utilS.getByRole("button", { name: "Expand file" }).click();
			await utilS
				.getByTestId("diff-line")
				.filter({ hasText: "util 3 changed" })
				.getByRole("button", { name: /1 comment/ })
				.click();
			const card = utilS
				.getByTestId("files-thread")
				.filter({ hasText: "On the head" });
			await expect(
				card.getByRole("status", { name: "Placing threads" }),
			).toBeVisible();
			// core.ts again (one file is open at a time), still with no list.
			await coreS.getByRole("button", { name: "Expand file" }).click();
			await expect(coreS.getByTestId("diff-line").first()).toBeVisible();
			await expect(unplacedRows(coreS)).toHaveCount(0);
			// Held no longer: this and every later ask goes through.
			release();
		},
		result: unplacedRows(coreS).filter({ hasText: "Is core 30 needed?" }),
		...GIT_WAIT,
	});
	await expect(
		page.getByRole("status", { name: "Placing threads" }),
	).toHaveCount(0, GIT_WAIT);
	await expect(page.getByTestId("not-in-comparison")).toHaveCount(0);
});

test("when the placements fail every thread stays listed with the error and a retry, never gone; a resolved one as a quiet line after the rest, counted nowhere", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	test.setTimeout(120_000);
	expectConsoleError(/500/);
	await threadsPushed(page, pr, startCrb, ["Why change core 5?"]);
	await page.route("**/api/r/*/placements?*", (route) =>
		route.fulfill({
			status: 500,
			contentType: "application/json",
			body: JSON.stringify({ error: "git failed" }),
		}),
	);
	await toast(page).getByRole("button", { name: "View" }).click();
	await baseOn(page, "branch", "[");
	const failed = page.getByTestId("placements-failed");
	await expect(failed).toBeVisible(GIT_WAIT);
	await expect(failed).toContainText("Thread places couldn't be computed");
	// The two PS1 threads, by their file; not the head's own (it shows on its line).
	const rows = failed.getByTestId("unplaced-thread");
	await expect(rows).toHaveCount(2);
	const open = rows.first();
	await expect(open).toContainText("Is core 30 needed?");
	await expect(open).toHaveAttribute("data-fate", "unknown");
	await expect(open).toContainText("src/core.ts");
	// The resolved one: listed too, a quiet line after it, counted nowhere.
	const quiet = rows.nth(1);
	await expect(quiet).toHaveAttribute("data-resolved", "true");
	const line = quiet.getByTestId("unplaced-collapsed");
	await expect(line).toHaveText("Place unknown · src/core.ts · rev1");
	await expect(line).toHaveClass(/text-muted/);
	await expect(failed).toContainText("1 thread");
	await expect(failed).not.toContainText("2 threads");
	await line.click();
	await expect(quiet.getByTestId("thread-body")).toContainText(
		"Why change core 5?",
	);
	await expect(page.getByTestId("not-in-comparison")).toHaveCount(0);
	await expectNoPageOverflow(page);
	// Retry once it works, held at first: a spinner in the Retry's slot, the
	// list kept, then the threads land where they belong.
	await page.unroute("**/api/r/*/placements?*");
	let release = () => {};
	const held = new Promise<void>((r) => {
		release = r;
	});
	await page.route("**/api/r/*/placements?*", async (route) => {
		await held;
		await route.continue();
	});
	const coreS = fileSection(page, "src/core.ts");
	await failed.getByRole("button", { name: "Retry" }).click();
	await expectLoadingThen({
		loading: failed.getByRole("status", { name: "Retrying" }),
		empty: [failed.getByRole("button", { name: "Retry" })],
		release: async () => {
			await expect(failed).toHaveAttribute("aria-busy", "true");
			await expect(rows).toHaveCount(2);
			await coreS.getByRole("button", { name: "Expand file" }).click();
			release();
		},
		result: unplacedRows(coreS).filter({ hasText: "Is core 30 needed?" }),
		...GIT_WAIT,
	});
	await expect(failed).toHaveCount(0);
});

/** The PR's reviews as the fake gh keeps them (a verdict appends one). */
const storedReviews = (p: Pr) =>
	(
		JSON.parse(readFileSync(p.scenarioPath, "utf8")) as {
			prs: Record<
				string,
				{ graphql?: { reviews?: { state: string; commit: { oid: string } }[] } }
			>;
		}
	).prs[7]?.graphql?.reviews ?? [];

const verdictCard = (page: Page) => page.getByTestId("verdict-card-tab");

/**
 * PS1 fully reviewed and approved in carbonless, then `push` (a commit,
 * or a force-push when `force`); the page reloaded on the Final Verdict
 * tab with the head newer. `kept` is the fixture's review list: the
 * approval goes into it, so the fake gh keeps serving it after the push.
 */
async function approvedThenPushed(
	page: Page,
	s: { url: string },
	p: Pr,
	kept: unknown[],
	push: () => string,
	/** Before the reload, e.g. a route that holds the engine's answer. */
	beforeReload: () => Promise<void> = async () => {},
) {
	await openFiles(page, s.url);
	await reviewAll(page);
	const ps1 = p.head();
	await page.getByRole("link", { name: "Final Verdict" }).click();
	const card = verdictCard(page);
	await card.getByRole("button", { name: "Approve", exact: true }).click();
	await expect(card.getByTestId("your-verdict")).toContainText("You approved");
	await expect.poll(() => storedReviews(p).length).toBe(1);
	kept.push(...storedReviews(p));
	const head = push();
	await beforeReload();
	await page.reload();
	// The head check finds the push (git), then the engine's answer.
	await expect(card.getByTestId("verdict-since")).toBeVisible(GIT_WAIT);
	return { ps1, head };
}

test("the verdict tab says what changed since your approval, with the patch set's meter; Approve goes on the new head", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	const kept: unknown[] = [];
	const p = await pr({ ...fixture, reviews: kept });
	const s = await startCrb();
	const { ps1, head } = await approvedThenPushed(page, s, p, kept, () =>
		p.moveHead(rework),
	);
	const card = verdictCard(page);
	await expect(card.getByTestId("your-verdict")).toHaveText(
		new RegExp(`^You approved ${ps1.slice(0, 7)} \\(PS1\\), `),
	);
	await expect(card.getByTestId("verdict-since")).toHaveAttribute(
		"data-state",
		"changed",
		GIT_WAIT,
	);
	await expect(card.getByTestId("verdict-since")).toHaveText(
		"Since then: 1 commit · 2 files · 1 reworked, 1 new cluster",
	);
	// No patch set on the head yet: no meter; the verdict would start it.
	await expect(card.getByTestId("verdict-since-meter")).toHaveCount(0);
	await expect(card.getByTestId("verdict-older")).toHaveCount(0);
	await expectNoPageOverflow(page);
	const approve = card.getByRole("button", {
		name: `Approve ${head.slice(0, 7)}`,
	});
	expect((await approve.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
	const link = card
		.getByTestId("your-verdict")
		.getByRole("link", { name: ps1.slice(0, 7) });
	await expect(link).toHaveAttribute(
		"href",
		/^https:\/\/github\.com\/acme\/widget\/pull\/7#pullrequestreview-\d+$/,
	);
	if (isMobile) {
		await page.setViewportSize({ width: 360, height: 740 });
		await expectNoPageOverflow(page);
		// A tap target, though it sits in a line of text (principle 5);
		// mid-window, clear of the toast fixed at the bottom.
		await link.evaluate((n) => n.scrollIntoView({ block: "center" }));
		expect(await tapHeight(link)).toBeGreaterThanOrEqual(40);
	}

	// Reading on the head starts PS2: the since names it, with its meter.
	await page.getByRole("link", { name: "Files changed" }).click();
	await expect(progress(page)).toBeVisible();
	// Ctrl+] past the newest patch set views the head.
	await page.keyboard.press("Control+]");
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/);
	const utilS = fileSection(page, "src/util.ts");
	await utilS.getByRole("button", { name: "Expand file" }).click();
	await boxes(utilS).first().click();
	await expect(
		node(page, "ps2").getByRole("button", { name: "comparison target" }),
	).toBeVisible();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	expect(reviewRefs(workdir)).toContain("/patchsets/2 ");
	await page.getByRole("link", { name: "Final Verdict" }).click();
	await expect(card.getByTestId("verdict-since-meter")).toHaveText(
		/\d+ \/ \d+ on PS2/,
		GIT_WAIT,
	);
	await expect(card.getByTestId("verdict-since")).toContainText(
		"1 reworked, 1 new cluster",
	);

	await approve.click();
	await expect.poll(() => storedReviews(p).length).toBe(2);
	expect(storedReviews(p).map((r) => r.commit.oid)).toEqual([ps1, head]);
	// A verdict on the head the PR is on: nothing since.
	await expect(card.getByTestId("verdict-since")).toHaveCount(0);
	await expect(card.getByTestId("your-verdict")).toContainText("You approved");
});

test("an identical diff force-pushed (a squash on the same base): same diff · nothing to re-read; Approve again posts on the new head and starts PS2", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	const kept: unknown[] = [];
	const p = await pr({ ...fixture, reviews: kept });
	const s = await startCrb();
	const first = fixture.files?.[0];
	if (!first) throw new Error("no PR commit");
	const { ps1, head } = await approvedThenPushed(page, s, p, kept, () =>
		p.forceHead({ ...first, message: "PR change, squashed" }),
	);
	const card = verdictCard(page);
	// The same merge base, other commits: the engine calls it a squash (S5).
	await expect(card.getByTestId("verdict-since")).toHaveText(
		"Squashed, same diff · nothing to re-read",
		GIT_WAIT,
	);
	await expect(card.getByTestId("your-verdict")).toContainText(
		`You approved ${ps1.slice(0, 7)} (PS1)`,
	);
	const again = card.getByRole("button", {
		name: `Approve again on ${head.slice(0, 7)}`,
	});
	await expect(again).toBeVisible();
	expect((await again.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
	await expectNoPageOverflow(page);
	const before = reviewRefs(workdir);
	expect(before).not.toContain("/patchsets/2 ");

	await again.click();
	await expect.poll(() => storedReviews(p).length).toBe(2);
	const posted = storedReviews(p).at(-1);
	expect(posted?.state).toBe("APPROVED");
	expect(posted?.commit.oid).toBe(head);
	// The verdict started PS2 on the new head, every mark carried.
	expect(reviewRefs(workdir)).toContain("/patchsets/2 ");
	await expect(card.getByTestId("verdict-since")).toHaveCount(0);
	await page.getByRole("link", { name: "Files changed" }).click();
	await expect(
		node(page, "ps2").getByRole("button", { name: "comparison target" }),
	).toBeVisible();
	await expect(tail(page)).toHaveAttribute("data-state", "up-to-date");
	// The since view (PS1 → PS2): the same diff, nothing of its own to count.
	await expect(progress(page)).toHaveText("Nothing to read");
});

test("a new thread on the viewed head starts PS2 and the page follows: the PS2 dot, up to date, PS1 read-only", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	await pushed(page, workdir, s, p);
	await page.keyboard.press("Control+]");
	await expect(page).toHaveURL(/head=[0-9a-f]{40}/, GIT_WAIT);
	expect(reviewRefs(workdir)).not.toContain("/patchsets/2 ");
	const section = fileSection(page, "src/util.ts");
	await section.getByRole("button", { name: "Expand file" }).click();
	await section.getByRole("button", { name: "Comment on file" }).click();
	const composer = section.getByTestId("new-thread");
	await composer.getByRole("textbox", { name: "Comment" }).fill("On the head");
	await composer.getByRole("button", { name: "Comment" }).click();
	await expect(section.getByTestId("new-thread")).toHaveCount(0);
	await expect.poll(() => reviewRefs(workdir)).toContain("/patchsets/2 ");
	// No reload: the thread's answer brings the session and the review in.
	await expect(
		node(page, "ps2").getByRole("button", { name: "comparison target" }),
	).toBeVisible();
	await expect(tail(page)).toHaveAttribute("data-state", "up-to-date");
	await expect(page).toHaveURL(/ps=2/);
	// PS1 is an earlier patch set now: read-only, its boxes locked.
	await page.keyboard.press("Control+[");
	await expect(page).toHaveURL(/ps=1/);
	await expect(page.getByTestId("read-only-note")).toContainText(
		"PS1 · as reviewed · read-only",
	);
	const coreS = fileSection(page, "src/core.ts");
	await coreS.getByRole("button", { name: "Expand file" }).click();
	await expect(boxes(coreS).first()).toBeDisabled();
	await expect(
		coreS.getByTestId("diff-line").filter({ hasText: "core 5 reworked" }),
	).toHaveCount(0);
});

test("the since line spins while the engine computes, never says nothing or 0, then the counts", async ({
	page,
	pr,
	startCrb,
}) => {
	const kept: unknown[] = [];
	const p = await pr({ ...fixture, reviews: kept });
	const s = await startCrb();
	// The engine runs in crb: its pending answers pass, any finished one
	// waits here until released (then read afresh), so the pending state
	// stays on screen for as long as the test looks.
	let released = false;
	let release = () => {};
	const held = new Promise<void>((r) => {
		release = r;
	});
	const route = "**/api/r/*/verdict*";
	const hold = async () => {
		await page.route(route, async (r) => {
			if (r.request().method() !== "GET") return r.continue();
			const res = await r.fetch();
			const body = (await res.json()) as {
				since: { changes: { status: string } } | null;
			};
			if (released || !body.since || body.since.changes.status === "pending") {
				return r.fulfill({ response: res, json: body });
			}
			await held;
			return r.fulfill({ response: await r.fetch() });
		});
	};
	await approvedThenPushed(page, s, p, kept, () => p.moveHead(rework), hold);
	const card = verdictCard(page);
	await expectLoadingThen({
		...GIT_WAIT,
		loading: card
			.getByTestId("verdict-since")
			.getByRole("status", { name: "Comparing with your verdict" }),
		empty: [
			card.getByText(/nothing to re-read/),
			card.getByTestId("verdict-since").getByText(/\b0 /),
			card.locator('[data-testid="verdict-since"][data-state="same"]'),
		],
		release: () => {
			released = true;
			release();
			return page.unroute(route);
		},
		result: card.locator('[data-testid="verdict-since"][data-state="changed"]'),
	});
	await expect(card.getByTestId("verdict-since")).toHaveText(
		"Since then: 1 commit · 2 files · 1 reworked, 1 new cluster",
	);
});

/*
 * Pieces (marks per piece, brief 8): one file whose PS1 adds a block, two
 * changes next to each other and two lines; PS2 edits the block in three
 * places (one cluster, three pieces), merges the two changes into one
 * cluster that deletes more base lines and keeps one line the same as a
 * reviewed PS1 line (a removal-only piece inside a PS2 cluster), and takes
 * the two added lines out again (reverted).
 */
const piecesBase = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
const piecesBlock = Array.from({ length: 10 }, (_, i) => `block ${i + 1}`);
const splice = (lines: string[], at: number, remove: number, add: string[]) => {
	const copy = [...lines];
	copy.splice(at, remove, ...add);
	return copy;
};
const piecesPs1 = splice(
	splice(
		splice(splice(piecesBase, 30, 0, ["added 1", "added 2"]), 14, 1, ["b new"]),
		9,
		4,
		["a 1", "a 2", "a 3", "a 4", "a 5"],
	),
	5,
	0,
	piecesBlock,
);
const piecesPs2 = splice(
	splice(piecesBase, 9, 6, ["b new"]),
	5,
	0,
	piecesBlock.map((l, i) => ([1, 5, 8].includes(i) ? `${l}!` : l)),
);
const PIECES = "src/pieces.ts";
const piecesFixture: PrOptions = {
	base: { [PIECES]: text(piecesBase) },
	files: [{ message: "PS1", files: { [PIECES]: text(piecesPs1) } }],
};
const piecesPush = { message: "PS2", files: { [PIECES]: text(piecesPs2) } };

/** PS1 fully reviewed, PS2 pushed, the since view open on the file. */
async function piecesSince(
	page: Page,
	s: { url: string },
	p: { moveHead: (c: FixtureCommit) => string },
) {
	await openFiles(page, s.url);
	const section = await expand(page, PIECES);
	const all = boxes(section);
	await expect(all).toHaveCount(4);
	for (let i = 0; i < 3; i++) {
		await all.nth(i).click();
		await expect(all.nth(i)).toBeChecked();
	}
	// The last mark finishes the file, which closes.
	await all.nth(3).click();
	await expect(
		section.getByRole("button", { name: "Expand file" }),
	).toBeVisible();
	await expect(progress(page)).toHaveAttribute("aria-valuenow", "100");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	p.moveHead(piecesPush);
	await page.reload();
	await expect(tail(page)).toHaveAttribute("data-state", "head", GIT_WAIT);
	await toast(page).getByRole("button", { name: "View" }).click();
	await expect(
		node(page, "ps1").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	const since = fileSection(page, PIECES);
	await expect(toRead(page)).toHaveText(/5 to read/, GIT_WAIT);
	await since.getByRole("button", { name: "Expand file" }).click();
	// Three pieces of the block, the removal inside the merged cluster, the revert.
	await expect(boxes(since)).toHaveCount(5, GIT_WAIT);
	return since;
}

const toFullDiff = async (page: Page) => {
	await page.keyboard.press("Control+Shift+[");
	await expect(
		node(page, "branch").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
};
const toSince = async (page: Page) => {
	await page.keyboard.press("Control+Shift+]");
	await expect(
		node(page, "ps1").getByRole("button", { name: "comparison base" }),
	).toBeVisible();
};

test("a cluster in three pieces: each piece marks only itself; the full diff shows it mixed until all are marked; an untick is mixed again; a reload keeps it", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr(piecesFixture);
	const s = await startCrb();
	const since = await piecesSince(page, s, p);
	const all = boxes(since);
	await all.nth(0).click();
	await expect(all.nth(0)).toBeChecked();
	await expect(all.nth(1)).not.toBeChecked();
	await expect(all.nth(2)).not.toBeChecked();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);

	// The full diff: the block's cluster mixed, its first piece's lines green.
	await toFullDiff(page);
	const full = fileSection(page, PIECES);
	const blockBox = boxes(full).first();
	await expect(blockBox).toHaveAttribute("aria-checked", "mixed");
	await expect(blockBox).not.toBeChecked();
	const row = (t: string) =>
		full.getByTestId("diff-line").filter({ hasText: new RegExp(`^.*${t}$`) });
	await expect(row("block 1")).toHaveAttribute("data-reviewed", "true");
	await expect(row("block 6!")).not.toHaveAttribute("data-reviewed");
	await expect(progress(page)).not.toHaveAttribute("aria-valuenow", "100");

	// The other two pieces: the cluster reviewed.
	await toSince(page);
	await all.nth(1).click();
	await all.nth(2).click();
	await expect(all.nth(2)).toBeChecked();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);
	await toFullDiff(page);
	await expect(blockBox).toBeChecked();
	await expect(blockBox).not.toHaveAttribute("aria-checked", "mixed");

	// An untick of one piece: mixed again, and a reload keeps it.
	await toSince(page);
	await all.nth(1).click();
	await expect(all.nth(1)).not.toBeChecked();
	await expect(all.nth(0)).toBeChecked();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);
	await page.reload();
	await expect(toRead(page)).toBeVisible(GIT_WAIT);
	await since.getByRole("button", { name: "Expand file" }).click();
	await expect(boxes(since)).toHaveCount(5, GIT_WAIT);
	await expect(boxes(since).nth(0)).toBeChecked();
	await expect(boxes(since).nth(1)).not.toBeChecked();
	await expect(boxes(since).nth(2)).toBeChecked();
	await toFullDiff(page);
	await expect(boxes(full).first()).toHaveAttribute("aria-checked", "mixed");
	await expectNoPageOverflow(page);
});

test("a removal-only piece inside a cluster is markable, chipped removed, and marks its cluster; a reverted piece is markable, stays marked after a reload, and leaves to-read", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr(piecesFixture);
	const s = await startCrb();
	const since = await piecesSince(page, s, p);
	const all = boxes(since);
	const pieceWith = (t: string) =>
		since.locator("tbody").filter({
			has: page.getByTestId("diff-line").filter({ hasText: t }),
		});
	// The merged cluster's piece: only removals, chipped removed.
	const removal = pieceWith("a 1");
	await expect(
		removal.getByTestId("diff-line").filter({ hasText: "a 1" }),
	).toHaveAttribute("data-kind", "del");
	await expect(removal.getByRole("checkbox")).toHaveCount(1);

	await expect(
		removal.getByTestId("kind-chip").filter({ hasText: "removed" }),
	).toBeVisible();
	await expect(
		removal.getByRole("button", { name: "Cross off cluster" }),
	).toHaveCount(1);
	const revert = pieceWith("added 1");
	await expect(
		revert.getByTestId("kind-chip").filter({ hasText: "reverted" }),
	).toBeVisible();
	await expect(
		revert.getByRole("button", { name: "Cross off cluster" }),
	).toHaveCount(1);

	// Ticking the removal piece marks the merged cluster: reviewed in the full diff.
	await all.nth(3).click();
	await expect(all.nth(3)).toBeChecked();
	await expect(toRead(page)).toHaveText(/4 to read/);
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);
	await toFullDiff(page);
	const full = fileSection(page, PIECES);
	const merged = full.locator("tbody").filter({
		has: page.getByTestId("diff-line").filter({ hasText: "b new" }),
	});
	await expect(merged.getByRole("checkbox")).toBeChecked();

	// The reverted piece: ticked, kept over a reload, out of to-read.
	await toSince(page);
	await all.nth(4).click();
	await expect(all.nth(4)).toBeChecked();
	await expect(toRead(page)).toHaveText(/3 to read/);
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);
	await page.reload();
	await expect(toRead(page)).toHaveText(/3 to read/, GIT_WAIT);
	await since.getByRole("button", { name: "Expand file" }).click();
	await expect(boxes(since)).toHaveCount(5, GIT_WAIT);
	await expect(boxes(since).nth(4)).toBeChecked();
	await expect(boxes(since).nth(3)).toBeChecked();
	await expectNoPageOverflow(page);
});

test("the since view counts its pieces: marking a reverted piece, then a piece of a three-piece cluster, moves the bar, to-read and the connector by one; the full diff counts clusters, that one mixed", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr(piecesFixture);
	const s = await startCrb();
	const since = await piecesSince(page, s, p);
	const all = boxes(since);
	// Five pieces: the block's three, the merged cluster's removal, the revert.
	await expect(progress(page)).toContainText("0 / 5 clusters reviewed");
	await expect(toRead(page)).toHaveText(/5 to read/);
	const fileMeter = since.getByRole("progressbar", { name: "File progress" });
	await expect(fileMeter).toHaveAttribute(
		"aria-valuetext",
		/0 of 5 clusters reviewed/,
	);
	const connectorSays = async (text: string) => {
		const conn = page.getByTestId("ps-conn-ps2");
		await conn.hover();
		await expect(card(page)).toContainText(text, GIT_WAIT);
		await page.mouse.move(0, 0);
	};

	// The reverted piece.
	await all.nth(4).click();
	await expect(all.nth(4)).toBeChecked();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);
	await expect(progress(page)).toContainText("1 / 5 clusters reviewed");
	await expect(toRead(page)).toHaveText(/4 to read/);
	await expect(fileMeter).toHaveAttribute(
		"aria-valuetext",
		/1 of 5 clusters reviewed/,
	);
	await connectorSays("1 file, 4 clusters to read");

	// One piece of the three-piece cluster.
	await all.nth(0).click();
	await expect(all.nth(0)).toBeChecked();
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, GIT_WAIT);
	await expect(progress(page)).toContainText("2 / 5 clusters reviewed");
	await expect(toRead(page)).toHaveText(/3 to read/);
	await connectorSays("1 file, 3 clusters to read");

	// The full diff counts the snapshot's clusters: two, none reviewed, the
	// block's mixed.
	await toFullDiff(page);
	await expect(progress(page)).toContainText("0 / 2 clusters reviewed");
	const full = fileSection(page, PIECES);
	await expect(boxes(full).first()).toHaveAttribute("aria-checked", "mixed");
	await expectNoPageOverflow(page);
});
