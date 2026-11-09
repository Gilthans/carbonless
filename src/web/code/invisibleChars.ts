/**
 * Shows the characters code is made of, the way Notepad++'s "Show All
 * Characters" does: spaces as `·` (except a lone space between two printing
 * characters), tabs as `\t` padded to the next tab stop,
 * line endings as `\n` / `\r\n` / `\r`, and anything that would print as
 * nothing (or deceive) as a `\uXXXX` escape.
 *
 * `renderInvisibles` only splits a line into pieces; every piece keeps the
 * exact original characters (`raw`), so what is shown never changes what is
 * copied. Rendering lives in Invisibles.tsx.
 */

import {
	JOINING_SCRIPTS,
	JOINING_TYPES,
	type JoiningType,
} from "./joiningTypes";

export const DEFAULT_TAB_WIDTH = 4;

export type Piece =
	/** Ordinary text, `start` its UTF-16 offset in the line. */
	| { kind: "text"; raw: string; start: number }
	/**
	 * A run of U+0020, one `·` each (only while invisibles show). A lone
	 * space between two printing characters is part of the text instead.
	 */
	| { kind: "space"; raw: string; start: number }
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
			/**
			 * Kept unescaped elsewhere (part of an emoji or a joining
			 * script), escaped here because it lies inside a mark.
			 */
			kept?: true;
	  }
	/** The line ending: `label` is "" when invisibles are hidden. */
	| { kind: "eol"; raw: "" | "\r"; start: number; label: string };

export interface RenderOptions {
	/** A newline follows the line (false for the last line without one). */
	newline?: boolean;
	/**
	 * Spaces, tab markers, line endings and U+FEFF (Settings: "Show hidden
	 * characters"): off, code looks as it does in an editor, and an editor
	 * draws a BOM as nothing wherever it is (owner, 2026-11-08);
	 * hiddenChange and hiddenLines flag a change made of one. Other escapes
	 * show either way: hiding them would hide content.
	 */
	show?: boolean;
	/**
	 * A pair's word marks (UTF-16 `[from, to)`). While invisibles show, a
	 * selector, joiner or tag kept unescaped (it draws nothing inside an
	 * emoji or a script that needs it) that lies inside one is escaped
	 * like any other invisible, so a change made of it shows (owner,
	 * 2026-11-04). Outside the marks, emoji stay whole.
	 */
	marks?: readonly (readonly [from: number, to: number])[];
}

const BIDI = /^[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]$/u;
const VARIATION = /^[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]$/u;
const TAG = /^[\u{E0020}-\u{E007F}]$/u;
const BLACK_FLAG = 0x1f3f4;
const ZWJ = "\u200D";
const ZWNJ = "\u200C";
export const BOM = "\uFEFF";

/**
 * Prints as nothing, as a blank that isn't a plain space, or not as itself:
 * controls (C0 but tab/LF/CR, DEL, C1), format characters (zero widths,
 * BOM, soft hyphen, bidi controls, tags), unusual spaces, line and paragraph
 * separators, other default-ignorable code points (variation selectors,
 * Hangul fillers), lone surrogates and the braille blank.
 */
