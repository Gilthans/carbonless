import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import {
	reviewThread,
	type Scenario,
	threadComment,
} from "../test/fake-gh/scenario";
import { fileSection, openFiles } from "./files-ui";
import { expect, type Pr, type PrOptions, test } from "./fixtures";

/**
 * Replying and resolving, written to the fake gh (its writes persist in the
 * scenario file, so a reload reads them back). The viewer is Octo_Cat.
 * Two open threads on new.txt (line 1) and a.txt (line 2), by rev1, no
 * replies yet.
 */
const base = "2026-01-01T00:00:00Z";
const fixture: PrOptions = {
	baseDate: base,
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
};

async function setup(
	pr: (opts?: PrOptions) => Promise<Pr>,
	scenario: Partial<Scenario> = {},
	reviews: unknown[] = [],
) {
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
			reviewThread({ path: "a.txt", line: 2, subjectType: "LINE" }, [
				threadComment({
					login: "rev1",
					text: "Changed how?",
					createdAt: "2026-01-02T08:00:00Z",
					commit: head,
					diffHunk: "@@ -1,2 +1,2 @@\n line 1\n-line 2\n+line 2 changed",
				}),
			]),
		];
		graph.reviews = reviews;
		Object.assign(s, scenario);
	});
	return p;
}

/** Replies to the thread in the fake gh's store, by text. */
function storedReplies(p: Pr, text: string): number {
	const s = JSON.parse(readFileSync(p.scenarioPath, "utf8")) as Scenario;
	const threads = (s.prs[7]?.graphql?.reviewThreads ?? []) as {
		comments: { nodes: { body?: string; bodyText?: string }[] };
	}[];
	return threads
		.flatMap((t) => t.comments.nodes)
		.filter((c) => (c.body ?? c.bodyText) === text).length;
}

const humans = (page: Page) =>
	page.getByRole("region", { name: "Human reviews" });
const card = (page: Page, path: string) =>
	humans(page).getByTestId("thread").filter({ hasText: path });

/** Opens a card's reply box (its "Reply" toggle when it has no replies). */
async function openReply(c: Locator) {
	const box = c.getByRole("textbox", { name: "Reply" });
	if (!(await box.isVisible())) {
		await c
			.getByRole("button", { name: /^Reply$|repl(y|ies)/ })
			.first()
			.click();
	}
	await expect(box).toBeVisible();
	return box;
}

/** a.txt's new line 2, where its thread is. */
const line2 = (section: Locator) =>
	section.locator('tr[data-testid="diff-line"][data-new-no="2"]');

const send = (scope: Locator) =>
	scope.getByTestId("reply-box").getByRole("button", { name: "Reply" });

test("reply from an Overview card: shown at once, still there after a reload", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	const p = await setup(pr, { replyDelayMs: 800 });
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "new.txt");
	const box = await openReply(c);
	// One line until focused, then it grows.
	const closed = (await box.boundingBox())?.height ?? 0;
	await box.click();
	await box.fill("Kept on purpose");
	expect((await box.boundingBox())?.height ?? 0).toBeGreaterThan(closed);
	expect((await send(c).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
	await box.press("Control+Enter");
	await expect(box).toHaveValue("");
	const sending = c.getByTestId("thread-comment-sending");
	await expect(sending).toContainText("Kept on purpose");
	await expect(sending.getByRole("img", { name: "Sending" })).toBeVisible();
	// GitHub's answer replaces it.
	await expect(sending).toHaveCount(0);
	await expect(
		c.getByTestId("thread-comment").filter({ hasText: "Kept on purpose" }),
	).toHaveCount(1);
	await expect(c.getByRole("img", { name: "2 comments" })).toBeVisible();
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await c.scrollIntoViewIfNeeded();
		await page.screenshot({
			path: `${shots}/thread-reply-${isMobile ? "phone" : "desktop"}.png`,
		});
	}
	await page.reload();
	const again = card(page, "new.txt");
	await expect(again.getByRole("img", { name: "2 comments" })).toBeVisible();
	await again.getByRole("button", { name: "1 reply" }).click();
	await expect(
		again.getByTestId("thread-comment").filter({ hasText: "Kept on purpose" }),
	).toHaveCount(1);
	expect(storedReplies(p, "Kept on purpose")).toBe(1);
});

