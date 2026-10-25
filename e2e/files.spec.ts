import type { Page } from "@playwright/test";
import {
	barBottom,
	chooseUnit,
	fileAction,
	fileActionButton,
	fileProgress,
	fileSection,
	openFiles,
	pickInTree,
	progress,
	treeNumbers,
	withTree,
} from "./files-ui";
import { expect, type PrOptions, test } from "./fixtures";

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
		/^done · 2 clusters · 1 of 1 cluster reviewed, 1 crossed off$/,
	);
	await expect(bar).toContainText("1 / 3 clusters reviewed");
	// In files, a file with a crossed-off cluster counts as crossed off, never
	// reviewed: crossing off shrinks the work left only.
	await chooseUnit(page, "Files");
	await expect(bar).toContainText("0 / 2 files reviewed");
	await expect(bar).toHaveAttribute("aria-valuenow", "0");
	await expect(fileProgress(section)).toContainText("done · 1 crossed off");
	await chooseUnit(page, "Clusters");

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
	await expect(
		fileActionButton(section, "Mark remaining reviewed"),
	).toBeDisabled();
	await fileAction(section, "Undo cross-off");
	// Only the crossed-off cluster went back to unreviewed.
	await expect(bar).toContainText("1 / 4 clusters reviewed");
	await expect(bar).toHaveAttribute("aria-valuenow", "25");
	await expect(fileActionButton(section, "Undo cross-off")).toHaveCount(0);
	await expect(fileActionButton(section, "Cross off file")).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect(fileActionButton(section, "Cross off file")).toBeEnabled();
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
	// All reviewed: nothing to cross off, undo or mark.
	await expect(fileActionButton(section, "Cross off file")).toBeDisabled();
	await expect(fileActionButton(section, "Undo cross-off")).toHaveCount(0);
	await expect(
		fileActionButton(section, "Mark remaining reviewed"),
	).toBeDisabled();
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
	await expect(page.getByRole("checkbox")).toHaveCount(0);
	await withTree(page, (tree) =>
		expect(tree.getByRole("button")).toHaveCount(3),
	);
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

test("tree rows show progress as aligned mini bars and counts in the unit", async ({
	page,
	pr,
	startCrb,
	isMobile,
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
	await expect(header).toContainText("+3 −2");

	await chooseUnit(page, "Clusters");
	await withTree(page, async (tree) => {
		const core = tree.getByRole("button", { name: /core\.ts/ });
		await expect(core).not.toContainText("+3");
		const count = core.getByRole("img", { name: "2 clusters" });
		await expect(count).toHaveText("2");
		await expect(count).not.toHaveAttribute("title");
		await expect(treeNumbers(tree, /core\.ts/)).toHaveText(
			"0 of 2 clusters reviewed",
		);
	});
	// A phone's two-row header leaves the count to the tree.
	// (Decorative: the progress summary carries the name.)
	await expect(
		header.locator("[aria-hidden=true]").filter({ hasText: /^2$/ }),
	).toBeVisible({ visible: !isMobile });

	await chooseUnit(page, "Files");
	await withTree(page, async (tree) => {
		const core = tree.getByRole("button", { name: /core\.ts/ });
		await expect(core).not.toContainText("+3");
		await expect(core.getByRole("img", { name: /clusters?$/ })).toHaveCount(0);
		await expect(treeNumbers(tree, /util\.ts/)).toHaveText("done");
	});
	await expect(header).not.toContainText("+3");
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
