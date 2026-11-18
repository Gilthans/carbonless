import type { AgentViewTarget } from "../../shared/agent";

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

/**
 * The number of the patch set being looked at (the comparison target the
 * patch set graph shows): a patch set's own; the head, which is none yet,
 * the next one after the reviewer's (`patchsets`, their count; undefined
 * while the session isn't known). Undefined while unknown.
 */
export function viewedPatchset(
	target: AgentViewTarget,
	patchsets: number | undefined,
): number | undefined {
	if ("patchset" in target) return target.patchset;
	return patchsets === undefined ? undefined : patchsets + 1;
}

/**
 * The review conversation's questions: the re-review's when the patch set
 * looked at is PS2 or later (the owner, 2026-11-18: "Re-review means
 * we're looking at Patch Set > 1"), else the new PR's; null while its
 * number isn't known.
 */
export function reviewQuestions(
	viewed: number | undefined,
): readonly string[] | null {
	if (viewed === undefined) return null;
	return viewed > 1 ? REREVIEW_QUESTIONS : NEW_PR_QUESTIONS;
}
