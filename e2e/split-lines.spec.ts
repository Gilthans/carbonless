import type { Locator, Page } from "@playwright/test";
import { groupMarks } from "../src/web/files/wordDiff";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import {
	expectNoPageOverflow,
	fileAction,
	fileSection,
	openFiles,
	sideBySide,
} from "./files-ui";
import {
	expect,
	expectEveryUnitMarkable,
	type PrOptions,
	test,
} from "./fixtures";

/**
 * A line split into several, or several joined into one (CAR-130): the one
 * line and its run read as one group, a bracket in the gutter ties their
 * rows (unified: all of them; side by side: down the run's side), the
 * group's label names each line's number cell, and only text that really
 * changed is marked. Spec:
 * docs/superpowers/specs/2026-11-24-split-joined-lines-design.md. Made-up
 * code throughout.
 */
const text = (lines: string[]) => `${lines.join("\n")}\n`;

/** The pure split: line 3 becomes five lines, nothing else changes. */
const SPLIT = "split/loader.py";
const SPLIT_OLD = text([
	"import os",
	"",
	"def load(path, retries=3, timeout=30):",
	"    return open(path)",
]);
const SPLIT_NEW = text([
	"import os",
	"",
	"def load(",
	"    path,",
	"    retries=3,",
	"    timeout=30",
	"):",
	"    return open(path)",
]);

/** The split with one new trailing comma. */
const COMMA = "split/fetch.py";
const COMMA_OLD = text([
	"import net",
	"",
	"def fetch(url, retries=3, timeout=30):",
	"    return net.get(url)",
]);
const COMMA_NEW = text([
	"import net",
	"",
	"def fetch(",
	"    url,",
	"    retries=3,",
	"    timeout=30,",
	"):",
	"    return net.get(url)",
]);

/** CAR-221's shape: a comment grew and wrapped onto a second line. */
const WRAP = "split/scene.ts";
const WRAP_OLD = text([
	"export function draw(scene: Scene) {",
	"  // Uses the camera's own matrix, set once per frame.",
	"  return scene.render();",
	"}",
]);
const WRAP_NEW = text([
	"export function draw(scene: Scene) {",
	"  // Uses the camera's own matrix, not the light's .project(): it",
	"  // is set once per frame.",
	"  return scene.render();",
	"}",
]);

/** The join: a call chain onto one line, its argument changed. */
const JOIN = "split/cart.js";
const JOIN_OLD = text([
	"import { price, sum } from './math';",
	"",
	"const total = items",
	"  .map(price)",
	"  .reduce(sum, 0);",
	"export default total;",
]);
const JOIN_NEW = text([
	"import { price, sum } from './math';",
	"",
	"const total = items.map(price).reduce(sum, 1);",
	"export default total;",
]);

const fixture: PrOptions = {
	base: {
		[SPLIT]: SPLIT_OLD,
		[COMMA]: COMMA_OLD,
		[WRAP]: WRAP_OLD,
		[JOIN]: JOIN_OLD,
	},
	files: [
		{
			message: "Split and join lines",
			files: {
				[SPLIT]: SPLIT_NEW,
				[COMMA]: COMMA_NEW,
				[WRAP]: WRAP_NEW,
				[JOIN]: JOIN_NEW,
			},
		},
	],
};

/**
 * The rows as shown with their bracket pieces, top to bottom: a changed
 * line's row as `old/new:` and its pieces (`L`/`R` by the code cell's side,
 * then where it sits), another row (a thread's, a phone's bubble row) by
 * its test id, when it holds a piece. Context rows are left out.
 */
const bracketRows = (section: Locator) =>
	section
		.locator('tr[data-testid="diff-line"]')
		.first()
		.waitFor()
		.then(() =>
			section.locator("table tr").evaluateAll((rows) =>
				rows.flatMap((tr) => {
					const pieces = [
						...tr.querySelectorAll('[data-testid="group-bracket"]'),
					].map((el) => {
						const side = el.closest("td")?.getAttribute("data-side");
						const s = side === "LEFT" ? "L" : side === "RIGHT" ? "R" : "";
						return `${s}${el.getAttribute("data-group-at")}`;
					});
					const id = tr.getAttribute("data-testid");
					if (id === "diff-line") {
						if (tr.getAttribute("data-kind") === "context") return [];
						const old = tr.getAttribute("data-old-no") ?? "";
						const nu = tr.getAttribute("data-new-no") ?? "";
						return [`${old}/${nu}:${pieces.join(",")}`];
					}
					return pieces.length > 0 ? [`${id}:${pieces.join(",")}`] : [];
				}),
			),
		);

