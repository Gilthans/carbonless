/**
 * One line for the server's log (stderr) about a request that failed on
 * the server's side (a git, gh or placement failure mapped to a 5xx):
 * enough to find it again, never a secret. The server runs with no
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
	let line =
		message
			.split(/\r\n|[\n\r\u0085\u2028\u2029]/)
			.find((l) => l.trim() !== "") ?? "";
	if (accessKey) line = line.split(accessKey).join("<key>");
	line = line
		// Any URL (a remote's can carry a token, a page's the key).
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
		// key=, token=, … in whatever survived.
		.replace(
			/\b(key|token|access_token|password|secret|auth)=[^\s&]+/gi,
			"$1=<redacted>",
		)
		// A credential before a host, with no scheme (`user:token@host`).
		.replace(/[^\s/@:]+:[^\s/@]+@(?=[A-Za-z0-9.-])/g, "<credentials>@")
		// GitHub's tokens, wherever they appear.
		.replace(/\b(gh[opsur]_|github_pat_)[A-Za-z0-9_]+/g, "<token>")
		// An Authorization header's value.
		.replace(
			/\b(bearer|basic|token)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{8,}/gi,
			"$1 <redacted>",
		)
		// No control characters (a terminal's escapes, C1's CSI) and no
		// Unicode line breaks: one line stays one line in any log viewer.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: that's the point.
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
		.trim();
	return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE)}…` : line;
}

/** How long the same failure (review, route, status, class) is logged once. */
export const FAILURE_LOG_WINDOW_MS = 60_000;

/**
 * The server's failure log (CAR-271): each failureLine once per
 * FAILURE_LOG_WINDOW_MS for the same review, route, status and error
 * class; the next one says how many were left out meanwhile. A page
 * asking again and again never floods the journal.
 */
export class FailureLog {
	readonly #last = new Map<string, { at: number; left: number }>();
	constructor(
		private readonly write: (line: string) => void,
		private readonly now: () => number = Date.now,
	) {}

	log(failure: Parameters<typeof failureLine>[0]): void {
		const { error } = failure;
		const kind = error instanceof Error ? error.constructor.name : typeof error;
		const key = JSON.stringify([
			failure.reviewId,
			failure.method,
			failure.route,
			failure.status,
			kind,
		]);
		const now = this.now();
		const last = this.#last.get(key);
		if (last && now - last.at < FAILURE_LOG_WINDOW_MS) {
			last.left++;
			return;
		}
		// Old entries go: the map stays as small as the minute's failures.
		for (const [k, v] of this.#last)
			if (now - v.at >= FAILURE_LOG_WINDOW_MS) this.#last.delete(k);
		const left = last?.left ?? 0;
		this.#last.set(key, { at: now, left: 0 });
		this.write(
			failureLine(failure) +
				(left > 0 ? ` (and ${left} more like it in the last minute)` : ""),
		);
	}
}
