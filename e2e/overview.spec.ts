import type { Page } from "@playwright/test";
import {
	reviewThread,
	suggestionHtml,
	threadComment,
} from "../test/fake-gh/scenario";
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
	const ready = page.getByRole("region", { name: "Is it ready" });
	await expect(ready.getByRole("list", { name: "Readiness" })).toContainText(
		"Draft",
	);
	const bots = page.getByRole("region", { name: "Bot reviews" });
	const humans = page.getByRole("region", { name: "Human reviews" });
	await expect(bots.getByTestId("thread")).toContainText("src/bot.ts:3");
	await expect(bots.getByTestId("thread")).toContainText("no reply");
	await expect(humans.getByTestId("thread")).toContainText("src/cache.ts:42");
	await expect(humans.getByTestId("thread")).not.toContainText("no reply");
	await expect(page.getByRole("list", { name: "No reply" })).toHaveCount(0);
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

test.describe("in Israel's time zone", () => {
	test.use({ timezoneId: "Asia/Jerusalem" });

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
		// "2026 Aug 31, 22:11:13 Israel Time", in the browser's zone.
		const d = new Date(updated);
		const parts = Object.fromEntries(
			new Intl.DateTimeFormat("en", {
				timeZone: "Asia/Jerusalem",
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				hourCycle: "h23",
			})
				.formatToParts(d)
				.map((p) => [p.type, p.value]),
		);
		const full = `${parts.year} ${parts.month} ${parts.day}, ${parts.hour}:${parts.minute}:${parts.second} Israel Time`;
		await time.focus();
		const tip = page.getByRole("tooltip");
		await expect(tip).toBeVisible();
		await expect(tip).toHaveText(full);
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
});

test("a thread previews its first comment as GitHub renders it, clipped, with a toggle", async ({
	page,
	pr,
	startCrb,
}) => {
	const long = Array.from(
		{ length: 14 },
		(_, i) =>
			`<p dir="auto">Point ${i + 1}: use <code class="notranslate">fs/promises</code></p>`,
	).join("\n");
	await pr({
		threads: [
			botThreadNoReply,
			reviewThread({ path: "src/cache.ts", line: 42 }, [
				threadComment({ login: "rev1", text: "Points", html: long }),
				threadComment({ login: "octo-author", text: "Done" }),
				threadComment({ login: "rev1", text: "Thanks" }),
			]),
		],
	});
	const s = await startCrb();
	await page.goto(s.url);
	const bots = page.getByRole("region", { name: "Bot reviews" });
	// Short: shown in full as GitHub's HTML, nothing to expand.
	await expect(bots.locator(".markdown-body code")).toHaveText("fs");
	await expect(bots.getByRole("button", { name: "Show more" })).toHaveCount(0);
	await expect(bots.locator("time")).toHaveAttribute(
		"datetime",
		"2026-01-03T09:00:00Z",
	);
	await expect(bots.getByRole("img", { name: "1 comment" })).toBeVisible();

	const humans = page.getByRole("region", { name: "Human reviews" });
	await expect(humans.getByRole("img", { name: "3 comments" })).toHaveText("3");
	const body = humans.getByTestId("thread-body");
	const last = body.getByText("Point 14:");
	await expect(body.getByText("Point 1:")).toBeVisible();
	const clipped = await body.boundingBox();
	expect(clipped?.height).toBeLessThanOrEqual(130);
	await expect(last).not.toBeInViewport({ ratio: 1 });
	const more = humans.getByRole("button", { name: "Show more" });
	await more.click();
	await expect(
		humans.getByRole("button", { name: "Show less" }),
	).toHaveAttribute("aria-expanded", "true");
	const full = await body.boundingBox();
	expect(full?.height).toBeGreaterThan((clipped?.height ?? 0) + 100);
	await humans.getByRole("button", { name: "Show less" }).click();
	await expect(more).toHaveAttribute("aria-expanded", "false");
	expect((await body.boundingBox())?.height).toBeLessThanOrEqual(130);
	const box = await more.boundingBox();
	expect(box?.height).toBeGreaterThanOrEqual(40);
});

