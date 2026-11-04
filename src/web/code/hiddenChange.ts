import type { Mark } from "./Invisibles";
import { DEFAULT_TAB_WIDTH, type Piece, renderInvisibles } from "./invisibles";

export interface HiddenChangeOptions {
	tabWidth?: number;
	/** A newline follows the line (false for the last line without one). */
	newline?: boolean;
	/** The line it pairs with (its word marks are its own business). */
	partner?: { text: string; newline?: boolean };
}

/** How a line looks while hidden characters are off. */
const piecesOff = (text: string, tabWidth: number, newline: boolean) =>
	renderInvisibles(text, tabWidth, { newline, show: false });

/**
 * Where the line's trailing blanks start (UTF-16 offset): everything from
 * there on (spaces, tabs, a CRLF's `\r`) draws nothing while hidden
 * characters are off.
 */
function trailFrom(pieces: Piece[]): number {
	let trail = 0;
	for (const piece of pieces) {
		if (piece.kind === "escape") trail = piece.start + piece.raw.length;
		else if (piece.kind === "text") {
			const kept = piece.raw.replace(/ +$/, "");
			if (kept) trail = piece.start + kept.length;
		}
	}
	return trail;
}

/** What is on screen, column for column, with trailing blanks left out. */
const look = (pieces: Piece[]) =>
	pieces
		.map((p) =>
			p.kind === "tab"
				? " ".repeat(p.columns)
				: p.kind === "escape"
					? p.label
					: p.kind === "eol"
						? ""
						: p.raw,
		)
		.join("")
		.replace(/ +$/, "");

/**
 * Whether a changed line's word marks hold a change that doesn't show while
 * "Show hidden characters" is off, so the reader should be told: a mark
 * that draws nothing (a line ending's `\r`, trailing spaces or tabs), or a
 * line that looks exactly like its partner (a tab swapped for spaces of the
 * same width). Escaped characters (zero widths, no-break spaces, bidi
 * controls) show as `\uXXXX` either way, so they never count.
 */
export function hiddenChange(
	text: string,
	marks: readonly Mark[],
	options: HiddenChangeOptions = {},
): boolean {
	if (marks.length === 0) return false;
	const { tabWidth = DEFAULT_TAB_WIDTH, newline = true, partner } = options;
	const pieces = piecesOff(text, tabWidth, newline);
	const trail = trailFrom(pieces);
	if (marks.some(([from, to]) => to > from && from >= trail)) return true;
	if (!partner) return false;
	return (
		look(pieces) ===
		look(piecesOff(partner.text, tabWidth, partner.newline ?? true))
	);
}
