import { createHash, timingSafeEqual } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";

const COOKIE = "crb_key";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Requires `key` on every request (API and static) when it's set: as
 * `?key=<key>`, which also sets an HttpOnly cookie for the page's later
 * requests, or as that cookie. Used when crb listens beyond loopback.
 */
export async function registerAccessKey(
	app: FastifyInstance,
	key: string | null,
): Promise<void> {
	if (key === null) return;
	const expected = digest(key);
	// Hashing first makes the comparison constant-time whatever the length.
	const matches = (value: unknown) =>
		typeof value === "string" && timingSafeEqual(digest(value), expected);

	await app.register(fastifyCookie);
	app.addHook("onRequest", async (request, reply) => {
		const query = request.query as Record<string, unknown> | undefined;
		if (matches(query?.key)) {
			reply.setCookie(COOKIE, key, {
				httpOnly: true,
				sameSite: "strict",
				path: "/",
			});
			return;
		}
		if (matches(request.cookies[COOKIE])) return;
		return reply.code(401).send({ error: "Missing or wrong access key" });
	});
}

/**
 * Guards against DNS rebinding and cross-site writes. On a loopback bind
 * (`loopback`), the Host header must name loopback and the listening port, so
 * a page on another origin that resolves its name to 127.0.0.1 can't read the
 * API. In every mode, a write that carries an Origin must come from this
 * server's own origin.
 */
export function registerHostCheck(
	app: FastifyInstance,
	loopback: boolean,
): void {
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
		if (loopback && !allowed.has(host)) return reply.code(403).send(forbidden);
		const origin = request.headers.origin?.toLowerCase();
		const write = request.method !== "GET" && request.method !== "HEAD";
		if (
			write &&
			origin !== undefined &&
			![...allowed].some((h) => origin === `http://${h}`)
		) {
			return reply.code(403).send(forbidden);
		}
	});
}
