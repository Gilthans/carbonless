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

/** The line's leading spaces and tabs, and how many columns they take. */
function indentOf(text: string, tabWidth: number) {
	const raw = /^[ \t]*/.exec(text)?.[0] ?? "";
	// As renderInvisibles clamps it.
	const width = Number.isFinite(tabWidth)
		? Math.min(32, Math.max(1, Math.round(tabWidth)))
		: DEFAULT_TAB_WIDTH;
	let columns = 0;
	for (const ch of raw) columns += ch === "\t" ? width - (columns % width) : 1;
	return { raw, columns };
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
 * reaching into what draws nothing (a line ending's `\r`, trailing spaces
 * or tabs), even when it starts on something drawn; a line that looks
 * exactly like its partner; or an indent swapped for one as wide (a tab for
 * spaces of the same width), even beside a visible change. Escaped
 * characters (zero widths, no-break spaces, bidi controls) show as
 * `\uXXXX` either way, so they never count.
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
	// A mark reaching into the trailing blanks holds a changed one there:
	// marks are whole changed tokens, merged when adjacent or bridged across
	// unchanged spaces between two changes (wordDiff.ts), so a mark never
	// ends on an unchanged blank. That blank draws nothing, whatever the
	// mark also covers before it.
	if (marks.some(([from, to]) => to > from && to > trail)) return true;
	if (!partner) return false;
	// An indent swapped for one as wide (tabs ↔ spaces): its mark is a
	// tinted blank like the old one, whatever else on the line changed.
	const indent = indentOf(text, tabWidth);
	const other = indentOf(partner.text, tabWidth);
	if (
		indent.raw !== other.raw &&
		indent.columns === other.columns &&
		marks.some(([from, to]) => to > from && from < indent.raw.length)
	) {
		return true;
	}
	return (
		look(pieces) ===
		look(piecesOff(partner.text, tabWidth, partner.newline ?? true))
	);
}
