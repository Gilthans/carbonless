import { spawn } from "node:child_process";
import type { CommitInfo } from "../shared/types.js";

export class GitError extends Error {}

export interface RunGitOptions {
	env?: Record<string, string>;
	input?: string;
	/** Return "" instead of throwing when git exits non-zero. */
	allowFailure?: boolean;
}

export function runGit(
	repoPath: string,
	args: string[],
	opts: RunGitOptions = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", ["-C", repoPath, ...args], {
			env: { ...process.env, ...opts.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.stdin.on("error", () => {});
		child.on("error", (error) => {
			if (opts.allowFailure) resolve("");
			else reject(new GitError(error.message));
		});
		child.on("close", (code) => {
			if (code === 0) {
				resolve(Buffer.concat(out).toString("utf8"));
			} else if (opts.allowFailure) {
				resolve("");
			} else {
				const stderr = Buffer.concat(err).toString("utf8").trim();
				reject(new GitError(stderr || `git exited with code ${code}`));
			}
		});
		child.stdin.end(opts.input ?? "");
	});
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