test("human and bot reviews sit inside Is it ready, count resolved threads and list unresolved ones", async ({
	page,
	pr,
	startCrb,
}) => {
	const resolved = (bot: boolean, path: string) =>
		reviewThread({ path, isResolved: true }, [
			threadComment({ login: bot ? "lint-bot" : "rev2", bot, text: "ok" }),
		]);
	await pr({
		threads: [
			botThreadNoReply,
			humanThreadWithReply,
			resolved(false, "src/a.ts"),
			resolved(false, "src/b.ts"),
			resolved(true, "src/c.ts"),
		],
	});
	const s = await startCrb();
	await page.goto(s.url);
	const humans = page.getByRole("region", { name: "Human reviews" });
	const bots = page.getByRole("region", { name: "Bot reviews" });
	await expect(humans.getByRole("list", { name: "Thread counts" })).toHaveText(
		"1 unresolved2 resolved",
	);
	await expect(bots.getByRole("list", { name: "Thread counts" })).toHaveText(
		"1 unresolved1 resolved",
	);
	await expect(humans.getByTestId("thread")).toHaveCount(1);
	await expect(bots.getByTestId("thread")).toHaveCount(1);
	await expect(page.getByText("src/a.ts")).toHaveCount(0);
	// Inside "Is it ready", below the checks, humans first.
	const ready = page.getByRole("region", { name: "Is it ready" });
	const order = await ready
		.getByRole("region")
		.evaluateAll((els) => els.map((el) => el.querySelector("h3")?.textContent));
	expect(order).toEqual(["Human reviews", "Bot reviews"]);
	const checks = await ready
		.getByRole("list", { name: "Readiness" })
		.boundingBox();
	const h = await humans.boundingBox();
	if (!checks || !h) throw new Error("no boxes");
	expect(h.y).toBeGreaterThan(checks.y + checks.height);
	const top = await page
		.getByRole("region")
		.evaluateAll((els) =>
			els
				.filter((el) => !el.parentElement?.closest("section"))
				.map((el) => el.getAttribute("aria-label")),
		);
	expect(top).toEqual(["What it does", "Who's on it", "Is it ready"]);

	// The resolved count swaps the list to resolved threads, and back.
	const toggle = humans.getByRole("button", { name: "2 resolved" });
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(humans.getByTestId("thread")).toHaveCount(2);
	await expect(humans.getByText("src/a.ts")).toBeVisible();
	await expect(humans.getByText("src/cache.ts:42")).toHaveCount(0);
	await toggle.click();
	await expect(humans.getByTestId("thread")).toHaveCount(1);
	await expect(humans.getByText("src/cache.ts:42")).toBeVisible();
});

test("section headings are centered bands", async ({ page, pr, startCrb }) => {
	await pr();
	const s = await startCrb();
	await page.goto(s.url);
	for (const name of ["What it does", "Who's on it", "Is it ready"]) {
		const heading = page.getByRole("heading", { level: 2, name });
		await expect(heading).toHaveCSS("text-align", "center");
		const band = await heading.evaluate(
			(el) => getComputedStyle(el).backgroundColor,
		);
		const card = await heading.evaluate(
			(el) => getComputedStyle(el.parentElement as Element).backgroundColor,
		);
		expect(band).not.toBe(card);
	}
});

