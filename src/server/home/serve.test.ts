import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { homePr } from "../../../test/fake-gh/scenario";
import {
	createHomeFixture,
	type HomeFixture,
} from "../../../test/home-fixture";
import type { HomeView, RepoHome } from "../../shared/home.js";
import { type StartedServer, startServer } from "../serve.js";

// Each fake gh call is a node process: give a loaded machine time.
vi.setConfig({ testTimeout: 60_000 });

const iso = (ms: number) => new Date(ms).toISOString();

describe("Home in a real crb serve", () => {
	let fx: HomeFixture | undefined;
	let server: StartedServer | undefined;
	const saved = {
		state: process.env.XDG_STATE_HOME,
		config: process.env.XDG_CONFIG_HOME,
	};
	afterEach(async () => {
		await server?.close();
		server = undefined;
		process.env.XDG_STATE_HOME = saved.state;
		process.env.XDG_CONFIG_HOME = saved.config;
		await fx?.cleanup();
		fx = undefined;
	});

	async function start() {
		fx = createHomeFixture({
			repos: {
				"acme/api": {
					prs: [
						homePr({
							repo: "acme/api",
							number: 1,
							author: "Octo",
							updatedAt: iso(Date.now() - 1000),
						}),
						homePr({
							repo: "acme/api",
							number: 2,
							author: "alice",
							updatedAt: iso(Date.now() - 2000),
						}),
					],
				},
				"acme/web": { prs: [] },
			},
		});
		const dir = join(fx.path, "..");
		process.env.XDG_STATE_HOME = join(dir, "state");
		process.env.XDG_CONFIG_HOME = join(dir, "config");
		mkdirSync(join(dir, "config", "carbonless"), { recursive: true });
		const configFile = join(dir, "config", "carbonless", "config.json");
		writeFileSync(
			configFile,
			JSON.stringify({
				views: [{ name: "My PRs", repos: ["acme/api"], mine: 1 }],
				extra: true,
			}),
		);
		server = await startServer({ port: 0 });
		return { url: server.url, configFile };
	}

	it("answers /api/home and each view repo's rows from the scenario", async () => {
		const { url } = await start();
		const res = await fetch(`${url}/api/home`);
		expect(res.status).toBe(200);
		const view = (await res.json()) as HomeView;
		expect(view.viewer.login).toBe("Octo");
		expect(view.view).toEqual({ name: "My PRs", repos: ["acme/api"] });
		const repo = (await (
			await fetch(`${url}/api/home/repos/acme/api`)
		).json()) as RepoHome;
		expect(
			repo.rows
				.map((r) => [r.number, r.section])
				.sort((a, b) => Number(a[0]) - Number(b[0])),
		).toEqual([
			[1, "mine"],
			[2, "grabs"],
		]);
	});

	it("refuses cross-site writes like every /api write", async () => {
		const { url } = await start();
		const put = await fetch(`${url}/api/home/view`, {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				origin: "http://evil.example",
			},
			body: JSON.stringify({ repos: ["acme/web"] }),
		});
		expect(put.status).toBe(403);
	});

	it("PUT view writes config.json, keeping the view's and the file's own keys", async () => {
		const { url, configFile } = await start();
		const res = await fetch(`${url}/api/home/view`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ repos: ["acme/api", "Acme/Web"] }),
		});
		expect(res.status).toBe(200);
		const file = JSON.parse(readFileSync(configFile, "utf8"));
		expect(file.views).toEqual([
			{ name: "My PRs", repos: ["acme/api", "acme/web"], mine: 1 },
		]);
		expect(file.extra).toBe(true);
	});
});
