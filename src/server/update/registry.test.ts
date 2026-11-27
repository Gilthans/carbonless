import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	CHECK_ACCEPT,
	checkRegistry,
	newerOnRegistry,
	registryUrl,
} from "./registry";

/** A fake registry: dist-tags for carbonless-review, or a status. */
async function fakeRegistry(
	answer: { tags: Record<string, string> } | { status: number },
): Promise<{ url: string; server: Server; asked: string[] }> {
	const asked: string[] = [];
	const server = createServer((req, res) => {
		asked.push(req.url ?? "");
		if ("status" in answer) {
			res.writeHead(answer.status).end("{}");
			return;
		}
		res
			.writeHead(200, { "content-type": "application/json" })
			.end(JSON.stringify(answer.tags));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}`, server, asked };
}

const servers: Server[] = [];
afterEach(async () => {
	for (const s of servers.splice(0)) {
		await new Promise((r) => s.close(r));
	}
});

async function check(
	current: string,
	answer: { tags: Record<string, string> } | { status: number },
) {
	const r = await fakeRegistry(answer);
	servers.push(r.server);
	const newer = await newerOnRegistry(current, { registry: r.url });
	return { newer, asked: r.asked };
}

describe("newerOnRegistry", () => {
	it("asks for the package's dist-tags; a newer latest for a release", async () => {
		const { newer, asked } = await check("0.1.0", {
			tags: { latest: "0.2.0", rc: "0.3.0-rc.1" },
		});
		expect(newer).toBe("0.2.0");
		// Then each version's own document (deprecated?): the running one
		// and the candidate.
		expect(asked).toEqual([
			"/-/package/carbonless-review/dist-tags",
			"/carbonless-review/0.1.0",
			"/carbonless-review/0.2.0",
		]);
	});

	it("a prerelease follows rc", async () => {
		expect(
			(
				await check("0.3.0-rc.1", {
					tags: { latest: "0.2.0", rc: "0.3.0-rc.2" },
				})
			).newer,
		).toBe("0.3.0-rc.2");
		// rc moved up to the release itself.
		expect(
			(await check("0.3.0-rc.2", { tags: { latest: "0.3.0", rc: "0.3.0" } }))
				.newer,
		).toBe("0.3.0");
	});

	it("rc takes latest when it is newer (a fix released without moving rc)", async () => {
		expect(
			(await check("0.3.0-rc.2", { tags: { latest: "0.3.1", rc: "0.3.0" } }))
				.newer,
		).toBe("0.3.1");
		expect(
			(
				await check("0.3.0-rc.2", {
					tags: { latest: "0.2.0", rc: "0.3.0-rc.3" },
				})
			).newer,
		).toBe("0.3.0-rc.3");
		// latest never takes rc.
		expect(
			(await check("0.3.0", { tags: { latest: "0.3.0", rc: "0.4.0-rc.1" } }))
				.newer,
		).toBe(null);
	});

	it("an answer past 64 KB is dropped as it streams (no content-length)", async () => {
		let sent = 0;
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			const chunk = "x".repeat(16 * 1024);
			const more = () => {
				// Without a cap the body would never end (crb buffering it all).
				while (res.write(chunk)) sent += chunk.length;
				res.once("drain", more);
			};
			res.write('{"latest":"9.9.9","pad":"');
			more();
		});
		servers.push(server);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const { port } = server.address() as AddressInfo;
		expect(
			await newerOnRegistry("0.1.0", {
				registry: `http://127.0.0.1:${port}`,
				timeoutMs: 20_000,
			}),
		).toBe(null);
		server.closeAllConnections();
		expect(sent).toBeGreaterThan(0);
	});

	it("an explicit channel: a release kept on rc", async () => {
		const r = await fakeRegistry({
			tags: { latest: "0.3.0", rc: "0.4.0-rc.1" },
		});
		servers.push(r.server);
		expect(
			await newerOnRegistry("0.3.0", { registry: r.url, channel: "rc" }),
		).toBe("0.4.0-rc.1");
	});

	it("the same or an older version: nothing", async () => {
		expect((await check("0.2.0", { tags: { latest: "0.2.0" } })).newer).toBe(
			null,
		);
		expect((await check("0.2.0", { tags: { latest: "0.1.0" } })).newer).toBe(
			null,
		);
		expect(
			(await check("0.3.0-rc.2", { tags: { latest: "0.2.0" } })).newer,
		).toBe(null);
		expect(
			(await check("0.2.0", { tags: { latest: "not-a-version" } })).newer,
		).toBe(null);
	});

	it("an oversized answer or version: nothing", async () => {
		expect(
			(
				await check("0.1.0", {
					tags: { latest: `1.0.0-${"a".repeat(80)}`, pad: "x" },
				})
			).newer,
		).toBe(null);
		expect(
			(
				await check("0.1.0", {
					tags: { latest: "0.2.0", pad: "x".repeat(70_000) },
				})
			).newer,
		).toBe(null);
	});

	it("404 (not published yet) or a server error: silent", async () => {
		expect((await check("0.1.0", { status: 404 })).newer).toBe(null);
		expect((await check("0.1.0", { status: 500 })).newer).toBe(null);
	});

	it("unreachable or slow: silent", async () => {
		const r = await fakeRegistry({ tags: {} });
		const url = r.url;
		await new Promise((done) => r.server.close(done));
		expect(await newerOnRegistry("0.1.0", { registry: url })).toBe(null);
		const hang = createServer(() => {});
		servers.push(hang);
		await new Promise<void>((done) => hang.listen(0, "127.0.0.1", done));
		const { port } = hang.address() as AddressInfo;
		expect(
			await newerOnRegistry("0.1.0", {
				registry: `http://127.0.0.1:${port}`,
				timeoutMs: 50,
			}),
		).toBe(null);
		hang.closeAllConnections();
	});

	it("checkRegistry says why a check failed, in a few words", async () => {
		const missing = await fakeRegistry({ status: 404 });
		servers.push(missing.server);
		await expect(
			checkRegistry("0.1.0", { registry: missing.url }),
		).rejects.toThrow("Registry answered 404");
		const bad = await fakeRegistry({ tags: {} });
		servers.push(bad.server);
		await expect(
			checkRegistry("0.1.0", {
				registry: bad.url,
				fetch: async () => new Response("not json", { status: 200 }),
			}),
		).rejects.toThrow("Registry gave a bad answer");
		await expect(
			checkRegistry("0.1.0", {
				registry: bad.url,
				fetch: async () => {
					throw new TypeError("fetch failed");
				},
			}),
		).rejects.toThrow("Registry unreachable");
		const hang = createServer(() => {});
		servers.push(hang);
		await new Promise<void>((done) => hang.listen(0, "127.0.0.1", done));
		const { port } = hang.address() as AddressInfo;
		await expect(
			checkRegistry("0.1.0", {
				registry: `http://127.0.0.1:${port}`,
				timeoutMs: 50,
			}),
		).rejects.toThrow("Registry timed out");
		hang.closeAllConnections();
		// Nothing newer is no failure.
		const same = await fakeRegistry({ tags: { latest: "0.1.0" } });
		servers.push(same.server);
		expect((await checkRegistry("0.1.0", { registry: same.url })).newer).toBe(
			null,
		);
	});

	it("registry: $CRB_NPM_REGISTRY, else npm's", () => {
		expect(registryUrl({})).toBe("https://registry.npmjs.org");
		expect(registryUrl({ CRB_NPM_REGISTRY: "http://localhost:1/" })).toBe(
			"http://localhost:1",
		);
	});
});