test("threads come latest activity first, five at a time", async ({
	page,
	pr,
	startCrb,
}) => {
	const at = (day: number) =>
		`2026-01-${String(day).padStart(2, "0")}T09:00:00Z`;
	await pr({
		threads: Array.from({ length: 12 }, (_, i) =>
			reviewThread({ path: `src/f${i}.ts`, line: 1 }, [
				threadComment({ login: "rev1", text: `t${i}`, createdAt: at(1 + i) }),
				// Thread 0 had the latest reply.
				...(i === 0
					? [threadComment({ login: "rev2", text: "late", createdAt: at(28) })]
					: []),
			]),
		),
	});
	const s = await startCrb();
	await page.goto(s.url);
	const humans = page.getByRole("region", { name: "Human reviews" });
	const paths = humans.getByTestId("thread").locator("code").first();
	await expect(humans.getByTestId("thread")).toHaveCount(5);
	const shown = () =>
		humans
			.getByTestId("thread")
			.evaluateAll((els) =>
				els.map((el) => el.querySelector("code")?.textContent),
			);
	expect(await shown()).toEqual([
		"src/f0.ts:1",
		"src/f11.ts:1",
		"src/f10.ts:1",
		"src/f9.ts:1",
		"src/f8.ts:1",
	]);
	await expect(paths).toBeVisible();
	const more = humans.getByRole("button", { name: /^Load \d+ more/ });
	await expect(more).toHaveText("Load 5 more comments out of 7");
	// A prominent button: at least 40px tall, outlined, centred under the list.
	const box = await more.boundingBox();
	const list = await humans
		.getByRole("list", { name: "Unresolved threads" })
		.boundingBox();
	if (!box || !list) throw new Error("no layout");
	expect(box.height).toBeGreaterThanOrEqual(40);
	expect(box.y).toBeGreaterThanOrEqual(list.y + list.height);
	expect(
		Math.abs(box.x + box.width / 2 - (list.x + list.width / 2)),
	).toBeLessThanOrEqual(2);
	expect(box.width).toBeLessThan(list.width);
	await expect(more).not.toHaveCSS("border-top-width", "0px");
	await more.focus();
	await expect(more).not.toHaveCSS("outline-style", "none");
	await more.click();
	await expect(humans.getByTestId("thread")).toHaveCount(10);
	await expect(more).toHaveText("Load 2 more comments out of 2");
	await more.click();
	await expect(humans.getByTestId("thread")).toHaveCount(12);
	await expect(more).toHaveCount(0);
});

const CODE_HUNK = [
	"@@ -1,6 +1,9 @@ export class Cache {",
	" import { load } from './load';",
	" ",
	" export class Cache {",
	"-  private map = new Map();",
	"+  private map = new Map<string, Widget>();",
	"+  private ttl = 60_000;",
	"   get(key: string) {",
	"+    const hit = this.map.get(key);",
	"+    if (hit && Date.now() - hit.at < this.ttl) return hit.value;",
].join("\n");

test("a thread shows the code it was written on beside the comment, stacked on a phone", async ({
	page,
	pr,
	startCrb,
}) => {
	const long = Array.from(
		{ length: 14 },
		(_, i) => `<p dir="auto">Point ${i + 1}</p>`,
	).join("\n");
	await pr({
		threads: [
			reviewThread(
				{
					path: "src/cache.ts",
					line: null,
					originalLine: 8,
					originalStartLine: 7,
					isOutdated: true,
				},
				[
					threadComment({
						login: "rev1",
						text: "Points",
						html: long,
						diffHunk: CODE_HUNK,
					}),
				],
			),
			// A file comment: the path, no code.
			reviewThread({ path: "src/file.ts", line: null, originalLine: null }, [
				threadComment({
					login: "rev2",
					text: "Whole file",
					createdAt: "2026-01-01T00:00:00Z",
				}),
			]),
		],
	});
	const s = await startCrb();
	await page.goto(s.url);
	const humans = page.getByRole("region", { name: "Human reviews" });
	const [thread, fileThread] = [
		humans.getByTestId("thread").first(),
		humans.getByTestId("thread").nth(1),
	];
	// Outdated: the line where it was written.
	await expect(thread.locator("code").first()).toHaveText("src/cache.ts:8");
	const code = thread.getByRole("figure", { name: "Code at src/cache.ts" });
	const lines = code.getByTestId("thread-code-line");
	// No commit to rebuild it from: GitHub's hunk, three rows before the
	// range (it ends at the range).
	await expect(code).toHaveAttribute("data-source", "github");
	await expect(lines).toHaveCount(5);
	await expect(lines.first()).toContainText("Map<string, Widget>();");
	await expect(lines.last()).toContainText("if (hit &&");
	await expect(code.locator("[data-marked]")).toHaveCount(2);
	await expect(lines.last()).toHaveAttribute("data-marked", "true");
	// Highlighted by Shiki (tokens carry colors).
	await expect(
		lines.last().locator("span[style*=color]").first(),
	).toBeVisible();
	await expect(code).toHaveCSS("font-family", /mono/i);
	await expect(fileThread.getByTestId("thread-code")).toHaveCount(0);
	await expect(fileThread.locator("code").first()).toHaveText("src/file.ts");

	const body = thread.getByTestId("thread-body");
	const [c, b] = [await code.boundingBox(), await body.boundingBox()];
	if (!c || !b) throw new Error("no boxes");
	const phone = (page.viewportSize()?.width ?? 0) < 768;
	if (phone) {
		expect(b.y).toBeGreaterThanOrEqual(c.y + c.height);
	} else {
		expect(Math.abs(c.y - b.y)).toBeLessThan(2);
		expect(b.x).toBeGreaterThan(c.x + c.width);
	}
	// Clipped: up to seven lines fit with no vertical scrollbar; a sideways
	// one makes it focusable.
	const clipped = await code.evaluate((el) => ({
		down: el.scrollHeight > el.clientHeight,
		sideways: el.scrollWidth > el.clientWidth,
		tabIndex: el.getAttribute("tabindex"),
	}));
	expect(clipped.down).toBe(false);
	expect(clipped.tabIndex).toBe(clipped.sideways ? "0" : null);
	expect(c.height).toBeLessThanOrEqual(160);
	// Show more opens both, wrapped, without scrollbars, the range still marked.
	await thread.getByRole("button", { name: "Show more" }).click();
	await expect(lines).toHaveCount(5);
	await expect(code.locator("[data-marked]")).toHaveCount(2);
	await expect(code).not.toHaveAttribute("tabindex");
	const opened = await code.evaluate(
		(el) =>
			el.scrollHeight > el.clientHeight + 1 ||
			el.scrollWidth > el.clientWidth + 1,
	);
	expect(opened).toBe(false);
	expect((await body.boundingBox())?.height).toBeGreaterThan(b.height + 100);
});

