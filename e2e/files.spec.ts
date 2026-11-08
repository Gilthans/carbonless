import type { Locator, Page } from "@playwright/test";
import {
	barBottom,
	chooseUnit,
	clicksReady,
	fileAction,
	fileActionButton,
	fileProgress,
	fileSection,
	marksReady,
	openFiles,
	pickInTree,
	progress,
	resetFile,
	treeNumbers,
	withTree,
} from "./files-ui";
import { expect, type PrOptions, reviewPage, test } from "./fixtures";

const core = Array.from({ length: 78 }, (_, i) => `core ${i + 1}`);
const util = Array.from({ length: 10 }, (_, i) => `util ${i + 1}`);
const text = (lines: string[]) => `${lines.join("\n")}\n`;

/**
 * Four clusters: src/core.ts has two, 10 lines apart (separate hunks with a
 * 3-line gap), and a 60-line unchanged tail; src/util.ts has one; docs/old.md
 * is renamed without edits. Line 5 of core.ts becomes two lines, so below it
 * new line numbers run one ahead of old ones.
 */
const fixture: PrOptions = {
	base: {
		"src/core.ts": text(core),
		"src/util.ts": text(util),
		"docs/old.md": "# Notes\n\nNothing changes here.\n",
	},
	files: [
		{
			message: "PR change",
			rename: { "docs/old.md": "docs/new.md" },
			files: {
				"src/core.ts": text(
					core.flatMap((line, i) =>
						i === 4
							? ["core 5 a", "core 5 b"]
							: i === 14
								? ["core 15 changed"]
								: [line],
					),
				),
				"src/util.ts": text(
					util.map((l, i) => (i === 2 ? "util 3 changed" : l)),
				),
			},
		},
	],
};

/** "Undo cross-off" for the whole file, asked and answered. */
const undoFileCrossOff = (page: Page, section: Locator) =>
	resetFile(page, section, "Undo cross-off");

async function expand(page: Page, path: string) {
	const section = fileSection(page, path);
	await section.getByRole("button", { name: "Expand file" }).click();
	return section;
}

test("checking a cluster updates file and overall progress", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const bar = progress(page);
	await expect(bar).toHaveAttribute("aria-valuenow", "0");
	const section = await expand(page, "src/core.ts");
	const boxes = section.getByRole("checkbox", {
		name: "Mark cluster reviewed",
	});
	await expect(boxes).toHaveCount(2);
	await boxes.first().click();
	await expect(boxes.first()).toBeChecked();
	await expect(bar).toHaveAttribute("aria-valuenow", "25");
	await expect(bar).toContainText("1 / 4 clusters reviewed");
	await expect(fileProgress(section)).toContainText("1 / 2 clusters");
	await withTree(page, (tree) =>
		expect(treeNumbers(tree, /core\.ts/)).toHaveText(
			"1 of 2 clusters reviewed",
		),
	);

	// Every count follows the unit.
	await chooseUnit(page, "Lines");
	await expect(bar).toContainText("3 / 7 lines reviewed");
	await expect(bar).toHaveAttribute("aria-valuenow", "42");
	await expect(fileProgress(section)).toContainText("3 / 5 lines");
	await withTree(page, (tree) =>
		expect(treeNumbers(tree, /core\.ts/)).toHaveText("3 of 5 lines reviewed"),
	);
	await chooseUnit(page, "Files");
	await expect(bar).toContainText("0 / 3 files reviewed");
	await expect(fileProgress(section)).toContainText("0 / 1");
	await chooseUnit(page, "Clusters");

	// Undo, and the state survives a reload.
	await boxes.first().click();
	await expect(bar).toHaveAttribute("aria-valuenow", "0");
	await boxes.last().click();
	await expect(bar).toHaveAttribute("aria-valuenow", "25");
	await page.reload();
	await expect(progress(page)).toHaveAttribute("aria-valuenow", "25");
	// The unit is remembered.
	await expect(
		page.getByRole("radio", { name: "Clusters", exact: true }),
	).toBeChecked();
});

test("cross off a file without a reason", async ({ page, pr, startCrb }) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, "docs/new.md");
	await expect(section).toContainText("docs/old.md → docs/new.md");
	await fileAction(section, "Cross off file");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(fileProgress(section)).toContainText("crossed off");

	await withTree(page, async (tree) => {
		const entry = tree.getByRole("button", { name: /new\.md/ });
		await expect(entry.locator("s")).toHaveText("new.md");
		await expect(entry.getByRole("img", { name: "crossed off" })).toBeVisible();
	});
	await expect(page.getByText(/Crossed off, not reviewed/)).toHaveCount(0);
	const bar = progress(page);
	await expect(bar).toHaveAttribute("aria-valuenow", "0");
	await expect(bar).toContainText("0 / 3 clusters reviewed");
	await chooseUnit(page, "Files");
	await expect(bar).toContainText("0 / 2 files reviewed");
	await chooseUnit(page, "Clusters");

	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(
		section.getByRole("checkbox", { name: "Undo cross-off" }),
	).toHaveAccessibleDescription("Crossed off");
});

test("crossing off keeps reviewed clusters, and undoing leaves clusters unreviewed", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const bar = progress(page);
	const section = await expand(page, "src/core.ts");
	await section
		.getByRole("checkbox", { name: "Mark cluster reviewed" })
		.first()
		.click();
	await expect(bar).toContainText("1 / 4 clusters reviewed");

	// The cluster already read stays reviewed; only the other is crossed off.
	await fileAction(section, "Cross off file");
	await expect(fileProgress(section)).toHaveAttribute(
		"aria-valuetext",
		/^done · 3 lines added, 2 deleted · 2 clusters · 1 of 1 cluster reviewed, 1 crossed off$/,
	);
	await expect(bar).toContainText("1 / 3 clusters reviewed");
	// In files, a done file with a reviewed cluster counts as reviewed; only
	// one crossed off all through counts as crossed off.
	await chooseUnit(page, "Files");
	await expect(bar).toContainText("1 / 3 files reviewed");
	await expect(bar).toHaveAttribute("aria-valuenow", "33");
	await expect(fileProgress(section)).toContainText("done · 1 crossed off");
	await chooseUnit(page, "Clusters");

	// Crossing off finished the file, so it closed; open it to undo a cluster.
	await expect(section.getByTestId("diff-line")).toHaveCount(0);
	await section.getByRole("button", { name: "Expand file" }).click();
	// Undo through the cluster's box: unreviewed, not reviewed.
	const undoBox = section.getByRole("checkbox", { name: "Undo cross-off" });
	await expect(undoBox).toHaveAccessibleDescription("Crossed off");
	await undoBox.click();
	await expect(bar).toContainText("1 / 4 clusters reviewed");
	await expect(section.getByText("Crossed off")).toHaveCount(0);
	await expect(
		section.getByRole("checkbox", { name: "Mark cluster reviewed" }).last(),
	).not.toBeChecked();

	// Undo for the whole file: the cross-off button flips to undo once nothing
	// is unreviewed, and back once something is.
	await expect(fileActionButton(section, "Cross off file")).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await fileAction(section, "Cross off file");
	await expect(bar).toContainText("1 / 3 clusters reviewed");
	const undo = fileActionButton(section, "Undo cross-off");
	await expect(undo).toHaveAttribute("aria-pressed", "true");
	await expect(fileActionButton(section, "Cross off file")).toHaveCount(0);
	// Finished: the reviewed mark is a reset too.
	await expect(fileActionButton(section, "Unmark reviewed")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await undoFileCrossOff(page, section);
	// Only the crossed-off cluster went back to unreviewed.
	await expect(bar).toContainText("1 / 4 clusters reviewed");
	await expect(bar).toHaveAttribute("aria-valuenow", "25");
	await expect(fileActionButton(section, "Undo cross-off")).toHaveCount(0);
	await expect(fileActionButton(section, "Cross off file")).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect(fileActionButton(section, "Cross off file")).toBeEnabled();
	// The file closed on crossing off; undoing doesn't open or close it.
	await expect(section.getByTestId("diff-line")).toHaveCount(0);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(
		section.getByRole("checkbox", { name: "Mark cluster reviewed" }).first(),
	).toBeChecked();
	await expect(
		section.getByRole("checkbox", { name: "Mark cluster reviewed" }).last(),
	).not.toBeChecked();
});

