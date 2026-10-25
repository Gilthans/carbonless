import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import { expect, test } from "./fixtures";

/**
 * As-of mode (hidden dev flags): the PR as it was at CUTOFF. Before it: the
 * PR's first commit, a review by the gh user and one by rev1, a comment and a
 * thread. After it: a reply, a second thread, late-rev's review, another commit
 * (the PR's head now) and the merge.
 */
const CUTOFF = "2026-01-03T00:00:00Z";
const user = (login: string) => ({ login, __typename: "User" });

test("shows the PR as of a cutoff, with another login as you, in a review of its own", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr({
		baseDate: "2026-01-01T00:00:00Z",
		files: [
			{
				message: "PR change",
				files: { "new.txt": "new\n" },
				date: "2026-01-02T00:00:00Z",
			},
		],
		overview: { state: "MERGED", mergeable: "MERGEABLE" },
		threads: [
			reviewThread({ path: "new.txt", line: 1 }, [
				threadComment({
					login: "rev1",
					text: "Why new?",
					createdAt: "2026-01-02T10:00:00Z",
				}),
				threadComment({
					login: "octo-author",
					text: "Because",
					createdAt: "2026-01-04T10:00:00Z",
				}),
			]),
			reviewThread({ path: "later.txt", line: 1 }, [
				threadComment({
					login: "late-rev",
					text: "Too late",
					createdAt: "2026-01-05T10:00:00Z",
				}),
			]),
		],
		reviews: [
			{
				author: user("Octo_Cat"),
				state: "COMMENTED",
				submittedAt: "2026-01-02T09:00:00Z",
			},
			{
				author: user("rev1"),
				state: "CHANGES_REQUESTED",
				submittedAt: "2026-01-02T10:00:00Z",
			},
			{
				author: user("late-rev"),
				state: "APPROVED",
				submittedAt: "2026-01-05T10:00:00Z",
			},
		],
		comments: [
			{ author: user("early-bird"), createdAt: "2026-01-02T11:00:00Z" },
			{ author: user("late-comer"), createdAt: "2026-01-06T11:00:00Z" },
		],
	});
	const then = p.repo.shas[1] ?? "";
	const now = p.moveHead({ message: "later", files: { "later.txt": "x\n" } });
	p.editScenario((s) => {
		const graphql = s.prs[p.number]?.graphql;
		if (!graphql) throw new Error("no graphql");
		graphql.commits = [
			{ commit: { oid: then, committedDate: "2026-01-02T00:00:00Z" } },
			{ commit: { oid: now, committedDate: "2026-01-05T00:00:00Z" } },
		];
		s.commits = {
			[then]: {
				contexts: [
					{
						__typename: "CheckRun",
						name: "build",
						status: "COMPLETED",
						conclusion: "FAILURE",
						startedAt: "2026-01-02T01:00:00Z",
						completedAt: "2026-01-02T01:10:00Z",
					},
					{
						__typename: "CheckRun",
						name: "rerun-later",
						status: "COMPLETED",
						conclusion: "SUCCESS",
						startedAt: "2026-01-04T01:00:00Z",
						completedAt: "2026-01-04T01:10:00Z",
					},
				],
			},
		};
	});

	const s = await startCrb(undefined, [
		"--as-of",
		CUTOFF,
		"--viewer",
		"someone-else",
	]);
	await page.goto(s.url);
	await expect(page.getByTestId("as-of")).toContainText("as of 2026 Jan");
	// The PR has moved on since, obviously: no banner says so.
	await expect(page.getByRole("status")).toHaveCount(0);

	const who = page.getByRole("region", { name: "Who's on it" });
	await expect(who.getByRole("list", { name: "Reviews" })).toContainText(
		"Octo_Cat",
	);
	await expect(who.getByRole("list", { name: "Reviews" })).toContainText(
		"rev1",
	);
	await expect(who).not.toContainText("late-rev");
	await expect(who).toContainText("early-bird");
	await expect(who).not.toContainText("late-comer");
	await expect(who).toContainText("not started on GitHub");

	const row = page
		.getByRole("region", { name: "Is it ready" })
		.getByRole("list", { name: "Readiness" });
	await expect(row.getByRole("listitem")).toHaveText([
		"Conflicts unknown",
		"1 failing",
	]);
	await expect(
		page.getByRole("region", { name: "What it does" }),
	).not.toContainText("Merged");

	const humans = page.getByRole("region", { name: "Human reviews" });
	await expect(humans.getByTestId("thread")).toHaveCount(1);
	await expect(humans.getByTestId("thread")).toContainText("new.txt:1");
	// The reply came after the cutoff.
	await expect(humans.getByTestId("thread")).toContainText("no reply");
	await expect(humans).toContainText("resolved unknown");
	await expect(page.getByText("Too late")).toHaveCount(0);

	// The diff is the PR's as of then: no later.txt.
	const review = page.getByRole("link", { name: /Review files/ });
	await expect(review).toContainText("0 / 1");
	await review.click();
	const files = page.locator('[data-page="/files"]');
	await expect(files.getByText("new.txt").first()).toBeVisible();
	await expect(files.getByText("later.txt")).toHaveCount(0);
	await page
		.getByRole("button", { name: "Mark remaining reviewed" })
		.first()
		.click();
	await expect(
		page.getByRole("progressbar", { name: "Review progress" }),
	).toHaveAttribute("aria-valuenow", /^[1-9]/);
	await s.stop();

	// The PR's own review is untouched by what was marked as of then.
	const normal = await startCrb();
	await page.goto(normal.url);
	await expect(page.getByTestId("as-of")).toHaveCount(0);
	await expect(page.getByRole("link", { name: /Review files/ })).toContainText(
		"0 / 2",
	);
});
