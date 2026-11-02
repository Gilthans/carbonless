import type { Locator, Page } from "@playwright/test";
import {
	release,
	reviewThread,
	type Scenario,
	threadComment,
} from "../test/fake-gh/scenario";
import { fileSection, openFiles, progress, withTree } from "./files-ui";
import {
	expect,
	expectLoadingThen,
	type Pr,
	type PrOptions,
	reviewPage,
	test,
} from "./fixtures";

const core = Array.from({ length: 78 }, (_, i) => `core ${i + 1}`);
const util = Array.from({ length: 10 }, (_, i) => `util ${i + 1}`);
const text = (lines: string[]) => `${lines.join("\n")}\n`;

/**
 * Two PR commits. The first changes src/core.ts: old line 5 becomes new 5–6
 * and old 15 becomes new 16 (two hunks, a 3-line gap between them, a long
 * unchanged tail). The second (the head) changes src/util.ts.
 */
const fixture: PrOptions = {
	base: { "src/core.ts": text(core), "src/util.ts": text(util) },
	files: [
		{
			message: "core",
			binary: { "src/zz.bin": new Uint8Array([0, 1, 2, 0, 3]) },
			files: {
				"src/core.ts": text(
					core.flatMap((line, i) =>
						i === 4
							? ["core 5 a", "core 5 b"]
							: i === 14
								? ["core 15 changed"]
								: [line],
					),
				),
			},
		},
		{
			message: "util",
			files: {
				"src/util.ts": text(
					util.map((l, i) => (i === 2 ? "util 3 changed" : l)),
				),
			},
		},
	],
};

const CORE = "src/core.ts";
const BIN = "src/zz.bin";
const UTIL = "src/util.ts";

/**
 * The threads, on the head unless said: the viewer's turn on new 16; a
 * range over new 5–6; LEFT on the deleted old 15; a resolved one on new 8;
 * one in the collapsed tail (new 40) and a LEFT one there (old 50); a file
 * comment on util.ts; one whose line isn't in the file; one on a line of the
 * binary src/zz.bin; and one on the older commit (not shown).
 */
function threads(head: string, older: string) {
	const on = (commit: string) => ({ commit, diffHunk: "" });
	return [
		reviewThread({ path: CORE, line: 16, subjectType: "LINE" }, [
			threadComment({
				login: "Octo_Cat",
				text: "Why changed?",
				createdAt: "2026-01-04T09:00:00Z",
				...on(head),
			}),
			threadComment({
				login: "octo-author",
				text: "Clearer name",
				createdAt: "2026-01-04T10:00:00Z",
			}),
		]),
		reviewThread(
			{
				path: CORE,
				line: 6,
				originalStartLine: 5,
				startDiffSide: "RIGHT",
				subjectType: "LINE",
			},
			[threadComment({ login: "rev1", text: "Split in two?", ...on(head) })],
		),
		reviewThread(
			{ path: CORE, line: 15, diffSide: "LEFT", subjectType: "LINE" },
			[threadComment({ login: "rev2", text: "Gone for good?", ...on(head) })],
		),
		reviewThread(
			{ path: CORE, line: 8, isResolved: true, subjectType: "LINE" },
			[
				threadComment({ login: "rev2", text: "Rename", ...on(head) }),
				threadComment({ login: "octo-author", text: "Renamed" }),
			],
		),
		reviewThread({ path: CORE, line: 40, subjectType: "LINE" }, [
			threadComment({ login: "rev1", text: "Far down here", ...on(head) }),
		]),
		reviewThread({ path: UTIL, line: null, subjectType: "FILE" }, [
			threadComment({ login: "rev1", text: "Whole file note", ...on(head) }),
		]),
		reviewThread({ path: CORE, line: 500, subjectType: "LINE" }, [
			threadComment({ login: "rev1", text: "Past the end", ...on(head) }),
		]),
		reviewThread({ path: CORE, line: 16, subjectType: "LINE" }, [
			threadComment({ login: "rev3", text: "From before", ...on(older) }),
		]),
		reviewThread(
			{ path: CORE, line: 50, diffSide: "LEFT", subjectType: "LINE" },
			[threadComment({ login: "rev2", text: "Old fifty", ...on(head) })],
		),
		reviewThread({ path: BIN, line: 1, subjectType: "LINE" }, [
			threadComment({ login: "rev1", text: "On a binary", ...on(head) }),
		]),
	];
}