test("cross off a single cluster, and undo it", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const bar = progress(page);
	const section = await expand(page, "src/core.ts");
	const controls = section.getByRole("button", { name: "Cross off cluster" });
	await expect(controls).toHaveCount(2);
	await controls.last().click();
	await expect(controls.last()).toHaveAttribute("aria-pressed", "true");
	await expect(bar).toContainText("0 / 3 clusters reviewed");
	await expect(section.getByText("Crossed off", { exact: true })).toBeVisible();
	await expect(fileProgress(section)).toContainText("0 / 1 cluster");

	await controls.last().click();
	await expect(controls.last()).toHaveAttribute("aria-pressed", "false");
	await expect(bar).toContainText("0 / 4 clusters reviewed");
	await expect(
		section.getByRole("checkbox", { name: "Mark cluster reviewed" }),
	).toHaveCount(2);
});

test("mark remaining reviewed", async ({ page, pr, startCrb }) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, "src/core.ts");
	await fileAction(section, "Mark remaining reviewed");
	await expect(fileProgress(section)).toContainText("2 / 2 clusters");
	// All reviewed: nothing to cross off or undo; the mark resets instead.
	await expect(fileActionButton(section, "Cross off file")).toBeDisabled();
	await expect(fileActionButton(section, "Undo cross-off")).toHaveCount(0);
	await expect(fileActionButton(section, "Unmark reviewed")).toBeEnabled();
	await withTree(page, async (tree) => {
		const entry = tree.getByRole("button", { name: /core\.ts/ });
		await expect(treeNumbers(tree, /core\.ts/)).toHaveText(
			"2 of 2 clusters reviewed",
		);
		await expect(entry.getByRole("img", { name: "done" })).toBeVisible();
	});
	await expect(progress(page)).toHaveAttribute("aria-valuenow", "50");
	await chooseUnit(page, "Files");
	await expect(fileProgress(section)).toContainText("done");
	await expect(progress(page)).toContainText("1 / 3 files reviewed");
});

test("finished files get a green header and tree row, gone on undo", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const bg = (el: Locator) =>
		el.evaluate((node) => getComputedStyle(node).backgroundColor);
	const header = (path: string) => fileSection(page, path).locator("header");
	const unfinished = await bg(header("src/util.ts"));
	await fileAction(fileSection(page, "src/core.ts"), "Mark remaining reviewed");
	await expect(fileProgress(fileSection(page, "src/core.ts"))).toContainText(
		"2 / 2 clusters",
	);
	const finished = await bg(header("src/core.ts"));
	expect(finished).not.toBe(unfinished);
	// Opaque, so a stuck header hides the diff under it, open or closed.
	expect(finished).not.toMatch(/\/|rgba|transparent/);
	// The tree: a lighter green on the finished row only. The current row
	// keeps its accent highlight instead (FileTree.tsx: current beats
	// finished), so compare only the rows that aren't current.
	await withTree(page, async (tree) => {
		const rows = (finished: boolean) =>
			tree.locator(
				`button:has([data-testid=tree-meter]):not([aria-current])${
					finished ? "[data-finished]" : ":not([data-finished])"
				}`,
			);
		await expect(rows(true).or(rows(false)).first()).toBeVisible();
		const done = await rows(true).evaluateAll((els) =>
			els.map((el) => getComputedStyle(el).backgroundColor),
		);
		const open = await rows(false).evaluateAll((els) =>
			els.map((el) => getComputedStyle(el).backgroundColor),
		);
		expect(done.length).toBeGreaterThan(0);
		expect(open.length).toBeGreaterThan(0);
		for (const d of done) for (const o of open) expect(d).not.toBe(o);
		await expect(
			tree.getByRole("button", { name: /core\.ts/ }),
		).toHaveAttribute("data-finished");
		await expect(
			tree.getByRole("button", { name: /util\.ts/ }),
		).not.toHaveAttribute("data-finished");
	});
	await expand(page, "src/core.ts");
	expect(await bg(header("src/core.ts"))).toBe(finished);
	expect(await bg(header("src/util.ts"))).toBe(unfinished);

	// Crossed off counts as finished; undoing it drops the tint at once.
	const util = fileSection(page, "src/util.ts");
	await fileAction(util, "Cross off file");
	await expect(fileProgress(util)).toContainText("crossed off");
	await expect.poll(() => bg(header("src/util.ts"))).toBe(finished);
	await withTree(page, async (tree) => {
		const row = (name: RegExp) => tree.getByRole("button", { name });
		await expect(row(/util\.ts/)).toHaveAttribute("data-finished");
		await expect(row(/new\.md/)).not.toHaveAttribute("data-finished");
	});
	await undoFileCrossOff(page, util);
	await expect(fileActionButton(util, "Cross off file")).toBeEnabled();
	expect(await bg(header("src/util.ts"))).toBe(unfinished);
	await withTree(page, async (tree) => {
		await expect(
			tree.getByRole("button", { name: /util\.ts/ }),
		).not.toHaveAttribute("data-finished");
	});
});

test("marking the rest reviewed or crossing it off closes the file", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const bar = progress(page);
	for (const [path, action, done] of [
		["src/core.ts", "Mark remaining reviewed", "2 / 2 clusters"],
		["src/util.ts", "Cross off file", "crossed off"],
	] as const) {
		// util.ts opens by itself: core.ts finished just above it.
		const section = fileSection(page, path);
		if (path === "src/core.ts") await expand(page, path);
		await expect(section.getByTestId("diff-line").first()).toBeVisible();
		// Opened by a move-on, it takes marks a moment later.
		await clicksReady(page, fileActionButton(section, action));
		await fileAction(section, action);
		await expect(fileProgress(section)).toContainText(done);
		await expect(
			section.getByRole("button", { name: "Expand file" }),
		).toBeVisible();
		await expect(section.getByTestId("diff-line")).toHaveCount(0);
	}
	await expect(bar).toContainText("2 / 3 clusters reviewed");

	// Undoing the cross-off of an open file leaves it open.
	const util = await expand(page, "src/util.ts");
	await undoFileCrossOff(page, util);
	await expect(fileActionButton(util, "Cross off file")).toBeEnabled();
	await expect(util.getByTestId("diff-line").first()).toBeVisible();
	// Marking its last cluster by hand finishes it too: it closes (the last
	// file: nothing opens after it).
	await util.getByRole("checkbox", { name: "Mark cluster reviewed" }).click();
	await expect(fileProgress(util)).toContainText("1 / 1 cluster");
	await expect(util.getByRole("button", { name: "Expand file" })).toBeVisible();
	await expect(util.getByTestId("diff-line")).toHaveCount(0);
});

