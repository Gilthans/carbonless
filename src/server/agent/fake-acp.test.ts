import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acpLog, writeAcpScenario } from "../../../test/fake-acp/scenario.js";
import { GIT_TEST_TIMEOUTS } from "../../../test/git-fixture.js";

// Real agent processes (node + the SDKs): see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const FAKE = resolve(import.meta.dirname, "../../../test/fake-acp");

type Recorder = {
	url: string;
	calls: {
		tool: string;
		args: Record<string, unknown>;
		headers: Record<string, string>;
	}[];
	close(): Promise<void>;
};

let dir: string;
let logPath: string;
const stops: (() => void | Promise<void>)[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "crb-fake-acp-"));
	logPath = join(dir, "acp.log");
});
afterEach(async () => {
	for (const s of stops.splice(0)) await s();
	rmSync(dir, { recursive: true, force: true });
});

/** The fake agent over ACP with `mcpServers`; prompt(text) runs one turn. */
async function fakeAgent(
	scenario: Record<string, unknown>,
	mcpServers: unknown[],
) {
	const path = writeAcpScenario(dir, {
		agent: { name: "fake-acp", version: "1.0.0" },
		...scenario,
	});
	const child = spawn(process.execPath, [join(FAKE, "agent.mjs")], {
		env: { ...process.env, CRB_FAKE_ACP: path, CRB_FAKE_ACP_LOG: logPath },
		stdio: ["pipe", "pipe", "inherit"],
	});
	stops.push(() => {
		child.kill("SIGKILL");
	});
	const conn = client({ name: "test" })
		.onRequest(methods.client.session.requestPermission, () => ({
			outcome: { outcome: "selected", optionId: "allow" },
		}))
		.connect(
			ndJsonStream(
				Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
				Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
			),
		);
	const init = await conn.agent.request(methods.agent.initialize, {
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
	});
	const session = await conn.agent
		.buildSession({ cwd: dir, mcpServers: mcpServers as never })
		.start();
	return {
		init,
		prompt: async (text: string) => {
			void session.prompt([{ type: "text", text }]).catch(() => {});
			for (;;) {
				const m = await session.nextUpdate();
				if (m.kind === "stop") return m.stopReason;
			}
		},
	};
}

const kickoff = (request: string) =>
	`Attach to the review with crb's attach tool:\n${JSON.stringify({ review: "http://127.0.0.1:1/r/x", request })}`;

describe("acpLog", () => {
	it("reads whole lines only: a line whose append is under way isn't logged yet (CAR-305)", () => {
		const first = JSON.stringify({ pid: 1, method: "spawn", params: {} });
		const second = JSON.stringify({ pid: 1, method: "initialize", params: {} });
		// A read in the middle of the second append: part of its line is there.
		writeFileSync(logPath, `${first}\n${second.slice(0, 20)}`);
		expect(acpLog(logPath).map((e) => e.method)).toEqual(["spawn"]);
		writeFileSync(logPath, `${first}\n${second}\n`);
		expect(acpLog(logPath).map((e) => e.method)).toEqual([
			"spawn",
			"initialize",
		]);
	});
});

