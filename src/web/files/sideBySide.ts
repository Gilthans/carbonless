import type { DiffLine } from "../../shared/types";
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
 * whitespace row (`ws`) stays one row with each side's own line; the plain
 * removed and added lines between whitespace rows pair by position, the
 * i-th removed against the i-th added, the surplus one-sided.
 */
export function layoutRows(rows: DiffRow[]): SideRow[] {
	const out: SideRow[] = [];
	const dels: DiffLine[] = [];
	const adds: DiffLine[] = [];
	const flush = () => {
		const n = Math.max(dels.length, adds.length);
		for (let i = 0; i < n; i++) out.push(pair(dels[i], adds[i], false));
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
