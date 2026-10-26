import type { Page, Route } from "@playwright/test";
import {
	fileAction,
	fileActionButton,
	fileProgress,
	fileSection,
	openFiles,
	progress,
} from "./files-ui";
import { expect, type PrOptions, test } from "./fixtures";

const text = (lines: string[]) => `${lines.join("\n")}\n`;
const lines = (name: string, n: number) =>
	Array.from({ length: n }, (_, i) => `${name} ${i + 1}`);

/** Two files of one cluster each. */
const fixture: PrOptions = {
	base: {
		"src/a.ts": text(lines("a", 10)),
		"src/b.ts": text(lines("b", 10)),
	},
	files: [
		{
			message: "PR change",
			files: {
				"src/a.ts": text(lines("a", 10).map((l, i) => (i === 2 ? "a 3!" : l))),
				"src/b.ts": text(lines("b", 10).map((l, i) => (i === 5 ? "b 6!" : l))),
			},
		},
	],
};

/**
 * Holds every state write until `release()`; each then gets `answer`, or
 * goes through to the server when `answer` is "pass".
 */
async function holdWrites(page: Page) {
	const held: Route[] = [];
	await page.route("**/api/review/states", (route) => {
		held.push(route);
	});
	return {
		count: () => held.length,
		release: async (answer: "pass" | { status: number; error: string }) => {
			for (const route of held.splice(0)) {
				if (answer === "pass") await route.continue();
				else {
					await route.fulfill({
						status: answer.status,
						contentType: "application/json",
						body: JSON.stringify({ error: answer.error }),
					});
				}
			}
		},
	};
}

test("a click shows at once while its write is held, and a reload shows what was stored", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const writes = await holdWrites(page);
	const a = fileSection(page, "src/a.ts");
	await fileAction(a, "Mark remaining reviewed");
	// Reviewed before the server answers.
	await expect(fileProgress(a)).toContainText("1 / 1 cluster");
	await expect(progress(page)).toContainText("1 / 2 clusters reviewed");
	await expect(fileActionButton(a, "Mark remaining reviewed")).toBeDisabled();
	await expect.poll(writes.count).toBe(1);
	// The delayed notice after 5 s, naming what waits; gone once stored.
	const delayed = page.getByTestId("save-delayed");
	await expect(delayed).toBeVisible({ timeout: 8000 });
	await expect(delayed).toContainText("Saving 1 change…");
	await expect(delayed).toContainText("Reviewed · src/a.ts");
	await expect(page.getByRole("status").filter({ has: delayed })).toBeVisible();
	await writes.release("pass");
	await expect(delayed).toBeHidden();
	await page.unroute("**/api/review/states");

	await page.reload();
	await expect(fileProgress(fileSection(page, "src/a.ts"))).toContainText(
		"1 / 1 cluster",
	);
	await expect(progress(page)).toContainText("1 / 2 clusters reviewed");
});

test("a failing write shows what failed with its message, and Retry saves it", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/400|Failed to load resource/);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const writes = await holdWrites(page);
	const b = fileSection(page, "src/b.ts");
	await fileAction(b, "Cross off file");
	await expect(fileActionButton(b, "Undo cross-off")).toBeVisible();
	await expect.poll(writes.count).toBe(1);
	await writes.release({ status: 400, error: "disk full" });
	const alert = page.getByRole("alert").filter({ hasText: "disk full" });
	await expect(alert).toBeVisible();
	await expect(alert).toContainText("Crossed off · src/b.ts");
	// Still crossed off on screen.
	await expect(fileActionButton(b, "Undo cross-off")).toBeVisible();
	const retry = alert.getByRole("button", { name: "Retry saving" });
	const box = await retry.boundingBox();
	expect(box?.width).toBeGreaterThanOrEqual(40);
	expect(box?.height).toBeGreaterThanOrEqual(40);

	await page.unroute("**/api/review/states");
	await retry.click();
	await expect(alert).toBeHidden();
	await page.reload();
	await expect(
		fileActionButton(fileSection(page, "src/b.ts"), "Undo cross-off"),
	).toBeVisible();
});

/** A long file (its open header sticks while scrolling) and a short one. */
const longFixture: PrOptions = {
	base: {
		"src/a.ts": text(lines("a", 300)),
		"src/b.ts": text(lines("b", 10)),
	},
	files: [
		{
			message: "PR change",
			files: {
				"src/a.ts": text(
					lines("a", 300).map((l, i) => (i % 10 === 2 ? `${l}!` : l)),
				),
				"src/b.ts": text(lines("b", 10).map((l, i) => (i === 5 ? "b 6!" : l))),
			},
		},
	],
};

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
	a.x < b.x + b.width &&
	b.x < a.x + a.width &&
	a.y < b.y + b.height &&
	b.y < a.y + a.height;

