import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeServerState } from "./server/serverState";
import { BUILD } from "./server/version";

/**
 * `crb <pr>` is only a client: loading the server (Fastify and all under
 * it) would cost every `crb <pr>` ~0.4 s of CPU before its request (CAR-97).
 * This runs the real CLI through the whole client path, against a stub
 * server, and checks what it loaded.
 */
describe("crb <pr>", () => {
	let dir: string;
	let stub: Server;
	const saved = process.env.XDG_STATE_HOME;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-cli-"));
		process.env.XDG_STATE_HOME = join(dir, "state");
	});
	afterEach(async () => {
		await new Promise((done) => stub.close(done));
		process.env.XDG_STATE_HOME = saved;
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
		const server = loaded.filter((url) =>
			/\/node_modules\/(\.pnpm\/)?@?fastify|\/src\/server\/(serve|app|session|registry)\.ts$/.test(
				url,
			),
		);
		expect(server).toEqual([]);
	}, 60_000);
});
