import { join } from "node:path";
import { readConfig } from "../config.js";
import { stateDir } from "../paths.js";
import { setDefaultTraceDir } from "../trace.js";

/** Where crb serve traces when the mailbox is on and $CRB_TRACE_DIR is unset. */
export const defaultTraceDir = (): string => join(stateDir(), "traces");

/**
 * The trace directory the mailbox gives crb serve: the default one while
 * the mailbox is on and $CRB_TRACE_DIR is unset (that one wins), else none.
 */
export function mailboxTraceDir(
	mailboxOn: boolean,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (env.CRB_TRACE_DIR || !mailboxOn) return undefined;
	return defaultTraceDir();
}

/**
 * crb serve with the mailbox on traces by default (rotation and retention
 * as with $CRB_TRACE_DIR), so turning the mailbox on is all a device needs.
 * Runs before the tracer is first made (src/cli.ts). Decided at start: a
 * mailbox turned on later traces from the next start. Never fails a start.
 */
export async function applyMailboxTracing(): Promise<void> {
	try {
		const { config } = await readConfig();
		setDefaultTraceDir(mailboxTraceDir(config.telemetry !== undefined));
	} catch {
		// No config read, no default tracing.
	}
}
