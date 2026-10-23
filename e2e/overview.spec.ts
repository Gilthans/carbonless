import { reviewThread } from "../test/fake-gh/scenario";
import { expect, test } from "./fixtures";

const botThreadNoReply = reviewThread({
	path: "src/bot.ts",
	line: 3,
	comments: {
		totalCount: 1,
		nodes: [
			{
				author: { login: "lint-bot", __typename: "Bot" },
				body: "Unused import",
				createdAt: "2026-01-03T09:00:00Z",
			},
		],
	},
});
const humanThreadWithReply = reviewThread({ path: "src/cache.ts", line: 42 });

test("shows what the PR does, who's on it and whether it's ready", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr({
		overview: { title: "Add widgets", isDraft: true },
		threads: [botThreadNoReply, humanThreadWithReply],
	});
	const s = await startCrb();
	await page.goto(s.url);
	await expect(
		page.getByRole("region", { name: "What it does" }),
	).toContainText("Add widgets");
	await expect(page.getByRole("region", { name: "Is it ready" })).toContainText(
		"Draft",
	);
	await expect(
		page.getByRole("region", { name: "Is it ready" }).getByText("No reply"),
	).toBeVisible();
	const noReply = page
		.getByRole("region", { name: "Is it ready" })
		.getByRole("list", { name: "No reply" });
	await expect(noReply.getByRole("listitem")).toHaveCount(1);
	await expect(noReply).toContainText("src/bot.ts:3");
	await expect(noReply).not.toContainText("src/cache.ts");
});

test("shows who started reviewing and the description as markdown", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr({
		overview: { body: "Caches **widgets**.\n\n- [x] tested" },
		reviews: [
			{
				author: { login: "rev1", __typename: "User" },
				state: "CHANGES_REQUESTED",
				submittedAt: "2026-01-03T09:00:00Z",
			},
			{
				author: { login: "rev1", __typename: "User" },
				state: "COMMENTED",
				submittedAt: "2026-01-04T09:00:00Z",
			},
		],
	});
	const s = await startCrb();
	await page.goto(s.url);
	const what = page.getByRole("region", { name: "What it does" });
	await expect(what.locator("strong")).toHaveText("widgets");
	await expect(what.getByRole("checkbox")).toBeChecked();
	const who = page.getByRole("region", { name: "Who's on it" });
	await expect(who).toContainText("rev1 already started");
	await expect(who).toContainText("Changes requested");
});

test("Review files opens the files tab, which survives a reload", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr();
	const s = await startCrb();
	await page.goto(s.url);
	const review = page.getByRole("link", { name: /Review files/ });
	await expect(review).toContainText("0 / 2");
	await review.click();
	await expect(page).toHaveURL(/\/files$/);
	await expect(
		page.getByRole("link", { name: "Files changed" }),
	).toHaveAttribute("aria-current", "page");
	await page.reload();
	await expect(
		page.getByRole("link", { name: "Files changed" }),
	).toHaveAttribute("aria-current", "page");
	await page.getByRole("link", { name: "Overview" }).click();
	await expect(
		page.getByRole("region", { name: "What it does" }),
	).toBeVisible();
});

test("Refresh reloads the PR from GitHub", async ({ page, pr, startCrb }) => {
	const p = await pr({ overview: { title: "First title" } });
	const s = await startCrb();
	await page.goto(s.url);
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		"First title",
	);
	p.moveHead({ message: "more", files: { "b.txt": "b\n" } });
	await page.getByRole("button", { name: "Refresh" }).click();
	await expect(page.getByRole("link", { name: /Review files/ })).toContainText(
		"0 / 3",
	);
});
