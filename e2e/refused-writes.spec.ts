import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { DELETE_UNDO_MS } from "../src/web/threads/threadWrites";
import {
	reviewThread,
	type Scenario,
	threadComment,
} from "../test/fake-gh/scenario";
import { fileSection, openFiles } from "./files-ui";
import {
	expect,
	installClock,
	type Pr,
	type PrOptions,
	test,
} from "./fixtures";

/**
 * Writes GitHub refuses (the fake gh's `failNext`, used up once) are listed
 * under one red chip until a Retry lands or they're dropped; leaving asks
 * meanwhile, and a reload lists them again. Also: a closed file's header
 * opens it, and the file bubble sits in the middle of the diff's first row.
 * The viewer is Octo_Cat. Threads: 0. new.txt:1, Octo_Cat's opener alone
 * ("My take"); 1. a.txt:2, rev1's ("Changed how?").
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
		const graph = s.prs[p.number]?.graphql;
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
			]),
		];
		Object.assign(s, scenario);
	});
	return p;
}

interface StoredThread {
	path: string;
	isResolved: boolean;
	removed?: boolean;
	comments: {
		nodes: { body?: string; bodyText?: string; removed?: boolean }[];
	};
}

/** The fake gh's threads as stored. */
function storedThreads(p: Pr): StoredThread[] {
	const s = JSON.parse(readFileSync(p.scenarioPath, "utf8")) as Scenario;
	return (s.prs[p.number]?.graphql?.reviewThreads ?? []) as StoredThread[];
}

/** Comment bodies on GitHub (the fake's), deleted ones left out. */
const bodies = (p: Pr) =>
	storedThreads(p).flatMap((t) =>
		t.removed
			? []
			: t.comments.nodes
					.filter((c) => !c.removed)
					.map((c) => c.body ?? c.bodyText ?? ""),
	);

const humans = (page: Page) =>
	page.getByRole("region", { name: "Human reviews" });
const card = (page: Page, path: string) =>
	humans(page).getByTestId("thread").filter({ hasText: path });

async function openCard(c: Locator) {
	const more = c.getByTestId("thread-more");
	if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
	await expect(more).toHaveAttribute("aria-expanded", "true");
}

const chip = (page: Page) => page.getByTestId("refused-bar");
const item = (page: Page) => page.getByTestId("refused-write");

/** Screenshots for the brief, when DESIGN_SHOTS names a folder. */
async function shot(page: Page, name: string, isMobile: boolean) {
	const dir = process.env.DESIGN_SHOTS;
	if (!dir) return;
	await page.screenshot({
		path: `${dir}/${name}-${isMobile ? "phone" : "desktop"}.png`,
	});
}

/** Reloads, answering the leave prompt; says whether it asked. */
async function reload(page: Page): Promise<boolean> {
	let asked = false;
	const answer = (d: { type: () => string; accept: () => Promise<void> }) => {
		if (d.type() === "beforeunload") asked = true;
		void d.accept();
	};
	page.on("dialog", answer);
	await page.reload();
	page.off("dialog", answer);
	return asked;
}

type Kind = {
	op: "reply" | "resolve" | "edit" | "delete" | "comment";
	action: string;
	where: string;
	/** Makes the write, which GitHub refuses. */
	write: (page: Page) => Promise<void>;
	/** GitHub has it now. */
	landed: (p: Pr) => boolean;
};

const KINDS: Kind[] = [
	{
		op: "reply",
		action: "Reply",
		where: "new.txt:1",
		write: async (page) => {
			const c = card(page, "new.txt");
			await openCard(c);
			await c.getByRole("textbox", { name: "Reply" }).fill("Refused reply");
			await c
				.getByTestId("reply-box")
				.getByRole("button", { name: "Reply" })
				.click();
		},
		landed: (p) => bodies(p).includes("Refused reply"),
	},
	{
		op: "resolve",
		action: "Resolve",
		where: "a.txt:2",
		write: async (page) => {
			const c = card(page, "a.txt");
			await openCard(c);
			await c.getByRole("button", { name: "Resolve", exact: true }).click();
		},
		landed: (p) =>
			storedThreads(p).find((t) => t.path === "a.txt")?.isResolved === true,
	},
	{
		op: "edit",
		action: "Edit",
		where: "new.txt:1",
		write: async (page) => {
			const c = card(page, "new.txt");
			await openCard(c);
			await c.getByRole("button", { name: "Edit" }).click();
			await c.getByRole("textbox", { name: "Edit comment" }).fill("My edit");
			await c.getByRole("button", { name: "Save" }).click();
		},
		landed: (p) => bodies(p).includes("My edit"),
	},
	{
		op: "delete",
		action: "Delete",
		where: "new.txt:1",
		write: async (page) => {
			const c = card(page, "new.txt");
			await openCard(c);
			await c.getByRole("button", { name: "Delete" }).click();
			await page
				.getByRole("alertdialog", { name: "Delete this comment?" })
				.getByRole("button", { name: "Delete" })
				.click();
			// Sent once its undo window is over (the test installed the clock).
			await expect(c.getByTestId("comment-deleted-row")).toBeVisible();
			await page.clock.fastForward(DELETE_UNDO_MS);
		},
		landed: (p) => !bodies(p).includes("My take"),
	},
	{
		op: "comment",
		action: "New comment",
		where: "new.txt",
		write: async (page) => {
			await page.getByRole("link", { name: "Files changed" }).click();
			const section = fileSection(page, "new.txt");
			await section.getByRole("button", { name: "Expand file" }).click();
			await section.getByRole("button", { name: "Comment on file" }).click();
			const box = section
				.getByTestId("new-thread")
				.getByRole("textbox", { name: "Comment" });
			await box.fill("A file remark");
			await box.press("Control+Enter");
		},
		landed: (p) => bodies(p).some((b) => b.startsWith("A file remark")),
	},
];

