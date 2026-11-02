import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { bumpHomePr, homePr, release } from "../test/fake-gh/scenario";
import {
	expectNoPageOverflow,
	fileAction,
	fileSection,
	openFiles,
} from "./files-ui";
import { expect, OWNER_REPO, PR_NUMBER, type Pr, test } from "./fixtures";

/**
 * Home in the built `crb serve`, on a fake gh scenario: acme/api in the
 * view with a PR for each section, and the review PR (acme/widget#7, a
 * real repo), which the viewer starts; its repo is in the view only when
 * a test says so (Home lists only the view's repos, started or not).
 */

const VIEWER = "Octo";
const now = Date.now();
const iso = (minutesAgo: number) =>
	new Date(now - minutesAgo * 60_000).toISOString();

/** The fixture PR (widget#7) and acme/api's PRs, one per section. */
async function setup(
	workdir: string,
	pr: (opts?: object) => Promise<Pr>,
	{ widgetInView = false } = {},
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
		JSON.stringify({
			views: [
				{
					name: "My PRs",
					repos: widgetInView ? ["acme/api", OWNER_REPO] : ["acme/api"],
				},
			],
		}),
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

test("shows the sections from GitHub, and a started review with its coverage", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	await setup(workdir, pr, { widgetInView: true });
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
	await expect(page.getByRole("main").getByRole("status")).toContainText(
		"Opening",
	);
	await expect(page).toHaveURL(new RegExp(`/pr/${OWNER_REPO}/8$`));
	// The same address in another tab while the first open is held: two
	// opens of the PR at once.
	const prUrl = page.url();
	const other = await page.context().newPage();
	await other.goto(prUrl);
	await expect(other.getByRole("main").getByRole("status")).toContainText(
		"Opening",
	);
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
	const width = (await box.boundingBox())?.width;
	await box.click();
	await box.pressSequentially("acme");
	const repos = page.getByRole("group", { name: "Repos" });
	// The view's repo shows under the spinner while the list loads.
	await expect(repos).toHaveAttribute("aria-busy", "true");
	await expect(repos.locator(".animate-spin")).toBeVisible();
	await expect(repos.getByRole("option").first()).toContainText("acme/api");
	// The open box's own live region.
	const boxStatus = page.getByRole("search").getByRole("status");
	await expect(boxStatus).toHaveText("Loading your repos");
	// Its spinner has its own place: the input keeps its width.
	expect((await box.boundingBox())?.width).toBe(width);
	writeFileSync(hold, "");
	await expect(repos).toHaveAttribute("aria-busy", "false", {
		timeout: 15_000,
	});
	await expect(repos.getByRole("option")).toHaveText([
		/acme\/api/,
		new RegExp(OWNER_REPO),
	]);
	await expect(boxStatus).toHaveText("");
});

test("the view's repo input suggests the viewer's repos as you type; Save is stored at once while the added repo still reads", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	const made = await setup(workdir, pr);
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
	// GitHub's answers for the added repo are held (its read starts as it's
	// picked): saving doesn't wait for them (owner, 2026-11-01: "Saving
	// saves the configured repos immediately").
	const held = `home:${OWNER_REPO}` as const;
	made.editScenario((s) => {
		s.hold = [held];
	});
	await field.press("ArrowDown");
	await field.press("Enter");
	await expect(
		dialog
			.getByRole("list", { name: "Repos in this view" })
			.getByRole("listitem"),
	).toHaveText(["acme/api", OWNER_REPO]);
	await expect(field).toHaveValue("");
	await dialog.getByRole("button", { name: "Remove acme/api" }).click();
	const put = page.waitForResponse(
		(r) => r.url().endsWith("/api/home/view") && r.request().method() === "PUT",
	);
	await dialog.getByRole("button", { name: "Save" }).click();
	// At once: the dialog shuts, acme/api's rows go, the chips are the new
	// list.
	await expect(dialog).toBeHidden();
	await expect(page.getByText("Snooze PRs from the inbox")).toHaveCount(0);
	await expect(page.getByTestId("view-repo")).toHaveText([OWNER_REPO]);
	// Stored while the read is still held: the save is done, the repo loads.
	expect((await put).status()).toBe(200);
	await expect(page.getByRole("status", { name: "Saving" })).toBeHidden();
	await expect(page.getByRole("status", { name: "Loading" })).toBeVisible();
	await expect(page.getByTestId("view-repo")).toHaveAttribute(
		"data-state",
		"loading",
	);
	// Confirmed: nothing left to warn about.
	await expect(page.getByTestId("save-delayed")).toHaveCount(0);
	await expectNoPageOverflow(page);
	release(made.scenarioPath, held);
	await expect(
		page.getByText("Add widget cache with a rather long title"),
	).toBeVisible();
	await expect(page.getByRole("status", { name: "Loading" })).toBeHidden();
	await expect(page.getByText("Snooze PRs from the inbox")).toHaveCount(0);
	// The server kept it: a reload shows the same.
	await page.reload();
	await expect(page.getByTestId("view-repo")).toHaveText([OWNER_REPO]);
});

