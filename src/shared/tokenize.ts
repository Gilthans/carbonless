/**
 * GitHub's word tokens and length cut, shared by the word marks
 * (src/web/files/wordDiff.ts) and the similarity pairing
 * (src/shared/linePairing.ts: the side-by-side view and the tracer).
 * A pair with a line this long or longer (UTF-16 `length`) has no marks, as
 * on GitHub.
 */
export const WORD_DIFF_MAX = 1024;

/** A letter, combining mark, digit or `_`: what a word run is made of. */
const WORD = /^[\p{L}\p{M}\p{N}_]$/u;

/** Whether the code point at `i` is a word one (ASCII without the regex). */
function wordAt(text: string, i: number): boolean {
	const c = text.charCodeAt(i);
	if (c < 0x80) {
		return (
			(c >= 0x61 && c <= 0x7a) || // a-z
			(c >= 0x41 && c <= 0x5a) || // A-Z
			(c >= 0x30 && c <= 0x39) || // 0-9
			c === 0x5f // _
		);
	}
	return WORD.test(String.fromCodePoint(text.codePointAt(i) as number));
}

/** UTF-16 length of the code point at `i`. */
const widthAt = (text: string, i: number): number =>
	(text.codePointAt(i) as number) > 0xffff ? 2 : 1;

/** The end of the token that starts at `i`. */
export function tokenEnd(text: string, i: number): number {
	const n = text.length;
	const word = wordAt(text, i);
	let end = i + widthAt(text, i);
	if (word) while (end < n && wordAt(text, end)) end += widthAt(text, end);
	return end;
}

/**
 * The line's tokens: a run of letters, marks, digits and `_` whole, every
 * other code point alone.
 */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < text.length; ) {
		const end = tokenEnd(text, i);
		out.push(text.slice(i, end));
		i = end;
	}
	return out;
}
