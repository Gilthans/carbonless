import type { Page } from "@playwright/test";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import { expect, test } from "./fixtures";

const botThreadNoReply = reviewThread({ path: "src/bot.ts", line: 3 }, [
	threadComment({
		login: "lint-bot",
		bot: true,
		text: "Unused import of fs in this module",
		html: '<p dir="auto">Unused import of <code class="notranslate">fs</code> in this module</p>',
	}),
]);

/** What GitHub renders for a description with a comment, emoji and a task list. */
const RICH_BODY_HTML = [
	'<div class="markdown-heading" dir="auto"><h2 class="heading-element" dir="auto">Why</h2><a id="user-content-why" class="anchor" aria-label="Permalink: Why" href="#why"><svg class="octicon octicon-link" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M7.775 3.275a.75.75 0 0 0 1.06 1.06l1.25-1.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95l-1.25 1.25Z"></path></svg></a></div>',
	'<p dir="auto">Caches <strong>widgets</strong>. <g-emoji class="g-emoji" alias="rocket">🚀</g-emoji> <img class="emoji" title=":shipit:" alt=":shipit:" src="https://github.githubassets.com/images/icons/emoji/shipit.png" height="20" width="20" align="absmiddle"></p>',
	'<ul class="contains-task-list">\n<li class="task-list-item"><input type="checkbox" id="" disabled="" class="task-list-item-checkbox" checked=""> tested</li>\n</ul>',
].join("\n");

/** Images come from GitHub's CDN; serve a 1×1 PNG so tests stay offline. */
async function stubImages(page: Page) {
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
		"base64",
	);
	await page.route("https://**/*", (route) =>
		route.fulfill({ contentType: "image/png", body: png }),
	);
}
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

test("shows the description as GitHub renders it, and who started reviewing", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await stubImages(page);
	await pr({
		overview: {
			body: "## Why\n\n<!-- reviewer note -->\nCaches **widgets**. :rocket: :shipit:\n\n- [x] tested",
		},
		bodyHTML: RICH_BODY_HTML,
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
	await expect(what.getByRole("heading", { name: "Why" })).toBeVisible();
	await expect(what.locator("strong")).toHaveText("widgets");
	await expect(what).toContainText("🚀");
	await expect(what.getByAltText(":shipit:")).toBeVisible();
	await expect(what.getByRole("checkbox")).toBeChecked();
	await expect(what).not.toContainText("<!--");
	await expect(what).not.toContainText("reviewer note");
	const who = page.getByRole("region", { name: "Who's on it" });
	await expect(who).toContainText("rev1 already started");
	const changes = who.getByRole("img", { name: "Changes requested" });
	await expect(changes).toBeVisible();
	// The icon's name shows on tap (phone) or keyboard focus, not only on hover.
	if (isMobile) await changes.tap();
	else await changes.focus();
	await expect(
		page.getByText("Changes requested", { exact: true }),
	).toBeVisible();
});

test("links to GitHub with its mark and shows dates as relative times", async ({
	page,
	pr,
	startCrb,
}) => {
	const updated = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
	await pr({ overview: { updatedAt: updated } });
	const s = await startCrb();
	await page.goto(s.url);
	const what = page.getByRole("region", { name: "What it does" });
	const github = what.getByRole("link", { name: "View on GitHub" });
	await expect(github).toHaveAttribute(
		"href",
		"https://github.com/acme/widget/pull/7",
	);
	await expect(github).not.toHaveText(/\S/);
	const box = await github.boundingBox();
	expect(box?.width).toBeGreaterThanOrEqual(40);
	expect(box?.height).toBeGreaterThanOrEqual(40);

	const time = what.locator(`time[datetime="${updated}"]`);
	await expect(time).toHaveText("3 hours ago");
	const full = await page.evaluate(
		(iso) =>
			new Intl.DateTimeFormat(undefined, { timeZoneName: "long" })
				.formatToParts(new Date(iso))
				.find((p) => p.type === "timeZoneName")?.value ?? "",
		updated,
	);
	await time.focus();
	const tip = page.getByRole("tooltip");
	await expect(tip).toBeVisible();
	await expect(tip).toContainText(full);
	await expect(tip).toContainText(String(new Date(updated).getFullYear()));
	await expect(time).toHaveAccessibleDescription(await tip.innerText());
	// The tooltip stays inside the viewport.
	const tipBox = await tip.boundingBox();
	const width = page.viewportSize()?.width ?? 0;
	expect(tipBox && tipBox.x >= 0 && tipBox.x + tipBox.width <= width).toBe(
		true,
	);
	await page.keyboard.press("Escape");
	await expect(tip).toBeHidden();
});

test("a thread previews its first comment and expands to GitHub's rendering", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr({ threads: [botThreadNoReply] });
	const s = await startCrb();
	await page.goto(s.url);
	const bots = page
		.getByRole("region", { name: "Is it ready" })
		.getByRole("list", { name: "Bots" });
	const preview = bots.locator("summary");
	await expect(preview).toContainText("Unused import of fs in this module");
	await expect(bots.locator("code.notranslate")).toBeHidden();
	await preview.click();
	await expect(bots.locator(".markdown-body code")).toHaveText("fs");
	await expect(bots.locator("time")).toHaveAttribute(
		"datetime",
		"2026-01-03T09:00:00Z",
	);
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

test("no element on the Overview page uses a native title tooltip", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr({});
	const s = await startCrb();
	await page.goto(s.url);
	await expect(
		page.getByRole("region", { name: "What it does" }),
	).toBeVisible();
	// The description is GitHub's own HTML (emoji images carry their title);
	// everything the app renders itself has none.
	await expect(page.locator("[title]:not(.markdown-body *)")).toHaveCount(0);
});
