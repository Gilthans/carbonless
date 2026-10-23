import type { Cluster, DiffLine, DisplayHunk } from "../../shared/types.js";

interface Span {
	cluster: Cluster;
	/** Last unchanged line above the cluster, 0 if none (both sides). */
	newAbove: number;
	oldAbove: number;
	/** First unchanged new-side line below the cluster. */
	newBelow: number;
	/** newCount − oldCount of every cluster above this one. */
	shiftBefore: number;
}

/** Line clusters in file order, with their position among unchanged lines. */
function spans(clusters: Cluster[]): Span[] {
	const sorted = clusters
		.filter((c) => c.kind === "lines")
		.sort((a, b) => a.newStart - b.newStart || a.oldStart - b.oldStart);
	let shift = 0;
	return sorted.map((cluster) => {
		const newAbove =
			cluster.newCount === 0 ? cluster.newStart : cluster.newStart - 1;
		const span: Span = {
			cluster,
			newAbove,
			oldAbove:
				cluster.oldCount === 0 ? cluster.oldStart : cluster.oldStart - 1,
			newBelow: newAbove + cluster.newCount + 1,
			shiftBefore: shift,
		};
		shift += cluster.newCount - cluster.oldCount;
		return span;
	});
}

/**
 * An unchanged line. Throws if the old side differs, which means the clusters
 * don't belong to these blobs: showing it as unchanged would hide a change.
 */
function context(
	oldLines: string[],
	newLines: string[],
	newNo: number,
	shift: number,
): DiffLine {
	const oldNo = newNo - shift;
	const text = newLines[newNo - 1];
	if (text === undefined || oldLines[oldNo - 1] !== text) {
		throw new Error(
			`Unchanged line ${newNo} (old ${oldNo}) differs between the two sides`,
		);
	}
	return { kind: "context", oldNo, newNo, text };
}

/**
 * GitHub/git style hunks: each line cluster plus up to `context` unchanged
 * lines either side, merged when the expansions touch or overlap (so
 * clusters ≤ 2 × context unchanged lines apart share a hunk).
 */
export function buildDisplayHunks(
	oldLines: string[],
	newLines: string[],
	clusters: Cluster[],
	contextSize = 3,
): DisplayHunk[] {
	const groups: Span[][] = [];
	for (const span of spans(clusters)) {
		const group = groups[groups.length - 1];
		const prev = group?.[group.length - 1];
		if (group && prev && span.newAbove - prev.newBelow + 1 <= 2 * contextSize) {
			group.push(span);
		} else {
			groups.push([span]);
		}
	}
	return groups.map((group) => {
		const first = group[0] as Span;
		const last = group[group.length - 1] as Span;
		const from = Math.max(1, first.newAbove - contextSize + 1);
		const to = Math.min(newLines.length, last.newBelow + contextSize - 1);
		const lines: DiffLine[] = [];
		let next = from;
		for (const span of group) {
			for (; next <= span.newAbove; next++) {
				lines.push(context(oldLines, newLines, next, span.shiftBefore));
			}
			const { cluster } = span;
			cluster.removed.forEach((text, i) => {
				lines.push({
					kind: "del",
					oldNo: cluster.oldStart + i,
					text,
					clusterKey: cluster.key,
				});
			});
			cluster.added.forEach((text, i) => {
				lines.push({
					kind: "add",
					newNo: cluster.newStart + i,
					text,
					clusterKey: cluster.key,
				});
			});
			next = span.newBelow;
		}
		const shiftAfter =
			last.shiftBefore + last.cluster.newCount - last.cluster.oldCount;
		for (; next <= to; next++)
			lines.push(context(oldLines, newLines, next, shiftAfter));

		const oldCount = lines.filter((l) => l.kind !== "add").length;
		const newCount = lines.filter((l) => l.kind !== "del").length;
		const oldFrom = first.oldAbove - (first.newAbove - from + 1) + 1;
		return {
			oldStart: oldCount > 0 ? oldFrom : oldFrom - 1,
			oldCount,
			newStart: newCount > 0 ? from : from - 1,
			newCount,
			lines,
		};
	});
}

/**
 * Unchanged lines in the new-side range `newFrom..newTo` (clamped to the
 * file), with old line numbers. Added lines are skipped: loaded context can
 * never show a change as unchanged.
 */
export function contextLines(
	oldLines: string[],
	newLines: string[],
	clusters: Cluster[],
	newFrom: number,
	newTo: number,
): DiffLine[] {
	const all = spans(clusters);
	const lines: DiffLine[] = [];
	let i = 0;
	let shift = 0;
	const end = Math.min(newTo, newLines.length);
	for (let n = Math.max(1, newFrom); n <= end; n++) {
		while (i < all.length && (all[i] as Span).newBelow <= n) {
			const { cluster } = all[i] as Span;
			shift += cluster.newCount - cluster.oldCount;
			i++;
		}
		const span = all[i];
		const added =
			span !== undefined &&
			span.cluster.newCount > 0 &&
			n >= span.cluster.newStart;
		if (!added) lines.push(context(oldLines, newLines, n, shift));
	}
	return lines;
}
