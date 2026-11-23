/**
 * One line for the server's log (stderr) about a request that failed on
 * the server's side (a git, gh or placement failure mapped to a 5xx, a read
 * gone): enough to find it again, never a secret. The server runs with no
 * request logger (URLs can carry the access key), so without this line
 * those failures leave no trace (CAR-271).
 *
 * It names the route's pattern (`/api/r/:id/placements`, never the URL and
 * its query), the review id, the status, the error's class and the first
 * line of its message, with URLs, `key=` values, GitHub tokens and the
 * access key itself cut out, and cut to MAX_MESSAGE characters.
 */
export function failureLine(failure: {
	method: string;
	/** The route's pattern; undefined: none matched. */
	route: string | undefined;
	reviewId: unknown;
	status: number;
	error: unknown;
	/** The server's access key, never printed. */
	accessKey?: string | null;
}): string {
	const { method, route, reviewId, status, error, accessKey } = failure;
	const kind =
		error instanceof Error ? error.constructor.name || "Error" : typeof error;
	const raw = error instanceof Error ? error.message : String(error);
	const review =
		typeof reviewId === "string" && REVIEW_ID.test(reviewId)
			? ` review ${reviewId}`
			: "";
	return `crb: ${safeWord(method)} ${route ? redact(route, accessKey) : "?"} ${status} ${safeWord(kind)}${review}: ${redact(raw, accessKey)}`;
}

/** The most of an error's message a log line keeps. */
export const MAX_MESSAGE = 300;

const REVIEW_ID = /^[A-Za-z0-9_-]{1,64}$/;

const safeWord = (s: string) => s.replace(/[^A-Za-z0-9_$.-]/g, "").slice(0, 40);

/** A message cut to one line, with no URL, key or token in it. */
export function redact(message: string, accessKey?: string | null): string {
	let line = message.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
	if (accessKey) line = line.split(accessKey).join("<key>");
	line = line
		// Any URL (a remote's can carry a token, a page's the key).
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
		// key=, token=, … in whatever survived.
		.replace(
			/\b(key|token|access_token|password|secret|auth)=[^\s&]+/gi,
			"$1=<redacted>",
		)
		// GitHub's tokens, wherever they appear.
		.replace(/\b(gh[opsur]_|github_pat_)[A-Za-z0-9_]+/g, "<token>")
		// An Authorization header's value.
		.replace(
			/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
			"$1 <redacted>",
		)
		// No control characters (a terminal's escapes) in the log.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: that's the point.
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.trim();
	return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE)}…` : line;
}
