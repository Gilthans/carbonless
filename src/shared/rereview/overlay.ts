import { fileFlags, reviewProgress } from "../progress.js";
import type { RereviewAnswer, ReviewView } from "../types.js";

/**
 * The engine's provisional carries laid over a snapshot's view: every
 * cluster the answer lists as carried takes the carried state, with its
 * source patch set and rule, the files' flags and the progress following.
 * A carried entry missing its source, state or rule changes nothing
 * (principle 2: a bad answer can only leave a cluster unreviewed). Used by
 * the server (a viewed head once the engine has answered) and by the page
 * (the same answer, as soon as it has it).
 */
export function overlayCarries(
	view: ReviewView,
	answer: RereviewAnswer,
): ReviewView {
	const carried = new Map(
		answer.files
			.flatMap((f) => f.clusters)
			.filter((c) => c.kind === "carried")
			.map((c) => [c.key, c]),
	);
	if (carried.size === 0) return view;
	const files = view.files.map((file) => {
		const clusters = file.clusters.map((c) => {
			const carry = carried.get(c.key);
			if (!carry || carry.from === undefined || !carry.state || !carry.rule) {
				return c;
			}
			return {
				...c,
				state: carry.state,
				carried: { from: carry.from, rule: carry.rule },
			};
		});
		return { ...file, clusters, ...fileFlags(clusters) };
	});
	return { ...view, files, progress: reviewProgress(files) };
}
