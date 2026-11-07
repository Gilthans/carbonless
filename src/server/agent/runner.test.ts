import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AcpScenario,
	acpLog,
	FAKE_ACP_BIN,
	releaseAcp,
	writeAcpScenario,
} from "../../../test/fake-acp/scenario.js";
import {
	createBareRepo,
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
	testGitEnv,
} from "../../../test/git-fixture.js";
import type {
	AgentAnchor,
	AgentConfig,
	AgentStatus,
} from "../../shared/agent.js";
import { RefStore } from "../review/refStore.js";
import { agentsDir } from "./checkout.js";
import type { PromptEnvelope } from "./prompt.js";
import { AgentRunner, type RunnerDeps } from "./runner.js";
import { AgentThreadStore } from "./store.js";

// Real git and fake agent processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const REVIEW = "01k9e6m2q8x4v7c3n5b0h1j2t6";
const AGENT: AgentConfig = {
	command: "claude-agent-acp",
	args: [],
	env: {},
	leash: "open",
};

let tmp: string;
let origin: GitFixture;
let cache: { path: string; cleanup: () => void };
let store: AgentThreadStore;
let scenarioPath: string;
let logPath: string;
let config: { agent: AgentConfig | null; problems: string[] };
let runner: AgentRunner;
const saved: Record<string, string | undefined> = {};

const anchor = (line: number): AgentAnchor => ({
	subject: "line",
	path: "a.txt",
	commit: origin.shas[1] as string,
	side: "RIGHT",
	line,
	startSide: "RIGHT",
	startLine: line,
});

const scenario = (s: Partial<AcpScenario> = {}) => {
	scenarioPath = writeAcpScenario(tmp, {
		agent: { name: "fake-acp", version: "1.0.0" },
		...s,
	});
	process.env.CRB_FAKE_ACP = scenarioPath;
};

function makeRunner(over: Partial<RunnerDeps> = {}): AgentRunner {
	runner = new AgentRunner({
		reviewId: REVIEW,
		config: async () => config,
		store,
		cacheClone: cache.path,
		head: origin.shas[1] as string,
		port: 4800,
		viewer: "dan",
		facts: {
			review: () => ({
				repo: "acme/widget",
				pr: 12,
				url: "https://github.com/acme/widget/pull/12",
				base: { ref: "main", commit: origin.shas[0] as string },
				head: { ref: "feature", commit: origin.shas[1] as string },
				mergeBase: origin.shas[0] as string,
				tree: join(agentsDir(), REVIEW, "tree"),
			}),
			prFacts: async () => ({
				title: "Add a lock",
				body: "<!-- hidden -->Body",
				files: ["a.txt"],
			}),
			anchored: async () => null,
			hunk: async () => null,
			authorOf: () => "reviewer",
		},
		...over,
	});
	return runner;
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "crb-runner-"));
	logPath = join(tmp, "acp.log");
	origin = createGitFixture([
		{ message: "base", files: { "a.txt": "old\n" } },
		{ message: "pr", files: { "a.txt": "new\n" } },
	]);
	cache = createBareRepo();
	execFileSync(
		"git",
		[
			"-C",
			cache.path,
			"fetch",
			"--quiet",
			origin.path,
			`${origin.shas[1]}:refs/pull/12/head`,
		],
		{ env: testGitEnv() },
	);
	store = new AgentThreadStore(new RefStore(cache.path), REVIEW, "dan");
	config = { agent: AGENT, problems: [] };
	for (const k of ["PATH", "CRB_FAKE_ACP", "CRB_FAKE_ACP_LOG"])
		saved[k] = process.env[k];
	process.env.PATH = `${FAKE_ACP_BIN}:${process.env.PATH}`;
	process.env.CRB_FAKE_ACP_LOG = logPath;
	scenario();
});

afterEach(async () => {
	await runner?.close();
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	origin.cleanup();
	cache.cleanup();
	rmSync(tmp, { recursive: true, force: true });
	rmSync(agentsDir(), { recursive: true, force: true });
});

const ask = (text: string, line = 1, clientId = `c-${text.length}-${line}`) =>
	store.open({ anchor: anchor(line), text, by: "human", clientId });
const threads = () => store.read();
const prompts = () =>
	acpLog(logPath)
		.filter((e) => e.method === "session/prompt")
		.map((e) => {
			const blocks = (e.params as { prompt: Array<{ text?: string }> }).prompt;
			const text = blocks[0]?.text ?? "";
			return JSON.parse(
				text.slice(text.indexOf("\n\n{") + 2),
			) as PromptEnvelope;
		});
const spawns = () => acpLog(logPath).filter((e) => e.method === "spawn");
const until = async (
	check: (s: AgentStatus) => boolean,
): Promise<AgentStatus> => {
	let last: AgentStatus | undefined;
	await vi.waitFor(
		async () => {
			last = await runner.status();
			expect(check(last)).toBe(true);
		},
		{ timeout: 20_000, interval: 20 },
	);
	return last as AgentStatus;
};
const answered = async (n: number) =>
	vi.waitFor(
		async () => {
			const all = await threads();
			expect(all.filter((t) => !t.waiting).length).toBe(n);
		},
		{ timeout: 20_000, interval: 20 },
	);

