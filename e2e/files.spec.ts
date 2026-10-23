import type { Page } from "@playwright/test";
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

const fileSection = (page: Page, path: string) =>
	page.getByRole("region", { name: path });

async function openFiles(page: Page, url: string) {
	await page.goto(new URL("/files", url).href);
	await expect(
		page.getByRole("progressbar", { name: "Clusters" }),
	).toBeVisible();
}

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
	const clusters = page.getByRole("progressbar", { name: "Clusters" });
	await expect(clusters).toHaveAttribute("aria-valuenow", "0");
	const section = await expand(page, "src/core.ts");
	const boxes = section.getByRole("checkbox", {
		name: "Mark cluster reviewed",
	});
	await expect(boxes).toHaveCount(2);
	await boxes.first().click();
	await expect(boxes.first()).toBeChecked();
	await expect(clusters).toHaveAttribute("aria-valuenow", "25");
	await expect(clusters).toContainText("1 / 4 reviewed");
	await expect(page.getByRole("progressbar", { name: "Lines" })).toContainText(
		"3 / 7 reviewed",
	);
	await expect(section).toContainText("1 of 2 clusters reviewed");
	await expect(page.getByTestId("file-tree")).toContainText("1/2");

	// Undo, and the state survives a reload.
	await boxes.first().click();
	await expect(clusters).toHaveAttribute("aria-valuenow", "0");
	await boxes.last().click();
	await expect(clusters).toHaveAttribute("aria-valuenow", "25");
	await page.reload();
	await expect(
		page.getByRole("progressbar", { name: "Clusters" }),
	).toHaveAttribute("aria-valuenow", "25");
});

test("cross off a file with a reason", async ({ page, pr, startCrb }) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, "docs/new.md");
	await expect(section).toContainText("docs/old.md → docs/new.md");
	await section.getByRole("button", { name: "Cross off file…" }).click();
	const dialog = page.getByRole("dialog", { name: "Cross off file" });
	await dialog.getByRole("button", { name: "rename only" }).click();
	await dialog.getByRole("button", { name: "Cross off" }).click();
	await expect(dialog).toBeHidden();

	const entry = page
		.getByTestId("file-tree")
		.getByRole("button", { name: /new\.md/ });
	await expect(entry.locator("s")).toHaveText("new.md");
	await expect(entry).toContainText("rename only");
	await expect(entry.getByRole("img", { name: "crossed off" })).toBeVisible();
	await expect(page.getByText(/^Crossed off, not reviewed:/)).toHaveText(
		"Crossed off, not reviewed: 1 clusters · 0 lines · 1 files",
	);
	const clusters = page.getByRole("progressbar", { name: "Clusters" });
	await expect(clusters).toHaveAttribute("aria-valuenow", "0");
	await expect(clusters).toContainText("0 / 3 reviewed");
});

test("mark remaining reviewed", async ({ page, pr, startCrb }) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, "src/core.ts");
	await section
		.getByRole("button", { name: "Mark remaining reviewed" })
		.click();
	await expect(section).toContainText("2 of 2 clusters reviewed");
	const entry = page
		.getByTestId("file-tree")
		.getByRole("button", { name: /core\.ts/ });
	await expect(entry).toContainText("2/2");
	await expect(entry.getByRole("img", { name: "done" })).toBeVisible();
	await expect(
		page.getByRole("progressbar", { name: "Clusters" }),
	).toHaveAttribute("aria-valuenow", "50");
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
	await expect(page.getByTestId("file-tree").getByRole("button")).toHaveCount(
		3,
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
	await expect(page.getByTestId("file-tree")).toContainText("b.txt");
	await expect(
		page.getByRole("progressbar", { name: "Clusters" }),
	).toContainText("0 / 5 reviewed");
});