test("with the repo suggestions open, one click (a tap) on Add adds what was typed; the list never moves Add", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	// Owner, 2026-11-02, on Add missing the click while the list is open:
	// "sure go ahead and fix it".
	await setup(workdir, pr);
	const crb = await startCrb();
	await goHome(page, crb.url);
	await page.getByRole("button", { name: "Edit repos" }).click();
	const dialog = page.getByRole("dialog", { name: "My PRs" });
	const field = dialog.getByRole("combobox", { name: "Add a repo" });
	const add = dialog.getByRole("button", { name: "Add", exact: true });
	// Neither Add nor what the list floats over (Save) moves.
	const boxes = () =>
		Promise.all(
			[add, dialog.getByRole("button", { name: "Save" })].map((b) =>
				b.boundingBox(),
			),
		);
	await field.focus();
	const closed = await boxes();
	await field.pressSequentially(OWNER_REPO);
	const list = dialog.getByRole("listbox", { name: "Suggestions" });
	await expect(list.getByRole("option")).toHaveText([OWNER_REPO]);
	expect(await boxes()).toEqual(closed);
	if (isMobile) await add.tap();
	else await add.click();
	await expect(
		dialog
			.getByRole("list", { name: "Repos in this view" })
			.getByRole("listitem"),
	).toHaveText(["acme/api", OWNER_REPO]);
	await expect(field).toHaveValue("");
	await expect(list).toHaveCount(0);
});

test("a repo picked in the settings is read at once: saved after its read, its rows come with no second read", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	// Owner, 2026-11-02: "after a repo is selected into the view, the
	// tanstack query for it should start populating in the background".
	const made = await setup(workdir, pr);
	const crb = await startCrb();
	const reads: string[] = [];
	page.on("request", (r) => {
		if (r.url().includes(`/api/home/repos/${OWNER_REPO}`)) reads.push(r.url());
	});
	await goHome(page, crb.url);
	await expect(page.getByRole("status", { name: "Loading" })).toBeHidden();
	const held = `home:${OWNER_REPO}` as const;
	made.editScenario((s) => {
		s.hold = [held];
	});
	await page.getByRole("button", { name: "Edit repos" }).click();
	const dialog = page.getByRole("dialog", { name: "My PRs" });
	const answered = page.waitForResponse((r) =>
		r.url().includes(`/api/home/repos/${OWNER_REPO}`),
	);
	const field = dialog.getByRole("combobox", { name: "Add a repo" });
	await field.fill(OWNER_REPO);
	await field.press("Enter");
	await expect(
		dialog
			.getByRole("list", { name: "Repos in this view" })
			.getByRole("listitem"),
	).toHaveText(["acme/api", OWNER_REPO]);
	await expect.poll(() => reads.length).toBe(1);
	// Nothing on the page meanwhile.
	await expect(page.getByTestId("view-repo")).toHaveText(["acme/api"]);
	await expect(page.getByRole("status", { name: "Loading" })).toBeHidden();
	release(made.scenarioPath, held);
	expect((await answered).status()).toBe(200);
	// Held again, so a fresh second read would never answer; the guard
	// is the page's request count staying at 1 (a plain second ask would
	// be answered from the server's cache).
	made.editScenario((s) => {
		s.hold = [held];
	});
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(
		page.getByText("Add widget cache with a rather long title"),
	).toBeVisible();
	await expect(page.getByRole("status", { name: "Saving" })).toBeHidden();
	await expect(
		page.getByTestId("view-repo").filter({ hasText: OWNER_REPO }),
	).toHaveAttribute("data-state", "ready");
	await expect(page.getByRole("status", { name: "Loading" })).toBeHidden();
	expect(reads).toHaveLength(1);
	await expectNoPageOverflow(page);
	release(made.scenarioPath, held);
});

