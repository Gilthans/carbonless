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
const ref = agentThreadsRef("r1", "dan");

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
	store = new AgentThreadStore(refs, "r1", "dan");
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
			"r1",
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
		const fresh = new AgentThreadStore(new RefStore(repo), "r1", "dan");
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

	it("a 40 KiB reply is stored truncated with the flag", async () => {
		const t = await ask("Explain everything", "c1");
		const long = "é".repeat(20 * 1024); // 40 KiB of two-byte letters
		const stored = await answer(t.id, long);
		const reply = stored.messages[1];
		expect(reply?.truncated).toBe(true);
		expect(Buffer.byteLength(reply?.text ?? "")).toBe(MAX_AGENT_TEXT);
		const [read] = await new AgentThreadStore(
			new RefStore(repo),
			"r1",
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
		expect(ref).toBe("refs/crb/reviews/r1/reviewers/dan/agent/threads");
		await expect(refs.tip(ref)).resolves.toBeNull();
		await ask("Why?", "c1");
		expect(git("rev-parse", "--verify", ref)).toMatch(/^[0-9a-f]{40}$/);
		expect(git("check-ref-format", ref)).toBe("");
	});
});