test("a file closes at once on marking it all, and reopens if the save fails", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/400|Failed to load resource/);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	// The other files finished first, from their closed headers (which
	// doesn't move on): util.ts is all that's left.
	for (const path of ["docs/new.md", "src/core.ts"]) {
		const other = fileSection(page, path);
		await fileAction(other, "Mark remaining reviewed");
		await expect(fileActionButton(other, "Unmark reviewed")).toBeVisible();
	}
	await expect(progress(page)).toContainText("3 / 4 clusters reviewed");
	// Saves fail for good (not a transient error), once the test lets them.
	const held: (() => void)[] = [];
	// Only the first write waits; the parts it's split into answer at once.
	let holding = true;
	await page.route("**/api/r/*/review/states", async (route) => {
		if (holding) {
			await new Promise<void>((r) => {
				held.push(r);
			});
			holding = false;
		}
		await route.fulfill({
			status: 400,
			contentType: "application/json",
			body: JSON.stringify({ error: "disk full" }),
		});
	});
	const failed = page.getByRole("alert").filter({ hasText: "disk full" });
	// The last file with anything left: finished, it closes and nothing
	// opens after it (the verdict comes into view).
	const section = await expand(page, "src/util.ts");
	await fileAction(section, "Mark remaining reviewed");
	// Closed and reviewed without waiting for the save.
	await expect(section.getByTestId("diff-line")).toHaveCount(0);
	await expect(
		section.getByRole("button", { name: "Expand file" }),
	).toBeVisible();
	await expect(progress(page)).toContainText("4 / 4 clusters reviewed");
	await expect.poll(() => held.length).toBe(1);
	held.shift()?.();
	// The failure reopens it, the error in view, the change kept.
	await expect(failed).toBeVisible();
	await expect(failed).toContainText("src/util.ts");
	await expect(
		section.getByRole("button", { name: "Collapse file" }),
	).toBeVisible();
	await expect(section.getByTestId("diff-line").first()).toBeVisible();
	await expect(progress(page)).toContainText("4 / 4 clusters reviewed");
	await page.unroute("**/api/r/*/review/states");
	await failed.getByRole("button", { name: "Retry saving" }).click();
	await expect(failed).toBeHidden();
	// Both left to do again, for the move-on below.
	await resetFile(page, section, "Unmark reviewed");
	const core = fileSection(page, "src/core.ts");
	await resetFile(page, core, "Unmark reviewed");
	await expect(progress(page)).toContainText("1 / 4 clusters reviewed");

	// Opening another file before the failure: that file stays open, and
	// this one stays closed.
	holding = true;
	await page.route("**/api/r/*/review/states", async (route) => {
		if (holding) {
			await new Promise<void>((r) => {
				held.push(r);
			});
			holding = false;
		}
		await route.fulfill({
			status: 400,
			contentType: "application/json",
			body: JSON.stringify({ error: "disk full" }),
		});
	});
	// Finishing a file with another one left moves on (util.ts opens), so
	// its failure doesn't reopen it either.
	await expand(page, "src/core.ts");
	await fileAction(core, "Cross off file");
	await expect(core.getByTestId("diff-line")).toHaveCount(0);
	await expect(section.getByTestId("diff-line").first()).toBeVisible();
	await expect.poll(() => held.length).toBe(1);
	held.shift()?.();
	await expect(failed).toBeVisible();
	await expect(core.getByRole("button", { name: "Expand file" })).toBeVisible();
	await expect(core.getByTestId("diff-line")).toHaveCount(0);
	await expect(section.getByTestId("diff-line").first()).toBeVisible();
});

test("a click right as Undo cross-off swaps in doesn't undo", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, "src/util.ts");
	const bar = progress(page);
	await expect(fileActionButton(section, "Cross off file")).toBeEnabled();
	// A double click's second click lands on the button that swapped in. The
	// page clicks it the moment it appears: from the test, a loaded machine
	// could take longer than the guard's 500 ms (UNDO_ARM_MS) to get there.
	const clickedAt = await section.evaluate(
		(el) =>
			new Promise<number>((done) => {
				const undo = () =>
					el.querySelector<HTMLButtonElement>(
						'button[aria-label="Undo cross-off"][aria-pressed="true"]',
					);
				const watch = new MutationObserver(() => {
					const button = undo();
					if (!button) return;
					watch.disconnect();
					button.click();
					done(performance.now());
				});
				// The same button may just be relabeled.
				watch.observe(el, {
					subtree: true,
					childList: true,
					attributeFilter: ["aria-label"],
				});
				el.querySelector<HTMLButtonElement>(
					'button[aria-label="Cross off file"]',
				)?.click();
			}),
	);
	const undo = fileActionButton(section, "Undo cross-off");
	await page.waitForTimeout(100);
	await expect(undo).toBeVisible();
	await expect(bar).toContainText("0 / 3 clusters reviewed");
	// Once the guard is over, a click asks and a second one undoes.
	await page.waitForFunction((t) => performance.now() > t + 500, clickedAt);
	await undo.click();
	const armed = section.locator("button[data-armed]");
	await expect(armed).toBeVisible();
	await expect(bar).toContainText("0 / 3 clusters reviewed");
	await clicksReady(page, armed);
	await armed.click();
	await expect(fileActionButton(section, "Cross off file")).toBeEnabled();
	await expect(bar).toContainText("0 / 4 clusters reviewed");
});

test("file actions are outlined icon buttons with tooltips", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, "src/core.ts");
	const cross = section.getByRole("button", { name: "Cross off file" });
	const mark = section.getByRole("button", {
		name: "Mark remaining reviewed",
	});
	await expect(cross).toBeVisible();
	await expect(cross).toHaveText("⊘", { useInnerText: true });
	await expect(cross).not.toHaveAttribute("title");
	await expect(cross).toHaveAccessibleDescription(/not needing review/);
	await expect(mark).toBeVisible();
	await expect(mark).toHaveText("✓", { useInnerText: true });
	await expect(mark).not.toHaveAttribute("title");
	await expect(mark).toHaveAccessibleDescription(
		"Mark all unreviewed clusters as reviewed",
	);
	// Hover shows the tooltip (after a short delay), above the sticky header.
	await cross.hover();
	await expect(page.getByRole("tooltip")).toContainText(/not needing review/);
	await page.mouse.move(0, 0);
	await expect(page.getByRole("tooltip")).toBeHidden();
	await expect(
		section.getByRole("button", { name: "File actions" }),
	).toHaveCount(0);
});

test("loading more lines", async ({ page, pr, startCrb }) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, "src/core.ts");
	const line = (content: string) =>
		section
			.getByTestId("diff-line")
			.filter({ hasText: new RegExp(`${content}$`) });
	await expect(line("core 18")).toHaveCount(1);
	await expect(line("core 19")).toHaveCount(0);

	await section.getByRole("button", { name: "Load 20 lines below" }).click();
	await expect(line("core 19").getByTestId("old")).toHaveText("19");
	await expect(line("core 19").getByTestId("new")).toHaveText("20");
	await expect(line("core 38").getByTestId("new")).toHaveText("39");
	await expect(line("core 39")).toHaveCount(0);

	// The 3 unchanged lines between the two hunks fill in one step.
	await expect(line("core 9")).toHaveCount(0);
	await section.getByRole("button", { name: "Load all 3 lines" }).click();
	for (const n of [9, 10, 11]) {
		await expect(line(`core ${n}`).getByTestId("new")).toHaveText(
			String(n + 1),
		);
	}
	await expect(
		section.getByRole("button", { name: "Load all 3 lines" }),
	).toHaveCount(0);
	await expect(section.getByTestId("diff-line")).toHaveCount(17 + 3 + 20);

	// Line 1 sits above the first hunk.
	await section.getByRole("button", { name: "Load 1 line above" }).click();
	await expect(line("core 1").getByTestId("old")).toHaveText("1");
});

test("files start collapsed", async ({ page, pr, startCrb }) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	for (const path of ["docs/new.md", "src/core.ts", "src/util.ts"]) {
		await expect(fileSection(page, path)).toBeVisible();
	}
	await expect(page.getByTestId("diff-line")).toHaveCount(0);
	// No review checkboxes (the verdict card's "Include a message" aside).
	for (const path of ["docs/new.md", "src/core.ts", "src/util.ts"]) {
		await expect(fileSection(page, path).getByRole("checkbox")).toHaveCount(0);
	}
	await expect(page.getByRole("checkbox")).toHaveCount(1);
	await withTree(page, async (tree) => {
		await expect(
			tree.locator("button:not([aria-expanded]):not([data-moved])"),
		).toHaveCount(3);
		// The rename's old path, and the folders, open.
		await expect(tree.locator("button[data-moved]")).toHaveCount(1);
		await expect(tree.locator("button[aria-expanded=true]")).toHaveCount(2);
	});
});

