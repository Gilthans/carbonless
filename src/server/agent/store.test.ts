import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createBareRepo,
	GIT_TEST_TIMEOUTS,
	testGitEnv,
} from "../../../test/git-fixture.js";
import {
	type AgentActivity,
	type AgentAnchor,
	agentCommentClientId,
	MAX_ACTIVITY_BYTES,
	MAX_AGENT_TEXT,
	startedBy,
} from "../../shared/agent.js";
import { foldMoves } from "../../shared/rereview/moves.js";
import { TRACER_VERSION } from "../../shared/tracer/trace.js";
import { type CrbEvent, newEvent } from "../review/events.js";
import { RefStore } from "../review/refStore.js";
import {
	AgentLinkError,
	AgentThreadStore,
	agentThreadsRef,
	capActivity,
	capText,
	foldAgentThreads,
	UnknownAgentMessageError,
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

describe("GitHub thread conversations", () => {
	const gh = (thread: string): AgentAnchor => ({
		subject: "thread",
		thread,
		path: "src/lock.ts",
		commit: "a".repeat(40),
		side: "RIGHT",
		line: 12,
		startSide: "RIGHT",
		startLine: 10,
	});
	const askOn = (thread: string, text: string, clientId: string) =>
		store.open({ anchor: gh(thread), text, by: "human", clientId });
	const view = {
		target: { patchset: 2 },
		from: { branch: true as const },
		left: "b".repeat(40),
		right: "c".repeat(40),
	};

	it("two openings of one GitHub thread fold into one", async () => {
		const first = await askOn("PRRT_1", "Why a lock?", "c1");
		await answer(first.id, "Two writers.");
		const second = await askOn("PRRT_1", "And the retry?", "c2");
		// Joined: the first's id, every message in (ts, id) order.
		expect(second.id).toBe(first.id);
		await store.message(second.id, {
			by: "human",
			text: "Also this",
			clientId: "c3",
		});
		const all = await store.read();
		expect(all).toHaveLength(1);
		expect(all[0]?.id).toBe(first.id);
		expect(all[0]?.messages.map((m) => m.text)).toEqual([
			"Why a lock?",
			"Two writers.",
			"And the retry?",
			"Also this",
		]);
		// A different GitHub thread is its own conversation.
		const other = await askOn("PRRT_2", "Elsewhere?", "c4");
		expect(other.id).not.toBe(first.id);
		expect(await store.read()).toHaveLength(2);
		// A message written under the second opening's own id joins too.
		const raw = (await refs.readEvents(ref)).filter(
			(e) => e.type === "agent-thread-opened",
		);
		const secondId =
			raw[1]?.type === "agent-thread-opened" ? raw[1].thread : "";
		expect(secondId).not.toBe(first.id);
		const viaAlias = await store.message(secondId, {
			by: "human",
			text: "via alias",
			clientId: "c5",
		});
		expect(viaAlias.id).toBe(first.id);
		expect(viaAlias.messages.at(-1)?.text).toBe("via alias");
		// A resent clientId of the joined opening returns the joined thread.
		expect((await askOn("PRRT_1", "And the retry?", "c2")).id).toBe(first.id);
	});

	it("unread: an ai message after the last seen upTo", async () => {
		const t = await ask("Why?", "c1");
		expect(t.unread).toBe(false);
		const a1 = await answer(t.id, "Because.");
		expect(a1.unread).toBe(true);
		const answered = a1.messages[1]?.id as string;
		const seen = await store.seen(t.id, answered);
		expect(seen).toMatchObject({ unread: false, seenUpTo: answered });
		const a2 = await answer(t.id, "Also.");
		expect(a2.unread).toBe(true);
		expect(a2.seenUpTo).toBe(answered);
		// A fresh store folds the same.
		const fresh = await new AgentThreadStore(
			new RefStore(repo),
			REVIEW,
			"dan",
		).read();
		expect(fresh[0]).toMatchObject({ unread: true, seenUpTo: answered });
	});

	it("an ai-opened thread is unread until seen", async () => {
		const t = await store.open({
			anchor: { subject: "file", path: "src/lock.ts", commit: "" },
			text: "A lock is taken twice.",
			by: "ai",
			agent,
		});
		expect(t.unread).toBe(true);
		const seen = await store.seen(t.id, t.messages[0]?.id as string);
		expect(seen.unread).toBe(false);
	});

	it("a seen upTo naming an earlier message than a previous seen does not move it back", async () => {
		const t = await ask("Why?", "c1");
		await answer(t.id, "One.");
		const last = await answer(t.id, "Two.");
		const [, one, two] = last.messages.map((m) => m.id) as string[];
		await store.seen(t.id, two as string);
		// Written by hand: a stale client's older mark, later in the ref.
		await refs.appendEvent(
			ref,
			"seen",
			newEvent("agent-thread-seen", "dan", {
				thread: t.id,
				upTo: one as string,
			}),
			"dan",
		);
		const read = (await store.read())[0];
		expect(read).toMatchObject({ seenUpTo: two, unread: false });
	});

	it("seen writes nothing when already seen up to there", async () => {
		const t = await ask("Why?", "c1");
		const a = await answer(t.id, "Because.");
		const [q, ans] = a.messages.map((m) => m.id) as string[];
		await store.seen(t.id, ans as string);
		const count = () => Number(git("rev-list", "--count", ref));
		const before = count();
		await store.seen(t.id, ans as string);
		await store.seen(t.id, q as string);
		expect(count()).toBe(before);
		await expect(store.seen(t.id, "x".repeat(26))).rejects.toThrow();
		await expect(store.seen("nope", ans as string)).rejects.toBeInstanceOf(
			UnknownAgentThreadError,
		);
	});

	it("view, head, suggests and origin round trip", async () => {
		const t = await store.open({
			anchor: gh("PRRT_9"),
			text: "Why?",
			by: "human",
			clientId: "c1",
			view,
		});
		expect(t.messages[0]?.view).toEqual(view);
		const m = await store.message(t.id, {
			by: "human",
			text: "More",
			clientId: "c2",
			view: { ...view, target: { head: "d".repeat(40) } },
		});
		expect(m.messages[1]?.view?.target).toEqual({ head: "d".repeat(40) });
		const reply = await store.message(t.id, {
			by: "ai",
			text: "Fine.",
			agent,
			stop: "end_turn",
			activity: [],
			head: "e".repeat(40),
			suggests: "resolve",
		});
		expect(reply.messages[2]).toMatchObject({
			head: "e".repeat(40),
			suggests: "resolve",
		});
		const flagged = await store.open({
			anchor: { subject: "file", path: "src/lock.ts", commit: "" },
			text: "Locks twice.",
			by: "ai",
			agent,
			origin: { thread: t.id, message: t.messages[0]?.id as string },
		});
		expect(flagged.messages[0]?.origin).toEqual({
			thread: t.id,
			message: t.messages[0]?.id,
		});
		const fresh = await new AgentThreadStore(
			new RefStore(repo),
			REVIEW,
			"dan",
		).read();
		expect(fresh[0]?.messages[0]?.view).toEqual(view);
		expect(fresh[0]?.messages[2]).toMatchObject({ suggests: "resolve" });
		expect(fresh[1]?.messages[0]?.origin).toEqual({
			thread: t.id,
			message: t.messages[0]?.id,
		});
		expect(fresh[0]?.messages[0]?.origin).toBeUndefined();
	});

	it("agent-thread-resolved still folds for a thread anchor", async () => {
		const t = await askOn("PRRT_1", "Why?", "c1");
		expect((await store.setResolved(t.id, true)).resolved).toBe(true);
		expect((await store.setResolved(t.id, false)).resolved).toBe(false);
	});
});

describe("linking a conversation to a new GitHub thread (agent-thread-linked)", () => {
	const gh = (thread: string): AgentAnchor => ({
		subject: "thread",
		thread,
		path: "src/lock.ts",
		commit: "a".repeat(40),
		side: "RIGHT",
		line: 12,
		startSide: "RIGHT",
		startLine: 10,
	});
	const forge = (events: CrbEvent[]) =>
		refs.appendEvents(ref, "crb: forged", events, "dan");

	it("a linked line conversation becomes that GitHub thread's, history and id kept, across a fresh store", async () => {
		const t = await ask("Why a lock?", "c1");
		await answer(t.id, "Two writers.");
		const linked = await store.link(t.id, "PRRT_new");
		expect(linked.id).toBe(t.id);
		// The span GitHub was given, without columns (a thread anchor has none).
		expect(linked.anchor).toEqual(gh("PRRT_new"));
		expect(linked.messages.map((m) => m.text)).toEqual([
			"Why a lock?",
			"Two writers.",
		]);
		const fresh = new AgentThreadStore(new RefStore(repo), REVIEW, "dan");
		expect(await fresh.read()).toEqual([linked]);
		// One small commit, readable with plain git.
		expect(git("log", "-1", "--format=%s", ref)).toBe(
			"crb: agent thread linked to a GitHub thread",
		);
		expect(
			Buffer.byteLength(git("log", "-1", "--format=%B", ref)),
		).toBeLessThan(300);
	});

	it("a file conversation links with a file-wide thread anchor", async () => {
		const t = await store.open({
			anchor: { subject: "file", path: "README.md", commit: "b".repeat(40) },
			text: "Is this current?",
			by: "human",
			clientId: "c1",
		});
		const linked = await store.link(t.id, "PRRT_file");
		expect(linked.anchor).toEqual({
			subject: "thread",
			thread: "PRRT_file",
			path: "README.md",
			commit: "b".repeat(40),
		});
	});

	it("a later question on that GitHub thread joins the linked conversation", async () => {
		const t = await ask("Why a lock?", "c1");
		await store.link(t.id, "PRRT_new");
		const asked = await store.open({
			anchor: gh("PRRT_new"),
			text: "And now?",
			by: "human",
			clientId: "c2",
		});
		expect(asked.id).toBe(t.id);
		expect((await store.read()).map((x) => x.messages.length)).toEqual([2]);
	});

	it("linking again to the same GitHub thread writes nothing; to another, or onto a thread with a conversation, is refused", async () => {
		const t = await ask("Why?", "c1");
		await store.link(t.id, "PRRT_new");
		const count = () => Number(git("rev-list", "--count", ref));
		const before = count();
		expect((await store.link(t.id, "PRRT_new")).id).toBe(t.id);
		expect(count()).toBe(before);
		await expect(store.link(t.id, "PRRT_other")).rejects.toBeInstanceOf(
			AgentLinkError,
		);
		expect(count()).toBe(before);
		const other = await ask("Elsewhere?", "c2");
		const asked = count();
		await expect(store.link(other.id, "PRRT_new")).rejects.toBeInstanceOf(
			AgentLinkError,
		);
		await expect(store.link("0".repeat(26), "PRRT_x")).rejects.toBeInstanceOf(
			UnknownAgentThreadError,
		);
		expect(count()).toBe(asked);
	});

	it("the fold drops a forged ai link, a link of a thread never opened, a second link, and a link onto a thread with a conversation", async () => {
		const t = await ask("Why?", "c1");
		const onGithub = await store.open({
			anchor: gh("PRRT_taken"),
			text: "Here?",
			by: "human",
			clientId: "c2",
		});
		const u = await ask("Other?", "c3");
		// by: ai is never a link; written raw, as validateForWrite refuses it.
		const aiLink = {
			...newEvent("agent-thread-linked", "dan", {
				thread: t.id,
				github: "PRRT_ai",
			}),
			by: "ai",
		};
		const tree = execFileSync("git", ["mktree"], {
			cwd: repo,
			input: "",
			encoding: "utf8",
			env: testGitEnv(),
		}).trim();
		const commit = execFileSync(
			"git",
			["commit-tree", tree, "-p", git("rev-parse", ref)],
			{
				cwd: repo,
				input: `crb: forged\n\n${JSON.stringify(aiLink)}\n`,
				encoding: "utf8",
				env: {
					...testGitEnv(),
					GIT_AUTHOR_NAME: "dan",
					GIT_AUTHOR_EMAIL: "dan@crb",
					GIT_COMMITTER_NAME: "dan",
					GIT_COMMITTER_EMAIL: "dan@crb",
				},
			},
		).trim();
		git("update-ref", ref, commit);
		expect((await store.read()).find((x) => x.id === t.id)?.anchor).toEqual(
			anchor,
		);
		await forge([
			newEvent("agent-thread-linked", "dan", {
				thread: "0".repeat(26),
				github: "PRRT_ghost",
			}),
			newEvent("agent-thread-linked", "dan", {
				thread: u.id,
				github: "PRRT_taken",
			}),
		]);
		let all = await store.read();
		expect(all.find((x) => x.id === t.id)?.anchor).toEqual(anchor);
		expect(all.find((x) => x.id === u.id)?.anchor).toEqual(anchor);
		expect(all.find((x) => x.id === onGithub.id)?.messages).toHaveLength(1);
		// First link wins; a second one on the same conversation is dropped.
		await forge([
			newEvent("agent-thread-linked", "dan", {
				thread: t.id,
				github: "PRRT_1",
			}),
		]);
		await forge([
			newEvent("agent-thread-linked", "dan", {
				thread: t.id,
				github: "PRRT_2",
			}),
		]);
		all = await store.read();
		const linked = all.find((x) => x.id === t.id);
		expect(linked?.anchor.subject === "thread" && linked.anchor.thread).toBe(
			"PRRT_1",
		);
		// Nothing is lost: every conversation is still listed.
		expect(all).toHaveLength(3);
	});
});

describe("origins: an agent message from a request", () => {
	const fileAnchor: AgentAnchor = {
		subject: "file",
		path: "src/lock.ts",
		commit: "a".repeat(40),
	};
	const request = async () => {
		const t = await ask("Show me every lock", "r1");
		return { thread: t.id, message: t.messages[0]?.id as string };
	};
	const openFrom = (
		origin: { thread: string; message: string },
		text = "This is such a case.",
		key?: string,
	) =>
		store.open({
			anchor: fileAnchor,
			text,
			by: "ai",
			agent,
			origin,
			...(key !== undefined ? { key } : {}),
		});

	it("an origin message doesn't answer a waiting question", async () => {
		const origin = await request();
		const q = await ask("Is this safe?", "q1");
		expect(q.waiting).toBe(true);
		const after = await store.message(q.id, {
			by: "ai",
			text: "This is such a case.",
			agent,
			origin,
		});
		expect(after.messages[1]?.origin).toEqual(origin);
		expect(after.waiting).toBe(true);
		// The request itself still waits until the agent replies there.
		const [req] = await store.read();
		expect(req?.waiting).toBe(true);
		// After a real answer, the origin message after it doesn't make it wait again.
		const answered = await answer(q.id, "Yes.");
		expect(answered.waiting).toBe(false);
		const again = await store.message(q.id, {
			by: "ai",
			text: "And here.",
			agent,
			origin,
		});
		expect(again.waiting).toBe(false);
	});

	it("an ai-opened thread waits only after the reviewer replies", async () => {
		const origin = await request();
		const t = await openFrom(origin);
		expect(t).toMatchObject({ openedBy: "ai", waiting: false });
		const replied = await store.message(t.id, {
			by: "human",
			text: "Why?",
			clientId: "h1",
		});
		expect(replied.waiting).toBe(true);
		expect((await answer(t.id, "Because.")).waiting).toBe(false);
	});

	it("an origin naming a missing thread or a non-human message is dropped on read", async () => {
		const origin = await request();
		const ans = await answer(origin.thread, "An answer.");
		const aiMessage = ans.messages[1]?.id as string;
		const missing = "01k9e6m2q8x4v7c3n5b0h1j2zz";
		const a = await openFrom({ thread: missing, message: origin.message });
		const b = await openFrom({ thread: origin.thread, message: aiMessage });
		const c = await openFrom({ thread: origin.thread, message: missing });
		const good = await openFrom(origin);
		const threads = await store.read();
		const byId = new Map(threads.map((t) => [t.id, t]));
		expect(byId.get(a.id)?.messages[0]?.origin).toBeUndefined();
		expect(byId.get(b.id)?.messages[0]?.origin).toBeUndefined();
		expect(byId.get(c.id)?.messages[0]?.origin).toBeUndefined();
		expect(byId.get(good.id)?.messages[0]?.origin).toEqual(origin);
	});

	it("an origin dropped on read still answers nothing: a waiting question stays waiting (fail safe)", async () => {
		const q = await ask("Is this safe?", "q1");
		const missing = "01k9e6m2q8x4v7c3n5b0h1j2zz";
		const after = await store.message(q.id, {
			by: "ai",
			text: "Such a case.",
			agent,
			origin: { thread: missing, message: missing },
		});
		expect(after.messages[1]?.origin).toBeUndefined();
		expect(after.waiting).toBe(true);
		const fresh = new AgentThreadStore(new RefStore(repo), REVIEW, "dan");
		expect((await fresh.read())[0]?.waiting).toBe(true);
	});

	it("startedBy groups by request message, once per thread", async () => {
		const first = await request();
		const second = await ask("And the queues?", "r2");
		const other = {
			thread: second.id,
			message: second.messages[0]?.id as string,
		};
		const a = await openFrom(first, "a");
		const b = await openFrom(other, "b");
		const c = await openFrom(first, "c");
		// A second origin message on a, from the same request: a counts once.
		await store.message(a.id, {
			by: "ai",
			text: "And again.",
			agent,
			origin: first,
		});
		const started = startedBy(await store.read());
		expect(started.get(first.message)).toEqual([a.id, c.id]);
		expect(started.get(other.message)).toEqual([b.id]);
		expect(started.size).toBe(2);
	});

	it("an ai opening with a repeated key returns the same thread", async () => {
		const origin = await request();
		const t = await openFrom(origin, "Here.", "k1");
		expect(await openFrom(origin, "Here.", "k1")).toEqual(t);
		const [x, y] = await Promise.all([
			openFrom(origin, "Twice.", "k2"),
			openFrom(origin, "Twice.", "k2"),
		]);
		expect(x.id).toBe(y.id);
		// A restarted server: the key is read back from the ref.
		const fresh = new AgentThreadStore(new RefStore(repo), REVIEW, "dan");
		const again = await fresh.open({
			anchor: fileAnchor,
			text: "Here.",
			by: "ai",
			agent,
			origin,
			key: "k1",
		});
		expect(again.id).toBe(t.id);
		const threads = await store.read();
		expect(threads).toHaveLength(3);
		expect(threads.find((th) => th.id === t.id)?.messages).toHaveLength(1);
		// A human clientId equal to an ai key is a different thing.
		const human = await ask("Mine", "k1");
		expect(human.id).not.toBe(t.id);
	});

	it("a keyed opening folded into the reviewer's conversation on that GitHub thread is not 'opened' on a retry (CAR-80 F)", async () => {
		const origin = await request();
		const ghAnchor: AgentAnchor = {
			subject: "thread",
			thread: "PRRT_9",
			path: "src/lock.ts",
			commit: "a".repeat(40),
		};
		const theirs = await store.open({
			anchor: ghAnchor,
			text: "Fixed?",
			by: "human",
			clientId: "h9",
		});
		const mine = await store.open({
			anchor: ghAnchor,
			text: "Such a case.",
			by: "ai",
			agent,
			origin,
			key: "k9",
		});
		expect(mine.id).toBe(theirs.id);
		expect(await store.keyed(origin, "k9")).toEqual({
			thread: theirs.id,
			opened: false,
		});
		// Its own opening (nothing to fold into) stays "opened".
		await store.open({
			anchor: fileAnchor,
			text: "Here.",
			by: "ai",
			agent,
			origin,
			key: "k10",
		});
		expect((await store.keyed(origin, "k10"))?.opened).toBe(true);
	});

	it("an origin message with a repeated key on a thread is written once", async () => {
		const origin = await request();
		const q = await ask("Is this safe?", "q1");
		const send = () =>
			store.message(q.id, {
				by: "ai",
				text: "Such a case.",
				agent,
				origin,
				key: "m1",
			});
		await send();
		await send();
		const fresh = new AgentThreadStore(new RefStore(repo), REVIEW, "dan");
		await fresh.message(q.id, {
			by: "ai",
			text: "Such a case.",
			agent,
			origin,
			key: "m1",
		});
		const found = (await store.read()).find((t) => t.id === q.id);
		expect(found?.messages).toHaveLength(2);
	});
});

describe("agent-comment-posted (CAR-83)", () => {
	const github = (n: number) => ({
		thread: "PRRT_1",
		comment: `PRRC_${n}`,
		url: `https://github.com/o/r/pull/1#discussion_r${n}`,
	});

	it("the client id is ag.<thread>.<message>.<block>", () => {
		const id = agentCommentClientId(
			"01k9e6m2q8x4v7c3n5b0h1j2t6",
			"01k9e6m2q8x4v7c3n5b0h1j2t7",
			2,
		);
		expect(id).toBe(
			"ag.01k9e6m2q8x4v7c3n5b0h1j2t6.01k9e6m2q8x4v7c3n5b0h1j2t7.2",
		);
		// It fits the comment marker's id (server/marker.ts).
		expect(id).toMatch(/^[A-Za-z0-9_.:-]{1,100}$/);
	});

	it("folds onto its ai message as posted, by block; a fresh store folds the same", async () => {
		const t = await ask("Why?", "c1");
		const a = await answer(t.id, "Ask:\n```comment\nWhy one?\n```");
		const message = a.messages[1]?.id as string;
		const after = await store.posted(t.id, {
			message,
			block: 1,
			github: github(11),
			text: "Why two?",
		});
		expect(after.messages[1]?.posted).toEqual([
			{
				block: 1,
				url: github(11).url,
				at: expect.any(String),
				text: "Why two?",
			},
		]);
		await store.posted(t.id, {
			message,
			block: 0,
			github: github(10),
			text: "Why one?",
		});
		const fresh = await new AgentThreadStore(
			new RefStore(repo),
			REVIEW,
			"dan",
		).read();
		expect(fresh[0]?.messages[1]?.posted?.map((p) => p.block)).toEqual([0, 1]);
		// Never on the human message.
		expect(fresh[0]?.messages[0]?.posted).toBeUndefined();
	});

	it("a block posted already writes nothing again; the first stays", async () => {
		const t = await ask("Why?", "c1");
		const a = await answer(t.id, "```comment\nx\n```");
		const message = a.messages[1]?.id as string;
		await store.posted(t.id, {
			message,
			block: 0,
			github: github(1),
			text: "x",
		});
		const count = () => Number(git("rev-list", "--count", ref));
		const before = count();
		const again = await store.posted(t.id, {
			message,
			block: 0,
			github: github(2),
			text: "y",
		});
		expect(count()).toBe(before);
		expect(again.messages[1]?.posted).toEqual([
			expect.objectContaining({ url: github(1).url, text: "x" }),
		]);
	});

	it("refuses an unknown message or a human one; the fold ignores them and ai-written ones", async () => {
		const t = await ask("Why?", "c1");
		const a = await answer(t.id, "```comment\nx\n```");
		const human = a.messages[0]?.id as string;
		const ai = a.messages[1]?.id as string;
		await expect(
			store.posted(t.id, {
				message: "x".repeat(26),
				block: 0,
				github: github(1),
				text: "x",
			}),
		).rejects.toBeInstanceOf(UnknownAgentMessageError);
		await expect(
			store.posted(t.id, {
				message: human,
				block: 0,
				github: github(1),
				text: "x",
			}),
		).rejects.toBeInstanceOf(UnknownAgentMessageError);
		// Written by hand: an unknown message, a human one, and one the agent wrote.
		const event = (message: string) =>
			newEvent("agent-comment-posted", "dan", {
				thread: t.id,
				message,
				block: 0,
				clientId: agentCommentClientId(t.id, message, 0),
				github: github(1),
				text: "x",
			});
		await refs.appendEvent(ref, "p", event("0".repeat(26)), "dan");
		await refs.appendEvent(ref, "p", event(human), "dan");
		const raw = { ...event(ai), by: "ai" };
		// validateForWrite refuses it, so it goes in as a raw commit message.
		await expect(
			refs.appendEvent(ref, "p", raw as never, "dan"),
		).rejects.toThrow();
		const read = (await store.read())[0];
		expect(read?.messages.every((m) => m.posted === undefined)).toBe(true);
	});
});

describe("the review conversation", () => {
	const review: AgentAnchor = { subject: "review" };
	const t1 = "01k9e6m2q8x4v7c3n5b0h1j2a1";
	const t2 = "01k9e6m2q8x4v7c3n5b0h1j2a2";
	const opening = (thread: string, text: string, ts: number) =>
		newEvent(
			"agent-thread-opened",
			"dan",
			{ thread, anchor: review, text, details: { clientId: thread } },
			"human",
			ts,
		);

	it("two review openings fold into the first", () => {
		const events = [
			opening(t2, "second", 2000),
			newEvent(
				"agent-message",
				"dan",
				{ thread: t2, text: "more" },
				"human",
				3000,
			),
			opening(t1, "first", 1000),
		];
		const folded = foldAgentThreads(events);
		expect(folded).toHaveLength(1);
		expect(folded[0]?.id).toBe(t1);
		expect(folded[0]?.anchor).toEqual(review);
		expect(folded[0]?.messages.map((m) => m.text)).toEqual([
			"first",
			"second",
			"more",
		]);
	});

	it("a resolve on a review thread is ignored on read", () => {
		const events = [
			opening(t1, "q", 1000),
			newEvent(
				"agent-message",
				"dan",
				{ thread: t1, text: "a", agent, stop: "end_turn", activity: [] },
				"ai",
				2000,
			),
			newEvent(
				"agent-thread-resolved",
				"dan",
				{ thread: t1, resolved: true },
				"human",
				3000,
			),
		];
		const resolved = foldAgentThreads(events);
		expect(resolved[0]?.resolved).toBe(false);
		expect(resolved[0]?.waiting).toBe(false);
		const later = foldAgentThreads([
			...events,
			newEvent(
				"agent-message",
				"dan",
				{ thread: t1, text: "again" },
				"human",
				4000,
			),
		]);
		expect(later[0]).toMatchObject({ resolved: false, waiting: true });
	});

	it("store.open refuses a second review opening and an ai one, resend returns the first", async () => {
		const first = await store.open({
			anchor: review,
			text: "q",
			by: "human",
			clientId: "c1",
		});
		await expect(
			store.open({ anchor: review, text: "q2", by: "human", clientId: "c2" }),
		).rejects.toMatchObject({ thread: first.id });
		expect(
			(
				await store.open({
					anchor: review,
					text: "q",
					by: "human",
					clientId: "c1",
				})
			).id,
		).toBe(first.id);
		await expect(
			store.open({ anchor: review, text: "hi", by: "ai", agent }),
		).rejects.toBeInstanceOf(Error);
		expect(await store.read()).toHaveLength(1);
	});

	it("two review openings at once: one written, the other refused naming it", async () => {
		const [a, b] = await Promise.allSettled([
			store.open({ anchor: review, text: "q1", by: "human", clientId: "c1" }),
			store.open({ anchor: review, text: "q2", by: "human", clientId: "c2" }),
		]);
		const won = [a, b].filter((x) => x.status === "fulfilled");
		const lost = [a, b].filter((x) => x.status === "rejected");
		expect(won).toHaveLength(1);
		expect(lost).toHaveLength(1);
		const id = (won[0] as PromiseFulfilledResult<{ id: string }>).value.id;
		expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
			thread: id,
		});
		const all = await store.read();
		expect(all).toHaveLength(1);
		expect(all[0]?.id).toBe(id);
		expect(all[0]?.messages).toHaveLength(1);
	});
});