for (const kind of KINDS) {
	test(`a refused ${kind.action.toLowerCase()}: listed under the chip until a Retry lands`, async ({
		page,
		pr,
		startCrb,
		expectConsoleError,
	}) => {
		expectConsoleError(/403/);
		const p = await setup(pr, {
			failNext: { op: kind.op, status: 403, message: "Not allowed here" },
		});
		const s = await startCrb();
		await installClock(page);
		await page.goto(s.url);
		await kind.write(page);
		// Newly refused: the chip, its list open.
		await expect(chip(page)).toHaveAccessibleName("1 not posted");
		await expect(item(page)).toContainText(`${kind.action} · ${kind.where}`);
		// GitHub's message (a resolve's GraphQL FORBIDDEN says its own).
		await expect(item(page)).toContainText(
			kind.op === "resolve" ? "does not have permission" : "Not allowed here",
		);
		expect(kind.landed(p)).toBe(false);
		await item(page)
			.getByRole("button", { name: `Retry ${kind.action.toLowerCase()}` })
			.click();
		await expect(chip(page)).toHaveCount(0);
		await expect.poll(() => kind.landed(p)).toBe(true);
	});
}

test("the chip stays put while the page scrolls, on both pages; Drop asks, then the guard stops asking", async ({
	page,
	pr,
	startCrb,
	isMobile,
	expectConsoleError,
}) => {
	expectConsoleError(/403/);
	const p = await setup(pr, {
		failNext: { op: "reply", status: 403, message: "Not allowed here" },
	});
	const s = await startCrb();
	await page.goto(s.url);
	await KINDS[0]?.write(page);
	await expect(item(page)).toContainText("Refused reply");
	await shot(page, "refused-list", isMobile);
	// Collapsed: the chip alone, fixed at the bottom.
	await chip(page).click();
	await expect(page.getByTestId("refused-list")).toHaveCount(0);
	await shot(page, "refused-chip", isMobile);
	const before = await chip(page).boundingBox();
	await page.mouse.wheel(0, 2000);
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	expect(await chip(page).boundingBox()).toEqual(before);
	await expect(chip(page)).toBeInViewport();
	await page.getByRole("link", { name: "Files changed" }).click();
	await expect(chip(page)).toBeInViewport();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - window.innerWidth,
		),
	).toBeLessThanOrEqual(0);
	// Unsettled: leaving asks.
	expect(await reload(page)).toBe(true);
	await expect(chip(page)).toHaveAccessibleName("1 not posted");
	// From before the reload: the list waits for the reviewer.
	await expect(page.getByTestId("refused-list")).toHaveCount(0);
	await chip(page).click();
	const drop = item(page).getByRole("button", { name: "Drop reply" });
	const size = await drop.boundingBox();
	expect(size?.height ?? 0).toBeGreaterThanOrEqual(40);
	expect(size?.width ?? 0).toBeGreaterThanOrEqual(40);
	await drop.click();
	const ask = page.getByRole("alertdialog", {
		name: "Drop this? Its text is lost",
	});
	await expect(ask.getByRole("button", { name: "Cancel" })).toBeFocused();
	await shot(page, "refused-drop-confirm", isMobile);
	await ask.getByRole("button", { name: "Cancel" }).click();
	await expect(item(page)).toHaveCount(1);
	await drop.click();
	await ask.getByRole("button", { name: "Drop" }).click();
	await expect(chip(page)).toHaveCount(0);
	expect(await reload(page)).toBe(false);
	await expect(chip(page)).toHaveCount(0);
	// The text is gone with it.
	await page.getByRole("link", { name: "Overview" }).click();
	const c = card(page, "new.txt");
	await openCard(c);
	await expect(c.getByRole("textbox", { name: "Reply" })).toHaveValue("");
	expect(bodies(p)).not.toContain("Refused reply");
});

