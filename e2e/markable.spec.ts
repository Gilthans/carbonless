import type { Page } from "@playwright/test";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import {
	expectNoPageOverflow,
	fileAction,
	fileSection,
	ignoreWhitespace,
	openFiles,
	sideBySide,
} from "./files-ui";
import {
	expect,
	expectEveryUnitMarkable,
	type PrOptions,
	test,
} from "./fixtures";

/*
 * "Every cluster visible in the UI in any view should be individually
 * markable" (the owner, 2026-11-08; docs/product-rules.md): each gallery-
 * like case, on desktop and on a phone, through expectEveryUnitMarkable.
 */

const lines = (n: number, name: string) =>
	Array.from({ length: n }, (_, i) => `${name} ${i + 1}`);
const text = (ls: string[]) => `${ls.join("\n")}\n`;
const edit = (ls: string[], at: Record<number, string | string[] | null>) =>
	text(
		ls.flatMap((line, i) => {
			const e = at[i + 1];
			return e === undefined ? [line] : e === null ? [] : e;
		}),
	);

const main = lines(40, "main");
const tail = lines(5, "tail");

/**
 * src/main.ts: a modified line, two added lines, a removed line, two lines
 * re-indented (whitespace only), a mixed cluster (one real change, one
 * re-indent), a three-line cluster with a thread on its middle line;
 * src/tail.ts loses its final newline. The thread is added per test (on
 * the head's commit).
 */
const fullFixture: PrOptions = {
	base: {
		"src/main.ts": edit(main, { 24: "\tmain 24", 25: "\tmain 25" }),
		"src/tail.ts": text(tail),
	},
	files: [
		{
			message: "every kind of line cluster",
			files: {
				"src/main.ts": edit(main, {
					3: "main 3 changed",
					8: ["main 8", "added a", "added b"],
					14: null,
					20: "main 20 changed",
					21: "  main 21",
					24: "  main 24",
					25: "  main 25",
					33: ["three a", "three b", "three c"],
				}),
				"src/tail.ts": text(tail).slice(0, -1),
			},
		},
	],
};

async function expand(page: Page, path: string) {
	const section = fileSection(page, path);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(
		section
			.locator('[data-testid="diff-line"], [data-testid="ws-cluster"]')
			.first(),
	).toBeVisible();
	return section;
}

test("full diff: every kind of line cluster is markable on its own, unified and side by side, whitespace shown and ignored, a thread open inside one", async ({
	page,
	pr,
	startCrb,
}) => {
	// Four layouts, two files, a write per tick: well past the default.
	test.setTimeout(180_000);
	const p = await pr(fullFixture);
	// A thread on the head's "three b" (new line 35: two lines added above,
	// one removed), the middle line of a three-line cluster.
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((sc) => {
		const graph = sc.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: "src/main.ts", line: 35, subjectType: "LINE" }, [
				threadComment({ login: "rev1", text: "Three?", commit: head }),
			]),
		];
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const reopen = (path: string) => async () => {
		await expand(page, path);
	};
	for (const [side, ws] of [
		[false, false],
		[false, true],
		[true, false],
		[true, true],
	] as const) {
		await sideBySide(page, side);
		await ignoreWhitespace(page, ws);
		for (const path of ["src/main.ts", "src/tail.ts"]) {
			const section = await expand(page, path);
			// The thread's bubble opened: its row sits inside the cluster.
			if (path === "src/main.ts") {
				const bubble = section.locator(
					'[data-testid="thread-bubble"]:not([data-file])',
				);
				await bubble.click();
				await expect(bubble).toHaveAttribute("aria-expanded", "true");
				// Its thread opens between the cluster's lines, in its block.
				await expect(
					section
						.locator("tbody")
						.filter({ hasText: "three a" })
						.getByTestId("files-thread"),
				).toBeVisible();
			}
			const first = !side && !ws;
			await expectEveryUnitMarkable(section, {
				cycle: first ? "full" : "tick",
				reopen: first ? reopen(path) : undefined,
			});
			await expectNoPageOverflow(page);
			await section.getByRole("button", { name: "Collapse file" }).click();
		}
	}
});