test("a folded folder keeps its progress, unfolds for its file, and stays folded on reload, the first one too", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const src = (tree: Locator) => tree.locator('button[data-folder="src"]');
	// The first folder: it holds the file in view after a reload.
	const docs = (tree: Locator) => tree.locator('button[data-folder="docs"]');
	await withTree(page, async (tree) => {
		await expect(treeNumbers(tree, /^src/)).toHaveText(
			"0 / 3 clusters · 2 files left",
		);
		await src(tree).click();
		await expect(src(tree)).toHaveAttribute("aria-expanded", "false");
		await expect(tree.getByRole("button", { name: /core\.ts/ })).toHaveCount(0);
		await expect(tree.getByRole("button", { name: /util\.ts/ })).toHaveCount(0);
		// Its numbers and meter stay, unfinished.
		await expect(treeNumbers(tree, /^src/)).toHaveText(
			"0 / 3 clusters · 2 files left",
		);
		await expect(src(tree).getByTestId("tree-meter")).toBeVisible();
		await expect(src(tree)).not.toHaveAttribute("data-finished");
		await docs(tree).click();
		await expect(docs(tree)).toHaveAttribute("aria-expanded", "false");
	});
	// Folding changes no progress.
	await expect(progress(page)).toHaveAttribute(
		"aria-valuetext",
		/0 \/ 4 clusters reviewed/,
	);
	await page.reload();
	await expect(progress(page)).toBeVisible();
	await withTree(page, async (tree) => {
		await expect(src(tree)).toHaveAttribute("aria-expanded", "false");
		// The file in view settled on docs/new.md: docs stays folded, marked.
		await expect(docs(tree)).toHaveAttribute("data-holds-current");
		await expect(docs(tree)).toHaveAttribute("aria-expanded", "false");
		await expect(tree.getByRole("button", { name: /new\.md/ })).toHaveCount(0);
	});
	// Going to a file inside it (a link, on a fresh load) unfolds it.
	await page.goto(reviewPage(s.url, "files", "?path=src/util.ts"));
	await expect(
		fileSection(page, "src/util.ts").getByTestId("diff-line").first(),
	).toBeVisible();
	await withTree(page, async (tree) => {
		await expect(src(tree)).toHaveAttribute("aria-expanded", "true");
		await expect(tree.getByRole("button", { name: /util\.ts/ })).toBeVisible();
	});
});

test("a write from a tab on an old snapshot reloads it", async ({
	page,
	context,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/status of 409 \(Conflict\)/);
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, "src/util.ts");
	const box = section.getByRole("checkbox", { name: "Mark cluster reviewed" });
	await expect(box).toBeVisible();

	p.moveHead({ message: "more", files: { "b.txt": "b\n" } });
	const other = await context.newPage();
	await other.goto(s.url);
	await other.getByRole("button", { name: "Refresh" }).click();
	await expect(other.getByRole("link", { name: /Review files/ })).toContainText(
		"0 / 5",
	);

	await box.click();
	await expect(
		page.getByText("The review moved to a new snapshot; reloaded."),
	).toBeVisible();
	await withTree(page, (tree) => expect(tree).toContainText("b.txt"));
	await expect(progress(page)).toContainText("0 / 5 clusters reviewed");
});

test("one file is open at a time", async ({ page, pr, startCrb }) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const core = await expand(page, "src/core.ts");
	await expect(core.getByTestId("diff-line").first()).toBeVisible();
	// Opening the next file closes core.ts above it; the header just used
	// stays where it was on screen.
	const util = fileSection(page, "src/util.ts");
	const header = util.locator("header");
	// A short window, scrolled down to util.ts: room to keep its header put.
	const width = page.viewportSize()?.width ?? 1280;
	await page.setViewportSize({ width, height: 360 });
	await header.scrollIntoViewIfNeeded();
	const before = (await header.boundingBox())?.y ?? Number.NaN;
	await util.getByRole("button", { name: "Expand file" }).click();
	await expect(util.getByTestId("diff-line").first()).toBeVisible();
	await expect(core.getByRole("button", { name: "Expand file" })).toBeVisible();
	await expect(core.getByTestId("diff-line")).toHaveCount(0);
	await expect
		.poll(async () =>
			Math.abs(((await header.boundingBox())?.y ?? 1e9) - before),
		)
		.toBeLessThanOrEqual(3);
	await util.getByRole("button", { name: "Collapse file" }).click();
	await expect(page.getByTestId("diff-line")).toHaveCount(0);
});

const long = Array.from({ length: 300 }, (_, i) => `long ${i + 1}`);
/** A file with a 300-line change, after two short ones. */
const longFixture: PrOptions = {
	base: {
		"a/one.ts": text(util),
		"a/two.ts": text(util),
		"b/long.ts": text(long),
		"c/last.ts": text(util),
	},
	files: [
		{
			message: "PR change",
			files: {
				"a/one.ts": text(util.map((l) => `${l} x`)),
				"a/two.ts": text(util.map((l) => `${l} y`)),
				"b/long.ts": text(long.map((l) => `${l} changed`)),
				"c/last.ts": text(util.map((l) => `${l} z`)),
			},
		},
	],
};

/**
 * A rename with no edits (a cluster without changed lines) above a long file
 * with a three-line change every 20 lines (one hunk per change).
 */
const unitSwitchFixture: PrOptions = {
	base: {
		"a/old.md": "# Notes\n",
		"b/long.ts": text(long),
	},
	files: [
		{
			message: "PR change",
			rename: { "a/old.md": "a/new.md" },
			files: {
				"b/long.ts": text(
					long.map((l, i) => (i % 20 < 3 ? `${l} changed` : l)),
				),
			},
		},
	],
};

/** Opens b/long.ts and scrolls a row from its middle to mid-screen. */
async function readMiddleOfLongFile(page: Page) {
	const section = await expand(page, "b/long.ts");
	const row = section
		.getByTestId("diff-line")
		.filter({ hasText: /long 141 changed$/ });
	await row.scrollIntoViewIfNeeded();
	const height = page.viewportSize()?.height ?? 0;
	const y0 = (await row.boundingBox())?.y ?? 0;
	await page.evaluate((by) => window.scrollBy(0, by), y0 - height / 2);
	const top = async () => (await row.boundingBox())?.y ?? Number.NaN;
	expect(Math.abs((await top()) - height / 2)).toBeLessThan(5);
	return top;
}

test("switching the unit keeps the line being read in place", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(unitSwitchFixture);
	const s = await startCrb();
	await openFiles(page, s.url, "Lines");
	const top = await readMiddleOfLongFile(page);
	const before = await top();
	for (const unit of ["Clusters", "Lines", "Files", "Clusters"] as const) {
		await chooseUnit(page, unit);
		expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(2);
	}
	// From the keyboard too: arrows move between the units.
	await page.keyboard.press("ArrowLeft");
	await expect(page.getByRole("radio", { name: "Lines" })).toBeChecked();
	expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(2);
});

test("switching the unit keeps the line in place when the bar's height changes", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(unitSwitchFixture);
	const s = await startCrb();
	await openFiles(page, s.url, "Clusters");
	// Like Safari, which has no CSS scroll anchoring: the page must keep the
	// line in place itself.
	await page.addStyleTag({ content: "* { overflow-anchor: none; }" });
	await fileAction(fileSection(page, "b/long.ts"), "Mark remaining reviewed");
	await expect(progress(page)).toContainText("15 / 16 clusters");
	const top = await readMiddleOfLongFile(page);
	const before = await top();
	const barHeight = async () =>
		(await page.locator("[data-page-bar]").boundingBox())?.height ?? 0;
	const clustersBar = await barHeight();
	// In lines only the rename is left, and the bar says so on a line of its own.
	await chooseUnit(page, "Lines");
	await expect(
		page.getByText("1 cluster without changed lines left"),
	).toBeVisible();
	expect(await barHeight()).toBeGreaterThan(clustersBar);
	expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(2);
	await chooseUnit(page, "Clusters");
	await expect(
		page.getByText("1 cluster without changed lines left"),
	).toHaveCount(0);
	expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(2);
});

/** A file with a 300-line change, then enough short ones to fill a screen. */
const longThenMoreFixture: PrOptions = {
	base: {
		"b/long.ts": text(long),
		...Object.fromEntries(
			Array.from({ length: 30 }, (_, i) => [`c/more${i}.ts`, text(util)]),
		),
	},
	files: [
		{
			message: "PR change",
			files: {
				"b/long.ts": text(long.map((l) => `${l} changed`)),
				...Object.fromEntries(
					Array.from({ length: 30 }, (_, i) => [
						`c/more${i}.ts`,
						text(util.map((l) => `${l} ${i}`)),
					]),
				),
			},
		},
	],
};

