import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import {
	release,
	reviewThread,
	type Scenario,
	threadComment,
} from "../test/fake-gh/scenario";
import { expect, type Pr, type PrOptions, test } from "./fixtures";

/**
 * The Final Verdict tab and the verdict card (also after the last file in
 * Files changed). The viewer is Octo_Cat. GitHub says BLOCKED, review
 * required, the rule unreadable: a required check failing (jira), one not
 * required running (e2e), one required passing (unit), the platform team
 * asked as code owner, rev2 asked; threads: rev1's on a.txt:2, Octo_Cat's
 * own on new.txt:1.
 */
const LONG_TITLE =
	"Refactor the widget cache so eviction, expiry and the HTTP client retries share one clock";

function fixture(): PrOptions {
	return {
		baseDate: "2026-01-01T00:00:00Z",
		files: [
			{
				message: "PR change",
				files: {
					"a.txt": `${Array.from({ length: 30 }, (_, i) =>
						i === 1 ? "line 2 changed" : `line ${i + 1}`,
					).join("\n")}\n`,
					"new.txt": "new\n",
				},
				date: "2026-01-02T00:00:00Z",
			},
		],
		overview: {
			title: LONG_TITLE,
			author: { login: "alice" },
			mergeStateStatus: "BLOCKED",
			reviewDecision: "REVIEW_REQUIRED",
			reviewRequests: [
				{ __typename: "User", login: "rev2", asCodeOwner: false },
				{
					__typename: "Team",
					name: "Platform",
					slug: "platform",
					asCodeOwner: true,
				},
			],
			statusCheckRollup: [
				{
					__typename: "CheckRun",
					name: "jira",
					status: "COMPLETED",
					conclusion: "FAILURE",
					detailsUrl: "https://ci.example/jira",
					required: true,
				},
				{
					__typename: "CheckRun",
					name: "e2e",
					status: "IN_PROGRESS",
					conclusion: null,
					detailsUrl: "https://ci.example/e2e",
					required: false,
				},
				{
					__typename: "CheckRun",
					name: "unit",
					status: "COMPLETED",
					conclusion: "SUCCESS",
					detailsUrl: "https://ci.example/unit",
					required: true,
				},
			],
		},
	};
}

const PENDING = {
	author: { login: "Octo_Cat", __typename: "User" },
	state: "PENDING",
	submittedAt: null,
	createdAt: "2026-01-03T00:00:00Z",
};

async function setup(
	pr: (opts?: PrOptions) => Promise<Pr>,
	scenario: Partial<Scenario> = {},
	more: Partial<PrOptions> = {},
) {
	const p = await pr({ ...fixture(), ...more });
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((s) => {
		const graph = s.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: "a.txt", line: 2, subjectType: "LINE" }, [
				threadComment({
					login: "rev1",
					text: "Changed how?",
					createdAt: "2026-01-02T08:00:00Z",
					commit: head,
					diffHunk: "@@ -1,2 +1,2 @@\n line 1\n-line 2\n+line 2 changed",
				}),
			]),
			reviewThread({ path: "new.txt", line: 1, subjectType: "LINE" }, [
				threadComment({
					login: "Octo_Cat",
					text: "My own question",
					createdAt: "2026-01-02T09:00:00Z",
					commit: head,
					diffHunk: "@@ -0,0 +1 @@\n+new",
				}),
			]),
		];
		Object.assign(s, scenario);
	});
	return p;
}

interface StoredReview {
	author?: { login: string };
	state: string;
	body?: string;
}

/** The PR's reviews as the fake gh stores them. */
function reviews(p: Pr): StoredReview[] {
	const s = JSON.parse(readFileSync(p.scenarioPath, "utf8")) as Scenario;
	return (s.prs[7]?.graphql?.reviews ?? []) as StoredReview[];
}

const submitted = (p: Pr) => reviews(p).filter((r) => r.state !== "PENDING");

const tabCard = (page: Page) => page.getByTestId("verdict-card-tab");
const filesCard = (page: Page) => page.getByTestId("verdict-card-files");
const verdictButton = (card: Locator, name: string) =>
	card.getByRole("button", { name, exact: true });
const chip = (page: Page) => page.getByTestId("refused-bar");
const item = (page: Page) => page.getByTestId("refused-write");

