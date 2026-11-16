import type { Locator, Page } from "@playwright/test";
import { release, reviewThread, threadComment } from "../test/fake-gh/scenario";
import { fixture as agentFixture, ask, CALC, openFile, test } from "./agent-ui";
import { expectNoPageOverflow, fileSection, openFiles } from "./files-ui";
import {
	expect,
	expectLoadingThen,
	installClock,
	type PrOptions,
} from "./fixtures";

/**
 * The tree's Threads tab (owner, 2026-11-15): every conversation on the
 * PR in two regions, People (GitHub's review threads) and AI (the
 * reviewer's agent threads), newest activity first, resolved ones hidden
 * until Show resolved; a row goes to its thread. Desktop and phone (the
 * tree's sheet).
 */

const lines = (name: string) =>
	Array.from({ length: 8 }, (_, i) => `${name} ${i + 1}`);
const text = (l: string[]) => `${l.join("\n")}\n`;
const A = "a.ts";
const B = "src/deep/b.ts";

const fixture: PrOptions = {
	base: { [A]: text(lines("a")), [B]: text(lines("b")) },
	files: [
		{
			message: "change both",
			files: {
				[A]: text(
					lines("a").map((l, i) => (i === 1 || i === 4 ? `${l} changed` : l)),
				),
				[B]: text(lines("b").map((l, i) => (i === 2 ? `${l} changed` : l))),
			},
		},
	],
};

const narrow = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;

/** The tree's sidebar: the column on desktop, the sheet behind the Files button on a phone. */
async function sidebar(page: Page): Promise<Locator> {
	if (narrow(page)) {
		await page.getByRole("button", { name: "Files", exact: true }).click();
		const sheet = page.getByRole("dialog", { name: "Files" });
		await expect(sheet).toBeVisible();
		return sheet;
	}
	return page.locator("body");
}

const tabs = (scope: Locator) =>
	scope.getByRole("tablist", { name: "Sidebar" });
const region = (scope: Locator, name: string) =>
	scope.getByRole("region", { name, exact: true });
const rowNames = (r: Locator) => r.getByTestId("threads-row-name");

/**
 * The card is in view and its top below the sticky stack over it (the
 * Files bar, and its file's header when that is stuck), not under it.
 */
async function expectShown(card: Locator) {
	await expect(card).toBeInViewport();
	await expect
		.poll(() =>
			card.evaluate((el) => {
				const top = el.getBoundingClientRect().top;
				const bar = document.querySelector("[data-page-bar]");
				const header = el
					.closest("section[data-path]")
					?.querySelector(":scope > header");
				const stuck =
					header && getComputedStyle(header).position === "sticky"
						? header.getBoundingClientRect().bottom
						: 0;
				const stack = Math.max(bar?.getBoundingClientRect().bottom ?? 0, stuck);
				return top - stack;
			}),
		)
		.toBeGreaterThanOrEqual(-1);
}

