import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { bumpHomePr, homePr, release } from "../test/fake-gh/scenario";
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
			viewerRepos: [
				{ name: OWNER_REPO, relation: "COLLABORATOR" },
				{ name: "acme/api", relation: "ORGANIZATION_MEMBER" },
				// A public repo the viewer has no relation to: never listed.
				{ name: "acme/widgetry", relation: "NONE" },
			],
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
						// Long, with a word longer than a phone is wide.
						title:
							"Add widget cache with a rather long title: WidgetCacheInvalidationAcrossEveryRegionAndTenant",
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

/**
 * Every row's title is whole: not cut (no ellipsis, nothing past its box)
 * and inside its row. Returns what isn't.
 */
function cutTitles(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll("[data-testid^=home-row] a")].flatMap((a) => {
			const link = a as HTMLElement;
			const row = link.closest("li")?.getBoundingClientRect();
			const box = link.getBoundingClientRect();
			const style = getComputedStyle(link);
			const cut =
				style.textOverflow === "ellipsis" ||
				style.whiteSpace === "nowrap" ||
				link.scrollWidth > link.clientWidth + 1 ||
				!row ||
				box.right > row.right + 0.5;
			return cut ? [link.textContent ?? ""] : [];
		}),
	);
}

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

test("a PR chosen in the open box shows at once, loading, then becomes its review", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	const made = await setup(workdir, pr);
	const second = "Second widget change";
	// A second PR of the fixture repo, in the view: Home knows its title.
	execFileSync("git", [
		"-C",
		made.repo.path,
		"update-ref",
		"refs/pull/8/head",
		made.repo.shas.at(-1) ?? "",
	]);
	made.editScenario((s) => {
		const first = s.prs[String(PR_NUMBER)];
		if (!first) throw new Error("no fixture PR");
		s.prs["8"] = {
			...first,
			view: { ...first.view, number: 8, title: second },
		};
		s.repos?.[OWNER_REPO]?.prs.push(
			homePr({
				repo: OWNER_REPO,
				number: 8,
				title: second,
				author: "alice",
				updatedAt: iso(30),
			}),
		);
	});
	writeFileSync(
		join(workdir, "config", "carbonless", "config.json"),
		JSON.stringify({
			views: [{ name: "My PRs", repos: ["acme/api", OWNER_REPO] }],
		}),
	);
	const crb = await startCrb();
	await goHome(page, crb.url);
	await expect(page.getByText(second)).toBeVisible();
	// GitHub's answer for the PR is held: the review can't open yet.
	made.editScenario((s) => {
		s.hold = ["prView"];
	});
	const box = page.getByRole("combobox", { name: "Open a pull request" });
	await box.click();
	await box.pressSequentially(`${OWNER_REPO} second`);
	await page.getByRole("option", { name: new RegExp(second) }).click();
	const opening = page.getByTestId("opening");
	await expect(opening).toContainText(second);
	await expect(opening).toContainText("#8");
	await expect(page.getByRole("status")).toContainText("Opening");
	await expect(page).toHaveURL(new RegExp(`/pr/${OWNER_REPO}/8$`));
	// The same address in another tab while the first open is held: two
	// opens of the PR at once.
	const prUrl = page.url();
	const other = await page.context().newPage();
	await other.goto(prUrl);
	await expect(other.getByRole("status")).toContainText("Opening");
	release(made.scenarioPath, "prView");
	await expect(page).toHaveURL(/\/r\/[0-9a-z]{26}$/);
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(second);
	const review = page.url();
	// One review: the other tab lands on the same one.
	await expect(other).toHaveURL(review);
	await other.close();
	// Back is Home, not the loading page.
	await page.goBack();
	await expect(section(page, "Mine")).toBeVisible();
	// The address opened again, after: the same review.
	await page.goto(prUrl);
	await expect(page).toHaveURL(review);
});

test("Repos spins while the viewer's repos load, then lists only theirs", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	const made = await setup(workdir, pr);
	const hold = join(workdir, "let-repos-through");
	made.editScenario((s) => {
		s.viewerReposHold = hold;
	});
	const crb = await startCrb();
	const box = page.getByRole("combobox", { name: "Open a pull request" });
	await goHome(page, crb.url);
	await box.click();
	await box.pressSequentially("acme");
	const repos = page.getByRole("group", { name: "Repos" });
	// The view's repo shows under the spinner while the list loads.
	await expect(repos).toHaveAttribute("aria-busy", "true");
	await expect(repos.locator(".animate-spin")).toBeVisible();
	await expect(repos.getByRole("option").first()).toContainText("acme/api");
	await expect(page.getByRole("status")).toHaveText("Loading your repos");
	writeFileSync(hold, "");
	await expect(repos).toHaveAttribute("aria-busy", "false", {
		timeout: 15_000,
	});
	await expect(repos.getByRole("option")).toHaveText([
		/acme\/api/,
		new RegExp(OWNER_REPO),
	]);
	await expect(page.getByRole("status")).toHaveText("");
});