async function openTab(page: Page) {
	await page.getByRole("link", { name: "Final Verdict" }).click();
	await expect(page.getByTestId("github-status")).toBeVisible();
}

/** Screenshots for the report, when DESIGN_SHOTS names a folder. */
async function shot(page: Page, name: string, isMobile: boolean) {
	const dir = process.env.DESIGN_SHOTS;
	if (!dir) return;
	await page.screenshot({
		path: `${dir}/${name}-${isMobile ? "phone" : "desktop"}.png`,
		fullPage: true,
	});
}

test("the tab isn't read on first open of the Overview, only once shown; it lists the blockers", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await setup(pr);
	const s = await startCrb();
	const verdictReads: string[] = [];
	page.on("request", (r) => {
		if (new URL(r.url()).pathname === "/api/verdict" && r.method() === "GET") {
			verdictReads.push(r.url());
		}
	});
	await page.goto(s.url);
	await expect(
		page.getByRole("region", { name: "Human reviews" }).getByTestId("thread"),
	).toHaveCount(2);
	expect(verdictReads).toEqual([]);
	await openTab(page);
	expect(verdictReads).toHaveLength(1);
	await expect(page.getByTestId("github-status")).toContainText(
		"GitHub: blocked",
	);
	const list = page.getByRole("list", { name: "Blockers" });
	const row = (text: string | RegExp) =>
		list.getByTestId("blocker").filter({ hasText: text });
	// Required: tagged, red.
	await expect(row("jira failing")).toHaveAttribute("data-required", "true");
	await expect(row("jira failing").getByTestId("required-tag")).toBeVisible();
	await expect(row("jira failing").getByRole("link")).toHaveAttribute(
		"href",
		"https://ci.example/jira",
	);
	// The rule unreadable: the code owner is a detail of review required.
	await expect(row("Review required")).toHaveAttribute("data-required", "true");
	await expect(row("Review required")).toContainText(/platform.*code owner/i);
	// Not required: untagged, yellow.
	await expect(row("e2e running")).not.toHaveAttribute("data-required");
	await expect(row("e2e running")).toHaveAttribute("data-tone", "warn");
	// Threads, the reviewer's own first, each linking to its card.
	const threads = list.locator('[data-kind="thread"]');
	await expect(threads).toHaveCount(2);
	await expect(threads.first()).toContainText("My own question");
	await expect(threads.first()).toContainText("you");
	await expect(threads.nth(1)).toContainText("a.txt:2");
	await expect(row("Waiting on rev2")).toBeVisible();
	await expect(row(/1 check passing/)).toHaveAttribute("data-kind", "summary");
	await shot(page, "verdict-tab", isMobile);
	await threads.nth(1).getByRole("link").click();
	const card = page
		.getByRole("region", { name: "Human reviews" })
		.getByTestId("thread")
		.filter({ hasText: "a.txt" });
	await expect(card).toBeFocused();
	await expect(card).toBeInViewport();
});

test("approve with no message: You approved, and the Overview's reviewer list shows it", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await setup(pr);
	const s = await startCrb();
	await page.goto(`${s.url}verdict`);
	const card = tabCard(page);
	await expect(verdictButton(card, "Approve")).toHaveAccessibleDescription(
		"Allow merging after remaining comments are resolved",
	);
	await expect(verdictButton(card, "Comment")).toHaveAccessibleDescription(
		"No approval, but approval by someone else acceptable",
	);
	await expect(
		verdictButton(card, "Request changes"),
	).toHaveAccessibleDescription("Disallow merging without another review");
	for (const name of ["Approve", "Comment", "Request changes"]) {
		const box = await verdictButton(card, name).boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
	}
	await verdictButton(card, "Approve").click();
	await expect(card.getByTestId("your-verdict")).toContainText("You approved");
	await expect
		.poll(() => submitted(p).map((r) => r.state))
		.toEqual(["APPROVED"]);
	// No message: no body sent.
	expect(submitted(p)[0]?.body ?? "").toBe("");
	await page.getByRole("link", { name: "Overview" }).click();
	await expect(
		page
			.getByRole("region", { name: "Who's on it" })
			.getByRole("img", { name: "Approved" }),
	).toBeVisible();
});

