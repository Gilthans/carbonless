import type { Page } from "@playwright/test";
import {
	chooseUnit,
	fileAction,
	fileActionButton,
	fileProgress,
	fileSection,
	openFiles,
	progress,
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
		expect(tree.getByRole("button", { name: /core\.ts/ })).toContainText(
			"1 / 2",
		),
	);

	// Every count follows the unit.
	await chooseUnit(page, "Lines");
	await expect(bar).toContainText("3 / 7 lines reviewed");
	await expect(bar).toHaveAttribute("aria-valuenow", "42");
	await expect(fileProgress(section)).toContainText("3 / 5 lines");
	await withTree(page, (tree) =>
		expect(tree.getByRole("button", { name: /core\.ts/ })).toContainText(
			"3 / 5",
		),
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
		"1 of 1 clusters reviewed, 1 crossed off",
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
	await expect(fileProgress(section)).toContainText("0 / 1 clusters");

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
		await expect(entry).toContainText("2 / 2");
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
	isMobile,
}) => {
	test.skip(isMobile, "desktop layout: the actions sit inline");
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
	await expect(cross).toHaveAttribute("title", /not needing review/);
	await expect(mark).toBeVisible();
	await expect(mark).toHaveText("✓", { useInnerText: true });
	await expect(mark).toHaveAttribute("title", /as reviewed/);
	await expect(
		section.getByRole("button", { name: "File actions" }),
	).toBeHidden();
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
