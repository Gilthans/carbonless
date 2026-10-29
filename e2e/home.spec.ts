import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { bumpHomePr, homePr } from "../test/fake-gh/scenario";
import { fileAction, fileSection, openFiles } from "./files-ui";
import { expect, OWNER_REPO, PR_NUMBER, type Pr, test } from "./fixtures";

/**
 * Home in the built `crb serve`, on a fake gh scenario: acme/api in the
 * view with a PR for each section, and the review PR (acme/widget#7, a
 * real repo) outside the view, which the viewer starts.
 */

const VIEWER = "Octo";
const now = Date.now();
const iso = (minutesAgo: number) =>
	new Date(now - minutesAgo * 60_000).toISOString();

/** The fixture PR (widget#7) and acme/api's PRs, one per section. */
async function setup(
	workdir: string,
	pr: (opts?: object) => Promise<Pr>,
): Promise<Pr> {
	const made = await pr({
		scenario: {
			user: { login: VIEWER, avatarUrl: `https://avatars.example/${VIEWER}` },
			search: { repos: [{ fullName: OWNER_REPO }, { fullName: "acme/api" }] },
		},
	});
	made.editScenario((s) => {
		s.repos = {
			"acme/api": {
				prs: [
					homePr({
						repo: "acme/api",
						number: 1,
						title: "Snooze PRs from the inbox",
						author: VIEWER,
						checks: "SUCCESS",
						updatedAt: iso(5),
					}),
					homePr({
						repo: "acme/api",
						number: 2,
						title: "Rate-limit gh polling per repo",
						author: "alice",
						requested: [VIEWER],
						checks: "FAILURE",
						threads: { unresolved: 2 },
						updatedAt: iso(10),
					}),
					homePr({
						repo: "acme/api",
						number: 3,
						title: "Snapshot reviews of a working tree",
						author: "alice",
						updatedAt: iso(15),
					}),
					homePr({
						repo: "acme/api",
						number: 4,
						title: "Migrate alerts table",
						author: "alice",
						requested: ["bob"],
						updatedAt: iso(20),
					}),
					homePr({
						repo: "acme/api",
						number: 5,
						title: "Ignore whitespace setting",
						author: "alice",
						state: "MERGED",
						closedAt: iso(60),
					}),
					homePr({
						repo: "acme/api",
						number: 6,
						title: "Dropped idea",
						author: "alice",
						state: "CLOSED",
						closedAt: iso(90),
					}),
				],
			},
			// The started review's PR: every sign a row can carry.
			[OWNER_REPO]: {
				prs: [
					homePr({
						repo: OWNER_REPO,
						number: PR_NUMBER,
						title: "Add widget cache with a rather long title",
						author: "alice",
						requested: [VIEWER, "bob", "carol"],
						checks: "PENDING",
						decision: "CHANGES_REQUESTED",
						threads: { unresolved: 123 },
						// A head past the review's: "New commits since your review".
						head: "f".repeat(40),
						// The longest age text: "10 months ago".
						updatedAt: iso(60 * 24 * 300),
					}),
				],
			},
		};
	});
	const config = join(workdir, "config", "carbonless");
	mkdirSync(config, { recursive: true });
	writeFileSync(
		join(config, "config.json"),
		JSON.stringify({ views: [{ name: "My PRs", repos: ["acme/api"] }] }),
	);
	return made;
}

// The fake avatars' host doesn't resolve: serve each a plain disc.
test.beforeEach(async ({ page }) => {
	await page.route("https://avatars.example/**", (route) =>
		route.fulfill({
			contentType: "image/svg+xml",
			body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><circle cx="1" cy="1" r="1" fill="#5f6a8a"/></svg>',
		}),
	);
});

const home = (url: string) => new URL("/", url).href;
const section = (page: Page, name: string) =>
	page.getByRole("region", { name: new RegExp(`^${name}`) });
const rowOf = (scope: Page | Locator, title: string) =>
	scope.getByTestId(/^home-row/).filter({ hasText: title });

/** Starts the widget review (one file reviewed) and goes Home. */
async function startReview(
	page: Page,
	startCrb: (arg?: string) => Promise<{ url: string }>,
) {
	const crb = await startCrb();
	await openFiles(page, crb.url, "Lines");
	await fileAction(fileSection(page, "new.txt"), "Mark remaining reviewed");
	await expect(
		fileSection(page, "new.txt").getByRole("progressbar", {
			name: "File progress",
		}),
	).toHaveAttribute("aria-valuenow", "100");
	return crb;
}