test("comment with a message; request changes with the box off opens and focuses it first", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await setup(pr);
	const s = await startCrb();
	await page.goto(`${s.url}verdict`);
	const card = tabCard(page);
	await card.getByRole("checkbox", { name: "Include a message" }).check();
	await card.getByRole("textbox", { name: "Message" }).fill("Reads well");
	await verdictButton(card, "Comment").click();
	await expect(card.getByTestId("your-verdict")).toContainText("You commented");
	await expect
		.poll(() => submitted(p).at(-1)?.body ?? "")
		.toContain("Reads well");
	// The box is closed again: Request changes ticks and focuses it, sends nothing.
	await expect(card.getByRole("textbox", { name: "Message" })).toHaveCount(0);
	await verdictButton(card, "Request changes").click();
	const box = card.getByRole("textbox", { name: "Message" });
	await expect(box).toBeFocused();
	await expect(
		card.getByRole("checkbox", { name: "Include a message" }),
	).toBeChecked();
	expect(submitted(p)).toHaveLength(1);
	await page.keyboard.type("Please add tests");
	// By keyboard: the message, then the buttons.
	await page.keyboard.press("Tab");
	await expect(verdictButton(card, "Approve")).toBeFocused();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	await expect(verdictButton(card, "Request changes")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(card.getByTestId("your-verdict")).toContainText(
		"You requested changes",
	);
	await expect
		.poll(() => submitted(p).map((r) => r.state))
		.toEqual(["COMMENTED", "CHANGES_REQUESTED"]);
	expect(submitted(p).at(-1)?.body).toContain("Please add tests");
});

test("a verdict on its way shows at once, holds the buttons, and posts once for a double press", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await setup(pr, { hold: ["verdict"] });
	const s = await startCrb();
	await page.goto(`${s.url}verdict`);
	const card = tabCard(page);
	await verdictButton(card, "Approve").dblclick();
	await expect(card.getByTestId("your-verdict")).toContainText(
		"You approved just now",
	);
	await expect(
		card.getByTestId("your-verdict").getByRole("img", { name: "Sending" }),
	).toBeVisible();
	for (const name of ["Approve", "Comment", "Request changes"]) {
		await expect(verdictButton(card, name)).toHaveAttribute(
			"aria-disabled",
			"true",
		);
	}
	await verdictButton(card, "Request changes").click({ force: true });
	release(p.scenarioPath, "verdict");
	await expect(
		card.getByTestId("your-verdict").getByRole("img", { name: "Sending" }),
	).toHaveCount(0);
	await expect(card.getByTestId("your-verdict")).toContainText("You approved");
	expect(submitted(p).map((r) => r.state)).toEqual(["APPROVED"]);
});

test("a refused verdict: listed under the chip, Retry lands it; a second one is dropped", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/403/);
	const p = await setup(pr, {
		failNext: { op: "verdict", status: 403, message: "Not allowed here" },
	});
	const s = await startCrb();
	await page.goto(`${s.url}verdict`);
	const card = tabCard(page);
	await verdictButton(card, "Approve").click();
	await expect(chip(page)).toHaveAccessibleName("1 not posted");
	await expect(item(page)).toContainText("Verdict · Approve");
	await expect(item(page)).toContainText("Not allowed here");
	expect(submitted(p)).toEqual([]);
	await item(page).getByRole("button", { name: "Retry verdict" }).click();
	await expect(chip(page)).toHaveCount(0);
	await expect
		.poll(() => submitted(p).map((r) => r.state))
		.toEqual(["APPROVED"]);
	// A second one, refused, with a message: Drop asks, then it and its message go.
	p.editScenario((sc) => {
		sc.failNext = { op: "verdict", status: 403, message: "Not allowed here" };
	});
	await card.getByRole("checkbox", { name: "Include a message" }).check();
	await card.getByRole("textbox", { name: "Message" }).fill("Second thoughts");
	await verdictButton(card, "Comment").click();
	await expect(item(page)).toContainText("Verdict · Comment");
	await expect(item(page)).toContainText("Second thoughts");
	await expect(card.getByRole("textbox", { name: "Message" })).toHaveValue(
		"Second thoughts",
	);
	await item(page).getByRole("button", { name: "Drop verdict" }).click();
	await page
		.getByRole("alertdialog", { name: "Drop this? Its text is lost" })
		.getByRole("button", { name: "Drop" })
		.click();
	await expect(chip(page)).toHaveCount(0);
	// Its message is gone with it.
	await expect(card.getByRole("textbox", { name: "Message" })).toHaveValue("");
	expect(submitted(p)).toHaveLength(1);
});