describe("thread moves in the agent threads ref (CAR-139)", () => {
	const on = { base: "b".repeat(40), head: "c".repeat(40), patchset: 2 };
	const to = (line: number) => ({
		path: "src/lock.ts",
		startSide: "RIGHT" as const,
		startLine: line,
		side: "RIGHT" as const,
		line,
	});
	const gh = { source: "github" as const, id: "PRRT_kwDOabc" };

	it("writes a thread-moved and a thread-move-undone by the reviewer; reading them back writes nothing", async () => {
		const t = await ask("Why a lock?", "c1");
		const m = await store.move({
			thread: { source: "agent", id: t.id },
			on,
			anchor: to(14),
		});
		const g = await store.move({ thread: gh, on, anchor: to(3) });
		const u = await store.undoMove(gh, g.id);
		const tip = git("rev-parse", ref);
		const { moves, undos } = await store.moves();
		expect(moves.map((x) => x.id)).toEqual([m.id, g.id]);
		expect(moves[0]).toMatchObject({
			thread: { source: "agent", id: t.id },
			on,
			anchor: to(14),
			engine: TRACER_VERSION,
		});
		expect(undos).toEqual([{ id: u.id, ts: u.ts, thread: gh, move: g.id }]);
		expect(git("rev-parse", ref)).toBe(tip);
		const subject = git("log", "-3", "--format=%s", ref);
		expect(subject).toContain("crb: moved a thread to src/lock.ts:14 on PS2");
		expect(subject).toContain("crb: undid a thread move");
		// The threads fold is untouched by moves.
		expect((await store.read()).map((x) => x.id)).toEqual([t.id]);
	});

	it("drops a move of an agent thread never opened, a file thread, a thread conversation or the review conversation", async () => {
		const line = await ask("Why a lock?", "c1");
		const file = await store.open({
			anchor: { subject: "file", path: "src/lock.ts", commit: "a".repeat(40) },
			text: "This file?",
			by: "human",
			clientId: "c2",
		});
		const conv = await store.open({
			anchor: {
				subject: "thread",
				thread: "PRRT_x",
				path: "src/lock.ts",
				commit: "a".repeat(40),
			},
			text: "Is it fixed?",
			by: "human",
			clientId: "c3",
		});
		const review = await store.open({
			anchor: { subject: "review" },
			text: "Overall?",
			by: "human",
			clientId: "c4",
		});
		const never = "01jzzzzzzzzzzzzzzzzzzzzzzz";
		for (const id of [line.id, file.id, conv.id, review.id, never]) {
			await store.move({ thread: { source: "agent", id }, on, anchor: to(5) });
		}
		const { moves } = await store.moves();
		expect(moves.map((m) => m.thread.id)).toEqual([line.id]);
	});

	it("two tabs moving at once both land", async () => {
		const other = new AgentThreadStore(new RefStore(repo), REVIEW, "dan");
		const [a, b] = await Promise.all([
			store.move({ thread: gh, on, anchor: to(3) }),
			other.move({ thread: gh, on, anchor: to(4) }),
		]);
		const { moves, undos } = await store.moves();
		expect(new Set(moves.map((m) => m.id))).toEqual(new Set([a.id, b.id]));
		// The later (ts, id) is the one the thread stands on.
		const later = [a, b].sort(
			(x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1),
		)[1];
		expect(foldMoves(moves, undos).get("github:PRRT_kwDOabc")?.at(-1)?.id).toBe(
			later?.id,
		);
	});
});

