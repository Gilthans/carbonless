import type { DiffLine } from "../../shared/types";
import type { DiffRow } from "./whitespace";

/** Each paired line's partner, both directions (hunkPairs' pairs). */
export type Partners = ReadonlyMap<DiffLine, DiffLine>;

const isPlain = (row: DiffRow): row is DiffRow & { kind: "line" } =>
	row.kind === "line" && row.line.kind !== "context";

/**
 * One stretch of plain removed and added lines (the server lays it out as
 * its removed lines, then its added ones) in unified B's order: the gap's
 * removed lines, the gap's added lines, then a run of consecutive pairs as
 * its removed lines and its added lines; and again. A partner outside the
 * stretch counts as no partner. A stretch of another shape, or pairs that
 * cross, stay as they are.
 */
function orderStretch(rows: DiffRow[], partners: Partners): DiffRow[] {
	const dels: DiffRow[] = [];
	const adds: DiffRow[] = [];
	for (const row of rows) {
		const line = (row as DiffRow & { kind: "line" }).line;
		if (line.kind === "del" && adds.length === 0) dels.push(row);
		else if (line.kind === "add") adds.push(row);
		else return rows;
	}
	const addAt = new Map(
		adds.map((r, j) => [(r as DiffRow & { kind: "line" }).line, j]),
	);
	const at: [number, number][] = [];
	dels.forEach((r, i) => {
		const partner = partners.get((r as DiffRow & { kind: "line" }).line);
		const j = partner && addAt.get(partner);
		if (j !== undefined) at.push([i, j]);
	});
	if (at.length === 0) return rows;
	for (let k = 1; k < at.length; k++)
		if ((at[k] as [number, number])[1] <= (at[k - 1] as [number, number])[1])
			return rows;
	const out: DiffRow[] = [];
	let d = 0;
	let a = 0;
	for (let k = 0; k < at.length; ) {
		const [i0, j0] = at[k] as [number, number];
		let last = k;
		while (
			last + 1 < at.length &&
			(at[last + 1] as [number, number])[0] ===
				(at[last] as [number, number])[0] + 1 &&
			(at[last + 1] as [number, number])[1] ===
				(at[last] as [number, number])[1] + 1
		)
			last++;
		const [i1, j1] = at[last] as [number, number];
		out.push(...dels.slice(d, i0), ...adds.slice(a, j0));
		out.push(...dels.slice(i0, i1 + 1), ...adds.slice(j0, j1 + 1));
		d = i1 + 1;
		a = j1 + 1;
		k = last + 1;
	}
	out.push(...dels.slice(d), ...adds.slice(a));
	return out;
}

/**
 * A cluster run's rows in unified B's order (spec: "Unified (B)"): within
 * each stretch of plain removed and added rows, a pair reads together.
 * Context and whitespace-only (`~`) rows end a stretch and stay at their
 * indices, so no line crosses one. A stretch without partners is unchanged.
 */
export function orderRun(
	rows: readonly DiffRow[],
	partners: Partners,
): DiffRow[] {
	const out: DiffRow[] = [];
	let stretch: DiffRow[] = [];
	const flush = () => {
		out.push(...(stretch.length > 0 ? orderStretch(stretch, partners) : []));
		stretch = [];
	};
	for (const row of rows) {
		if (isPlain(row)) stretch.push(row);
		else {
			flush();
			out.push(row);
		}
	}
	flush();
	return out;
}
