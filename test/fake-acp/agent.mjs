// A fake ACP agent for tests, speaking the Agent Client Protocol over stdio
// with the SDK's agent(). It answers from the scenario JSON at
// $CRB_FAKE_ACP (see scenario.ts) and appends every request it gets, and
// every permission answer it is given, to $CRB_FAKE_ACP_LOG (JSONL).
import { appendFileSync, closeSync, readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";

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
			agentCapabilities: {},
			agentInfo: { name, version },
			authMethods: [],
		};
	})
	.onRequest(methods.agent.session.new, async (cx) => {
		log({ method: "session/new", params: cx.params });
		return { sessionId: `fake-${process.pid}` };
	})
	.onRequest(methods.agent.session.prompt, async (cx) => {
		const { sessionId, prompt } = cx.params;
		log({ method: "session/prompt", params: cx.params });
		cancelled.delete(sessionId);
		const stopped = () => cancelled.has(sessionId);
		const update = (u) =>
			cx.client.notify(methods.client.session.update, { sessionId, update: u });
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
		const latest = latestText(prompt);
		const answers = s.answers?.length ? s.answers : [{ text: "ok" }];
		const answer =
			answers.find((a) => a.match !== undefined && latest.includes(a.match)) ??
			answers.at(-1);
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