test("marking a long file reviewed from its stuck header moves on to the next", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(longThenMoreFixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, "b/long.ts");
	await section
		.getByTestId("diff-line")
		.filter({ hasText: /long 250 changed$/ })
		.scrollIntoViewIfNeeded();
	const header = section.locator("header");
	expect((await section.boundingBox())?.y ?? 0).toBeLessThan(-1000);
	const stuck = (await header.boundingBox())?.y ?? Number.NaN;
	expect(Math.abs(stuck - (await barBottom(page)))).toBeLessThanOrEqual(1);

	await fileAction(section, "Mark remaining reviewed");
	await expect(section.getByTestId("diff-line")).toHaveCount(0);
	// The next file opens where the header was stuck, the closed one right
	// above it.
	const more = fileSection(page, "c/more0.ts");
	await expect(more.getByTestId("diff-line").first()).toBeVisible();
	const next = more.locator("header");
	await expect
		.poll(async () => Math.abs(((await next.boundingBox())?.y ?? 1e9) - stuck))
		.toBeLessThanOrEqual(2);
	const headerBox = await header.boundingBox();
	const nextBox = await next.boundingBox();
	expect(
		Math.abs(
			(nextBox?.y ?? 1e9) - ((headerBox?.y ?? 0) + (headerBox?.height ?? 0)),
		),
	).toBeLessThan(40);
});

test("a failed save doesn't reopen a file the reviewer scrolled away from", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/400|Failed to load resource/);
	await pr(longThenMoreFixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const held: (() => void)[] = [];
	await page.route("**/api/r/*/review/states", async (route) => {
		await new Promise<void>((r) => {
			held.push(r);
		});
		await route.fulfill({
			status: 400,
			contentType: "application/json",
			body: JSON.stringify({ error: "disk full" }),
		});
	});
	const section = await expand(page, "b/long.ts");
	await section
		.getByTestId("diff-line")
		.filter({ hasText: /long 250 changed$/ })
		.scrollIntoViewIfNeeded();
	await fileAction(section, "Mark remaining reviewed");
	await expect(section.getByTestId("diff-line")).toHaveCount(0);
	// Reading on, below: the closed header is off screen.
	const header = section.locator("header");
	const bottom = await header.evaluate(
		(el) => el.getBoundingClientRect().bottom,
	);
	await page.evaluate((by) => window.scrollBy(0, by), bottom + 50);
	await expect(header).not.toBeInViewport();
	const later = fileSection(page, "c/more20.ts").locator("header");
	const before = (await later.boundingBox())?.y ?? Number.NaN;
	await expect.poll(() => held.length).toBe(1);
	held.shift()?.();
	// The error shows; the file stays closed and nothing moves.
	await expect(
		page.getByRole("alert").filter({ hasText: "disk full" }),
	).toBeVisible();
	await expect(
		section.getByRole("button", { name: "Expand file" }),
	).toBeAttached();
	await expect(section.getByTestId("diff-line")).toHaveCount(0);
	expect((await later.boundingBox())?.y).toBeCloseTo(before, 0);
});

test("crossing off the last long file from its stuck header keeps it in view", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(longFixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, "b/long.ts");
	await section
		.getByTestId("diff-line")
		.filter({ hasText: /long 250 changed$/ })
		.scrollIntoViewIfNeeded();
	expect((await section.boundingBox())?.y ?? 0).toBeLessThan(-1000);
	await fileAction(section, "Cross off file");
	await expect(section.getByTestId("diff-line")).toHaveCount(0);
	// Too near the end to stay put: the page ends, the header still shows.
	await expect(section.locator("header")).toBeInViewport();
	await expect(fileSection(page, "c/last.ts")).toBeInViewport();
});

test("an open file's header sticks below the progress bar", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(longFixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, "b/long.ts");
	await expect(section.getByTestId("diff-line")).toHaveCount(600);
	// Deep into the diff, the header is still on screen, right below the bar.
	await section
		.getByTestId("diff-line")
		.filter({ hasText: /long 250 changed$/ })
		.scrollIntoViewIfNeeded();
	const header = section.locator("header");
	await expect(header).toBeInViewport();
	const top = (await header.boundingBox())?.y ?? Number.NaN;
	expect(Math.abs(top - (await barBottom(page)))).toBeLessThanOrEqual(1);
	const sectionTop = (await section.boundingBox())?.y ?? 0;
	expect(sectionTop).toBeLessThan(-1000);
	// Nothing hides the bar or covers the header's controls.
	await expect(progress(page)).toBeInViewport();
	const collapse = section.getByRole("button", { name: "Collapse file" });
	await collapse.click();
	await expect(section.getByTestId("diff-line")).toHaveCount(0);
	// Closed from deep inside it, the header stays where it was.
	const expandButton = section.getByRole("button", { name: "Expand file" });
	await expect(expandButton).toBeInViewport();
	await expect(fileSection(page, "c/last.ts")).toBeInViewport();
});

test("picking a file in the tree opens it alone, its header at the top", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(longFixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const first = await expand(page, "a/one.ts");
	await expect(first.getByTestId("diff-line").first()).toBeVisible();
	await pickInTree(page, /long\.ts/);
	const last = fileSection(page, "b/long.ts");
	await expect(last.getByTestId("diff-line").first()).toBeVisible();
	await expect(first.getByTestId("diff-line")).toHaveCount(0);
	await expect(
		first.getByRole("button", { name: "Expand file" }),
	).toBeAttached();
	await expect
		.poll(async () => {
			const top = (await last.locator("header").boundingBox())?.y ?? 0;
			return Math.round(top - (await barBottom(page)));
		})
		.toBe(0);
});

