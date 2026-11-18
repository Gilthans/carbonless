import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, AgentStop } from "../../shared/agent.js";
import { AcpAgent } from "./acp.js";
import type { ReviewClaim } from "./claim.js";
import { JoinBroker } from "./join.js";
import {
	AgentRunner,
	CANCEL_GRACE_MS,
	type RunnerFacts,
	WAKE_LINE,
} from "./runner.js";
import type { AgentThreadStore } from "./store.js";

// No process and no git: a stand-in agent whose turn never ends by
// itself, on fake timers, for the turn's time limit.
vi.mock("./acp.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("./acp.js")>();
	return { ...real, AcpAgent: { spawn: vi.fn() } };
});
vi.mock("./checkout.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("./checkout.js")>();
	return {
		...real,
		createCheckout: vi.fn(async () => ({
			dir: "/nowhere",
			tree: "/nowhere/tree",
			remove: async () => {},
			moveTo: async () => null,
		})),
	};
});

const AGENT: AgentConfig = {
	command: "fake",
	args: [],
	env: {},
	leash: "open",
};
const TURN_MS = 60_000;

/** A stand-in AcpAgent: prompt() hangs until cancelled (if it obeys) or closed. */
function fakeAgent(obeysCancel: boolean) {
	let end: ((r: { text: string; stop: AgentStop }) => void) | null = null;
	const a = {
		info: { name: "fake", version: "1" },
		alive: true,
		prompts: 0,
		prompt: vi.fn(
			() =>
				new Promise<{ text: string; stop: AgentStop }>((r) => {
					a.prompts++;
					end = r;
				}),
		),
		cancel: vi.fn(async () => {
			if (obeysCancel) end?.({ text: "", stop: "cancelled" });
		}),
		close: vi.fn(async () => {
			a.alive = false;
			end?.({ text: "", stop: "error" });
		}),
		exitsWithin: async () => true,
		stderrTail: () => "",
	};
	return a;
}

let dir: string;
let broker: JoinBroker;
let runner: AgentRunner;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	clock = Date.parse("2026-11-14T10:00:00.000Z");
	questions = [];
	dir = mkdtempSync(join(tmpdir(), "crb-runner-turn-"));
	broker = new JoinBroker({
		dir,
		onApproved: async () => {},
		onLeft: () => {},
	});
});
afterEach(async () => {
	vi.useRealTimers();
	await runner?.close();
	broker.close();
	rmSync(dir, { recursive: true, force: true });
});

/** The spawn's secret (its X-Crb-Spawn header), for a stand-in that attaches. */
let secret = "";
/** What the stand-in's store holds: one waiting question, or none. */
let questions: unknown[] = [];
let stored: ReturnType<typeof vi.fn>;
/** The runner's clock (ms), moved with the fake timers by tick(). */
let clock = 0;
const tick = async (ms: number) => {
	clock += ms;
	await vi.advanceTimersByTimeAsync(ms);
};

function start(
	agent: { prompt: unknown },
	config: () => AgentConfig | null = () => AGENT,
) {
	vi.mocked(AcpAgent.spawn).mockImplementation(async (opts) => {
		secret = opts.mcp?.headers[0]?.value ?? "";
		return agent as unknown as AcpAgent;
	});
	stored = vi.fn(async () => {});
	runner = new AgentRunner({
		reviewId: "01k9e6m2q8x4v7c3n5b0h1j2t6",
		config: async () => ({ agent: config(), problems: [] }),
		now: () => clock,
		store: {
			read: async () => questions,
			message: stored,
		} as unknown as AgentThreadStore,
		cacheClone: "/nowhere",
		head: "a".repeat(40),
		port: 4800,
		facts: {
			review: () => ({
				repo: "acme/widget",
				pr: 12,
				url: "https://github.com/acme/widget/pull/12",
				base: { ref: "main", commit: "b".repeat(40) },
				head: { ref: "feature", commit: "a".repeat(40) },
				mergeBase: "b".repeat(40),
			}),
			prFacts: async () => ({ title: "t", body: "", files: [] }),
			join: async (f: unknown) => f,
		} as unknown as RunnerFacts,
		turnMs: TURN_MS,
		claim: {
			hold: async () => ({ ok: true, release: async () => {} }),
			drop: async () => {},
		} as unknown as ReviewClaim,
		join: broker,
		mcp: () => ({ url: "http://127.0.0.1:1/mcp", key: null }),
	});
	runner.poke();
}

const flush = () => vi.advanceTimersByTimeAsync(0);

/** A waiting question, as the store folds it. */
const QUESTION = {
	id: "t1",
	waiting: true,
	resolved: false,
	anchor: { subject: "line" },
	messages: [{ id: "m1", by: "human" }],
};

type End = (r: { text: string; stop: AgentStop }) => void;
/**
 * A stand-in that attaches on its kickoff (with the spawn's secret, as its
 * attach would), then runs `turns` in order: each gets the prompt's text and
 * its end; a cancel ends the turn (cancelled).
 */