async function setup(
	pr: (opts?: PrOptions) => Promise<Pr>,
	scenario: Partial<Scenario> = {},
) {
	const p = await pr(fixture);
	const head = p.repo.shas.at(-1) ?? "";
	const older = p.repo.shas.at(-2) ?? "";
	p.editScenario((s) => {
		const graph = s.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = threads(head, older);
		Object.assign(s, scenario);
	});
	return p;
}

async function expand(page: Page, path: string) {
	const section = fileSection(page, path);
	await section.getByRole("button", { name: "Expand file" }).click();
	return section;
}

const row = (section: Locator, side: "old" | "new", n: number) =>
	section.locator(`tr[data-testid="diff-line"][data-${side}-no="${n}"]`);
const bubbles = (scope: Locator) => scope.getByTestId("thread-bubble");

/** Opens every closed bubble in `scope`, one at a time (each open moves the rest). */
async function openAll(scope: Locator) {
	const closed = scope.locator(
		'[data-testid="thread-bubble"][aria-expanded="false"]',
	);
	// One may go as it opens (a gap's bubble moves to its row): try again,
	// for as long as a loaded machine needs rather than a number of clicks.
	await expect(async () => {
		if ((await closed.count()) > 0) await closed.first().click();
		await expect(closed).toHaveCount(0, { timeout: 1000 });
	}).toPass({ timeout: 30_000 });
}

test("bubble on the commented line with count, dot and resolved state", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, CORE);
	const mine = row(section, "new", 16).getByRole("button", {
		name: "2 comments on line 16, your turn",
	});
	await expect(mine).toBeVisible();
	await expect(mine).toHaveAttribute("aria-expanded", "false");
	await expect(mine.getByTestId("your-turn-dot")).toBeVisible();
	// A 40px target on touch; 40px wide and a row tall with a mouse.
	const box = await mine.boundingBox();
	expect(box?.height ?? 0).toBeGreaterThanOrEqual(isMobile ? 40 : 20);
	expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
	const resolved = row(section, "new", 8).getByRole("button", {
		name: "2 comments on line 8, resolved",
	});
	await expect(resolved).toBeVisible();
	await expect(resolved.locator("svg.octicon-check")).toHaveCount(1);
	// Named by its tooltip too.
	await mine.hover();
	await expect(page.locator('[role="tooltip"]:not([hidden])')).toHaveText(
		"2 comments on line 16, your turn",
	);
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await mine.scrollIntoViewIfNeeded();
		await page.screenshot({
			path: `${shots}/files-bubbles-${isMobile ? "phone" : "desktop"}.png`,
		});
	}
});

test("multi-line range is highlighted, the bubble sits on its last line", async ({
	page,
	pr,
	startCrb,
}) => {
	await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, CORE);
	for (const n of [5, 6]) {
		await expect(row(section, "new", n)).toHaveAttribute("data-commented", "");
	}
	await expect(row(section, "new", 4)).not.toHaveAttribute(
		"data-commented",
		"",
	);
	await expect(bubbles(row(section, "new", 5))).toHaveCount(0);
	await expect(
		row(section, "new", 6).getByRole("button", { name: "1 comment on line 6" }),
	).toBeVisible();
	// LEFT: the deleted old line 15 carries its own bubble.
	const deleted = section.locator(
		'tr[data-testid="diff-line"][data-old-no="15"]:not([data-new-no])',
	);
	await expect(deleted).toHaveAttribute("data-commented", "");
	await expect(
		deleted.getByRole("button", { name: "1 comment on old line 15" }),
	).toBeVisible();
	// The highlight is the accent tint over the cells.
	const shadow = await row(section, "new", 5)
		.locator("td")
		.last()
		.evaluate((el) => getComputedStyle(el).boxShadow);
	expect(shadow).toContain("inset");
});

