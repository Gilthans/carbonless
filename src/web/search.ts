/**
 * The router's search params: every value is the string in the address.
 * TanStack's default JSON-parses them, so `?head=1234567` (an all-digit
 * SHA prefix) became a number and `?path=123` too; each route's
 * validateSearch reads strings (and the numbers and booleans it wants)
 * itself. A JSON-quoted string is still read as its text, as the default
 * wrote links that way.
 */
export function parseSearch(searchStr: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of new URLSearchParams(searchStr)) {
		out[key] = quoted(value) ?? value;
	}
	return out;
}

function quoted(value: string): string | null {
	if (!value.startsWith('"')) return null;
	try {
		const text: unknown = JSON.parse(value);
		return typeof text === "string" ? text : null;
	} catch {
		return null;
	}
}

/** The search as `?k=v&...` (none for an empty one); parseSearch reads it back. */
export function stringifySearch(search: Record<string, unknown>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(search)) {
		if (value === undefined) continue;
		const text =
			typeof value === "string"
				? // Only a value that starts with a quote needs one more to stay itself.
					value.startsWith('"')
					? JSON.stringify(value)
					: value
				: typeof value === "object" && value !== null
					? JSON.stringify(value)
					: String(value);
		params.set(key, text);
	}
	const str = params.toString();
	return str ? `?${str}` : "";
}
