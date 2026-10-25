/** GitHub review-comment diff hunks, parsed the same way on the server and in the page. */

export interface HunkLine {
	kind: "context" | "add" | "del";
	oldNo: number | null;
	newNo: number | null;
	text: string;
	/** Git's "\ No newline at end of file" follows this line. */
	noNewline?: boolean;
}

const HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * GitHub's diff hunk as numbered lines. A hunk header (re)starts the
 * numbering; lines before any header are dropped, and a "\ No newline"
 * marker flags the line before it. An empty line is context (some tools
 * strip its leading space). Lines split on "\n" only: a CR stays in the
 * text, so the invisibles renderer shows CRLF endings and lone CRs as the
 * Files page does.
 */
export function parseDiffHunk(hunk: string): HunkLine[] {
	const out: HunkLine[] = [];
	let oldNo: number | null = null;
	let newNo: number | null = null;
	for (const raw of hunk.split("\n")) {
		const header = HEADER.exec(raw);
		if (header) {
			oldNo = Number(header[1]);
			newNo = Number(header[2]);
			continue;
		}
		if (oldNo === null || newNo === null) continue;
		if (raw.startsWith("\\")) {
			const before = out.at(-1);
			if (before) before.noNewline = true;
			continue;
		}
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

/** A line's number on one side of the diff ("LEFT" is the old side). */
export function numberOn(
	line: HunkLine,
	side: "LEFT" | "RIGHT",
): number | null {
	return side === "LEFT" ? line.oldNo : line.newNo;
}