test("opening the bubble shows every comment, closing keeps the scroll position", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, CORE);
	const bubble = row(section, "new", 16).getByRole("button", {
		name: "2 comments on line 16, your turn",
	});
	await bubble.click();
	await expect(bubble).toHaveAttribute("aria-expanded", "true");
	const thread = section.getByTestId("thread-row");
	await expect(thread).toHaveCount(1);
	const comments = thread.getByTestId("thread-comment");
	await expect(comments).toHaveCount(2);
	await expect(comments.nth(0)).toContainText("Octo_Cat");
	await expect(comments.nth(0)).toContainText("Why changed?");
	await expect(comments.nth(1)).toContainText("Clearer name");
	// Its header: the count and the dot.
	await expect(
		thread.getByRole("img", { name: "2 comments" }).first(),
	).toBeVisible();
	await expect(thread.getByRole("img", { name: "Your turn" })).toBeVisible();
	// The thread sits right under its line.
	const lineBox = await row(section, "new", 16).boundingBox();
	const threadBox = await thread.boundingBox();
	expect(
		Math.abs(
			(threadBox?.y ?? 0) - ((lineBox?.y ?? 0) + (lineBox?.height ?? 0)),
		),
	).toBeLessThanOrEqual(2);
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await page.screenshot({
			path: `${shots}/files-thread-open-${isMobile ? "phone" : "desktop"}.png`,
		});
	}
	const before = await bubble.boundingBox();
	await bubble.click();
	await expect(thread).toHaveCount(0);
	await expect(bubble).toHaveAttribute("aria-expanded", "false");
	const after = await bubble.boundingBox();
	expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
});

test("a thread on an older commit is not shown", async ({
	page,
	pr,
	startCrb,
}) => {
	await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, CORE);
	// Rows 16, 6, old 15 and 8; the gap's; the header's unplaced one.
	await expect(bubbles(section)).toHaveCount(6);
	await expect(
		row(section, "new", 16).getByRole("button", {
			name: "2 comments on line 16, your turn",
		}),
	).toBeVisible();
	await openAll(section);
	await expect(section.getByTestId("thread-comment").first()).toBeVisible();
	await expect(section).not.toContainText("From before");
});

test("file comment opens from the file header into the file bubble; a line not in the diff is flagged there", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	// A closed file's header counts its threads; tapping opens the file
	// with its file comment opened.
	const util = fileSection(page, UTIL);
	const header = util.locator("header");
	const bubble = header.getByRole("button", { name: "1 comment in this file" });
	await expect(bubble).toBeVisible();
	await bubble.click();
	await expect(
		util.getByRole("button", { name: "Collapse file" }),
	).toBeVisible();
	await expect(
		util.getByTestId("file-threads").getByTestId("thread-comment"),
	).toContainText("Whole file note");
	await expect(
		util.getByRole("button", { name: "1 comment on this file" }),
	).toHaveAttribute("aria-expanded", "true");
	// The line past the file's end: in core.ts's file bubble, flagged.
	const core = await expand(page, CORE);
	const flagged = core.locator("table").getByRole("button", {
		name: "1 comment on this file, line not in this diff",
	});
	await expect(flagged).toBeVisible();
	await flagged.click();
	await expect(core.getByTestId("thread-comment")).toContainText(
		"Past the end",
	);
	await expect(
		core.getByRole("img", { name: "Line not in this diff" }),
	).toBeVisible();
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await core.locator("header").scrollIntoViewIfNeeded();
		await page.screenshot({
			path: `${shots}/files-file-bubble-${isMobile ? "phone" : "desktop"}.png`,
		});
	}
});

