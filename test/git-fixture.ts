import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FixtureCommit {
	message: string;
	files: Record<string, string>;
}

export interface GitFixture {
	path: string;
	/** Commit SHAs, in the order they were created. */
	shas: string[];
	cleanup: () => void;
}

/** Creates a throwaway git repository with the given commits. */
export function createGitFixture(commits: FixtureCommit[]): GitFixture {
	const path = mkdtempSync(join(tmpdir(), "carbonless-fixture-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();

	git("init", "--quiet", "--initial-branch=main");
	git("config", "user.name", "Fixture Author");
	git("config", "user.email", "fixture@example.com");
	git("config", "commit.gpgsign", "false");

	const shas = commits.map(({ message, files }) => {
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(path, name), content);
		}
		git("add", "--all");
		git("commit", "--quiet", "-m", message);
		return git("rev-parse", "HEAD");
	});

	return {
		path,
		shas,
		cleanup: () => rmSync(path, { recursive: true, force: true }),
	};
}
