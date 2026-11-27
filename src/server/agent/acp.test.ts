import { spawn as spawnChild } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type {
	RequestPermissionRequest,
	SessionUpdate,
} from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownerToken } from "../../../scripts/owner.mjs";
import {
	type AcpScenario,
	acpLog,
	FAKE_ACP_BIN,
	releaseAcp,
	writeAcpScenario,
} from "../../../test/fake-acp/scenario.js";
import { GIT_TEST_TIMEOUTS } from "../../../test/git-fixture.js";
import { AGENT_ENV_MASK } from "../../shared/agent.js";
import {
	AcpAgent,
	type AcpSpawn,
	AgentStartError,
	agentEnv,
	checkAgent,
	redactSecrets,
	StderrTail,
	turnError,
} from "./acp.js";

// spawn as it is, watched: a start stopped in time spawns nothing.
const spawned = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: ((...args: Parameters<typeof actual.spawn>) => {
			spawned.count++;
			return actual.spawn(...args);
		}) as typeof actual.spawn,
	};
});

// Real agent processes (node + the SDK): see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

let dir: string;
let scenarioPath: string;
let logPath: string;
const agents: AcpAgent[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "crb-acp-"));
	logPath = join(dir, "acp.log");
});
afterEach(async () => {
	await Promise.all(agents.splice(0).map((a) => a.close()));
	rmSync(dir, { recursive: true, force: true });
});

const scenario = (s: Partial<AcpScenario> = {}) => {
	scenarioPath = writeAcpScenario(dir, {
		agent: { name: "fake-acp", version: "1.2.3" },
		...s,
	});
};

interface Seen {
	updates: SessionUpdate[];
	permissions: RequestPermissionRequest[];
	exits: Array<[number | null, string | null]>;
}

function options(over: Partial<AcpSpawn> = {}): AcpSpawn & { seen: Seen } {
	const seen: Seen = { updates: [], permissions: [], exits: [] };
	return {
		seen,
		command: "claude-agent-acp",
		args: [],
		env: agentEnv({
			PATH: `${FAKE_ACP_BIN}${delimiter}${process.env.PATH}`,
			CRB_FAKE_ACP: scenarioPath,
			CRB_FAKE_ACP_LOG: logPath,
		}),
		cwd: dir,
		stderrFile: join(dir, "agent.stderr.log"),
		onUpdate: (u) => seen.updates.push(u),
		onPermission: (req) => {
			seen.permissions.push(req);
			return { outcome: { outcome: "selected", optionId: "allow" } };
		},
		onExit: (code, signal) => seen.exits.push([code, signal]),
		...over,
	};
}

async function spawn(over: Partial<AcpSpawn> = {}) {
	const opts = options(over);
	const agent = await AcpAgent.spawn(opts);
	agents.push(agent);
	return { agent, seen: opts.seen };
}

const text = (t: string) => [{ type: "text" as const, text: t }];
const methodsLogged = () => acpLog(logPath).map((e) => e.method);