describe("the fake ACP agent with a crb MCP server", () => {
	it("over http: advertises http, attaches with the kickoff's request, then next → reply with the scenario's answer; headers reach the server", async () => {
		const { recorderServer } = (await import(
			join(FAKE, "mcp-recorder.mjs")
		)) as { recorderServer: () => Promise<Recorder> };
		const rec = await recorderServer();
		stops.push(() => rec.close());
		const agent = await fakeAgent(
			{ answers: [{ match: "lock", text: "Because of races." }] },
			[
				{
					type: "http",
					name: "crb",
					url: rec.url,
					headers: [{ name: "X-Crb-Spawn", value: "s3cret" }],
				},
			],
		);
		expect(agent.init.agentCapabilities?.mcpCapabilities?.http).toBe(true);
		expect(await agent.prompt(kickoff("01req"))).toBe("end_turn");
		expect(rec.calls.map((c) => c.tool)).toEqual([
			"attach",
			"next",
			"reply",
			"next",
		]);
		expect(rec.calls[0]?.args).toMatchObject({
			request: "01req",
			name: "fake-acp",
		});
		expect(rec.calls[0]?.headers["x-crb-spawn"]).toBe("s3cret");
		expect(rec.calls[2]?.args).toEqual({
			token: "tok",
			thread: "t1",
			replyTo: "m1",
			text: "Because of races.",
		});
		// The log names each call, without the token.
		const logged = acpLog(logPath).filter((e) => e.method.startsWith("mcp/"));
		expect(logged.map((e) => e.method)).toEqual([
			"mcp/attach",
			"mcp/next",
			"mcp/reply",
			"mcp/next",
		]);
		expect(JSON.stringify(logged)).not.toContain('"tok"');
	});

	it("open steps: between next and reply, a GitHub thread by its index in review, and the reply cites what opened (a refused one stays a placeholder)", async () => {
		const { recorderServer } = (await import(
			join(FAKE, "mcp-recorder.mjs")
		)) as { recorderServer: () => Promise<Recorder> };
		const rec = await recorderServer();
		stops.push(() => rec.close());
		const agent = await fakeAgent(
			{
				answers: [
					{
						text: "See {{cite:0}}, {{cite:1}} and {{cite:2}}.",
						open: [
							{
								code: { path: "a.txt", line: 2 },
								text: "Such a case.",
								key: "k0",
							},
							{ ghThread: 0, text: "Here too." },
							{ thread: "PRRT_refused", text: "Not here." },
						],
					},
				],
			},
			[{ type: "http", name: "crb", url: rec.url, headers: [] }],
		);
		expect(await agent.prompt(kickoff("01req"))).toBe("end_turn");
		expect(rec.calls.map((c) => c.tool)).toEqual([
			"attach",
			"next",
			"open",
			"review",
			"open",
			"open",
			"reply",
			"next",
		]);
		expect(rec.calls[2]?.args).toEqual({
			token: "tok",
			text: "Such a case.",
			key: "k0",
			code: { path: "a.txt", line: 2 },
		});
		expect(rec.calls[4]?.args).toMatchObject({ thread: "PRRT_gh0" });
		expect(rec.calls[6]?.args).toMatchObject({
			thread: "t1",
			text: "See crb:c/c1, crb:c/c2 and {{cite:2}}.",
		});
	});

	it("over stdio (mcpHttp false): spawns the server with its args and env and works the same; tools and detach are called", async () => {
		const recLog = join(dir, "recorder.log");
		const agent = await fakeAgent(
			{
				mcpHttp: false,
				mcp: { tools: ["threads"], detach: true },
			},
			[
				{
					name: "crb",
					command: process.execPath,
					args: [join(FAKE, "mcp-recorder.mjs")],
					env: [
						{ name: "RECORDER_LOG", value: recLog },
						{ name: "CRB_MCP_HEADERS", value: '[{"name":"a","value":"b"}]' },
					],
				},
			],
		);
		expect(agent.init.agentCapabilities?.mcpCapabilities?.http).toBe(false);
		expect(await agent.prompt(kickoff("01req"))).toBe("end_turn");
		const calls = readFileSync(recLog, "utf8")
			.trim()
			.split("\n")
			.map(
				(l) => JSON.parse(l) as { tool: string; env: Record<string, string> },
			);
		expect(calls.map((c) => c.tool)).toEqual([
			"attach",
			"threads",
			"next",
			"reply",
			"next",
			"detach",
		]);
		expect(calls[0]?.env.CRB_MCP_HEADERS).toBe('[{"name":"a","value":"b"}]');
	});

	it("replies none: takes the question and ends the turn without replying; no request in the prompt: no attach", async () => {
		const { recorderServer } = (await import(
			join(FAKE, "mcp-recorder.mjs")
		)) as { recorderServer: () => Promise<Recorder> };
		const rec = await recorderServer();
		stops.push(() => rec.close());
		const agent = await fakeAgent({ mcp: { replies: "none" } }, [
			{ type: "http", name: "crb", url: rec.url, headers: [] },
		]);
		expect(await agent.prompt("A question waits for you: call next.")).toBe(
			"end_turn",
		);
		expect(rec.calls).toEqual([]);
		expect(await agent.prompt(kickoff("01req"))).toBe("end_turn");
		expect(rec.calls.map((c) => c.tool)).toEqual(["attach", "next"]);
	});
});