test("the view's repo input suggests the viewer's repos as you type; Save spins while it saves", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	await setup(workdir, pr);
	const crb = await startCrb();
	await goHome(page, crb.url);
	await page.getByRole("button", { name: "Edit repos" }).click();
	const dialog = page.getByRole("dialog", { name: "My PRs" });
	const field = dialog.getByRole("combobox", { name: "Add a repo" });
	await field.pressSequentially("wid");
	const repos = dialog.getByRole("group", { name: "Repos" });
	// Only the viewer's repos: never acme/widgetry, public but not theirs.
	await expect(repos.getByRole("option")).toHaveText([OWNER_REPO]);
	await expect(
		dialog.getByRole("group", { name: "Pull requests" }),
	).toHaveCount(0);
	await field.press("ArrowDown");
	await field.press("Enter");
	await expect(
		dialog
			.getByRole("list", { name: "Repos in this view" })
			.getByRole("listitem"),
	).toHaveText(["acme/api", OWNER_REPO]);
	await expect(field).toHaveValue("");
	// The save is held: Save spins, nothing can change meanwhile.
	let release = () => {};
	const held = new Promise<void>((done) => {
		release = done;
	});
	await page.route("**/api/home/view", async (route) => {
		await held;
		await route.continue();
	});
	const save = dialog.getByRole("button", { name: "Save" });
	await save.click();
	await expect(save).toBeDisabled();
	await expect(save.locator(".animate-spin")).toBeVisible();
	await expect(field).toHaveAttribute("readonly", "");
	await expect(
		dialog.getByRole("button", { name: "Remove acme/api" }),
	).toBeDisabled();
	release();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByText("Add widget cache with a rather long title"),
	).toBeVisible();
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
	await rowAction(page, hidden, "Wake up");
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