describe("AcpAgent", () => {
	it("spawn + initialize + session/new reports the agent's name", async () => {
		scenario();
		const { agent } = await spawn();
		expect(agent.info).toEqual({ name: "fake-acp", version: "1.2.3" });
		expect(methodsLogged()).toEqual(["spawn", "initialize", "session/new"]);
		const [spawned, init, session] = acpLog(logPath);
		expect(spawned?.params).toMatchObject({ cwd: dir });
		expect(init?.params).toMatchObject({
			protocolVersion: 1,
			clientInfo: { name: "carbonless" },
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
			},
		});
		expect(session?.params).toEqual({ cwd: dir, mcpServers: [] });
	});

	it("session/new carries crb's MCP server over http when the agent advertises it (the key in the URL, the secret as a header)", async () => {
		scenario();
		const { agent } = await spawn({
			mcp: {
				url: "http://127.0.0.1:4800/mcp",
				key: "k3y",
				headers: [{ name: "X-Crb-Spawn", value: "s3cret" }],
			},
		});
		expect(agent.alive).toBe(true);
		const session = acpLog(logPath).find((e) => e.method === "session/new");
		expect(session?.params).toEqual({
			cwd: dir,
			mcpServers: [
				{
					type: "http",
					name: "crb",
					url: "http://127.0.0.1:4800/mcp?key=k3y",
					headers: [{ name: "X-Crb-Spawn", value: "s3cret" }],
				},
			],
		});
	});

	it("without http, the stdio bridge: crb's own command with --url and no secret in argv; the key and headers in its env", async () => {
		scenario({ mcpHttp: false });
		const { agent } = await spawn({
			mcp: {
				url: "http://127.0.0.1:4800/mcp",
				key: "k3y",
				headers: [{ name: "X-Crb-Spawn", value: "s3cret" }],
			},
			bridge: { command: "/usr/bin/node", args: ["/crb/cli.js", "mcp-bridge"] },
		});
		expect(agent.alive).toBe(true);
		const session = acpLog(logPath).find((e) => e.method === "session/new");
		const servers =
			(session?.params as { mcpServers: unknown[] } | undefined)?.mcpServers ??
			[];
		expect(servers).toEqual([
			{
				name: "crb",
				command: "/usr/bin/node",
				args: [
					"/crb/cli.js",
					"mcp-bridge",
					"--url",
					"http://127.0.0.1:4800/mcp",
				],
				env: [
					{ name: "CRB_MCP_KEY", value: "k3y" },
					{
						name: "CRB_MCP_HEADERS",
						value: '[{"name":"X-Crb-Spawn","value":"s3cret"}]',
					},
				],
			},
		]);
		expect(JSON.stringify((servers[0] as { args: string[] }).args)).not.toMatch(
			/k3y|s3cret/,
		);
	});

	it("args reach the agent as given, shell metacharacters too (a Windows .cmd shim runs through cmd.exe)", async () => {
		scenario();
		const args = [
			"two words",
			'a "quoted" arg',
			"100%PATH%",
			"a&echo injected",
			"^caret",
			"<in> | out",
			"!bang!",
			"trailing\\",
			"",
		];
		await spawn({ args });
		expect(acpLog(logPath)[0]?.params).toMatchObject({ argv: args });
	});

	it("a prompt streams chunks and stops end_turn", async () => {
		scenario({ answers: [{ text: "Two writers race.", chunks: 3 }] });
		const { agent, seen } = await spawn();
		const reply = await agent.prompt(text("why?"));
		expect(reply).toEqual({ text: "Two writers race.", stop: "end_turn" });
		const chunks = seen.updates.filter(
			(u) => u.sessionUpdate === "agent_message_chunk",
		);
		expect(chunks).toHaveLength(3);
	});

	it("permission requests reach onPermission and the response is logged", async () => {
		scenario({
			requests: [
				{ kind: "execute", title: "node -e 1", rawInput: { command: "node" } },
			],
		});
		const { agent, seen } = await spawn();
		await agent.prompt(text("run it"));
		expect(seen.permissions.map((p) => p.toolCall.kind)).toEqual(["execute"]);
		expect(
			seen.updates.some(
				(u) => u.sessionUpdate === "tool_call" && u.title === "node -e 1",
			),
		).toBe(true);
		const logged = acpLog(logPath).find(
			(e) => e.method === "session/request_permission",
		);
		expect(logged?.response).toEqual({
			outcome: { outcome: "selected", optionId: "allow" },
		});
	});

	it("initializeError → AgentStartError exited with the stderr", async () => {
		scenario({ initializeError: "Please log in: run claude /login" });
		const failure = await AcpAgent.spawn(options()).catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(AgentStartError);
		expect(failure).toMatchObject({ reason: "exited" });
		expect((failure as AgentStartError).stderr).toContain("Please log in");
		expect((failure as AgentStartError).message).toContain("code 1");
		expect(readFileSync(join(dir, "agent.stderr.log"), "utf8")).toContain(
			"Please log in",
		);
	});

	it("a stderr log that can't be opened is dropped, the agent still runs", async () => {
		scenario();
		// A directory: opening it for append fails (EISDIR).
		const { agent } = await spawn({ stderrFile: dir });
		expect((await agent.prompt(text("hi"))).text).toBe("ok");
	});

	it("ENOENT → not-found", async () => {
		scenario();
		const failure = await AcpAgent.spawn(
			options({ command: "crb-no-such-agent" }),
		).catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(AgentStartError);
		expect(failure).toMatchObject({ reason: "not-found" });
	});

	it("crashOnPrompt → stop error with the text so far", async () => {
		scenario({
			crashOnPrompt: true,
			answers: [{ text: "partial and the rest", chunks: 2 }],
		});
		const { agent, seen } = await spawn();
		const reply = await agent.prompt(text("go"));
		expect(reply.stop).toBe("error");
		expect(reply.text).toBe("partial an");
		// The exit says why (the runner's error), not the broken connection.
		expect(reply.error).toBeUndefined();
		await vi.waitFor(() => expect(seen.exits).toEqual([[70, null]]), {
			timeout: 20_000,
		});
	});

	it("a prompt that fails carries the agent's reason, sanitised and capped", async () => {
		scenario({
			answers: [
				{
					text: "half",
					stop: "error",
					error: `Rate limited\u0000\n\tby the API ${"x".repeat(600)}`,
				},
			],
		});
		const { agent } = await spawn();
		const reply = await agent.prompt(text("go"));
		expect(reply.stop).toBe("error");
		expect(reply.text).toBe("half");
		expect(reply.error).toMatch(
			/^Internal error: Rate limited by the API x+…$/,
		);
		expect(reply.error?.length).toBeLessThanOrEqual(300);
		expect(agent.alive).toBe(true);
	});

	it('an agent that names itself "" is known by its command\'s name', async () => {
		scenario({ agent: { name: "", version: "2.0.0" } });
		const { agent } = await spawn({
			command: join(FAKE_ACP_BIN, "claude-agent-acp"),
		});
		expect(agent.info).toEqual({ name: "claude-agent-acp", version: "2.0.0" });
	});

	it("cancel → stop cancelled", async () => {
		scenario({
			hold: ["prompt"],
			answers: [{ text: "first second", chunks: 2 }],
		});
		const { agent, seen } = await spawn();
		const turn = agent.prompt(text("go"));
		await vi.waitFor(
			() =>
				expect(
					seen.updates.some((u) => u.sessionUpdate === "agent_message_chunk"),
				).toBe(true),
			{ timeout: 20_000, interval: 20 },
		);
		await agent.cancel();
		expect(await turn).toEqual({ text: "first ", stop: "cancelled" });
		expect(methodsLogged()).toContain("session/cancel");
	});

	it("close kills the process", async () => {
		scenario({ hold: ["prompt"] });
		const { agent, seen } = await spawn();
		const pid = acpLog(logPath)[0]?.pid as number;
		const turn = agent.prompt(text("go"));
		await agent.close();
		expect(() => process.kill(pid, 0)).toThrow();
		expect(seen.exits).toHaveLength(1);
		expect((await turn).stop).toBe("error");
		releaseAcp(scenarioPath, "prompt");
	});
});