/** Opens a row action: hover buttons on desktop, the ⋯ sheet on touch. */
async function rowAction(page: Page, row: Locator, name: string) {
	const more = row.getByRole("button", { name: /^Actions for #/ });
	if (await more.isVisible()) {
		await more.click();
		await page.getByRole("dialog").getByRole("button", { name }).click();
		return page.getByRole("dialog");
	}
	await row.hover();
	await row.getByRole("button", { name, exact: true }).click();
	return page.getByRole("dialog", { name });
}

async function goHome(page: Page, url: string) {
	await page.goto(home(url));
	await expect(section(page, "Mine")).toBeVisible();
	await expect(page.getByText("Snooze PRs from the inbox")).toBeVisible();
}

test("shows the sections from GitHub, and a started review outside the view with its coverage", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	await setup(workdir, pr);
	const crb = await startReview(page, startCrb);
	await goHome(page, crb.url);
	const titles = async (name: string) =>
		section(page, name)
			.getByTestId("home-row")
			.getByRole("link")
			.allTextContents();
	expect(await titles("Mine")).toEqual([
		expect.stringContaining("Snooze PRs from the inbox"),
	]);
	await expect(
		section(page, "Reviewing").getByRole("link", { name: /Add widget cache/ }),
	).toBeVisible();
	expect(await titles("Reviewing")).toHaveLength(2);
	expect(await titles("Up for grabs")).toEqual([
		expect.stringContaining("Snapshot reviews"),
	]);
	expect(await titles("Other open")).toEqual([
		expect.stringContaining("Migrate alerts"),
	]);
	const closed = section(page, "Recently closed");
	await expect(closed.getByRole("img", { name: "Merged" })).toBeVisible();
	await expect(closed.getByRole("img", { name: "Closed" })).toBeVisible();
	await expect(
		closed.getByRole("link", { name: /Ignore whitespace/ }),
	).toHaveAttribute("href", "https://github.com/acme/api/pull/5");
	// The started review: its coverage beside the age, and a link to it.
	const widget = rowOf(section(page, "Reviewing"), "Add widget cache");
	await expect(
		widget.getByRole("img", { name: /^1 of \d+ lines? reviewed$/ }),
	).toBeVisible();
	await expect(widget.locator("time")).toBeVisible();
	await expect(widget.getByRole("link")).toHaveAttribute(
		"href",
		new URL(crb.url).pathname,
	);
});

test("opens a PR by URL, by owner/repo#n and by repo then title words", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	await setup(workdir, pr);
	const crb = await startCrb();
	const box = page.getByRole("combobox", { name: "Open a pull request" });
	const reviewPath = new URL(crb.url).pathname;

	await goHome(page, crb.url);
	await box.fill(`https://github.com/${OWNER_REPO}/pull/${PR_NUMBER}`);
	await box.press("Enter");
	await expect(page).toHaveURL(new RegExp(`${reviewPath}$`));

	await goHome(page, crb.url);
	await box.fill(`${OWNER_REPO}#${PR_NUMBER}`);
	await box.press("Enter");
	await expect(page).toHaveURL(new RegExp(`${reviewPath}$`));

	await goHome(page, crb.url);
	await box.click();
	await box.pressSequentially("acme/wid");
	await expect(
		page.getByRole("group", { name: "Repos" }).getByRole("option").first(),
	).toContainText(OWNER_REPO);
	await box.press("Tab");
	await expect(box).toHaveValue(`${OWNER_REPO} `);
	await box.pressSequentially("cache widget");
	await expect(
		page.getByRole("option", { name: /Add widget cache/ }),
	).toBeVisible();
	await box.press("Enter");
	await expect(page).toHaveURL(new RegExp(`${reviewPath}$`));
});

