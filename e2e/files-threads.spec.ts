import type { Locator, Page } from "@playwright/test";
import {
	reviewThread,
	type Scenario,
	threadComment,
} from "../test/fake-gh/scenario";
import { fileSection, openFiles, progress } from "./files-ui";
import { expect, type Pr, type PrOptions, test } from "./fixtures";

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
const UTIL = "src/util.ts";

/**
 * The threads, on the head unless said: the viewer's turn on new 16; a
 * range over new 5–6; LEFT on the deleted old 15; a resolved one on new 8;
 * one in the collapsed tail (new 40); a file comment on util.ts; one whose
 * line isn't in the file; and one on the older commit (not shown).
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
	for (let i = 0; i < 20 && (await closed.count()) > 0; i++) {
		await closed.first().click();
	}
	await expect(closed).toHaveCount(0);
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
		name: "2 comments, your turn",
	});
	await expect(mine).toBeVisible();
	await expect(mine).toHaveAttribute("aria-expanded", "false");
	await expect(mine.getByTestId("your-turn-dot")).toBeVisible();
	// A 40px target on touch; 40px wide and a row tall with a mouse.
	const box = await mine.boundingBox();
	expect(box?.height ?? 0).toBeGreaterThanOrEqual(isMobile ? 40 : 20);
	expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
	const resolved = row(section, "new", 8).getByRole("button", {
		name: "2 comments, resolved",
	});
	await expect(resolved).toBeVisible();
	await expect(resolved.locator("svg.octicon-check")).toHaveCount(1);
	// Named by its tooltip too.
	await mine.hover();
	await expect(page.locator('[role="tooltip"]:not([hidden])')).toHaveText(
		"2 comments, your turn",
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
		row(section, "new", 6).getByRole("button", { name: "1 comment" }),
	).toBeVisible();
	// LEFT: the deleted old line 15 carries its own bubble.
	const deleted = section.locator(
		'tr[data-testid="diff-line"][data-old-no="15"]:not([data-new-no])',
	);
	await expect(deleted).toHaveAttribute("data-commented", "");
	await expect(
		deleted.getByRole("button", { name: "1 comment" }),
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
		name: "2 comments, your turn",
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
			name: "2 comments, your turn",
		}),
	).toBeVisible();
	await openAll(section);
	await expect(section.getByTestId("thread-comment").first()).toBeVisible();
	await expect(section).not.toContainText("From before");
});

test("file comment opens from the file header; a line not in the diff is flagged there", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	// A file comment shows on the header even while the file is closed.
	const util = fileSection(page, UTIL);
	const header = util.locator("header");
	const bubble = header.getByRole("button", { name: "1 comment" });
	await expect(bubble).toBeVisible();
	await bubble.click();
	await expect(util.getByTestId("thread-comment")).toContainText(
		"Whole file note",
	);
	// The line past the file's end: in core.ts's header, flagged.
	const core = await expand(page, CORE);
	const flagged = core
		.locator("header")
		.getByRole("button", { name: "1 comment, line not in this diff" });
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
			path: `${shots}/files-header-thread-${isMobile ? "phone" : "desktop"}.png`,
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
	const bubble = gap.getByRole("button", { name: "1 comment" });
	await expect(bubble).toBeVisible();
	await bubble.click();
	// The gap opens around the line, and the thread opens under it.
	await expect(row(section, "new", 40)).toBeVisible();
	await expect(row(section, "new", 40)).toHaveAttribute("data-commented", "");
	const thread = section.getByTestId("thread-row");
	await expect(thread.getByTestId("thread-comment")).toContainText(
		"Far down here",
	);
	await expect(
		row(section, "new", 40).getByRole("button", { name: "1 comment" }),
	).toHaveAttribute("aria-expanded", "true");
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
		new URL(`/files?path=${encodeURIComponent(CORE)}&line=16`, s.url).href,
	);
	const section = fileSection(page, CORE);
	await expect(
		row(section, "new", 16).getByRole("button", {
			name: "2 comments, your turn",
		}),
	).toBeVisible();
});

test("slow comments: spinner, then comments", async ({
	page,
	pr,
	startCrb,
}) => {
	await setup(pr, { commentsDelayMs: 3000 });
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = await expand(page, CORE);
	await row(section, "new", 6)
		.getByRole("button", { name: "1 comment" })
		.click();
	const thread = section.getByTestId("thread-row");
	await expect(
		thread.getByRole("status", { name: "Loading comments" }),
	).toBeVisible();
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
		if (url.pathname === "/api/comments") {
			asked.push((url.searchParams.get("ids") ?? "").split(","));
		}
	});
	// util.ts (file 1) is opened by the link; core.ts (file 0) comes after it.
	await page.goto(
		new URL(`/files?path=${encodeURIComponent(UTIL)}&line=3`, s.url).href,
	);
	await expect.poll(() => asked.length).toBeGreaterThan(0);
	const ids = asked.flat();
	// T7-5 is util.ts's file comment.
	expect(ids[0]).toBe("T7-5");
	// The older commit's thread isn't in Files changed.
	await expect.poll(() => asked.flat()).toContain("T7-0");
	expect(asked.flat()).not.toContain("T7-7");
});
