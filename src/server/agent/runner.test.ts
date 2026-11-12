import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
	AgentView,
} from "../../shared/agent.js";
import { RefStore } from "../review/refStore.js";
import { agentsDir, createCheckout } from "./checkout.js";
import { orphanAnchor } from "./githubJoin.js";
import type {
	GithubThreadFacts,
	PromptEnvelope,
	PromptPatchset,
} from "./prompt.js";
import { AgentRunner, type RunnerDeps, type RunnerFacts } from "./runner.js";
import { type AgentThreadFold, AgentThreadStore } from "./store.js";

// The real checkout, wrapped so a test can hold it.
vi.mock("./checkout.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("./checkout.js")>();
	return { ...real, createCheckout: vi.fn(real.createCheckout) };
});

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
/** The reviewer's patch sets, as the runner's facts give them. */
let patchsets: PromptPatchset[];
/** GitHub's newest head (SessionInfo.currentHead). */
let currentHead: string;
/** What checkHead does (a test's fake gh moving the head), after counting. */
let onCheckHead: () => void;
let checkHeads: number;
/** GitHub's word on every thread conversation's thread. */
let ghState: "open" | "resolved" | "gone" | "unknown";
/** GitHub's thread as the session reads it for a turn. */
let ghThread: () => GithubThreadFacts;
const githubReads: { thread: string; view: AgentView }[] = [];
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
			authorOf: async () => "reviewer",
			...threadFacts(),
		},
		...over,
	});
	return runner;
}

/** The runner's facts about GitHub threads, patch sets and the head, from the test's state. */
function threadFacts(): Pick<
	RunnerFacts,
	"join" | "github" | "views" | "checkHead"
> {
	return {
		join: async (folds: AgentThreadFold[]) =>
			folds.map((f) => {
				if (f.anchor.subject !== "thread") return f;
				if (ghState === "gone") {
					return { ...f, anchor: orphanAnchor(f.anchor), orphaned: true };
				}
				if (ghState === "unknown") return { ...f, githubUnknown: true };
				return { ...f, resolved: ghState === "resolved" };
			}),
		github: async (thread, view) => {
			githubReads.push({ thread, view });
			return ghState === "gone" ? null : ghThread();
		},
		views: () => ({ patchsets, current: currentHead }),
		checkHead: async () => {
			checkHeads++;
			onCheckHead();
		},
	};
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
	currentHead = prHead;
	patchsets = [];
	onCheckHead = () => {};
	checkHeads = 0;
	ghState = "open";
	githubReads.length = 0;
	ghThread = () => ({
		url: "https://github.com/acme/widget/pull/12#discussion_r7",
		path: "a.txt",
		startLine: 1,
		line: 1,
		openedOn: origin.shas[1] as string,
		createdAt: "2026-11-02T00:00:00.000Z",
		outdated: false,
		resolved: ghState === "resolved",
		comments: [
			{
				login: "ann",
				role: "pr_author",
				at: "2026-11-02T00:00:00.000Z",
				body: "Is this right?",
			},
		],
		code: "@@ -1 +1 @@\n-old\n+new",
	});
	for (const k of ["PATH", "CRB_FAKE_ACP", "CRB_FAKE_ACP_LOG"])
		saved[k] = process.env[k];
	process.env.PATH = `${FAKE_ACP_BIN}${delimiter}${process.env.PATH}`;
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

const run = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: testGitEnv(),
	}).trim();
/** A new commit on the PR on GitHub's side, not fetched yet. */
const commitOnOrigin = (files: Record<string, string>): string => {
	for (const [name, text] of Object.entries(files))
		writeFileSync(join(origin.path, name), text);
	run(origin.path, "commit", "--quiet", "-am", "more");
	return run(origin.path, "rev-parse", "HEAD");
};
/** Fetches `sha` into the cache clone, as a Refresh or checkHead does. */
const fetchIntoCache = (sha: string) =>
	run(cache.path, "fetch", "--quiet", origin.path, `${sha}:refs/pull/12/head`);
