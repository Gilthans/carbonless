import { createHash, timingSafeEqual } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Cookies ignore ports, so every crb instance on a host would share one
 * `crb_key` cookie and opening a second PR would lock the first tab out.
 * Naming the cookie after the listening port keeps instances apart.
 */
function cookieName(app: FastifyInstance): string {
	const address = app.server.address();
	return address && typeof address === "object"
		? `crb_key_${address.port}`
		: "crb_key";
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Requires `key` on every request (API and static) when it's set: as
 * `?key=<key>`, which also sets an HttpOnly cookie (named per listening
 * port) for the page's later requests, or as that cookie. Used when crb listens beyond loopback.
 */
export async function registerAccessKey(
	app: FastifyInstance,
	key: string | null,
	publicUrl?: string,
): Promise<void> {
	if (key === null) return;
	// Cookies ignore ports: over an HTTPS public URL, keep the key off plain
	// HTTP services on the same name.
	const secureHost =
		publicUrl && new URL(publicUrl).protocol === "https:"
			? new URL(publicUrl).host
			: null;
	const expected = digest(key);
	// Hashing first makes the comparison constant-time whatever the length.
	const matches = (value: unknown) =>
		typeof value === "string" && timingSafeEqual(digest(value), expected);

	await app.register(fastifyCookie);
	app.addHook("onRequest", async (request, reply) => {
		const cookie = cookieName(app);
		const query = request.query as Record<string, unknown> | undefined;
		if (matches(query?.key)) {
			// Lax, not Strict: a browser holds a Strict cookie back when the
			// reviewer clicks a link to a review on another site (GitHub),
			// which registerHostCheck allows on purpose. Every other request
			// from another site (no click: a script's navigation, a redirect
			// it started, a frame, a write) is refused there, on any path.
			reply.setCookie(cookie, key, {
				httpOnly: true,
				sameSite: "lax",
				path: "/",
				secure: (request.headers.host ?? "").toLowerCase() === secureHost,
			});
			return;
		}
		if (matches(request.cookies[cookie])) return;
		return reply.code(401).send({ error: "Missing or wrong access key" });
	});
}

/**
 * Guards against DNS rebinding and cross-site writes. On a loopback bind
 * (`loopback`), the Host header must name loopback and the listening port, so
 * a page on another origin that resolves its name to 127.0.0.1 can't read the
 * API. In every mode, a write that carries an Origin must come from this
 * server's own origin, and nothing may come from another site's page
 * (Sec-Fetch-Site) but a link the reviewer clicked (`clickedFromAnotherSite`).
 * `publicUrl` (an origin, e.g. a `tailscale serve` HTTPS proxy in front)
 * counts as the server's own: its Host and its Origin are accepted too.
 */
export function registerHostCheck(
	app: FastifyInstance,
	opts: { loopback: boolean; publicUrl?: string },
): void {
	const { loopback } = opts;
	const publicUrl = opts.publicUrl ? new URL(opts.publicUrl) : null;
	const allowedHosts = (): Set<string> => {
		const address = app.server.address();
		if (!address || typeof address === "string") return new Set();
		const port = address.port;
		return new Set(
			["127.0.0.1", "localhost", "[::1]"].map((h) => `${h}:${port}`),
		);
	};
	const forbidden = { error: "Forbidden host or origin" };
	app.addHook("onRequest", async (request, reply) => {
		const host = (request.headers.host ?? "").toLowerCase();
		const allowed = loopback ? allowedHosts() : new Set(host ? [host] : []);
		if (loopback && !allowed.has(host) && host !== publicUrl?.host) {
			return reply.code(403).send(forbidden);
		}
		const origin = request.headers.origin?.toLowerCase();
		const write = request.method !== "GET" && request.method !== "HEAD";
		if (
			write &&
			origin !== undefined &&
			origin !== publicUrl?.origin &&
			![...allowed].some((h) => origin === `http://${h}`)
		) {
			return reply.code(403).send(forbidden);
		}
		// Another site's page (or another port on this host: same-site) gets
		// nothing but a link the reviewer clicked, on any path: whatever its
		// spelling (/PR/, /%70r/), a client route that acts on load can't be
		// set off by a script, a redirect or a frame. Typed or bookmarked
		// (none), the server's own pages (same-origin) and clients without
		// Fetch Metadata (crb, an agent's MCP, older browsers) pass.
		const site = request.headers["sec-fetch-site"];
		if (
			site !== undefined &&
			site !== "none" &&
			site !== "same-origin" &&
			!clickedFromAnotherSite(request)
		) {
			return reply.code(403).send(forbidden);
		}
	});
}

/**
 * A top-level GET navigation the user set off (a click, Enter, a middle
 * click): what the Lax key cookie lets through from another site. A
 * script's `location = ...`, a redirect it started, a frame, a form post
 * or a fetch lacks one of these. The browser keeps them on a redirect, a
 * reload and back/forward of the page the click opened (Chromium,
 * measured).
 */
function clickedFromAnotherSite(request: FastifyRequest): boolean {
	const h = request.headers;
	return (
		request.method === "GET" &&
		h["sec-fetch-mode"] === "navigate" &&
		h["sec-fetch-dest"] === "document" &&
		h["sec-fetch-user"] === "?1"
	);
}
