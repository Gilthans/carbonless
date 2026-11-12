import type { Locator, Page } from "@playwright/test";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import {
	expectNoPageOverflow,
	fileSection,
	openFiles,
	sideBySide,
} from "./files-ui";
import { expect, type PrOptions, test } from "./fixtures";

/**
 * Inline diff step 2 (CAR-30): in a cluster with more lines on one side, a
 * removed line pairs with the added line it's clearly similar to. The pair
 * gets word marks; unified puts the removed line right above its partner,
 * side by side puts the two on one row. Cases 2, 3 and 5 of the spec
 * (docs/superpowers/specs/2026-11-08-inline-diff-step2-design.md; 5
 * verbatim from its appendix), also in the gallery's similarity-pairing PR.
 */
const text = (lines: string[]) => `${lines.join("\n")}\n`;

const COMMENT = "pairing/02-comment-above.ts";
const MIDDLE = "pairing/03-removed-middle.ts";
const HELPER = "pairing/05-helper-above.go";

/** Case 2: old line 11 becomes a comment and its new value (1 removed, 2 added). */
const comment = (value: string, note: boolean) =>
	text([
		"// Request settings.",
		'import { request } from "./http";',
		"",
		"export interface Options {",
		"\turl: string;",
		"\tretries: number;",
		"}",
		"",
		'const base = "https://example.test";',
		"",
		...(note ? ["// seconds before a request gives up"] : []),
		`const timeout = ${value};`,
		"",
		"export function get(path: string) {",
		"\treturn request(base + path, { timeout });",
		"}",
	]);

/** Case 3: the log line between two retries goes (3 removed, 2 added). */
const MIDDLE_OLD = text([
	"export async function load() {",
	"\tconst user = await retry(getUser, 3);",
	'\tlog("fetching orders");',
	"\tconst orders = await retry(getOrders, 3);",
	"\treturn { user, orders };",
	"}",
]);
const MIDDLE_NEW = text([
	"export async function load() {",
	"\tconst user = await retry(getUser, 5);",
	"\tconst orders = await retry(getOrders, 5);",
	"\treturn { user, orders };",
	"}",
]);

/** Case 5, verbatim: a 1/8 cluster whose old doc comment pairs with the 8th added line. */
const HELPER_OLD = text([
	"// IsCacheSkippedForDomain reports whether planning requests for domain must bypass the cache entirely, per the",
	"// skip_cache_domains list of the ff_gpo_planning_cache feature flag.",
	"func IsCacheSkippedForDomain(domain string) bool {",
	"    return domainInList(GetFeatureFlags().Value.SkipCacheDomains, domain)",
	"}",
]);
const HELPER_NEW = text([
	"// flagsOr lets a handler's own flags replace the process-wide ones, so tests can run in parallel.",
	"func flagsOr(flags *PlanningCacheFeatureFlags) PlanningCacheFeatureFlags {",
	"    if flags != nil {",
	"        return *flags",
	"    }",
	"    return GetFeatureFlags()",
	"}",
	"// SkipsCacheFor reports whether planning requests for domain must bypass the cache entirely, per the",
	"// skip_cache_domains list of the ff_gpo_planning_cache feature flag.",
	"func (ff PlanningCacheFeatureFlags) SkipsCacheFor(domain string) bool {",
	"    return domainInList(ff.Value.SkipCacheDomains, domain)",
	"}",
]);

const fixture: PrOptions = {
	base: {
		[COMMENT]: comment("30", false),
		[MIDDLE]: MIDDLE_OLD,
		[HELPER]: HELPER_OLD,
	},
	files: [
		{
			message: "Similarity pairing",
			files: {
				[COMMENT]: comment("60", true),
				[MIDDLE]: MIDDLE_NEW,
				[HELPER]: HELPER_NEW,
			},
		},
	],
};

/**
 * The changed rows as shown, top to bottom: unified, `-text` or `+text`;
 * side by side, `left | right` (a blank cell is empty).
 */
const changedRows = (section: Locator) =>
	section
		.locator(
			'tr[data-testid="diff-line"]:not([data-kind="context"]) td[data-testid="code"]',
		)
		.first()
		.waitFor()
		.then(() =>
			section
				.locator('tr[data-testid="diff-line"]:not([data-kind="context"])')
				.evaluateAll((rows) =>
					rows.map((tr) => {
						const side = (s: string) =>
							tr.querySelector(
								`td[data-testid="code"][data-side="${s}"] [data-code]`,
							)?.textContent ?? "";
						const kind = tr.getAttribute("data-kind");
						if (kind === "del") return `-${side("LEFT")}`;
						if (kind === "add") return `+${side("RIGHT")}`;
						return `${side("LEFT")} | ${side("RIGHT")}`;
					}),
				),
		);

/** The marked runs on a side's code cells within `scope`. */
const marked = (scope: Locator, side: "LEFT" | "RIGHT") =>
	scope
		.locator(`td[data-testid="code"][data-side="${side}"] [data-word]`)
		.allTextContents();

const row = (section: Locator, attr: "old" | "new", n: number) =>
	section.locator(`tr[data-testid="diff-line"][data-${attr}-no="${n}"]`);

/** What sits under a row, past a phone's bubble row. */
const under = (tr: Locator) =>
	tr.evaluate((el) => {
		let next = el.nextElementSibling;
		if (next?.getAttribute("data-testid") === "bubble-row")
			next = next.nextElementSibling;
		return next?.getAttribute("data-testid");
	});