describe("a move's size (principle 3, CAR-139)", () => {
	/** A commit object's bytes, raw and as git stores it loose (zlib). */
	const sizes = (oid: string) => {
		const body = execFileSync("git", ["cat-file", "commit", oid], {
			cwd: repo,
			env: testGitEnv(),
		});
		const object = Buffer.concat([
			Buffer.from(`commit ${body.length}\0`),
			body,
		]);
		return { raw: body.length, deflated: deflateSync(object).length };
	};
	const on = {
		base: "0123456789abcdef0123456789abcdef01234567",
		head: "89abcdef0123456789abcdef0123456789abcdef",
		patchset: 3,
	};
	const anchor = {
		path: "src/module12/service/pool.ts",
		startSide: "RIGHT" as const,
		startLine: 52,
		side: "RIGHT" as const,
		line: 58,
	};

	it("one move commit (a GitHub thread's, an agent thread's) is under 1 KiB raw and 512 B deflated; an undo too", async () => {
		const t = await ask("Why a lock?", "c1");
		await store.move({
			thread: { source: "github", id: "PRRT_kwDOKx000012Hq1AbCdEf" },
			on,
			anchor,
		});
		const gh = sizes(git("rev-parse", ref));
		const m = await store.move({
			thread: { source: "agent", id: t.id },
			on,
			anchor,
		});
		const ai = sizes(git("rev-parse", ref));
		await store.undoMove({ source: "agent", id: t.id }, m.id);
		const undone = sizes(git("rev-parse", ref));
		for (const s of [gh, ai, undone]) {
			expect(s.raw).toBeLessThan(1024);
			expect(s.deflated).toBeLessThan(512);
		}
	});
});