/** Each code cell's marked text on `side`, joined per line; lines without marks left out. */
const marked = (scope: Locator, side: "LEFT" | "RIGHT") =>
	scope
		.locator(`td[data-testid="code"][data-side="${side}"]`)
		.evaluateAll((cells) =>
			cells
				.map((cell) =>
					Array.from(
						cell.querySelectorAll("[data-word]"),
						(w) => w.textContent,
					).join(""),
				)
				.filter((t) => t.length > 0),
		);

async function expand(section: Locator) {
	// The file's toggle first (a page still loading has neither), then open it.
	const toggle = section
		.getByRole("button", {
			name: /^(Expand|Collapse) file$/,
		})
		.first();
	await expect(toggle).toBeVisible();
	if ((await toggle.getAttribute("aria-label")) === "Expand file")
		await toggle.click();
	await expect(
		section.locator('tr[data-testid="diff-line"]').first(),
	).toBeVisible();
	return section;
}

/** The number cells named by `label`: in their accessible name and their title. */
/** The number cells named by a group label. */
const labelledCells = (section: Locator, label: string | RegExp) =>
	section
		.locator('td[data-testid="old"], td[data-testid="new"]')
		.filter({ hasText: label });

/**
 * The number cells named by `label`: in their accessible name, and in
 * their pick button's accessible description (what focus announces).
 */
async function expectLabelled(section: Locator, label: string, count: number) {
	const cells = labelledCells(section, label);
	await expect(cells).toHaveCount(count);
	for (const cell of await cells.all()) {
		await expect(cell).toHaveAccessibleName(new RegExp(label));
		await expect(cell.locator("button[data-pick]")).toHaveAccessibleDescription(
			label,
		);
	}
	// Every piece of the bracket says it too, and is hidden from readers.
	const pieces = section.getByTestId("group-bracket");
	for (const piece of await pieces.all()) {
		await expect(piece).toHaveAttribute("title", label);
		await expect(piece).toHaveAttribute("aria-hidden", "true");
	}
}

/**
 * Every `through` piece in `rows` shows: nothing (a thread's card) is over
 * its middle.
 */
async function expectThroughShown(rows: Locator) {
	const pieces = rows.locator('[data-group-at="through"]');
	expect(await pieces.count()).toBeGreaterThan(0);
	for (const piece of await pieces.all()) {
		await piece.scrollIntoViewIfNeeded();
		await piece.evaluate((el) =>
			el.scrollIntoView({ block: "center", inline: "nearest" }),
		);
		// What is over its middle, down to it: nothing that paints (a
		// card's background, a border); a transparent box is fine.
		const over = await piece.evaluate((el) => {
			const r = el.getBoundingClientRect();
			const stack = document.elementsFromPoint(
				r.left + r.width / 2,
				r.top + r.height / 2,
			);
			const at = stack.indexOf(el);
			if (at < 0) return ["not under its own middle"];
			return stack.slice(0, at).flatMap((e) => {
				const css = getComputedStyle(e);
				const clear =
					/rgba\(.*, 0\)|transparent/.test(css.backgroundColor) &&
					css.backgroundImage === "none";
				return clear ? [] : [e.outerHTML.slice(0, 120)];
			});
		});
		expect(over).toEqual([]);
	}
}

/** Each side's code text's left edge, over every changed or context row: one x per side. */
const codeLefts = (section: Locator) =>
	section
		.locator('tr[data-testid="diff-line"] td[data-testid="code"]')
		.evaluateAll((cells) => {
			const out: Record<string, number[]> = {};
			for (const cell of cells) {
				const code = cell.querySelector("[data-code]");
				if (!code) continue;
				const side = cell.getAttribute("data-side") ?? "";
				const key =
					cell.closest("table")?.dataset.view === "unified" ? "all" : side;
				// Its first line box: a wrapped line's later ones start
				// further left, under the sign.
				const x = Math.round(code.getClientRects()[0]?.left ?? -1);
				out[key] = [...new Set([...(out[key] ?? []), x])];
			}
			return out;
		});

const phone = async (page: Page, isMobile: boolean) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
};

