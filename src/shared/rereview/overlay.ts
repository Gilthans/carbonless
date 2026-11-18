import { type LineRanges, union } from "../lineRanges.js";
import { viewOfLines } from "../pieces.js";
import { fileFlags, reviewProgress } from "../progress.js";
import type { ClusterView, RereviewAnswer, ReviewView } from "../types.js";

/**
 * An unmarked cluster with the line marks the engine carried into it
 * (CAR-195, RereviewAnswer's `lines`): its lines marked as they say, with
 * `linesCarried`. A cluster that holds any mark already, no lines, or
 * ranges past its lines (fails closed) is left as it is.
 */
export function linesCarriedView(
	view: ClusterView,
	lines: { reviewed?: LineRanges; crossed?: LineRanges } | undefined,
	from: number,
): ClusterView {
	if (!lines || view.state !== "unreviewed") return view;
	if (view.reviewedLines?.length || view.crossedLines?.length) return view;
	const reviewed = lines.reviewed ?? [];
	const crossed = lines.crossed ?? [];
	const carried = union(reviewed, crossed);
	if (carried.length === 0) return view;
	const marked = viewOfLines(view, reviewed, crossed);
	if (!marked) return view;
	return { ...marked, linesCarried: { from, lines: carried } };
}

/**
 * The engine's provisional carries laid over a snapshot's view: every
 * cluster the answer lists as carried takes the carried state, with its
 * source patch set and rule, and every reworked or new one with line
 * carries takes them (linesCarriedView), the files' flags and the
 * progress following. A carried entry missing its source, state or rule
 * changes nothing (principle 2: a bad answer can only leave a cluster
 * unreviewed). Used by the server (a viewed head once the engine has
 * answered) and by the page (the same answer, as soon as it has it).
 */
export function overlayCarries(
	view: ReviewView,
	answer: RereviewAnswer,
): ReviewView {
	const entries = new Map(
		answer.files
			.flatMap((f) => f.clusters)
			.filter(
				(c) =>
					c.kind === "carried" ||
					((c.kind === "reworked" || c.kind === "new") && c.lines),
			)
			.map((c) => [c.key, c]),
	);
	if (entries.size === 0) return view;
	const files = view.files.map((file) => {
		const clusters = file.clusters.map((c) => {
			const carry = entries.get(c.key);
			if (!carry) return c;
			if (carry.kind !== "carried") {
				return linesCarriedView(c, carry.lines, answer.from);
			}
			if (carry.from === undefined || !carry.state || !carry.rule) {
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
