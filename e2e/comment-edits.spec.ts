import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import {
	editElsewhere,
	release,
	reviewThread,
	type Scenario,
	threadComment,
} from "../test/fake-gh/scenario";
import { fileSection, openFiles } from "./files-ui";
import { expect, type Pr, type PrOptions, test } from "./fixtures";

/**
 * Editing and deleting the viewer's own comments, written to the fake gh
 * (its writes persist in the scenario file, so a reload reads them back).
 * The viewer is Octo_Cat. Threads:
 * 0. new.txt:1, Octo_Cat's opener alone ("My take");
 * 1. a.txt:2, rev1's opener, then Octo_Cat's reply ("Because reasons");
 * 2. b.txt:1, Octo_Cat's opener ("Opening words"), then rev1's reply.
 */
const fixture: PrOptions = {
	baseDate: "2026-01-01T00:00:00Z",
	files: [
		{
			message: "PR change",
			files: {
				"a.txt": `${Array.from({ length: 30 }, (_, i) =>
					i === 1 ? "line 2 changed" : `line ${i + 1}`,
				).join("\n")}\n`,
				"b.txt": "b\n",
				"new.txt": "new\n",
			},
			date: "2026-01-02T00:00:00Z",
		},
	],
};

async function setup(
	pr: (opts?: PrOptions) => Promise<Pr>,
	scenario: Partial<Scenario> = {},
) {
	const p = await pr(fixture);
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((s) => {
		const graph = s.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: "new.txt", line: 1, subjectType: "LINE" }, [
				threadComment({
					login: "Octo_Cat",
					text: "My take",
					createdAt: "2026-01-02T09:00:00Z",
					commit: head,
					diffHunk: "@@ -0,0 +1 @@\n+new",
				}),
			]),
			reviewThread({ path: "a.txt", line: 2, subjectType: "LINE" }, [
				threadComment({
					login: "rev1",
					text: "Changed how?",
					createdAt: "2026-01-02T08:00:00Z",
					commit: head,
					diffHunk: "@@ -1,2 +1,2 @@\n line 1\n-line 2\n+line 2 changed",
				}),
				threadComment({
					login: "Octo_Cat",
					text: "Because reasons",
					createdAt: "2026-01-02T08:30:00Z",
					commit: head,
				}),
			]),
			reviewThread({ path: "b.txt", line: 1, subjectType: "LINE" }, [
				threadComment({
					login: "Octo_Cat",
					text: "Opening words",
					createdAt: "2026-01-02T07:00:00Z",
					commit: head,
					diffHunk: "@@ -0,0 +1 @@\n+b",
				}),
				threadComment({
					login: "rev1",
					text: "Fair",
					createdAt: "2026-01-02T07:30:00Z",
					commit: head,
				}),
			]),
		];
		Object.assign(s, scenario);
	});
	return p;
}

interface StoredComment {
	body?: string;
	bodyText?: string;
	removed?: boolean;
	lastEditedAt?: string | null;
}

/** The fake gh's comments of thread `i`, as stored (deleted ones flagged). */
function stored(
	p: Pr,
	i: number,
): { removed: boolean; comments: StoredComment[] } {
	const s = JSON.parse(readFileSync(p.scenarioPath, "utf8")) as Scenario;
	const t = (s.prs[7]?.graphql?.reviewThreads ?? [])[i] as {
		removed?: boolean;
		comments: { nodes: StoredComment[] };
	};
	return { removed: t.removed === true, comments: t.comments.nodes };
}

const bodies = (p: Pr, i: number) =>
	stored(p, i)
		.comments.filter((c) => !c.removed)
		.map((c) => c.body ?? c.bodyText);

const humans = (page: Page) =>
	page.getByRole("region", { name: "Human reviews" });
const card = (page: Page, path: string) =>
	humans(page).getByTestId("thread").filter({ hasText: path });

async function openCard(c: Locator) {
	const more = c.getByTestId("thread-more");
	if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
	await expect(more).toHaveAttribute("aria-expanded", "true");
}

/** The confirmation Delete opens. */
const confirmation = (page: Page) =>
	page.getByRole("alertdialog", { name: "Delete this comment?" });

/** Delete, then Delete again in its confirmation. */
async function confirmDelete(page: Page, del: Locator) {
	await del.click();
	await confirmation(page).getByRole("button", { name: "Delete" }).click();
	await expect(confirmation(page)).toHaveCount(0);
}

const overflow = (page: Page) =>
	page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/** Screenshots for the brief, when DESIGN_SHOTS names a folder. */
