import type { DiffLine } from "../../shared/types";

/**
 * "Ignore whitespace" (Settings): the view pairs a cluster's removed and
 * added lines that differ only in whitespace, so they read as one quiet
 * row. A view only: nothing here changes clusters, keys, counts or review
 * state, and every removed and added line of the cluster is in the rows
 * exactly once (whitespace.test.ts checks that for any input).
 */

/** ASCII whitespace, as git's `-w` ignores it. Unicode blanks are content. */
const WHITESPACE = /[ \t\r\v\f]/g;

export const stripWhitespace = (text: string): string =>
	text.replace(WHITESPACE, "");

/** Byte-identical after removing every ASCII whitespace character. */
export const whitespaceEqual = (a: string, b: string): boolean =>
	stripWhitespace(a) === stripWhitespace(b);

/**
 * What a line compares by: its text without whitespace, and whether git's
 * "No newline at end of file" follows it (`-w` doesn't ignore that: a
 * final newline lost or gained is a real change).
 */
const keyOf = (line: DiffLine): string =>
	`${stripWhitespace(line.text)}${line.noNewline ? "\0" : ""}`;

/** Two lines a pair may join: whitespace-equal, with the same final newline. */
export const linesWhitespaceEqual = (del: DiffLine, add: DiffLine): boolean =>
	keyOf(del) === keyOf(add);

/**
 * A cluster with more removed or more added lines than this isn't paired
 * (the pairing is O(n·m)).
 */
export const PAIR_CAP = 2000;

/** A row of a cluster: a line as it is, or a whitespace-only pair. */
export type DiffRow =
	| { kind: "line"; line: DiffLine }
	| { kind: "ws"; del: DiffLine; add: DiffLine };

/** Every row is a pair: the cluster changes nothing but whitespace. */
export const whitespaceOnly = (rows: DiffRow[]): boolean =>
	rows.length > 0 && rows.every((r) => r.kind === "ws");

/**
 * The longest common subsequence of `a` and `b` under whitespace-equality,
 * as index pairs in order.
 */
function pairs(a: string[], b: string[]): [number, number][] {
	const n = a.length;
	const m = b.length;
	const w = m + 1;
	// lcs[i * w + j]: the LCS length of a[i..] and b[j..].
	const lcs = new Uint16Array((n + 1) * w);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i * w + j] =
				a[i] === b[j]
					? (lcs[(i + 1) * w + j + 1] as number) + 1
					: Math.max(
							lcs[(i + 1) * w + j] as number,
							lcs[i * w + j + 1] as number,
						);
		}
	}
	const out: [number, number][] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push([i, j]);
			i++;
			j++;
		} else if (
			(lcs[(i + 1) * w + j] as number) >= (lcs[i * w + j + 1] as number)
		) {
			i++;
		} else {
			j++;
		}
	}
	return out;
}

/**
 * A cluster's lines (its removed lines, then its added ones) as rows with
 * whitespace-equal lines paired, in diff order: the unpaired removed lines,
 * the unpaired added lines, then the pair, and so on. Lines in any other
 * shape (a context line among them, a side over PAIR_CAP) stay as they are.
 */
export function pairWhitespace(lines: DiffLine[]): DiffRow[] {
	const plain = (): DiffRow[] => lines.map((line) => ({ kind: "line", line }));
	const dels: DiffLine[] = [];
	const adds: DiffLine[] = [];
	for (const line of lines) {
		if (line.kind === "del" && adds.length === 0) dels.push(line);
		else if (line.kind === "add") adds.push(line);
		else return plain();
	}
	if (dels.length > PAIR_CAP || adds.length > PAIR_CAP) return plain();
	const delKeys = dels.map(keyOf);
	const addKeys = adds.map(keyOf);
	// The common case for a big real change: nothing to pair, no O(n·m) work.
	const addSet = new Set(addKeys);
	if (!delKeys.some((k) => addSet.has(k))) return plain();
	const matched = pairs(delKeys, addKeys);
	const rows: DiffRow[] = [];
	let d = 0;
	let a = 0;
	const upTo = (toD: number, toA: number) => {
		for (; d < toD; d++) rows.push({ kind: "line", line: dels[d] as DiffLine });
		for (; a < toA; a++) rows.push({ kind: "line", line: adds[a] as DiffLine });
	};
	for (const [i, j] of matched) {
		upTo(i, j);
		rows.push({
			kind: "ws",
			del: dels[i] as DiffLine,
			add: adds[j] as DiffLine,
		});
		d = i + 1;
		a = j + 1;
	}
	upTo(dels.length, adds.length);
	return rows;
}