test("checks are one row of chips; a CI chip opens the list, failing first", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr({
		overview: {
			mergeable: "CONFLICTING",
			statusCheckRollup: [
				{
					__typename: "CheckRun",
					name: "build",
					status: "COMPLETED",
					conclusion: "SUCCESS",
					detailsUrl: "https://ci.example/build",
				},
				{
					__typename: "CheckRun",
					name: "lint",
					status: "COMPLETED",
					conclusion: "FAILURE",
					detailsUrl: "javascript:alert(1)",
				},
				{
					__typename: "StatusContext",
					context: "deploy",
					state: "PENDING",
					targetUrl: "https://ci.example/deploy",
				},
			],
		},
	});
	const s = await startCrb();
	await page.goto(s.url);
	const ready = page.getByRole("region", { name: "Is it ready" });
	const row = ready.getByRole("list", { name: "Readiness" });
	await expect(row.getByRole("listitem")).toHaveText([
		"Conflicts",
		"1 failing",
		"1 pending",
		"1 passing",
	]);
	await expect(ready.getByTestId("check")).toHaveCount(0);
	const pending = row.getByRole("button", { name: "1 pending" });
	const pbox = await pending.boundingBox();
	expect(pbox?.height).toBeGreaterThanOrEqual(40);
	await pending.click();
	await expect(ready.getByTestId("check")).toHaveText([
		"lint",
		"deploy",
		"build",
	]);
	await expect(ready.getByRole("link", { name: "build" })).toHaveAttribute(
		"href",
		"https://ci.example/build",
	);
	await expect(ready.getByRole("link", { name: "lint" })).toHaveCount(0);
	await row.getByRole("button", { name: "1 failing" }).click();
	await expect(ready.getByTestId("check")).toHaveCount(0);
});

test("all-passing CI is one chip", async ({ page, pr, startCrb }) => {
	const pass = (name: string) => ({
		__typename: "CheckRun",
		name,
		status: "COMPLETED",
		conclusion: "SUCCESS",
	});
	await pr({ overview: { statusCheckRollup: [pass("a"), pass("b")] } });
	const s = await startCrb();
	await page.goto(s.url);
	const row = page
		.getByRole("region", { name: "Is it ready" })
		.getByRole("list", { name: "Readiness" });
	await expect(row.getByRole("listitem")).toHaveText([
		"No conflicts",
		"2/2 passing",
	]);
});