/** A new commit on the PR, fetched into the cache clone like a Refresh. */
const pushToPr = (files: Record<string, string>): string => {
	const sha = commitOnOrigin(files);
	fetchIntoCache(sha);
	return sha;
};
const tree = () => join(agentsDir(), REVIEW, "tree");
const treeHead = () => run(tree(), "rev-parse", "HEAD");

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

	// Not on Windows: the .cmd shim's cmd.exe holds the stdout pipe open, so
	// the agent closing its end is no EOF until the agent exits.
	it.skipIf(process.platform === "win32")(
		"an agent whose connection closes but whose process lingers is killed and replaced",
		async () => {
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
			await vi.waitFor(
				() => expect(() => process.kill(lingering, 0)).toThrow(),
				{
					timeout: 20_000,
					interval: 20,
				},
			);
			scenario({ answers: [{ text: "fine" }] });
			await ask("two?", 2);
			runner.asked();
			await answered(2);
			expect(spawns()).toHaveLength(2);
			await until((s) => s.state === "ready");
		},
	);

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

	it("close while the checkout is being made spawns nothing and doesn't wait for a start", async () => {
		// initialize held for good: a start after close would keep close()
		// waiting for the agent's start timeout.
		scenario({ hold: ["initialize"] });
		const real =
			await vi.importActual<typeof import("./checkout.js")>("./checkout.js");
		let inCheckout!: () => void;
		const entered = new Promise<void>((r) => {
			inCheckout = r;
		});
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		vi.mocked(createCheckout).mockImplementationOnce(async (...args) => {
			inCheckout();
			await gate;
			return real.createCheckout(...args);
		});
		makeRunner().poke();
		await entered;
		const closed = runner.close();
		release();
		await closed;
		expect(spawns()).toEqual([]);
		expect((await runner.status()).state).toBe("off");
		expect(() =>
			execFileSync("test", ["-e", join(agentsDir(), REVIEW, "tree")]),
		).toThrow();
		expect(() =>
			execFileSync("test", ["-e", join(agentsDir(), REVIEW, "claim.json")]),
		).toThrow();
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
				authorOf: async () => "reviewer",
				...threadFacts(),
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
});

