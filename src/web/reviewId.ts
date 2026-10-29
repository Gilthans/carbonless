import { useParams } from "@tanstack/react-router";

/** The id of the review the page shows (`/r/$id`); "" outside a review. */
export function useReviewId(): string {
	return useParams({ strict: false }).id ?? "";
}
