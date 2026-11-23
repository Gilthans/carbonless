import { type LineRanges, size } from "../../shared/lineRanges";
import {
	pieceState,
	type SincePiece,
	sinceMarkKey,
	sinceOnlyState,
} from "../../shared/pieces";
import type { ClusterView, SinceMark } from "../../shared/types";

/** What a box's two controls do. */
export interface Marker {
	toggle: () => void;
	crossOff: () => void;
}

/**
 * A piece shown as a cluster of its own: reviewed or crossed off when every
 * line it owns is; whitespace only as the piece is (`whitespaceOnly`, judged
 * on the interdiff, CAR-218), never as its cluster is against the base.
 */
export function pieceView(
	whole: ClusterView,
	piece: LineRanges,
	whitespaceOnly: boolean,
): ClusterView {
	const {
		reviewedLines: _,
		crossedLines: __,
		reason: ___,
		whitespaceOnly: ____,
		...rest
	} = whole;
	return {
		...rest,
		state: pieceState(whole, piece),
		...(whitespaceOnly ? { whitespaceOnly: true } : {}),
	};
}

/**
 * The since view: a piece as a box (the line view's and the Rendered
 * view's alike). A piece of a cluster marks those of its lines it owns; one
 * that owns no line of this snapshot is marked on its own (`onSinceMark`).
 * Undefined for a piece whose cluster the view doesn't list.
 */
export function pieceMark(
	piece: SincePiece,
	ctx: {
		clusters: ReadonlyMap<string, ClusterView>;
		since: number;
		path: string;
		sinceMarks?: SinceMark[];
		onToggle: (cluster: ClusterView, piece?: LineRanges) => void;
		onCrossOff: (cluster: ClusterView, piece?: LineRanges) => void;
		onSinceMark?: (piece: SincePiece, cross: boolean) => void;
	},
): { cluster: ClusterView; marker: Marker; whole?: ClusterView } | undefined {
	const { owns } = piece;
	if (owns) {
		const whole = piece.key ? ctx.clusters.get(piece.key) : undefined;
		if (!whole) return undefined;
		return {
			// Whitespace only as the piece is (judged on the interdiff,
			// CAR-218), not as its cluster is against the base.
			cluster: pieceView(whole, owns, piece.whitespaceOnly === true),
			marker: {
				toggle: () => ctx.onToggle(whole, owns),
				crossOff: () => ctx.onCrossOff(whole, owns),
			},
			whole,
		};
	}
	const { since, path } = ctx;
	return {
		cluster: {
			key: `${sinceMarkKey(since, path)}:${piece.hunk}:${piece.line}`,
			kind: "lines",
			oldStart: 0,
			oldCount: 0,
			newStart: 0,
			newCount: 0,
			removed: [],
			added: [],
			lines: size(piece.old) + size(piece.new),
			state: sinceOnlyState(ctx.sinceMarks, since, path, piece),
			...(piece.whitespaceOnly ? { whitespaceOnly: true } : {}),
		},
		marker: {
			toggle: () => ctx.onSinceMark?.(piece, false),
			crossOff: () => ctx.onSinceMark?.(piece, true),
		},
	};
}
