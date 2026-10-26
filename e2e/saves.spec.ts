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

test("the save notices fit a phone and leave the file header's controls free", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/400|Failed to load resource/);
	await page.setViewportSize({ width: 360, height: 740 });
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const writes = await holdWrites(page);
	const a = fileSection(page, "src/a.ts");
	await fileAction(a, "Mark remaining reviewed");
	await expect.poll(writes.count).toBe(1);
	await writes.release({ status: 422, error: "Unknown cluster key" });
	const alert = page.getByRole("alert").filter({ hasText: "Unknown cluster" });
	await expect(alert).toBeVisible();
	const width = await page.evaluate(() => document.documentElement.scrollWidth);
	expect(width).toBeLessThanOrEqual(360);
	// Over the bottom of the window, clear of the header at the top.
	const notice = await alert.boundingBox();
	const header = await a.locator("header").boundingBox();
	expect(notice && header).toBeTruthy();
	if (notice && header) {
		expect(notice.y).toBeGreaterThan(header.y + header.height);
	}
});
