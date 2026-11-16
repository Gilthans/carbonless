// A fake ACP agent for tests, speaking the Agent Client Protocol over stdio
// with the SDK's agent(). It answers from the scenario JSON at
// $CRB_FAKE_ACP (see scenario.ts) and appends every request it gets, and
// every permission answer it is given, to $CRB_FAKE_ACP_LOG (JSONL).
import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	getDefaultEnvironment,
	StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { watchOwner } from "../../scripts/owner.mjs";

// A held or lingering agent outlives a test runner killed mid-test.
watchOwner(() => process.exit(0));

const scenarioPath = process.env.CRB_FAKE_ACP;
const read = () =>
	scenarioPath ? JSON.parse(readFileSync(scenarioPath, "utf8")) : {};
const s = read();
const name = s.agent?.name ?? "fake-acp";
const version = s.agent?.version ?? "0.0.0";

function log(entry) {
	const path = process.env.CRB_FAKE_ACP_LOG;
	if (path) {
		appendFileSync(path, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
	}
}
log({
	method: "spawn",
	params: {
		cwd: process.cwd(),
		argv: process.argv.slice(2),
		env: Object.keys(process.env).sort(),
	},
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Waits while the scenario file holds `op` (a test's gate: release() takes
 * it out), polling every 20 ms like the fake gh; `stop()` ends the wait
 * early (a cancelled turn).
 */
async function hold(op, stop = () => false) {
	if (!s.hold?.includes(op)) return;
	for (;;) {
		if (stop()) return;
		if (!read().hold?.includes(op)) return;
		await sleep(20);
	}
}

/** The latest message's text: the envelope's last message, else all text. */
function latestText(prompt) {
	const text = prompt
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	const json = text.indexOf("\n\n{");
	if (json >= 0) {
		try {
			const env = JSON.parse(text.slice(json + 2).split("\n")[0]);
			const last = env.messages?.at(-1)?.text;
			if (typeof last === "string") return last;
		} catch {}
	}
	return text;
}

/** n pieces of `text`, in order, none empty unless the text is. */
function split(text, n) {
	const count = Math.max(1, Math.min(n ?? 1, text.length || 1));
	const size = Math.ceil(text.length / count);
	const out = [];
	for (let i = 0; i < count; i++)
		out.push(text.slice(i * size, (i + 1) * size));
	return out.filter((p, i) => p !== "" || i === 0);
}

const cancelled = new Set();
let calls = 0;

/** The `crb` MCP server session/new gave (null: none, the old text-answer mode). */
let crbServer = null;
/** The connected MCP client, once a prompt needed it. */
let mcpClient = null;
/** The token an approved attach returned. */
let token = null;

async function connectMcp() {
	if (mcpClient) return mcpClient;
	const c = new Client({ name: "fake-acp", version });
	const srv = crbServer;
	const pairs = (list) =>
		Object.fromEntries((list ?? []).map((h) => [h.name, h.value]));
	const transport =
		srv.type === "http"
			? new StreamableHTTPClientTransport(new URL(srv.url), {
					requestInit: { headers: pairs(srv.headers) },
				})
			: new StdioClientTransport({
					command: srv.command,
					args: srv.args,
					env: { ...getDefaultEnvironment(), ...pairs(srv.env) },
				});
	await c.connect(transport);
	mcpClient = c;
	return c;
}

/** The turn's session/update sender, while a turn runs (for `mcp.report`). */
let reportCall = null;

/** Calls crb's tool `name`: its JSON answer, logged (the token redacted). */
async function tool(name, args) {
	const c = await connectMcp();
	// As Claude Code does: an MCP call is a tool_call too, named
	// mcp__<server>__<tool> in its _meta and title.
	if (reportCall) {
		const full = `mcp__crb__${name}`;
		await reportCall({
			sessionUpdate: "tool_call",
			toolCallId: `call-${++calls}`,
			title: full,
			kind: "other",
			status: "pending",
			rawInput: {},
			_meta: { claudeCode: { toolName: full } },
		});
	}
	const r = await c.callTool({ name, arguments: args });
	const text = r.content?.[0]?.text ?? "{}";
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		value = { text };
	}
	const { token: _, ...shown } = args;
	const { token: __, ...said } = value;
	log({
		method: `mcp/${name}`,
		params: shown,
		response: { error: r.isError === true, value: said },
	});
	return { error: r.isError === true, value };
}

/** The attach arguments the kickoff prompt carries: a JSON line with `request`. */
function attachArgs(text) {
	for (const line of text.split("\n")) {
		const at = line.indexOf('{"review"');
		if (at < 0) continue;
		try {
			const args = JSON.parse(line.slice(at));
			if (typeof args.request === "string") return args;
		} catch {}
	}
	return null;
}

/** Permission requests (each a tool_call update first), as the scenario lists them. */
async function permissions(cx, update, sessionId) {
	for (const r of s.requests ?? []) {
		const toolCallId = `call-${++calls}`;
		await update({
			sessionUpdate: "tool_call",
			toolCallId,
			title: r.title,
			kind: r.kind,
			status: "pending",
			rawInput: r.rawInput ?? {},
		});
		const params = {
			sessionId,
			toolCall: {
				toolCallId,
				title: r.title,
				kind: r.kind,
				rawInput: r.rawInput ?? {},
				status: "pending",
			},
			options: [
				{ optionId: "allow", name: "Allow", kind: "allow_once" },
				{ optionId: "reject", name: "Reject", kind: "reject_once" },
			],
		};
		const response = await cx.client.request(
			methods.client.session.requestPermission,
			params,
		);
		log({ method: "session/request_permission", params, response });
		const allowed =
			response.outcome.outcome === "selected" &&
			response.outcome.optionId === "allow";
		await update({
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: allowed ? "completed" : "failed",
		});
	}
}

/** The answer for a question's latest message: the first match, else the last. */
function answerFor(latest) {
	const answers = s.answers?.length ? s.answers : [{ text: "ok" }];
	return (
		answers.find((a) => a.match !== undefined && latest.includes(a.match)) ??
		answers.at(-1)
	);
}

/** The answer's `open` steps, in order: each one's cite (null when refused). */
async function opens(steps) {
	const cites = [];
	let ghThreads = null;
	for (const step of steps ?? []) {
		let thread = step.thread;
		if (step.ghThread !== undefined) {
			if (!ghThreads) {
				const r = await tool("review", { token });
				ghThreads = r.value.review?.threads ?? [];
			}
			thread = ghThreads[step.ghThread]?.id ?? "unknown";
		}
		const r = await tool("open", {
			token,
			text: step.text,
			...(step.key !== undefined ? { key: step.key } : {}),
			...(step.code ? { code: step.code } : { thread }),
		});
		cites.push(r.error ? null : r.value.cite);
	}
	return cites;
}

/**
 * A turn as a joined session works: attach with the kickoff's request (once),
 * the scenario's extra tools, then next → reply until none waits.
 */
async function mcpTurn(cx, sessionId, prompt) {
	const stopped = () => cancelled.has(sessionId);
	const update = (u) =>
		cx.client.notify(methods.client.session.update, { sessionId, update: u });
	const cfg = { attach: true, replies: "answer", ...(s.mcp ?? {}) };
	reportCall = cfg.report ? update : null;
	const text = prompt
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	if (!token && cfg.attach) {
		const args = attachArgs(text);
		if (args) {
			const r = await tool("attach", { name, ...args });
			if (r.value.state === "approved") token = r.value.token;
		}
	}
	if (!token) return { stopReason: "end_turn" };
	for (const t of cfg.tools ?? []) await tool(t, { token });
	let crashed = false;
	for (;;) {
		if (cfg.next === false) break;
		if (stopped()) return { stopReason: "cancelled" };
		const q = await tool("next", { token });
		if (q.error || q.value.none) break;
		if (s.crashOnPrompt && !crashed) {
			crashed = true;
			process.stdout.write("", () => process.exit(70));
			return new Promise(() => {});
		}
		if (s.lingerOnPrompt) {
			// Its stdout closes, the process lives on (until killed).
			process.stdout.write("", () => {
				process.stdout.on("error", () => {});
				closeSync(1);
				setInterval(() => {}, 1000);
			});
			return new Promise(() => {});
		}
		await permissions(cx, update, sessionId);
		const latest = q.value.envelope?.messages?.at(-1)?.text ?? "";
		const answer = answerFor(latest);
		if (answer.run?.length) {
			execFileSync(answer.run[0], answer.run.slice(1), { stdio: "ignore" });
		}
		await update({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: answer.text },
		});
		await hold("prompt", stopped);
		if (stopped()) return { stopReason: "cancelled" };
		if (answer.stop === "error") {
			throw new Error(answer.error ?? "fake agent: error");
		}
		if (cfg.replies === "none") return { stopReason: "end_turn" };
		if (cfg.strayReply) {
			await tool("reply", {
				token,
				thread: cfg.strayReply,
				replyTo: q.value.replyTo ?? "",
				text: "stray",
			});
		}
		const cites = await opens(answer.open);
		await tool("reply", {
			token,
			thread: q.value.thread,
			replyTo: q.value.replyTo ?? "",
			text: answer.text.replace(/\{\{cite:(\d+)\}\}/g, (all, i) =>
				typeof cites[Number(i)] === "string" ? cites[Number(i)] : all,
			),
		});
		if (answer.stop && answer.stop !== "end_turn") {
			return { stopReason: answer.stop };
		}
	}
	if (cfg.detach) await tool("detach", { token });
	return { stopReason: "end_turn" };
}

agent({ name })
	.onRequest(methods.agent.initialize, async (cx) => {
		log({ method: "initialize", params: cx.params });
		if (s.initializeError) {
			process.stderr.write(`${s.initializeError}\n`, () => process.exit(1));
			return new Promise(() => {});
		}
		await hold("initialize");
		return {
			protocolVersion: 1,
			agentCapabilities: {
				mcpCapabilities: { http: s.mcpHttp !== false, sse: false },
			},
			agentInfo: { name, version },
			authMethods: [],
		};
	})
	.onRequest(methods.agent.session.new, async (cx) => {
		log({ method: "session/new", params: cx.params });
		crbServer =
			(cx.params.mcpServers ?? []).find((m) => m.name === "crb") ?? null;
		return { sessionId: `fake-${process.pid}` };
	})
	.onRequest(methods.agent.session.prompt, async (cx) => {
		const { sessionId, prompt } = cx.params;
		log({ method: "session/prompt", params: cx.params });
		cancelled.delete(sessionId);
		const stopped = () => cancelled.has(sessionId);
		const update = (u) =>
			cx.client.notify(methods.client.session.update, { sessionId, update: u });
		if (crbServer) return mcpTurn(cx, sessionId, prompt);
		await permissions(cx, update, sessionId);
		const answer = answerFor(latestText(prompt));
		// A command the agent runs in its cwd before answering (e.g. a checkout).
		if (answer.run?.length) {
			execFileSync(answer.run[0], answer.run.slice(1), { stdio: "ignore" });
		}
		const [first = "", ...rest] = split(answer.text, answer.chunks);
		await update({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: first },
		});
		if (s.lingerOnPrompt) {
			// Its stdout closes, the process lives on (until killed).
			process.stdout.write("", () => {
				process.stdout.on("error", () => {});
				closeSync(1);
				setInterval(() => {}, 1000);
			});
			return new Promise(() => {});
		}
		if (s.crashOnPrompt) {
			// Flushed first: the client sees the chunk, then the exit.
			process.stdout.write("", () => process.exit(70));
			return new Promise(() => {});
		}
		await hold("prompt", stopped);
		for (const piece of rest) {
			if (stopped()) break;
			await update({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: piece },
			});
		}
		if (stopped()) return { stopReason: "cancelled" };
		if (answer.stop === "error") {
			throw new Error(answer.error ?? "fake agent: error");
		}
		return { stopReason: answer.stop ?? "end_turn" };
	})
	.onNotification(methods.agent.session.cancel, async (cx) => {
		log({ method: "session/cancel", params: cx.params });
		cancelled.add(cx.params.sessionId);
	})
	.connect(
		ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
	);