test("the Overview stays inside a 360px screen", async ({
	page,
	pr,
	startCrb,
}) => {
	await page.setViewportSize({ width: 360, height: 780 });
	await pr({
		overview: { isDraft: true, mergeable: "CONFLICTING" },
		threads: [
			botThreadNoReply,
			reviewThread(
				{
					path: "src/some/very/long/directory/name/that/keeps/going/file.ts",
					line: 12345,
					isOutdated: true,
				},
				[
					threadComment({
						login: "a-reviewer-with-a-long-login",
						text: "Hm",
						diffHunk: `@@ -1,1 +1,2 @@\n const a = 1;\n+${"const someVeryLongIdentifierName = callSomething(withArguments, andMore, andEvenMore);".repeat(2)}`,
					}),
				],
			),
		],
	});
	const s = await startCrb();
	await page.goto(s.url);
	await expect(page.getByRole("region", { name: "Bot reviews" })).toBeVisible();
	await expect(page.getByTestId("thread-code")).toBeVisible();
	const { scrollWidth, clientWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth,
	}));
	expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
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

test("the logo shares the title's line, both pages end with a footer, and Review files comes last", async ({
	page,
	pr,
	startCrb,
}) => {
	await pr();
	const s = await startCrb();
	await page.goto(s.url);
	const title = page.getByRole("heading", { level: 1 });
	await expect(title).toBeVisible();
	const logo = page.locator("header img").first();
	const [l, t] = await Promise.all([logo.boundingBox(), title.boundingBox()]);
	if (!l || !t) throw new Error("no boxes");
	expect(
		Math.abs(l.y + l.height / 2 - (t.y + Math.min(t.height, 32) / 2)),
	).toBeLessThan(8);
	// No wordmark text in the header.
	await expect(page.locator("header").getByText("carbonless")).toHaveCount(0);

	const footer = page.getByTestId("app-footer");
	await expect(footer).toContainText("Diff by");
	await expect(footer).toContainText("carbonless");
	await expect(footer.locator("img")).toHaveCount(1);

	const review = page.getByRole("link", { name: /Review files/ });
	const last = await page
		.getByRole("region", { name: "Bot reviews" })
		.boundingBox();
	const r = await review.boundingBox();
	const f = await footer.boundingBox();
	if (!last || !r || !f) throw new Error("no boxes");
	expect(r.y).toBeGreaterThanOrEqual(last.y + last.height);
	// Centered under the sections.
	expect(Math.abs(r.x + r.width / 2 - (last.x + last.width / 2))).toBeLessThan(
		2,
	);
	expect(f.y).toBeGreaterThanOrEqual(r.y + r.height);

	await page.getByRole("link", { name: "Files changed" }).click();
	await expect(page).toHaveURL(/\/files$/);
	const footer2 = page.getByTestId("app-footer");
	await expect(footer2).toContainText("Diff by");
	await expect(footer2).toContainText("carbonless");
	await expect(footer2.locator("img")).toHaveCount(1);
});

