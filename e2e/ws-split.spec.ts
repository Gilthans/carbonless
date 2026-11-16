import type { Locator, Page } from "@playwright/test";
import { buildSnapshot } from "../src/server/diff/snapshot";
import { RefStore } from "../src/server/review/refStore";
import { ReviewService } from "../src/server/review/reviews";
import type { Cluster, Snapshot } from "../src/shared/types";
import {
	fileSection,
	ignoreWhitespace,
	openFiles,
	progress,
	sideBySide,
} from "./files-ui";
import { expect, type PrOptions, reviewPage, test } from "./fixtures";

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

const leftOut = (page: Page) =>
	page.getByRole("img", { name: "1 whitespace-only cluster not counted" });

test("change / whitespace-only / change in one hunk is three clusters; Ignore whitespace leaves the middle one out of progress, and counts it again when off", async ({
	page,
	pr,
	startCrb,
}) => {
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
	await expect(leftOut(page)).toHaveCount(0);
	await ignoreWhitespace(page, true);
	await expect(files).toContainText("2 / 2 clusters · 100%");
	await expect(leftOut(page)).toBeVisible();
});

test.describe("a review started before the split", () => {
	test.use({ crbServer: "own" });

	test("keeps its mark on the whole hunk: all three pieces open reviewed", async ({
		page,
		pr,
		startCrb,
	}) => {
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