test("a snooze moves the row behind its footer, Wake up brings it back, and activity wakes it", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	const made = await setup(workdir, pr);
	const crb = await startCrb();
	await goHome(page, crb.url);
	const grabs = section(page, "Up for grabs");
	const title = "Snapshot reviews of a working tree";
	let dialog = await rowAction(page, rowOf(grabs, title), "Snooze");
	await dialog.getByRole("button", { name: /Tomorrow/ }).click();
	const foot = grabs.getByRole("button", { name: "1 snoozed" });
	await expect(foot).toBeVisible();
	await expect(grabs.getByTestId("home-row")).toHaveCount(0);
	await foot.click();
	await expect(foot).toHaveAttribute("aria-expanded", "true");
	const hidden = grabs.getByTestId("home-row-hidden");
	await expect(
		hidden.getByRole("img", { name: /^Snoozed until .*activity$/ }),
	).toBeVisible();
	await hidden.getByRole("button", { name: "Wake up" }).click();
	await expect(grabs.getByTestId("home-row")).toHaveCount(1);
	await expect(foot).toBeHidden();

	// Snoozed again (waking on activity, the default), then the PR moves.
	dialog = await rowAction(page, rowOf(grabs, title), "Snooze");
	await dialog.getByRole("button", { name: /Next Monday/ }).click();
	await expect(foot).toBeVisible();
	bumpHomePr(
		made.scenarioPath,
		"acme/api",
		3,
		new Date().toISOString(),
		"alice",
	);
	await page.getByRole("button", { name: "Refresh" }).click();
	await expect(grabs.getByTestId("home-row")).toHaveCount(1);
	await expect(
		grabs.getByRole("img", { name: "Woke: activity" }),
	).toBeVisible();
});

test("waiting on someone hides the row until they act; a note shows on the row", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	const made = await setup(workdir, pr);
	const crb = await startCrb();
	await goHome(page, crb.url);
	const other = section(page, "Other open");
	const title = "Migrate alerts table";

	let dialog = await rowAction(page, rowOf(other, title), "Note");
	await dialog.getByRole("textbox").fill("awaiting Tomer's decision");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(
		rowOf(other, title).getByRole("img", {
			name: "Note: awaiting Tomer's decision",
		}),
	).toBeVisible();

	dialog = await rowAction(page, rowOf(other, title), "Waiting on");
	await dialog.getByRole("button", { name: /bob/ }).click();
	await expect(other.getByRole("button", { name: "1 waiting" })).toBeVisible();
	await expect(other.getByTestId("home-row")).toHaveCount(0);

	// Someone else's activity doesn't end it; bob's does.
	bumpHomePr(
		made.scenarioPath,
		"acme/api",
		4,
		new Date().toISOString(),
		"alice",
	);
	await page.getByRole("button", { name: "Refresh" }).click();
	await expect(other.getByRole("button", { name: "1 waiting" })).toBeVisible();
	bumpHomePr(
		made.scenarioPath,
		"acme/api",
		4,
		new Date(Date.now() + 1000).toISOString(),
		"bob",
	);
	await page.getByRole("button", { name: "Refresh" }).click();
	await expect(other.getByTestId("home-row")).toHaveCount(1);
	await expect(other.getByRole("button", { name: /waiting/ })).toBeHidden();
});

test("a failed refresh shows the warning and keeps the rows", async ({
	page,
	workdir,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	const made = await setup(workdir, pr);
	const crb = await startCrb();
	await goHome(page, crb.url);
	made.editScenario((s) => {
		s.rateLimited = true;
	});
	expectConsoleError(/Failed to load resource/);
	await page.getByRole("button", { name: "Refresh" }).click();
	const status = page.getByTestId("refresh-status");
	await expect(
		status.getByRole("img", { name: /^Refresh failed: / }),
	).toBeVisible();
	await expect(status).toHaveClass(/text-warn/);
	await expect(page.getByText("Snooze PRs from the inbox")).toBeVisible();
	await expect(page.getByText("Rate-limit gh polling per repo")).toBeVisible();
});

test("an open popover is on top of the rows after it", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "popovers are desktop's; touch uses the sheet");
	await setup(workdir, pr);
	const crb = await startReview(page, startCrb);
	await goHome(page, crb.url);
	// The first row of Reviewing has another row and more sections below it.
	const first = section(page, "Reviewing").getByTestId("home-row").first();
	const dialog = await rowAction(page, first, "Snooze");
	// Every control of it, across its whole area, is itself: nothing of the
	// rows below (their signs, ages, actions) paints over it or takes a click.
	const controls = await dialog.getByRole("button").all();
	controls.push(dialog.getByRole("switch"));
	expect(controls.length).toBeGreaterThanOrEqual(5);
	for (const control of controls) {
		const box = await control.boundingBox();
		if (!box) throw new Error("no box");
		const missed = await control.evaluate((el, b) => {
			const out: string[] = [];
			for (let i = 1; i < 10; i++) {
				for (const fy of [0.25, 0.5, 0.75]) {
					const x = b.x + (b.width * i) / 10;
					const y = b.y + b.height * fy;
					const hit = document.elementFromPoint(x, y);
					if (!el.contains(hit)) out.push(`${x},${y}: ${hit?.className}`);
				}
			}
			return out;
		}, box);
		expect(missed, (await control.textContent()) ?? "").toEqual([]);
	}
	await dialog.getByRole("button", { name: /In 3 days/ }).click();
	await expect(
		section(page, "Reviewing").getByRole("button", { name: "1 snoozed" }),
	).toBeVisible();
});

