import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { SessionRegistry } from "../registry";
import { BUILD } from "../version";
import { Updater } from "./updater";

let host = "";
const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
	for (const a of apps.splice(0)) await a.close();
});

async function app(updater?: Updater, accessKey: string | null = null) {
	const a = await buildApp(new SessionRegistry(), { accessKey, updater });
	apps.push(a);
	// The loopback Host check needs the real listening port.
	await a.listen({ port: 0, host: "127.0.0.1" });
	const address = a.server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	host = `127.0.0.1:${address.port}`;
	return a;
}

describe("/api/update", () => {
	it("without an updater: nothing on offer, and Update refused", async () => {
		const a = await app();
		const res = await a.inject({ url: "/api/update", headers: { host } });
		expect(res.statusCode).toBe(200);
		expect(res.headers["cache-control"]).toBe("no-store");
		expect(res.json()).toEqual({
			current: BUILD.version,
			available: null,
			releaseUrl: null,
			oneClick: false,
			command: null,
			state: "idle",
			failed: null,
			commit: BUILD.commit,
			channel: expect.stringMatching(/^(rc|latest)$/),
			install: null,
			byHand: false,
			lastChecked: null,
			checkError: null,
			checksOff: "unavailable",
		});
		const check = await a.inject({
			method: "POST",
			url: "/api/update/check",
			headers: { host },
		});
		expect(check.statusCode).toBe(409);
		const post = await a.inject({
			method: "POST",
			url: "/api/update",
			headers: { host },
			payload: { version: "9.9.9" },
		});
		expect(post.statusCode).toBe(409);
	});

	it("offers the updater's version; Update takes only that one", async () => {
		const exits: number[] = [];
		const updater = new Updater({
			build: { version: "0.2.0", commit: "a".repeat(40) },
			enabled: true,
			install: {
				pm: "npm",
				root: "/p/lib/node_modules/carbonless-review",
				home: "/p",
				writable: true,
				packages: [],
				scan: [],
			},
			check: async () => "0.3.0",
			service: async () => null,
			exit: (c) => exits.push(c),
			port: () => 4747,
			startHelper: async () => {},
			graceMs: 10,
		});
		await updater.start();
		await updater.checkNow();
		const a = await app(updater);
		expect(
			(await a.inject({ url: "/api/update", headers: { host } })).json(),
		).toMatchObject({ available: "0.3.0", oneClick: true });
		const bad = await a.inject({
			method: "POST",
			url: "/api/update",
			headers: { host },
			payload: {},
		});
		expect(bad.statusCode).toBe(400);
		const other = await a.inject({
			method: "POST",
			url: "/api/update",
			headers: { host },
			payload: { version: "0.4.0" },
		});
		expect(other.statusCode).toBe(409);
		const ok = await a.inject({
			method: "POST",
			url: "/api/update",
			headers: { host },
			payload: { version: "0.3.0" },
		});
		expect(ok.statusCode).toBe(202);
		expect(ok.json()).toMatchObject({ state: "restarting" });
		updater.stop();
	});

	it("check now: the fresh info, one check for concurrent asks; refused when checks are off", async () => {
		let asked = 0;
		let release: (v: string | null) => void = () => {};
		const updater = new Updater({
			build: { version: "0.2.0", commit: "a".repeat(40) },
			enabled: true,
			install: null,
			check: () => {
				asked++;
				return new Promise((r) => {
					release = r;
				});
			},
			service: async () => null,
			exit: () => {},
			port: () => 4747,
		});
		const a = await app(updater);
		const post = () =>
			a.inject({ method: "POST", url: "/api/update/check", headers: { host } });
		const first = post();
		const second = post();
		await expect.poll(() => asked).toBe(1);
		release("0.3.0");
		const [one, two] = await Promise.all([first, second]);
		expect(asked).toBe(1);
		for (const res of [one, two]) {
			expect(res.statusCode).toBe(200);
			expect(res.headers["cache-control"]).toBe("no-store");
			expect(res.json()).toMatchObject({
				available: "0.3.0",
				byHand: true,
				command: "npm install -g carbonless-review@0.3.0",
				checkError: null,
			});
			expect(res.json().lastChecked).toEqual(expect.any(String));
		}
		const off = await app(
			new Updater({
				build: { version: "0.2.0", commit: "a".repeat(40) },
				enabled: false,
				off: "config",
				install: null,
				exit: () => {},
				port: () => 4747,
			}),
		);
		const refused = await off.inject({
			method: "POST",
			url: "/api/update/check",
			headers: { host },
		});
		expect(refused.statusCode).toBe(409);
		expect(
			(await off.inject({ url: "/api/update", headers: { host } })).json(),
		).toMatchObject({ checksOff: "config" });
	});

	it("check now is refused from another site", async () => {
		let asked = 0;
		const updater = {
			info: () => ({ checksOff: null }),
			checkNow: async () => {
				asked++;
			},
		} as unknown as Updater;
		const a = await app(updater);
		const cross = await a.inject({
			method: "POST",
			url: "/api/update/check",
			headers: { host, origin: "https://evil.example" },
		});
		expect(cross.statusCode).toBe(403);
		expect(asked).toBe(0);
	});

	it("Update is refused from another site, and without the key", async () => {
		let asked = 0;
		const updater = {
			info: () => {
				throw new Error("not asked");
			},
			update: async () => {
				asked++;
				throw new Error("not asked");
			},
		} as unknown as Updater;
		const a = await app(updater);
		const cross = await a.inject({
			method: "POST",
			url: "/api/update",
			headers: { host, origin: "https://evil.example" },
			payload: { version: "0.3.0" },
		});
		expect(cross.statusCode).toBe(403);
		const site = await a.inject({
			method: "POST",
			url: "/api/update",
			headers: { host, "sec-fetch-site": "cross-site" },
			payload: { version: "0.3.0" },
		});
		expect(site.statusCode).toBe(403);
		const keyed = await app(updater, "k3y");
		const nokey = await keyed.inject({
			method: "POST",
			url: "/api/update",
			headers: { host },
			payload: { version: "0.3.0" },
		});
		expect(nokey.statusCode, nokey.body).toBe(401);
		expect(asked).toBe(0);
	});
});