test("a thread in a collapsed gap is reachable", async ({
	page,
	pr,
	startCrb,
}) => {
	await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, CORE);
	await expect(row(section, "new", 40)).toHaveCount(0);
	const gap = section.getByTestId("gap-row").last();
	// The tail gap hides two: RIGHT new 40 and LEFT old 50 (new 51).
	const bubble = gap.getByRole("button", {
		name: "2 comments on hidden lines 20–79",
	});
	await expect(bubble).toBeVisible();
	// By keyboard: focus lands on the opened row's bubble.
	await bubble.focus();
	await page.keyboard.press("Enter");
	// The gap opens around the lines, and the threads open under them.
	await expect(row(section, "new", 40)).toBeVisible();
	await expect(row(section, "new", 40)).toHaveAttribute("data-commented", "");
	const rows = section.getByTestId("thread-row");
	await expect(
		rows.filter({ hasText: "Far down here" }).getByTestId("thread-comment"),
	).toHaveCount(1);
	await expect(
		row(section, "new", 40).getByRole("button", {
			name: "1 comment on line 40",
		}),
	).toHaveAttribute("aria-expanded", "true");
	// The LEFT one, on old 50.
	const old50 = row(section, "old", 50);
	await expect(old50).toHaveAttribute("data-new-no", "51");
	await expect(
		old50.getByRole("button", { name: "1 comment on line 51" }),
	).toHaveAttribute("aria-expanded", "true");
	await expect(
		rows.filter({ hasText: "Old fifty" }).getByTestId("thread-comment"),
	).toHaveCount(1);
	const focused = await page.evaluate(() => {
		const el = document.activeElement;
		return el?.getAttribute("data-testid") === "thread-bubble"
			? (el.getAttribute("aria-label") ?? "")
			: (el?.tagName ?? "none");
	});
	expect(focused).toMatch(/^1 comment on line (40|51)$/);
	// The gap lines that stay hidden are still counted, with no "0 hidden".
	await expect(section).not.toContainText("0 hidden lines");
});

test("opening a thread doesn't change review progress", async ({
	page,
	pr,
	startCrb,
}) => {
	await setup(pr);
	const s = await startCrb();
	const writes: string[] = [];
	page.on("request", (r) => {
		if (r.method() !== "GET") writes.push(`${r.method()} ${r.url()}`);
	});
	await openFiles(page, s.url);
	const bar = progress(page);
	await expect(bar).toHaveAttribute("aria-valuenow", "0");
	const section = await expand(page, CORE);
	await openAll(section);
	await expect(section.getByTestId("thread-row").first()).toBeVisible();
	await expect(section.getByTestId("thread-comment").first()).toBeVisible();
	await expect(bar).toHaveAttribute("aria-valuenow", "0");
	await expect(
		section.getByRole("checkbox", { name: "Mark cluster reviewed" }).first(),
	).not.toBeChecked();
	expect(writes).toEqual([]);
});

test("threads show when /files is the first page", async ({
	page,
	pr,
	startCrb,
}) => {
	await setup(pr);
	const s = await startCrb();
	// A deep link to the line: the Overview never loads first.
	await page.goto(
		reviewPage(s.url, "files", `?path=${encodeURIComponent(CORE)}&line=16`),
	);
	const section = fileSection(page, CORE);
	await expect(
		row(section, "new", 16).getByRole("button", {
			name: "2 comments on line 16, your turn",
		}),
	).toBeVisible();
});

test("threads loading: spinners in the bar and on the file, never no comments", async ({
	page,
	pr,
	startCrb,
}) => {
	// The threads' summaries wait until the test lets them go.
	const p = await setup(pr, { hold: ["threads"] });
	const s = await startCrb();
	await openFiles(page, s.url);
	const bar = page.locator("[data-page-bar]");
	const core = await expand(page, CORE);
	const util = fileSection(page, UTIL);
	// The open file's bubble spins rather than offering a first comment.
	await expectLoadingThen({
		loading: core.getByRole("button", { name: "Loading comments" }),
		empty: [core.getByRole("button", { name: "Comment on file" })],
		release: async () => {
			// The bar says so too, and a closed file has no count yet.
			await expect(
				bar.getByRole("status", { name: "Loading comments" }),
			).toBeVisible();
			await expect(util.getByTestId("thread-bubble")).toHaveCount(0);
			// And the tree, whose files have no dots yet.
			await withTree(page, async (tree) => {
				await expect(
					tree.getByRole("status", { name: "Loading comments" }),
				).toBeVisible();
				await expect(tree).toHaveAttribute("aria-busy", "true");
			});
			release(p.scenarioPath, "threads");
		},
		result: core.getByRole("button", {
			name: "2 comments on line 16, your turn",
		}),
	});
	await expect(
		bar.getByRole("status", { name: "Loading comments" }),
	).toHaveCount(0);
	await expect(
		util.getByRole("button", { name: "1 comment in this file" }),
	).toBeVisible();
	await expect(
		core.getByRole("button", { name: /^Comment on file|on this file/ }),
	).toBeVisible();
	await withTree(page, async (tree) => {
		await expect(
			tree.getByRole("status", { name: "Loading comments" }),
		).toHaveCount(0);
		await expect(tree).not.toHaveAttribute("aria-busy");
	});
});

