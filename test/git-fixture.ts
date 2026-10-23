import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface FixtureCommit {
	message: string;
	files: Record<string, string>;
	/** Paths to delete. */
	delete?: string[];
	/** Old path to new path. Applied before `files`, so edits can follow. */
	rename?: Record<string, string>;
	chmod?: Record<string, "755" | "644">;
	binary?: Record<string, Uint8Array>;
	/** Path to commit SHA, recorded as a gitlink (mode 160000). */
	submodule?: Record<string, string>;
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

	const write = (name: string, content: string | Uint8Array) => {
		mkdirSync(dirname(join(path, name)), { recursive: true });
		writeFileSync(join(path, name), content);
	};

	const shas = commits.map((commit) => {
		for (const name of commit.delete ?? []) {
			rmSync(join(path, name), { force: true });
		}
		for (const [from, to] of Object.entries(commit.rename ?? {})) {
			mkdirSync(dirname(join(path, to)), { recursive: true });
			renameSync(join(path, from), join(path, to));
		}
		for (const [name, content] of Object.entries(commit.files)) {
			write(name, content);
		}
		for (const [name, content] of Object.entries(commit.binary ?? {})) {
			write(name, content);
		}
		for (const [name, mode] of Object.entries(commit.chmod ?? {})) {
			chmodSync(join(path, name), mode === "755" ? 0o755 : 0o644);
		}
		git("add", "--all");
		for (const [name, sha] of Object.entries(commit.submodule ?? {})) {
			git("update-index", "--add", "--cacheinfo", `160000,${sha},${name}`);
		}
		git("commit", "--quiet", "--allow-empty", "-m", commit.message);
		return git("rev-parse", "HEAD");
	});

	return {
		path,
		shas,
		cleanup: () => rmSync(path, { recursive: true, force: true }),
	};
}

/** Creates an empty throwaway bare repository, like carbonless's private clone. */
export function createBareRepo(): { path: string; cleanup: () => void } {
	const path = mkdtempSync(join(tmpdir(), "carbonless-bare-"));
	execFileSync("git", ["init", "--quiet", "--bare", path]);
	return {
		path,
		cleanup: () => rmSync(path, { recursive: true, force: true }),
	};
}
