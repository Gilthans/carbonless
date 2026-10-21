import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitFixture, type GitFixture } from "../../test/git-fixture";
import { GitError, getCommit, resolveRepoRoot } from "./git";

describe("git", () => {
	let repo: GitFixture;

	beforeAll(() => {
		repo = createGitFixture([
			{ message: "Initial commit", files: { "a.txt": "one\n" } },
			{ message: "Second commit", files: { "a.txt": "two\n" } },
		]);
	});

	afterAll(() => repo.cleanup());

	it("reads commit info for a ref", async () => {
		const commit = await getCommit(repo.path, "HEAD");
		expect(commit).toMatchObject({
			sha: repo.shas[1],
			subject: "Second commit",
			author: "Fixture Author",
		});
		expect(repo.shas[1]?.startsWith(commit.shortSha)).toBe(true);
	});

	it("resolves relative refs", async () => {
		const commit = await getCommit(repo.path, "HEAD~1");
		expect(commit.sha).toBe(repo.shas[0]);
	});

	it("throws a GitError for unknown refs", async () => {
		await expect(getCommit(repo.path, "does-not-exist")).rejects.toBeInstanceOf(
			GitError,
		);
	});

	it("does not treat refs as command-line options", async () => {
		await expect(
			getCommit(repo.path, "--output=/tmp/pwned"),
		).rejects.toBeInstanceOf(GitError);
	});

	it("resolves the repository root from a path", async () => {
		const root = await resolveRepoRoot(repo.path);
		expect(root.endsWith(repo.path.split("/").at(-1) ?? "")).toBe(true);
	});
});