test("a finished file resets after asking, each button its own kind", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const bar = progress(page);
	const section = fileSection(page, "src/core.ts");
	await fileAction(section, "Mark remaining reviewed");
	await expect(bar).toContainText("2 / 4 clusters reviewed");
	const unmark = fileActionButton(section, "Unmark reviewed");
	await expect(unmark).toHaveAttribute("aria-pressed", "true");
	await expect(fileActionButton(section, "Cross off file")).toBeDisabled();

	// The first click asks, in the button's name and a tooltip; Escape
	// drops the question and nothing changes.
	await clicksReady(page, unmark);
	await unmark.click();
	const question = "Remove all reviewed markings from this file?";
	const armed = section.locator("button[data-armed]");
	await expect(armed).toHaveAccessibleName(question);
	// Its text is the button's name now, so it is hidden from the a11y tree.
	await expect(
		page.locator("[role=tooltip]:not([hidden])").filter({ hasText: question }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(armed).toHaveCount(0);
	await expect(unmark).toBeVisible();
	await expect(bar).toContainText("2 / 4 clusters reviewed");
	// A press elsewhere drops it too.
	await clicksReady(page, unmark);
	await unmark.click();
	await expect(armed).toHaveCount(1);
	await progress(page).click();
	await expect(armed).toHaveCount(0);

	// Asked and answered: every reviewed cluster back to unreviewed, saved.
	await resetFile(page, section, "Unmark reviewed");
	await expect(bar).toContainText("0 / 4 clusters reviewed");
	await expect(
		fileActionButton(section, "Mark remaining reviewed"),
	).toBeEnabled();
	await page.reload();
	await expect(progress(page)).toContainText("0 / 4 clusters reviewed");

	// Finished by both kinds: each button resets only its own.
	const core = await expand(page, "src/core.ts");
	await core
		.getByRole("checkbox", { name: "Mark cluster reviewed" })
		.first()
		.click();
	await core.getByRole("button", { name: "Cross off cluster" }).last().click();
	await expect(progress(page)).toContainText("1 / 3 clusters reviewed");
	await resetFile(page, core, "Undo cross-off");
	await expect(progress(page)).toContainText("1 / 4 clusters reviewed");
	await expect(fileProgress(core)).toContainText("1 / 2 clusters");
});

/**
 * Records, in the page, each file section (or the verdict) a move-on
 * raised into place (`data-arriving`, FilesPage's `arrive`): it lasts
 * ~200 ms, too short to poll for.
 */
async function recordArrivals(page: Page) {
	await page.evaluate(() => {
		const seen: string[] = [];
		(window as unknown as { __arrived: string[] }).__arrived = seen;
		new MutationObserver((records) => {
			for (const r of records) {
				const el = r.target as HTMLElement;
				if (el.hasAttribute("data-arriving")) {
					seen.push(el.getAttribute("data-path") ?? el.id);
				}
			}
		}).observe(document.body, {
			subtree: true,
			attributes: true,
			attributeFilter: ["data-arriving"],
		});
	});
}
const arrivals = (page: Page) =>
	page.evaluate(() => (window as unknown as { __arrived: string[] }).__arrived);

/** The header of `section` is right under the sticky bar. */
async function expectAtTop(page: Page, section: Locator) {
	await expect
		.poll(async () => {
			const top = (await section.locator("header").boundingBox())?.y ?? 0;
			return Math.round(top - (await barBottom(page)));
		})
		.toBe(0);
}

test("marking a file's last cluster opens the next file with something left", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(longFixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await recordArrivals(page);
	const one = await expand(page, "a/one.ts");
	const box = one.getByRole("checkbox", { name: "Mark cluster reviewed" });
	await expect(box).toHaveCount(1);
	// The cluster's mark finishes the file: it closes, the next one rises
	// into place with its header at the top and the focus on its toggle.
	await box.click();
	await expect(one.getByTestId("diff-line")).toHaveCount(0);
	await expect(fileProgress(one)).toContainText("1 / 1 cluster");
	const two = fileSection(page, "a/two.ts");
	await expect(two.getByTestId("diff-line").first()).toBeVisible();
	await expect(
		two.getByRole("button", { name: "Collapse file" }),
	).toBeFocused();
	await expectAtTop(page, two);
	expect(await arrivals(page)).toEqual(["a/two.ts"]);
	await withTree(page, (tree) =>
		expect(tree.getByRole("button", { name: /two\.ts/ })).toHaveAttribute(
			"aria-current",
			/.+/,
		),
	);

	// Undoing it from the file's header doesn't move anything.
	await resetFile(page, one, "Unmark reviewed");
	await expect(two.getByTestId("diff-line").first()).toBeVisible();
	await expect(one.getByTestId("diff-line")).toHaveCount(0);

	// The whole-file action on an open file moves on as well.
	await marksReady(page, two);
	await fileAction(two, "Cross off file");
	await expect(two.getByTestId("diff-line")).toHaveCount(0);
	const long = fileSection(page, "b/long.ts");
	await expect(long.getByTestId("diff-line").first()).toBeVisible();

	// After the last file it wraps round to the first with something left.
	const last = await expand(page, "c/last.ts");
	await expect(long.getByTestId("diff-line")).toHaveCount(0);
	await last.getByRole("button", { name: "Cross off cluster" }).click();
	await expect(last.getByTestId("diff-line")).toHaveCount(0);
	await expect(one.getByTestId("diff-line").first()).toBeVisible();
	await expectAtTop(page, one);

	// Files with nothing left are skipped: two (crossed off) for long.
	await marksReady(page, one);
	await one.getByRole("checkbox", { name: "Mark cluster reviewed" }).click();
	await expect(one.getByTestId("diff-line")).toHaveCount(0);
	await expect(two.getByTestId("diff-line")).toHaveCount(0);
	await expect(long.getByTestId("diff-line").first()).toBeVisible();
	await expectAtTop(page, long);

	// Nothing left anywhere: it closes and the verdict rises into view.
	await marksReady(page, long);
	await fileAction(long, "Mark remaining reviewed");
	await expect(long.getByTestId("diff-line")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Collapse file" })).toHaveCount(
		0,
	);
	await expect(page.getByTestId("verdict-card-files")).toBeInViewport();
	await expect(progress(page)).toContainText(/\b(\d+) \/ \1 clusters reviewed/);
	expect(await arrivals(page)).toEqual([
		"a/two.ts",
		"b/long.ts",
		"a/one.ts",
		"b/long.ts",
		"files-verdict",
	]);
});

test("with reduced motion, a move-on is instant", async ({
	page,
	pr,
	startCrb,
}) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await pr(longFixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await recordArrivals(page);
	const one = await expand(page, "a/one.ts");
	await one.getByRole("checkbox", { name: "Mark cluster reviewed" }).click();
	const two = fileSection(page, "a/two.ts");
	await expect(two.getByTestId("diff-line").first()).toBeVisible();
	await expectAtTop(page, two);
	// No animation ran; once in place, it waits the usual moment for marks.
	expect(await two.evaluate((el) => el.getAnimations().length)).toBe(0);
	await marksReady(page, two);
	await fileAction(two, "Mark remaining reviewed");
	await expect(
		fileSection(page, "b/long.ts").getByTestId("diff-line").first(),
	).toBeVisible();
	expect(await arrivals(page)).toEqual([]);
});

/**
 * A double click (on a phone, a double tap) on `target`, whose click
 * finishes its file: the first is a real click or tap; the second lands at
 * the same point the moment the same kind of control (`control`, a
 * selector) of the next file (`nextPath`) shows under it, as a person's
 * second click would. The page clicks it itself, in the frame it sees that:
 * from the test, a loaded machine could take longer than the guard
 * (UNDO_ARM_MS). Says what the second click hit and how long after the
 * first, or what it waited for in vain.
 */
async function doubleAcrossMoveOn(
	page: Page,
	target: Locator,
	control: string,
	nextPath: string,
	isMobile: boolean,
) {
	const box = await target.boundingBox();
	if (!box) throw new Error("target not rendered");
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	type Second = { hit: boolean; after: number; seen: string };
	const w = "__secondClick";
	// Awaited before the first click: an evaluate still on its way could
	// miss it and wait for a click that already happened (then the test
	// times out, and its teardown's navigation is all it reports).
	await page.evaluate(
		({ x, y, control, nextPath, w }) => {
			(window as unknown as Record<string, Promise<Second>>)[w] = new Promise(
				(done) => {
					let at = 0;
					addEventListener(
						"click",
						() => {
							at ||= performance.now();
						},
						{ capture: true, once: true },
					);
					const start = performance.now();
					const poll = () => {
						const next = document.querySelector<HTMLElement>(
							`section[data-path="${CSS.escape(nextPath)}"]`,
						);
						const hit = document.elementFromPoint(x, y) as HTMLElement | null;
						// A box's point is its label's (cluster-box-target).
						const under = hit?.closest("label, button");
						const isControl =
							!!under &&
							(under.matches(control) || !!under.querySelector(control));
						const seen = `${hit?.closest("section")?.getAttribute("data-path")} ${under?.outerHTML.slice(0, 120)}`;
						if (at && isControl && next?.contains(hit)) {
							const after = performance.now() - at;
							hit?.click();
							done({ hit: true, after, seen });
						} else if (performance.now() - start > 15_000) {
							// Said here rather than as the test's timeout.
							done({ hit: false, after: -1, seen: `clicked ${!!at}; ${seen}` });
						} else requestAnimationFrame(poll);
					};
					requestAnimationFrame(poll);
				},
			);
		},
		{ x, y, control, nextPath, w },
	);
	if (isMobile) await page.touchscreen.tap(x, y);
	else await page.mouse.click(x, y);
	return page.evaluate(
		(w) =>
			(window as unknown as Record<string, Promise<Second>>)[
				w
			] as Promise<Second>,
		w,
	);
}

/**
 * A long file to finish deep inside (its header stuck, its cluster's box
 * floating right under it), then a rename with no edits: its cluster's box
 * sits in its first row, right under its header. A next file with lines
 * starts with its "@@" row there instead, which a second click can't mark.
 * Then enough files for its header to reach the top on a phone.
 */
const stuckFixture: PrOptions = {
	base: {
		"b/long.ts": text(long),
		"c/old.md": "# Notes\n",
		...Object.fromEntries(
			Array.from({ length: 14 }, (_, i) => [`d/f${i}.ts`, text(util)]),
		),
	},
	files: [
		{
			message: "PR change",
			rename: { "c/old.md": "c/new.md" },
			files: {
				"b/long.ts": text(long.map((l) => `${l} changed`)),
				...Object.fromEntries(
					Array.from({ length: 14 }, (_, i) => [
						`d/f${i}.ts`,
						text(util.map((l) => `${l} z`)),
					]),
				),
			},
		},
	],
};

for (const [where, control] of [
	["picked", "file action"],
	["picked", "cluster box"],
	["stuck", "file action"],
	["stuck", "cluster box"],
] as const) {
	test(`a double click on a ${control} that finishes a ${where} file doesn't mark the next one`, async ({
		page,
		pr,
		startCrb,
		isMobile,
	}) => {
		await pr(where === "picked" ? longFixture : stuckFixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		// Its header at the top (picked), or stuck deep in a long file.
		const [path, nextPath] =
			where === "picked" ? ["a/one.ts", "a/two.ts"] : ["b/long.ts", "c/new.md"];
		let section: Locator;
		if (where === "picked") {
			await pickInTree(page, /one\.ts/);
			section = fileSection(page, path);
			await expect
				.poll(async () => {
					const top = (await section.locator("header").boundingBox())?.y ?? 0;
					return Math.round(top - (await barBottom(page)));
				})
				.toBe(0);
		} else {
			section = await expand(page, path);
			await section
				.getByTestId("diff-line")
				.filter({ hasText: /long 250 changed$/ })
				.scrollIntoViewIfNeeded();
			await expect
				.poll(async () => {
					const top = (await section.locator("header").boundingBox())?.y ?? 0;
					return Math.round(top - (await barBottom(page)));
				})
				.toBe(0);
		}
		const [target, selector] =
			control === "file action"
				? [
						fileActionButton(section, "Mark remaining reviewed"),
						'button[aria-label="Mark remaining reviewed"]',
					]
				: [
						section.getByRole("checkbox", { name: "Mark cluster reviewed" }),
						'input[aria-label="Mark cluster reviewed"]',
					];
		await expect(target).toBeInViewport();
		const second = await doubleAcrossMoveOn(
			page,
			target,
			selector,
			nextPath,
			isMobile,
		);
		// The second click landed on the next file's control (`after`: how
		// long the move-on took, which the guard doesn't count).
		expect(second.hit, `${second.seen} after ${second.after} ms`).toBe(true);
		// This file is reviewed and closed; the next one is open, untouched.
		await expect(fileProgress(section)).toContainText("1 / 1 cluster");
		const next = fileSection(page, nextPath);
		await expect(fileProgress(next)).toContainText("0 / 1 cluster");
		await expect(
			next.getByRole("button", { name: "Collapse file" }),
		).toBeVisible();
		await expect(progress(page)).toContainText(/\b1 \/ \d+ clusters reviewed/);
	});
}

test("tree rows and headers keep change counts in every unit; progress follows it", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url, "Lines");
	await fileAction(fileSection(page, "src/util.ts"), "Mark remaining reviewed");
	await withTree(page, async (tree) => {
		const core = tree.getByRole("button", { name: /core\.ts/ });
		const bar = treeNumbers(tree, /core\.ts/);
		await expect(bar).toHaveText("0 of 5 lines reviewed");
		// The row's name ends with the numbers, and focus shows them.
		await expect(core).toHaveAccessibleName(/core\.ts.*0 of 5 lines reviewed$/);
		await core.focus();
		await expect(
			page.getByText("src/core.ts · 0 of 5 lines reviewed"),
		).toBeVisible();
		await expect(treeNumbers(tree, /util\.ts/)).toHaveText(
			"2 of 2 lines reviewed",
		);
		// A rename has no lines: the bar is not full while it's unreviewed.
		await expect(treeNumbers(tree, /new\.md/)).toHaveText("1 cluster left");
		await expect(core).toContainText("+3 −2");
		await expect(core).not.toContainText("/");
		// Bars line up at the right edge.
		const rights = await tree
			.getByTestId("tree-meter")
			.evaluateAll((els) =>
				els.map((el) => Math.round(el.getBoundingClientRect().right)),
			);
		expect(new Set(rights).size).toBe(1);
		const widths = await tree
			.getByTestId("tree-meter")
			.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
		for (const w of widths) expect(w).toBeGreaterThan(20);
	});
	const header = fileSection(page, "src/core.ts").locator("header");
	const headerCount = header.getByTestId("change-count");
	const headerBar = fileProgress(fileSection(page, "src/core.ts"));
	await expect(headerCount).toHaveText("+3 −22");
	await expect(headerCount).toBeInViewport();
	await expect(headerBar).toContainText("0 / 5 lines");
	// It fits a phone's header without overflowing it.
	expect(
		await header.evaluate((el) => el.scrollWidth - el.clientWidth),
	).toBeLessThanOrEqual(0);

	// Only progress follows the unit: the change counts stay.
	await chooseUnit(page, "Clusters");
	await withTree(page, async (tree) => {
		const core = tree.getByRole("button", { name: /core\.ts/ });
		await expect(
			core.getByRole("img", { name: "3 lines added, 2 deleted" }),
		).toHaveText("+3 −2");
		const count = core.getByRole("img", { name: "2 clusters" });
		await expect(count).toHaveText("2");
		await expect(count).not.toHaveAttribute("title");
		await expect(treeNumbers(tree, /core\.ts/)).toHaveText(
			"0 of 2 clusters reviewed",
		);
	});
	// Decorative in the header: the progress summary carries the names.
	await expect(headerCount).toHaveText("+3 −22");
	await expect(headerCount).toBeInViewport();
	await expect(headerBar).toHaveAttribute(
		"aria-valuetext",
		"not started · 3 lines added, 2 deleted · 2 clusters · 0 of 2 clusters reviewed",
	);

	await chooseUnit(page, "Files");
	await withTree(page, async (tree) => {
		const core = tree.getByRole("button", { name: /core\.ts/ });
		await expect(core).toContainText("+3 −2");
		await expect(core.getByRole("img", { name: "2 clusters" })).toBeVisible();
		await expect(treeNumbers(tree, /util\.ts/)).toHaveText("done");
	});
	await expect(headerCount).toHaveText("+3 −22");
});