describe("agentEnv", () => {
	it("drops secrets, keeps HOME and PATH, adds the config's env last", () => {
		const saved = { ...process.env };
		try {
			process.env.GH_TOKEN = "t";
			process.env.AWS_SECRET_ACCESS_KEY = "s";
			process.env.ANTHROPIC_API_KEY = "k";
			process.env.DB_PASSWORD = "p";
			process.env.KEYBOARD_LAYOUT = "us";
			process.env.GIT_DIR = "/elsewhere";
			const env = agentEnv({ CLAUDE_CODE_EXECUTABLE: "/bin/claude" });
			for (const name of [
				"GH_TOKEN",
				"AWS_SECRET_ACCESS_KEY",
				"ANTHROPIC_API_KEY",
				"DB_PASSWORD",
				"GIT_DIR",
			]) {
				expect(env[name]).toBeUndefined();
			}
			expect(env.KEYBOARD_LAYOUT).toBe("us");
			expect(env.HOME).toBe(process.env.HOME);
			expect(env.PATH).toBe(process.env.PATH);
			expect(env.CLAUDE_CODE_EXECUTABLE).toBe("/bin/claude");
		} finally {
			for (const k of Object.keys(process.env))
				if (!(k in saved)) delete process.env[k];
			Object.assign(process.env, saved);
		}
	});
});

