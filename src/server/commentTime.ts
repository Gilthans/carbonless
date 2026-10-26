/**
 * When a review comment became visible to anyone but its author. GitHub
 * dates a review comment twice: `createdAt` when it was written (also while
 * it sat in a pending review) and `publishedAt` when its review was
 * submitted. What others saw, and when, follows the second, so threads,
 * their order, as-of filtering and the timeline all date review comments by
 * it.
 *
 * The time is `publishedAt`, else its review's `submittedAt` (the comment's
 * own `pullRequestReview` if read, or `reviewSubmittedAt` when the caller
 * read the comment through its review), else, when GitHub reports neither,
 * when it was written: a submitted comment is never dropped for a missing
 * date. Null for a pending comment (`state` PENDING, or its review's): only
 * its author, the viewer, can see it until the review is submitted, so it
 * is left out like the pending review itself.
 */
export function visibleAt(
	comment: unknown,
	reviewSubmittedAt?: unknown,
): string | null {
	const c = obj(comment);
	const review = obj(c.pullRequestReview);
	if (c.state === "PENDING" || review.state === "PENDING") return null;
	return (
		str(c.publishedAt) ||
		str(review.submittedAt) ||
		str(reviewSubmittedAt) ||
		str(c.createdAt)
	);
}

function obj(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}