export const INVISIBLE =
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
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const MODIFIER = /^\p{Emoji_Modifier}$/u;
const MODIFIER_BASE = /^\p{Emoji_Modifier_Base}$/u;
const REGIONAL = /^\p{Regional_Indicator}$/u;
const MARK = /^\p{M}$/u;
const LETTER = /^\p{L}$/u;
const KEYCAP_BASE = /^[0-9#*]$/;
const KEYCAP = String.fromCharCode(0x20e3);
const VS15 = String.fromCharCode(0xfe0e);
const VS16 = String.fromCharCode(0xfe0f);
/**
 * Viramas (Canonical_Combining_Class=Virama) by script: a joiner after one
 * picks a half form or conjunct. Thai phinthu and the Tamil pulli are left
 * out (no joiner use worth the risk); so is any script not listed.
 */
const VIRAMAS: [script: string, codePoints: number[]][] = [
	["Devanagari", [0x094d]],
	["Bengali", [0x09cd]],
	["Gurmukhi", [0x0a4d]],
	["Gujarati", [0x0acd]],
	["Oriya", [0x0b4d]],
	["Telugu", [0x0c4d]],
	["Kannada", [0x0ccd]],
	["Malayalam", [0x0d3b, 0x0d3c, 0x0d4d]],
	["Sinhala", [0x0dca]],
	["Lao", [0x0eba]],
	["Tibetan", [0x0f84]],
	["Myanmar", [0x1039, 0x103a]],
	["Tagalog", [0x1714, 0x1715]],
	["Hanunoo", [0x1734]],
	["Khmer", [0x17d2]],
	["Tai_Tham", [0x1a60]],
	["Balinese", [0x1b44]],
	["Sundanese", [0x1baa, 0x1bab]],
	["Batak", [0x1bf2, 0x1bf3]],
	["Syloti_Nagri", [0xa806, 0xa82c]],
	["Saurashtra", [0xa8c4]],
	["Rejang", [0xa953]],
	["Javanese", [0xa9c0]],
	["Meetei_Mayek", [0xaaf6, 0xabed]],
	["Kharoshthi", [0x10a3f]],
	["Brahmi", [0x11046, 0x11070, 0x1107f]],
	["Kaithi", [0x110b9]],
	["Chakma", [0x11133, 0x11134]],
	["Sharada", [0x111c0]],
	["Khojki", [0x11235]],
	["Khudawadi", [0x112ea]],
	["Grantha", [0x1134d]],
	["Newa", [0x11442]],
	["Tirhuta", [0x114c2]],
	["Siddham", [0x115bf]],
	["Modi", [0x1163f]],
	["Takri", [0x116b6]],
	["Ahom", [0x1172b]],
	["Dogra", [0x11839]],
	["Dives_Akuru", [0x1193d, 0x1193e]],
	["Nandinagari", [0x119e0]],
	["Zanabazar_Square", [0x11a34, 0x11a47]],
	["Soyombo", [0x11a99]],
	["Bhaiksuki", [0x11c3f]],
	["Masaram_Gondi", [0x11d44, 0x11d45]],
	["Gunjala_Gondi", [0x11d97]],
	["Kawi", [0x11f41, 0x11f42]],
];
/** Virama code point to a test for a letter of its script. */
const VIRAMA_SCRIPT = new Map<number, RegExp>(
	VIRAMAS.flatMap(([script, codePoints]) => {
		const re = new RegExp(`^\\p{Script=${script}}$`, "u");
		return codePoints.map((cp) => [cp, re] as [number, RegExp]);
	}),
);

/** Joining_Type of a code point (generated from Unicode data), or undefined. */
function joiningType(ch: string | undefined): JoiningType | undefined {
	if (!visible(ch)) return undefined;
	const cp = ch.codePointAt(0) as number;
	let lo = 0;
	let hi = JOINING_TYPES.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const [first, last, type] = JOINING_TYPES[mid] as readonly [
			number,
			number,
			JoiningType,
		];
		if (cp < first) hi = mid - 1;
		else if (cp > last) lo = mid + 1;
		else return type;
	}
	return undefined;
}

/** Script_Extensions tests for the scripts whose letters join. */
const SCRIPT_EXTENSIONS = JOINING_SCRIPTS.map(
	(script) => new RegExp(`^\\p{Script_Extensions=${script}}$`, "u"),
);
const INHERITED = /^\p{Script=Inherited}$/u;
const NONSPACING = /^[\p{Mn}\p{Me}]$/u;

/** Indices of the joining scripts `ch` belongs to. */
const joiningScripts = (ch: string) =>
	SCRIPT_EXTENSIONS.flatMap((re, k) => (re.test(ch) ? [k] : []));

/**
 * The letter next to a ZWNJ (step -1: before, 1: after), past nonspacing
 * marks that show and belong to it (inherited, or of its own script). An
 * invisible mark (CGJ, a variation selector) or a foreign one ends the
 * search: no letter.
 */
function joiningNeighbour(
	chars: string[],
	i: number,
	step: -1 | 1,
): string | undefined {
	const marks: string[] = [];
	let j = i + step;
	while (is(NONSPACING, chars[j]) && visible(chars[j])) {
		marks.push(chars[j] as string);
		j += step;
	}
	const letter = chars[j];
	if (!visible(letter) || !is(LETTER, letter)) return undefined;
	const own = joiningScripts(letter);
	const belongs = (mark: string) =>
		INHERITED.test(mark) || joiningScripts(mark).some((k) => own.includes(k));
	return marks.every(belongs) ? letter : undefined;
}

/** The tags of the RGI subdivision flags (England, Scotland, Wales). */
const FLAG_TAGS = ["gbeng", "gbsct", "gbwls"].map((code) =>
	[...code]
		.map((c) => String.fromCodePoint(0xe0000 + (c.codePointAt(0) as number)))
		.concat("\u{E007F}"),
);

