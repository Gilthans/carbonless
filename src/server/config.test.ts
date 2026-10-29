import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, readConfig, updateConfig } from "./config";

describe("config", () => {
	let dir: string;
	let saved: string | undefined;
	const file = () => join(dir, "carbonless", "config.json");
	const write = (text: string) => {
		mkdirSync(join(dir, "carbonless"), { recursive: true });
		writeFileSync(file(), text);
	};
	const onDisk = () => JSON.parse(readFileSync(file(), "utf8"));

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-config-"));
		saved = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = dir;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = saved;
		rmSync(dir, { recursive: true, force: true });
	});

	it("has the defaults when there's no file", async () => {
		expect(await readConfig()).toEqual({
			config: {
				serve: { host: "127.0.0.1", port: 4747 },
				views: [],
				refresh: { minutes: 2 },
			},
			problems: [],
		});
		expect(DEFAULT_CONFIG.serve.port).toBe(4747);
	});

	it("reads a valid file, repos lowercased", async () => {
		write(
			JSON.stringify({
				serve: { host: "100.78.32.127", port: 4800 },
				views: [{ name: "My PRs", repos: ["Acme/API", "acme/console"] }],
				refresh: { minutes: 5 },
			}),
		);
		expect(await readConfig()).toEqual({
			config: {
				serve: { host: "100.78.32.127", port: 4800 },
				views: [{ name: "My PRs", repos: ["acme/api", "acme/console"] }],
				refresh: { minutes: 5 },
			},
			problems: [],
		});
	});

	it("bad JSON: the defaults, and says so", async () => {
		write("{ serve: nope");
		const { config, problems } = await readConfig();
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/config\.json is not valid JSON/);
	});

	it("not an object: the defaults, and says so", async () => {
		write("[1, 2]");
		const { config, problems } = await readConfig();
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(problems).toEqual(["config.json is not a JSON object"]);
	});

	it("replaces only the bad parts with defaults, one problem each", async () => {
		write(
			JSON.stringify({
				serve: { host: "", port: 70000 },
				views: [
					{ name: "Mine", repos: ["acme/api", "no-slash", 7, "acme/api"] },
					"junk",
				],
				refresh: { minutes: -1 },
			}),
		);
		const { config, problems } = await readConfig();
		expect(config).toEqual({
			serve: { host: "127.0.0.1", port: 4747 },
			views: [{ name: "Mine", repos: ["acme/api"] }],
			refresh: { minutes: 2 },
		});
		expect(problems).toEqual([
			"serve.host must be a non-empty string; using 127.0.0.1",
			"serve.port must be a port number; using 4747",
			'views[0].repos: "no-slash" is not owner/repo; dropped',
			"views[0].repos: 7 is not owner/repo; dropped",
			"views[1] is not an object; dropped",
			"refresh.minutes must be a positive number; using 2",
		]);
	});

	it("a view without a name is My PRs; one without repos is empty", async () => {
		write(JSON.stringify({ views: [{}] }));
		const { config, problems } = await readConfig();
		expect(config.views).toEqual([{ name: "My PRs", repos: [] }]);
		expect(problems).toEqual([]);
	});

	it("updateConfig writes a valid file and keeps unknown keys", async () => {
		write(
			JSON.stringify({
				theme: "dark",
				serve: { host: "127.0.0.1", port: 4800, tls: false },
				views: [{ name: "My PRs", repos: ["acme/api"], color: "red" }],
				refresh: { minutes: 3, jitter: true },
			}),
		);
		const next = await updateConfig((c) => ({
			...c,
			views: [
				{ ...c.views[0], name: "My PRs", repos: ["acme/api", "acme/web"] },
			],
		}));
		expect(next.views).toEqual([
			{ name: "My PRs", repos: ["acme/api", "acme/web"] },
		]);
		expect(onDisk()).toEqual({
			theme: "dark",
			serve: { host: "127.0.0.1", port: 4800, tls: false },
			views: [
				{ name: "My PRs", repos: ["acme/api", "acme/web"], color: "red" },
			],
			refresh: { minutes: 3, jitter: true },
		});
	});

	it("updateConfig over garbage rewrites a valid file, unknown keys of the good parts kept", async () => {
		write(
			JSON.stringify({ extra: 1, serve: "nope", views: [{ repos: ["x"] }] }),
		);
		await updateConfig((c) => ({
			...c,
			views: [{ name: "My PRs", repos: ["acme/api"] }],
		}));
		expect(onDisk()).toEqual({
			extra: 1,
			serve: { host: "127.0.0.1", port: 4747 },
			views: [{ name: "My PRs", repos: ["acme/api"] }],
			refresh: { minutes: 2 },
		});
		expect(await readConfig()).toMatchObject({ problems: [] });

		write("not json at all");
		await updateConfig((c) => c);
		expect(onDisk()).toEqual(DEFAULT_CONFIG);
	});

	it("updateConfig creates the file and its directory; updates run one at a time", async () => {
		await Promise.all(
			["acme/a", "acme/b", "acme/c"].map((repo) =>
				updateConfig((c) => ({
					...c,
					views: [
						{
							name: "My PRs",
							repos: [...(c.views[0]?.repos ?? []), repo],
						},
					],
				})),
			),
		);
		expect(onDisk().views[0].repos.sort()).toEqual([
			"acme/a",
			"acme/b",
			"acme/c",
		]);
	});

	it("updateConfig validates what it's given", async () => {
		await expect(
			updateConfig((c) => ({ ...c, views: [{ name: "x", repos: ["bad"] }] })),
		).rejects.toThrow(/not owner\/repo/);
	});
});