describe("moves stay private (CAR-139)", () => {
	it("a default clone, and a fetch of the review's shared refs, never carry the agent threads ref that holds the moves", async () => {
		const on = { base: "b".repeat(40), head: "c".repeat(40) };
		await store.move({
			thread: { source: "github", id: "PRRT_1" },
			on,
			anchor: {
				path: "a.ts",
				startSide: "RIGHT",
				startLine: 1,
				side: "RIGHT",
				line: 1,
			},
		});
		const progress = `refs/crb/reviews/${REVIEW}/reviewers/dan/progress`;
		await refs.appendEvents(
			progress,
			"crb: x",
			[
				newEvent("cluster-state", "dan", {
					patchset: "f".repeat(64),
					cluster: "c1",
					path: "a.ts",
					state: "reviewed",
				}),
			],
			"dan",
		);
		const { path: other, cleanup: done } = createBareRepo();
		try {
			const run = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: other,
					encoding: "utf8",
					env: testGitEnv(),
				}).trim();
			// What a default clone fetches: branches and tags.
			run(
				"fetch",
				"--quiet",
				"--tags",
				`file://${repo}`,
				"+refs/heads/*:refs/remotes/origin/*",
			);
			run(
				"fetch",
				"--quiet",
				`file://${repo}`,
				`refs/crb/reviews/${REVIEW}/reviewers/dan/progress:${progress}`,
			);
			const listed = run("for-each-ref", "--format=%(refname)", "refs/crb");
			expect(listed).toBe(progress);
			expect(listed).not.toContain("agent");
		} finally {
			done();
		}
	});
});

