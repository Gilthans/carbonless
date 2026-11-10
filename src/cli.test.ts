import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeServerState } from "./server/serverState";
import { BUILD, formatVersion } from "./server/version";

/**
 * `crb <pr>` is only a client: loading the server (Fastify and all under
 * it) would cost every `crb <pr>` ~0.4 s of CPU before its request (CAR-97).
 * This runs the real CLI through the whole client path, against a stub
 * server, and checks what it loaded.
 */
describe("crb <pr>", () => {
	let dir: string;
	let stub: Server;
	const root = fileURLToPath(new URL("..", import.meta.url));

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-cli-"));
		vi.stubEnv("XDG_STATE_HOME", join(dir, "state"));
		vi.stubEnv("XDG_CONFIG_HOME", join(dir, "config"));
		// Should the stub's probe ever fail, the client would start a real
		// server: on any free port, never the owner's 4747.
		mkdirSync(join(dir, "config", "carbonless"), { recursive: true });
		writeFileSync(
			join(dir, "config", "carbonless", "config.json"),
			JSON.stringify({ serve: { port: 0 } }),
		);
	});
	afterEach(async () => {
		await new Promise((done) => stub.close(done));
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	it("loads no server module on its way to the review", async () => {
		// The running crb serve, as far as the client can tell.
		stub = createServer((req, res) => {
			res.setHeader("content-type", "application/json");
			if (req.url === "/api/version") res.end(JSON.stringify(BUILD));
			else if (req.method === "POST" && req.url === "/api/reviews")
				res.end(JSON.stringify({ url: "http://127.0.0.1/r/stub" }));
			else res.writeHead(404).end("{}");
		});
		await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
		const { port } = stub.address() as AddressInfo;
		await writeServerState({
			url: `http://127.0.0.1:${port}`,
			host: "127.0.0.1",
			port,
			pid: process.pid,
			startedAt: new Date().toISOString(),
			version: BUILD,
		});

		const log = join(dir, "modules.txt");
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				"--import",
				"./test/module-log.mjs",
				"src/cli.ts",
				"octo/repo#1",
			],
			{
				cwd: root,
				env: { ...process.env, CRB_MODULE_LOG: log },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk;
			output += chunk;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk;
		});
		const code = await new Promise((done) => child.once("close", done));
		expect(code, output).toBe(0);
		// It went all the way: the review's URL came back from the stub.
		expect(stdout).toBe("http://127.0.0.1/r/stub\n");

		const loaded = readFileSync(log, "utf8").trim().split("\n");
		// The log works: it saw the client.
		expect(loaded.some((url) => url.endsWith("/src/client.ts"))).toBe(true);
		// No npm package at all (tsx loads before the log starts; `open` only
		// with --open): Fastify, the agent SDK, ulid... are the server's.
		expect(loaded.filter((url) => url.includes("/node_modules/"))).toEqual([]);
		// And no server started behind the stub's back.
		expect(existsSync(join(dir, "state", "carbonless", "serve.log"))).toBe(
			false,
		);
	}, 60_000);
});

/**
 * The agent SDK costs ~140 ms of CPU to load: crb serve loads it only when an
 * agent is started or checked, never to start (CAR-105). This runs the real
 * CLI up to listening, then stops it, and checks what it loaded.
 */
describe("crb serve", () => {
	let dir: string;
	let child: ChildProcess | undefined;
	const root = fileURLToPath(new URL("..", import.meta.url));

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-cli-serve-"));
	});
	afterEach(async () => {
		// A test that failed before stopping it leaves no server behind.
		const running = child;
		child = undefined;
		if (running && running.exitCode === null && running.signalCode === null) {
			const closed = new Promise((done) => running.once("close", done));
			running.kill("SIGKILL");
			await closed;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("starts without loading the agent SDK", async () => {
		const log = join(dir, "modules.txt");
		const server = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				"--import",
				"./test/module-log.mjs",
				"src/cli.ts",
				"serve",
				"--port",
				"0",
				"--host",
				"127.0.0.1",
				"--api-only",
			],
			{
				cwd: root,
				env: {
					...process.env,
					CRB_MODULE_LOG: log,
					XDG_STATE_HOME: join(dir, "state"),
					XDG_CONFIG_HOME: join(dir, "config"),
					XDG_CACHE_HOME: join(dir, "cache"),
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		child = server;
		let output = "";
		const closed = new Promise((done) => server.once("close", done));
		const listening = await new Promise<string | null>((done) => {
			const scan = (chunk: Buffer) => {
				output += chunk;
				const url = output.match(/carbonless listening on (http:\/\/\S+?)\//);
				if (url?.[1]) done(url[1]);
			};
			server.stdout.on("data", scan);
			server.stderr.on("data", scan);
			void closed.then(() => done(null));
		});
		expect(listening, output).not.toBeNull();
		// A route that needs nothing loaded lazily; the server answers.
		const version = await fetch(`${listening}/api/version`);
		expect(version.ok).toBe(true);
		server.kill("SIGTERM");
		const code = await closed;
		expect(code, output).toBe(0);

		const loaded = readFileSync(log, "utf8").trim().split("\n");
		// The log works: it saw the server and Fastify.
		expect(loaded.some((url) => url.endsWith("/src/server/app.ts"))).toBe(true);
		expect(loaded.some((url) => url.includes("/node_modules/fastify/"))).toBe(
			true,
		);
		// The agent's own modules load (routes, the runner)...
		expect(loaded.some((url) => url.endsWith("/src/server/agent/acp.ts"))).toBe(
			true,
		);
		// ...but not the SDK under them.
		expect(
			loaded.filter((url) => url.includes("@agentclientprotocol")),
		).toEqual([]);
	}, 60_000);
});

describe("the compile cache", () => {
	// Node reports a cache it can't turn on (status FAILED) rather than
	// throwing, so this passes without src/cli.ts's try/catch too: it guards
	// the behaviour (crb runs anyway), and the try/catch stays for any throw.
	it("is only a speed-up: a crb that can't keep it still runs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "crb-cli-cache-"));
		try {
			// XDG_CACHE_HOME is a file: no cache directory can be made under it.
			const file = join(dir, "not-a-dir");
			writeFileSync(file, "");
			const root = fileURLToPath(new URL("..", import.meta.url));
			const child = spawn(
				process.execPath,
				["--import", "tsx", "src/cli.ts", "--version"],
				{
					cwd: root,
					env: { ...process.env, XDG_CACHE_HOME: file },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk;
			});
			child.stderr.on("data", (chunk: Buffer) => {
				output += chunk;
			});
			const code = await new Promise((done) => child.once("close", done));
			expect(code, output).toBe(0);
			expect(output.trim()).toBe(formatVersion(BUILD));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
