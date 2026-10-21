import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommitInfo } from "../shared/types.js";

const execFileAsync = promisify(execFile);

export class GitError extends Error {}

export async function runGit(
	repoPath: string,
	args: string[],
): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
			maxBuffer: 64 * 1024 * 1024,
		});
		return stdout;
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new GitError(stderr || (error as Error).message);
	}
}

export async function resolveRepoRoot(path: string): Promise<string> {
	return (await runGit(path, ["rev-parse", "--show-toplevel"])).trim();
}

const FIELD_SEPARATOR = "\x1f";

export async function getCommit(
	repoPath: string,
	ref: string,
): Promise<CommitInfo> {
	const format = ["%H", "%h", "%s", "%an", "%aI"].join(FIELD_SEPARATOR);
	// "--end-of-options" stops refs like "--foo" from being parsed as flags.
	const output = await runGit(repoPath, [
		"show",
		"--no-patch",
		`--format=${format}`,
		"--end-of-options",
		`${ref}^{commit}`,
	]);
	const [sha, shortSha, subject, author, date] = output
		.trim()
		.split(FIELD_SEPARATOR);
	if (!sha || !shortSha || subject === undefined || !author || !date) {
		throw new GitError(`Could not parse commit info for ${ref}`);
	}
	return { sha, shortSha, subject, author, date };
}
