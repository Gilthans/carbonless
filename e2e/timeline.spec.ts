import {
	release,
	reviewThread,
	threadComment,
	timelineComment,
	timelineCommit,
	timelineFact,
	timelineReview,
} from "../test/fake-gh/scenario";
import { expect, test } from "./fixtures";

const sha = (c: string) => c.repeat(40);
const LONG_PATH = "src/some/very/long/directory/name/that/keeps/going/file.ts";

/** Two threads and a timeline whose review comments are in them (PR `n`'s). */
const fixture = (n: number) => ({
	threads: [
		reviewThread({ path: "src/cache.ts", line: 1 }, [
			threadComment({
				login: "rev1",
				text: "Should this expire?",
				createdAt: "2026-01-03T09:00:00Z",
			}),
		]),
		reviewThread({ path: LONG_PATH, line: 2, isResolved: true }, [
			threadComment({
				login: "rev1",
				text: "Rename this",
				createdAt: "2026-01-03T09:05:00Z",
			}),
		]),
	],
	timeline: [
		timelineCommit({
			login: "octo-author",
			at: "2026-01-01T09:00:00Z",
			oid: sha("1"),
			headline: "Add the cache",
		}),
		timelineCommit({
			login: "octo-author",
			at: "2026-01-02T09:00:00Z",
			oid: sha("2"),
			headline: `Make ${"theCacheExpireAfterAVeryLongTime".repeat(3)}`,
		}),
		timelineFact("HeadRefForcePushedEvent", {
			login: "octo-author",
			at: "2026-01-02T10:00:00Z",
			beforeCommit: { oid: sha("a") },
			afterCommit: { oid: sha("c") },
		}),
		timelineReview({
			login: "rev1",
			at: "2026-01-03T09:05:00Z",
			state: "CHANGES_REQUESTED",
			comments: [
				{
					// The fake gh's ids for each thread's opening comment.
					id: `C${n}-0`,
					path: "src/cache.ts",
					line: 1,
					at: "2026-01-03T09:00:00Z",
					text: "Should this expire?",
				},
				{
					id: `C${n}-1`,
					path: LONG_PATH,
					line: 2,
					at: "2026-01-03T09:05:00Z",
					text: "Rename this",
				},
			],
		}),
		timelineComment({
			login: "rev1",
			at: "2026-01-03T09:10:00Z",
			text: "Otherwise fine",
		}),
		timelineFact("ReadyForReviewEvent", {
			login: "octo-author",
			at: "2026-01-04T09:00:00Z",
		}),
	],
});

test("the Timeline: runs oldest first, each opening into its items", async ({
	page,
	pr,
	prNumber,
	startCrb,
}) => {
	await pr(fixture(prNumber));
	const s = await startCrb();
	await page.goto(s.url);
	const section = page.getByRole("region", { name: "Timeline" });
	const rows = section.getByTestId("timeline-event");
	await expect(rows).toHaveCount(4);
	await expect(rows.nth(0)).toContainText("octo-author");
	await expect(rows.nth(0)).toContainText("2 commits");
	await expect(rows.nth(0)).toContainText(/from .+ to .+/);
	await expect(rows.nth(1)).toContainText("force-pushed");
	await expect(rows.nth(2)).toContainText("3 comments");
	await expect(rows.nth(2).getByTestId("timeline-resolved")).toHaveText(
		"1 of 2 resolved",
	);
	await expect(rows.nth(3)).toContainText("marked ready for review");

	// Every run starts closed; a tap opens it.
	const commits = rows.nth(0).getByRole("button", { name: "Show 2 commits" });
	await expect(commits).toHaveAttribute("aria-expanded", "false");
	const box = await commits.boundingBox();
	expect(box?.height).toBeGreaterThanOrEqual(40);
	expect(box?.width).toBeGreaterThanOrEqual(40);
	await commits.click();
	await expect(commits).toHaveAttribute("aria-expanded", "true");
	await expect(rows.nth(0).getByTestId("timeline-item")).toHaveCount(2);
	await expect(rows.nth(0).getByTestId("timeline-item").first()).toContainText(
		"1111111",
	);

	const comments = rows.nth(2).getByRole("button", { name: "Show 3 comments" });
	await comments.click();
	const items = rows.nth(2).getByTestId("timeline-item");
	// By when each was published: the verdict and both comments (submitted
	// together, though the first was written earlier), then a conversation
	// comment.
	await expect(items).toHaveCount(4);
	await expect(items.nth(1)).toContainText("src/cache.ts:1");
	await expect(
		items.nth(1).getByRole("img", { name: "Unresolved" }),
	).toBeVisible();
	await expect(
		items.nth(2).getByRole("img", { name: "Resolved" }),
	).toBeVisible();

	// "Go to the thread" brings the resolved thread's card into view.
	await items.nth(2).getByRole("link", { name: "Go to the thread" }).click();
	const humans = page.getByRole("region", { name: "Human reviews" });
	const card = humans
		.getByRole("list", { name: "Resolved threads" })
		.getByTestId("thread");
	await expect(card).toBeFocused();
	await expect(card).toBeInViewport();

	// Opened, it still fits a 360px screen.
	await page.setViewportSize({ width: 360, height: 780 });
	await expect(rows.nth(0).getByTestId("timeline-item")).toHaveCount(2);
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});

test("the Timeline loads on its own: the rest of the page doesn't wait for it", async ({
	page,
	pr,
	prNumber,
	startCrb,
}) => {
	// The timeline waits until the test lets it go.
	const p = await pr({
		...fixture(prNumber),
		scenario: { hold: ["timeline"] },
	});
	const s = await startCrb();
	await page.goto(s.url);
	const section = page.getByRole("region", { name: "Timeline" });
	await expect(section.getByTestId("timeline-loading")).toBeVisible();
	await expect(
		page.getByRole("region", { name: "Human reviews" }).getByTestId("thread"),
	).toHaveCount(1);
	release(p.scenarioPath, "timeline");
	await expect(section.getByTestId("timeline-event")).toHaveCount(4, {
		timeout: 15_000,
	});
	await expect(section.getByTestId("timeline-loading")).toHaveCount(0);
});