test("an opened long range scrolls inside its pane to the marked lines, never the window", async ({
	page,
	pr,
	startCrb,
}) => {
	const hunk = [
		"@@ -0,0 +1,60 @@",
		...Array.from({ length: 60 }, (_, i) => `+export const v${i + 1} = ${i};`),
	].join("\n");
	await pr({
		threads: [
			reviewThread({ path: "src/long.ts", line: 60, originalStartLine: 1 }, [
				threadComment({ login: "rev1", text: "Here", diffHunk: hunk }),
			]),
		],
	});
	const s = await startCrb();
	await page.goto(s.url);
	const thread = page
		.getByRole("region", { name: "Human reviews" })
		.getByTestId("thread");
	const more = thread.getByRole("button", { name: "Show more" });
	await more.scrollIntoViewIfNeeded();
	const before = await page.evaluate(() => window.scrollY);
	await more.click();
	const code = thread.getByTestId("thread-code");
	await expect(code.getByTestId("thread-code-line")).toHaveCount(60);
	const marked = code.locator("[data-marked]");
	await expect(marked).toHaveCount(60);
	// Too long to fit: the range's start at the top.
	const first = marked.first();
	await expect(first).toHaveText(/v1 /);
	const [pane, row] = [await code.boundingBox(), await first.boundingBox()];
	if (!pane || !row) throw new Error("no boxes");
	expect(row.y).toBeGreaterThanOrEqual(pane.y);
	expect(row.y + row.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
	expect(pane.height).toBeLessThan(600);
	await expect(code).toHaveAttribute("tabindex", "0");
	expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test("a line comment GitHub kept no hunk for shows its code from the clone; a file comment shows none", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr();
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((s) => {
		const graph = s.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: "a.txt", line: 2, subjectType: "LINE" }, [
				threadComment({
					login: "rev1",
					text: "Here",
					diffHunk: "",
					commit: head,
				}),
			]),
			reviewThread({ path: "new.txt", line: 1, subjectType: "FILE" }, [
				threadComment({
					login: "rev2",
					text: "Whole file",
					diffHunk: "",
					commit: head,
					createdAt: "2026-01-01T00:00:00Z",
				}),
			]),
		];
	});
	const s = await startCrb();
	await page.goto(s.url);
	const threads = page
		.getByRole("region", { name: "Human reviews" })
		.getByTestId("thread");
	const code = threads.first().getByTestId("thread-code");
	await expect(code.locator("[data-marked]")).toHaveText(/line 2 changed/);
	await expect(code.getByTestId("thread-code-line").first()).toContainText(
		"line 1",
	);
	await expect(threads.nth(1).getByTestId("thread-code")).toHaveCount(0);
});

test("a thread's code comes from the clone, three rows before and after its line; GitHub's hunk only when the clone can't", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	const b = (i: number) => `b ${i + 1}`;
	const p = await pr({
		base: {
			"b.txt": `${Array.from({ length: 80 }, (_, i) => b(i)).join("\n")}\n`,
		},
		files: [
			{
				message: "PR change",
				files: {
					"b.txt": `${Array.from({ length: 80 }, (_, i) => (i === 59 ? "b 60 changed" : b(i))).join("\n")}\n`,
				},
			},
		],
	});
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((s) => {
		const graph = s.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: "b.txt", line: 60 }, [
				threadComment({
					login: "rev1",
					text: "Here",
					// GitHub's hunk ends at the line; the clone's code goes on.
					diffHunk: "@@ -59,2 +59,2 @@\n b 59\n-b 60\n+b 60 changed",
					commit: head,
					// After the fixture's commits, so the base then is the base now.
					createdAt: "2099-01-01T00:00:00Z",
				}),
			]),
			// Written on a commit the clone can't get: GitHub's hunk.
			reviewThread({ path: "b.txt", line: 10, isOutdated: true }, [
				threadComment({
					login: "rev2",
					text: "Earlier",
					diffHunk: "@@ -8,3 +8,3 @@\n b 8\n b 9\n-b 10\n+b ten",
					commit: "e".repeat(40),
					createdAt: "2026-01-01T00:00:00Z",
				}),
			]),
		];
	});
	const s = await startCrb();
	await page.goto(s.url);
	const threads = page
		.getByRole("region", { name: "Human reviews" })
		.getByTestId("thread");
	const code = threads.first().getByTestId("thread-code");
	await expect(code).toHaveAttribute("data-source", "clone");
	const rows = code.getByTestId("thread-code-line");
	await expect(rows).toHaveText([
		/b 58/,
		/b 59/,
		/b 60$/,
		/b 60 changed/,
		/b 61/,
		/b 62/,
		/b 63/,
	]);
	await expect(code.locator("[data-marked]")).toHaveText(/b 60 changed/);
	await expect(threads.first().getByTestId("thread-place")).toHaveText(
		"b.txt:60",
	);
	// Seven rows fit clipped, no scrolling.
	expect(await code.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
		false,
	);
	const github = threads.nth(1).getByTestId("thread-code");
	await expect(github).toHaveAttribute("data-source", "github");
	await expect(github.locator("[data-marked]")).toHaveText(/b ten/);
	expect(
		await page.evaluate(
			() =>
				document.documentElement.scrollWidth -
				document.documentElement.clientWidth,
		),
	).toBe(0);
});