test("a pending review on GitHub refuses the verdict with the pending-review notice", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/409/);
	await setup(pr, {}, { reviews: [PENDING] });
	const s = await startCrb();
	await page.goto(`${s.url}verdict`);
	const card = tabCard(page);
	// Read up front, as on the Overview.
	await expect(card.getByTestId("pending-review-warning")).toBeVisible();
	await verdictButton(card, "Approve").click();
	await expect(item(page)).toContainText(
		"A pending review on GitHub blocks it",
	);
	await expect(
		item(page).getByRole("link", { name: "Open on GitHub" }),
	).toHaveAttribute("href", /\/pull\/7\/files$/);
});

test("the Files changed end card: the verdict, its blockers' count, clear of the Files button", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	const p = await setup(pr);
	const s = await startCrb();
	await page.goto(`${s.url}files`);
	const card = filesCard(page);
	await card.scrollIntoViewIfNeeded();
	await expect(card.getByTestId("verdict-blockers-link")).toHaveText(
		/Blockers: \d+/,
	);
	if (isMobile) {
		// Scrolled to the very end, the floating Files button covers none of it.
		await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
		const files = page.getByRole("button", { name: "Files", exact: true });
		const a = await files.boundingBox();
		const b = await verdictButton(card, "Request changes").boundingBox();
		if (a && b) {
			const overlap =
				a.x < b.x + b.width &&
				b.x < a.x + a.width &&
				a.y < b.y + b.height &&
				b.y < a.y + a.height;
			expect(overlap).toBe(false);
		}
	}
	await shot(page, "verdict-files-end", isMobile);
	await verdictButton(card, "Approve").click();
	await expect(card.getByTestId("your-verdict")).toContainText("You approved");
	await expect
		.poll(() => submitted(p).map((r) => r.state))
		.toEqual(["APPROVED"]);
	await card.getByTestId("verdict-blockers-link").click();
	await expect(page.getByTestId("github-status")).toBeVisible();
});

test("the three tabs, Refresh and the title fit at 360px with no horizontal scroll", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "phone layout");
	await setup(pr);
	const s = await startCrb();
	await page.setViewportSize({ width: 360, height: 740 });
	await page.goto(`${s.url}verdict`);
	await expect(page.getByTestId("github-status")).toBeVisible();
	const nav = page.getByRole("navigation", { name: "PR pages" });
	await expect(nav.getByRole("link", { name: "Files changed" })).toHaveText(
		"Files",
		{ useInnerText: true },
	);
	await expect(nav.getByRole("link", { name: "Final Verdict" })).toHaveText(
		"Verdict",
		{ useInnerText: true },
	);
	// Scrolled until the header sticks, the title's pill shows beside them.
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	await expect(page.getByTestId("compact-title")).not.toHaveAttribute("inert");
	const row = await page.getByTestId("app-header-row").boundingBox();
	for (const el of [
		nav.getByRole("link", { name: "Overview" }),
		nav.getByRole("link", { name: "Files changed" }),
		nav.getByRole("link", { name: "Final Verdict" }),
		page.getByRole("button", { name: "Refresh" }),
	]) {
		const box = await el.boundingBox();
		expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
			(row?.x ?? 0) + (row?.width ?? 360) + 0.5,
		);
	}
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - window.innerWidth,
		),
	).toBeLessThanOrEqual(0);
	// The three verdict buttons share one row.
	const card = tabCard(page);
	const tops = await Promise.all(
		["Approve", "Comment", "Request changes"].map(async (n) =>
			Math.round((await verdictButton(card, n).boundingBox())?.y ?? -1),
		),
	);
	expect(new Set(tops).size).toBe(1);
	await expect(verdictButton(card, "Request changes")).toHaveText("Changes", {
		useInnerText: true,
	});
});
