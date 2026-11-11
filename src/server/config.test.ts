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
import type { AgentConfig } from "../shared/agent.js";
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
				agent: null,
			},
			problems: [],
		});
		expect(DEFAULT_CONFIG.serve.port).toBe(4747);
	});

	it("reads a valid file, repos lowercased", async () => {
		write(
			JSON.stringify({
				serve: { host: "100.64.0.7", port: 4800 },
				views: [{ name: "My PRs", repos: ["Acme/API", "acme/console"] }],
				refresh: { minutes: 5 },
			}),
		);
		expect(await readConfig()).toEqual({
			config: {
				serve: { host: "100.64.0.7", port: 4800 },
				views: [{ name: "My PRs", repos: ["acme/api", "acme/console"] }],
				refresh: { minutes: 5 },
				agent: null,
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
			agent: null,
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

	it("serve.publicUrl: an http(s) origin, kept as one; anything else ignored", async () => {
		write(
			JSON.stringify({
				serve: { publicUrl: " HTTPS://Box.tail0.ts.net:8443/ " },
			}),
		);
		expect((await readConfig()).config.serve).toEqual({
			host: "127.0.0.1",
			port: 4747,
			publicUrl: "https://box.tail0.ts.net:8443",
		});
		for (const bad of [
			"box.ts.net:8443",
			"ftp://box.ts.net",
			"https://box.ts.net/crb",
			"https://box.ts.net/?key=k",
			"https://me:pw@box.ts.net",
			7,
		]) {
			write(JSON.stringify({ serve: { publicUrl: bad } }));
			const { config, problems } = await readConfig();
			expect(config.serve.publicUrl, String(bad)).toBeUndefined();
			expect(problems).toEqual([
				"serve.publicUrl must be an http(s) URL with no path; ignored",
			]);
		}
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
			agent: null,
		});
	});

	it("updateConfig keeps a view's unknown keys with that view, by name, not by place", async () => {
		write(
			JSON.stringify({
				views: [
					"junk",
					{ name: "A", repos: [], x: 1 },
					{ name: "Work", repos: [], color: "red" },
				],
			}),
		);
		// The junk was dropped on read: Work is views[1] now, not raw [1].
		await updateConfig((c) => c);
		expect(onDisk().views).toEqual([
			{ name: "A", repos: [], x: 1 },
			{ name: "Work", repos: [], color: "red" },
		]);
		// A deleted: Work keeps its own keys, never A's.
		await updateConfig((c) => ({
			...c,
			views: c.views.filter((v) => v.name !== "A"),
		}));
		expect(onDisk().views).toEqual([{ name: "Work", repos: [], color: "red" }]);
		// A new view gets none.
		await updateConfig((c) => ({
			...c,
			views: [{ name: "New", repos: ["acme/x"] }, ...c.views],
		}));
		expect(onDisk().views).toEqual([
			{ name: "New", repos: ["acme/x"] },
			{ name: "Work", repos: [], color: "red" },
		]);
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
			agent: null,
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

	describe("agent", () => {
		const agent: AgentConfig = {
			command: "claude-agent-acp",
			args: ["--verbose"],
			env: { CLAUDE_CODE_EXECUTABLE: "/usr/bin/claude" },
			leash: "open",
		};

		it("agent defaults to null", async () => {
			expect((await readConfig()).config.agent).toBeNull();
			write(JSON.stringify({ agent: null }));
			expect(await readConfig()).toMatchObject({
				config: { agent: null },
				problems: [],
			});
			expect(DEFAULT_CONFIG.agent).toBeNull();
		});

		it("a valid agent section reads back", async () => {
			write(JSON.stringify({ agent }));
			expect(await readConfig()).toMatchObject({
				config: { agent },
				problems: [],
			});
			// Only the command is required.
			write(JSON.stringify({ agent: { command: "gemini" } }));
			expect(await readConfig()).toMatchObject({
				config: {
					agent: { command: "gemini", args: [], env: {}, leash: "open" },
				},
				problems: [],
			});
		});

		it.each([
			["claude", null, "agent must be an object or null; agent disabled"],
			[[], null, "agent must be an object or null; agent disabled"],
			[
				{ args: [] },
				null,
				"agent.command must be a non-empty string; agent disabled",
			],
			[
				{ command: "  " },
				null,
				"agent.command must be a non-empty string; agent disabled",
			],
			[
				{ command: "goose", args: "acp" },
				{ command: "goose", args: [], env: {}, leash: "open" },
				"agent.args must be an array of strings; using []",
			],
			[
				{ command: "goose", args: ["acp", 1] },
				{ command: "goose", args: [], env: {}, leash: "open" },
				"agent.args must be an array of strings; using []",
			],
			[
				{ command: "goose", env: { A: 1 } },
				{ command: "goose", args: [], env: {}, leash: "open" },
				"agent.env must be an object of strings; using {}",
			],
			[
				{ command: "goose", env: ["A=1"] },
				{ command: "goose", args: [], env: {}, leash: "open" },
				"agent.env must be an object of strings; using {}",
			],
			[
				{ command: "goose", leash: "strict" },
				{ command: "goose", args: [], env: {}, leash: "open" },
				'agent.leash "strict" is not available yet; using "open"',
			],
		])(
			"agent %j reads as %j with the problem %s",
			async (raw, read, problem) => {
				write(JSON.stringify({ agent: raw }));
				expect(await readConfig()).toMatchObject({
					config: { agent: read },
					problems: [problem],
				});
			},
		);

		it("updateConfig writes agent and keeps its unknown keys", async () => {
			write(
				JSON.stringify({
					views: [],
					agent: { command: "old", model: "opus", leash: "strict" },
				}),
			);
			const next = await updateConfig((c) => ({ ...c, agent }));
			expect(next.agent).toEqual(agent);
			expect(onDisk().agent).toEqual({ ...agent, model: "opus" });
			expect(await readConfig()).toMatchObject({
				config: { agent },
				problems: [],
			});
			// A bad agent is refused, with the problem.
			await expect(
				updateConfig((c) => ({
					...c,
					agent: { ...agent, command: "" },
				})),
			).rejects.toThrow(/agent\.command must be a non-empty string/);
		});

		it("updateConfig(null) removes it", async () => {
			write(JSON.stringify({ agent: { ...agent, model: "opus" } }));
			const next = await updateConfig((c) => ({ ...c, agent: null }));
			expect(next.agent).toBeNull();
			// Written as null: off, said so in the file.
			expect(onDisk().agent).toBeNull();
			expect((await readConfig()).config.agent).toBeNull();
		});
	});

	it("updateConfig validates what it's given", async () => {
		await expect(
			updateConfig((c) => ({ ...c, views: [{ name: "x", repos: ["bad"] }] })),
		).rejects.toThrow(/not owner\/repo/);
	});
});
