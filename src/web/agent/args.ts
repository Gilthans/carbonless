/**
 * The setup modal's Arguments field: one line for the agent's argv. Spaces
 * split it; double quotes keep a word with spaces together (inside them,
 * \" is a quote and \\ a backslash); single quotes keep it together as
 * typed; outside quotes a backslash is itself (Windows paths). A saved
 * argv shows the same way and reads back unchanged.
 */

/** `args` as the field shows it: plain where it can be, else double-quoted. */
export function formatArgs(args: readonly string[]): string {
	return args
		.map((a) =>
			a !== "" && !/[\s"']/.test(a)
				? a
				: `"${a.replace(/[\\"]/g, (c) => `\\${c}`)}"`,
		)
		.join(" ");
}

/** The field's text as an argv (an unclosed quote runs to the end). */
export function parseArgs(text: string): string[] {
	const out: string[] = [];
	let word: string | null = null;
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i] as string;
		if (quote === "'") {
			if (c === "'") quote = null;
			else word += c;
		} else if (quote === '"') {
			const next = text[i + 1];
			if (c === "\\" && (next === '"' || next === "\\")) {
				word += next;
				i++;
			} else if (c === '"') quote = null;
			else word += c;
		} else if (/\s/.test(c)) {
			if (word !== null) out.push(word);
			word = null;
		} else if (c === '"' || c === "'") {
			quote = c;
			word ??= "";
		} else {
			word = (word ?? "") + c;
		}
	}
	if (word !== null) out.push(word);
	return out;
}
