import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HomeView } from "../src/shared/home";
import { homePr, writeScenario } from "../test/fake-gh/scenario";
import { expect, startServe, stopChild, test } from "./fixtures";

/**
 * Smoke test of Home's server side in the built `crb serve`: the API
 * answers the fake gh scenario's sections. The page's tests (home.spec.ts)
 * build on this.
 */
test("crb serve answers /api/home with the scenario's sections", async ({
	workdir,
}) => {
	const now = Date.now();
	const iso = (ms: number) => new Date(ms).toISOString();
	writeScenario(workdir, {
		repoPath: join(workdir, "no-repo"),
		user: { login: "Octo", avatarUrl: "https://avatars.example/Octo" },
		prs: {},
		repos: {
			"acme/api": {
				prs: [
					homePr({
						repo: "acme/api",
						number: 1,
						author: "Octo",
						updatedAt: iso(now - 1000),
					}),
					homePr({
						repo: "acme/api",
						number: 2,
						author: "alice",
						requested: ["Octo"],
						updatedAt: iso(now - 2000),
					}),
					homePr({
						repo: "acme/api",
						number: 3,
						author: "alice",
						updatedAt: iso(now - 3000),
					}),
					homePr({
						repo: "acme/api",
						number: 4,
						author: "alice",
						state: "MERGED",
						closedAt: iso(now - 4000),
					}),
				],
			},
		},
	});
	const config = join(workdir, "config", "carbonless");
	mkdirSync(config, { recursive: true });
	writeFileSync(
		join(config, "config.json"),
		JSON.stringify({ views: [{ name: "My PRs", repos: ["acme/api"] }] }),
	);
	const served = await startServe(workdir);
	try {
		const api = (path: string, init?: RequestInit) =>
			fetch(new URL(path, served.url), init);
		expect((await api("/api/home")).status).toBe(200);
		const view = (await (
			await api("/api/home/refresh", { method: "POST" })
		).json()) as HomeView;
		expect(view.refreshError).toBe(null);
		expect(
			view.sections.map((s) => [s.id, s.rows.map((r) => r.number)]),
		).toEqual([
			["mine", [1]],
			["reviewing", [2]],
			["grabs", [3]],
			["other", []],
			["closed", [4]],
		]);
	} finally {
		await stopChild(served.child);
	}
});