/** Neither invisible (escaped or default-ignorable) nor undefined. */
const visible = (ch: string | undefined): ch is string =>
	ch !== undefined && !INVISIBLE.test(ch);
const nonAscii = (ch: string) => (ch.codePointAt(0) as number) > 0x7f;

/** Index of the letter a run of marks before `i` sits on, or -1. */
function baseBefore(chars: string[], i: number): number {
	let j = i - 1;
	while (j >= 0 && is(MARK, chars[j]) && visible(chars[j])) j--;
	return j;
}

/** An emoji that shows as one: emoji presentation, or text made emoji by VS16. */
const emojiAt = (chars: string[], j: number) => {
	const ch = chars[j];
	if (!visible(ch) || !nonAscii(ch)) return false;
	return (
		is(EMOJI_PRESENTATION, ch) ||
		(is(PICTOGRAPHIC, ch) && chars[j + 1] === VS16)
	);
};

/**
 * A joiner (ZWJ or ZWNJ) after a virama, on a letter of the virama's own
 * script: Indic half forms and conjuncts.
 */
function afterVirama(chars: string[], i: number): boolean {
	const virama = chars[i - 1];
	const script =
		virama === undefined
			? undefined
			: VIRAMA_SCRIPT.get(virama.codePointAt(0) as number);
	if (!script) return false;
	const base = chars[baseBefore(chars, i - 1)];
	return visible(base) && is(LETTER, base) && script.test(base);
}

/**
 * A ZWNJ between letters of one script that would otherwise join (IDNA
 * CONTEXTJ): the letter before joins on its left (Joining_Type L or D), the
 * one after on its right (R or D).
 */
function betweenJoiningLetters(chars: string[], i: number): boolean {
	const before = joiningNeighbour(chars, i, -1);
	const after = joiningNeighbour(chars, i, 1);
	const left = joiningType(before);
	const right = joiningType(after);
	if (!(left === "L" || left === "D") || !(right === "R" || right === "D")) {
		return false;
	}
	const scripts = joiningScripts(before as string);
	return joiningScripts(after as string).some((k) => scripts.includes(k));
}

/** A ZWJ inside an emoji ZWJ sequence: emoji (skin tone, VS16) ZWJ emoji. */
function inEmojiSequence(chars: string[], i: number): boolean {
	let j = i - 1;
	if (chars[j] === VS16) j--;
	else if (is(MODIFIER, chars[j]) && is(MODIFIER_BASE, chars[j - 1])) j--;
	return emojiAt(chars, j) && emojiAt(chars, i + 1);
}

/**
 * Whether an invisible character is doing its legitimate job, so escaping it
 * would break text that displays correctly. Anything else, and anything this
 * isn't sure about, is escaped.
 */
function attached(chars: string[], i: number, inFlag: boolean): boolean {
	const ch = chars[i] as string;
	const prev = chars[i - 1];
	if (ch === VS15 || ch === VS16) {
		// After an emoji, or a keycap's digit, # or *.
		if (visible(prev) && nonAscii(prev) && is(EMOJI, prev)) return true;
		return is(KEYCAP_BASE, prev) && chars[i + 1] === KEYCAP;
	}
	// Ideographic variation selectors are always escaped: rare in code.
	if (ch === ZWNJ) {
		return afterVirama(chars, i) || betweenJoiningLetters(chars, i);
	}
	if (ch === ZWJ) {
		return afterVirama(chars, i) || inEmojiSequence(chars, i);
	}
	return inFlag && is(TAG, ch);
}

/** East Asian Wide and Fullwidth (UAX #11), outside emoji. */
const WIDE: [number, number][] = [
	[0x1100, 0x115f],
	[0x2329, 0x232a],
	[0x2e80, 0x303e],
	[0x3041, 0x33ff],
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf],
	[0xa960, 0xa97f],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe10, 0xfe19],
	[0xfe30, 0xfe6f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x16fe0, 0x16fe4],
	[0x17000, 0x18cff],
	[0x1aff0, 0x1b2ff],
	[0x1f200, 0x1f2ff],
	[0x20000, 0x2fffd],
	[0x30000, 0x3fffd],
];
const isWide = (codePoint: number, ch: string) =>
	WIDE.some(([lo, hi]) => codePoint >= lo && codePoint <= hi) ||
	EMOJI_PRESENTATION.test(ch);

/** A character that prints (not a space, tab or other blank, nor invisible). */
const solid = (ch: string | undefined): boolean =>
	ch !== undefined && !/^\s$/u.test(ch) && !INVISIBLE.test(ch);

