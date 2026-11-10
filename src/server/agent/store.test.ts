import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createBareRepo,
	GIT_TEST_TIMEOUTS,
	testGitEnv,
} from "../../../test/git-fixture.js";
import {
	type AgentActivity,
	type AgentAnchor,
	MAX_ACTIVITY_BYTES,
	MAX_AGENT_TEXT,
} from "../../shared/agent.js";
import { newEvent } from "../review/events.js";
import { RefStore } from "../review/refStore.js";
import {
	AgentThreadStore,
	agentThreadsRef,
	capActivity,
	capText,
	foldAgentThreads,
	UnknownAgentThreadError,
} from "./store.js";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const anchor: AgentAnchor = {
	subject: "line",
	path: "src/lock.ts",
	commit: "a".repeat(40),
	side: "RIGHT",
	line: 12,
	startSide: "RIGHT",
	startLine: 10,
	startCol: null,
	endCol: null,
};
const agent = { name: "fake-acp", version: "1.0.0" };
const REVIEW = "01k9e6m2q8x4v7c3n5b0h1j2t6";
const ref = agentThreadsRef(REVIEW, "dan");

let repo: string;
let cleanup: () => void;
let refs: RefStore;
let store: AgentThreadStore;

const git = (...args: string[]) =>
	execFileSync("git", args, {
		cwd: repo,
		encoding: "utf8",
		env: testGitEnv(),
	}).trim();

beforeEach(() => {
	({ path: repo, cleanup } = createBareRepo());
	refs = new RefStore(repo);
	store = new AgentThreadStore(refs, REVIEW, "dan");
});
afterEach(() => cleanup());

const ask = (text: string, clientId: string) =>
	store.open({ anchor, text, by: "human", clientId });
const answer = (thread: string, text: string, activity: AgentActivity[] = []) =>
	store.message(thread, { by: "ai", text, agent, stop: "end_turn", activity });