async function shot(page: Page, name: string, isMobile: boolean, at?: Locator) {
	const dir = process.env.DESIGN_SHOTS;
	if (!dir) return;
	await at?.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: `${dir}/${name}-${isMobile ? "phone" : "desktop"}.png`,
	});
}

test("edit from an Overview card: shown at once, marked edited, still there after a reload", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	// GitHub answers the edit only once the test has seen it saving.
	const p = await setup(pr, { hold: ["edit"] });
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "new.txt");
	// Closed: no Edit (it's inside Show more).
	await expect(c.getByRole("button", { name: "Edit" })).toHaveCount(0);
	await openCard(c);
	const edit = c.getByRole("button", { name: "Edit" });
	const del = c.getByRole("button", { name: "Delete" });
	await expect(edit).toBeVisible();
	await expect(del).toBeVisible();
	for (const b of [edit, del]) {
		const box = await b.boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
		expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
	}
	expect(await overflow(page)).toBeLessThanOrEqual(0);
	await shot(page, "comment-actions", isMobile, c);
	await edit.click();
	const box = c.getByRole("textbox", { name: "Edit comment" });
	await expect(box).toHaveValue("My take");
	await expect(box).toBeFocused();
	await box.fill("My better take");
	expect(await overflow(page)).toBeLessThanOrEqual(0);
	await shot(page, "edit-form", isMobile, c);
	await box.press("Control+Enter");
	await expect(box).toHaveCount(0);
	await expect(c.getByTestId("thread-body")).toContainText("My better take");
	await expect(c.getByRole("img", { name: "Saving" })).toBeVisible();
	release(p.scenarioPath, "edit");
	await expect(c.getByRole("img", { name: "Saving" })).toHaveCount(0);
	await expect(c.getByTestId("comment-edited")).toBeVisible();
	await expect.poll(() => bodies(p, 0)).toEqual(["My better take"]);
	await page.reload();
	const again = card(page, "new.txt");
	await expect(again.getByTestId("thread-body")).toContainText(
		"My better take",
	);
	await expect(again.getByTestId("comment-edited")).toBeVisible();
	await again.getByTestId("comment-edited").focus();
	await expect(page.getByRole("tooltip")).toContainText(/^Edited 20\d\d/);
});

test("an edit in progress survives a reload, opens its card and is listed in Drafts", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await setup(pr);
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "new.txt");
	await openCard(c);
	await c.getByRole("button", { name: "Edit" }).click();
	await c.getByRole("textbox", { name: "Edit comment" }).fill("Half rewritten");
	// Kept, it loses nothing: the reload doesn't ask.
	const asked: string[] = [];
	page.on("dialog", (d) => {
		asked.push(d.type());
		void d.accept();
	});
	await page.reload();
	expect(asked).toEqual([]);
	const again = card(page, "new.txt");
	// The reloaded page reads the overview, the threads and the card's
	// comments before the box can open: several requests, which a loaded
	// machine stretches past the 5 s default.
	await expect(
		again.getByRole("textbox", { name: "Edit comment" }),
	).toHaveValue("Half rewritten", { timeout: 20_000 });
	await expect(humans(page).getByTestId("drafts-filter")).toHaveText("1 draft");
	// Nothing reached GitHub.
	expect(bodies(p, 0)).toEqual(["My take"]);
	await again.getByRole("button", { name: "Save" }).click();
	await expect.poll(() => bodies(p, 0)).toEqual(["Half rewritten"]);
	await expect(humans(page).getByTestId("drafts-filter")).toHaveCount(0);
});

test("a reload in a delete's undo window asks first, and a dismissed ask stays", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await setup(pr);
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "new.txt");
	await openCard(c);
	await confirmDelete(page, c.getByRole("button", { name: "Delete" }));
	await expect(c.getByTestId("comment-deleted-row")).toBeVisible();
	// Nothing is sent yet and nothing resends it: leaving would lose it.
	const asked: string[] = [];
	page.once("dialog", (d) => {
		asked.push(d.type());
		void d.dismiss();
	});
	await page.reload({ timeout: 2000 }).catch(() => {});
	expect(asked).toEqual(["beforeunload"]);
	await expect(c.getByTestId("comment-deleted-row")).toBeVisible();
	await expect.poll(() => stored(p, 0).removed, { timeout: 10_000 }).toBe(true);
});

