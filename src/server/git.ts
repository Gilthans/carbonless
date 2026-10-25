import { type ChildProcess, spawn } from "node:child_process";

export class GitError extends Error {}

export interface RunGitOptions {
	env?: Record<string, string>;
	input?: string;
	/** Return "" instead of throwing when git exits non-zero. */
	allowFailure?: boolean;
	/** Kill git after this long; that counts as a failure. */
	timeoutMs?: number;
}

/**
 * Inherited GIT_* variables that only affect transport, diagnostics and where
 * the user keeps their git config (GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM,
 * GIT_CONFIG_NOSYSTEM: a relocated config is still the user's config). Every
 * other GIT_* variable is dropped: GIT_DIR, GIT_NAMESPACE, GIT_OBJECT_DIRECTORY
 * and friends would redirect reads and writes to another repository (for
 * example when crb runs from a git hook or alias), and GIT_AUTHOR_*,
 * GIT_COMMITTER_*, GIT_CONFIG_COUNT/KEY_<n>/VALUE_<n> and
 * GIT_CONFIG_PARAMETERS (config injected by a parent git process) would
 * change what we write.
 */
const INHERITED_GIT_VARS = new Set([
	"GIT_ASKPASS",
	"GIT_TERMINAL_PROMPT",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
	"GIT_SSH_VARIANT",
	"GIT_PROXY_COMMAND",
	"GIT_SSL_CAINFO",
	"GIT_SSL_CAPATH",
	"GIT_SSL_CERT",
	"GIT_SSL_KEY",
	"GIT_SSL_CERT_PASSWORD_PROTECTED",
	"GIT_HTTP_PROXY_AUTHMETHOD",
	"GIT_HTTP_USER_AGENT",
	"GIT_HTTP_LOW_SPEED_LIMIT",
	"GIT_HTTP_LOW_SPEED_TIME",
	"GIT_EXEC_PATH",
	"GIT_CURL_VERBOSE",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
]);

/** process.env minus the GIT_* variables that could redirect or change git. */
export function inheritedEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (
			!key.startsWith("GIT_") ||
			INHERITED_GIT_VARS.has(key) ||
			key.startsWith("GIT_TRACE")
		) {
			env[key] = value;
		}
	}
	return env;
}

/** Kills a detached child's whole process group (the child alone if that fails). */
function killGroup(child: ChildProcess): void {
	try {
		if (child.pid === undefined) throw new Error("not started");
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

/**
 * Timed gits still running. They are in their own process groups, so a
 * Ctrl-C to crb no longer reaches them: crb kills them on its way out.
 */
const detached = new Set<ChildProcess>();
let killOnExit = false;

/** Kills every timed git still running, with its children. */
export function killDetachedGits(): void {
	for (const child of detached) killGroup(child);
	detached.clear();
}

function trackDetached(child: ChildProcess): void {
	detached.add(child);
	child.on("close", () => detached.delete(child));
	if (!killOnExit) {
		killOnExit = true;
		// However crb ends (a signal handler's exit, an uncaught error).
		process.on("exit", killDetachedGits);
	}
}

export async function runGit(
	repoPath: string,
	args: string[],
	opts: RunGitOptions = {},
): Promise<string> {
	return (await runGitBuffer(repoPath, args, opts)).toString("utf8");
}

/** Like `runGit`, but returns stdout as raw bytes. */
export function runGitBuffer(
	repoPath: string,
	args: string[],
	opts: RunGitOptions = {},
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", ["-C", repoPath, ...args], {
			env: { ...inheritedEnv(), ...opts.env },
			stdio: ["pipe", "pipe", "pipe"],
			// A timed git gets its own process group, so the timeout kills its
			// children too (a credential helper, an alias, a remote helper).
			// An untimed one stays in ours and goes with a Ctrl-C; a timed one
			// is killed when crb exits (killDetachedGits).
			detached: opts.timeoutMs !== undefined,
		});
		if (opts.timeoutMs !== undefined) trackDetached(child);
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		// A timeout settles at once, without waiting for the pipes to close.
		let timedOut = false;
		const timer =
			opts.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						killGroup(child);
						child.stdout.destroy();
						child.stderr.destroy();
						if (opts.allowFailure) resolve(Buffer.alloc(0));
						else
							reject(new GitError(`git timed out after ${opts.timeoutMs} ms`));
					}, opts.timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.stdin.on("error", () => {});
		child.on("error", (error) => {
			clearTimeout(timer);
			if (opts.allowFailure) resolve(Buffer.alloc(0));
			else reject(new GitError(error.message));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) {
				// Already settled.
			} else if (code === 0) {
				resolve(Buffer.concat(out));
			} else if (opts.allowFailure) {
				resolve(Buffer.alloc(0));
			} else {
				const stderr = Buffer.concat(err).toString("utf8").trim();
				reject(new GitError(stderr || `git exited with code ${code}`));
			}
		});
		child.stdin.end(opts.input ?? "");
	});
}
