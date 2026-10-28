import type { CodeAnchor } from "../shared/types.js";

/**
 * The hidden marker carbonless appends to a thread's opening comment on
 * GitHub: `<!-- crb:v1 id=<clientId> -->`, with a span `span=<startLine>:
 * <startCol>-<line>:<endCol>` (the lines posted). GitHub hides an HTML
 * comment when it renders the body; the source keeps it. It carries the
 * write's client id (a retry finds the comment by it) and the span's
 * columns, which GitHub has no field for. Server only: every body the
 * server sends has it stripped.
 */

/** The columns of a span, on the lines posted. */
export interface MarkerSpan {
	startLine: number;
	startCol: number;
	line: number;
	endCol: number;
}

export interface Marker {
	/** The client id; null when the marker has none (hand-edited). */
	id: string | null;
	/** The span; null without one, or one that doesn't parse. */
	span: MarkerSpan | null;
}

/** Client ids a marker can carry: no spaces, nothing that could end the comment. */
export const MARKER_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

/**
 * Where `text`'s trailing crb marker starts (the whitespace before it
 * included) and its inside; null without one. A marker is any HTML
 * comment at the very end (trailing whitespace aside) whose inside starts
 * `crb:`, a hand-edited one too; any other is left as text. Linear: no
 * backtracking over a long body.
 */
function trailing(
	text: string,
	open: string,
	close: string,
): { start: number; inner: string } | null {
	const end = text.trimEnd();
	if (!end.endsWith(close)) return null;
	const at = end.lastIndexOf(open, end.length - close.length);
	if (at < 0) return null;
	const inner = end.slice(at + open.length, end.length - close.length);
	if (inner.includes(close) || !inner.trimStart().startsWith("crb:")) {
		return null;
	}
	let start = at;
	while (start > 0 && /\s/.test(text[start - 1] ?? "")) start--;
	return { start, inner: inner.trimStart().slice("crb:".length) };
}

const SPAN = /^(\d{1,9}):(\d{1,9})-(\d{1,9}):(\d{1,9})$/;

/** The marker for a new thread's opener, to append to its body. */
export function markerFor(clientId: string, span?: MarkerSpan | null): string {
	if (!MARKER_ID.test(clientId)) throw new Error("Not a marker id");
	const s = span
		? ` span=${span.startLine}:${span.startCol}-${span.line}:${span.endCol}`
		: "";
	return `\n\n<!-- crb:v1 id=${clientId}${s} -->`;
}

/** `body`'s trailing crb marker, parsed; null when it has none. */
export function parseMarker(body: string): Marker | null {
	const m = trailing(body, "<!--", "-->");
	if (!m) return null;
	const words = m.inner.trim().split(/\s+/);
	// Only v1 is read; any other crb marker is stripped, but means nothing.
	if (words[0] !== "v1") return { id: null, span: null };
	let id: string | null = null;
	let span: MarkerSpan | null = null;
	for (const word of words.slice(1)) {
		const [key, value = ""] = word.split("=", 2);
		if (key === "id" && MARKER_ID.test(value)) id = value;
		if (key === "span") {
			const s = SPAN.exec(value);
			if (s) {
				const [startLine, startCol, line, endCol] = s.slice(1).map(Number);
				if (
					startLine !== undefined &&
					startCol !== undefined &&
					line !== undefined &&
					endCol !== undefined &&
					startLine > 0 &&
					line > 0
				) {
					span = { startLine, startCol, line, endCol };
				}
			}
		}
	}
	return { id, span };
}

/** `body` without its trailing crb marker (and the blank before it). */
export function stripMarker(body: string): string {
	const m = trailing(body, "<!--", "-->");
	return m ? body.slice(0, m.start) : body;
}

/** `html` without a trailing crb marker, should GitHub's rendering keep one. */
export function stripMarkerHtml(html: string): string {
	const m =
		trailing(html, "<!--", "-->") ?? trailing(html, "&lt;!--", "--&gt;");
	return m ? html.slice(0, m.start) : html;
}

/** `body`'s trailing marker as written (with the blank before it), or "". */
export function markerText(body: string): string {
	const m = trailing(body, "<!--", "-->");
	return m ? body.slice(m.start) : "";
}

/**
 * The span's columns for `anchor`, from the opener's marker: only when
 * the marker's lines are the anchor's own (GitHub's original range), so a
 * thread whose lines moved or were edited falls back to whole lines.
 */
export function spanCols(
	marker: Marker | null,
	anchor: Pick<CodeAnchor, "startLine" | "line">,
): { startCol: number; endCol: number } | null {
	const span = marker?.span;
	if (!span) return null;
	if (span.startLine !== anchor.startLine || span.line !== anchor.line) {
		return null;
	}
	return { startCol: span.startCol, endCol: span.endCol };
}
