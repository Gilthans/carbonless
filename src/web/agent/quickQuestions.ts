import type { SessionInfo } from "../../shared/types";

/**
 * The one-tap questions that fill an Ask agent box (CAR-203). The owner's
 * defaults; CAR-204 makes them customizable, replacing these constants.
 */

/** On a code span (a line, a range, highlighted text, a file). */
export const SPAN_QUESTIONS: readonly string[] = [
	"Explain this code please",
	"Why this change?",
	"What calls this?",
	"Is this tested?",
];

/** The whole review conversation, on a first review of the PR. */
export const NEW_PR_QUESTIONS: readonly string[] = [
	"Please summarize the changes",
	"Please highlight all decisions made in code that I might object to",
	"Please highlight all code that can't be tested directly",
];

/** The whole review conversation, on a re-review (an earlier patch set reviewed). */
export const REREVIEW_QUESTIONS: readonly string[] = [
	"Please summarize what changed",
	"Please confirm all comments I wrote have been addressed and highlight those that haven't",
	"Please highlight any change that isn't related to a comment I've made",
];

/**
 * The box's text once a question is tapped: the question alone in an
 * empty (or blank) box, else on a new line after what was typed.
 */
export function withQuestion(text: string, question: string): string {
	const typed = text.trimEnd();
	return typed.trim() ? `${typed}\n${question}` : question;
}

/** What isRereview reads of the session. */
export type RereviewFacts = Pick<
	SessionInfo,
	"snapshotHead" | "head" | "patchsets"
>;

/**
 * Whether the reviewer is re-reviewing: they have a patch set of this PR
 * on another head than the PR's latest (GitHub's head as last checked,
 * else the snapshot's: a merged or closed PR, an as-of view, a pinned
 * head). So a push after their review, seen as the head toast or the
 * since view, already makes it one, before a new patch set starts.
 * Undefined while the session isn't known.
 */
export function isRereview(
	session: RereviewFacts | undefined,
): boolean | undefined {
	if (!session) return undefined;
	const latest = session.head?.oid ?? session.snapshotHead;
	return session.patchsets.some((p) => p.head !== latest);
}

/** The review conversation's questions; null while it isn't known which. */
export function reviewQuestions(
	session: RereviewFacts | undefined,
): readonly string[] | null {
	const again = isRereview(session);
	if (again === undefined) return null;
	return again ? REREVIEW_QUESTIONS : NEW_PR_QUESTIONS;
}