describe("AgentRunner", () => {
	it("spawns on poke, answers the oldest waiting thread first", async () => {
		const first = await ask("first?");
		const second = await ask("second?", 2);
		makeRunner().poke();
		await answered(2);
		expect(prompts().map((p) => p.thread.id)).toEqual([first.id, second.id]);
		const [one, two] = prompts();
		expect(one?.pr).toEqual({
			title: "Add a lock",
			body: "Body",
			files: ["a.txt"],
		});
		expect(two?.pr).toBeUndefined();
		expect(one?.messages).toEqual([
			{
				author: { login: "dan", role: "reviewer" },
				at: first.at,
				text: "first?",
			},
		]);
		const [t] = await threads();
		expect(t?.messages[1]).toMatchObject({
			by: "ai",
			text: "ok",
			stop: "end_turn",
			agent: { name: "fake-acp", version: "1.0.0" },
		});
		expect(spawns()).toHaveLength(1);
		expect(spawns()[0]?.params).toMatchObject({
			cwd: join(agentsDir(), REVIEW),
		});
	});

	it("backlog is drained on attach (three waiting threads → three ai messages, in opened order)", async () => {
		const ids = [
			(await ask("one", 1)).id,
			(await ask("two", 2)).id,
			(await ask("three", 3)).id,
		];
		makeRunner().poke();
		await answered(3);
		expect(prompts().map((p) => p.thread.id)).toEqual(ids);
		expect((await runner.status()).waiting).toBe(0);
	});

	it("a reply while answering waits for the turn, then is answered", async () => {
		scenario({ hold: ["prompt"], answers: [{ text: "a b", chunks: 2 }] });
		const t = await ask("why?");
		makeRunner().poke();
		await until((s) => s.state === "busy");
		await store.message(t.id, { by: "human", text: "and?", clientId: "r1" });
		runner.poke();
		expect(prompts()).toHaveLength(1);
		releaseAcp(scenarioPath, "prompt");
		await vi.waitFor(
			async () => expect((await threads())[0]?.messages).toHaveLength(4),
			{ timeout: 20_000, interval: 20 },
		);
		const [, second] = prompts();
		// The reply was stored before the turn's answer, so it folds first; the
		// thread still gets an answer that has it.
		expect(second?.messages.map((m) => m.text)).toEqual([
			"why?",
			"and?",
			"a b",
		]);
		expect(second?.messages[2]?.author).toEqual({ role: "agent" });
	});

	it("status reports starting → ready → busy → ready with answering.text growing while held", async () => {
		scenario({
			hold: ["initialize", "prompt"],
			answers: [{ text: "Two writers race.", chunks: 2 }],
		});
		makeRunner().poke();
		const starting = await until((s) => s.state === "starting");
		expect(starting.configured).toBe(true);
		releaseAcp(scenarioPath, "initialize");
		const ready = await until((s) => s.state === "ready");
		expect(ready.agent).toEqual({ name: "fake-acp", version: "1.0.0" });
		const t = await ask("why?");
		runner.poke();
		const busy = await until((s) => s.state === "busy" && !!s.answering?.text);
		expect(busy.answering).toEqual({
			thread: t.id,
			text: "Two write",
			activity: [],
		});
		expect(busy.waiting).toBe(1);
		releaseAcp(scenarioPath, "prompt");
		const done = await until((s) => s.state === "ready" && s.waiting === 0);
		expect(done.answering).toBeUndefined();
		expect((await threads())[0]?.messages[1]?.text).toBe("Two writers race.");
	});

	it("activity records tool calls and the decision; a rejection's reason is the next envelope's notice", async () => {
		scenario({
			requests: [
				{
					kind: "execute",
					title: "node -e 1",
					rawInput: { command: "node -e 1" },
				},
				{
					kind: "switch_mode",
					title: "Enter plan mode",
					rawInput: { mode: "plan" },
				},
			],
		});
		const t = await ask("run it");
		makeRunner().poke();
		await answered(1);
		const [thread] = await threads();
		expect(thread?.messages[1]?.activity).toEqual([
			{ kind: "execute", title: "node -e 1", decision: "allowed" },
			{ kind: "switch_mode", title: "Enter plan mode", decision: "rejected" },
		]);
		const responses = acpLog(logPath)
			.filter((e) => e.method === "session/request_permission")
			.map((e) => e.response);
		expect(responses).toEqual([
			{ outcome: { outcome: "selected", optionId: "allow" } },
			{ outcome: { outcome: "selected", optionId: "reject" } },
		]);
		expect(prompts()[0]?.notice).toBeUndefined();
		await store.message(t.id, {
			by: "human",
			text: "why not?",
			clientId: "r1",
		});
		runner.poke();
		await vi.waitFor(() => expect(prompts()).toHaveLength(2), {
			timeout: 20_000,
			interval: 20,
		});
		expect(prompts()[1]?.notice).toBe(
			"carbonless keeps the session out of plan mode",
		);
	});

	it("cancel stores the partial text with stop cancelled", async () => {
		scenario({
			hold: ["prompt"],
			answers: [{ text: "partialpartial", chunks: 2 }],
		});
		await ask("why?");
		makeRunner().poke();
		await until((s) => s.state === "busy" && !!s.answering?.text);
		await runner.cancel();
		await answered(1);
		expect((await threads())[0]?.messages[1]).toMatchObject({
			text: "partial",
			stop: "cancelled",
		});
		await until((s) => s.state === "ready");
	});

	it("crash mid-turn stores the partial reply, respawns once, a second crash stays error", async () => {
		scenario({
			crashOnPrompt: true,
			answers: [{ text: "half and the rest", chunks: 2 }],
		});
		await ask("one?", 1);
		makeRunner().poke();
		await answered(1);
		expect((await threads())[0]?.messages[1]).toMatchObject({
			text: "half and ",
			stop: "error",
		});
		const error = await until((s) => s.state === "error");
		expect(error.error).toContain("exited with code 70");
		await runner.settled();
		expect(spawns()).toHaveLength(1);

		await ask("two?", 2);
		runner.poke();
		await answered(2);
		await until((s) => s.state === "error");
		await runner.settled();
		expect(spawns()).toHaveLength(2);

		await ask("three?", 3);
		runner.poke();
		await runner.settled();
		expect(spawns()).toHaveLength(2);
		expect((await runner.status()).state).toBe("error");
		expect((await threads())[2]?.waiting).toBe(true);
	});

	it("bad config is an error status, not a crash", async () => {
		config = {
			agent: null,
			problems: ["agent.command must be a non-empty string; agent disabled"],
		};
		await ask("why?");
		makeRunner().poke();
		await runner.settled();
		expect(await runner.status()).toMatchObject({
			state: "off",
			configured: false,
			error: "agent.command must be a non-empty string; agent disabled",
			waiting: 1,
		});
		expect(spawns()).toHaveLength(0);
	});

	it("elsewhere when the claim is held by a live pid, retries on status", async () => {
		const dir = join(agentsDir(), REVIEW);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "claim.json"),
			JSON.stringify({ pid: process.ppid, port: 4801, token: "theirs" }),
		);
		await ask("why?");
		makeRunner().poke();
		await runner.settled();
		expect(await runner.status()).toMatchObject({
			state: "elsewhere",
			elsewhere: 4801,
		});
		expect(spawns()).toHaveLength(0);
		rmSync(join(dir, "claim.json"));
		await runner.status();
		await answered(1);
		expect(spawns()).toHaveLength(1);
	});

	it("a config change to a new command respawns; to null closes", async () => {
		makeRunner().poke();
		await until((s) => s.state === "ready");
		const [firstSpawn] = spawns();
		config = { agent: { ...AGENT, args: ["--again"] }, problems: [] };
		await until((s) => s.state === "ready" && spawns().length === 2);
		expect(spawns()[1]?.params).toMatchObject({ argv: ["--again"] });
		await vi.waitFor(() =>
			expect(() => process.kill(firstSpawn?.pid as number, 0)).toThrow(),
		);
		const secondPid = spawns()[1]?.pid as number;
		config = { agent: null, problems: [] };
		expect((await runner.status()).state).toBe("off");
		await runner.settled();
		expect(() => process.kill(secondPid, 0)).toThrow();
		expect((await runner.status()).state).toBe("off");
	});

	it("turn deadline cancels", async () => {
		scenario({
			hold: ["prompt"],
			answers: [{ text: "slow answer", chunks: 2 }],
		});
		await ask("why?");
		makeRunner({ turnMs: 50 }).poke();
		await answered(1);
		expect((await threads())[0]?.messages[1]).toMatchObject({
			stop: "cancelled",
		});
		expect(acpLog(logPath).some((e) => e.method === "session/cancel")).toBe(
			true,
		);
	});

	it("close removes the checkout and releases the claim; an unfinished turn is not stored", async () => {
		scenario({ hold: ["prompt"], answers: [{ text: "a b", chunks: 2 }] });
		await ask("why?");
		makeRunner().poke();
		await until((s) => s.state === "busy");
		await runner.close();
		const dir = join(agentsDir(), REVIEW);
		expect(() => execFileSync("test", ["-e", join(dir, "tree")])).toThrow();
		expect(() =>
			execFileSync("test", ["-e", join(dir, "claim.json")]),
		).toThrow();
		expect((await threads())[0]?.waiting).toBe(true);
		expect((await threads())[0]?.messages).toHaveLength(1);
	});
});
