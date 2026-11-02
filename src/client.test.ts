import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrFixture, type PrFixture } from "../test/pr-fixture";
import { ClientError, ensureServer, runClient, trimLog } from "./client";
import { type StartedServer, startServer } from "./server/serve";
import { readLiveServerState, writeServerState } from "./server/serverState";
import { BUILD } from "./server/version";

describe("the client", () => {
	let dir: string;
	let pr: PrFixture;
	const saved = {
		state: process.env.XDG_STATE_HOME,
		config: process.env.XDG_CONFIG_HOME,
	};
	let servers: StartedServer[];

	/** `crb serve` in this process, counting the starts. */
	const spawner = (delayMs = 0) => {
		const spawn = vi.fn(() => {
			void (async () => {
				await new Promise((r) => setTimeout(r, delayMs));
				servers.push(await startServer({ port: 0 }));
			})();
			return { exited: new Promise<number | null>(() => {}) };
		});
		return spawn;
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-client-"));
		process.env.XDG_STATE_HOME = join(dir, "state");
		process.env.XDG_CONFIG_HOME = join(dir, "config");
		pr = createPrFixture();
		servers = [];
	});
	afterEach(async () => {
		await Promise.all(servers.map((s) => s.close()));
		await pr.cleanup();
		process.env.XDG_STATE_HOME = saved.state;
		process.env.XDG_CONFIG_HOME = saved.config;
		rmSync(dir, { recursive: true, force: true });
	});

	it("uses the running server and starts none; stdout is only the URL", async () => {
		const server = await startServer({ port: 0 });
		servers.push(server);
		const spawnServer = spawner();
		const out: string[] = [];
		const openUrl = vi.fn(async () => {});
		const url = await runClient(
			{ pr: pr.arg, cwd: process.cwd() },
			{ out: (l) => out.push(l), spawnServer, openUrl },
		);
		expect(url).toMatch(new RegExp(`^${server.url}/r/[0-9a-hjkmnp-tv-z]{26}$`));
		expect(out).toEqual([url]);
		expect(spawnServer).not.toHaveBeenCalled();
		expect(openUrl).not.toHaveBeenCalled();
		// Asked again: the same review.
		expect(
			await runClient({ pr: pr.arg, cwd: process.cwd() }, { out: () => {} }),
		).toBe(url);
	});

	it("--open opens the review's URL", async () => {
		servers.push(await startServer({ port: 0 }));
		const openUrl = vi.fn(async () => {});
		const url = await runClient(
			{ pr: pr.arg, cwd: process.cwd(), open: true },
			{ out: () => {}, openUrl },
		);
		expect(openUrl).toHaveBeenCalledWith(url);
	});

	it("starts a server when none runs", async () => {
		const spawnServer = spawner();
		const out: string[] = [];
		await runClient(
			{ pr: pr.arg, cwd: process.cwd() },
			{ out: (l) => out.push(l), spawnServer },
		);
		expect(spawnServer).toHaveBeenCalledTimes(1);
		expect(out[0]).toContain(`${servers[0]?.url}/r/`);
	});

	it("replaces a stale server.json: a dead pid, or a live pid that isn't crb", async () => {
		const dead = spawnSync(process.execPath, ["-e", "0"]).pid ?? 0;
		for (const pid of [dead, 1]) {
			await writeServerState({
				url: "http://127.0.0.1:9",
				host: "127.0.0.1",
				port: 9,
				pid,
				startedAt: "2026-10-01T00:00:00Z",
				version: BUILD,
			});
			const spawnServer = spawner();
			const server = await ensureServer({ spawnServer });
			expect(spawnServer).toHaveBeenCalledTimes(1);
			expect(server.url).toBe(servers.at(-1)?.url);
			expect((await readLiveServerState())?.url).toBe(server.url);
			await servers.pop()?.close();
		}
	});

	it("concurrent auto-start: two clients end with one server", async () => {
		const spawnServer = spawner(200);
		const [a, b] = await Promise.all([
			ensureServer({ spawnServer }),
			ensureServer({ spawnServer }),
		]);
		expect(spawnServer).toHaveBeenCalledTimes(1);
		expect(a.url).toBe(b.url);
		expect(servers).toHaveLength(1);
	});

	it("a server that exits at once: says so", async () => {
		await expect(
			ensureServer({
				spawnServer: () => ({ exited: Promise.resolve(1) }),
			}),
		).rejects.toThrow(/crb serve exited \(1\)/);
	});

	it("refuses a server of another build, naming both sides", async () => {
		servers.push(await startServer({ port: 0 }));
		const other = { version: "9.9.9", commit: "d".repeat(40) };
		const run = runClient(
			{ pr: pr.arg, cwd: process.cwd() },
			{ out: () => {}, build: other },
		);
		await expect(run).rejects.toBeInstanceOf(ClientError);
		await expect(run).rejects.toThrow(
			`server runs ${BUILD.version} (${BUILD.commit.slice(0, 7)}), this crb is 9.9.9 (ddddddd)`,
		);
	});

	it("serve.log past its limit moves aside before the next start", async () => {
		const logs = join(dir, "state", "carbonless");
		mkdirSync(logs, { recursive: true });
		writeFileSync(join(logs, "serve.log"), "x".repeat(20));
		await trimLog(100);
		expect(existsSync(join(logs, "serve.log.1"))).toBe(false);
		await trimLog(10);
		expect(existsSync(join(logs, "serve.log"))).toBe(false);
		expect(readFileSync(join(logs, "serve.log.1"), "utf8")).toHaveLength(20);
		await trimLog(10);
	});

	it("checks its arguments before any server starts", async () => {
		const spawnServer = spawner();
		for (const [req, message] of [
			[{ pr: "nope" }, /Not a PR/],
			[{ pr: pr.arg, head: "xyz" }, /Invalid --head/],
			[{ pr: pr.arg, asOf: "2026-01-03" }, /Invalid --as-of/],
			[
				{ pr: pr.arg, head: "reviewed", asOf: "2026-01-03T00:00:00Z" },
				/can't be combined/,
			],
		] as const) {
			await expect(
				runClient({ cwd: process.cwd(), ...req }, { spawnServer }),
			).rejects.toThrow(message);
		}
		expect(spawnServer).not.toHaveBeenCalled();
	});

	it("passes the server's refusal on", async () => {
		servers.push(await startServer({ port: 0 }));
		await expect(
			runClient(
				{ pr: "acme/widget#99", cwd: process.cwd() },
				{ out: () => {} },
			),
		).rejects.toThrow(/not found/);
	});
});