test("reply and resolve from Files changed", async ({ page, pr, startCrb }) => {
	const p = await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, "a.txt");
	await section.getByRole("button", { name: "Expand file" }).click();
	const bubble = line2(section).getByRole("button", {
		name: /^1 comment on line 2/,
	});
	await bubble.click();
	const thread = section.getByTestId("files-thread");
	const box = thread.getByRole("textbox", { name: "Reply" });
	await box.fill("From the diff");
	await send(thread).click();
	await expect(
		thread.getByTestId("thread-comment").filter({ hasText: "From the diff" }),
	).toHaveCount(1);
	await thread.getByRole("button", { name: "Resolve" }).click();
	await expect(thread).toHaveAttribute("aria-label", /^Resolved thread/);
	await expect(
		section.getByRole("button", {
			name: /^2 comments on line 2, resolved/,
		}),
	).toBeVisible();
	await expect(thread.getByRole("button", { name: "Unresolve" })).toBeVisible();
	await expect.poll(() => storedReplies(p, "From the diff")).toBe(1);
	await page.reload();
	await fileSection(page, "a.txt")
		.getByRole("button", { name: "Expand file" })
		.click();
	await expect(
		line2(fileSection(page, "a.txt")).getByRole("button", {
			name: /^2 comments on line 2, resolved/,
		}),
	).toBeVisible();
	// And back.
	await line2(fileSection(page, "a.txt"))
		.getByRole("button", { name: /^2 comments on line 2/ })
		.click();
	await fileSection(page, "a.txt")
		.getByTestId("files-thread")
		.getByRole("button", { name: "Unresolve" })
		.click();
	await expect(
		line2(fileSection(page, "a.txt")).getByRole("button", {
			name: /^2 comments on line 2, resolved/,
		}),
	).toHaveCount(0);
	await page.reload();
	await fileSection(page, "a.txt")
		.getByRole("button", { name: "Expand file" })
		.click();
	await expect(
		line2(fileSection(page, "a.txt")).getByRole("button", {
			name: /^2 comments on line 2/,
		}),
	).toBeVisible();
	await expect(
		line2(fileSection(page, "a.txt")).getByRole("button", {
			name: /^2 comments on line 2, resolved/,
		}),
	).toHaveCount(0);
});

test("resolve from an Overview card fades, then moves; unresolve brings it back", async ({
	page,
	pr,
	startCrb,
}) => {
	await setup(pr);
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "new.txt");
	await c.getByRole("button", { name: "Resolve" }).click();
	await expect(c).toHaveAttribute("data-fading", "true");
	await expect(c.getByTestId("thread-head")).toContainText("Resolved thread");
	// Still in place, the toggle there to undo; then gone to the other list.
	await expect(c.getByRole("button", { name: "Unresolve" })).toBeVisible();
	await expect(c).toHaveCount(0, { timeout: 8000 });
	const resolved = humans(page).getByRole("button", { name: "1 resolved" });
	await resolved.click();
	const back = card(page, "new.txt");
	await back.getByRole("button", { name: "Unresolve" }).click();
	await expect(back).toHaveAttribute("data-fading", "true");
	await expect(back).toHaveCount(0, { timeout: 8000 });
	await page.reload();
	await expect(
		humans(page).getByRole("button", { name: "0 resolved" }),
	).toBeVisible();
	await expect(card(page, "new.txt")).toBeVisible();
});

test("undo during the fade keeps the card", async ({ page, pr, startCrb }) => {
	await setup(pr);
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "new.txt");
	await c.getByRole("button", { name: "Resolve" }).click();
	await c.getByRole("button", { name: "Unresolve" }).click();
	await expect(c).not.toHaveAttribute("data-fading");
	await page.waitForTimeout(4500);
	await expect(card(page, "new.txt")).toBeVisible();
	await expect(c.getByTestId("thread-head")).toContainText("Unresolved thread");
});