test("removing a repo from the view takes its started rows with it; adding it back brings them back", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	// Owner, 2026-11-01: "only prs from the selected repos should appear".
	const made = await setup(workdir, pr, { widgetInView: true });
	const crb = await startReview(page, startCrb);
	await goHome(page, crb.url);
	const widget = () => rowOf(page, "Add widget cache");
	const coverage = () =>
		widget().getByRole("img", { name: /^1 of \d+ lines? reviewed$/ });
	await expect(coverage()).toBeVisible();
	const edit = async () => {
		await page.getByRole("button", { name: "Edit repos" }).click();
		return page.getByRole("dialog", { name: "My PRs" });
	};
	let dialog = await edit();
	await dialog.getByRole("button", { name: `Remove ${OWNER_REPO}` }).click();
	made.editScenario((s) => {
		s.hold = ["home"];
	});
	await dialog.getByRole("button", { name: "Save" }).click();
	// At once, before the server answers.
	await expect(dialog).toBeHidden();
	await expect(widget()).toHaveCount(0);
	const saving = page.getByRole("status", { name: "Saving" });
	release(made.scenarioPath, "home");
	await expect(saving).toBeHidden();
	await expect(widget()).toHaveCount(0);
	await expect(page.getByText("Snooze PRs from the inbox")).toBeVisible();
	// The server's own read says the same.
	await page.reload();
	await expect(page.getByText("Snooze PRs from the inbox")).toBeVisible();
	await expect(page.getByTestId("view-repo")).toHaveText(["acme/api"]);
	await expect(widget()).toHaveCount(0);
	// Back in the view with one click on its chip: the row returns with its
	// coverage after the read.
	dialog = await edit();
	await dialog.getByRole("button", { name: `Add ${OWNER_REPO}` }).click();
	await expect(
		dialog
			.getByRole("list", { name: "Repos in this view" })
			.getByRole("listitem"),
	).toHaveText(["acme/api", OWNER_REPO]);
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toBeHidden();
	await expect(coverage()).toBeVisible();
	await page.reload();
	await expect(coverage()).toBeVisible();
});

test("after Save the pencil's tooltip doesn't stay over the sections", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await setup(workdir, pr);
	const crb = await startCrb();
	await goHome(page, crb.url);
	const pencil = page.getByRole("button", { name: "Edit repos" });
	if (isMobile) await pencil.tap();
	else await pencil.click();
	const dialog = page.getByRole("dialog", { name: "My PRs" });
	const save = dialog.getByRole("button", { name: "Save" });
	if (isMobile) await save.tap();
	else await save.click();
	await expect(dialog).toBeHidden();
	if (!isMobile) await page.mouse.move(0, 0);
	const tip = page
		.locator("[role=tooltip]:not([hidden])")
		.filter({ hasText: "Edit repos" });
	// Give a late tooltip its chance to show.
	await page.waitForTimeout(500);
	await expect(tip).toHaveCount(0);
});

test("a refused view save says why and puts the last saved view back", async ({
	page,
	workdir,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/status of 400/);
	await setup(workdir, pr);
	const crb = await startCrb();
	await goHome(page, crb.url);
	await page.getByRole("button", { name: "Edit repos" }).click();
	const dialog = page.getByRole("dialog", { name: "My PRs" });
	await dialog.getByRole("button", { name: "Remove acme/api" }).click();
	// The page takes it; GitHub's names can't start with a dash.
	await dialog.getByRole("combobox", { name: "Add a repo" }).fill("-acme/x");
	await dialog.getByRole("combobox", { name: "Add a repo" }).press("Enter");
	await dialog.getByRole("button", { name: "Save" }).click();
	const failed = page.getByTestId("view-save-failed");
	await expect(failed).toContainText("Not a repository: -acme/x");
	await expect(page.getByTestId("view-repo")).toHaveText(["acme/api"]);
	await expect(page.getByText("Snooze PRs from the inbox")).toBeVisible();
	await failed.getByRole("button", { name: "Dismiss" }).click();
	await expect(failed).toBeHidden();
});