test.describe("on GitHub's threads", () => {
	test("Threads tab: loads with a spinner, lists newest first, shows resolved on the toggle, folds, survives a reload, and a row jumps to its thread", async ({
		page,
		pr,
		startCrb,
	}) => {
		const p = await pr(fixture);
		const head = p.head();
		const on = { commit: head, diffHunk: "" };
		p.editScenario((s) => {
			const graph = s.prs[p.number]?.graphql;
			if (!graph) throw new Error("no PR in the scenario");
			graph.reviewThreads = [
				reviewThread({ path: A, line: 2, subjectType: "LINE" }, [
					threadComment({
						login: "rev2",
						text: "Older one",
						createdAt: "2026-01-04T10:00:00Z",
						...on,
					}),
				]),
				reviewThread({ path: B, line: 3, subjectType: "LINE" }, [
					threadComment({
						login: "rev1",
						text: "Why?",
						createdAt: "2026-01-04T09:00:00Z",
						...on,
					}),
					threadComment({
						login: "octo-author",
						text: "Because",
						createdAt: "2026-01-04T12:00:00Z",
					}),
				]),
				reviewThread(
					{ path: A, line: 5, subjectType: "LINE", isResolved: true },
					[
						threadComment({
							login: "rev1",
							text: "Done already",
							createdAt: "2026-01-04T13:00:00Z",
							...on,
						}),
					],
				),
			];
			s.hold = ["threads"];
		});
		const s = await startCrb();
		// The page's clock: a landing's highlight lasts until the test moves it.
		await installClock(page);
		await openFiles(page, s.url);
		let side = await sidebar(page);
		await tabs(side)
			.getByRole("tab", { name: /^Threads/ })
			.click();
		await expect(
			tabs(side).getByRole("tab", { name: /^Threads/ }),
		).toHaveAttribute("aria-selected", "true");
		const people = region(side, "People");
		// While GitHub's threads are held: a spinner, never 0 or no rows.
		await expectLoadingThen({
			loading: people.getByRole("status", { name: "Loading People" }),
			empty: [
				people.getByTestId("threads-count"),
				people.getByTestId("threads-row"),
			],
			release: async () => {
				await expect(people).toHaveAttribute("aria-busy", "true");
				await expect(
					tabs(side).getByRole("tab", { name: "Threads, loading" }),
				).toBeVisible();
				release(p.scenarioPath, "threads");
			},
			result: people.getByTestId("threads-row"),
		});
		// Newest activity first; the resolved one hidden.
		await expect(rowNames(people)).toHaveText(["b.ts:3", "a.ts:2"]);
		await expect(people.getByTestId("threads-count")).toHaveText("2");
		await expect(
			people.getByRole("button", {
				name: "src/deep/b.ts:3, last by octo-author",
			}),
		).toBeVisible();
		// Beneath it, what it's about: its first comment's start.
		await expect(
			people
				.getByTestId("threads-row")
				.first()
				.getByTestId("threads-row-blurb"),
		).toHaveText("Why?");
		await expect(region(side, "AI").getByTestId("threads-count")).toHaveText(
			"0",
		);
		await expect(
			tabs(side).getByRole("tab", { name: "Threads, 2 open" }),
		).toBeVisible();
		// A row is a 40px target on touch, one line on desktop.
		const box = await people.getByTestId("threads-row").first().boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(narrow(page) ? 40 : 18);
		await expectNoPageOverflow(page);

		// Show resolved: listed too, in its place by activity, muted.
		const toggle = side.getByRole("button", { name: "Show resolved" });
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		await expect(rowNames(people)).toHaveText(["a.ts:5", "b.ts:3", "a.ts:2"]);
		await expect(people.getByTestId("threads-row").first()).toHaveAttribute(
			"data-resolved",
			"true",
		);
		await expect(people.getByTestId("threads-count")).toHaveText("3");
		await toggle.click();
		await expect(rowNames(people)).toHaveText(["b.ts:3", "a.ts:2"]);

		// Fold People: its rows go, its count stays.
		const header = people.getByRole("button", { name: "People, 2" });
		await header.click();
		await expect(header).toHaveAttribute("aria-expanded", "false");
		await expect(people.getByTestId("threads-row")).toHaveCount(0);
		await expect(people.getByTestId("threads-count")).toHaveText("2");

		// A reload keeps the tab and the fold.
		await page.reload();
		side = await sidebar(page);
		await expect(
			tabs(side).getByRole("tab", { name: /^Threads/ }),
		).toHaveAttribute("aria-selected", "true");
		const again = region(side, "People");
		await expect(
			again.getByRole("button", { name: "People, 2" }),
		).toHaveAttribute("aria-expanded", "false");
		await again.getByRole("button", { name: "People, 2" }).click();

		// A row goes to its thread: the file opens, the line lands (the
		// sheet closes on a phone).
		const jump = again.getByRole("button", { name: /^src\/deep\/b\.ts:3/ });
		if (narrow(page)) {
			// On touch a tap on the row's date goes to the thread too (no
			// tooltip in the way).
			const date = again
				.getByTestId("threads-row")
				.filter({
					has: page.getByRole("button", { name: /^src\/deep\/b\.ts:3/ }),
				})
				.locator("time");
			const at = await date.boundingBox();
			if (!at) throw new Error("no date on the row");
			await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
		} else await jump.click();
		if (narrow(page)) {
			await expect(page.getByRole("dialog", { name: "Files" })).toBeHidden();
		}
		// Its card opens and is in view.
		const section = fileSection(page, B);
		const card = section
			.getByTestId("files-thread")
			.filter({ hasText: "Because" });
		await expectShown(card);
		await expect(
			section
				.locator('tr[data-testid="diff-line"][data-new-no="3"]')
				.getByRole("button", { name: /^2 comments on line 3/ }),
		).toHaveAttribute("aria-expanded", "true");
	});
});