test("the save notices stay clear of the sticky header, the tree and the Files button", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
	isMobile,
}) => {
	expectConsoleError(/400|Failed to load resource/);
	if (isMobile) await page.setViewportSize({ width: 360, height: 740 });
	await pr(longFixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const writes = await holdWrites(page);
	// A refused change (red) and one still waiting (yellow), both at once.
	await fileAction(fileSection(page, "src/b.ts"), "Cross off file");
	await expect.poll(writes.count).toBe(1);
	await writes.release({ status: 422, error: "Unknown cluster key" });
	const alert = page.getByRole("alert").filter({ hasText: "Unknown cluster" });
	await expect(alert).toBeVisible();
	const a = fileSection(page, "src/a.ts");
	await a.getByRole("button", { name: "Expand file" }).click();
	await a
		.getByRole("checkbox", { name: "Mark cluster reviewed" })
		.first()
		.click();
	await expect(page.getByTestId("save-delayed")).toBeVisible({ timeout: 8000 });
	// Read on: a's header sticks at the top.
	await page.mouse.wheel(0, 1500);
	const header = a.locator("header");
	await expect(header).toHaveCSS("position", "sticky");
	await expect(header).toBeInViewport();

	const width = await page.evaluate(() => document.documentElement.scrollWidth);
	expect(width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
	const notices = await page.getByTestId("sync-notices").locator("> *").all();
	const clear: Box[] = [];
	const headerBox = await header.boundingBox();
	if (headerBox) clear.push(headerBox);
	const files = page.getByRole("button", { name: "Files", exact: true });
	if (await files.isVisible()) {
		const box = await files.boundingBox();
		if (box) clear.push(box);
	}
	// The tree's column, top to bottom: its rows may reach the bottom.
	const tree = page.getByTestId("file-tree");
	if (await tree.isVisible()) {
		const box = await tree.boundingBox();
		const height = page.viewportSize()?.height ?? 0;
		if (box) clear.push({ x: box.x, width: box.width, y: 0, height });
	}
	expect(clear.length).toBe(2);
	for (const notice of notices) {
		const box = await notice.boundingBox();
		if (!box || box.height === 0) continue;
		for (const other of clear) expect(overlaps(box, other)).toBe(false);
	}
	const retry = await alert
		.getByRole("button", { name: "Retry saving" })
		.boundingBox();
	expect(retry?.width).toBeGreaterThanOrEqual(40);
	expect(retry?.height).toBeGreaterThanOrEqual(40);
	await writes.release("pass");
});

test("a change refused for good doesn't hold up the next ones", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/400|Failed to load resource/);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	// The first key written is refused every time; the rest go through.
	let refused: string | undefined;
	await page.route("**/api/review/states", async (route) => {
		const { changes } = route.request().postDataJSON() as {
			changes: { key: string }[];
		};
		refused ??= changes[0]?.key;
		if (changes.some((c) => c.key === refused)) {
			await route.fulfill({
				status: 400,
				contentType: "application/json",
				body: JSON.stringify({ error: "Unknown cluster key" }),
			});
		} else await route.continue();
	});
	await fileAction(fileSection(page, "src/a.ts"), "Mark remaining reviewed");
	const alert = page.getByRole("alert").filter({ hasText: "Unknown cluster" });
	await expect(alert).toContainText("Reviewed · src/a.ts");
	await fileAction(fileSection(page, "src/b.ts"), "Mark remaining reviewed");
	await expect(progress(page)).toContainText("2 / 2 clusters reviewed");
	// b is stored: only a is left unsaved.
	await expect(alert).toContainText("Reviewed · src/a.ts");
	await expect(page.getByTestId("save-delayed")).toHaveCount(0);
	await page.unroute("**/api/review/states");
	await page.reload();
	await expect(progress(page)).toContainText("1 / 2 clusters reviewed");
	await expect(fileProgress(fileSection(page, "src/b.ts"))).toContainText(
		"1 / 1 cluster",
	);
});

test("a write that fails transiently is retried and stored, with no error", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/503|Failed to load resource/);
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	let failures = 0;
	await page.route("**/api/review/states", async (route) => {
		if (failures < 2) {
			failures++;
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({ error: "busy" }),
			});
		} else await route.continue();
	});
	await fileAction(fileSection(page, "src/a.ts"), "Mark remaining reviewed");
	// Two retries (1 s, then 2 s), then stored.
	await expect(page.getByTestId("sync-notices")).toHaveCount(0, {
		timeout: 10_000,
	});
	expect(failures).toBe(2);
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.unroute("**/api/review/states");
	await page.reload();
	await expect(fileProgress(fileSection(page, "src/a.ts"))).toContainText(
		"1 / 1 cluster",
	);
});

/** Enough files that the page scrolls. */
const manyFixture: PrOptions = {
	base: Object.fromEntries(
		Array.from({ length: 20 }, (_, i) => [`f${i}.ts`, text(lines("x", 5))]),
	),
	files: [
		{
			message: "PR change",
			files: Object.fromEntries(
				Array.from({ length: 20 }, (_, i) => [
					`f${i}.ts`,
					text(lines("x", 5).map((l, j) => (j === 2 ? `${l}!` : l))),
				]),
			),
		},
	],
};

test("the last file header can scroll clear of a notice", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/400|Failed to load resource/);
	await pr(manyFixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await page.route("**/api/review/states", (route) =>
		route.fulfill({
			status: 400,
			contentType: "application/json",
			body: JSON.stringify({ error: "Unknown cluster key" }),
		}),
	);
	await fileAction(fileSection(page, "f0.ts"), "Mark remaining reviewed");
	await fileAction(fileSection(page, "f1.ts"), "Cross off file");
	const alert = page.getByRole("alert").filter({ hasText: "Unknown cluster" });
	await expect(alert).toContainText("2 changes in 2 files");
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	const sections = page.locator("section[data-file-index]");
	const lastHeader = sections.last().locator("header");
	await expect(lastHeader).toBeInViewport();
	await expect
		.poll(async () => {
			const header = await lastHeader.boundingBox();
			const notice = await alert.boundingBox();
			return (header?.y ?? 0) + (header?.height ?? 0) <= (notice?.y ?? 0);
		})
		.toBe(true);
});