describe("a posted block joins its GitHub thread (CAR-236)", () => {
	const T = "01k9e6m2q8x4v7c3n5b0h1j2b1";
	const T2 = "01k9e6m2q8x4v7c3n5b0h1j2b2";
	const A = "01k9e6m2q8x4v7c3n5b0h1j2c1";
	const A2 = "01k9e6m2q8x4v7c3n5b0h1j2c2";
	const file: AgentAnchor = {
		subject: "file",
		path: "src/a.ts",
		commit: "a".repeat(40),
	};
	const opened = (thread: string, a: AgentAnchor, ts: number) =>
		newEvent(
			"agent-thread-opened",
			"dan",
			{ thread, anchor: a, text: "q", details: { clientId: thread } },
			"human",
			ts,
		);
	const said = (thread: string, id: string, ts: number) => ({
		...newEvent(
			"agent-message",
			"dan",
			{
				thread,
				text: "```comment\nx\n```\n```comment\ny\n```",
				agent,
				stop: "end_turn" as const,
				activity: [],
			},
			"ai",
			ts,
		),
		id,
	});
	const posted = (
		thread: string,
		message: string,
		block: number,
		gt: string,
		ts: number,
	) =>
		newEvent(
			"agent-comment-posted",
			"dan",
			{
				thread,
				message,
				block,
				clientId: agentCommentClientId(thread, message, block),
				github: {
					thread: gt,
					comment: `PRRC_${block}`,
					url: `https://github.com/o/r/pull/1#discussion_r${block}`,
				},
				text: "x",
			},
			"human",
			ts,
		);

	it("a line conversation that posted a block is on that GitHub thread, its lines kept", () => {
		const [t] = foldAgentThreads([
			opened(T, anchor, 1000),
			said(T, A, 2000),
			posted(T, A, 0, "PRRT_new", 3000),
		]);
		expect(t?.id).toBe(T);
		expect(t?.anchor).toEqual({
			subject: "thread",
			thread: "PRRT_new",
			path: "src/lock.ts",
			commit: "a".repeat(40),
			side: "RIGHT",
			line: 12,
			startSide: "RIGHT",
			startLine: 10,
		});
		expect(t?.joins).toEqual({ asked: anchor, threads: ["PRRT_new"] });
		// Nothing else changes: messages, posted.
		expect(t?.messages).toHaveLength(2);
		expect(t?.messages[1]?.posted?.map((p) => p.block)).toEqual([0]);
	});

	it("a file conversation joins as a thread anchor without lines", () => {
		const [t] = foldAgentThreads([
			opened(T, file, 1000),
			said(T, A, 2000),
			posted(T, A, 0, "PRRT_new", 3000),
		]);
		expect(t?.anchor).toEqual({
			subject: "thread",
			thread: "PRRT_new",
			path: "src/a.ts",
			commit: "a".repeat(40),
		});
	});

	it("nothing posted: on its lines as asked", () => {
		const [t] = foldAgentThreads([opened(T, anchor, 1000), said(T, A, 2000)]);
		expect(t?.anchor).toEqual(anchor);
		expect(t).not.toHaveProperty("joins");
	});

	it("two posted threads: the earliest posted is the one, the other kept as a fallback", () => {
		const [t] = foldAgentThreads([
			opened(T, anchor, 1000),
			said(T, A, 2000),
			said(T, A2, 2500),
			// Block 1 of the first message posted later than the second message's.
			posted(T, A, 1, "PRRT_late", 4000),
			posted(T, A2, 0, "PRRT_early", 3000),
			// A reply to the joined thread adds nothing.
			posted(T, A, 0, "PRRT_early", 5000),
		]);
		expect(t?.anchor).toMatchObject({
			subject: "thread",
			thread: "PRRT_early",
		});
		expect(t?.joins?.threads).toEqual(["PRRT_early", "PRRT_late"]);
	});

	it("several posted threads: ordered by when GitHub took the comment, not by when the record was written", () => {
		const late = (gt: string, n: number, ts: number) => ({
			...posted(T, A, n, gt, ts),
			github: {
				thread: gt,
				comment: `PRRC_${n}`,
				url: `https://github.com/o/r/pull/1#discussion_r${n === 0 ? 900 : 100}`,
			},
		});
		const [t] = foldAgentThreads([
			opened(T, anchor, 1000),
			said(T, A, 2000),
			// Block 0's comment (id 900) was recorded first, but GitHub took
			// block 1's (id 100) earlier: its record failed and came later.
			late("PRRT_second", 0, 3000),
			late("PRRT_first", 1, 4000),
		]);
		expect(t?.anchor).toMatchObject({
			subject: "thread",
			thread: "PRRT_first",
		});
		expect(t?.joins?.threads).toEqual(["PRRT_first", "PRRT_second"]);
	});

	it("the review conversation and a thread conversation never change", () => {
		const review: AgentAnchor = { subject: "review" };
		const onThread: AgentAnchor = {
			subject: "thread",
			thread: "PRRT_old",
			path: "src/a.ts",
			commit: "a".repeat(40),
		};
		const folded = foldAgentThreads([
			opened(T, review, 1000),
			said(T, A, 2000),
			posted(T, A, 0, "PRRT_x", 3000),
			opened(T2, onThread, 1100),
			said(T2, A2, 2100),
			posted(T2, A2, 0, "PRRT_old", 3100),
		]);
		expect(folded.map((t) => t.anchor)).toEqual([review, onThread]);
		expect(folded.every((t) => t.joins === undefined)).toBe(true);
	});

	it("a later Ask agent on the joined GitHub thread folds into the conversation", () => {
		const folded = foldAgentThreads([
			opened(T, anchor, 1000),
			said(T, A, 2000),
			posted(T, A, 0, "PRRT_new", 3000),
			opened(
				T2,
				{
					subject: "thread",
					thread: "PRRT_new",
					path: "src/lock.ts",
					commit: "a".repeat(40),
				},
				4000,
			),
		]);
		expect(folded).toHaveLength(1);
		expect(folded[0]?.id).toBe(T);
		expect(folded[0]?.messages).toHaveLength(3);
	});

	it("a GitHub thread another conversation was opened on first stays that one's", () => {
		const folded = foldAgentThreads([
			opened(
				T2,
				{
					subject: "thread",
					thread: "PRRT_new",
					path: "src/lock.ts",
					commit: "a".repeat(40),
				},
				1500,
			),
			opened(T, anchor, 1000),
			said(T, A, 2000),
			posted(T, A, 0, "PRRT_new", 3000),
		]);
		expect(folded.map((t) => t.id)).toEqual([T, T2]);
		expect(folded[0]?.anchor).toEqual(anchor);
	});

	it("the store's posted() answers the joined conversation", async () => {
		const t = await ask("Why?", "c1");
		const a = await answer(t.id, "```comment\nx\n```");
		const after = await store.posted(t.id, {
			message: a.messages[1]?.id as string,
			block: 0,
			github: {
				thread: "PRRT_9",
				comment: "PRRC_9",
				url: "https://github.com/o/r/pull/1#discussion_r9",
			},
			text: "x",
		});
		expect(after.id).toBe(t.id);
		expect(after.anchor).toMatchObject({ subject: "thread", thread: "PRRT_9" });
		// And find() by its id, as the MCP tools do.
		expect((await store.find(t.id)).anchor).toMatchObject({ thread: "PRRT_9" });
	});
});