test("delete from an Overview card: Undo sends nothing; then the card fades and leaves", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	// It waits out the 5 s undo window twice, then the fade: past the
	// default 30 s on a loaded machine.
	test.slow();
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	const p = await setup(pr);
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "new.txt");
	await openCard(c);
	const del = c.getByRole("button", { name: "Delete" });
	// It asks first: Cancel (focused) keeps the comment, nothing sent.
	await del.click();
	const ask = confirmation(page);
	await expect(ask).toBeVisible();
	const cancel = ask.getByRole("button", { name: "Cancel" });
	await expect(cancel).toBeFocused();
	const askBox = await ask.boundingBox();
	const width = page.viewportSize()?.width ?? 0;
	expect(askBox?.x ?? -1).toBeGreaterThanOrEqual(0);
	expect((askBox?.x ?? 0) + (askBox?.width ?? 0)).toBeLessThanOrEqual(width);
	for (const b of [cancel, ask.getByRole("button", { name: "Delete" })]) {
		expect((await b.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
	}
	expect(await overflow(page)).toBeLessThanOrEqual(0);
	await shot(page, "delete-confirm", isMobile, c);
	await cancel.click();
	await expect(ask).toHaveCount(0);
	await expect(del).toBeFocused();
	await expect(c.getByTestId("thread-body")).toContainText("My take");
	// Escape cancels too.
	await del.click();
	await expect(ask).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(ask).toHaveCount(0);
	await expect(del).toBeFocused();
	await expect(c.getByTestId("comment-deleted-row")).toHaveCount(0);
	// Confirmed: Deleted · Undo.
	await confirmDelete(page, del);
	const row = c.getByTestId("comment-deleted-row");
	await expect(row).toContainText("Deleted");
	await expect(c.getByText("My take")).toHaveCount(0);
	expect(await overflow(page)).toBeLessThanOrEqual(0);
	await shot(page, "deleted-undo", isMobile, c);
	await row.getByRole("button", { name: "Undo" }).click();
	await expect(c.getByTestId("thread-body")).toContainText("My take");
	await page.waitForTimeout(5500);
	expect(stored(p, 0).removed).toBe(false);
	await confirmDelete(page, c.getByRole("button", { name: "Delete" }));
	await expect(c).toHaveAttribute("data-fading", "true", { timeout: 10_000 });
	await expect(c).toHaveCount(0, { timeout: 10_000 });
	expect(stored(p, 0).removed).toBe(true);
	await page.reload();
	await expect(humans(page).getByTestId("thread")).toHaveCount(2);
});

test("leaving the page with the delete confirmation open leaves the other page usable", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	await page.getByRole("link", { name: "Overview" }).click();
	const c = card(page, "new.txt");
	await openCard(c);
	await c.getByRole("button", { name: "Delete" }).click();
	await expect(confirmation(page)).toBeVisible();
	// Back to Files changed (the Overview stays mounted, hidden).
	await page.goBack();
	await expect(page).toHaveURL(/\/files/);
	// Nothing modal is left: Files changed takes clicks and Tab.
	await expect(page.locator("dialog[open]")).toHaveCount(0);
	// (A dialog left modal would block the click until the test times out.)
	await page.getByRole("link", { name: "Overview" }).click();
	await expect(page).not.toHaveURL(/\/files/);
	await expect(c.getByTestId("thread-body")).toContainText("My take");
	expect(stored(p, 0).removed).toBe(false);
});

test("deleting an opener with replies leaves [deleted] as a normal comment, which Edit writes back", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	const p = await setup(pr);
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "b.txt");
	await openCard(c);
	// The opener's Delete (rev1's reply has none).
	await expect(c.getByRole("button", { name: "Delete" })).toHaveCount(1);
	await c.getByRole("button", { name: "Delete" }).click();
	await expect(confirmation(page)).toHaveAccessibleDescription(
		"It stays as [deleted] in the thread.",
	);
	await confirmation(page).getByRole("button", { name: "Delete" }).click();
	await expect(c.getByTestId("thread-body")).toHaveText("[deleted]", {
		timeout: 10_000,
	});
	await expect.poll(() => bodies(p, 2)).toEqual(["[deleted]", "Fair"]);
	await page.reload();
	const again = card(page, "b.txt");
	await expect(again.getByTestId("thread-body")).toHaveText("[deleted]");
	await openCard(again);
	await expect(again.getByText("Fair")).toBeVisible();
	// Replies follow it: nothing more for Delete to do; Edit writes it back.
	await expect(again.getByRole("button", { name: "Delete" })).toHaveCount(0);
	expect(await overflow(page)).toBeLessThanOrEqual(0);
	await shot(page, "deleted-opener", isMobile, again);
	await again.getByRole("button", { name: "Edit" }).click();
	const box = again.getByRole("textbox", { name: "Edit comment" });
	await expect(box).toHaveValue("[deleted]");
	await box.fill("Opening words, back");
	await again.getByRole("button", { name: "Save" }).click();
	await expect(again.getByTestId("thread-body")).toContainText(
		"Opening words, back",
	);
	await expect(again.getByRole("img", { name: "Saving" })).toHaveCount(0);
	await expect
		.poll(() => bodies(p, 2))
		.toEqual(["Opening words, back", "Fair"]);
});

