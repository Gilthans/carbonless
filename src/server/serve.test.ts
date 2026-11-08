import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer } from "./serve";
import { accessKey, readLiveServerState } from "./serverState";
import { BUILD } from "./version";

describe("startServer", () => {
	let dir: string;
	const saved = {
		state: process.env.XDG_STATE_HOME,
		config: process.env.XDG_CONFIG_HOME,
	};
	const closers: (() => Promise<void>)[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-serve-"));
		process.env.XDG_STATE_HOME = join(dir, "state");
		process.env.XDG_CONFIG_HOME = join(dir, "config");
	});
	afterEach(async () => {
		await Promise.all(closers.splice(0).map((c) => c()));
		process.env.XDG_STATE_HOME = saved.state;
		process.env.XDG_CONFIG_HOME = saved.config;
		rmSync(dir, { recursive: true, force: true });
	});

	const start = async (opts: Parameters<typeof startServer>[0] = {}) => {
		const s = await startServer({ port: 0, ...opts });
		closers.push(s.close);
		return s;
	};

	it("listens, records itself in server.json, and removes it on close", async () => {
		const s = await start();
		expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(s.key).toBeNull();
		const state = await readLiveServerState();
		expect(state).toMatchObject({
			url: s.url,
			host: "127.0.0.1",
			pid: process.pid,
			version: BUILD,
		});
		expect(state?.port).toBe(Number(new URL(s.url).port));
		const res = await fetch(`${s.url}/api/version`);
		expect(await res.json()).toEqual(BUILD);
		await s.close();
		expect(await readLiveServerState()).toBeNull();
	});

	it("a taken port fails and leaves the running server's file alone", async () => {
		const first = await start();
		const port = Number(new URL(first.url).port);
		await expect(start({ port })).rejects.toThrow(
			`Port ${port} on 127.0.0.1 is already in use`,
		);
		expect((await readLiveServerState())?.url).toBe(first.url);
	});

	it("beyond loopback, needs the stable key; --new-key rotates it", async () => {
		const key = await accessKey();
		const s = await start({ host: "0.0.0.0" });
		expect(s.key).toBe(key);
		const port = new URL(s.url).port;
		const bare = await fetch(`http://127.0.0.1:${port}/api/version`);
		expect(bare.status).toBe(401);
		const keyed = await fetch(
			`http://127.0.0.1:${port}/api/version?key=${key}`,
		);
		expect(keyed.status).toBe(200);
		await s.close();
		const again = await start({ host: "0.0.0.0", newKey: true });
		expect(again.key).not.toBe(key);
		expect(await accessKey()).toBe(again.key);
	});

	it("--new-key on a taken port keeps the key the running server checks", async () => {
		const first = await start({ host: "0.0.0.0" });
		const port = Number(new URL(first.url).port);
		await expect(
			start({ host: "0.0.0.0", port, newKey: true }),
		).rejects.toThrow(/already in use/);
		expect(await accessKey()).toBe(first.key);
		const keyed = await fetch(
			`http://127.0.0.1:${port}/api/version?key=${first.key}`,
		);
		expect(keyed.status).toBe(200);
	});

	it("behind a public URL: keyed on loopback too, and records it", async () => {
		const { updateConfig } = await import("./config");
		const publicUrl = "https://box.tail0.ts.net:8443";
		await updateConfig((c) => ({ ...c, serve: { ...c.serve, publicUrl } }));
		const s = await start();
		expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(s.publicUrl).toBe(publicUrl);
		expect(s.key).toBe(await accessKey());
		expect(await readLiveServerState()).toMatchObject({
			url: s.url,
			keyed: true,
			publicUrl,
		});
		expect((await fetch(`${s.url}/api/version`)).status).toBe(401);
		const keyed = await fetch(`${s.url}/api/version?key=${s.key}`);
		expect(keyed.status).toBe(200);
	});

	it("takes host and port from config.json", async () => {
		// A free port, then let go of it.
		const port = await new Promise<number>((done) => {
			const probe = createServer().listen(0, "127.0.0.1", () => {
				const address = probe.address();
				probe.close(() =>
					done(typeof address === "object" && address ? address.port : 0),
				);
			});
		});
		const { updateConfig } = await import("./config");
		await updateConfig((c) => ({ ...c, serve: { host: "127.0.0.1", port } }));
		const s = await startServer({});
		closers.push(s.close);
		expect(s.url).toBe(`http://127.0.0.1:${port}`);
	});
});