test("a repo GitHub doesn't know is saved, and its chip says so with Retry; the other's rows stay", async ({
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
	await field.fill("acme/nowhere");
	await field.press("Enter");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toBeHidden();
	const typo = page
		.getByTestId("view-repo")
		.filter({ hasText: "acme/nowhere" });
	await expect(typo).toHaveAttribute("data-state", "failed");
	await expect(
		typo.getByRole("img", { name: "acme/nowhere: Not found on GitHub" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Retry acme/nowhere" }),
	).toBeVisible();
	await expect(page.getByTestId("view-save-failed")).toHaveCount(0);
	await expect(page.getByText("Snooze PRs from the inbox")).toBeVisible();
	// Never read: every section's count says so; no section says none.
	await expect(
		section(page, "Reviewing").getByRole("img", {
			name: "Without acme/nowhere: Not found on GitHub",
		}),
	).toBeVisible();
	await expect(page.getByTestId("section-none")).toHaveCount(0);
	// At 360px, with an unread repo and one a held save is adding.
	await page.setViewportSize({ width: 360, height: 780 });
	await expectNoPageOverflow(page);
	let answer: () => void = () => {};
	const putHeld = new Promise<void>((r) => {
		answer = r;
	});
	await page.route("**/api/home/view", async (route) => {
		if (route.request().method() === "PUT") await putHeld;
		await route.continue();
	});
	await page.getByRole("button", { name: "Edit repos" }).click();
	await field.fill(OWNER_REPO);
	await field.press("Enter");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toBeHidden();
	const adding = page.getByTestId("view-repo").filter({ hasText: OWNER_REPO });
	await expect(adding).toHaveAttribute("data-state", "saving");
	await expect(
		section(page, "Mine").getByRole("img", {
			name: `Waiting for the save: ${OWNER_REPO}`,
		}),
	).toBeVisible();
	await expectNoPageOverflow(page);
	answer();
	await expect(adding).not.toHaveAttribute("data-state", "saving");
});

test("one repo's read held: the other's rows show, the held one and the sections spin, no counts; released, its rows and the counts come", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	const made = await setup(workdir, pr, { widgetInView: true });
	const held = `home:${OWNER_REPO}` as const;
	made.editScenario((s) => {
		s.hold = [held];
	});
	const crb = await startCrb();
	await page.goto(home(crb.url));
	await expect(page.getByText("Snooze PRs from the inbox")).toBeVisible();
	await expect(page.getByRole("status", { name: "Loading" })).toBeVisible();
	const widget = page.getByTestId("view-repo").filter({ hasText: OWNER_REPO });
	await expect(widget).toHaveAttribute("data-state", "loading");
	await expect(
		widget.getByRole("img", { name: `Loading ${OWNER_REPO}` }),
	).toBeVisible();
	for (const name of ["Mine", "Reviewing", "Up for grabs", "Other open"]) {
		const s = section(page, name);
		await expect(s.getByRole("img", { name: "Loading" })).toBeVisible();
		await expect(s.getByRole("heading")).not.toHaveText(/\d/);
		await expect(s.getByTestId("row-skeleton").first()).toBeVisible();
	}
	await expect(page.getByText("Add widget cache")).toHaveCount(0);
	await expectNoPageOverflow(page);
	release(made.scenarioPath, held);
	await expect(page.getByText("Add widget cache")).toBeVisible();
	await expect(page.getByRole("status", { name: "Loading" })).toBeHidden();
	await expect(page.getByTestId("row-skeleton")).toHaveCount(0);
	await expect(section(page, "Reviewing").getByRole("heading")).toHaveText(
		/Reviewing\s*2/,
	);
	await expect(section(page, "Other open").getByRole("heading")).toHaveText(
		/Other open\s*1/,
	);
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

test("waiting on suggests people as you type: the viewer's orgs and repos' people, then GitHub's", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	const made = await setup(workdir, pr);
	made.editScenario((s) => {
		s.orgMembers = { acme: [VIEWER, "alicia", "malik"] };
		s.githubUsers = ["alibaba-dev", "alice", { login: "alien-org", org: true }];
	});
	const crb = await startCrb();
	await goHome(page, crb.url);
	const other = section(page, "Other open");
	const title = "Migrate alerts table";
	const dialog = await rowAction(page, rowOf(other, title), "Waiting on");
	const field = dialog.getByRole("combobox", { name: "Someone else" });
	await field.pressSequentially("ali");
	// alice authors the view's PRs, alicia and malik are in the viewer's
	// org: theirs first, starting with the text first; then GitHub's, never
	// an org.
	await expect(
		page.getByRole("group", { name: "People" }).getByRole("option"),
	).toHaveText(["alice", "alicia", "malik"]);
	await expect(
		page.getByRole("group", { name: "GitHub" }).getByRole("option"),
	).toHaveText(["alibaba-dev"]);
	await expectNoPageOverflow(page);
	await page.getByRole("option", { name: "alibaba-dev" }).click();
	await expect(other.getByRole("button", { name: "1 waiting" })).toBeVisible();
});

test("with the waiting-on suggestions open, a tap on a person takes it; the list moves neither the people nor Clear", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	const made = await setup(workdir, pr);
	made.editScenario((s) => {
		s.orgMembers = { acme: [VIEWER, "alicia", "malik"] };
	});
	const crb = await startCrb();
	await goHome(page, crb.url);
	const other = section(page, "Other open");
	const title = "Migrate alerts table";
	/**
	 * Opens Waiting on, then its suggestions: `name` doesn't move. With a
	 * mouse the list floats over the panel (over the target too, above or
	 * below the input): shut first. On touch it floats below the input,
	 * and a person above it is tapped with the list open.
	 */
	const withList = async (row: Locator, name: string | RegExp) => {
		const dialog = await rowAction(page, row, "Waiting on");
		const field = dialog.getByRole("combobox", { name: "Someone else" });
		const target = dialog.getByRole("button", { name });
		await field.focus();
		const closed = await target.boundingBox();
		await field.pressSequentially("ali");
		await expect(
			page.getByRole("group", { name: "People" }).getByRole("option"),
		).toHaveText(["alice", "alicia", "malik"]);
		expect(await target.boundingBox()).toEqual(closed);
		return { field, target };
	};
	const bob = await withList(rowOf(other, title), /^bob/);
	if (isMobile) await bob.target.tap();
	else {
		await bob.field.press("Escape");
		await bob.target.click();
	}
	const foot = other.getByRole("button", { name: "1 waiting" });
	await expect(foot).toBeVisible();
	await expect(other.getByTestId("home-row")).toHaveCount(0);
	await foot.click();
	const clear = await withList(other.getByTestId("home-row-hidden"), "Clear");
	await clear.field.press("Escape");
	await clear.target.click();
	await expect(other.getByTestId("home-row")).toHaveCount(1);
	await expect(foot).toBeHidden();
});

test("on a short window the waiting-on suggestions stay inside it, and inside the phone's sheet", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	if (!isMobile) await page.setViewportSize({ width: 1280, height: 600 });
	const made = await setup(workdir, pr);
	made.editScenario((s) => {
		s.orgMembers = {
			acme: [VIEWER, ...Array.from({ length: 12 }, (_, i) => `ali${i}`)],
		};
	});
	const crb = await startCrb();
	await goHome(page, crb.url);
	const other = section(page, "Other open");
	const dialog = await rowAction(
		page,
		rowOf(other, "Migrate alerts table"),
		"Waiting on",
	);
	await dialog
		.getByRole("combobox", { name: "Someone else" })
		.pressSequentially("ali");
	const list = page.getByRole("listbox", { name: "Suggestions" });
	await expect(list.getByRole("option").first()).toBeVisible();
	// Inside the window, and on a phone inside its sheet (a modal dialog
	// that scrolls: anything above its top could never be reached).
	const box = await list.evaluate((el) => {
		const r = (el.parentElement as HTMLElement).getBoundingClientRect();
		const sheet = el.closest("dialog")?.getBoundingClientRect();
		return {
			top: r.top,
			bottom: r.bottom,
			height: window.innerHeight,
			sheetTop: sheet?.top ?? 0,
		};
	});
	expect(box.top).toBeGreaterThanOrEqual(isMobile ? box.sheetTop : 0);
	if (!isMobile) expect(box.bottom).toBeLessThanOrEqual(box.height);
	// Every suggestion can be reached and tapped: the first and the last.
	for (const option of [
		list.getByRole("option").first(),
		list.getByRole("option").last(),
	]) {
		await option.scrollIntoViewIfNeeded();
		await expect(option).toBeInViewport();
		const hit = await option.evaluate((el) => {
			const r = el.getBoundingClientRect();
			const at = document.elementFromPoint(
				r.left + r.width / 2,
				r.top + r.height / 2,
			);
			return !!at && el.contains(at);
		});
		expect(hit).toBe(true);
	}
});

test("a note sits under the title on one line; hover or a tap shows all of it", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await setup(workdir, pr);
	const crb = await startCrb();
	await goHome(page, crb.url);
	const other = section(page, "Other open");
	const title = "Migrate alerts table";
	const note = [
		"Waiting for the alerts team to sign off on the migration window before this goes anywhere",
		"then rerun the backfill",
		"and tell Tomer",
	].join("\n");
	const dialog = await rowAction(page, rowOf(other, title), "Note");
	await dialog.getByRole("textbox").fill(note);
	await dialog.getByRole("button", { name: "Save" }).click();
	const row = rowOf(other, title);
	const shown = row.getByTestId("row-note");
	await expect(shown).toBeVisible();
	const link = row.getByRole("link", { name: new RegExp(title) });
	const t = await link.boundingBox();
	const n = await shown.boundingBox();
	// Under the title, not beside it.
	expect(n?.y ?? 0).toBeGreaterThanOrEqual((t?.y ?? 0) + (t?.height ?? 0) - 1);
	// One line: as tall as a line of its text, cut with an ellipsis.
	const line = await shown.evaluate((el) =>
		Number.parseFloat(getComputedStyle(el).lineHeight),
	);
	expect(n?.height ?? 0).toBeLessThanOrEqual(line + 4);
	expect(
		await shown.evaluate((el) => {
			const text = el.querySelector("[data-note-text]") as HTMLElement;
			return (
				getComputedStyle(text).textOverflow === "ellipsis" &&
				text.scrollWidth > text.clientWidth
			);
		}),
	).toBe(true);
	// The whole note, its lines kept: on hover with a mouse, on a tap on touch.
	const sign = shown.getByRole("img", { name: /^Note: / });
	if (isMobile) await sign.tap();
	else await sign.hover();
	const tip = page
		.locator("[role=tooltip]:not([hidden])")
		.filter({ hasText: /^Note: / });
	await expect(tip).toBeVisible();
	await expect(tip).toContainText("and tell Tomer");
	expect(await tip.innerText()).toBe(`Note: ${note}`);
	await expectNoPageOverflow(page);
});

