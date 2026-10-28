import type { Page } from "@playwright/test";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import { openFiles } from "./files-ui";
import { expect, type Pr, type PrOptions, test } from "./fixtures";

/** One open thread on new.txt, so the Overview has a reply box. */
const fixture: PrOptions = {
	baseDate: "2026-01-01T00:00:00Z",
	files: [
		{
			message: "PR change",
			files: { "new.txt": "new\n" },
			date: "2026-01-02T00:00:00Z",
		},
	],
};

async function setup(pr: (opts?: PrOptions) => Promise<Pr>) {
	const p = await pr(fixture);
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((s) => {
		const graph = s.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: "new.txt", line: 1, subjectType: "LINE" }, [
				threadComment({
					login: "rev1",
					text: "Why new?",
					createdAt: "2026-01-02T09:00:00Z",
					commit: head,
					diffHunk: "@@ -0,0 +1 @@\n+new",
				}),
			]),
		];
	});
	return p;
}

const help = (page: Page) =>
	page.getByRole("dialog", { name: "Keyboard shortcuts" });

const overflow = (page: Page) =>
	page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);

test("? opens the shortcuts help on Overview and Files changed; Escape closes it", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "no keyboard on a phone: the help isn't offered");
	await setup(pr);
	const s = await startCrb();
	await page.goto(s.url);
	await expect(
		page.getByRole("region", { name: "Human reviews" }),
	).toBeVisible();
	await page.keyboard.press("Shift+Slash");
	const dialog = help(page);
	await expect(dialog).toBeVisible();
	// The current page's group first (Overview has none yet: Global leads),
	// the reply box's own keys under Threads.
	const groups = dialog.locator("section");
	await expect(groups.first()).toHaveAttribute("aria-label", "Global");
	const threads = dialog.getByRole("region", { name: "Threads" });
	await expect(threads).toContainText("Send the reply");
	await expect(threads.locator("kbd").nth(1)).toHaveText("Enter");
	await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	// ? toggles it too.
	await page.keyboard.press("Shift+Slash");
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Shift+Slash");
	await expect(dialog).toBeHidden();

	await openFiles(page, s.url);
	await page.keyboard.press("Shift+Slash");
	await expect(dialog).toBeVisible();
	const shots = process.env.DESIGN_SHOTS;
	if (shots) await page.screenshot({ path: `${shots}/shortcuts-desktop.png` });
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
});

test("Settings' Keyboard shortcuts entry opens the help, focus back on the gear", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "no keyboard on a phone: the help isn't offered");
	await setup(pr);
	const s = await startCrb();
	await page.goto(s.url);
	const gear = page
		.getByTestId("app-header-row")
		.getByRole("button", { name: "Settings" });
	await gear.click();
	const entry = page
		.getByRole("dialog", { name: "Settings" })
		.getByRole("button", { name: "Keyboard shortcuts" });
	expect((await entry.boundingBox())?.height).toBeGreaterThanOrEqual(40);
	await entry.click();
	const dialog = help(page);
	await expect(dialog).toBeVisible();
	await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
	await dialog.getByRole("button", { name: "Close" }).click();
	await expect(dialog).toBeHidden();
	await expect(gear).toBeFocused();
});

test("typing ? in a reply box types it, and doesn't open the help", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await setup(pr);
	const s = await startCrb();
	await page.goto(s.url);
	const card = page
		.getByRole("region", { name: "Human reviews" })
		.getByTestId("thread")
		.filter({ hasText: "new.txt" });
	const more = card.getByTestId("thread-more");
	if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
	const box = card.getByRole("textbox", { name: "Reply" });
	await box.click();
	await box.pressSequentially("why?");
	await expect(box).toHaveValue("why?");
	await expect(help(page)).toBeHidden();
});

test("on a phone, Settings has no shortcuts entry and nothing scrolls sideways", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "phone only");
	await page.setViewportSize({ width: 360, height: 780 });
	await setup(pr);
	const s = await startCrb();
	await page.goto(s.url);
	await page
		.getByTestId("app-header-row")
		.getByRole("button", { name: "Settings" })
		.click();
	const settings = page.getByRole("dialog", { name: "Settings" });
	await expect(settings.getByRole("switch").first()).toBeVisible();
	await expect(
		settings.getByRole("button", { name: "Keyboard shortcuts" }),
	).toHaveCount(0);
	expect(await overflow(page)).toBeLessThanOrEqual(0);
});