describe("agentEnv secret names", () => {
	// Names that look like a key, token, password or credential, in any
	// part (split on `_`, other separators and camelCase).
	const dropped = [
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_ACCESS_KEY_ID",
		"ANTHROPIC_API_KEY",
		"OPENAI_APIKEY",
		"API_KEY_ID",
		"API_KEYS",
		"STRIPE_KEY_LIVE",
		"DB_PASSWORD",
		"MYSQL_PWD",
		"DB_PASSWD",
		"REDIS_PASS",
		"SSH_PASSPHRASE",
		"GH_PAT",
		"MY_GITHUB_PAT",
		"REGISTRY_AUTH",
		"BASIC_AUTH_HEADER",
		"NPM_CONFIG__AUTH",
		"npm_config__auth",
		"npm_config_//registry.npmjs.org/:_authToken",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"AZURE_CREDENTIAL",
		"DOCKER_CREDS",
		"SESSION_COOKIE",
		"AUTH_COOKIES",
		"DATABASE_URL",
		"DB_URL",
		"SENTRY_DSN",
		"PG_CONNECTION_STRING",
		"SIGNING_PRIVATE_KEY",
		"GITHUBTOKEN",
		"clientSecret",
		"apiKey",
		"ID_JWT",
		"API_BEARER",
		"BW_SESSION",
		"OP_SESSION_my",
	];
	const kept = [
		"HOME",
		"PATH",
		"PWD",
		"OLDPWD",
		"USER",
		"SHELL",
		"LANG",
		"TERM",
		"TMPDIR",
		"KEYBOARD",
		"KEYBOARD_LAYOUT",
		"MONKEY",
		"XKB_DEFAULT_KEYMAP",
		"LESSKEY",
		"XAUTHORITY",
		"AUTHOR_NAME",
		"AUTHOR_EMAIL",
		"PASSENGER_ENV",
		"PATHEXT",
		"NODE_OPTIONS",
		"XDG_SESSION_ID",
		"DBUS_SESSION_BUS_ADDRESS",
		"HTTP_PROXY",
		"URL_BASE",
		"SSH_AUTH_SOCK",
		"KUBECONFIG",
		"NETRC",
		"GNUPGHOME",
		"SALT",
	];

	it("drops every secret-looking name and keeps the rest", () => {
		const saved = { ...process.env };
		try {
			for (const name of [...dropped, ...kept]) process.env[name] = "v";
			const env = agentEnv({});
			expect(dropped.filter((n) => n in env)).toEqual([]);
			expect(kept.filter((n) => !(n in env))).toEqual([]);
		} finally {
			for (const k of Object.keys(process.env))
				if (!(k in saved)) delete process.env[k];
			Object.assign(process.env, saved);
		}
	});

	it("drops a value that is a URL with a password, keeps one without", () => {
		const withPassword = {
			REDIS_URL: "redis://:hunter2@cache:6379/0",
			MONGODB_URI: "mongodb+srv://app:hunter2@cluster0.example.net/db",
			HTTPS_PROXY: "http://me:hunter2@proxy:3128",
		};
		const without = {
			PLAIN_URL: "https://example.com:8443/path@v1",
			USER_ONLY_URL: "ssh://git@example.com/repo.git",
			NOT_A_URL: "a:b@c",
		};
		const saved = { ...process.env };
		try {
			Object.assign(process.env, withPassword, without);
			const env = agentEnv({});
			for (const name of Object.keys(withPassword))
				expect(env[name], name).toBeUndefined();
			for (const [name, value] of Object.entries(without))
				expect(env[name], name).toBe(value);
		} finally {
			for (const k of Object.keys(process.env))
				if (!(k in saved)) delete process.env[k];
			Object.assign(process.env, saved);
		}
	});

	it("the config's own env passes as written, secret names and values too", () => {
		const env = agentEnv({
			CLAUDE_CODE_OAUTH_TOKEN: "t",
			MY_PAT: "p",
			REDIS_URL: "redis://:pw@cache",
		});
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("t");
		expect(env.MY_PAT).toBe("p");
		expect(env.REDIS_URL).toBe("redis://:pw@cache");
	});
});

