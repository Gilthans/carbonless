import type { ThreadComment, WriteError } from "../shared/types.js";

/** A failure talking to GitHub through `gh`; the message is shown to the user as is. */
export class GhError extends Error {}

/**
 * A thread write GitHub (or carbonless) refused for good: retrying the same
 * request won't help. `code` is WriteError's; `url` where to fix it.
 */
export class WriteRefusedError extends GhError {
	constructor(
		message: string,
		readonly code: WriteError["code"],
		readonly url?: string,
		/** "changed": the comment as GitHub has it now. */
		readonly current?: ThreadComment,
	) {
		super(message);
	}
}