describe("AgentThreadStore", () => {
	it("open, message, resolve, unresolve fold in order", async () => {
		const t = await ask("Why a lock here?", "c1");
		expect(t).toMatchObject({
			anchor,
			openedBy: "human",
			resolved: false,
			waiting: true,
			clientId: "c1",
		});
		expect(t.id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
		await answer(t.id, "Two writers race.", [{ kind: "read", title: "Read" }]);
		await store.message(t.id, { by: "human", text: "Both?", clientId: "c2" });
		await answer(t.id, "Yes.");
		const resolved = await store.setResolved(t.id, true);
		expect(resolved.resolved).toBe(true);
		const reopened = await store.setResolved(t.id, false);
		expect(reopened.resolved).toBe(false);

		// A fresh store reads it all back from git.
		const [thread, ...rest] = await new AgentThreadStore(
			new RefStore(repo),
			REVIEW,
			"dan",
		).read();
		expect(rest).toEqual([]);
		expect(thread).toEqual(reopened);
		expect(thread?.messages.map((m) => [m.by, m.text])).toEqual([
			["human", "Why a lock here?"],
			["ai", "Two writers race."],
			["human", "Both?"],
			["ai", "Yes."],
		]);
		expect(thread?.messages[1]).toMatchObject({
			agent,
			stop: "end_turn",
			activity: [{ kind: "read", title: "Read" }],
		});
		const ats = thread?.messages.map((m) => Date.parse(m.at)) ?? [];
		expect([...ats].sort((a, b) => a - b)).toEqual(ats);
		expect(git("log", "--format=%s", ref).split("\n").reverse()).toEqual([
			"crb: agent thread opened",
			"crb: agent message",
			"crb: agent message",
			"crb: agent message",
			"crb: agent thread resolved",
			"crb: agent thread unresolved",
		]);
		// Threads come back in the order they were opened.
		const second = await ask("And this?", "c3");
		expect((await store.read()).map((x) => x.id)).toEqual([t.id, second.id]);
	});

	it("waiting follows the last message's author, an ai-opened thread is not waiting", async () => {
		const t = await ask("Is this safe?", "c1");
		expect(t.waiting).toBe(true);
		expect((await answer(t.id, "Yes.")).waiting).toBe(false);
		const again = await store.message(t.id, {
			by: "human",
			text: "Sure?",
			clientId: "c2",
		});
		expect(again.waiting).toBe(true);

		const flagged = await store.open({
			anchor: { subject: "file", path: "src/lock.ts", commit: "" },
			text: "A lock is taken twice here.",
			by: "ai",
			agent,
		});
		expect(flagged).toMatchObject({ openedBy: "ai", waiting: false });
		expect(flagged.messages[0]).toMatchObject({ by: "ai", agent });
		expect(flagged.clientId).toBeUndefined();
		const reply = await store.message(flagged.id, {
			by: "human",
			text: "Where?",
			clientId: "c3",
		});
		expect(reply.waiting).toBe(true);
	});

	it("a reply sent during a turn still waits after the answer lands (replyTo), also for a fresh store", async () => {
		const t = await ask("Why a lock?", "c1");
		const asked = t.messages[0]?.id as string;
		// The reply lands while the agent answers the first question.
		await store.message(t.id, {
			by: "human",
			text: "And here?",
			clientId: "c2",
		});
		const after = await store.message(t.id, {
			by: "ai",
			text: "Two writers race.",
			agent,
			stop: "end_turn",
			activity: [],
			replyTo: asked,
		});
		expect(after.messages.map((m) => m.text)).toEqual([
			"Why a lock?",
			"And here?",
			"Two writers race.",
		]);
		expect(after.messages[2]?.replyTo).toBe(asked);
		expect(after.waiting).toBe(true);
		const fresh = new AgentThreadStore(new RefStore(repo), REVIEW, "dan");
		expect((await fresh.read())[0]?.waiting).toBe(true);
		// Answered with the reply in the prompt: no longer waiting.
		const reply = after.messages[1]?.id as string;
		const done = await store.message(t.id, {
			by: "ai",
			text: "Here too.",
			agent,
			stop: "end_turn",
			activity: [],
			replyTo: reply,
		});
		expect(done.waiting).toBe(false);
	});

	it("open with a seen clientId returns the same thread (also after a fresh store on the same repo)", async () => {
		const t = await ask("Why?", "c1");
		expect(await ask("Why?", "c1")).toEqual(t);
		const msg = await store.message(t.id, {
			by: "human",
			text: "More?",
			clientId: "c2",
		});
		expect(
			await store.message(t.id, { by: "human", text: "More?", clientId: "c2" }),
		).toEqual(msg);

		// A restarted server: a new store, seeded from the ref.
		const fresh = new AgentThreadStore(new RefStore(repo), REVIEW, "dan");
		expect(
			await fresh.open({ anchor, text: "Why?", by: "human", clientId: "c1" }),
		).toEqual(msg);
		await fresh.message(t.id, { by: "human", text: "More?", clientId: "c2" });
		const threads = await fresh.read();
		expect(threads).toHaveLength(1);
		expect(threads[0]?.messages).toHaveLength(2);

		// Pressed twice at once: still one thread.
		const [a, b] = await Promise.all([ask("Twice", "c9"), ask("Twice", "c9")]);
		expect(a.id).toBe(b.id);
		expect(await store.read()).toHaveLength(2);
	});

	it("a clientId remembered for one thread is new for another", async () => {
		const a = await ask("A?", "a1");
		const b = await ask("B?", "b1");
		await store.message(a.id, { by: "human", text: "more", clientId: "m1" });
		const onB = await store.message(b.id, {
			by: "human",
			text: "more",
			clientId: "m1",
		});
		expect(onB.messages.map((m) => m.text)).toEqual(["B?", "more"]);
		// Also when the store learnt it from the ref, after a restart.
		const fresh = new AgentThreadStore(new RefStore(repo), REVIEW, "dan");
		const c = await fresh.open({
			anchor,
			text: "C?",
			by: "human",
			clientId: "c1",
		});
		const onC = await fresh.message(c.id, {
			by: "human",
			text: "more",
			clientId: "m1",
		});
		expect(onC.messages.map((m) => m.text)).toEqual(["C?", "more"]);
		// The same thread again: still one message.
		expect(
			(await fresh.message(c.id, { by: "human", text: "more", clientId: "m1" }))
				.messages,
		).toHaveLength(2);
	});

	it("refuses a review id that isn't one ref segment", () => {
		for (const bad of [
			"r1/../x",
			"a/b",
			"",
			" ",
			"..",
			"r1",
			"01K9E6M2Q8X4V7C3N5B0H1J2T6",
		]) {
			expect(() => new AgentThreadStore(refs, bad, "dan")).toThrow(/review id/);
		}
		expect(() => new AgentThreadStore(refs, REVIEW, "dan")).not.toThrow();
	});

	it("a 40 KiB reply is stored truncated with the flag", async () => {
		const t = await ask("Explain everything", "c1");
		const long = "é".repeat(20 * 1024); // 40 KiB of two-byte letters
		const stored = await answer(t.id, long);
		const reply = stored.messages[1];
		expect(reply?.truncated).toBe(true);
		expect(Buffer.byteLength(reply?.text ?? "")).toBe(MAX_AGENT_TEXT);
		const [read] = await new AgentThreadStore(
			new RefStore(repo),
			REVIEW,
			"dan",
		).read();
		expect(read?.messages[1]).toEqual(reply);
		// A short reply is not flagged.
		expect((await answer(t.id, "ok")).messages[2]?.truncated).toBeUndefined();

		// Cut on a code point: never half a letter.
		const emoji = `${"x".repeat(MAX_AGENT_TEXT - 2)}😀`;
		expect(capText(emoji)).toEqual({
			text: "x".repeat(MAX_AGENT_TEXT - 2),
			truncated: true,
		});
		const fits = "x".repeat(MAX_AGENT_TEXT);
		expect(capText(fits)).toEqual({ text: fits, truncated: false });
	});

	it("activity is capped at 50 entries and 4 KiB", async () => {
		const many = Array.from(
			{ length: 60 },
			(_, i): AgentActivity => ({ kind: "read", title: `f${i}` }),
		);
		expect(capActivity(many)).toEqual(many.slice(0, 50));
		const wide = Array.from(
			{ length: 50 },
			(_, i): AgentActivity => ({
				kind: "execute",
				title: `${i}`.padEnd(200, "x"),
			}),
		);
		const capped = capActivity(wide);
		expect(capped).toEqual(wide.slice(0, capped.length));
		expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(
			MAX_ACTIVITY_BYTES,
		);
		expect(
			Buffer.byteLength(JSON.stringify(wide.slice(0, capped.length + 1))),
		).toBeGreaterThan(MAX_ACTIVITY_BYTES);

		const t = await ask("Look around", "c1");
		const stored = await answer(t.id, "Done.", [...many, ...wide]);
		expect(stored.messages[1]?.activity).toEqual(many.slice(0, 50));
	});

	it("a failed reply keeps the agent's reason, capped; a good one carries none", async () => {
		const t = await store.open({
			anchor,
			text: "q",
			by: "human",
			clientId: "c",
		});
		const ai = {
			by: "ai" as const,
			text: "",
			agent: { name: "fake-acp", version: "1" },
			activity: [],
		};
		await store.message(t.id, {
			...ai,
			stop: "error",
			error: "x".repeat(2000),
		});
		await store.message(t.id, { ...ai, stop: "end_turn", error: "ignored" });
		const [, failed, fine] = (await store.read())[0]?.messages ?? [];
		expect(failed?.error).toBe("x".repeat(1000));
		expect(fine?.error).toBeUndefined();
	});

	it("a joined session's reply keeps agent.via and machine through a fresh store's fold", async () => {
		const t = await ask("Why?", "c1");
		const joined = {
			name: "carbonless · main",
			version: "claude-code 2.1",
			via: "mcp" as const,
			machine: "devbox",
		};
		await store.message(t.id, {
			by: "ai",
			text: "Because.",
			agent: joined,
			stop: "end_turn",
			activity: [],
		});
		const [folded] = await new AgentThreadStore(refs, REVIEW, "dan").read();
		expect(folded?.messages[1]?.agent).toEqual(joined);
	});

	it("a bad via or machine is dropped, the message kept", async () => {
		const t = await ask("Why?", "c1");
		await store.message(t.id, {
			by: "ai",
			text: "Because.",
			agent: { ...agent, via: "carrier-pigeon", machine: 7 } as never,
			stop: "end_turn",
			activity: [],
		});
		const [folded] = await store.read();
		expect(folded?.messages[1]?.agent).toEqual(agent);
	});

	it("a machine read back from the ref is one line, capped at 80", async () => {
		const t = await ask("Why?", "c1");
		await store.message(t.id, {
			by: "ai",
			text: "Because.",
			agent: { ...agent, via: "mcp", machine: `dev\nbox${"x".repeat(200)}` },
			stop: "end_turn",
			activity: [],
		});
		const [folded] = await store.read();
		const machine = folded?.messages[1]?.agent?.machine ?? "";
		expect(machine.startsWith("dev box")).toBe(true);
		expect(Array.from(machine)).toHaveLength(80);
	});

	it("events of unknown thread ids are dropped by the fold", async () => {
		const t = await ask("Why?", "c1");
		const ghost = "0".repeat(26);
		await refs.appendEvents(
			ref,
			"crb: stray",
			[
				newEvent("agent-message", "dan", { thread: ghost, text: "hi" }, "ai"),
				newEvent("agent-thread-resolved", "dan", {
					thread: ghost,
					resolved: true,
				}),
			],
			"dan",
		);
		expect(await store.read()).toEqual([t]);
		await expect(
			store.message(ghost, { by: "human", text: "?", clientId: "c2" }),
		).rejects.toBeInstanceOf(UnknownAgentThreadError);
		await expect(store.setResolved(ghost, true)).rejects.toBeInstanceOf(
			UnknownAgentThreadError,
		);
		// The fold also deduplicates events by id.
		const events = await refs.readEvents(ref);
		expect(foldAgentThreads([...events, ...events])).toEqual([t]);
	});

	it("stamps after the ref's newest event, whatever the clock says", async () => {
		const t = await ask("Why?", "c1");
		const future = Date.now() + 3_600_000;
		await refs.appendEvent(
			ref,
			"crb: agent message",
			newEvent(
				"agent-message",
				"dan",
				{ thread: t.id, text: "later", agent },
				"ai",
				future,
			),
			"dan",
		);
		const next = await store.message(t.id, {
			by: "human",
			text: "after",
			clientId: "c2",
		});
		expect(next.messages.map((m) => m.text)).toEqual([
			"Why?",
			"later",
			"after",
		]);
		expect(Date.parse(next.messages[2]?.at ?? "")).toBeGreaterThan(future);
	});

	it("the ref name passes RefStore's checkRef", async () => {
		expect(ref).toBe(`refs/crb/reviews/${REVIEW}/reviewers/dan/agent/threads`);
		await expect(refs.tip(ref)).resolves.toBeNull();
		await ask("Why?", "c1");
		expect(git("rev-parse", "--verify", ref)).toMatch(/^[0-9a-f]{40}$/);
		expect(git("check-ref-format", ref)).toBe("");
	});
});
