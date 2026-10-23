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