test("slow comments: spinner, then comments", async ({
	page,
	pr,
	startCrb,
}) => {
	// The comments wait until the test lets them go, however slow the page.
	const p = await setup(pr, { hold: ["comments"] });
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, CORE);
	await row(section, "new", 6)
		.getByRole("button", { name: "1 comment on line 6" })
		.click();
	const thread = section.getByTestId("thread-row");
	await expect(
		thread.getByRole("status", { name: "Loading comments" }),
	).toBeVisible();
	release(p.scenarioPath, "comments");
	await expect(thread.getByTestId("thread-comment")).toHaveCount(1, {
		timeout: 15_000,
	});
	await expect(
		thread.getByRole("status", { name: "Loading comments" }),
	).toHaveCount(0);
});

test("the open file's comments are read first", async ({
	page,
	pr,
	startCrb,
}) => {
	await setup(pr, { commentsDelayMs: 1500 });
	const s = await startCrb();
	const asked: string[][] = [];
	page.on("request", (r) => {
		const url = new URL(r.url());
		if (url.pathname.endsWith("/comments")) {
			asked.push((url.searchParams.get("ids") ?? "").split(","));
		}
	});
	// util.ts (file 1) is opened by the link; core.ts (file 0) comes after it.
	await page.goto(
		reviewPage(s.url, "files", `?path=${encodeURIComponent(UTIL)}&line=3`),
	);
	await expect.poll(() => asked.length).toBeGreaterThan(0);
	const ids = asked.flat();
	// T7-5 is util.ts's file comment.
	expect(ids[0]).toBe("T7-5");
	// The older commit's thread isn't in Files changed.
	await expect.poll(() => asked.flat()).toContain("T7-0");
	expect(asked.flat()).not.toContain("T7-7");
});

test("a commented range is marked on added rows too, unlike a landed line", async ({
	page,
	pr,
	startCrb,
}) => {
	await setup(pr);
	const s = await startCrb();
	// Land on new 9 (uncommented context): the landed look, for comparison.
	await page.goto(
		reviewPage(s.url, "files", `?path=${encodeURIComponent(CORE)}&line=9`),
	);
	const section = fileSection(page, CORE);
	await expect(row(section, "new", 9)).toHaveAttribute("data-landed");
	const look = (where: Locator, n: number) =>
		row(where, "new", n).evaluate((tr) => {
			const cells = [...tr.querySelectorAll("td")];
			const style = (td: Element | undefined) =>
				td ? getComputedStyle(td).boxShadow : "";
			return {
				number: style(cells.find((c) => c.dataset.testid === "new")),
				code: style(cells.at(-1)),
			};
		});
	// New 5 is added and commented; util.ts's new 3 is added, not commented.
	const commented = await look(section, 5);
	const landed = await look(section, 9);
	const util = await expand(page, UTIL);
	await expect(row(util, "new", 3)).toHaveClass(/bg-add/);
	const plain = await look(util, 3);
	expect(commented.number).not.toBe(plain.number);
	expect(commented.number).toContain("inset");
	// The accent stripe at the code's left edge.
	expect(commented.code).toMatch(/3px 0px 0px 0px inset/);
	expect(plain.code).not.toMatch(/ 3px 0px 0px 0px inset/);
	expect(landed.code).not.toMatch(/ 3px 0px 0px 0px inset/);
	expect(commented.number).not.toBe(landed.number);
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		// One file open at a time: back to core.ts.
		await expand(page, CORE);
		await row(section, "new", 16)
			.getByRole("button", { name: "2 comments on line 16, your turn" })
			.click();
		await row(section, "new", 5).scrollIntoViewIfNeeded();
		await page.screenshot({
			path: `${shots}/files-thread-open-${test.info().project.name === "phone" ? "phone" : "desktop"}-fix1.png`,
		});
	}
});