for (const view of ["unified", "side-by-side"] as const) {
	const sbs = view === "side-by-side";
	test(`a split or joined line reads as one group under a bracket, only real changes marked (${view})`, async ({
		page,
		pr,
		startCrb,
		isMobile,
	}) => {
		await phone(page, isMobile);
		const p = await pr(fixture);
		const head = p.repo.shas.at(-1) ?? "";
		// A thread on the middle of the split's run (new line 5).
		p.editScenario((s) => {
			const graph = s.prs[p.number]?.graphql;
			if (!graph) throw new Error("no PR in the scenario");
			graph.reviewThreads = [
				reviewThread(
					{ path: SPLIT, line: 5, diffSide: "RIGHT", subjectType: "LINE" },
					[
						threadComment({
							login: "rev1",
							text: "One per line?",
							commit: head,
							diffHunk: "",
						}),
					],
				),
			];
		});
		const s = await startCrb();
		await openFiles(page, s.url);
		await sideBySide(page, sbs);

		// The pure split: the bracket spans the old line and its five new
		// lines; nothing is marked.
		const split = await expand(fileSection(page, SPLIT));
		await expect(split.locator(`table[data-view="${view}"]`)).toBeVisible();
		// A phone's side by side puts a row's bubbles (line 5's thread) in a
		// row of their own under it: inside the group, the bracket runs on.
		const bubbles = sbs && isMobile ? ["bubble-row:through"] : [];
		const splitRows = sbs
			? ["3/3:Rfirst", "/4:Rmid", "/5:Rmid", ...bubbles, "/6:Rmid", "/7:Rlast"]
			: ["3/:Lfirst", "/3:Rmid", "/4:Rmid", "/5:Rmid", "/6:Rmid", "/7:Rlast"];
		await expect.poll(() => bracketRows(split)).toEqual(splitRows);
		await expectLabelled(split, "Line 3 split into 3–7", 6);
		// The bracket moves no code: a group row's code starts where a
		// context row's does, on each side.
		for (const xs of Object.values(await codeLefts(split)))
			expect(xs).toHaveLength(1);
		// The label on the number: a tooltip on keyboard focus (desktop);
		// on a phone a tap picks the line and a long press (Android's
		// contextmenu) shows the label without picking.
		const four = split
			.locator(
				'tr[data-testid="diff-line"][data-new-no="4"] td[data-testid="new"]',
			)
			.locator("button[data-pick]");
		// (aria-hidden: the button's description says it already.)
		const tip = page.locator('[role="tooltip"]:visible');
		if (isMobile) {
			await four.tap();
			await expect(four).toHaveAttribute("aria-pressed", "true");
			await four.tap();
			await expect(four).toHaveAttribute("aria-pressed", "false");
			await four.dispatchEvent("contextmenu");
			await expect(tip).toHaveText("Line 3 split into 3–7");
			await expect(four).toHaveAttribute("aria-pressed", "false");
		} else {
			await page.keyboard.press("Shift");
			await four.focus();
			await expect(tip).toHaveText("Line 3 split into 3–7");
		}
		await page.keyboard.press("Escape");
		await expect(
			split.getByRole("img", { name: "Marking changed words" }),
		).toHaveCount(0);
		expect(await marked(split, "LEFT")).toEqual([]);
		expect(await marked(split, "RIGHT")).toEqual([]);

		// The thread on line 5 opens under its line; the bracket runs on past it.
		await split.getByRole("button", { name: "1 comment on line 5" }).click();
		await expect(split.getByTestId("thread-row")).toContainText(
			"One per line?",
		);
		const at = splitRows.indexOf("/5:Rmid") + 1 + bubbles.length;
		await expect
			.poll(() => bracketRows(split))
			.toEqual([
				...splitRows.slice(0, at),
				"thread-row:through",
				...splitRows.slice(at),
			]);
		// The bracket shows beside the card, never under it, where the diff
		// has room; on a phone the card keeps the row's width (a narrower
		// one is unreadable) and the bracket runs on under it, shown beside
		// the bubble row's bubbles.
		if (!isMobile) await expectThroughShown(split.getByTestId("thread-row"));
		if (sbs && isMobile)
			await expectThroughShown(split.getByTestId("bubble-row"));
		expect(
			await split
				.locator('tr[data-testid="diff-line"][data-new-no="5"]')
				.evaluate((tr) => {
					let next = tr.nextElementSibling;
					if (next?.getAttribute("data-testid") === "bubble-row")
						next = next.nextElementSibling;
					return next?.getAttribute("data-testid");
				}),
		).toBe("thread-row");
		await expectNoPageOverflow(page);

		// The comma split: only the new comma.
		const comma = await expand(fileSection(page, COMMA));
		await expectLabelled(comma, "Line 3 split into 3–7", 6);
		await expect.poll(() => marked(comma, "RIGHT")).toEqual([","]);
		expect(await marked(comma, "LEFT")).toEqual([]);

		// CAR-221's shape: the added words on both lines, nothing else.
		const wrap = await expand(fileSection(page, WRAP));
		await expect
			.poll(() => bracketRows(wrap))
			.toEqual(
				sbs ? ["2/2:Rfirst", "/3:Rlast"] : ["2/:Lfirst", "/2:Rmid", "/3:Rlast"],
			);
		await expectLabelled(wrap, "Line 2 split into 2–3", 3);
		await expect
			.poll(() => marked(wrap, "RIGHT"))
			.toEqual(["not the light's .project(): it", "is "]);
		expect(await marked(wrap, "LEFT")).toEqual([]);

		// The join: three old lines to one, the bracket down the old side; 0 → 1.
		const join = await expand(fileSection(page, JOIN));
		await expect
			.poll(() => bracketRows(join))
			.toEqual(
				sbs
					? ["3/3:Lfirst", "4/:Lmid", "5/:Llast"]
					: ["3/:Lfirst", "4/:Lmid", "5/:Lmid", "/3:Rlast"],
			);
		await expectLabelled(join, "Lines 3–5 joined into 3", 4);
		await expect.poll(() => marked(join, "LEFT")).toEqual(["0"]);
		await expect.poll(() => marked(join, "RIGHT")).toEqual(["1"]);
		await expectNoPageOverflow(page);

		// Every cluster is still markable on its own.
		await expand(split);
		await expect(
			split.getByRole("checkbox", { name: "Mark cluster reviewed" }),
		).toBeVisible();
		await expectEveryUnitMarkable(split);
	});
}