function scripted(turns: ((text: string, end: End) => void)[]) {
	let end: End | null = null;
	const texts: string[] = [];
	const a = {
		info: { name: "fake", version: "1" },
		alive: true,
		texts,
		prompt: vi.fn(
			(blocks: { text: string }[]) =>
				new Promise<{ text: string; stop: AgentStop }>((resolve) => {
					const text = blocks[0]?.text ?? "";
					texts.push(text);
					end = resolve;
					const line = text.split("\n").find((l) => l.startsWith('{"review"'));
					if (line) {
						const { request } = JSON.parse(line) as { request: string };
						void broker
							.outcome(request, 0, secret)
							.then(() => resolve({ text: "", stop: "end_turn" }));
						return;
					}
					turns.shift()?.(text, resolve);
				}),
		),
		cancel: vi.fn(async () => {
			end?.({ text: "", stop: "cancelled" });
		}),
		close: vi.fn(async () => {
			a.alive = false;
			end?.({ text: "", stop: "error" });
		}),
		exitsWithin: async () => true,
		stderrTail: () => "",
	};
	return a;
}

describe("every turn has a time limit, whatever it holds", () => {
	it("a kickoff that hangs without calling next: cancelled at turnMs; ignoring that, its process is closed", async () => {
		const agent = fakeAgent(false);
		start(agent);
		await vi.waitFor(async () => {
			await flush();
			expect(agent.prompts).toBe(1);
		});
		expect((await runner.status()).state).toBe("busy");
		await vi.advanceTimersByTimeAsync(TURN_MS - 1);
		expect(agent.cancel).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(agent.cancel).toHaveBeenCalledTimes(1);
		expect(agent.close).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS);
		await vi.waitFor(() => expect(agent.close).toHaveBeenCalled());
		const s = await runner.status();
		expect(s.state).toBe("error");
		expect(s.error).toContain("didn't stop");
		// Not busy for ever: the broker shows no turn.
		expect(broker.inTurn()).toBe(false);
	});

	it("an agent that obeys the cancel: the turn ends at turnMs (no attach: Spawn failed), nothing closes it twice", async () => {
		const agent = fakeAgent(true);
		start(agent);
		await vi.waitFor(async () => {
			await flush();
			expect(agent.prompts).toBe(1);
		});
		await vi.advanceTimersByTimeAsync(TURN_MS);
		await vi.waitFor(async () =>
			expect((await runner.status()).error).toContain("didn't attach"),
		);
		await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS);
		expect((await runner.status()).error).toContain("didn't attach");
		expect(agent.close).toHaveBeenCalledTimes(1);
	});
});

describe("connected", () => {
	it("a config change while a turn runs: the old process stays connected until it stops", async () => {
		const agent = fakeAgent(false);
		let config: AgentConfig = AGENT;
		start(agent, () => config);
		await vi.waitFor(async () => {
			await flush();
			expect(agent.prompts).toBe(1);
		});
		expect(await runner.status()).toMatchObject({
			state: "busy",
			connected: true,
		});
		config = { ...AGENT, args: ["--again"] };
		// The change is read: the turn is cancelled (and ignored), the process
		// still up and answering.
		const changed = await runner.status();
		expect(agent.cancel).toHaveBeenCalled();
		expect(changed.connected).toBe(true);
		await flush();
		expect((await runner.status()).connected).toBe(true);
		// The process stops: no longer connected.
		await agent.close();
		await vi.waitFor(async () => {
			await flush();
			expect((await runner.status()).connected).toBeUndefined();
		});
	});
});

describe("a turn's limit and the wake-up", () => {
	it("a wake turn that hangs and obeys the cancel: an error (red), a dry turn, exactly one wake (R1)", async () => {
		questions = [QUESTION];
		// The wake: it never calls next; the cancel ends it.
		const agent = scripted([() => {}]);
		start(agent);
		await vi.waitFor(async () => {
			await flush();
			expect(agent.texts).toHaveLength(2);
		});
		expect(agent.texts[1]).toBe(WAKE_LINE);
		await tick(TURN_MS);
		await vi.waitFor(async () =>
			expect((await runner.status()).error).toContain("ran past"),
		);
		// Polls don't wake it again: it stays red, quiet.
		for (let i = 0; i < 5; i++) {
			await runner.status();
			await flush();
		}
		await runner.settled();
		expect(agent.texts).toHaveLength(2);
		expect((await runner.status()).state).toBe("error");
	});

	it("a held question keeps its limit across a hold reminder: it fires turnMs after its next, not after the reminder (N8)", async () => {
		let endWake: End = () => {};
		const agent = scripted([
			// The wake: next hands t1 out, then the turn ends without a reply.
			(_t, end) => {
				broker.handOut("t1", "m1");
				runner.handed("t1");
				endWake = end;
			},
			// The reminder: it hangs.
			() => {},
		]);
		start(agent);
		// Attached with nothing waiting; then a question is asked.
		await vi.waitFor(async () => {
			await flush();
			expect(broker.attached()).toBe(true);
		});
		await runner.settled();
		questions = [QUESTION];
		runner.asked();
		await vi.waitFor(async () => {
			await flush();
			expect(agent.texts).toHaveLength(2);
		});
		await tick(40_000);
		endWake({ text: "", stop: "end_turn" });
		await vi.waitFor(async () => {
			await flush();
			expect(agent.texts).toHaveLength(3);
		});
		expect(agent.texts[2]).toContain("You still hold thread t1");
		expect(stored).not.toHaveBeenCalled();
		await tick(TURN_MS - 40_000);
		await vi.waitFor(() =>
			expect(stored).toHaveBeenCalledWith(
				"t1",
				expect.objectContaining({
					stop: "error",
					replyTo: "m1",
					error: expect.stringContaining("took longer"),
				}),
			),
		);
	});
});