test.describe("every kind of thread opens, in view", () => {
	const C = "c.ts";
	const KEEP = "keep.ts";
	const cLines = Array.from({ length: 40 }, (_, i) => `c ${i + 1}`);
	const kinds: PrOptions = {
		base: { [C]: text(cLines), [KEEP]: "keep\n" },
		files: [
			{
				message: "ends of c",
				files: {
					[C]: text(
						cLines.map((l, i) => (i === 1 || i === 37 ? `${l} changed` : l)),
					),
				},
			},
		],
	};

	/** Picks a People row by its name, from the sidebar (the sheet on a phone). */
	async function jump(page: Page, name: RegExp) {
		const side = await sidebar(page);
		const tab = tabs(side).getByRole("tab", { name: /^Threads/ });
		if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
		await region(side, "People").getByRole("button", { name }).click();
		if (narrow(page)) {
			await expect(page.getByRole("dialog", { name: "Files" })).toBeHidden();
		}
	}

	test("a thread in hidden lines, a file comment, a line past the end, one outside the comparison; the same row twice", async ({
		page,
		pr,
		startCrb,
	}) => {
		const p = await pr(kinds);
		const on = { commit: p.head(), diffHunk: "" };
		const said = (login: string, words: string, minute: number) =>
			threadComment({
				login,
				text: words,
				createdAt: `2026-01-04T10:${String(minute).padStart(2, "0")}:00Z`,
				...on,
			});
		p.editScenario((sc) => {
			const graph = sc.prs[p.number]?.graphql;
			if (!graph) throw new Error("no PR in the scenario");
			graph.reviewThreads = [
				reviewThread({ path: C, line: 20, subjectType: "LINE" }, [
					said("gapper", "Gap note", 1),
				]),
				reviewThread({ path: C, line: null, subjectType: "FILE" }, [
					said("filer", "File note", 2),
				]),
				reviewThread({ path: C, line: 500, subjectType: "LINE" }, [
					said("ender", "Past the end", 3),
				]),
				reviewThread({ path: KEEP, line: 1, subjectType: "LINE" }, [
					said("outsider", "Outside note", 4),
				]),
			];
		});
		const s = await startCrb();
		await installClock(page);
		await openFiles(page, s.url);
		const section = fileSection(page, C);
		const card = (words: string) =>
			page.getByTestId("files-thread").filter({ hasText: words });

		// In hidden lines: its run's bubble opens, the lines stay hidden,
		// no "isn't in this diff".
		await jump(page, /last by gapper/);
		await expectShown(card("Gap note"));
		await expect(section.getByTestId("landing-hint")).toHaveCount(0);

		// The same row again, scrolled away: in view again, still open.
		await page.evaluate(() => window.scrollTo(0, 0));
		await jump(page, /last by gapper/);
		await expectShown(card("Gap note"));
		await expect(
			section.getByRole("button", { name: /^1 comment on hidden line/ }),
		).toHaveAttribute("aria-expanded", "true");

		// A file comment: the file bubble's card.
		await jump(page, /last by filer/);
		await expectShown(card("File note"));

		// A line the tracer can't place in the file: its card under the
		// file's header, with its fate.
		await jump(page, /last by ender/);
		await expectShown(
			section
				.getByTestId("unplaced-thread")
				.filter({ hasText: "Past the end" }),
		);

		// Its file not in the comparison: its card after the files.
		await jump(page, /last by outsider/);
		await expectShown(
			page.getByTestId("unplaced-thread").filter({ hasText: "Outside note" }),
		);
	});
});

