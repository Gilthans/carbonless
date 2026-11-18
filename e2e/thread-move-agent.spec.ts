import type { Locator, Page } from "@playwright/test";
import { ask, CALC, expect, fixture, openFile, row, test } from "./agent-ui";
import { expectNoPageOverflow, fileSection } from "./files-ui";

// Its own crb serve: the agent config and its fake ACP agent.
test.use({ crbServer: "own" });

/*
 * Moving an agent thread (CAR-139): the same handle, chip and Undo as a
 * review thread's, on the agent's own card; the collapsed (resolved)
 * card's header keeps them in view at 360px.
 */

const GIT_WAIT = { timeout: 30_000 };

const LINES = Array.from(
	{ length: 12 },
	(_, i) => `export const v${i + 1} = ${i + 1};`,
).map((l, i) => (i === 2 ? "export const total = v1 + v2;" : l));

const agentCard = (page: Page) =>
	page.getByTestId("agent-thread").filter({ hasText: "Why the total?" });

/** Views the PR's new head `oid` once the toast names it. */
async function viewHead(page: Page, oid: string) {
	await page.reload();
	const toast = page.getByTestId("head-toast");
	await expect(toast).toContainText(oid.slice(0, 7), GIT_WAIT);
	await toast.getByRole("button", { name: "View" }).click();
	await expect(
		page.getByRole("button", { name: `head ${oid.slice(0, 7)}` }),
	).toBeVisible(GIT_WAIT);
}

/** Opens the agent thread on line `n` of the file (its bubble). */
async function openOn(section: Locator, page: Page, n: number) {
	const bubble = row(section, n).getByTestId("agent-bubble");
	await expect(bubble).toBeVisible(GIT_WAIT);
	if ((await bubble.getAttribute("aria-expanded")) !== "true") {
		await bubble.click();
	}
	await expect(agentCard(page)).toBeVisible();
	return agentCard(page);
}

test("an agent thread moved like a review thread: the chip, Undo focused, a reload keeps it, Undo brings it back; resolved at 360px nothing overflows", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	test.setTimeout(150_000);
	const p = await pr(fixture);
	const s = await agentCrb();
	const asked = await ask(
		page,
		await openFile(page, s.url, CALC),
		3,
		"Why the total?",
	);
	await expect(asked).toHaveAttribute("aria-label", "Agent thread, answered");
	// A push: two lines on top. Asked on the head before, it is traced now.
	const h2 = p.moveHead({
		message: "two on top",
		files: { [CALC]: `// a\n// b\n${LINES.join("\n")}\n` },
	});
	await viewHead(page, h2);
	const section = fileSection(page, CALC);
	await section.getByRole("button", { name: "Expand file" }).click();
	const card = await openOn(section, page, 5);
	const handle = card.getByTestId("move-handle");
	await expect(handle).toBeVisible(GIT_WAIT);
	if (isMobile) {
		await handle.click();
		await expect(page.getByTestId("move-bar")).toBeVisible();
		await row(section, 7).getByTestId("new").click();
		await page
			.getByTestId("selection-bar")
			.getByRole("button", { name: "Place here" })
			.click();
	} else {
		const from = await handle.boundingBox();
		if (!from) throw new Error("no handle");
		await page.mouse.move(from.x + 20, from.y + 20);
		await page.mouse.down();
		await page.mouse.move(from.x + 50, from.y + 50, { steps: 4 });
		// The card under line 5 pushes line 7 down: in view before the drop.
		await row(section, 7).scrollIntoViewIfNeeded();
		const to = await row(section, 7).boundingBox();
		if (!to) throw new Error("no row");
		await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
			steps: 8,
		});
		await page.mouse.up();
	}
	await expect(row(section, 7).getByTestId("agent-bubble")).toBeVisible();
	await expect(row(section, 5).getByTestId("agent-bubble")).toHaveCount(0);
	const moved = agentCard(page);
	await expect(moved.getByTestId("moved-chip")).toHaveText("moved");
	const undo = moved.getByRole("button", { name: "Undo move" });
	await expect(undo).toBeFocused();
	// A reload keeps it.
	await page.reload();
	const again = fileSection(page, CALC);
	await again.getByRole("button", { name: "Expand file" }).click();
	const reopened = await openOn(again, page, 7);
	await expect(reopened.getByTestId("moved-chip")).toBeVisible();
	if (isMobile) {
		// Resolved, its header closes to one row: still all in view at 360px.
		await reopened.getByTestId("agent-resolve").click();
		await expect(reopened).toHaveAttribute("data-closed", "true");
		const size = page.viewportSize();
		await page.setViewportSize({ width: 360, height: size?.height ?? 740 });
		await expectNoPageOverflow(page);
		const box = await reopened.boundingBox();
		for (const name of ["Show thread", "Undo move", "Move thread"]) {
			const b = await reopened.getByRole("button", { name }).boundingBox();
			expect(b, name).not.toBeNull();
			if (b && box) {
				expect(b.x + b.width, name).toBeLessThanOrEqual(box.x + box.width + 1);
				expect(b.height, name).toBeGreaterThanOrEqual(40);
			}
		}
		if (size) await page.setViewportSize(size);
	}
	// Undo: back where the tracer had it.
	await reopened.getByRole("button", { name: "Undo move" }).click();
	await expect(row(again, 5).getByTestId("agent-bubble")).toBeVisible(GIT_WAIT);
	await expect(row(again, 7).getByTestId("agent-bubble")).toHaveCount(0);
});