test("a refused delete survives a reload, and its Retry deletes it", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/403/);
	const p = await setup(pr, {
		failNext: { op: "delete", status: 403, message: "Not allowed here" },
	});
	const s = await startCrb();
	await installClock(page);
	await page.goto(s.url);
	await KINDS[3]?.write(page);
	await expect(item(page)).toContainText("Delete · new.txt:1");
	// The comment shows again, its text in the list.
	await expect(item(page).getByTestId("refused-preview")).toHaveText("My take");
	expect(await reload(page)).toBe(true);
	await chip(page).click();
	await expect(item(page)).toContainText("Delete · new.txt:1");
	await expect(item(page)).toContainText("Not allowed here");
	await item(page).getByRole("button", { name: "Retry delete" }).click();
	await expect(chip(page)).toHaveCount(0);
	await expect.poll(() => bodies(p).includes("My take")).toBe(false);
	expect(await reload(page)).toBe(false);
});

test("a refused new comment survives a reload: its composer and the chip come back, and Retry posts it", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/403/);
	const p = await setup(pr, {
		failNext: { op: "comment", status: 403, message: "Not allowed here" },
	});
	const s = await startCrb();
	await page.goto(s.url);
	await KINDS[4]?.write(page);
	await expect(item(page)).toContainText("New comment · new.txt");
	expect(await reload(page)).toBe(true);
	await expect(chip(page)).toHaveAccessibleName("1 not posted");
	const section = fileSection(page, "new.txt");
	const toggle = section.getByRole("button", {
		name: /(Expand|Collapse) file/,
	});
	if ((await toggle.getAttribute("aria-expanded")) !== "true")
		await toggle.click();
	await expect(
		section.getByTestId("new-thread").getByRole("textbox", { name: "Comment" }),
	).toHaveValue("A file remark");
	await chip(page).click();
	await expect(item(page).getByTestId("refused-preview")).toHaveText(
		"A file remark",
	);
	await item(page).getByRole("button", { name: "Retry new comment" }).click();
	await expect(chip(page)).toHaveCount(0);
	await expect.poll(() => KINDS[4]?.landed(p)).toBe(true);
	expect(await reload(page)).toBe(false);
});

test("a closed file's header opens it; the file bubble sits in the middle of the first row and opens the file composer", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await setup(pr);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, "a.txt");
	const toggle = section.getByRole("button", {
		name: /(Expand|Collapse) file/,
	});
	if ((await toggle.getAttribute("aria-expanded")) === "true") {
		await toggle.click();
	}
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await section.getByTestId("file-path").click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(section.getByTestId("new-thread")).toHaveCount(0);
	const bubble = section.getByRole("button", { name: "Comment on file" });
	await expect(bubble).toBeVisible();
	// On the first row (the hunk's header), not over code.
	await expect(
		section.locator("table tr").first().getByTestId("thread-bubble"),
	).toHaveAccessibleName("Comment on file");
	const scroller = section.locator("table").locator("..");
	const centre = async (l: Locator) => {
		const b = await l.boundingBox();
		return b ? b.x + b.width / 2 : Number.NaN;
	};
	const pill = bubble.locator("span").first();
	expect(
		Math.abs((await centre(pill)) - (await centre(scroller))),
	).toBeLessThanOrEqual(3);
	const box = await bubble.boundingBox();
	if (isMobile) expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
	// The `@@` text sits level with the bubble (a 40px one on touch too).
	const textMiddle = await section
		.locator("table tr")
		.first()
		.locator("td")
		.first()
		.evaluate((td) => {
			// The text itself, wherever the cell keeps it (its sticky span).
			const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
			let text: Node | null = null;
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				if (n.textContent?.includes("@@")) text = n;
			}
			if (!text) return Number.NaN;
			const range = document.createRange();
			range.selectNodeContents(text);
			const r = range.getBoundingClientRect();
			return r.y + r.height / 2;
		});
	const pillBox = await pill.boundingBox();
	expect(
		Math.abs(textMiddle - ((pillBox?.y ?? 0) + (pillBox?.height ?? 0) / 2)),
	).toBeLessThanOrEqual(3);
	expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
	await bubble.scrollIntoViewIfNeeded();
	await shot(page, "file-bubble-centred", isMobile);
	await bubble.click();
	await expect(section.getByTestId("new-thread")).toContainText("whole file");
});