test("a thread's file:line opens Files changed at that line, highlighted; a moved line says so", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	const p = await pr({
		base: {
			"b.txt": `${Array.from({ length: 80 }, (_, i) => `b ${i + 1}`).join("\n")}\n`,
		},
		files: [
			{
				message: "PR change",
				files: {
					"b.txt": `${Array.from({ length: 80 }, (_, i) => (i === 59 ? "b 60 changed" : `b ${i + 1}`)).join("\n")}\n`,
				},
			},
		],
	});
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((s) => {
		const graph = s.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: "b.txt", line: 60 }, [
				threadComment({
					login: "rev1",
					text: "Here",
					diffHunk: "",
					commit: head,
				}),
			]),
			// Written on another commit and outdated: its number may not hold.
			reviewThread(
				{ path: "b.txt", line: null, originalLine: 10, isOutdated: true },
				[
					threadComment({
						login: "rev2",
						text: "Earlier",
						diffHunk: "@@ -8,3 +8,3 @@\n b 8\n b 9\n-b 10\n+b ten",
						commit: "e".repeat(40),
						createdAt: "2026-01-01T00:00:00Z",
					}),
				],
			),
		];
	});
	const s = await startCrb();
	await page.goto(s.url);
	const threads = page
		.getByRole("region", { name: "Human reviews" })
		.getByTestId("thread");
	const place = threads.first().getByRole("link", { name: "b.txt:60" });
	expect((await place.boundingBox())?.height).toBeGreaterThanOrEqual(40);
	await place.click();
	await expect(page).toHaveURL(/\/files$/);
	const section = page.getByRole("region", { name: "b.txt" });
	await expect(
		section.getByRole("button", { name: "Collapse file" }),
	).toBeVisible();
	const row = section.locator('tr[data-new-no="60"]');
	await expect(row).toHaveAttribute("data-landed");
	await expect(row).toBeInViewport();
	await expect(section.getByTestId("landing-hint")).toHaveCount(0);
	// The highlight fades after a moment.
	await expect(row).not.toHaveAttribute("data-landed", { timeout: 5000 });

	await page.getByRole("link", { name: "Overview" }).click();
	await threads.nth(1).getByRole("link", { name: "b.txt:10" }).click();
	await expect(section.getByTestId("landing-hint")).toHaveText(
		"Line 10 is from another commit",
	);
	await expect(section.locator("tr[data-landed]")).toHaveCount(0);
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});

test("a thread card: status, author and times on a tinted header, then file:line, code and comment", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr({
		threads: [
			reviewThread(
				{
					path: "src/cache.ts",
					line: null,
					originalLine: 8,
					originalStartLine: 7,
				},
				[
					threadComment({
						login: "Gilthans",
						text: "Points",
						diffHunk: CODE_HUNK,
						createdAt: "2026-01-02T09:00:00Z",
					}),
					threadComment({
						login: "octo-author",
						text: "Done",
						createdAt: "2026-01-03T09:00:00Z",
					}),
				],
			),
		],
	});
	const s = await startCrb();
	await page.goto(s.url);
	const humans = page.getByRole("region", { name: "Human reviews" });
	const band = humans.getByTestId("thread-group-band");
	await expect(band).toContainText("Human reviews");
	await expect(band).toContainText("1 unresolved");
	const thread = humans.getByTestId("thread");
	const head = thread.getByTestId("thread-head");
	await expect(head).toContainText(
		/^Unresolved thread by Gilthans\s*opened\s.+ago\s*updated\s.+ago2$/,
	);
	await expect(head.locator("time")).toHaveCount(2);
	// Every part after the first has a "·" before it, except one that starts
	// a line (its dot is clipped): no line starts with a separator.
	const dots = await head.locator("p > span").evaluateAll((parts) => {
		const box = parts[0]?.parentElement?.parentElement;
		if (!box) throw new Error("no header line");
		const clip = box.getBoundingClientRect().left;
		return parts.map((part) => {
			const left = part.getBoundingClientRect().left;
			const shown = left + 12 > clip + 3;
			const starts = Math.abs(left + 12 - clip) < 4 || left + 12 < clip + 3;
			return { shown, starts };
		});
	});
	expect(dots[0]?.shown).toBe(false);
	for (const d of dots) expect(d.shown).toBe(!d.starts);
	const bg = (l: typeof head) =>
		l.evaluate((el) => getComputedStyle(el).backgroundColor);
	const [cardBg, headBg, bodyBg, codeBg] = await Promise.all([
		bg(thread),
		bg(head),
		bg(thread.getByTestId("thread-body")),
		bg(thread.getByTestId("thread-code")),
	]);
	expect(new Set([cardBg, headBg, bodyBg, codeBg]).size).toBe(4);
	// The commented range is tinted across the whole row.
	const marked = thread.getByTestId("thread-code").locator("[data-marked]");
	await expect(marked).toHaveCount(2);
	expect(
		await marked
			.first()
			.locator("td")
			.last()
			.evaluate((el) => getComputedStyle(el).boxShadow),
	).toMatch(/inset/);
	const boxes = await Promise.all(
		[
			head,
			thread.getByTestId("thread-place"),
			thread.getByTestId("thread-code"),
		].map((l) => l.boundingBox()),
	);
	const [h, p, c] = boxes.map((b) => b?.y ?? 0);
	expect(h).toBeLessThan(p ?? 0);
	expect(p).toBeLessThan(c ?? 0);
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await thread.scrollIntoViewIfNeeded();
		await page.screenshot({
			path: `${shots}/thread-card-${isMobile ? "phone" : "desktop"}.png`,
		});
	}
});