test.describe("on the reviewer's agent threads", () => {
	// Its own crb serve: the agent's config and its fake ACP env.
	test.use({ crbServer: "own" });

	test("an agent conversation is listed under AI, the agent last, and its row jumps to it", async ({
		page,
		pr,
		agentCrb,
	}) => {
		await pr(agentFixture);
		const s = await agentCrb();
		await installClock(page);
		const section = await openFile(page, s.url, CALC);
		const card = await ask(page, section, 3, "Why?");
		await expect(card).toHaveAttribute("aria-label", "Agent thread, answered");
		const side = await sidebar(page);
		await tabs(side)
			.getByRole("tab", { name: /^Threads/ })
			.click();
		const ai = region(side, "AI");
		await expect(ai.getByTestId("threads-count")).toHaveText("1");
		const row = ai.getByRole("button", {
			name: /^src\/calc\.ts:3, last by the agent/,
		});
		await expect(row).toBeVisible();
		await expect(row.locator('[data-speaker="ai"]')).toBeVisible();
		await expect(
			region(side, "People").getByTestId("threads-count"),
		).toHaveText("0");
		await expect(
			tabs(side).getByRole("tab", { name: "Threads, 1 open" }),
		).toBeVisible();
		// Its blurb: the question asked.
		await expect(ai.getByTestId("threads-row-blurb")).toHaveText("Why?");
		// Its card closed (its bubble), then the row: it opens, in view.
		if (narrow(page)) {
			await page
				.getByRole("dialog", { name: "Files" })
				.getByRole("button", { name: "Close" })
				.click();
		}
		const bubble = section
			.locator('tr[data-testid="diff-line"][data-new-no="3"]')
			.getByTestId("agent-bubble");
		await bubble.click();
		await expect(card).toHaveCount(0);
		await page.evaluate(() => window.scrollTo(0, 0));
		const again = await sidebar(page);
		await region(again, "AI")
			.getByRole("button", { name: /^src\/calc\.ts:3, last by the agent/ })
			.click();
		await expectShown(card);
		await expect(bubble).toHaveAttribute("aria-expanded", "true");
	});
	test("an agent conversation on a GitHub thread opens that thread with the conversation, in view", async ({
		page,
		pr,
		agentCrb,
	}) => {
		const p = await pr(agentFixture);
		p.editScenario((sc) => {
			const graph = sc.prs[p.number]?.graphql;
			if (!graph) throw new Error("no PR in the scenario");
			graph.reviewThreads = [
				reviewThread({ path: CALC, line: 3, subjectType: "LINE" }, [
					threadComment({
						login: "rev1",
						text: "Is total right?",
						createdAt: "2026-01-02T09:00:00Z",
						commit: p.head(),
						diffHunk:
							"@@ -1,3 +1,3 @@\n export const v1 = 1;\n export const v2 = 2;\n-export const v3 = 3;\n+export const total = v1 + v2;",
					}),
				]),
			];
		});
		const s = await agentCrb();
		await installClock(page);
		const section = await openFile(page, s.url, CALC);
		const bubble = section
			.locator('tr[data-testid="diff-line"][data-new-no="3"]')
			.getByRole("button", { name: /^1 comment on line 3/ });
		await bubble.click();
		const thread = section.getByTestId("files-thread");
		await thread.getByTestId("thread-agent-button").click();
		const panel = thread.getByTestId("thread-agent-panel");
		await expect(panel).toHaveAttribute("data-open", "true");
		await thread.getByRole("textbox", { name: "Ask agent" }).fill("Sure?");
		await thread.getByRole("button", { name: "Send to agent" }).click();
		await expect(panel.getByTestId("agent-message-ai")).toHaveText("ok");
		// Both closed: the conversation, then the thread.
		await thread.getByTestId("thread-agent-button").click();
		await expect(panel).toHaveAttribute("data-open", "false");
		await bubble.click();
		await expect(thread).toHaveCount(0);
		await page.evaluate(() => window.scrollTo(0, 0));

		const side = await sidebar(page);
		await tabs(side)
			.getByRole("tab", { name: /^Threads/ })
			.click();
		const ai = region(side, "AI");
		await expect(ai.getByTestId("threads-row-blurb")).toHaveText("Sure?");
		await ai.getByRole("button", { name: /^src\/calc\.ts:3/ }).click();
		await expectShown(thread);
		await expect(panel).toHaveAttribute("data-open", "true");
	});
});