test("edit and delete a reply from Files changed", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, "a.txt");
	await section.getByRole("button", { name: "Expand file" }).click();
	await section
		.locator('tr[data-testid="diff-line"][data-new-no="2"]')
		.getByRole("button", { name: /^2 comments on line 2/ })
		.click();
	const thread = section.getByTestId("files-thread");
	const mine = thread
		.getByTestId("thread-comment")
		.filter({ hasText: "Because reasons" });
	// rev1's opener has neither.
	await expect(thread.getByRole("button", { name: "Edit" })).toHaveCount(1);
	await mine.getByRole("button", { name: "Edit" }).click();
	const box = thread.getByRole("textbox", { name: "Edit comment" });
	await box.fill("Because of the cache");
	await thread.getByRole("button", { name: "Save" }).click();
	const edited = thread
		.getByTestId("thread-comment")
		.filter({ hasText: "Because of the cache" });
	await expect(edited.getByTestId("comment-edited")).toBeVisible();
	await expect
		.poll(() => bodies(p, 1))
		.toEqual(["Changed how?", "Because of the cache"]);
	await confirmDelete(page, edited.getByRole("button", { name: "Delete" }));
	await expect(thread.getByTestId("comment-deleted-row")).toBeVisible();
	await expect(thread.getByTestId("thread-comment")).toHaveCount(1, {
		timeout: 10_000,
	});
	await expect.poll(() => bodies(p, 1)).toEqual(["Changed how?"]);
	await expect(
		section.getByRole("button", { name: /^1 comment on line 2/ }),
	).toBeVisible();
});

test("changed on GitHub meanwhile: refused with the draft kept, then Save anyway", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/409/);
	const p = await setup(pr);
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "new.txt");
	await openCard(c);
	await c.getByRole("button", { name: "Edit" }).click();
	await c.getByRole("textbox", { name: "Edit comment" }).fill("Mine");
	editElsewhere(p.scenarioPath, { pr: 7, thread: 0, comment: 0 }, "Theirs");
	await c.getByRole("button", { name: "Save" }).click();
	const notice = page.getByTestId("write-failed");
	await expect(notice).toContainText("Changed on GitHub since you opened it");
	await expect(c.getByRole("textbox", { name: "Edit comment" })).toHaveValue(
		"Mine",
	);
	expect(bodies(p, 0)).toEqual(["Theirs"]);
	await notice.getByRole("button", { name: "Save anyway" }).click();
	await expect(notice).toHaveCount(0);
	await expect.poll(() => bodies(p, 0)).toEqual(["Mine"]);
	await expect(c.getByTestId("thread-body")).toContainText("Mine");
});

test("no Edit or Delete as of a cutoff", async ({ page, pr, startCrb }) => {
	const p = await setup(pr);
	p.editScenario((sc) => {
		const graph = sc.prs[7]?.graphql;
		if (graph) {
			graph.commits = [
				{
					commit: {
						oid: p.repo.shas.at(-1),
						committedDate: "2026-01-02T00:00:00Z",
					},
				},
			];
		}
		sc.commits = { [p.repo.shas.at(-1) ?? ""]: { contexts: null } };
	});
	const s = await startCrb(undefined, ["--as-of", "2026-01-05T00:00:00Z"]);
	await page.goto(s.url);
	// The viewer's own opener alone: nothing to open to.
	await expect(card(page, "new.txt")).toBeVisible();
	await expect(card(page, "new.txt").getByTestId("thread-more")).toHaveCount(0);
	// With a reply: opened, still nothing to edit or delete.
	const c = card(page, "b.txt");
	await openCard(c);
	await expect(c.getByText("Fair")).toBeVisible();
	await expect(c.getByRole("button", { name: "Edit" })).toHaveCount(0);
	await expect(c.getByRole("button", { name: "Delete" })).toHaveCount(0);
});