/** A seeded random (the same groups every run). */
function seeded(seed: number) {
	let s = seed;
	return () => {
		s = (s * 1103515245 + 12345) % 2 ** 31;
		return s / 2 ** 31;
	};
}

/**
 * 24 large splits in hunks of their own: each old line ~830 characters
 * of short tokens, split into 20 indented lines with ~30% of the tokens
 * changed. Marking each takes several milliseconds, so the render's budget
 * runs out after a few and the rest are marked off the render path.
 */
function bigGroups() {
	const random = seeded(7);
	const pick = <T>(xs: readonly T[]) =>
		xs[Math.floor(random() * xs.length)] as T;
	const letters = [..."abcdefghijklmnopqrstuvwxyz"];
	const words = letters.concat(letters.map((c) => `${c}e`));
	const seps = [..."().,=;+"];
	const token = () => pick(words) + pick(seps);
	return Array.from({ length: 24 }, () => {
		const segments = Array.from({ length: 20 }, () => {
			const tokens: string[] = [];
			let length = 0;
			while (length < 40) {
				const t = token();
				tokens.push(t);
				length += t.length;
			}
			return tokens;
		});
		return {
			one: segments.map((s) => s.join("")).join(" "),
			run: segments.map(
				(s) => `    ${s.map((t) => (random() < 0.3 ? token() : t)).join("")}`,
			),
		};
	});
}
const BIG = bigGroups();
const BIG_PATH = "split/big-splits.txt";
/** Each group between ten context lines: a hunk of its own. */
const bigFile = (lines: (g: (typeof BIG)[number]) => string[]) =>
	text(
		BIG.flatMap((g, k) => [
			...Array.from({ length: 10 }, (_, i) => `ctx ${k}.${i}`),
			...lines(g),
		]).concat(["ctx end"]),
	);

/** Each group line's marked text, by its text (what groupMarks says). */
const bigMarks = (() => {
	const byText = new Map<string, string>();
	for (const g of BIG) {
		const m = groupMarks({
			one: g.one,
			run: g.run,
			oneIsOld: true,
			markdown: false,
		});
		const cut = (t: string, ms: readonly (readonly [number, number])[]) =>
			ms.map(([from, to]) => t.slice(from, to)).join("");
		byText.set(g.one, cut(g.one, m.one));
		g.run.forEach((l, i) => {
			byText.set(l, cut(l, m.run[i] ?? []));
		});
	}
	return byText;
})();

