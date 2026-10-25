/**
 * Shows the characters code is made of, the way Notepad++'s "Show All
 * Characters" does: spaces as `·`, tabs as `\t` padded to the next tab stop,
 * line endings as `\n` / `\r\n` / `\r`, and anything that would print as
 * nothing (or deceive) as a `\uXXXX` escape.
 *
 * `renderInvisibles` only splits a line into pieces; every piece keeps the
 * exact original characters (`raw`), so what is shown never changes what is
 * copied. Rendering lives in Invisibles.tsx.
 */

export const DEFAULT_TAB_WIDTH = 4;

export type Piece =
	/** Ordinary text, `start` its UTF-16 offset in the line. */
	| { kind: "text"; raw: string; start: number }
	/** U+0020, drawn as `·` (only while invisibles show). */
	| { kind: "space"; raw: " "; start: number }
	/**
	 * A tab: `columns` wide, up to the next tab stop. While invisibles show,
	 * it starts with the `\t` marker (so it is at least 2 columns).
	 */
	| { kind: "tab"; raw: "\t"; start: number; columns: number; marker: boolean }
	/**
	 * A character that would print as nothing or mislead, shown as `label`.
	 * `bidi`: a bidirectional control, the "Trojan Source" vector.
	 */
	| {
			kind: "escape";
			raw: string;
			start: number;
			label: string;
			name: string;
			bidi: boolean;
	  }
	/** The line ending: `label` is "" when invisibles are hidden. */
	| { kind: "eol"; raw: "" | "\r"; start: number; label: string };

export interface RenderOptions {
	/** A newline follows the line (false for the last line without one). */
	newline?: boolean;
	/**
	 * Spaces, tab markers and line endings (the ¶ toggle). Escapes show
	 * either way: hiding them would hide content.
	 */
	show?: boolean;
}

const BIDI = /^[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]$/u;
const VARIATION = /^[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]$/u;
const TAG = /^[\u{E0020}-\u{E007F}]$/u;
const BLACK_FLAG = 0x1f3f4;
const ZWJ = "\u200D";
const ZWNJ = "\u200C";

/**
 * Prints as nothing, as a blank that isn't a plain space, or not as itself:
 * controls (C0 but tab/LF/CR, DEL, C1), format characters (zero widths,
 * BOM, soft hyphen, bidi controls, tags), unusual spaces, line and paragraph
 * separators, other default-ignorable code points (variation selectors,
 * Hangul fillers), lone surrogates and the braille blank.
 */
const INVISIBLE =
	/^[\p{Cc}\u2800\p{Cf}\p{Zs}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]$/u;

const NAMES = new Map<number, string>([
	[0x00a0, "no-break space"],
	[0x00ad, "soft hyphen"],
	[0x034f, "combining grapheme joiner"],
	[0x061c, "Arabic letter mark"],
	[0x115f, "Hangul choseong filler"],
	[0x1160, "Hangul jungseong filler"],
	[0x180e, "Mongolian vowel separator"],
	[0x2000, "en quad"],
	[0x2001, "em quad"],
	[0x2002, "en space"],
	[0x2003, "em space"],
	[0x2004, "three-per-em space"],
	[0x2005, "four-per-em space"],
	[0x2006, "six-per-em space"],
	[0x2007, "figure space"],
	[0x2008, "punctuation space"],
	[0x2009, "thin space"],
	[0x200a, "hair space"],
	[0x200b, "zero width space"],
	[0x200c, "zero width non-joiner"],
	[0x200d, "zero width joiner"],
	[0x200e, "left-to-right mark"],
	[0x200f, "right-to-left mark"],
	[0x2028, "line separator"],
	[0x2029, "paragraph separator"],
	[0x202a, "left-to-right embedding"],
	[0x202b, "right-to-left embedding"],
	[0x202c, "pop directional formatting"],
	[0x202d, "left-to-right override"],
	[0x202e, "right-to-left override"],
	[0x202f, "narrow no-break space"],
	[0x205f, "medium mathematical space"],
	[0x2060, "word joiner"],
	[0x2066, "left-to-right isolate"],
	[0x2067, "right-to-left isolate"],
	[0x2068, "first strong isolate"],
	[0x2069, "pop directional isolate"],
	[0x2800, "braille pattern blank"],
	[0x3000, "ideographic space"],
	[0x3164, "Hangul filler"],
	[0xfeff, "byte order mark"],
	[0xffa0, "halfwidth Hangul filler"],
]);

/** `\u00A0`, `\u{E0041}`: uppercase, at least 4 digits. */
export function escapeLabel(codePoint: number): string {
	const hex = codePoint.toString(16).toUpperCase().padStart(4, "0");
	return codePoint > 0xffff ? `\\u{${hex}}` : `\\u${hex}`;
}