describe("a write whose compare-and-swap loses to another process is rebuilt on the new tip (CAR-245)", () => {
	const on = { base: "b".repeat(40), head: "c".repeat(40), patchset: 2 };
	const to = (line: number) => ({
		path: "src/lock.ts",
		startSide: "RIGHT" as const,
		startLine: line,
		side: "RIGHT" as const,
		line,
	});
	const gh = { source: "github" as const, id: "PRRT_kwDOabc" };
	/** Another server, its clock a minute ahead of ours. */
	const AHEAD = 60_000;

	/**
	 * Runs `write` with `race` (another process's write) landing between
	 * the write's read and its first compare-and-swap.
	 */
	async function racing<T>(
		race: () => Promise<unknown>,
		write: () => Promise<T>,
	): Promise<T> {
		const transaction = refs.transaction.bind(refs);
		let raced = false;
		const spy = vi
			.spyOn(refs, "transaction")
			.mockImplementation(async (updates) => {
				if (!raced) {
					raced = true;
					await race();
				}
				return transaction(updates);
			});
		try {
			return await write();
		} finally {
			spy.mockRestore();
			expect(raced).toBe(true);
		}
	}
	const otherWrites = (event: CrbEvent) => () =>
		new RefStore(repo).appendEvent(ref, "crb: other", event, "dan");

	it("a move retried after another server's newer move is the one the thread stands on", async () => {
		const theirs = newEvent(
			"thread-moved",
			"dan",
			{ thread: gh, on, anchor: to(4), engine: TRACER_VERSION },
			"human",
			Date.now() + AHEAD,
		);
		const mine = await racing(otherWrites(theirs), () =>
			store.move({ thread: gh, on, anchor: to(3) }),
		);
		const { moves, undos } = await store.moves();
		expect(moves.map((m) => m.id)).toEqual([theirs.id, mine.id]);
		expect(mine.ts).toBeGreaterThan(theirs.ts);
		expect(foldMoves(moves, undos).get("github:PRRT_kwDOabc")?.at(-1)?.id).toBe(
			mine.id,
		);
	});

	it("an undo retried after another server's newer write folds after its move, and after that write", async () => {
		const move = await store.move({ thread: gh, on, anchor: to(3) });
		const theirs = newEvent(
			"thread-moved",
			"dan",
			{ thread: gh, on, anchor: to(9), engine: TRACER_VERSION },
			"human",
			Date.now() + AHEAD,
		);
		const undo = await racing(otherWrites(theirs), () =>
			store.undoMove(gh, move.id),
		);
		expect(undo.ts).toBeGreaterThan(theirs.ts);
		expect(undo.ts).toBeGreaterThan(move.ts);
		const { moves, undos } = await store.moves();
		expect(
			foldMoves(moves, undos)
				.get("github:PRRT_kwDOabc")
				?.map((m) => m.id),
		).toEqual([theirs.id]);
	});

	it("an undo whose move another server undid meanwhile is refused by its check, as a first try would be", async () => {
		const move = await store.move({ thread: gh, on, anchor: to(3) });
		const theirs = newEvent(
			"thread-move-undone",
			"dan",
			{ thread: gh, move: move.id },
			"human",
		);
		const tip = git("rev-parse", ref);
		class Dead extends Error {}
		await expect(
			racing(
				async () => {
					await otherWrites(theirs)();
				},
				() =>
					store.undoMove(gh, move.id, ({ moves, undos }) => {
						const live = foldMoves(moves, undos).get("github:PRRT_kwDOabc");
						if (!live?.some((m) => m.id === move.id)) throw new Dead();
					}),
			),
		).rejects.toBeInstanceOf(Dead);
		// Only the other server's undo landed.
		expect(git("rev-list", "--count", `${tip}..${ref}`)).toBe("1");
	});

	it("a move whose thread another server moved to the cap meanwhile is refused by its check", async () => {
		const theirs = newEvent(
			"thread-moved",
			"dan",
			{ thread: gh, on, anchor: to(4), engine: TRACER_VERSION },
			"human",
		);
		class Cap extends Error {}
		await expect(
			racing(otherWrites(theirs), () =>
				store.move({ thread: gh, on, anchor: to(3) }, ({ moves, undos }) => {
					if (
						(foldMoves(moves, undos).get("github:PRRT_kwDOabc")?.length ?? 0) >=
						1
					)
						throw new Cap();
				}),
			),
		).rejects.toBeInstanceOf(Cap);
		expect((await store.moves()).moves.map((m) => m.id)).toEqual([theirs.id]);
	});

	it("an answer retried after another server's newer message folds after it", async () => {
		const t = await ask("Why a lock?", "c1");
		const theirs = newEvent(
			"agent-message",
			"dan",
			{ thread: t.id, text: "And the timeout?", details: { clientId: "c2" } },
			"human",
			Date.now() + AHEAD,
		);
		const folded = await racing(otherWrites(theirs), () =>
			answer(t.id, "It guards the pool."),
		);
		const texts = ["Why a lock?", "And the timeout?", "It guards the pool."];
		expect(folded.messages.map((m) => m.text)).toEqual(texts);
		expect((await store.find(t.id)).messages.map((m) => m.text)).toEqual(texts);
	});

	it("a resend whose message another server stored meanwhile writes nothing", async () => {
		const t = await ask("Why a lock?", "c1");
		const theirs = newEvent(
			"agent-message",
			"dan",
			{ thread: t.id, text: "And the timeout?", details: { clientId: "c2" } },
			"human",
		);
		const tip = git("rev-parse", ref);
		const folded = await racing(otherWrites(theirs), () =>
			store.message(t.id, {
				by: "human",
				text: "And the timeout?",
				clientId: "c2",
			}),
		);
		expect(folded.messages.map((m) => m.text)).toEqual([
			"Why a lock?",
			"And the timeout?",
		]);
		expect(git("rev-list", "--count", `${tip}..${ref}`)).toBe("1");
	});

	it("a link whose GitHub thread another server gave a conversation meanwhile is refused", async () => {
		const t = await ask("Why a lock?", "c1");
		const theirs = newEvent(
			"agent-thread-opened",
			"dan",
			{
				thread: "01jzzzzzzzzzzzzzzzzzzzzzzz",
				anchor: {
					subject: "thread",
					thread: "PRRT_new",
					path: "src/lock.ts",
					commit: "a".repeat(40),
				},
				text: "Fixed?",
				details: { clientId: "c9" },
			},
			"human",
		);
		await expect(
			racing(otherWrites(theirs), () => store.link(t.id, "PRRT_new")),
		).rejects.toBeInstanceOf(AgentLinkError);
	});
});
