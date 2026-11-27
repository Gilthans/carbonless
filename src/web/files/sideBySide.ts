import type { DiffLine } from "../../shared/types";
import { type Partners, spansOf } from "./pairOrder";
import type { DiffRow } from "./whitespace";

/**
 * "Side by side" (Settings): the view lays a hunk out as old-left /
 * new-right pair rows, GitHub-style. A view only, pure and property-tested
 * (sideBySide.test.ts): every removed, added and context line of the rows
 * is in the layout exactly once per side, in order, on its own side.
 * Nothing here changes clusters, keys, counts or review state.
 */

/** One row of the side-by-side table: a context line on both sides, or a pair with at least one side. */
export type SideRow =
	| { kind: "context"; line: DiffLine }
	| { kind: "pair"; del?: DiffLine; add?: DiffLine; ws: boolean };

/**
 * One cluster run's (or context run's) rows, laid out side by side: a
 * whitespace row (`ws`) stays one row with each side's own line. Between
 * them, a similarity pair (`partners`, both lines in the stretch, not
 * crossing an earlier item) shares one row, and the plain removed and added
 * lines in each gap around the items pair by position, the i-th removed
 * against the i-th added, the surplus one-sided. A group (CAR-130): a
 * split puts its one line beside the run's first, then the run's other
 * lines on rows of their own, blank opposite; a join mirrors it. So a
 * blank cell only once the other side of that gap or group has run out.
 * Without `partners`, the whole stretch is one gap.
 */
export function layoutRows(rows: DiffRow[], partners?: Partners): SideRow[] {
	const out: SideRow[] = [];
	const dels: DiffLine[] = [];
	const adds: DiffLine[] = [];
	const gap = (d: DiffLine[], a: DiffLine[]) => {
		const n = Math.max(d.length, a.length);
		for (let i = 0; i < n; i++) out.push(pair(d[i], a[i], false));
	};
	const flush = () => {
		// Items (both lines, or every line of a group, in this stretch, not
		// crossing an earlier item) share their first row; the gaps between
		// them lay out by position. Independent of how the stretch's dels
		// and adds interleave.
		let di = 0;
		let ai = 0;
		if (partners) {
			for (const { d0, d1, a0, a1 } of spansOf(dels, adds, partners)) {
				if (d0 < di || a0 < ai) continue;
				gap(dels.slice(di, d0), adds.slice(ai, a0));
				// A pair is one row; a group its first row, then the run's
				// other lines alone (one side holds one line).
				gap(dels.slice(d0, d1 + 1), adds.slice(a0, a1 + 1));
				di = d1 + 1;
				ai = a1 + 1;
			}
		}
		gap(dels.slice(di), adds.slice(ai));
		dels.length = 0;
		adds.length = 0;
	};
	for (const row of rows) {
		if (row.kind === "ws") {
			flush();
			out.push(pair(row.del, row.add, true));
		} else if (row.line.kind === "del") {
			dels.push(row.line);
		} else if (row.line.kind === "add") {
			adds.push(row.line);
		} else {
			flush();
			out.push({ kind: "context", line: row.line });
		}
	}
	flush();
	return out;
}

/**
 * A pair row with only the sides it has: no `del: undefined` key, so a row
 * compares equal to its literal in tests and reads cleanly in a debugger.
 * Nothing depends on `"del" in row`; readers check `row.del` itself.
 */
function pair(
	del: DiffLine | undefined,
	add: DiffLine | undefined,
	ws: boolean,
): SideRow {
	const row: SideRow = { kind: "pair", ws };
	if (del) row.del = del;
	if (add) row.add = add;
	return row;
}

/** Every line of `rows` on its side, in order: what the layout must keep (tests, DiffBody never needs it). */
export function sides(rows: DiffRow[]): {
	left: DiffLine[];
	right: DiffLine[];
} {
	const left: DiffLine[] = [];
	const right: DiffLine[] = [];
	for (const row of rows) {
		if (row.kind === "ws") {
			if (row.del) left.push(row.del);
			if (row.add) right.push(row.add);
		} else {
			if (row.line.kind !== "add") left.push(row.line);
			if (row.line.kind !== "del") right.push(row.line);
		}
	}
	return { left, right };
}
