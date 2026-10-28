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
	/** The client id: a marker without one isn't carbonless's. */
	id: string;
	/** The span; null without one, or one that doesn't parse. */
	span: MarkerSpan | null;
}

/** Client ids a marker can carry: no spaces, nothing that could end the comment. */
export const MARKER_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

/**
 * Where `text`'s trailing crb comment starts (the whitespace before it
 * included) and its inside after `crb:`; null without one: an HTML
 * comment at the very end (trailing whitespace aside) whose inside starts
 * `crb:` (ours decides whether it is carbonless's). Linear: no
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

/**
 * A trailing marker's inside, parsed: carbonless's only when it is v1 and
 * carries a well-formed id (a span that doesn't parse is null). Anything
 * else that merely looks like one (someone's own text) is null: not ours.
 */
function parsed(inner: string): Marker | null {
	const words = inner.trim().split(/\s+/);
	if (words[0] !== "v1") return null;
	let id: string | null = null;
	let span: MarkerSpan | null = null;
	for (const word of words.slice(1)) {
		// The first "=" only: a value may hold more.
		const at = word.indexOf("=");
		if (at < 0) continue;
		const key = word.slice(0, at);
		const value = word.slice(at + 1);
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
	return id === null ? null : { id, span };
}

/** Where carbonless's own trailing marker starts in `text`, and it parsed; null without one. */
function ours(
	text: string,
	open = "<!--",
	close = "-->",
): { start: number; marker: Marker } | null {
	const m = trailing(text, open, close);
	const marker = m && parsed(m.inner);
	return m && marker ? { start: m.start, marker } : null;
}

/** `body`'s trailing marker, parsed; null when it has none of carbonless's. */
export function parseMarker(body: string): Marker | null {
	return ours(body)?.marker ?? null;
}

/** `body` without carbonless's trailing marker (and the blank before it). */
export function stripMarker(body: string): string {
	const m = ours(body);
	return m ? body.slice(0, m.start) : body;
}

/** `html` without carbonless's trailing marker, should GitHub's rendering keep one. */
export function stripMarkerHtml(html: string): string {
	const m = ours(html) ?? ours(html, "&lt;!--", "--&gt;");
	return m ? html.slice(0, m.start) : html;
}

/** `body`'s trailing marker of carbonless's as written (with the blank before it), or "". */
export function markerText(body: string): string {
	const m = ours(body);
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