test("at 360px: no sideways scroll with the busiest rows, and 40px targets", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	await page.setViewportSize({ width: 360, height: 800 });
	await setup(workdir, pr);
	const crb = await startReview(page, startCrb);
	await goHome(page, crb.url);
	const reviewing = section(page, "Reviewing");
	const busy = rowOf(reviewing, "Add widget cache");
	await expect(
		busy.getByRole("img", { name: /lines? reviewed$/ }),
	).toBeVisible();
	// A hidden row with its badge and Wake up, revealed.
	const dialog = await rowAction(
		page,
		rowOf(reviewing, "Rate-limit gh polling"),
		"Snooze",
	);
	await dialog.getByRole("button", { name: /Next Monday/ }).click();
	await reviewing.getByRole("button", { name: "1 snoozed" }).click();
	await expect(
		reviewing
			.getByTestId("home-row-hidden")
			.getByRole("button", { name: "Wake up" }),
	).toBeVisible();
	const widths = await page.evaluate(() => ({
		scroll: document.documentElement.scrollWidth,
		client: document.documentElement.clientWidth,
	}));
	expect(widths.scroll).toBeLessThanOrEqual(widths.client);
	// Every row's second line keeps its parts inside it: with justify-end,
	// a line that can't wrap spills out to the left, unseen by scrollWidth.
	const spills = await page.evaluate(() =>
		[...document.querySelectorAll("[data-testid=row-meta]")].flatMap((meta) => {
			const box = meta.getBoundingClientRect();
			return [...meta.children]
				.map((child) => child.getBoundingClientRect())
				.filter(
					(r) =>
						// A closed sheet (<dialog>) or empty slot has no box.
						r.width + r.height > 0 &&
						(r.left < box.left - 0.5 || r.right > box.right + 0.5),
				)
				.map(
					(r) =>
						`${meta.closest("li")?.textContent?.slice(0, 30)}: ${r.left}–${r.right} outside ${box.left}–${box.right}`,
				);
		}),
	);
	expect(spills).toEqual([]);
	for (const row of await page.getByTestId(/^home-row/).all()) {
		const box = await row.boundingBox();
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
	}
	if (isMobile) {
		const targets = [
			reviewing.getByRole("button", { name: "1 snoozed" }),
			busy.getByRole("button", { name: /^Actions for #/ }),
			reviewing
				.getByTestId("home-row-hidden")
				.getByRole("button", { name: "Wake up" }),
			page.getByRole("button", { name: "Refresh" }),
			page.getByRole("button", { name: "Edit repos" }),
		];
		for (const target of targets) {
			const box = await target.boundingBox();
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
		}
	}
	const shots = process.env.CRB_HOME_SHOTS;
	if (shots) {
		// A viewport as tall as the page: a full-page capture of an emulated
		// phone redraws it in another layout.
		const height = await page.evaluate(() => document.body.scrollHeight);
		await page.setViewportSize({ width: 360, height });
		await page.screenshot({
			path: join(shots, `home-360${isMobile ? "-phone" : ""}.png`),
		});
	}
});

test("screenshot at desktop width (CRB_HOME_SHOTS only)", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	const shots = process.env.CRB_HOME_SHOTS;
	test.skip(!shots || isMobile, "screenshots on request, desktop only");
	await page.setViewportSize({ width: 1280, height: 900 });
	await setup(workdir, pr);
	const crb = await startReview(page, startCrb);
	await goHome(page, crb.url);
	const other = section(page, "Other open");
	const dialog = await rowAction(page, rowOf(other, "Migrate alerts"), "Note");
	await dialog.getByRole("textbox").fill("awaiting Tomer's decision");
	await dialog.getByRole("button", { name: "Save" }).click();
	await page.mouse.move(0, 0);
	await page.screenshot({
		path: join(shots as string, "home-desktop.png"),
		fullPage: true,
	});
	await rowAction(
		page,
		rowOf(section(page, "Up for grabs"), "Snapshot reviews"),
		"Snooze",
	);
	await page.screenshot({
		path: join(shots as string, "home-desktop-snooze.png"),
	});
	await page.keyboard.press("Escape");
	await page
		.getByRole("combobox", { name: "Open a pull request" })
		.pressSequentially("acme");
	await expect(page.getByRole("listbox")).toBeVisible();
	await page.screenshot({
		path: join(shots as string, "home-desktop-search.png"),
	});
});
