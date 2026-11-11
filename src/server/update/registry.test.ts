import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { newerOnRegistry, registryUrl } from "./registry";

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
		expect(asked).toEqual(["/-/package/carbonless-review/dist-tags"]);
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

	it("registry: $CRB_NPM_REGISTRY, else npm's", () => {
		expect(registryUrl({})).toBe("https://registry.npmjs.org");
		expect(registryUrl({ CRB_NPM_REGISTRY: "http://localhost:1/" })).toBe(
			"http://localhost:1",
		);
	});
});
