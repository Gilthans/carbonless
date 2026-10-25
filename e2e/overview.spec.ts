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
	const more = humans.getByRole("button", { name: "Load more" });
	expect((await more.boundingBox())?.height).toBeGreaterThanOrEqual(40);
	await more.click();
	await expect(humans.getByTestId("thread")).toHaveCount(10);
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
	await expect(lines).toHaveCount(6);
	await expect(lines.first()).toContainText("private map = new Map();");
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
	// Clipped, the code scrolls; Show more opens both, without scrollbars.
	expect(c.height).toBeLessThanOrEqual(130);
	await thread.getByRole("button", { name: "Show more" }).click();
	const opened = await code.evaluate((el) => ({
		over:
			el.scrollHeight > el.clientHeight + 1 ||
			el.scrollWidth > el.clientWidth + 1,
		overflow: getComputedStyle(el).overflow,
	}));
	expect(opened).toEqual({ over: false, overflow: "visible" });
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
