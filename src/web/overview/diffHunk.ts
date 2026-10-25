import type { PrOverview } from "../../shared/types";

export type ThreadCode = NonNullable<PrOverview["threads"][number]["code"]>;

export interface HunkLine {
	kind: "context" | "add" | "del";
	oldNo: number | null;
	newNo: number | null;
	text: string;
}

const HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * GitHub's diff hunk as numbered lines. A hunk header (re)starts the
 * numbering; lines before any header, and "\ No newline" markers, are
 * dropped. An empty line is context (some tools strip its leading space).
 */
export function parseDiffHunk(hunk: string): HunkLine[] {
	const out: HunkLine[] = [];
	let oldNo: number | null = null;
	let newNo: number | null = null;
	for (const raw of hunk.replace(/\r\n?/g, "\n").split("\n")) {
		const header = HEADER.exec(raw);
		if (header) {
			oldNo = Number(header[1]);
			newNo = Number(header[2]);
			continue;
		}
		if (oldNo === null || newNo === null || raw.startsWith("\\")) continue;
		const sign = raw[0];
		const text = raw.slice(1);
		if (sign === "+") {
			out.push({ kind: "add", oldNo: null, newNo: newNo++, text });
		} else if (sign === "-") {
			out.push({ kind: "del", oldNo: oldNo++, newNo: null, text });
		} else {
			out.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text });
		}
	}
	// A trailing newline leaves one empty "context" line past the end.
	const last = out.at(-1);
	if (
		last &&
		last.kind === "context" &&
		last.text === "" &&
		hunk.endsWith("\n")
	) {
		out.pop();
	}
	return out;
}

function numberOn(line: HunkLine, side: ThreadCode["side"]): number | null {
	return side === "LEFT" ? line.oldNo : line.newNo;
}

function lastIndexOf(
	lines: HunkLine[],
	upTo: number,
	side: ThreadCode["side"],
	no: number,
): number {
	for (let i = upTo; i >= 0; i--) {
		const line = lines[i];
		if (line && numberOn(line, side) === no) return i;
	}
	return -1;
}

/**
 * The end of the hunk around the commented range: the range itself and the
 * lines before it, `context` lines in all at least. GitHub's hunk ends at
 * the commented line; if the numbers don't match, its last line stands for
 * it, so a bad range never hides the code.
 */
export function codeExcerpt(
	code: ThreadCode,
	context = 6,
): { lines: (HunkLine & { marked: boolean })[] } {
	const lines = parseDiffHunk(code.diffHunk);
	if (lines.length === 0) return { lines: [] };
	let end = lastIndexOf(lines, lines.length - 1, code.side, code.endLine);
	if (end === -1) end = lines.length - 1;
	let start = lastIndexOf(lines, end, code.startSide, code.startLine);
	if (start === -1) start = end;
	const from = Math.max(0, Math.min(start, end - context + 1));
	return {
		lines: lines.slice(from, end + 1).map((line, i) => ({
			...line,
			marked: from + i >= start,
		})),
	};
}