test("a failing reply keeps its text, with Retry", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/403/);
	const p = await setup(pr, { failNext: { op: "reply", status: 403 } });
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "new.txt");
	const box = await openReply(c);
	await box.fill("Try again");
	await send(c).click();
	const notice = page.getByTestId("write-failed");
	await expect(notice).toContainText("Reply · new.txt:1");
	await expect(box).toHaveValue("Try again");
	await notice.getByRole("button", { name: "Retry reply" }).click();
	await expect(notice).toHaveCount(0);
	await expect(box).toHaveValue("");
	await expect(
		c.getByTestId("thread-comment").filter({ hasText: "Try again" }),
	).toHaveCount(1);
	expect(storedReplies(p, "Try again")).toBe(1);
});

test("a pending review shows the warning and refuses replies with the link", async ({
	page,
	pr,
	startCrb,
	isMobile,
	expectConsoleError,
}) => {
	expectConsoleError(/409/);
	const p = await setup(pr, {}, [
		{
			author: { login: "Octo_Cat", __typename: "User" },
			state: "PENDING",
			submittedAt: null,
			createdAt: "2026-01-03T00:00:00Z",
		},
	]);
	const s = await startCrb();
	await page.goto(s.url);
	const who = page.getByRole("region", { name: "Who's on it" });
	const warning = who.getByTestId("pending-review-warning");
	await expect(warning).toContainText("Pending review on GitHub");
	await expect(
		warning.getByRole("link", { name: "Open on GitHub" }),
	).toHaveAttribute("href", "https://github.com/acme/widget/pull/7/files");
	const c = card(page, "new.txt");
	const box = await openReply(c);
	await box.fill("Blocked");
	await send(c).click();
	const notice = page.getByTestId("write-failed");
	await expect(notice).toContainText(
		"A pending review on GitHub blocks replies",
	);
	await expect(
		notice.getByRole("link", { name: "Open on GitHub" }),
	).toHaveAttribute("href", "https://github.com/acme/widget/pull/7/files");
	await expect(box).toHaveValue("Blocked");
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await page.screenshot({
			path: `${shots}/thread-pending-review-${isMobile ? "phone" : "desktop"}.png`,
		});
	}
	expect(storedReplies(p, "Blocked")).toBe(0);
});

test("no reply box or resolve toggle as of a cutoff", async ({
	page,
	pr,
	startCrb,
}) => {
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
	const c = card(page, "new.txt");
	await expect(c).toBeVisible();
	await expect(c.getByRole("button", { name: "Resolve" })).toHaveCount(0);
	await expect(c.getByRole("button", { name: "Reply" })).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "Reply" })).toHaveCount(0);
});

test("a reload with an unconfirmed reply posts it once", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await setup(pr, { replyDelayMs: 2500 });
	const s = await startCrb();
	await page.goto(s.url);
	const asked: string[] = [];
	page.on("dialog", (d) => {
		asked.push(d.type());
		void d.accept();
	});
	const c = card(page, "new.txt");
	const box = await openReply(c);
	await box.fill("Survives a reload");
	await send(c).click();
	await expect(c.getByTestId("thread-comment-sending")).toBeVisible();
	await page.reload();
	// It asked first: the reply wasn't confirmed yet.
	expect(asked).toContain("beforeunload");
	const again = card(page, "new.txt");
	await expect(again.getByRole("img", { name: "2 comments" })).toBeVisible({
		timeout: 10_000,
	});
	await expect.poll(() => storedReplies(p, "Survives a reload")).toBe(1);
	await page.waitForTimeout(3000);
	expect(storedReplies(p, "Survives a reload")).toBe(1);
});

test("the Drafts filter lists a thread with a draft, kept across a reload", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await setup(pr);
	const s = await startCrb();
	await page.goto(s.url);
	const c = card(page, "a.txt");
	const box = await openReply(c);
	await box.fill("Thinking about it");
	await box.press("Escape");
	const chip = humans(page).getByTestId("drafts-filter");
	await expect(chip).toHaveText("1 draft");
	page.once("dialog", (d) => void d.accept());
	await page.reload();
	await humans(page).getByTestId("drafts-filter").click();
	const list = humans(page).getByRole("list", { name: "Threads with a draft" });
	await expect(list.getByTestId("thread")).toHaveCount(1);
	await expect(list.getByRole("textbox", { name: "Reply" })).toHaveValue(
		"Thinking about it",
	);
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await page.screenshot({
			path: `${shots}/thread-drafts-${isMobile ? "phone" : "desktop"}.png`,
		});
	}
	// No horizontal page scroll with a box open.
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});