describe("AgentRunner: thread conversations", () => {
	const threadAnchor = (
		commit = origin.shas[1] as string,
	): Extract<AgentAnchor, { subject: "thread" }> => ({
		subject: "thread",
		thread: "PRRT_1",
		path: "a.txt",
		commit,
		side: "RIGHT",
		line: 1,
		startSide: "RIGHT",
		startLine: 1,
	});
	const ps = (n: number, head: string): PromptPatchset => ({
		number: n,
		head,
		mergeBase: origin.shas[0] as string,
		startedAt: `2026-11-0${n}T00:00:00.000Z`,
	});
	const viewOf = (p: PromptPatchset): AgentView => ({
		target: { patchset: p.number },
		from: { branch: true },
		left: p.mergeBase,
		right: p.head,
	});
	const askThread = (text: string, view?: AgentView, anchor = threadAnchor()) =>
		store.open({
			anchor,
			text,
			by: "human",
			clientId: `t-${text}`,
			...(view ? { view } : {}),
		});
	const has = (cwd: string, oid: string) => {
		try {
			run(cwd, "cat-file", "-e", `${oid}^{commit}`);
			return true;
		} catch {
			return false;
		}
	};

	it("a thread turn runs checkHead and the envelope's current follows the new head while the snapshot stays", async () => {
		const ps1 = ps(1, origin.shas[1] as string);
		patchsets = [ps1];
		const pushed = commitOnOrigin({ "a.txt": "pushed\n" });
		// The fake gh moves the head: checkHead fetches it, current follows.
		onCheckHead = () => {
			fetchIntoCache(pushed);
			currentHead = pushed;
		};
		await askThread("fixed?", viewOf(ps1));
		makeRunner().poke();
		await answered(1);
		expect(checkHeads).toBe(1);
		const [env] = prompts();
		expect(env?.kind).toBe("github_thread_conversation");
		expect(env?.current).toBe(pushed);
		expect(env?.review.head.commit).toBe(origin.shas[1]);
		expect(env?.github).toMatchObject({
			openedOn: origin.shas[1],
			openedOnPatchset: 1,
			resolved: false,
			comments: [{ author: { login: "ann", role: "pr_author" } }],
		});
		expect(env?.patchsets).toEqual([ps1]);
		expect(env?.notice).toBeUndefined();
		// The code it was opened on goes in as the diff block.
		const blocks = acpLog(logPath).find((e) => e.method === "session/prompt")
			?.params as { prompt: Array<{ text?: string }> };
		expect(blocks.prompt.at(-1)?.text).toContain(
			"The code the thread was opened on:\n```diff\n@@ -1 +1 @@",
		);
		// A span thread's turn doesn't check the head.
		await ask("span?");
		runner.poke();
		await answered(2);
		expect(checkHeads).toBe(1);
	});

	it("the checkout is at view.right for the turn and current's objects are reachable", async () => {
		const ps1 = ps(1, origin.shas[1] as string);
		const ps2 = ps(2, pushToPr({ "a.txt": "ps2\n" }));
		prHead = ps2.head;
		patchsets = [ps1, ps2];
		const pushed = commitOnOrigin({ "a.txt": "pushed\n" });
		onCheckHead = () => {
			fetchIntoCache(pushed);
			currentHead = pushed;
		};
		scenario({ hold: ["prompt"] });
		await askThread("fixed?", viewOf(ps1));
		makeRunner().poke();
		await until((s) => s.state === "busy");
		expect(treeHead()).toBe(ps1.head);
		expect(has(tree(), pushed)).toBe(true);
		releaseAcp(scenarioPath, "prompt");
		await answered(1);
		// A span thread's turn moves it back to the PR's head.
		await ask("span?");
		runner.poke();
		await answered(2);
		expect(treeHead()).toBe(ps2.head);
	});

	it("view is the one sent with the turn's last human message; an ai-opened conversation uses the latest patch set (the snapshot head without patch sets)", async () => {
		const ps1 = ps(1, origin.shas[1] as string);
		const ps2 = ps(2, pushToPr({ "a.txt": "ps2\n" }));
		patchsets = [ps1, ps2];
		currentHead = ps2.head;
		const t = await askThread("on PS1?", viewOf(ps1));
		makeRunner().poke();
		await answered(1);
		await store.message(t.id, {
			by: "human",
			text: "and on PS2?",
			clientId: "m2",
			view: viewOf(ps2),
		});
		runner.poke();
		await vi.waitFor(() => expect(prompts()).toHaveLength(2), {
			timeout: 20_000,
			interval: 20,
		});
		await runner.settled();
		const [first, second] = prompts();
		expect(first?.view).toMatchObject({ right: ps1.head, targetPatchset: 1 });
		expect(second?.view).toMatchObject({ right: ps2.head, targetPatchset: 2 });

		// Agent-started: no send carried a view.
		const opened = await store.open({
			anchor: { ...threadAnchor(), thread: "PRRT_2" },
			text: "This thread looks fixed.",
			by: "ai",
			agent: { name: "fake-acp", version: "1.0.0" },
		});
		await store.message(opened.id, {
			by: "human",
			text: "is it?",
			clientId: "m3",
		});
		runner.poke();
		await vi.waitFor(() => expect(prompts()).toHaveLength(3), {
			timeout: 20_000,
			interval: 20,
		});
		expect(prompts()[2]?.view).toEqual({
			target: { patchset: 2 },
			from: { branch: true },
			left: ps2.mergeBase,
			right: ps2.head,
			targetPatchset: 2,
		});
		await runner.settled();

		// No patch sets at all: the snapshot head, against the merge base.
		patchsets = [];
		await store.message(opened.id, {
			by: "human",
			text: "now?",
			clientId: "m4",
		});
		runner.poke();
		await vi.waitFor(() => expect(prompts()).toHaveLength(4), {
			timeout: 20_000,
			interval: 20,
		});
		expect(prompts()[3]?.view).toEqual({
			target: { head: prHead },
			from: { branch: true },
			left: origin.shas[0],
			right: prHead,
		});
	});

	it("the stored head is the checkout's commit when the answer ends", async () => {
		const ps1 = ps(1, origin.shas[1] as string);
		patchsets = [ps1];
		const pushed = commitOnOrigin({ "a.txt": "pushed\n" });
		onCheckHead = () => {
			fetchIntoCache(pushed);
			currentHead = pushed;
		};
		scenario({
			answers: [
				{
					text: "Fixed later, in the newest head.",
					run: ["git", "-C", "tree", "checkout", "--quiet", "--detach", pushed],
				},
			],
		});
		await askThread("fixed?", viewOf(ps1));
		makeRunner().poke();
		await answered(1);
		const [t] = await threads();
		expect(t?.messages[1]).toMatchObject({ by: "ai", head: pushed });
	});

	it("a final [suggest-resolve] is stripped and stored as suggests; one mid-message is not", async () => {
		patchsets = [ps(1, origin.shas[1] as string)];
		scenario({
			answers: [
				{ match: "first", text: "Fixed in PS 1.\n[suggest-resolve]\n" },
				{
					match: "second",
					text: "Not resolved: I would write [suggest-resolve]\n[suggest-resolve]\nonly if it were.",
				},
				{ text: "ok" },
			],
		});
		const t = await askThread("first?");
		makeRunner().poke();
		await answered(1);
		await store.message(t.id, { by: "human", text: "second?", clientId: "m2" });
		runner.poke();
		await vi.waitFor(
			async () => expect((await threads())[0]?.messages).toHaveLength(4),
			{ timeout: 20_000, interval: 20 },
		);
		const messages = (await threads())[0]?.messages ?? [];
		expect(messages[1]).toMatchObject({
			text: "Fixed in PS 1.",
			suggests: "resolve",
		});
		expect(messages[3]?.text).toBe(
			"Not resolved: I would write [suggest-resolve]\n[suggest-resolve]\nonly if it were.",
		);
		expect(messages[3]?.suggests).toBeUndefined();
		// The stripped text is what the next prompt replays.
		expect(prompts()[1]?.messages[1]?.text).toBe("Fixed in PS 1.");
	});

	it("a failed turn's answer ending in the marker is stripped but never suggests", async () => {
		patchsets = [ps(1, origin.shas[1] as string)];
		scenario({
			answers: [
				{
					text: "Looks fixed.\n[suggest-resolve]",
					stop: "error",
					error: "upstream went away",
				},
			],
		});
		await askThread("fixed?");
		makeRunner().poke();
		await answered(1);
		const [t] = await threads();
		expect(t?.messages[1]).toMatchObject({
			by: "ai",
			stop: "error",
			text: "Looks fixed.",
		});
		expect(t?.messages[1]?.suggests).toBeUndefined();
	});

	it("a span thread's answer keeps a final marker as text", async () => {
		scenario({ answers: [{ text: "Sure.\n[suggest-resolve]" }] });
		await ask("span?");
		makeRunner().poke();
		await answered(1);
		const [t] = await threads();
		expect(t?.messages[1]?.text).toBe("Sure.\n[suggest-resolve]");
		expect(t?.messages[1]?.suggests).toBeUndefined();
	});

	it("a question waiting on a resolved GitHub thread is still answered", async () => {
		ghState = "resolved";
		patchsets = [ps(1, origin.shas[1] as string)];
		await askThread("fixed?");
		// A resolved span thread with a waiting question is not.
		const span = await ask("span?");
		await store.setResolved(span.id, true);
		makeRunner().poke();
		await vi.waitFor(() => expect(prompts()).toHaveLength(1), {
			timeout: 20_000,
			interval: 20,
		});
		await runner.settled();
		expect(prompts()).toHaveLength(1);
		expect(prompts()[0]?.github?.resolved).toBe(true);
		const all = await threads();
		expect(all.find((t) => t.anchor.subject === "thread")?.waiting).toBe(false);
		expect(all.find((t) => t.id === span.id)?.waiting).toBe(true);
	});

	it("a commit the clone lacks is named in notice", async () => {
		const lost = "e".repeat(40);
		patchsets = [ps(1, origin.shas[1] as string)];
		const facts = ghThread;
		ghThread = () => ({ ...facts(), openedOn: lost });
		await askThread(
			"fixed?",
			viewOf(patchsets[0] as PromptPatchset),
			threadAnchor(lost),
		);
		makeRunner().poke();
		await answered(1);
		const [env] = prompts();
		expect(env?.notice).toContain(lost);
		expect(env?.notice).not.toContain(origin.shas[1]);
		expect(env?.github?.openedOn).toBe(lost);
	});

	it("GitHub unread: the turn runs without a github block, the notice says so", async () => {
		ghState = "unknown";
		patchsets = [ps(1, origin.shas[1] as string)];
		await askThread("fixed?");
		makeRunner().poke();
		await answered(1);
		const [env] = prompts();
		expect(env?.kind).toBe("github_thread_conversation");
		expect(env?.github).toBeUndefined();
		expect(env?.notice).toMatch(/GitHub couldn't be read/);
		expect(githubReads).toEqual([]);
		// Reading GitHub failing in the turn is the same.
		ghState = "open";
		ghThread = () => {
			throw new Error("gh: 502");
		};
		const [t] = await threads();
		await store.message(t?.id as string, {
			by: "human",
			text: "now?",
			clientId: "m2",
		});
		runner.poke();
		await vi.waitFor(() => expect(prompts()).toHaveLength(2), {
			timeout: 20_000,
			interval: 20,
		});
		expect(prompts()[1]?.github).toBeUndefined();
		expect(prompts()[1]?.notice).toMatch(/GitHub couldn't be read/);
	});

	it("an orphan is a regular agent conversation on its lines; the notice says the GitHub thread is gone", async () => {
		ghState = "gone";
		await askThread("fixed?");
		makeRunner().poke();
		await answered(1);
		const [env] = prompts();
		expect(env?.kind).toBe("agent_thread");
		expect(env?.github).toBeUndefined();
		expect(env?.thread.anchor).toMatchObject({ subject: "line", line: 1 });
		expect(env?.notice).toMatch(/GitHub thread .* is gone/);
		expect(checkHeads).toBe(0);
	});
});
