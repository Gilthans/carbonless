/**
 * How a file's bytes become display text: UTF-8 when every side is valid
 * UTF-8, otherwise latin1, which maps each byte to one character and so
 * never merges two different byte sequences.
 */
export type TextEncoding = "utf8" | "latin1";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isUtf8(bytes: Uint8Array): boolean {
	try {
		strictUtf8.decode(bytes);
		return true;
	} catch {
		return false;
	}
}

export function chooseEncoding(...sides: Uint8Array[]): TextEncoding {
	return sides.every(isUtf8) ? "utf8" : "latin1";
}

export function decode(bytes: Uint8Array, encoding: TextEncoding): string {
	return encoding === "utf8"
		? strictUtf8.decode(bytes)
		: Buffer.from(bytes).toString("latin1");
}

/** Lines the way git counts them, and whether the last one lacks a newline. */
export function decodeLines(
	bytes: Uint8Array,
	encoding: TextEncoding,
): { lines: string[]; noNewlineAtEnd: boolean } {
	const text = decode(bytes, encoding);
	if (text === "") return { lines: [], noNewlineAtEnd: false };
	const lines = text.split("\n");
	const noNewlineAtEnd = lines[lines.length - 1] !== "";
	if (!noNewlineAtEnd) lines.pop();
	return { lines, noNewlineAtEnd };
}

/** The exact bytes of decoded text, one character per byte, for hashing. */
export function byteString(text: string, encoding: TextEncoding): string {
	return encoding === "latin1"
		? text
		: Buffer.from(text, "utf8").toString("latin1");
}