test("a failed refresh shows the warning and keeps the rows", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	const made = await setup(workdir, pr);
	const crb = await startCrb();
	await goHome(page, crb.url);
	made.editScenario((s) => {
		s.rateLimited = true;
	});
	await page.getByRole("button", { name: "Refresh" }).click();
	const status = page.getByTestId("refresh-status");
	await expect(
		status.getByRole("img", { name: /^Refresh failed: / }),
	).toBeVisible();
	await expect(status).toHaveClass(/text-warn/);
	await expect(
		page.getByRole("button", { name: "Retry acme/api" }),
	).toBeVisible();
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
	await setup(workdir, pr, { widgetInView: true });
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
	await setup(workdir, pr, { widgetInView: true });
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

test("with a coarse pointer and hover (a touch laptop) the bar's buttons are 40px and stay clear of the age", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "the bar shows only with hover");
	await setup(workdir, pr, { widgetInView: true });
	const crb = await startReview(page, startCrb);
	await goHome(page, crb.url);
	// Chromium can't emulate a coarse pointer that also hovers (touch
	// emulation turns hover off): the page's own `(any-pointer: coarse)`
	// rules are switched on, as such a laptop matches them.
	const switched = await page.evaluate(() => {
		let n = 0;
		for (const sheet of document.styleSheets) {
			const walk = (rules: CSSRuleList) => {
				for (const rule of rules) {
					if (rule instanceof CSSMediaRule) {
						if (/any-pointer:\s*coarse/.test(rule.media.mediaText)) {
							rule.media.mediaText = "all";
							n++;
						}
						walk(rule.cssRules);
					} else if ("cssRules" in rule) {
						walk((rule as CSSGroupingRule).cssRules);
					}
				}
			};
			walk(sheet.cssRules);
		}
		return n;
	});
	expect(switched).toBeGreaterThan(0);
	const r = rowOf(section(page, "Up for grabs"), "Snapshot reviews");
	const bar = r.locator("[data-row-actions]");
	for (const width of [1280, 900]) {
		await page.setViewportSize({ width, height: 800 });
		await r.hover();
		await expect(bar).toHaveCSS("opacity", "1");
		for (const name of ["Snooze", "Waiting on", "Note"]) {
			const box = await r
				.getByRole("button", { name, exact: true })
				.boundingBox();
			expect(box?.height ?? 0, `${name} at ${width}px`).toBeGreaterThanOrEqual(
				40,
			);
			expect(box?.width ?? 0, `${name} at ${width}px`).toBeGreaterThanOrEqual(
				40,
			);
		}
		const barBox = await bar.boundingBox();
		const rowBox = await r.boundingBox();
		const ageBox = await r.locator("time").boundingBox();
		if (!barBox || !rowBox || !ageBox) throw new Error("no box");
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
});

