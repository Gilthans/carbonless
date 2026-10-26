import { hunkWindowRows } from "../src/server/codeWindow";
import type { CodeAnchor, CodeWindow } from "../src/shared/types";

/**
 * A thread's code as the server sends it, from a diff hunk: its window of
 * `hunk` around the anchor's range (the range defaults to `line` alone on
 * the right side), shown to be what the commenter saw unless `snapshot`
 * says otherwise.
 */
export function codeFromHunk(
	hunk: string,
	anchor: Partial<CodeAnchor> & { line: number },
	source: CodeWindow["source"] = "clone",
	snapshot: CodeWindow["snapshot"] = { same: true },
): CodeWindow {
	const full: CodeAnchor = {
		path: "src/a.ts",
		commit: "",
		side: "RIGHT",
		startSide: anchor.side ?? "RIGHT",
		startLine: anchor.line,
		at: "",
		...anchor,
	};
	return { anchor: full, rows: hunkWindowRows(hunk, full), source, snapshot };
}