test("rows end at their age; the actions float over the row's end, clear of the age, on hover and focus", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	await setup(workdir, pr);
	const crb = await startReview(page, startCrb);
	await goHome(page, crb.url);
	const r = rowOf(section(page, "Up for grabs"), "Snapshot reviews");
	const ageRight = async () => {
		const row = await r.boundingBox();
		const age = await r.locator("time").boundingBox();
		if (!row || !age) throw new Error("no box");
		return row.x + row.width - (age.x + age.width);
	};
	// Only the row's own padding (12px) after the age: no room kept for
	// the actions.
	const gap = await ageRight();
	expect(gap).toBeLessThanOrEqual(13);
	if (isMobile) {
		const more = r.getByRole("button", { name: /^Actions for #/ });
		const box = await more.boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
		expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
		return;
	}
	const snooze = r.getByRole("button", { name: "Snooze", exact: true });
	const bar = r.locator("[data-row-actions]");
	await page.mouse.move(0, 0);
	await expect(bar).toHaveCSS("opacity", "0");
	await r.hover();
	await expect(bar).toHaveCSS("opacity", "1");
	// Over the row, not beside it: the age hasn't moved.
	expect(await ageRight()).toBe(gap);
	// Inside its own row (never up under the sticky header) and clear of
	// the age, in columns (lg) and stacked.
	for (const width of [1280, 900]) {
		await page.setViewportSize({ width, height: 800 });
		await r.hover();
		await expect(bar).toHaveCSS("opacity", "1");
		const barBox = await bar.boundingBox();
		const rowBox = await r.boundingBox();
		const ageBox = await r.locator("time").boundingBox();
		if (!barBox || !rowBox || !ageBox) throw new Error("no box");
		expect(barBox.x + barBox.width, `${width}`).toBeLessThanOrEqual(
			rowBox.x + rowBox.width,
		);
		expect(barBox.y, `${width}`).toBeGreaterThanOrEqual(rowBox.y - 0.5);
		expect(barBox.y + barBox.height, `${width}`).toBeLessThanOrEqual(
			rowBox.y + rowBox.height + 0.5,
		);
		const overlaps =
			barBox.x < ageBox.x + ageBox.width &&
			ageBox.x < barBox.x + barBox.width &&
			barBox.y < ageBox.y + ageBox.height &&
			ageBox.y < barBox.y + barBox.height;
		expect(overlaps, `bar over the age at ${width}px`).toBe(false);
	}
	await page.setViewportSize({ width: 1280, height: 800 });
	// Keyboard: focus in the row shows it too.
	await page.mouse.move(0, 0);
	await r.getByRole("link").focus();
	await expect(bar).toHaveCSS("opacity", "1");
	// Past the row's focusable signs (the age's exact date), to the bar.
	for (
		let i = 0;
		i < 5 && !(await snooze.evaluate((el) => el === document.activeElement));
		i++
	) {
		await page.keyboard.press("Tab");
	}
	await expect(snooze).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("dialog", { name: "Snooze" })).toBeVisible();
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
	// Wake up is a row action: in the bar (hover), or the ⋯ sheet (touch).
	await expect(
		reviewing
			.getByTestId("home-row-hidden")
			.getByRole("button", { name: isMobile ? /^Actions for #/ : "Wake up" }),
	).toBeAttached();
	const widths = await page.evaluate(() => ({
		scroll: document.documentElement.scrollWidth,
		client: document.documentElement.clientWidth,
	}));
	expect(widths.scroll).toBeLessThanOrEqual(widths.client);
	expect(await cutTitles(page)).toEqual([]);
	// Stacked rows: no column header.
	await expect(page.getByTestId("home-columns")).toBeHidden();
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
				.getByRole("button", { name: /^Actions for #/ }),
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

test("at desktop width: every title in full, and the header names the columns in line with them", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await setup(workdir, pr);
	const crb = await startReview(page, startCrb);
	await goHome(page, crb.url);
	await expect(page.getByText(/WidgetCacheInvalidation/)).toBeVisible();
	expect(await cutTitles(page)).toEqual([]);
	const header = page.getByTestId("home-columns");
	await expect(header).toBeVisible();
	await expect(header.locator("[data-col]")).toHaveText([
		"Repo",
		"Pull request",
		"Status",
		"Turn",
		"Reviewed",
		"Updated",
	]);
	// Each name starts where its column does, on every row.
	const misaligned = await page.evaluate(() => {
		const head = document.querySelector("[data-testid=home-columns]");
		const out: string[] = [];
		for (const name of head?.querySelectorAll<HTMLElement>("[data-col]") ??
			[]) {
			const col = name.dataset.col;
			const x = name.getBoundingClientRect().left;
			for (const row of document.querySelectorAll("[data-testid=home-row]")) {
				const cell = row.querySelector(`[data-col="${col}"]`);
				const left = cell?.getBoundingClientRect().left;
				if (left === undefined || Math.abs(left - x) > 1) {
					out.push(`${col}: ${left} vs ${x}`);
				}
			}
		}
		return out;
	});
	expect(misaligned).toEqual([]);
	// Sticky: still there over a section further down.
	await section(page, "Recently closed").scrollIntoViewIfNeeded();
	await page.mouse.wheel(0, 2000);
	await expect(header).toBeInViewport();
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
	await expect(dialog).toBeHidden();
	await page.mouse.move(0, 0);
	await page.locator("body").click({ position: { x: 1, y: 300 } });
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
	await page.locator("body").click({ position: { x: 1, y: 300 } });
	// The floating actions over a hovered row.
	await rowOf(section(page, "Reviewing"), "Rate-limit").hover();
	await page.screenshot({
		path: join(shots as string, "home-desktop-actions.png"),
	});
	await page.mouse.move(0, 0);
	await page
		.getByRole("combobox", { name: "Open a pull request" })
		.pressSequentially("acme");
	await expect(page.getByRole("listbox")).toBeVisible();
	await page.screenshot({
		path: join(shots as string, "home-desktop-search.png"),
	});
});

test("screenshots of view settings and the loading page (CRB_HOME_SHOTS only)", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	const shots = process.env.CRB_HOME_SHOTS;
	test.skip(!shots, "screenshots on request");
	const at = isMobile ? "360-phone" : "desktop";
	await page.setViewportSize(
		isMobile ? { width: 360, height: 800 } : { width: 1280, height: 800 },
	);
	const made = await setup(workdir, pr);
	const crb = await startCrb();
	await goHome(page, crb.url);
	await page.getByRole("button", { name: "Edit repos" }).click();
	const dialog = page.getByRole("dialog", { name: "My PRs" });
	await dialog
		.getByRole("combobox", { name: "Add a repo" })
		.pressSequentially("acme");
	await expect(dialog.getByRole("option").first()).toBeVisible();
	await page.screenshot({
		path: join(shots as string, `view-settings-${at}.png`),
	});
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	// The loading page, GitHub's answer held.
	made.editScenario((s) => {
		s.hold = ["prView"];
	});
	await page.goto(new URL("/pr/acme/widget/8", crb.url).href);
	await expect(page.getByRole("status")).toContainText("Opening");
	await page.screenshot({
		path: join(shots as string, `opening-${at}.png`),
	});
	release(made.scenarioPath, "prView");
});