/**
 * A registry with dist-tags and per-version documents: `docs[v]` is the
 * version's document, a status, or "hang" (never answers).
 */
async function versionRegistry(
	tags: Record<string, string>,
	docs: Record<string, Record<string, unknown> | number | "hang">,
) {
	const asked: { url: string; accept: string }[] = [];
	const server = createServer((req, res) => {
		asked.push({ url: req.url ?? "", accept: req.headers.accept ?? "" });
		if (req.url === "/-/package/carbonless-review/dist-tags") {
			res.writeHead(200).end(JSON.stringify(tags));
			return;
		}
		const v = decodeURIComponent(
			/^\/carbonless-review\/([^/]+)$/.exec(req.url ?? "")?.[1] ?? "",
		);
		const doc = docs[v] ?? { version: v };
		if (doc === "hang") return;
		if (typeof doc === "number") {
			res.writeHead(doc).end("{}");
			return;
		}
		res.writeHead(200).end(JSON.stringify(doc));
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}`, asked, server };
}

describe("checkRegistry: withdrawn and deprecated versions (CAR-212)", () => {
	it("a deprecated latest is never offered, even the newest", async () => {
		const r = await versionRegistry(
			{ latest: "0.3.0" },
			{ "0.3.0": { deprecated: "withdrawn: bad" } },
		);
		expect(await checkRegistry("0.2.0", { registry: r.url })).toEqual({
			newer: null,
			withdrawn: null,
			deprecated: ["0.3.0"],
		});
		// Any deprecation, not only a withdrawal.
		const other = await versionRegistry(
			{ latest: "0.3.0" },
			{ "0.3.0": { deprecated: "use 0.3.1" } },
		);
		expect((await checkRegistry("0.2.0", { registry: other.url })).newer).toBe(
			null,
		);
	});

	it("on rc, a deprecated rc falls to a good newer latest", async () => {
		const r = await versionRegistry(
			{ latest: "0.4.1", rc: "0.5.0-rc.3" },
			{ "0.5.0-rc.3": { deprecated: "withdrawn: bad" } },
		);
		expect((await checkRegistry("0.5.0-rc.1", { registry: r.url })).newer).toBe(
			null,
		);
		const up = await versionRegistry(
			{ latest: "0.5.0", rc: "0.5.0-rc.3" },
			{ "0.5.0": { deprecated: "withdrawn: bad" } },
		);
		// latest newest but deprecated: the good rc instead.
		expect(
			(await checkRegistry("0.5.0-rc.1", { registry: up.url })).newer,
		).toBe("0.5.0-rc.3");
	});

	it("the running version withdrawn: its reason; another deprecation, a non-string field or a 404: not withdrawn", async () => {
		const answers: [Record<string, unknown> | number, string | null][] = [
			[
				{ deprecated: "withdrawn: comments posted to the wrong PR" },
				"comments posted to the wrong PR",
			],
			[{ deprecated: "deprecated for other reasons" }, null],
			[{ deprecated: 42 }, null],
			[{ deprecated: { message: "withdrawn: x" } }, null],
			[{}, null],
			// A local or unpublished build.
			[404, null],
		];
		for (const [doc, reason] of answers) {
			const r = await versionRegistry({ latest: "0.2.0" }, { "0.2.0": doc });
			expect(
				(await checkRegistry("0.2.0", { registry: r.url })).withdrawn,
			).toBe(reason);
		}
	});

	it("a non-string deprecated on a candidate is no deprecation: offered", async () => {
		const r = await versionRegistry(
			{ latest: "0.3.0" },
			{ "0.3.0": { deprecated: true } },
		);
		expect((await checkRegistry("0.2.0", { registry: r.url })).newer).toBe(
			"0.3.0",
		);
	});

	it("a version's request failing or timing out: never throws; the candidate isn't offered, the running one's withdrawal unknown", async () => {
		const r = await versionRegistry(
			{ latest: "0.3.0" },
			{ "0.2.0": "hang", "0.3.0": 500 },
		);
		expect(
			await checkRegistry("0.2.0", { registry: r.url, timeoutMs: 200 }),
		).toEqual({ newer: null, withdrawn: undefined, deprecated: [] });
		r.server.closeAllConnections();
		const bad = await versionRegistry({ latest: "0.3.0" }, { "0.3.0": "hang" });
		expect(
			await checkRegistry("0.2.0", { registry: bad.url, timeoutMs: 200 }),
		).toEqual({ newer: null, withdrawn: null, deprecated: [] });
		bad.server.closeAllConnections();
	});

	it("an oversized or unparsable version document is a failed request", async () => {
		const r = await versionRegistry(
			{ latest: "0.3.0" },
			{ "0.3.0": { pad: "x".repeat(300 * 1024) } },
		);
		expect((await checkRegistry("0.2.0", { registry: r.url })).newer).toBe(
			null,
		);
		const odd = await checkRegistry("0.2.0", {
			registry: r.url,
			fetch: async (url) =>
				String(url).endsWith("dist-tags")
					? new Response(JSON.stringify({ latest: "0.3.0" }))
					: new Response("not json"),
		});
		expect(odd).toEqual({ newer: null, withdrawn: undefined, deprecated: [] });
	});

	it("`also` (an earlier offer): reported when deprecated now", async () => {
		const r = await versionRegistry(
			{ latest: "0.2.0" },
			{ "0.3.0": { deprecated: "withdrawn: bad" } },
		);
		const answer = await checkRegistry("0.2.0", {
			registry: r.url,
			also: ["0.3.0"],
		});
		expect(answer).toEqual({
			newer: null,
			withdrawn: null,
			deprecated: ["0.3.0"],
		});
		// One request per version, with npm's accept.
		expect(r.asked.map((a) => a.url)).toEqual([
			"/-/package/carbonless-review/dist-tags",
			"/carbonless-review/0.2.0",
			"/carbonless-review/0.3.0",
		]);
		expect(r.asked[1]?.accept).toBe(CHECK_ACCEPT);
	});
});