test("full diff: file-level clusters (binary, rename only, mode change, empty file added) are markable on their own, next to a line cluster", async ({
	page,
	pr,
	startCrb,
}) => {
	// Four files, a write per tick, and each finishing tick closes the file
	// (the page moves on) to be opened again: past the default.
	test.setTimeout(120_000);
	await pr({
		base: {
			"docs/old.md": "# Notes\n\nNothing changes here.\n",
			"bin/run.sh": "echo run\n",
			"src/edit.ts": text(lines(10, "edit")),
		},
		baseBinary: { "img/logo.bin": new Uint8Array([0, 1, 2, 3, 0, 255]) },
		files: [
			{
				message: "file-level changes",
				rename: { "docs/old.md": "docs/new.md" },
				chmod: { "bin/run.sh": "755" },
				binary: { "img/logo.bin": new Uint8Array([0, 9, 9, 9, 0, 255]) },
				files: {
					"src/empty.ts": "",
					"src/edit.ts": edit(lines(10, "edit"), { 5: "edit 5 changed" }),
				},
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	for (const path of [
		"docs/new.md",
		"bin/run.sh",
		"img/logo.bin",
		"src/empty.ts",
	]) {
		const section = fileSection(page, path);
		await section.getByRole("button", { name: "Expand file" }).click();
		await expect(
			section.getByRole("checkbox", { name: "Mark cluster reviewed" }),
		).toBeVisible();
		await expectEveryUnitMarkable(section, {
			reopen: async () => {
				await section.getByRole("button", { name: "Expand file" }).click();
				await expect(
					section.getByRole("checkbox", { name: "Mark cluster reviewed" }),
				).toBeVisible();
			},
		});
		await section.getByRole("button", { name: "Collapse file" }).click();
	}
});

/**
 * For a step that waits on git in crb's child processes (the head check's
 * fetch, the engine's answer, another patch set's snapshot): on a loaded
 * machine these pass the expects' 10 s default; a missing answer still fails.
 */
const GIT_WAIT = { timeout: 30_000 };

const core = lines(40, "core");

/**
 * PS1 (`ps1` on main's core.ts) marked reviewed in full, then `ps2`
 * pushed and viewed: the since view from PS1. Returns core.ts's section.
 */
async function sinceView(
	page: Page,
	url: string,
	moveHead: (c: { message: string; files: Record<string, string> }) => string,
	ps2: string,
	path = "src/core.ts",
) {
	await openFiles(page, url);
	const section = fileSection(page, path);
	await fileAction(section, "Mark remaining reviewed");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	moveHead({ message: "PS2", files: { [path]: ps2 } });
	await page.reload();
	await expect(page.getByTestId("ps-tail")).toHaveAttribute(
		"data-state",
		"head",
		GIT_WAIT,
	);
	await page
		.getByTestId("head-toast")
		.getByRole("button", { name: "View" })
		.click();
	await expect(
		section
			.locator('[data-testid="since-chips"] [data-testid="kind-chip"]')
			.first(),
	).toBeVisible(GIT_WAIT);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.getByTestId("diff-line").first()).toBeVisible();
	return section;
}

test("since view: a reworked cluster and a new one are markable on their own; an earlier patch set is locked and says so", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr({
		base: { "src/core.ts": text(core) },
		files: [
			{
				message: "PS1",
				files: {
					"src/core.ts": edit(core, { 5: "core 5 v1", 30: "core 30 v1" }),
				},
			},
		],
	});
	const s = await startCrb();
	const section = await sinceView(
		page,
		s.url,
		p.moveHead,
		edit(core, { 5: "core 5 v2", 15: "core 15 new", 30: "core 30 v1" }),
	);
	await expect(section.getByTestId("cluster-kind")).toHaveCount(2);
	await expectEveryUnitMarkable(section);
	await expectNoPageOverflow(page);

	// PS1, as reviewed: read-only, with its chip.
	await page.keyboard.press("Control+[");
	// 0.2-0.4 s on a single run: the default wait. (A loaded phone run
	// once sat on "Loading the diff" past 10 s: reported, not waited out.)
	await expect(page.getByTestId("read-only-note")).toBeVisible();
	const ps1 = fileSection(page, "src/core.ts");
	if ((await ps1.getByRole("button", { name: "Expand file" }).count()) > 0) {
		await ps1.getByRole("button", { name: "Expand file" }).click();
	}
	await expect(ps1.getByTestId("diff-line").first()).toBeVisible();
	await expectEveryUnitMarkable(ps1, { readOnly: true });
});

const block = lines(10, "block");

test("since view: one cluster reworked in three pieces, each markable on its own", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr({
		base: { "src/core.ts": text(core) },
		files: [
			{
				message: "PS1: a block",
				files: { "src/core.ts": edit(core, { 10: ["core 10", ...block] }) },
			},
		],
	});
	const s = await startCrb();
	const section = await sinceView(
		page,
		s.url,
		p.moveHead,
		edit(core, {
			10: [
				"core 10",
				...block.map((l, i) => ([1, 5, 8].includes(i) ? `${l} v2` : l)),
			],
		}),
	);
	await expectEveryUnitMarkable(section, { cycle: "tick" });
});

test("since view: a reverted piece and a gone block are markable on their own", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr({
		base: { "src/core.ts": text(core) },
		files: [
			{
				message: "PS1",
				files: {
					"src/core.ts": edit(core, {
						5: "core 5 v1",
						20: ["core 20", "added x", "added y"],
						33: "core 33 v1",
					}),
				},
			},
		],
	});
	const s = await startCrb();
	const section = await sinceView(
		page,
		s.url,
		p.moveHead,
		// Line 5 reworked; x and y reverted; line 33 back to the base's.
		edit(core, { 5: "core 5 v2" }),
	);
	await expectEveryUnitMarkable(section, { cycle: "tick" });
});

