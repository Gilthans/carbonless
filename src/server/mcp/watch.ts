/**
 * The watcher a joined session runs in the background: plain `curl` in a
 * retry loop on `/mcp/watch/<review>`. Everything embedded in the shell
 * line is checked against a strict alphabet first, so nothing can leave
 * its single quotes.
 */

export const REVIEW_ID = /^[0-9a-hjkmnp-tv-z]{26}$/;
/** `<review id>.<secret>`: the secret is 32 random bytes, base64url. */
export const SESSION_TOKEN = /^([0-9a-hjkmnp-tv-z]{26})\.([A-Za-z0-9_-]{43})$/;
const ORIGIN = /^https?:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;
const KEY = /^[A-Za-z0-9_-]{1,256}$/;

/** A Host header (or origin's host) that may name this server: a name or address, an optional port. */
export const isSafeOrigin = (origin: string): boolean => ORIGIN.test(origin);

/** The session's token for review `id`. */
export const sessionToken = (id: string, secret: string): string =>
	`${id}.${secret}`;

/** `{id, secret}` of a session token; null for anything else. */
export function parseSessionToken(
	token: unknown,
): { id: string; secret: string } | null {
	if (typeof token !== "string") return null;
	const m = SESSION_TOKEN.exec(token);
	return m ? { id: m[1] as string, secret: m[2] as string } : null;
}

/** Failed connects in a row (5 s apart) before the loop gives up (exit 4). */
export const WATCH_TRIES = 60;

/**
 * The background command: exits 0 when crb writes its line (a question
 * waits, or the session left), 3 on any 4xx (detached: token gone), 4
 * after WATCH_TRIES dropped connections; otherwise reconnects every 5 s.
 * Throws if any part isn't in its alphabet.
 */
export function watchCommand(
	origin: string,
	id: string,
	token: string,
	key: string | null,
): string {
	if (!isSafeOrigin(origin)) throw new Error("Unsafe origin for the watcher");
	if (!REVIEW_ID.test(id)) throw new Error("Unsafe review id for the watcher");
	if (!SESSION_TOKEN.test(token))
		throw new Error("Unsafe token for the watcher");
	if (key !== null && !KEY.test(key)) {
		throw new Error("Unsafe access key for the watcher");
	}
	const url = `${origin}/mcp/watch/${id}${key === null ? "" : `?key=${key}`}`;
	return [
		"n=0;",
		`until curl -sfN -H 'Authorization: Bearer ${token}' '${url}'; do`,
		'[ "$?" -eq 22 ] && exit 3;',
		"n=$((n+1));",
		`[ "$n" -ge ${WATCH_TRIES} ] && exit 4;`,
		"sleep 5;",
		"done",
	].join(" ");
}
