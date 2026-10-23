import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerAccessKey } from "./access";

const apps: FastifyInstance[] = [];
afterEach(async () => {
	await Promise.all(apps.splice(0).map((a) => a.close()));
});

/** A listening app: the cookie is named after the listening port. */
async function app(key: string | null): Promise<FastifyInstance> {
	const app = Fastify();
	apps.push(app);
	await registerAccessKey(app, key);
	app.get("/api/x", async () => ({ ok: true }));
	await app.listen({ port: 0, host: "127.0.0.1" });
	return app;
}

function cookieName(a: FastifyInstance): string {
	const address = a.server.address();
	if (!address || typeof address === "string") throw new Error("not listening");
	return `crb_key_${address.port}`;
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
		expect(cookie).toContain(`${cookieName(a)}=s3cret`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).toContain("Path=/");

		const withCookie = await a.inject({
			url: "/api/x",
			cookies: { [cookieName(a)]: "s3cret" },
		});
		expect(withCookie.statusCode).toBe(200);
	});

	it("refuses a wrong key", async () => {
		const a = await app("s3cret");
		expect((await a.inject("/api/x?key=s3cre")).statusCode).toBe(401);
		expect((await a.inject("/api/x?key=s3cret2")).statusCode).toBe(401);
		const wrongCookie = await a.inject({
			url: "/api/x",
			cookies: { [cookieName(a)]: "nope" },
		});
		expect(wrongCookie.statusCode).toBe(401);
	});

	it("keeps the cookies of two instances on one host apart", async () => {
		// Cookies ignore ports: a browser sends both instances' cookies to each.
		const a = await app("key-a");
		const b = await app("key-b");
		const setA = String(
			(await a.inject("/api/x?key=key-a")).headers["set-cookie"],
		);
		const setB = String(
			(await b.inject("/api/x?key=key-b")).headers["set-cookie"],
		);
		expect(setA).toContain(`${cookieName(a)}=key-a`);
		expect(setB).toContain(`${cookieName(b)}=key-b`);
		expect(cookieName(a)).not.toBe(cookieName(b));
		const both = { [cookieName(a)]: "key-a", [cookieName(b)]: "key-b" };
		expect((await a.inject({ url: "/api/x", cookies: both })).statusCode).toBe(
			200,
		);
		expect((await b.inject({ url: "/api/x", cookies: both })).statusCode).toBe(
			200,
		);
		// Each instance only accepts its own cookie.
		const onlyB = { [cookieName(b)]: "key-b" };
		expect((await a.inject({ url: "/api/x", cookies: onlyB })).statusCode).toBe(
			401,
		);
	});
});