test("at 360px: no sideways scroll with the busiest rows, and 40px targets", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	await page.setViewportSize({ width: 360, height: 800 });
	await setup(workdir, pr, { widgetInView: true });
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

test("at desktop width: every title in full, and the header names the columns in line with them and the sub-rows", async ({
	page,
	workdir,
	pr,
	startCrb,
}) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	const made = await setup(workdir, pr, { widgetInView: true });
	const crb = await startReview(page, startCrb);
	// A second review of the PR, pinned to its head and started: sub-rows.
	// The head is a commit GitHub knows of the PR (a review on it).
	const head = made.repo.shas.at(-1) ?? "";
	made.editScenario((s) => {
		const graphql = s.prs[String(PR_NUMBER)]?.graphql;
		if (!graphql) throw new Error("no graphql");
		graphql.reviews = [
			{
				author: { login: "rev1", __typename: "User" },
				state: "COMMENTED",
				submittedAt: "2026-01-04T00:00:00Z",
				commit: { oid: head },
			},
		];
	});
	const origin = new URL(crb.url).origin;
	await page.goto(`${origin}/pr/${OWNER_REPO}/${PR_NUMBER}?head=${head}`);
	await expect(page).toHaveURL(/\/r\/[0-9a-z]{26}$/);
	await openFiles(page, page.url(), "Lines");
	await fileAction(fileSection(page, "new.txt"), "Mark remaining reviewed");
	await expect(
		fileSection(page, "new.txt").getByRole("progressbar", {
			name: "File progress",
		}),
	).toHaveAttribute("aria-valuenow", "100");
	await goHome(page, crb.url);
	await expect(page.getByTestId("home-subrow")).toHaveCount(2);
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
			// A sub-row's coverage and age, under Reviewed and Updated.
			if (col !== "coverage" && col !== "updated") continue;
			for (const row of document.querySelectorAll(
				"[data-testid=home-subrow]",
			)) {
				const left = row
					.querySelector(`[data-col="${col}"]`)
					?.getBoundingClientRect().left;
				if (left === undefined || Math.abs(left - x) > 1) {
					out.push(`sub-row ${col}: ${left} vs ${x}`);
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

test("at desktop width a long login or many signs stay inside their columns", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "columns with a mouse; touch shares the layout");
	await page.setViewportSize({ width: 1280, height: 900 });
	await setup(workdir, pr, { widgetInView: true });
	const crb = await startReview(page, startCrb);
	await goHome(page, crb.url);
	const other = section(page, "Other open");
	const login = "a-rather-long-github-login-of-39-chars";
	const dialog = await rowAction(
		page,
		rowOf(other, "Migrate alerts table"),
		"Waiting on",
	);
	await dialog.getByRole("combobox", { name: "Someone else" }).fill(login);
	await dialog.getByRole("combobox", { name: "Someone else" }).press("Enter");
	await other.getByRole("button", { name: "1 waiting" }).click();
	const hidden = other.getByTestId("home-row-hidden");
	// Cut on the row, whole in its name (the tooltip).
	await expect(
		hidden.getByRole("img", { name: `Waiting on ${login}` }),
	).toBeVisible();
	const spills = await page.evaluate(() =>
		[
			...document.querySelectorAll("[data-testid^=home-row] [data-col]"),
		].flatMap((cell) => {
			const box = cell.getBoundingClientRect();
			return [...cell.querySelectorAll("*")]
				.map((el) => [el, el.getBoundingClientRect()] as const)
				.filter(
					([, r]) =>
						r.width > 0 && (r.left < box.left - 1 || r.right > box.right + 1),
				)
				.map(
					([el, r]) =>
						`${(cell as HTMLElement).dataset.col}: ${el.textContent?.slice(0, 20)} ${r.left}–${r.right} outside ${box.left}–${box.right}`,
				);
		}),
	);
	expect(spills).toEqual([]);
});

/**
 * Where `targets` are on the page now: a spinner showing or going must
 * leave every one where it was (owner, 2026-11-02: "Make sure spinners
 * appear somewhere static so the UI doesn't jitter").
 */
async function boxes(targets: Locator[]) {
	return Promise.all(targets.map((t) => t.boundingBox()));
}

test("a refresh's spinners move nothing: the view's name, its chips, the first section and row stay put", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	const made = await setup(workdir, pr, { widgetInView: true });
	const crb = await startCrb();
	await goHome(page, crb.url);
	const loading = page.getByRole("status", { name: "Loading" });
	await expect(loading).toBeHidden();
	const mine = section(page, "Mine");
	const targets = [
		page.getByRole("heading", { level: 1 }),
		page.getByTestId("view-repo").first(),
		page.getByTestId("view-repo").last(),
		page.getByRole("button", { name: "Edit repos" }),
		mine.getByRole("heading"),
		mine.getByTestId(/^home-row/).first(),
		page.getByRole("button", { name: "Refresh" }),
	];
	const before = await boxes(targets);
	made.editScenario((s) => {
		s.hold = ["home"];
	});
	await page.getByRole("button", { name: "Refresh" }).click();
	await expect(loading).toBeVisible();
	expect(await boxes(targets)).toEqual(before);
	release(made.scenarioPath, "home");
	await expect(loading).toBeHidden();
	expect(await boxes(targets)).toEqual(before);
	await expectNoPageOverflow(page);
});

test("a section's count spinner holds the count's place: its heading and hint don't move when the count comes", async ({
	page,
	workdir,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	const made = await setup(workdir, pr, { widgetInView: true });
	const held = `home:${OWNER_REPO}` as const;
	made.editScenario((s) => {
		s.hold = [held];
	});
	const crb = await startCrb();
	await goHome(page, crb.url);
	const reviewing = section(page, "Reviewing");
	await expect(reviewing.getByRole("img", { name: "Loading" })).toBeVisible();
	const heading = reviewing.getByRole("heading");
	const hint = reviewing.getByText("requested or started");
	// Rows coming above may move the section down; within it, nothing moves.
	const place = async () => {
		const [h, t] = await boxes([heading, hint]);
		return {
			height: h?.height,
			x: h?.x,
			hintX: t?.x,
			hintDy: (t?.y ?? 0) - (h?.y ?? 0),
		};
	};
	const before = await place();
	release(made.scenarioPath, held);
	await expect(heading).toHaveText(/Reviewing\s*2/);
	expect(await place()).toEqual(before);
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
	await setup(workdir, pr, { widgetInView: true });
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
	// A long note under its title, then Waiting on's suggestions.
	made.editScenario((s) => {
		s.orgMembers = { acme: [VIEWER, "alicia", "malik"] };
		s.githubUsers = ["alibaba-dev", "alice"];
	});
	const other = section(page, "Other open");
	const note = await rowAction(page, rowOf(other, "Migrate alerts"), "Note");
	await note
		.getByRole("textbox")
		.fill(
			"Waiting for the alerts team to sign off on the migration window first\nthen rerun the backfill",
		);
	await note.getByRole("button", { name: "Save" }).click();
	await expect(note).toBeHidden();
	const waiting = await rowAction(
		page,
		rowOf(other, "Migrate alerts"),
		"Waiting on",
	);
	await waiting
		.getByRole("combobox", { name: "Someone else" })
		.pressSequentially("ali");
	await expect(page.getByRole("group", { name: "GitHub" })).toBeVisible();
	await page.screenshot({
		path: join(shots as string, `waiting-on-${at}.png`),
	});
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	await page.mouse.move(0, 0);
	await rowOf(other, "Migrate alerts").scrollIntoViewIfNeeded();
	await page.screenshot({
		path: join(shots as string, `note-${at}.png`),
	});
	// A save unconfirmed past 5 s: the new view, its spinner, the warning.
	await page.getByRole("button", { name: "Edit repos" }).click();
	await dialog.getByRole("combobox", { name: "Add a repo" }).fill(OWNER_REPO);
	await dialog.getByRole("combobox", { name: "Add a repo" }).press("Enter");
	made.editScenario((s) => {
		s.hold = ["home"];
	});
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(page.getByTestId("save-delayed")).toBeVisible({
		timeout: 15_000,
	});
	await page.screenshot({
		path: join(shots as string, `view-saving-${at}.png`),
	});
	release(made.scenarioPath, "home");
	await expect(page.getByRole("status", { name: "Saving" })).toBeHidden();
	// The loading page, GitHub's answer held.
	made.editScenario((s) => {
		s.hold = ["prView"];
	});
	await page.goto(new URL("/pr/acme/widget/8", crb.url).href);
	await expect(page.getByRole("main").getByRole("status")).toContainText(
		"Opening",
	);
	await page.screenshot({
		path: join(shots as string, `opening-${at}.png`),
	});
	release(made.scenarioPath, "prView");
});