/*
 * The rr-pieces gallery case's shape (#33), synthetic: PS1 adds a function
 * and a guard and reworks another function's body in two changes; PS2
 * edits the added function at three lines, takes the guard out again,
 * and cuts the reworked body down to the line PS1 added.
 */
const money = {
	base: text([
		"export function parse(s: string): number {",
		'  const [a, b] = s.split("=");',
		"  return Number(b ?? a);",
		"}",
		"",
		"export function show(n: number): string {",
		"  const fixed = n.toFixed(4);",
		"  const padded = fixed.padStart(10);",
		'  const sep = " | ";',
		"  const out = sep + padded;",
		"  return out;",
		"}",
	]),
	ps1: text([
		"export function parse(s: string): number {",
		'  const [a, b] = s.split("=");',
		"  if (a === undefined) throw new Error(s);",
		"  if (Number.isNaN(Number(b))) throw new Error(s);",
		"  return Number(b ?? a);",
		"}",
		"",
		"export function amount(n: number, c: string): string {",
		'  const digits = c === "JPY" ? 0 : 2;',
		'  const sign = n < 0 ? "-" : "";',
		"  const abs = Math.abs(n);",
		"  const whole = Math.floor(abs).toString();",
		'  const grouped = whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");',
		"  const cents = (abs % 1).toFixed(digits).slice(1);",
		"  return sign + grouped + cents;",
		"}",
		"",
		"export function show(n: number): string {",
		"  const fixed = n.toFixed(2);",
		"  const padded = fixed.padStart(12);",
		'  console.debug("show");',
		'  const sep = " | ";',
		'  const out = amount(n, "EUR");',
		"  return out;",
		"}",
	]),
	ps2: text([
		"export function parse(s: string): number {",
		'  const [a, b] = s.split("=");',
		"  return Number(b ?? a);",
		"}",
		"",
		"export function amount(n: number, c: string): string {",
		'  const digits = c === "JPY" || c === "KRW" ? 0 : 2;',
		'  const sign = n < 0 ? "-" : "";',
		"  const abs = Math.abs(n);",
		"  const whole = Math.floor(abs).toString();",
		'  const grouped = whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, " ");',
		"  const cents = (abs % 1).toFixed(digits).slice(1);",
		'  return (sign + grouped + cents + " " + c).trim();',
		"}",
		"",
		"export function show(n: number): string {",
		'  const out = amount(n, "EUR");',
		"  return out;",
		"}",
	]),
};

test("since view: the rr-pieces shape (a cluster in three pieces, a removal-only piece inside a cluster, a reverted piece), each markable on its own", async ({
	page,
	pr,
	startCrb,
}) => {
	// Every unit ticked, unticked, crossed off and undone, then a reload:
	// a write per step, past the default on a loaded machine.
	test.setTimeout(90_000);
	const p = await pr({
		base: { "src/money.ts": money.base },
		files: [{ message: "PS1", files: { "src/money.ts": money.ps1 } }],
	});
	const s = await startCrb();
	const section = await sinceView(
		page,
		s.url,
		p.moveHead,
		money.ps2,
		"src/money.ts",
	);
	// The guard taken out again is chipped "reverted" (beside its "gone").
	await expect(
		section.locator(
			'[data-testid="cluster-kind"] [data-testid="kind-chip"][data-kind="reverted"]',
		),
	).not.toHaveCount(0);
	await expectEveryUnitMarkable(section, {
		reopen: async () => {
			await section.getByRole("button", { name: "Expand file" }).click();
			await expect(section.getByTestId("diff-line").first()).toBeVisible();
		},
	});
});