/**
 * Each group as shown (from its `first` piece to its `last`): how many of
 * its lines' code cells are busy, of how many.
 */
const groupsBusy = (section: Locator) =>
	section.locator("table tr").evaluateAll((rows) => {
		const out: { busy: number; of: number }[] = [];
		let open: { busy: number; of: number } | null = null;
		for (const tr of rows) {
			if (tr.getAttribute("data-testid") !== "diff-line") continue;
			const at = tr
				.querySelector('[data-testid="group-bracket"]')
				?.getAttribute("data-group-at");
			if (!at) continue;
			if (at === "first") open = { busy: 0, of: 0 };
			if (!open) continue;
			for (const cell of tr.querySelectorAll('td[data-testid="code"]')) {
				if (cell.hasAttribute("data-blank")) continue;
				open.of += 1;
				if (cell.getAttribute("aria-busy") === "true") open.busy += 1;
			}
			if (at === "last") {
				out.push(open);
				open = null;
			}
		}
		return out;
	});

/** Each group line's shown marked text, by its text. */
const shownMarks = (section: Locator) =>
	section
		.locator('td[data-testid="code"]')
		.evaluateAll((cells) =>
			cells.map((cell) => [
				cell.querySelector("[data-code]")?.textContent ?? "",
				Array.from(
					cell.querySelectorAll("[data-word]"),
					(w) => w.textContent,
				).join(""),
			]),
		);