test("a closed file counts its threads; a binary file's line thread is flagged before it opens", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await setup(pr);
	const s = await startCrb();
	const hunkReads: string[] = [];
	page.on("request", (r) => {
		if (/\/api\/files\/\d+\/hunks/.test(r.url())) hunkReads.push(r.url());
	});
	await openFiles(page, s.url);
	// core.ts, closed: its 7 threads (9 comments) on the head, the viewer's
	// turn on one. Its hunks aren't read while closed, so the line past its
	// end is flagged once it opens; a binary file's is flagged at once.
	const core = fileSection(page, CORE);
	const count = core.locator("header").getByRole("button", {
		name: "9 comments in this file, your turn",
	});
	await expect(count).toBeVisible();
	await expect(count.getByTestId("your-turn-dot")).toBeVisible();
	// The binary file: flagged though never opened.
	const bin = fileSection(page, BIN);
	await expect(
		bin.locator("header").getByRole("button", {
			name: "1 comment in this file, line not in this diff",
		}),
	).toBeVisible();
	await expect(bin.getByRole("button", { name: "Expand file" })).toBeVisible();
	// The tree says it too: a dot, named like the bubble.
	await withTree(page, async (tree) => {
		await expect(
			tree
				.getByRole("button", { name: /core\.ts/ })
				.getByTestId("tree-threads"),
		).toHaveText("9 comments in this file, your turn");
		await expect(
			tree
				.getByRole("button", { name: /util\.ts/ })
				.getByTestId("tree-threads"),
		).toHaveText("1 comment in this file");
	});
	// The dot's label shows on hover too (the row's tooltip).
	await withTree(page, async (tree) => {
		await tree
			.getByRole("button", { name: /core\.ts/ })
			.getByTestId("tree-threads")
			.hover();
		await expect(page.locator('[role="tooltip"]:not([hidden])')).toContainText(
			"9 comments in this file, your turn",
		);
	});
	// No file's hunks are read until it opens.
	expect(hunkReads).toEqual([]);
	// Tapping the count opens the file.
	await count.click();
	await expect(
		core.getByRole("button", { name: "Collapse file" }),
	).toBeVisible();
	await expect(row(core, "new", 16)).toBeVisible();
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await page.screenshot({
			path: `${shots}/files-bubbles-${isMobile ? "phone" : "desktop"}-fix1.png`,
		});
	}
});

test("an opened thread survives a Refresh", async ({ page, pr, startCrb }) => {
	const p = await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, CORE);
	await row(section, "new", 6)
		.getByRole("button", { name: "1 comment on line 6" })
		.click();
	const thread = section.getByTestId("thread-row");
	await expect(thread.getByTestId("thread-comment")).toHaveCount(1);
	// Every bubble and the thread stay while the new read comes, slowly.
	p.editScenario((sc) => {
		sc.threadsDelayMs = 2500;
	});
	await page.evaluate(() => {
		const w = window as unknown as { lost: boolean };
		w.lost = false;
		new MutationObserver(() => {
			if (!document.querySelector('[data-testid="thread-row"]')) w.lost = true;
		}).observe(document.body, { childList: true, subtree: true });
	});
	const asked = page.waitForResponse(
		(r) => /^\/api\/r\/[^/]+\/threads$/.test(new URL(r.url()).pathname),
		{ timeout: 20_000 },
	);
	await page.getByRole("button", { name: "Refresh" }).first().click();
	await asked;
	await expect(
		page.getByRole("button", { name: "Refresh" }).first(),
	).toBeEnabled({
		timeout: 20_000,
	});
	await page.waitForTimeout(500);
	expect(
		await page.evaluate(() => (window as unknown as { lost: boolean }).lost),
	).toBe(false);
	await expect(thread.getByTestId("thread-comment")).toHaveCount(1);
});

