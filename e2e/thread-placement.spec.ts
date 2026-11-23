import type { Locator, Page, Route } from "@playwright/test";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import { fileSection, openFiles } from "./files-ui";
import {
	expect,
	installClock,
	type Pr,
	type PrOptions,
	test,
} from "./fixtures";

/**
 * CAR-271: a failed GET /placements. The page asks again by itself (with
 * backoff) and recovers with no reload; a spinner, never "place unknown",
 * until the failure has repeated; and a thread made on the viewed head,
 * shown at its own line, never reads "place unknown".
 */
const NEW = "src/enricher.ts";
const OLD = "src/other.ts";
const lines = (n: number, p: string) =>
	`${Array.from({ length: n }, (_, i) => `export const ${p}${i + 1} = ${i + 1};`).join("\n")}\n`;
/** The PR adds NEW; its head changes only OLD after that. */
const fixture: PrOptions = {
	base: { [OLD]: lines(10, "o") },
	files: [
		{
			message: "add enricher",
			files: { [NEW]: lines(60, "e"), [OLD]: lines(12, "o") },
		},
		{ message: "more", files: { [OLD]: lines(14, "o") } },
	],
};
const PLACEMENTS = /\/api\/r\/[^/]+\/placements\?/;

/** The PR with a thread on NEW line 10 made on the earlier commit, and one on line 40 made on the head. */
async function setup(pr: (opts?: PrOptions) => Promise<Pr>) {
	const p = await pr(fixture);
	const head = p.repo.shas.at(-1) ?? "";
	const older = p.repo.shas.at(-2) ?? "";
	p.editScenario((s) => {
		const graph = s.prs[p.number]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: NEW, line: 10, subjectType: "LINE" }, [
				threadComment({
					login: "rev1",
					text: "From before",
					commit: older,
					diffHunk: "",
				}),
			]),
			reviewThread({ path: NEW, line: 40, subjectType: "LINE" }, [
				threadComment({
					login: "rev1",
					text: "On the head",
					commit: head,
					diffHunk: "",
				}),
			]),
		];
	});
	return p;
}

const row = (section: Locator, n: number) =>
	section.locator(`tr[data-testid="diff-line"][data-new-no="${n}"]`);

async function expandNew(page: Page) {
	const section = fileSection(page, NEW);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.getByTestId("diff-line").first()).toBeVisible();
	return section;
}

/** Opens the bubble on `n` and gives its card (`text`). */
async function card(section: Locator, n: number, text: string) {
	await row(section, n)
		.getByRole("button", { name: /1 comment/ })
		.click();
	const c = section.getByTestId("files-thread").filter({ hasText: text });
	await expect(c).toBeVisible();
	return c;
}

async function comment(page: Page, section: Locator, n: number, text: string) {
	await row(section, n).getByTestId("new").click();
	await page
		.getByTestId("selection-bar")
		.getByRole("button", { name: "Comment" })
		.click();
	const box = section
		.getByTestId("new-thread")
		.getByRole("textbox", { name: "Comment" });
	await box.fill(text);
	await box.press("Control+Enter");
	const c = section.getByTestId("files-thread").filter({ hasText: text });
	await expect(c).toBeVisible();
	return c;
}

test("CAR-271: placements that failed come back by themselves, no reload; a thread posted on the head never reads 'place unknown'", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/500/);
	await setup(pr);
	const s = await startCrb();
	let failing = true;
	let asked = 0;
	await page.route(PLACEMENTS, (route) => {
		asked++;
		return failing
			? route.fulfill({ status: 500, json: { error: "boom" } })
			: route.continue();
	});
	await installClock(page);
	await openFiles(page, s.url);
	const section = await expandNew(page);
	const failed = page.getByTestId("placements-failed");
	// Failed after its tries: the earlier commit's thread listed as unknown.
	await expect(failed).toBeVisible();
	await expect(
		failed.getByTestId("unplaced-thread").filter({ hasText: "From before" }),
	).toHaveAttribute("data-fate", "unknown");
	// The head's own thread is shown at its line: nothing to place.
	const onHead = await card(section, 40, "On the head");
	await expect(onHead.getByTestId("placement-error")).toHaveCount(0);
	// No reload from here on: a mark the page would lose.
	await page.evaluate(() => {
		(window as unknown as { crb271?: number }).crb271 = 1;
	});
	// The server is back; a comment posted on the head meanwhile.
	failing = false;
	const posted = await comment(page, section, 32, "made right here");
	await expect(posted.getByTestId("placement-error")).toHaveCount(0);
	const before = asked;
	// The page asks again by itself (backoff: well within 30 s).
	await page.clock.fastForward(30_000);
	await expect(failed).toHaveCount(0);
	expect(asked).toBeGreaterThan(before);
	// The earlier commit's thread is placed at its line again.
	await expect(
		row(section, 10).getByRole("button", { name: /1 comment/ }),
	).toBeVisible();
	await expect(page.getByTestId("placement-error")).toHaveCount(0);
	expect(
		await page.evaluate(
			() => (window as unknown as { crb271?: number }).crb271,
		),
	).toBe(1);
});

test("CAR-271: placements that keep failing spin in the chip's slot through the tries, then say so, and Retry works once the server is back", async ({
	page,
	pr,
	startCrb,
	expectConsoleError,
}) => {
	expectConsoleError(/500/);
	await setup(pr);
	const s = await startCrb();
	let asked = 0;
	let releaseThird = () => {};
	const third = new Promise<void>((r) => {
		releaseThird = r;
	});
	/** Once the server is back: each ask held until `releaseBack`. */
	let back: Promise<void> | null = null;
	let releaseBack = () => {};
	const fail = (route: Route) =>
		route.fulfill({ status: 500, json: { error: "boom" } });
	await page.route(PLACEMENTS, async (route) => {
		asked++;
		if (back !== null) {
			await back;
			return route.continue();
		}
		if (asked === 3) await third;
		return fail(route);
	});
	await openFiles(page, s.url);
	const section = await expandNew(page);
	// Two failures in, the third ask held: still placing, never unknown.
	await expect.poll(() => asked).toBeGreaterThanOrEqual(3);
	const onHead = await card(section, 40, "On the head");
	await expect(
		onHead.getByRole("status", { name: "Placing threads" }),
	).toBeVisible();
	await expect(page.getByTestId("placement-error")).toHaveCount(0);
	await expect(page.getByTestId("placements-failed")).toHaveCount(0);
	// The third fails too: now it says so.
	releaseThird();
	const failed = page.getByTestId("placements-failed");
	await expect(failed).toBeVisible();
	await expect(
		failed.getByTestId("unplaced-thread").filter({ hasText: "From before" }),
	).toContainText("Couldn't work out where this thread is now");
	// The head's own thread: shown at its line, neither unknown nor spinning.
	await expect(onHead.getByTestId("placement-error")).toHaveCount(0);
	await expect(
		onHead.getByRole("status", { name: "Placing threads" }),
	).toHaveCount(0);
	// The server is back (each ask held): the Retry spins in its slot, then
	// everything clears.
	back = new Promise<void>((r) => {
		releaseBack = r;
	});
	await failed.getByRole("button", { name: "Retry" }).click();
	await expect(failed.getByRole("status", { name: "Retrying" })).toBeVisible();
	await expect(failed).toHaveAttribute("aria-busy", "true");
	releaseBack();
	await expect(failed).toHaveCount(0);
	await expect(
		row(section, 10).getByRole("button", { name: /1 comment/ }),
	).toBeVisible();
});
