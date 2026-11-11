import type { SessionInfo, VerdictFacts } from "../../shared/types";

/**
 * The commit a verdict goes on, which the buttons name and a Retry sends
 * again: with a since line, the head it compares with (the latest patch
 * set's, or the PR's head past it, which the verdict then starts); else
 * the snapshot's head, as before.
 */
export function verdictCommitOf(
	facts: Pick<VerdictFacts, "since"> | undefined,
	session: Pick<SessionInfo, "snapshotHead"> | undefined,
): string {
	return facts?.since?.to.head ?? session?.snapshotHead ?? "";
}