test("review threads that couldn't be read are flagged, not shown as none", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/50\d|Failed to load resource/);
	await setup(pr, { failGraphql: "reviewThreads" });
	const s = await startCrb();
	await openFiles(page, s.url);
	await expect(page.getByTestId("threads-failed")).toBeVisible({
		timeout: 20_000,
	});
	await expect(
		page.getByTestId("threads-failed").getByRole("img", {
			name: /^Review threads couldn't be read/,
		}),
	).toBeVisible();
});

test("a thread on a file's last line opens below its no-newline marker", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr({
		base: { "src/end.ts": "a\nb\nc" },
		files: [{ message: "end", files: { "src/end.ts": "a\nb\nc changed" } }],
	});
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((sc) => {
		const graph = sc.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: "src/end.ts", line: 3, subjectType: "LINE" }, [
				threadComment({ login: "rev1", text: "Add a newline", commit: head }),
			]),
		];
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, "src/end.ts");
	await row(section, "new", 3)
		.getByRole("button", { name: "1 comment on line 3" })
		.click();
	const after = await row(section, "new", 3).evaluate((tr) => {
		const next = tr.nextElementSibling;
		return [
			next?.textContent ?? "",
			next?.nextElementSibling?.getAttribute("data-testid"),
		];
	});
	expect(after[0]).toContain("No newline at end of file");
	expect(after[1]).toBe("thread-row");
});

test("a thread deep in a large gap loads only the lines around it", async ({
	page,
	pr,
	startCrb,
}) => {
	const big = Array.from({ length: 900 }, (_, i) => `big ${i + 1}`);
	const p = await pr({
		base: { "src/big.ts": text(big) },
		files: [
			{
				message: "big",
				files: {
					"src/big.ts": text(
						big.map((l, i) => (i === 0 ? "big 1 changed" : l)),
					),
				},
			},
		],
	});
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((sc) => {
		const graph = sc.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: "src/big.ts", line: 450, subjectType: "LINE" }, [
				threadComment({ login: "rev1", text: "Deep down", commit: head }),
			]),
		];
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, "src/big.ts");
	await section
		.getByRole("button", { name: /^1 comment on hidden lines/ })
		.click();
	await expect(row(section, "new", 450)).toBeVisible();
	await expect(
		section.getByTestId("thread-row").getByTestId("thread-comment"),
	).toHaveText(/Deep down/);
	// A few lines around it, hidden runs above and below.
	const shown = await section.locator('tr[data-testid="diff-line"]').count();
	expect(shown).toBeLessThan(40);
	const gaps = section.getByTestId("gap-row");
	await expect(gaps).toHaveCount(2);
	await expect(gaps.first()).toContainText(/\d+ hidden lines/);
	await expect(gaps.last()).toContainText(/\d+ hidden lines/);
	// The run above still grows from either end.
	await expect(
		gaps.first().getByRole("button", { name: /Load 20 lines (below|above)/ }),
	).toHaveCount(2);
});

test("comments of the file opened next go first", async ({
	page,
	pr,
	startCrb,
}) => {
	// Four files of 40 threads: the first two requests take 100 of them.
	const names = ["f1", "f2", "f3", "f4"].map((n) => `src/${n}.ts`);
	const lines = Array.from({ length: 50 }, (_, i) => `l ${i + 1}`);
	const p = await pr({
		base: Object.fromEntries(names.map((n) => [n, text(lines)])),
		files: [
			{
				message: "all",
				files: Object.fromEntries(
					names.map((n) => [
						n,
						text(lines.map((l, i) => (i === 0 ? `${l}!` : l))),
					]),
				),
			},
		],
	});
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((sc) => {
		const graph = sc.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = names.flatMap((path) =>
			Array.from({ length: 40 }, (_, i) =>
				reviewThread({ path, line: 1 + (i % 4), subjectType: "LINE" }, [
					threadComment({ login: "rev1", text: `${path} ${i}`, commit: head }),
				]),
			),
		);
		// The first two stay out until f4 has opened.
		sc.hold = ["comments"];
	});
	const s = await startCrb();
	const asked: string[][] = [];
	page.on("request", (r) => {
		const url = new URL(r.url());
		if (url.pathname.endsWith("/comments")) {
			asked.push((url.searchParams.get("ids") ?? "").split(","));
		}
	});
	await openFiles(page, s.url);
	await expect.poll(() => asked.length).toBe(2);
	// f4 (threads 120–159) opens while the first two are out.
	const f4 = await expand(page, names[3] as string);
	// Its threads are on screen (so first in line) before the others answer.
	await expect(bubbles(f4).first()).toBeVisible();
	release(p.scenarioPath, "comments");
	await expect.poll(() => asked.length, { timeout: 20_000 }).toBeGreaterThan(2);
	const third = asked[2] ?? [];
	const index = (id: string) => Number(id.split("-")[1]);
	expect(index(third[0] ?? "")).toBeGreaterThanOrEqual(120);
});