/**
 * Splits one line (without its "\n"; a CRLF line keeps its "\r") into pieces.
 * Tab stops count display columns (wide characters and emoji two, an emoji
 * sequence as one), so a tab after an escape or an ideograph still lands on
 * the next stop of what is on screen.
 */
export function renderInvisibles(
	text: string,
	tabWidth: number = DEFAULT_TAB_WIDTH,
	options: RenderOptions = {},
): Piece[] {
	const { newline = true, show = true } = options;
	const marks = show ? (options.marks ?? []) : [];
	const marked = (from: number, to: number) =>
		marks.some(([f, t]) => f <= from && to <= t);
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
	// Tags of an RGI subdivision flag run up to this index.
	let flagEnd = -1;
	// Columns of the last character drawn (VS16 can widen it to two).
	let last = 0;
	// The last character was a kept ZWJ: an emoji after it joins that glyph.
	let joined = false;
	// A regional indicator waits for its pair (a flag is one glyph).
	let regional = false;
	let run: { kind: "text"; raw: string; start: number } | undefined;
	const pushText = (ch: string, columns: number) => {
		if (run) run.raw += ch;
		else {
			run = { kind: "text", raw: ch, start: offset };
			pieces.push(run);
		}
		column += columns;
		if (columns > 0) last = columns;
	};
	const push = (piece: Piece) => {
		run = undefined;
		pieces.push(piece);
	};
	for (let i = 0; i < body; i++) {
		const ch = chars[i] as string;
		const codePoint = ch.codePointAt(0) as number;
		// Printable ASCII: the common case, kept fast.
		if (codePoint > 0x20 && codePoint < 0x7f) {
			pushText(ch, 1);
			joined = false;
			regional = false;
			offset += 1;
			continue;
		}
		if (codePoint === BLACK_FLAG) {
			const tags = chars.slice(i + 1, i + 7).join("");
			if (FLAG_TAGS.some((seq) => seq.join("") === tags)) flagEnd = i + 6;
		}
		const wasJoined: boolean = joined;
		const wasRegional: boolean = regional;
		joined = false;
		regional = false;
		if (ch === "\t") {
			let columns = width - (column % width);
			if (show && columns < 2) columns += width;
			push({ kind: "tab", raw: "\t", start: offset, columns, marker: show });
			column += columns;
			last = columns;
		} else if (ch === " ") {
			const prior = pieces[pieces.length - 1];
			// A lone space between two printing characters is ordinary
			// spacing: no dot. Runs of two or more, and a space at either end
			// of the line or next to another blank, keep theirs (a trailing
			// space can be all that changed in a line).
			if (!show || (solid(chars[i - 1]) && i + 1 < body && solid(chars[i + 1])))
				pushText(ch, 1);
			else if (!run && prior?.kind === "space") {
				prior.raw += " ";
				column += 1;
			} else {
				push({ kind: "space", raw: " ", start: offset });
				column += 1;
			}
			last = 1;
		} else if (ch === BOM && !show) {
			// A byte order mark (or zero width no-break space): drawn as
			// nothing, as an editor does, until hidden characters show.
			pushText(ch, 0);
		} else if (ch === "\r" || INVISIBLE.test(ch)) {
			// Attached to what it modifies (an emoji, a joining script), it
			// draws nothing and is kept, unless it lies inside a mark while
			// invisibles show.
			const glued = ch !== "\r" && attached(chars, i, i <= flagEnd);
			if (glued && !marked(offset, offset + ch.length)) {
				// VS16 turns a one-column symbol into a two-column emoji.
				if (ch === VS16 && last === 1) pushText(ch, 1);
				else pushText(ch, 0);
				if (ch === VS16) last = 2;
				joined = ch === ZWJ;
			} else {
				const label = ch === "\r" ? "\\r" : escapeLabel(codePoint);
				push({
					kind: "escape",
					raw: ch,
					start: offset,
					label,
					name: describeCodePoint(codePoint),
					bidi: BIDI.test(ch),
					...(glued ? { kept: true as const } : {}),
				});
				column += label.length;
				last = label.length;
			}
		} else if (
			is(MARK, ch) ||
			(wasJoined && is(PICTOGRAPHIC, ch)) ||
			(is(MODIFIER, ch) && is(MODIFIER_BASE, chars[i - 1]))
		) {
			pushText(ch, 0);
		} else if (is(REGIONAL, ch)) {
			pushText(ch, wasRegional ? 0 : 2);
			regional = !wasRegional;
		} else {
			pushText(ch, isWide(codePoint, ch) ? 2 : 1);
		}
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
