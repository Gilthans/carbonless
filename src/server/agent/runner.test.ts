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
import { JoinBroker } from "./join.js";
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
/** The PR's head as the review sees it (a Refresh moves it). */
let prHead: string;
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
				head: { ref: "feature", commit: prHead },
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
	prHead = origin.shas[1] as string;
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
		// Durable: the first answer names the question it saw, so the reply
		// waited in the ref itself, not in the runner's memory.
		const stored = (await threads())[0]?.messages ?? [];
		expect(stored[2]?.replyTo).toBe(stored[0]?.id);
		expect(stored[3]?.replyTo).toBe(stored[1]?.id);
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
			asked: t.messages[0]?.id,
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

	/** Two crashes in a row (the gate shut), the third question left waiting. */
	const crashTwice = async (over: Partial<RunnerDeps> = {}) => {
		scenario({
			crashOnPrompt: true,
			answers: [{ text: "half and the rest", chunks: 2 }],
		});
		await ask("one?", 1);
		makeRunner(over).poke();
		await answered(1);
		await until((s) => s.state === "error");
		await runner.settled();
		await ask("two?", 2);
		runner.poke();
		await answered(2);
		await until((s) => s.state === "error");
		await runner.settled();
		expect(spawns()).toHaveLength(2);
		await ask("three?", 3);
		// A poll or a poke alone doesn't respawn: never a loop.
		runner.poke();
		await runner.settled();
		await runner.status();
		await runner.settled();
		expect(spawns()).toHaveLength(2);
		expect((await threads())[2]?.waiting).toBe(true);
		scenario({ answers: [{ text: "fine now" }] });
	};

	it("after two crashes, a new question spawns again and is answered", async () => {
		await crashTwice();
		await ask("four?", 4);
		runner.asked();
		await answered(4);
		expect(spawns()).toHaveLength(3);
		expect((await threads())[3]?.messages[1]).toMatchObject({
			text: "fine now",
			stop: "end_turn",
		});
		await until((s) => s.state === "ready");
	});

	it("after two crashes, a Save of the same config spawns again and answers the backlog", async () => {
		let saves = 0;
		await crashTwice({ config: async () => ({ ...config, saves }) });
		saves++;
		await runner.status();
		await answered(3);
		expect(spawns()).toHaveLength(3);
		expect((await threads())[2]?.messages[1]?.text).toBe("fine now");
		await until((s) => s.state === "ready");
	});

	it("a turn the agent fails keeps its reason: on the stored reply and in the status", async () => {
		scenario({
			answers: [
				{ match: "why", text: "", stop: "error", error: "Rate limited" },
				{ text: "fine" },
			],
		});
		await ask("why?");
		makeRunner().poke();
		await answered(1);
		expect((await threads())[0]?.messages[1]).toMatchObject({
			text: "",
			stop: "error",
			error: "Internal error: Rate limited",
		});
		const failed = await until((s) => s.state === "error");
		expect(failed.error).toBe("Internal error: Rate limited");
		// The process lives on: the next question is answered by it.
		await ask("and now?", 2);
		runner.asked();
		await answered(2);
		await until((s) => s.state === "ready");
		expect(spawns()).toHaveLength(1);
	});

	it("the streamed answer stays in the status until the reply is stored", async () => {
		scenario({ answers: [{ text: "Two writers race.", chunks: 2 }] });
		let land: () => void = () => {};
		const landed = new Promise<void>((r) => {
			land = r;
		});
		let writing = false;
		const gated = new Proxy(store, {
			get(target, prop, receiver) {
				if (prop === "message") {
					return async (...args: Parameters<AgentThreadStore["message"]>) => {
						if (args[1].by === "ai") {
							writing = true;
							await landed;
						}
						return target.message(...args);
					};
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const t = await ask("why?");
		makeRunner({ store: gated }).poke();
		await vi.waitFor(() => expect(writing).toBe(true), {
			timeout: 20_000,
			interval: 20,
		});
		const during = await runner.status();
		expect(during.answering).toMatchObject({
			thread: t.id,
			text: "Two writers race.",
		});
		expect(during.state).toBe("busy");
		land();
		const done = await until((s) => s.state === "ready");
		expect(done.answering).toBeUndefined();
		expect((await threads())[0]?.messages[1]?.text).toBe("Two writers race.");
	});

	it("an agent whose connection closes but whose process lingers is killed and replaced", async () => {
		scenario({
			lingerOnPrompt: true,
			answers: [{ text: "half and the rest", chunks: 2 }],
		});
		await ask("one?", 1);
		makeRunner().poke();
		await answered(1);
		expect((await threads())[0]?.messages[1]).toMatchObject({
			text: "half and ",
			stop: "error",
		});
		const lost = await until((s) => s.state === "error");
		expect(lost.error).toMatch(/connection closed/);
		const lingering = spawns()[0]?.pid as number;
		await vi.waitFor(() => expect(() => process.kill(lingering, 0)).toThrow(), {
			timeout: 20_000,
			interval: 20,
		});
		scenario({ answers: [{ text: "fine" }] });
		await ask("two?", 2);
		runner.asked();
		await answered(2);
		expect(spawns()).toHaveLength(2);
		await until((s) => s.state === "ready");
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
		await vi.waitFor(
			() => expect(() => process.kill(firstSpawn?.pid as number, 0)).toThrow(),
			{ timeout: 20_000, interval: 20 },
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

	it("close doesn't wait for a start that hangs (initialize held)", async () => {
		scenario({ hold: ["initialize"] });
		makeRunner().poke();
		await until((s) => s.state === "starting");
		await vi.waitFor(
			() =>
				expect(acpLog(logPath).some((e) => e.method === "initialize")).toBe(
					true,
				),
			{ timeout: 20_000, interval: 20 },
		);
		const pid = spawns()[0]?.pid as number;
		// Held for good: only stopping the start lets close() resolve.
		await runner.close();
		expect(() => process.kill(pid, 0)).toThrow();
		expect((await runner.status()).state).toBe("off");
	});

	it("an agent set to none releases the claim and removes the tree; set again, both come back", async () => {
		makeRunner().poke();
		await until((s) => s.state === "ready");
		config = { agent: null, problems: [] };
		await runner.status();
		await runner.settled();
		expect(() =>
			execFileSync("test", ["-e", join(agentsDir(), REVIEW, "claim.json")]),
		).toThrow();
		// The tree goes with it: a sweep by the next holder can't pull it
		// from under a cwd this runner still points at.
		expect(() =>
			execFileSync("test", ["-e", join(agentsDir(), REVIEW, "tree")]),
		).toThrow();
		config = { agent: AGENT, problems: [] };
		await runner.status();
		await until((s) => s.state === "ready");
		expect(treeHead()).toBe(origin.shas[1]);
	});

	it("a config change during a turn stores nothing; the new agent answers the thread", async () => {
		scenario({
			hold: ["prompt"],
			answers: [{ text: "first second", chunks: 2 }],
		});
		await ask("why?");
		makeRunner().poke();
		await until((s) => s.state === "busy" && !!s.answering?.text);
		config = { agent: { ...AGENT, args: ["--again"] }, problems: [] };
		await runner.status();
		releaseAcp(scenarioPath, "prompt");
		await answered(1);
		const [t] = await threads();
		expect(t?.messages).toHaveLength(2);
		expect(t?.messages[1]).toMatchObject({
			text: "first second",
			stop: "end_turn",
		});
		expect(spawns()).toHaveLength(2);
	});

	it("the claim holder answers a question asked on the server that shows elsewhere", async () => {
		const holder = makeRunner({ port: 4800 });
		holder.poke();
		await until((s) => s.state === "ready");
		const otherStore = new AgentThreadStore(
			new RefStore(cache.path),
			REVIEW,
			"dan",
		);
		const other = new AgentRunner({
			reviewId: REVIEW,
			config: async () => config,
			store: otherStore,
			cacheClone: cache.path,
			head: origin.shas[1] as string,
			port: 4801,
			facts: {
				review: () => {
					throw new Error("the elsewhere runner never prompts");
				},
				prFacts: async () => ({ title: "", body: "", files: [] }),
				anchored: async () => null,
				hunk: async () => null,
				authorOf: () => "reviewer",
			},
		});
		try {
			other.poke();
			await other.settled();
			expect(await other.status()).toMatchObject({
				state: "elsewhere",
				elsewhere: 4800,
			});
			const t = await otherStore.open({
				anchor: anchor(1),
				text: "asked elsewhere",
				by: "human",
				clientId: "e1",
			});
			other.poke();
			// The holder's page polls its status; that's where it notices.
			await until((s) => s.waiting === 0);
			const [answeredThread] = await threads();
			expect(answeredThread?.id).toBe(t.id);
			expect(answeredThread?.messages[1]).toMatchObject({
				by: "ai",
				text: "ok",
			});
		} finally {
			await other.close();
		}
	});

	/** A new commit on the PR, fetched into the cache clone like a Refresh. */
	const pushToPr = (files: Record<string, string>): string => {
		const run = (cwd: string, ...args: string[]) =>
			execFileSync("git", ["-C", cwd, ...args], {
				encoding: "utf8",
				env: testGitEnv(),
			}).trim();
		for (const [name, text] of Object.entries(files))
			writeFileSync(join(origin.path, name), text);
		run(origin.path, "commit", "--quiet", "-am", "more");
		const sha = run(origin.path, "rev-parse", "HEAD");
		run(
			cache.path,
			"fetch",
			"--quiet",
			origin.path,
			`${sha}:refs/pull/12/head`,
		);
		return sha;
	};
	const treeHead = () =>
		execFileSync(
			"git",
			["-C", join(agentsDir(), REVIEW, "tree"), "rev-parse", "HEAD"],
			{
				encoding: "utf8",
				env: testGitEnv(),
			},
		).trim();

	it("the agent's tree follows the PR's head before a turn", async () => {
		await ask("one?", 1);
		makeRunner().poke();
		await answered(1);
		expect(treeHead()).toBe(origin.shas[1]);
		prHead = pushToPr({ "a.txt": "newer\n" });
		await ask("two?", 2);
		runner.poke();
		await answered(2);
		expect(treeHead()).toBe(prHead);
		expect(prompts()[1]?.notice).toBeUndefined();
	});

	it("when the agent's own edits block the move, the envelope says so", async () => {
		await ask("one?", 1);
		makeRunner().poke();
		await answered(1);
		const old = treeHead();
		// The agent's uncommitted edit to a file the new head changes.
		writeFileSync(join(agentsDir(), REVIEW, "tree", "a.txt"), "agent's edit\n");
		prHead = pushToPr({ "a.txt": "newer\n" });
		await ask("two?", 2);
		runner.poke();
		await answered(2);
		expect(treeHead()).toBe(old);
		expect(prompts()[1]?.notice).toContain(`The PR's head is now ${prHead}`);
	});

	describe("ACP off (a session joined through MCP)", () => {
		const broker = () =>
			new JoinBroker({
				dir: join(agentsDir(), REVIEW),
				onApproved: async () => {},
				onLeft: () => {},
			});

		it("never spawns while ACP is off: status poll, new question, config save, a new runner on the same dir", async () => {
			const b = broker();
			await b.setAcpOff(true);
			let saves = 0;
			await ask("why?");
			const r = makeRunner({
				acpOff: () => b.acpOff(),
				config: async () => ({ ...config, saves }),
			});
			r.poke();
			await r.settled();
			expect((await r.status()).state).toBe("off");
			await ask("and?", 2);
			r.asked();
			await r.settled();
			saves++;
			await r.status();
			await r.settled();
			// The config changed: still off.
			config = { agent: { ...AGENT, args: ["--x"] }, problems: [] };
			await r.status();
			await r.settled();
			expect(spawns()).toHaveLength(0);
			const status = await r.status();
			expect(status).toMatchObject({
				state: "off",
				configured: true,
				waiting: 2,
			});
			await r.close();
			// A crb restart: a new broker and runner on the same dir.
			const again = broker();
			const r2 = makeRunner({ acpOff: () => again.acpOff() });
			r2.poke();
			await r2.status();
			await r2.settled();
			expect(spawns()).toHaveLength(0);
			// Start: on again, the backlog is answered.
			await again.setAcpOff(false);
			r2.asked();
			await answered(2);
			expect(spawns()).toHaveLength(1);
		});

		it("stop() lets the running turn finish, then closes the agent and stays off", async () => {
			scenario({ hold: ["prompt"], answers: [{ text: "a b", chunks: 2 }] });
			let off = false;
			await ask("why?");
			await ask("second?", 2);
			const r = makeRunner({ acpOff: () => off });
			r.poke();
			await until((s) => s.state === "busy");
			off = true;
			let stopped = false;
			const stop = r.stop(60 * 60_000).then(() => {
				stopped = true;
			});
			// Held: the stop waits for the turn.
			await r.status();
			expect(stopped).toBe(false);
			releaseAcp(scenarioPath, "prompt");
			await stop;
			const [first, second] = await threads();
			expect(first?.messages[1]).toMatchObject({
				text: "a b",
				stop: "end_turn",
			});
			// The next question isn't taken: ACP is off.
			expect(second?.waiting).toBe(true);
			const status = await r.status();
			expect(status.state).toBe("off");
			expect(status.agent).toBeUndefined();
			await r.settled();
			expect(spawns()).toHaveLength(1);
		});

		it("stop() cancels a turn that runs past its time", async () => {
			scenario({ hold: ["prompt"], answers: [{ text: "a b", chunks: 2 }] });
			let off = false;
			await ask("why?");
			const r = makeRunner({ acpOff: () => off });
			r.poke();
			await until((s) => s.state === "busy");
			off = true;
			await r.stop(50);
			expect((await threads())[0]?.messages[1]).toMatchObject({
				stop: "cancelled",
			});
			expect((await r.status()).state).toBe("off");
		});
	});
});
