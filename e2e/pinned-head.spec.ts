import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import { fileSection, openFiles } from "./files-ui";
import { CrbExitError, expect, test } from "./fixtures";

const user = (login: string) => ({ login, __typename: "User" });

/**
 * `crb --head reviewed`: the viewer (Octo_Cat) reviewed the PR's first
 * commit; a later commit adds later.txt. The view is the PR's changes up to
 * the reviewed commit, with the threads opened on it, and says newer
 * commits exist.
 */
test("--head reviewed shows the PR up to the commit you last reviewed", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr();
	const then = p.repo.shas.at(-1) ?? "";
	const now = p.moveHead({ message: "later", files: { "later.txt": "x\n" } });
	p.editScenario((s) => {
		const graphql = s.prs[p.number]?.graphql;
		if (!graphql) throw new Error("no graphql");
		graphql.reviews = [
			{
				author: user("Octo_Cat"),
				state: "CHANGES_REQUESTED",
				submittedAt: "2026-01-02T00:00:00Z",
				commit: { oid: then },
			},
			{
				author: user("rev1"),
				state: "APPROVED",
				submittedAt: "2026-01-04T00:00:00Z",
				commit: { oid: now },
			},
		];
		graphql.reviewThreads = [
			reviewThread({ path: "new.txt", line: 1, subjectType: "LINE" }, [
				threadComment({
					login: "Octo_Cat",
					text: "On the reviewed commit",
					createdAt: "2026-01-02T00:00:00Z",
					commit: then,
					diffHunk: "",
				}),
			]),
			reviewThread({ path: "new.txt", line: 1, subjectType: "LINE" }, [
				threadComment({
					login: "rev1",
					text: "On the head",
					createdAt: "2026-01-04T00:00:00Z",
					commit: now,
					diffHunk: "",
				}),
			]),
		];
	});

	const s = await startCrb(undefined, ["--head", "reviewed"]);
	await page.goto(s.url);
	await expect(
		page.getByRole("region", { name: "What it does" }),
	).toBeVisible();
	// A pinned head never moves: no toast about newer commits.
	await expect(page.getByTestId("head-toast")).toHaveCount(0);

	await openFiles(page, s.url);
	// Nor a head dot in the graph: the slot says the view is pinned.
	await expect(page.getByTestId("ps-tail")).toHaveAttribute(
		"data-state",
		"none",
	);
	await expect(page.getByTestId("ps-tail")).toHaveText("pinned");
	const files = page.locator('[data-page="/files"]');
	await expect(fileSection(page, "new.txt")).toBeVisible();
	await expect(fileSection(page, "a.txt")).toBeVisible();
	await expect(files.getByText("later.txt")).toHaveCount(0);
	const section = fileSection(page, "new.txt");
	// Line bubbles (the file's own bubble is always there).
	const bubbles = section.locator(
		'[data-testid="thread-bubble"]:not([data-file])',
	);
	const bubble = section.getByRole("button", { name: "1 comment on line 1" });
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(bubble).toBeVisible();
	await expect(bubbles).toHaveCount(1);
	await bubble.click();
	await expect(bubble).toHaveAttribute("aria-expanded", "true");
	await expect(section.getByTestId("thread-comment")).toHaveText(
		/On the reviewed commit/,
	);
	await expect(section).not.toContainText("On the head");
	// Leave first: its page would poll the stopped server.
	await page.goto("about:blank");
	await s.stop();

	// Without --head: the PR's head, in the PR's own review.
	const normal = await startCrb();
	await openFiles(page, normal.url);
	await expect(fileSection(page, "later.txt")).toBeVisible();
});

test("--head fails clearly without a submitted review, and with --as-of", async ({
	pr,
	startCrb,
}) => {
	await pr();
	const exitOf = (promise: Promise<unknown>) =>
		promise.then(
			() => {
				throw new Error("crb started but should have exited");
			},
			(e: unknown) => {
				if (!(e instanceof CrbExitError)) throw e;
				return e;
			},
		);
	const none = await exitOf(startCrb(undefined, ["--head", "reviewed"]));
	expect(none.code).toBe(1);
	expect(none.output).toContain(
		"crb: octo-cat has no submitted review on acme/widget#7",
	);
	const both = await exitOf(
		startCrb(undefined, ["--head", "reviewed", "--as-of", "2026-01-01T00:00Z"]),
	);
	expect(both.output).toContain("crb: --head can't be combined with --as-of");
	const bad = await exitOf(startCrb(undefined, ["--head", "tip"]));
	expect(bad.output).toContain("crb: Invalid --head: tip");
});