describe("agentEnv PATH", () => {
	it("the config's PATH is the only PATH (Windows names ignore case)", () => {
		const env = agentEnv({ PATH: "/only" });
		const paths = Object.keys(env).filter((k) => k.toUpperCase() === "PATH");
		expect(paths).toEqual(["PATH"]);
		expect(env.PATH).toBe("/only");
	});
});

describe("checkAgent", () => {
	const withFake = async <T>(run: () => Promise<T>) => {
		const saved = {
			PATH: process.env.PATH,
			CRB_FAKE_ACP: process.env.CRB_FAKE_ACP,
		};
		process.env.PATH = `${FAKE_ACP_BIN}${delimiter}${process.env.PATH}`;
		process.env.CRB_FAKE_ACP = scenarioPath;
		try {
			return await run();
		} finally {
			process.env.PATH = saved.PATH;
			if (saved.CRB_FAKE_ACP === undefined) delete process.env.CRB_FAKE_ACP;
			else process.env.CRB_FAKE_ACP = saved.CRB_FAKE_ACP;
		}
	};
	const cfg = (command = "claude-agent-acp") => ({
		command,
		args: [],
		env: {},
		leash: "open" as const,
	});

	it("names the agent", async () => {
		scenario();
		expect(await withFake(() => checkAgent(cfg(), dir))).toEqual({
			ok: true,
			agent: { name: "fake-acp", version: "1.2.3" },
		});
	});

	it("an initialize failure carries its stderr", async () => {
		scenario({ initializeError: "not logged in" });
		const check = await withFake(() => checkAgent(cfg(), dir));
		expect(check).toMatchObject({ ok: false });
		expect(check.ok === false && check.stderr).toContain("not logged in");
	});

	it("the config's env values are masked in its stderr (CAR-59)", async () => {
		const secret = "sk-ant-api03-leaked-token";
		scenario({ initializeError: "not logged in", stderrEnv: "MY_KEY" });
		const check = await withFake(() =>
			checkAgent({ ...cfg(), env: { MY_KEY: secret } }, dir),
		);
		expect(check).toMatchObject({ ok: false });
		expect(JSON.stringify(check)).not.toContain(secret);
		expect(check.ok === false && check.stderr).toContain(
			`MY_KEY=${AGENT_ENV_MASK}`,
		);
	});

	it("a missing command is not found", async () => {
		scenario();
		const check = await withFake(() => checkAgent(cfg("crb-no-such"), dir));
		expect(check).toMatchObject({
			ok: false,
			error: "crb-no-such was not found on PATH",
		});
	});
});