/** "U+200B zero width space", for a tooltip. */
export function describeCodePoint(codePoint: number): string {
	const hex = codePoint.toString(16).toUpperCase().padStart(4, "0");
	const name =
		NAMES.get(codePoint) ??
		(codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)
			? "control character"
			: VARIATION.test(String.fromCodePoint(codePoint))
				? "variation selector"
				: TAG.test(String.fromCodePoint(codePoint))
					? "tag character"
					: "invisible character");
	return `U+${hex} ${name}`;
}

const is = (re: RegExp, ch: string | undefined) =>
	ch !== undefined && re.test(ch);
const EMOJI = /^\p{Emoji}$/u;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const MODIFIER = /^\p{Emoji_Modifier}$/u;
const IDEOGRAPHIC = /^\p{Ideographic}$/u;
/** Letters and marks of scripts that join with ZWJ/ZWNJ (Indic, Arabic...). */
const JOINING = /^[\p{Lo}\p{M}]$/u;
const MARK = /^\p{M}$/u;

/**
 * Whether an invisible character is doing its legitimate job, so escaping it
 * would break text that displays correctly: a variation selector right after
 * an emoji or ideograph, a ZWJ inside an emoji sequence, a joiner in a
 * script that needs one, an emoji flag's tag sequence.
 */
function attached(chars: string[], i: number, inFlagTags: boolean): boolean {
	const ch = chars[i] as string;
	const prev = chars[i - 1];
	if (is(VARIATION, ch)) {
		return (
			prev !== undefined &&
			!is(VARIATION, prev) &&
			(is(EMOJI, prev) || is(IDEOGRAPHIC, prev))
		);
	}
	if (ch === ZWJ) {
		// Back over a variation selector or skin tone to the emoji.
		let j = i - 1;
		while (j >= 0 && (is(VARIATION, chars[j]) || is(MODIFIER, chars[j]))) j--;
		if (is(PICTOGRAPHIC, chars[j]) && is(PICTOGRAPHIC, chars[i + 1])) {
			return true;
		}
	}
	if (ch === ZWJ || ch === ZWNJ) {
		return is(JOINING, prev) && is(JOINING, chars[i + 1]);
	}
	return inFlagTags && is(TAG, ch);
}

/** Display columns of ordinary text: one per code point, none for a mark. */
function textColumns(ch: string): number {
	return MARK.test(ch) ? 0 : 1;
}

/**
 * Splits one line (without its "\n"; a CRLF line keeps its "\r") into pieces.
 * Tab stops count display columns, so a tab after an escape still lands on
 * the next stop of what is on screen.
 */
export function renderInvisibles(
	text: string,
	tabWidth: number = DEFAULT_TAB_WIDTH,
	options: RenderOptions = {},
): Piece[] {
	const { newline = true, show = true } = options;
	const width = Number.isFinite(tabWidth)
		? Math.min(32, Math.max(1, Math.round(tabWidth)))
		: DEFAULT_TAB_WIDTH;
	const chars = Array.from(text);
	// A trailing CR before the newline is part of the line ending.
	const crlf = newline && chars[chars.length - 1] === "\r";
	const body = crlf ? chars.length - 1 : chars.length;
	const pieces: Piece[] = [];
	let offset = 0;
	let column = 0;
	let inFlagTags = false;
	const pushText = (ch: string) => {
		const last = pieces[pieces.length - 1];
		if (last?.kind === "text") last.raw += ch;
		else pieces.push({ kind: "text", raw: ch, start: offset });
		column += textColumns(ch);
	};
	for (let i = 0; i < body; i++) {
		const ch = chars[i] as string;
		const codePoint = ch.codePointAt(0) as number;
		if (codePoint === BLACK_FLAG) inFlagTags = true;
		else if (!is(TAG, ch)) inFlagTags = false;
		if (ch === "\t") {
			let columns = width - (column % width);
			if (show && columns < 2) columns += width;
			pieces.push({
				kind: "tab",
				raw: "\t",
				start: offset,
				columns,
				marker: show,
			});
			column += columns;
		} else if (ch === " ") {
			if (show) {
				pieces.push({ kind: "space", raw: " ", start: offset });
				column += 1;
			} else pushText(ch);
		} else if (
			ch === "\r" ||
			(INVISIBLE.test(ch) && !attached(chars, i, inFlagTags))
		) {
			const label = ch === "\r" ? "\\r" : escapeLabel(codePoint);
			pieces.push({
				kind: "escape",
				raw: ch,
				start: offset,
				label,
				name: describeCodePoint(codePoint),
				bidi: BIDI.test(ch),
			});
			column += label.length;
		} else {
			pushText(ch);
		}
		if (codePoint === 0xe007f) inFlagTags = false;
		offset += ch.length;
	}
	if (crlf) {
		pieces.push({
			kind: "eol",
			raw: "\r",
			start: offset,
			label: show ? "\\r\\n" : "",
		});
	} else if (newline && show) {
		pieces.push({ kind: "eol", raw: "", start: offset, label: "\\n" });
	}
	return pieces;
}

/** The original text back from its pieces (what a copy must yield). */
export const joinPieces = (pieces: Piece[]) =>
	pieces.map((p) => p.raw).join("");