const many = Array.from({ length: 200 }, (_, i) => `many ${i + 1}`);

test("keyboard focus inside an open diff is never hidden under the sticky headers", async ({
	page,
	pr,
	startCrb,
}) => {
	// Every 10th line changed: 20 clusters, each with its own checkbox.
	await pr({
		base: { "many.ts": text(many) },
		files: [
			{
				message: "PR change",
				files: {
					"many.ts": text(
						many.map((l, i) => (i % 10 === 5 ? `${l} changed` : l)),
					),
				},
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, "many.ts");
	const boxes = section.getByRole("checkbox", {
		name: "Mark cluster reviewed",
	});
	await expect(boxes).toHaveCount(20);
	const header = section.locator("header");
	const target = boxes.nth(10);
	// Scroll so the checkbox sits under the stuck header.
	await target.scrollIntoViewIfNeeded();
	await expect(header).toBeInViewport();
	const headerBottom = async () => {
		const box = await header.boundingBox();
		return (box?.y ?? 0) + (box?.height ?? 0);
	};
	const targetTop = async () => (await target.boundingBox())?.y ?? 0;
	// Its whole cluster (two rows) goes under the header, so its controls
	// stop floating and go under with it.
	await page.evaluate(
		(by) => window.scrollBy(0, by),
		(await targetTop()) - (await headerBottom()) + 50,
	);
	await expect.poll(targetTop).toBeLessThan(await headerBottom());
	await target.focus();
	await expect(target).toBeFocused();
	await expect
		.poll(async () => (await targetTop()) >= (await headerBottom()) - 1)
		.toBe(true);
});

test("no element on the Files page uses a native title tooltip", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await expand(page, "src/core.ts");
	// SVG <title> children are names, not tooltips.
	await expect(page.locator("[title]")).toHaveCount(0);
});

test("a header tooltip is above a stuck header and the diff", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(longFixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, "b/long.ts");
	await section
		.getByTestId("diff-line")
		.filter({ hasText: /long 250 changed$/ })
		.scrollIntoViewIfNeeded();
	const mark = section.getByRole("button", { name: "Mark remaining reviewed" });
	await mark.hover();
	const tip = page.getByRole("tooltip").filter({ visible: true });
	await expect(tip).toContainText("Mark all unreviewed");
	// It lives outside the sticky header's stacking context, and the topmost
	// thing at its centre is the tooltip itself (hit-testing skips it while it
	// ignores the pointer, so let it take hits just for this check).
	const topmost = await tip.evaluate((el) => {
		el.style.pointerEvents = "auto";
		const r = el.getBoundingClientRect();
		const hit = document.elementFromPoint(
			r.left + r.width / 2,
			r.top + r.height / 2,
		);
		el.style.pointerEvents = "";
		return {
			top: hit === el,
			inBody: el.parentElement === document.body,
			z: getComputedStyle(el).zIndex,
		};
	});
	expect(topmost.top).toBe(true);
	expect(topmost.inBody).toBe(true);
});

test("paths in tooltips are monospace, like paths everywhere", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	// The open tooltip's path (closed ones are hidden, out of the a11y tree).
	const pathFont = () =>
		page.evaluate(() => {
			const path = document.querySelector(
				'[role="tooltip"]:not([hidden]) [data-tooltip-path]',
			);
			return path ? getComputedStyle(path).fontFamily : "";
		});

	// The file header's full path.
	await fileSection(page, "src/core.ts").getByTestId("file-path").focus();
	await expect.poll(pathFont).toMatch(/monospace/);
	await page.keyboard.press("Escape");

	// A tree file.
	await withTree(page, async (tree) => {
		await tree.getByRole("button", { name: /util\.ts/ }).focus();
		await expect.poll(pathFont).toMatch(/monospace/);
	});
});

