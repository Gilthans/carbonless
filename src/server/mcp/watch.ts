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

/** Connects refused or timed out in a row (5 s apart) before the loop gives up (exit 4). */
export const WATCH_TRIES = 60;

/** curl's connect timeout, in seconds: an address that drops packets counts as a try this soon. */
export const WATCH_CONNECT_S = 10;

/** Thrown for a server access key a shell line can't carry (code bad-key). */
export class UnsafeKeyError extends Error {
	constructor() {
		super(
			"This carbonless server's access key has characters a shell command can't carry safely, so no watcher can be made. Ask the reviewer to replace it: crb serve --new-key",
		);
	}
}

/**
 * The background command (POSIX sh). curl's output is filtered inside a
 * command substitution, so the keep-alive newlines never reach the
 * harness; curl's status comes through as a `crb-exit <n>` line (no
 * pipefail needed). Ends 0 printing crb's one `carbonless:` line (a
 * question waits, or the session left), 3 on any HTTP status >= 400
 * (curl -f's 22; a 4xx: detached, token gone), 4 after WATCH_TRIES
 * refused or timed-out connects in a row (each connect gives up after
 * WATCH_CONNECT_S, so that is at most about 15 minutes); any other end (a dropped stream: crb restarting)
 * resets that count and reconnects after 5 s. Throws if any part isn't
 * in its alphabet.
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
	if (key !== null && !KEY.test(key)) throw new UnsafeKeyError();
	const url = `${origin}/mcp/watch/${id}${key === null ? "" : `?key=${key}`}`;
	return [
		"n=0; while :; do",
		`r=$({ curl -sfN --connect-timeout ${WATCH_CONNECT_S} -H 'Authorization: Bearer ${token}' '${url}'; echo "crb-exit $?"; } | grep -m1 -E '^(carbonless:|crb-exit )');`,
		"case $r in",
		`carbonless:*) printf '%s\\n' "$r"; exit 0;;`,
		"'crb-exit 22') exit 3;;",
		"'crb-exit 7'|'crb-exit 28') n=$((n+1));;",
		"*) n=0;;",
		"esac;",
		`[ "$n" -ge ${WATCH_TRIES} ] && exit 4;`,
		"sleep 5;",
		"done",
	].join(" ");
}