async function expand(page: Page, path: string) {
	const section = fileSection(page, path);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(
		section.locator('tr[data-testid="diff-line"]').first(),
	).toBeVisible();
	return section;
}

const helperAdds = HELPER_NEW.split("\n").slice(0, 8);

const EXPECTED = {
	unified: {
		[COMMENT]: [
			"+// seconds before a request gives up",
			"-const timeout = 30;",
			"+const timeout = 60;",
		],
		[MIDDLE]: [
			"-\tconst user = await retry(getUser, 3);",
			"+\tconst user = await retry(getUser, 5);",
			'-\tlog("fetching orders");',
			"-\tconst orders = await retry(getOrders, 3);",
			"+\tconst orders = await retry(getOrders, 5);",
		],
		[HELPER]: [
			...helperAdds.slice(0, 7).map((l) => `+${l}`),
			`-${HELPER_OLD.split("\n")[0]}`,
			`+${helperAdds[7]}`,
			`-${HELPER_OLD.split("\n")[2]}`,
			`-${HELPER_OLD.split("\n")[3]}`,
			`+${HELPER_NEW.split("\n")[9]}`,
			`+${HELPER_NEW.split("\n")[10]}`,
		],
	},
	"side-by-side": {
		[COMMENT]: [
			" | // seconds before a request gives up",
			"const timeout = 30; | const timeout = 60;",
		],
		[MIDDLE]: [
			"\tconst user = await retry(getUser, 3); | \tconst user = await retry(getUser, 5);",
			'\tlog("fetching orders"); | ',
			"\tconst orders = await retry(getOrders, 3); | \tconst orders = await retry(getOrders, 5);",
		],
		[HELPER]: [
			...helperAdds.slice(0, 7).map((l) => ` | ${l}`),
			`${HELPER_OLD.split("\n")[0]} | ${helperAdds[7]}`,
			`${HELPER_OLD.split("\n")[2]} | ${HELPER_NEW.split("\n")[9]}`,
			`${HELPER_OLD.split("\n")[3]} | ${HELPER_NEW.split("\n")[10]}`,
		],
	},
} as const;

for (const view of ["unified", "side-by-side"] as const) {
	test(`a similarity pair reads together and is marked (${view})`, async ({
		page,
		pr,
		startCrb,
		isMobile,
	}) => {
		if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
		const p = await pr(fixture);
		const head = p.repo.shas.at(-1) ?? "";
		p.editScenario((s) => {
			const graph = s.prs[7]?.graphql;
			if (!graph) throw new Error("no PR in the scenario");
			graph.reviewThreads = [
				reviewThread(
					{ path: COMMENT, line: 11, diffSide: "LEFT", subjectType: "LINE" },
					[
						threadComment({
							login: "rev1",
							text: "Why 60?",
							commit: head,
							diffHunk: "",
						}),
					],
				),
			];
		});
		const s = await startCrb();
		await openFiles(page, s.url);
		await sideBySide(page, view === "side-by-side");

		// Case 2: the old line moves down beside its new version; 30 → 60.
		let section = await expand(page, COMMENT);
		await expect(section.locator(`table[data-view="${view}"]`)).toBeVisible();
		await expect
			.poll(() => changedRows(section))
			.toEqual(EXPECTED[view][COMMENT]);
		await expect.poll(() => marked(section, "LEFT")).toEqual(["30"]);
		await expect.poll(() => marked(section, "RIGHT")).toEqual(["60"]);
		// The thread on old line 11 opens under that line, in its moved row.
		const old11 = row(section, "old", 11);
		await section
			.getByRole("button", { name: "1 comment on old line 11" })
			.click();
		const thread = section.getByTestId("thread-row");
		await expect(thread).toContainText("Why 60?");
		expect(await under(old11)).toBe("thread-row");
		if (view === "unified") {
			// Under the removed line, between the comment's row and 60's.
			await expect(old11).toHaveAttribute("data-kind", "del");
			expect(
				await old11.evaluate((tr) =>
					tr.previousElementSibling?.getAttribute("data-new-no"),
				),
			).toBe("11");
		} else {
			await expect(old11).toHaveAttribute("data-new-no", "12");
		}
		await expectNoPageOverflow(page);

		// Case 3: the retries pair; the log line gets its own row; 3 → 5.
		section = await expand(page, MIDDLE);
		await expect
			.poll(() => changedRows(section))
			.toEqual(EXPECTED[view][MIDDLE]);
		await expect.poll(() => marked(section, "LEFT")).toEqual(["3", "3"]);
		await expect.poll(() => marked(section, "RIGHT")).toEqual(["5", "5"]);

		// Case 5: the old doc comment pairs with the 8th added line; only the
		// names are marked on it.
		section = await expand(page, HELPER);
		await expect
			.poll(() => changedRows(section))
			.toEqual(EXPECTED[view][HELPER]);
		await expect
			.poll(() => marked(row(section, "old", 1), "LEFT"))
			.toEqual(["IsCacheSkippedForDomain"]);
		await expect
			.poll(() => marked(row(section, "new", 8), "RIGHT"))
			.toEqual(["SkipsCacheFor"]);
		await expectNoPageOverflow(page);
	});
}