test("each file shows whether it was added, deleted, modified or renamed", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr({
		base: {
			"src/edit.ts": text(util),
			"src/gone.ts": text(util),
			"docs/old.md": "# Notes\n\nNothing changes here.\n",
		},
		files: [
			{
				message: "kinds",
				delete: ["src/gone.ts"],
				rename: { "docs/old.md": "docs/new.md" },
				files: {
					"src/edit.ts": text(util.map((l, i) => (i === 2 ? "x" : l))),
					"src/fresh.ts": text(core.slice(0, 3)),
				},
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const kinds: [string, string, RegExp][] = [
		["src/fresh.ts", "Added", /fresh\.ts/],
		["src/gone.ts", "Deleted", /gone\.ts/],
		["src/edit.ts", "Modified", /edit\.ts/],
		["docs/new.md", "Renamed from docs/old.md", /new\.md/],
	];
	for (const [path, name] of kinds) {
		const section = fileSection(page, path);
		const icon = section.getByRole("img", { name, exact: true });
		await expect(icon).toBeVisible();
		// Beside the path, on its row.
		const iconBox = await icon.boundingBox();
		const pathBox = await section.getByTestId("file-path").boundingBox();
		expect(iconBox && pathBox).toBeTruthy();
		if (iconBox && pathBox) {
			expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(pathBox.x);
			const middle = (b: { y: number; height: number }) => b.y + b.height / 2;
			expect(Math.abs(middle(iconBox) - middle(pathBox))).toBeLessThan(4);
		}
	}
	// The path's tooltip says it too (the one way on touch).
	await fileSection(page, "src/gone.ts").getByTestId("file-path").focus();
	await expect(page.locator('[role="tooltip"]:not([hidden])')).toHaveText(
		"Deleted · src/gone.ts",
	);
	await page.keyboard.press("Escape");
	await withTree(page, async (tree) => {
		for (const [, name, row] of kinds) {
			await expect(
				tree
					.getByRole("button", { name: row })
					.getByRole("img", { name, exact: true }),
			).toBeVisible();
		}
	});
	// Nothing pushes the page sideways.
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
});

test("scrolling into a folded folder never unfolds it; opening a file from its header does", async ({
	page,
	pr,
	startCrb,
}) => {
	const long = Array.from({ length: 40 }, (_, i) => `long ${i + 1}`);
	// Enough small files below it that scrolling to the end brings one into view.
	const small = Object.fromEntries(
		"abcdefghijklmn".split("").map((n) => [`src/${n}.ts`, `${n}\n`]),
	);
	await pr({
		base: { "docs/long.md": text(long), ...small },
		files: [
			{
				message: "PR change",
				files: {
					"docs/long.md": text(long.map((l) => `${l} changed`)),
					...Object.fromEntries(
						Object.keys(small).map((p) => [p, `${p} changed\n`]),
					),
				},
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const folderRow = (tree: Locator, path: string) =>
		tree.locator(`button[data-folder="${path}"]`);
	await withTree(page, async (tree) => {
		await folderRow(tree, "src").click();
		await expect(folderRow(tree, "src")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	});
	// Open the long file from its header and scroll down past it.
	const section = await expand(page, "docs/long.md");
	await expect(section.getByTestId("diff-line").first()).toBeVisible();
	await page.evaluate(() =>
		window.scrollTo(0, document.documentElement.scrollHeight),
	);
	await withTree(page, async (tree) => {
		// The file in view moved into src: its dot did, the fold held; docs
		// keeps the opened file's dot.
		await expect(folderRow(tree, "src")).toHaveAttribute("data-holds-current");
		await expect(folderRow(tree, "src")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		await expect(tree.locator('[data-folder-group="src"] ul')).toHaveCount(0);
		await expect(folderRow(tree, "docs")).toHaveAttribute("data-holds-opened");
	});
	// Opening a file inside it from its own header unfolds it.
	await expand(page, "src/n.ts");
	await withTree(page, async (tree) => {
		await expect(folderRow(tree, "src")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		await expect(folderRow(tree, "src")).toHaveAttribute("data-holds-opened");
	});
});

test("a renamed file's old path opens it; a folder of old paths is a ghost; fold all and open all", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr({
		base: { "old/moved.ts": "moved\n", "keep/a.ts": "a\n" },
		files: [
			{
				message: "PR change",
				rename: { "old/moved.ts": "new/moved.ts" },
				files: { "keep/a.ts": "a changed\n" },
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	// The diff list has the file once, at its new path.
	await expect(page.locator("[data-file-index]")).toHaveCount(2);
	await withTree(page, async (tree) => {
		const ghost = tree.locator('button[data-folder="old"]');
		await expect(ghost).toHaveAttribute("data-ghost");
		await expect(ghost.getByTestId("tree-meter")).toHaveCount(0);
		await expect(ghost.getByTestId("tree-numbers")).toHaveCount(0);
		await expect(
			tree.locator('button[data-folder="new"]').getByTestId("tree-meter"),
		).toBeVisible();
	});
	await pickInTree(page, /moved\.ts.*moved away/);
	const section = fileSection(page, "new/moved.ts");
	await expect(
		section.getByRole("button", { name: "Collapse file" }),
	).toBeVisible();
	// The toolbar sits above the tree: in the sheet on a phone (withTree).
	await withTree(page, async (tree) => {
		const panel = tree.locator("xpath=..");
		await panel.getByRole("button", { name: "Fold all" }).click();
		await expect(tree.locator("button[aria-expanded=true]")).toHaveCount(0);
		await expect(tree.locator("button[aria-expanded=false]")).toHaveCount(3);
		await expect(tree.locator("button[data-moved]")).toHaveCount(0);
		await panel.getByRole("button", { name: "Open all" }).click();
		await expect(tree.locator("button[aria-expanded=false]")).toHaveCount(0);
		await expect(tree.locator("button[data-moved]")).toHaveCount(1);
	});
});

test("the tree and the diff list share one order: folders first, then files, by name", async ({
	page,
	pr,
	startCrb,
}) => {
	// Git's order would be README.md, lib/…, src/B.ts, src/a…, src/z/….
	await pr({
		base: { "keep.txt": "keep\n" },
		files: [
			{
				message: "PR change",
				files: {
					"README.md": "readme\n",
					"lib/x.ts": "x\n",
					"src/B.ts": "b\n",
					"src/a.ts": "a\n",
					"src/a10.ts": "a10\n",
					"src/a2.ts": "a2\n",
					"src/z/b.ts": "zb\n",
				},
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const order = [
		"lib/x.ts",
		"src/z/b.ts",
		"src/a.ts",
		"src/a2.ts",
		"src/a10.ts",
		"src/B.ts",
		"README.md",
	];
	await expect(page.locator("[data-file-index] > header")).toHaveCount(7);
	const sections = await page
		.locator("[data-file-index]")
		.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
	expect(sections).toEqual(order);
	await withTree(page, async (tree) => {
		const rows = tree.locator("button:not([aria-expanded])");
		await expect(rows).toHaveCount(7);
		const names = await rows.evaluateAll((els) =>
			els.map(
				(el) =>
					el.querySelector("[data-testid=tree-name]")?.textContent?.trim() ??
					"",
			),
		);
		expect(names).toEqual(order.map((p) => p.slice(p.lastIndexOf("/") + 1)));
		// The file being read is the first in that order, not git's first.
		await expect(rows.first()).toHaveAttribute("aria-current", "true");
	});
});
