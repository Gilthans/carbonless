import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { registerAccessKey } from "./access";

async function app(key: string | null): Promise<FastifyInstance> {
	const app = Fastify();
	await registerAccessKey(app, key);
	app.get("/api/x", async () => ({ ok: true }));
	return app;
}

describe("registerAccessKey", () => {
	it("lets everything through without a key", async () => {
		const res = await (await app(null)).inject("/api/x");
		expect(res.statusCode).toBe(200);
	});

	it("requires the key in the URL or the cookie", async () => {
		const a = await app("s3cret");
		const none = await a.inject("/api/x");
		expect(none.statusCode).toBe(401);
		expect(none.json()).toEqual({ error: "Missing or wrong access key" });

		const withKey = await a.inject("/api/x?key=s3cret");
		expect(withKey.statusCode).toBe(200);
		const cookie = String(withKey.headers["set-cookie"]);
		expect(cookie).toContain("crb_key=s3cret");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).toContain("Path=/");

		const withCookie = await a.inject({
			url: "/api/x",
			cookies: { crb_key: "s3cret" },
		});
		expect(withCookie.statusCode).toBe(200);
	});

	it("refuses a wrong key", async () => {
		const a = await app("s3cret");
		expect((await a.inject("/api/x?key=s3cre")).statusCode).toBe(401);
		expect((await a.inject("/api/x?key=s3cret2")).statusCode).toBe(401);
		const wrongCookie = await a.inject({
			url: "/api/x",
			cookies: { crb_key: "nope" },
		});
		expect(wrongCookie.statusCode).toBe(401);
	});
});