test("suggested changes show as mini diffs of the commented lines, highlighted like the code", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	const removed = [
		"    const hit = this.map.get(key);",
		"    if (hit && Date.now() - hit.at < this.ttl) return hit.value;",
	];
	const added = [
		"    const hit = this.map.get(key);\t// cached",
		"    if (hit && !expired(hit)) return hit.value;",
	];
	await pr({
		threads: [
			reviewThread(
				{
					path: "src/cache.ts",
					line: null,
					originalLine: 8,
					originalStartLine: 7,
					isOutdated: true,
				},
				[
					threadComment({
						login: "rev1",
						text: "Simpler: Suggested change ... or drop them",
						html: [
							'<p dir="auto">Simpler:</p>',
							suggestionHtml(removed, added),
							'<p dir="auto">or drop them:</p>',
							suggestionHtml(removed, []),
						].join("\n"),
						body: `Simpler:\r\n\`\`\`suggestion\r\n${added.join("\r\n")}\r\n\`\`\`\r\nor drop them:\r\n\`\`\`suggestion\r\n\`\`\``,
						diffHunk: CODE_HUNK,
					}),
				],
			),
		],
	});
	const s = await startCrb();
	await page.goto(s.url);
	const thread = page
		.getByRole("region", { name: "Human reviews" })
		.getByTestId("thread");
	await thread.getByRole("button", { name: "Show more" }).click();
	const blocks = thread.getByRole("figure", { name: "Suggested change" });
	await expect(blocks).toHaveCount(2);
	const first = blocks.first().getByTestId("suggestion-line");
	await expect(first).toHaveCount(4);
	await expect(first.nth(0)).toContainText("7");
	await expect(first.nth(0)).toContainText("const hit = this.map.get(key);");
	await expect(first.nth(3)).toContainText("!expired(hit)");
	// Opened, the comment's suggestions wrap like the code pane.
	await expect(first.nth(3).locator("td").last()).toHaveCSS(
		"white-space",
		"pre-wrap",
	);
	// Same rendering as the code pane: highlighted, invisibles shown.
	await expect(
		first.nth(3).locator("span[style*=color]").first(),
	).toBeVisible();
	await expect(first.nth(2).locator('[data-inv="tab"]')).toHaveCount(1);
	await expect(blocks.nth(1).getByTestId("suggestion-line")).toHaveCount(2);
	await expect(thread.getByTestId("thread-body")).toContainText(
		"or drop them:",
	);
	await expect(thread.getByRole("button", { name: /apply/i })).toHaveCount(0);
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await blocks.first().scrollIntoViewIfNeeded();
		await page.screenshot({
			path: `${shots}/suggestion-${isMobile ? "phone" : "desktop"}.png`,
		});
	}
});