test("a group's lines are all pending while its marks are held, then all marked", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	// The page is heavy and marking takes a while under load.
	test.slow();
	await phone(page, isMobile);
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/assets/wordWorker-*.js", async (route) => {
		await held;
		await route.fulfill({ response: await route.fetch() });
	});
	await pr({
		base: { [BIG_PATH]: bigFile((g) => [g.one]) },
		files: [
			{
				message: "Split long lines",
				files: { [BIG_PATH]: bigFile((g) => g.run) },
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	await sideBySide(page, false);
	const section = await expand(fileSection(page, BIG_PATH));
	const spinners = section.getByRole("img", { name: "Marking changed words" });
	await expect(spinners.first()).toBeVisible();
	// A group is pending or marked as a whole: never some of its lines plain.
	const groups = await groupsBusy(section);
	expect(groups.length).toBeGreaterThan(0);
	for (const g of groups) expect([0, g.of]).toContain(g.busy);
	expect(groups.filter((g) => g.busy > 0).length).toBeGreaterThanOrEqual(5);
	await expectNoPageOverflow(page);
	release();
	await expect(spinners).toHaveCount(0, { timeout: 30_000 });
	await expect(
		section.getByRole("img", { name: "Couldn't mark changed words" }),
	).toHaveCount(0);
	for (const g of await groupsBusy(section)) expect(g.busy).toBe(0);
	for (const [line, words] of await shownMarks(section)) {
		const want = bigMarks.get(line as string);
		if (want !== undefined) expect(words, line as string).toBe(want);
	}
	// Side by side keeps them: nothing to wait for.
	await sideBySide(page, true);
	await expect(
		section.locator('table[data-view="side-by-side"]'),
	).toBeVisible();
	await expect(spinners).toHaveCount(0);
	for (const g of await groupsBusy(section)) expect(g.busy).toBe(0);
});

/** For a step that waits on git in crb's child processes (markable.spec.ts). */
const GIT_WAIT = { timeout: 30_000 };

const core = Array.from({ length: 12 }, (_, i) =>
	i === 5 ? "def load(src):" : `x${i + 1} = ${i + 1}`,
);
const LOAD = "def load(path, retries=3, timeout=30):";
const LOAD_SPLIT = [
	"def load(",
	"    path,",
	"    retries=3,",
	"    timeout=30",
	"):",
];

test("the since view groups a split made after the compared patch set; against the base it isn't one", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await phone(page, isMobile);
	const path = "src/core.py";
	// Line 6 rewritten in PS1, then split in PS2: a reworked cluster, the
	// interdiff's one piece (a line PS1 added is a gone cluster's, a piece
	// of its own, so it couldn't group with PS2's lines).
	const with_ = (lines: string[]) =>
		text([...core.slice(0, 5), ...lines, ...core.slice(6)]);
	const p = await pr({
		base: { [path]: text(core) },
		files: [{ message: "PS1", files: { [path]: with_([LOAD]) } }],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	await sideBySide(page, false);
	const section = fileSection(page, path);
	await fileAction(section, "Mark remaining reviewed");
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	p.moveHead({ message: "PS2", files: { [path]: with_(LOAD_SPLIT) } });
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
	await expand(section);
	// Since PS1: PS1's line 6 split into PS2's 6–10, one group.
	await expect
		.poll(() => bracketRows(section))
		.toEqual([
			"6/:Lfirst",
			"/6:Rmid",
			"/7:Rmid",
			"/8:Rmid",
			"/9:Rmid",
			"/10:Rlast",
		]);
	await expectLabelled(section, "Line 6 split into 6–10", 6);
	expect(await marked(section, "RIGHT")).toEqual([]);
	await expectNoPageOverflow(page);

	// Against the base (`def load(src):`, too unlike them): no group.
	const full = new URL(page.url());
	full.searchParams.set("from", "branch");
	await page.goto(full.toString());
	await expect(
		page
			.getByTestId("ps-node-branch")
			.getByRole("button", { name: "comparison base" }),
	).toBeVisible();
	const fullSection = await expand(fileSection(page, path));
	await expect
		.poll(() => bracketRows(fullSection))
		.toEqual(expect.not.arrayContaining([expect.stringMatching(/:.+$/)]));
	await expect(fullSection.getByTestId("group-bracket")).toHaveCount(0);
	await expect(labelledCells(fullSection, /split into/)).toHaveCount(0);
});

const FIND = "src/find.ts";

test("Find steps through a group's rows in the order shown", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await phone(page, isMobile);
	// A pair, then a split, in one stretch: unified shows −2 +2 −3 +3…+7,
	// GitHub's order −2 −3 +2…
	await pr({
		base: {
			[FIND]: text([
				"// find",
				"const nameVal = load(user);",
				"const totalVal = sum(firstVal, secondVal, thirdVal);",
				"export {};",
			]),
		},
		files: [
			{
				message: "Find in a group",
				files: {
					[FIND]: text([
						"// find",
						"const nameVal = load(account);",
						"const totalVal = sum(",
						"\tfirstVal,",
						"\tsecondVal,",
						"\tthirdVal,",
						");",
						"export {};",
					]),
				},
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	await sideBySide(page, false);
	const section = await expand(fileSection(page, FIND));
	await expect
		.poll(() => bracketRows(section))
		.toEqual([
			"2/:",
			"/2:",
			"3/:Lfirst",
			"/3:Rmid",
			"/4:Rmid",
			"/5:Rmid",
			"/6:Rmid",
			"/7:Rlast",
		]);
	const bar = page.getByRole("search", { name: "Find in PR" });
	if (isMobile)
		await page.getByRole("button", { name: "Find in PR", exact: true }).click();
	else await page.keyboard.press("ControlOrMeta+f");
	await expect(bar).toBeVisible();
	await page.getByTestId("find-box").fill("Val");
	await expect(page.getByTestId("find-count")).not.toBeEmpty();
	await expect(
		page.getByRole("status", { name: "Searching files…" }),
	).toHaveCount(0);
	const next = bar.getByRole("button", { name: /^Next/ });
	const current = page.locator("tr[data-find-current]");
	// Each hit's row in turn: old line 3 holds four.
	const order = [
		"old 2",
		"new 2",
		"old 3",
		"old 3",
		"old 3",
		"old 3",
		"new 3",
		"new 4",
		"new 5",
		"new 6",
	];
	// Each step's place by the count ("3 of 10", "3/10" on a phone): the
	// first step may move on from a first hit already in view. Ten steps
	// visit every hit once, each on its row.
	const count = page.getByTestId("find-count");
	const place = async () =>
		Number(/^(\d+)/.exec((await count.innerText()).trim())?.[1] ?? "0");
	const seen: number[] = [];
	let was = await place();
	for (let step = 0; step < order.length; step++) {
		await next.click();
		await expect.poll(place).toBe((was % order.length) + 1);
		was = await place();
		seen.push(was);
		const [side, n] = (order[was - 1] ?? "").split(" ");
		await expect(current).toHaveAttribute(`data-${side}-no`, n as string);
		await expect(current).toHaveAttribute(
			"data-kind",
			side === "old" ? "del" : "add",
		);
	}
	expect(seen.toSorted((a, b) => a - b)).toEqual(order.map((_, i) => i + 1));
});