test("an opened thread inside a cluster keeps its rail", async ({
	page,
	pr,
	startCrb,
}) => {
	await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, CORE);
	// Old 15 is deleted, new 16 added: one cluster, the thread between them.
	const deleted = section.locator(
		'tr[data-testid="diff-line"][data-old-no="15"]:not([data-new-no])',
	);
	await deleted
		.getByRole("button", { name: "1 comment on old line 15" })
		.click();
	const thread = section.getByTestId("thread-row");
	await expect(thread.getByTestId("thread-comment")).toHaveCount(1);
	const rail = thread.getByTestId("thread-rail");
	await expect(rail).toBeVisible();
	await expect(rail).toHaveClass(/bg-unreviewed/);
});

test("below an opened thread the cluster's controls float again", async ({
	page,
	pr,
	startCrb,
}) => {
	const lines = Array.from({ length: 80 }, (_, i) => `x ${i + 1}`);
	const p = await pr({
		base: { "src/long.ts": text(lines) },
		files: [
			{
				message: "long",
				files: {
					"src/long.ts": text(
						lines.map((l, i) => (i >= 5 && i < 65 ? `${l} changed` : l)),
					),
				},
			},
		],
	});
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((sc) => {
		const graph = sc.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: "src/long.ts", line: 15, subjectType: "LINE" }, [
				threadComment({ login: "rev1", text: "Midway", commit: head }),
			]),
		];
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, "src/long.ts");
	await row(section, "new", 15)
		.getByRole("button", { name: "1 comment on line 15" })
		.click();
	await expect(section.getByTestId("thread-comment")).toHaveCount(1);
	// Scroll so new 50 (same cluster, below the thread) is just under the header.
	await row(section, "new", 50).evaluate((el) => {
		const header = el.closest("section")?.querySelector("header");
		const top = header?.getBoundingClientRect().bottom ?? 0;
		window.scrollBy(0, el.getBoundingClientRect().top - top - 5);
	});
	// Placement runs once a frame: let it catch up before reading it.
	await page.evaluate(
		() =>
			new Promise<void>((done) =>
				requestAnimationFrame(() => requestAnimationFrame(() => done())),
			),
	);
	expect(
		await section
			.locator("[data-sticky-controls]")
			.first()
			.getAttribute("data-stuck"),
	).toBe("fixed");
});

test("a gap window that failed doesn't take focus when it's retried later", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/500|Failed to load resource/);
	await setup(pr);
	let fail = true;
	await page.route("**/api/r/*/files/*/context**", (route) =>
		fail ? route.fulfill({ status: 500, body: "{}" }) : route.continue(),
	);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, CORE);
	await section
		.getByRole("button", { name: "2 comments on hidden lines 20–79" })
		.click();
	const retry = section.getByRole("button", { name: "Retry" });
	await expect(retry).toBeVisible();
	fail = false;
	await retry.click();
	await expect(row(section, "new", 40)).toBeVisible();
	// The reader is on Retry's spot; the opened row's bubble doesn't grab focus.
	const focused = await page.evaluate(
		() => document.activeElement?.getAttribute("data-testid") ?? "",
	);
	expect(focused).not.toBe("thread-bubble");
});