describe("redactSecrets (CAR-59)", () => {
	const KEY = "sk-ant-api03-abcdefgh";
	it("masks each value of 8 or more characters, every time; shorter ones stay", () => {
		expect(
			redactSecrets(`bad key ${KEY}; again ${KEY} (x=short)`, [KEY, "short"]),
		).toBe(`bad key ${AGENT_ENV_MASK}; again ${AGENT_ENV_MASK} (x=short)`);
	});
	it("a value cut at the tail's start or end is dropped, the cut by `max` too", () => {
		expect(redactSecrets(`${KEY.slice(5)} then`, [KEY], { cut: true })).toBe(
			" then",
		);
		expect(redactSecrets(`key: ${KEY.slice(0, 9)}`, [KEY])).toBe("key: ");
		// The last 15 characters cut what was left of KEY: none of it stays.
		const text = `${KEY.slice(3)}${"y".repeat(10)}`;
		expect(redactSecrets(text, [KEY], { max: 15 })).toBe("y".repeat(10));
		expect(redactSecrets(`${KEY}ok`, [KEY], { max: 9 })).toBe(
			`${AGENT_ENV_MASK.slice(-7)}ok`,
		);
	});
	it("an uncut start that is a value's end stays whole", () => {
		// A relative command path (absolute ones aren't masked at all).
		const exe = "node_modules/.bin/claude";
		expect(redactSecrets("claude: not logged in", [exe])).toBe(
			"claude: not logged in",
		);
		expect(redactSecrets("claude: not logged in", [exe], { max: 100 })).toBe(
			"claude: not logged in",
		);
	});
	it("absolute paths aren't masked: a wrong one is what Check must show", () => {
		for (const path of ["/home/u/.local/bin/claude", "C:\\tools\\claude.exe"]) {
			expect(redactSecrets(`spawn ${path} ENOENT`, [path])).toBe(
				`spawn ${path} ENOENT`,
			);
		}
		expect(redactSecrets(`key ${KEY}`, ["/home/u/bin", KEY])).toBe(
			`key ${AGENT_ENV_MASK}`,
		);
	});
	it("a longer value is masked before one it contains", () => {
		const long = `${KEY}-more`;
		expect(redactSecrets(`[${long}]`, [KEY, long])).toBe(`[${AGENT_ENV_MASK}]`);
	});
});

describe("StderrTail (CAR-59)", () => {
	it("a non-ASCII value split between two chunks is still masked", () => {
		const secret = "пароль-секрет-42";
		const bytes = Buffer.from(`key ${secret}\n`, "utf8");
		// Inside the second letter's two bytes.
		const at = Buffer.byteLength("key п", "utf8") + 1;
		const tail = new StderrTail([secret]);
		tail.push(bytes.subarray(0, at));
		tail.push(bytes.subarray(at));
		expect(tail.text()).toBe(`key ${AGENT_ENV_MASK}\n`);
	});
	it("an uncut stderr that starts with a value's end stays whole", () => {
		const tail = new StderrTail(["node_modules/.bin/claude"]);
		tail.push(Buffer.from("claude: not logged in"));
		expect(tail.text()).toBe("claude: not logged in");
	});
});

describe("turnError (CAR-59)", () => {
	it("masks the config's env values before the cut", () => {
		const secret = "sk-ant-api03-abcdefgh";
		const error = Object.assign(new Error("Internal error"), {
			data: { details: `401 for key ${secret}${" pad".repeat(100)}` },
		});
		const reason = turnError(error, (t) => redactSecrets(t, [secret]));
		expect(reason).toContain(`401 for key ${AGENT_ENV_MASK}`);
		expect(reason).not.toContain(secret.slice(0, 8));
	});
});

describe("a start stopped before it spawns", () => {
	it("spawns no process (the SDK loads first, CAR-105)", async () => {
		scenario();
		const controller = new AbortController();
		controller.abort();
		const before = spawned.count;
		const error = await AcpAgent.spawn(
			options({ signal: controller.signal }),
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AgentStartError);
		expect((error as AgentStartError).reason).toBe("exited");
		expect((error as AgentStartError).message).toBe("Stopped while starting");
		expect(spawned.count).toBe(before);
	});
});

describe("the fake agent", () => {
	it("exits once its owner is gone, its stdin still open", async () => {
		// Node for both, not sleep and the sh shim: this file runs on Windows too.
		const owner = spawnChild(process.execPath, [
			"-e",
			"setTimeout(() => {}, 60_000)",
		]);
		const agent = spawnChild(
			process.execPath,
			[join(FAKE_ACP_BIN, "..", "agent.mjs")],
			{
				env: { ...process.env, CRB_OWNER: ownerToken(owner.pid as number) },
				stdio: ["pipe", "ignore", "ignore"],
			},
		);
		try {
			const exited = new Promise<number | null>((done) =>
				agent.once("exit", (code) => done(code)),
			);
			owner.kill("SIGKILL");
			expect(await exited).toBe(0);
		} finally {
			owner.kill("SIGKILL");
			agent.kill("SIGKILL");
		}
	});
});
