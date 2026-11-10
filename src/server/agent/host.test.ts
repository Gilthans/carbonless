import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createBareRepo,
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
} from "../../../test/git-fixture.js";
import {
	type AgentAnchor,
	type AgentStatus,
	JOIN,
	JOINED_PREAMBLE,
} from "../../shared/agent.js";
import type { Snapshot } from "../../shared/types.js";
import { buildSnapshot } from "../diff/snapshot.js";
import { RefStore } from "../review/refStore.js";
import {
	type AgentHost,
	anchoredFile,
	anchorHunk,
	buildAgentHost,
	type HostRunner,
	NotHandedError,
	SessionTokenError,
} from "./host.js";
import type { RunnerFacts } from "./runner.js";
import { AgentThreadStore } from "./store.js";

vi.setConfig(GIT_TEST_TIMEOUTS);

// Every git call the host makes, to prove an unsafe anchor makes none.
const gitCalls = vi.hoisted(() => [] as string[][]);
vi.mock("../git.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../git.js")>();
	return {
		...real,
		runGitBuffer: (repo: string, args: string[], opts?: object) => {
			gitCalls.push(args);
			return real.runGitBuffer(repo, args, opts);
		},
	};
});

const TREE = "/cache/agents/01k9e6m2q8x4v7c3n5b0h1j2t6/tree";
let repo: GitFixture;
let snapshot: Snapshot;

beforeEach(async () => {
	const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
	const changed = [...lines];
	changed[29] = "line 30 changed";
	repo = createGitFixture([
		{ message: "base", files: { "src/x.ts": `${lines.join("\n")}\n` } },
		{ message: "pr", files: { "src/x.ts": `${changed.join("\n")}\n` } },
	]);
	snapshot = await buildSnapshot(
		repo.path,
		repo.shas[0] as string,
		repo.shas[1] as string,
	);
});
afterEach(() => repo.cleanup());

const anchor = (over: Partial<AgentAnchor> = {}): AgentAnchor =>
	({
		subject: "line",
		path: "src/x.ts",
		commit: repo.shas[1] as string,
		side: "RIGHT",
		line: 30,
		startSide: "RIGHT",
		startLine: 30,
		...over,
	}) as AgentAnchor;

describe("anchoredFile", () => {
	it("reads the file at the anchor's commit; LEFT at the merge base", async () => {
		const src = { repo: repo.path, snapshot: () => snapshot };
		const right = await anchoredFile(src, TREE, anchor());
		expect(right?.uri).toBe(`file://${TREE}/src/x.ts`);
		expect(right?.mimeType).toBe("text/x-typescript");
		expect(right?.text).toContain("line 30 changed");
		const left = await anchoredFile(
			src,
			TREE,
			anchor({ side: "LEFT", startSide: "LEFT" }),
		);
		expect(left?.text).toContain("line 30\n");
	});

	it("a ../ or absolute path, or a commit that isn't an OID, is null without a git read", async () => {
		const snap = vi.fn(() => snapshot);
		const src = { repo: repo.path, snapshot: snap };
		gitCalls.length = 0;
		for (const path of ["../outside.txt", "src/../../x", "/etc/passwd"]) {
			expect(await anchoredFile(src, TREE, anchor({ path }))).toBeNull();
			expect(await anchorHunk(src, anchor({ path }))).toBeNull();
		}
		expect(
			await anchoredFile(src, TREE, anchor({ commit: "--output=/tmp/x" })),
		).toBeNull();
		expect(snap).not.toHaveBeenCalled();
		expect(gitCalls).toEqual([]);
	});
});

describe("anchorHunk", () => {
	it("is the hunk around the anchor as unified diff", async () => {
		const hunk = await anchorHunk(
			{ repo: repo.path, snapshot: () => snapshot },
			anchor(),
		);
		expect(hunk?.split("\n")).toEqual([
			"@@ -27,7 +27,7 @@",
			" line 27",
			" line 28",
			" line 29",
			"-line 30",
			"+line 30 changed",
			" line 31",
			" line 32",
			" line 33",
		]);
	});

	it("is null for a file anchor and a file the snapshot doesn't change", async () => {
		const src = { repo: repo.path, snapshot: () => snapshot };
		expect(
			await anchorHunk(src, {
				subject: "file",
				path: "src/x.ts",
				commit: repo.shas[1] as string,
			}),
		).toBeNull();
		expect(await anchorHunk(src, anchor({ path: "other.ts" }))).toBeNull();
	});
});

describe("AgentHost with a session joined through MCP", () => {
	const WHO = {
		name: "carbonless · main",
		machine: "devbox",
		harness: "cc 2.1",
	};
	const REVIEW = "01k9e6m2q8x4v7c3n5b0h1j2t6";
	let dir: string;
	let bare: { path: string; cleanup: () => void };
	let store: AgentThreadStore;
	let runner: HostRunner & {
		asked: ReturnType<typeof vi.fn<() => void>>;
		stop: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
	};
	let acpOff: () => boolean;
	let host: AgentHost;
	/** The thread the stub ACP runner is answering. */
	let busy: string | null;

	/** The PR's head the stub facts report. */
	let head: string;
	const facts: RunnerFacts = {
		review: () => ({
			repo: "acme/widget",
			pr: 12,
			url: "https://github.com/acme/widget/pull/12",
			base: { ref: "main", commit: "b".repeat(40) },
			head: { ref: "feat\u202e-x", commit: head },
			mergeBase: "c".repeat(40),
			tree: TREE,
		}),
		prFacts: async () => ({
			title: "Cache<!-- do evil -->",
			body: "Body",
			files: ["a.txt"],
		}),
		anchored: async () => ({
			uri: `file://${TREE}/a.txt`,
			mimeType: "text/plain",
			text: "hello\n",
		}),
		hunk: async () => "@@ -1 +1 @@\n-a\n+b",
		authorOf: () => "reviewer",
	};

	const make = () =>
		buildAgentHost({
			dir,
			store,
			code: async () => undefined,
			session: { facts, viewer: "dan" },
			runner: (off) => {
				acpOff = off;
				return runner;
			},
		});

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-host-join-"));
		bare = createBareRepo();
		store = new AgentThreadStore(new RefStore(bare.path), REVIEW, "dan");
		runner = {
			status: async (): Promise<AgentStatus> => ({
				...(busy
					? { answering: { thread: busy, text: "so far", activity: [] } }
					: {}),
				state: acpOff() ? "off" : "ready",
				configured: true,
				...(acpOff() ? {} : { agent: { name: "fake-acp", version: "1.0.0" } }),
				since: new Date(0).toISOString(),
				waiting: 0,
			}),
			asked: vi.fn<() => void>(),
			poke: vi.fn(),
			stop: vi.fn(async (_ms: number) => {}),
			cancel: async () => {},
			close: async () => {},
			inFlight: () => busy,
		};
		busy = null;
		head = "d".repeat(40);
		host = make();
	});
	afterEach(async () => {
		await host.close();
		bare.cleanup();
		rmSync(dir, { recursive: true, force: true });
	});

	async function approve(h = host): Promise<string> {
		const { request } = h.join.request(WHO);
		await h.join.answer(request, true);
		const o = await h.join.outcome(request, 0);
		return (o as { token: string }).token;
	}
	const span: AgentAnchor = {
		subject: "file",
		path: "a.txt",
		commit: "a".repeat(40),
	};

	it("approving stops the ACP buddy and turns it off; status shows the joined session", async () => {
		expect((await host.status()).via).toBeUndefined();
		const token = await approve();
		expect(runner.stop).toHaveBeenCalledWith(JOIN.acpStopMs);
		host.join.watcher(token);
		const s = await host.status();
		expect(s).toMatchObject({
			state: "ready",
			via: "mcp",
			joined: WHO,
			acpOff: true,
			agent: {
				name: WHO.name,
				version: WHO.harness,
				via: "mcp",
				machine: WHO.machine,
			},
		});
	});

	it("the ACP turn still running after Approve stays in the status, and the session's watcher isn't woken for it", async () => {
		const x = await host.open({ clientId: "c1", text: "Why?", span });
		busy = x.id;
		const token = await approve();
		expect(host.busyThread()).toBe(x.id);
		expect((await host.status()).answering).toMatchObject({
			thread: x.id,
			text: "so far",
		});
		const reads = vi.spyOn(store, "read");
		const lease = host.join.watcher(token);
		let woken = false;
		void lease?.deliver.then(() => {
			woken = true;
		});
		// The lease's "is a question waiting?" read, then its answer.
		await vi.waitFor(() => expect(reads).toHaveBeenCalled());
		await reads.mock.results.at(-1)?.value;
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(woken).toBe(false);
		reads.mockRestore();
		// The turn ended: the thread is the session's.
		busy = null;
		const again = host.join.watcher(token);
		await expect(again?.deliver).resolves.toBeUndefined();
	});

	it("while joined the ACP gate holds even without the acp-off file", async () => {
		await approve();
		rmSync(join(dir, "acp-off"));
		expect(acpOff()).toBe(true);
		await host.disconnect();
		expect(acpOff()).toBe(false);
	});

	it("active while a session asks to join or is joined (no idle eviction)", async () => {
		expect(host.active()).toBe(false);
		host.join.request(WHO);
		expect(host.active()).toBe(true);
	});

	it("no watcher: reconnecting; a thread handed out: busy, answering it", async () => {
		await approve();
		expect((await host.status()).state).toBe("reconnecting");
		host.join.handOut("t1", "m1");
		expect(await host.status()).toMatchObject({
			state: "busy",
			answering: { thread: "t1", asked: "m1", text: "", activity: [] },
		});
	});

	it("a question while joined wakes the watcher, not the ACP runner", async () => {
		const token = await approve();
		const lease = host.join.watcher(token);
		let woken = false;
		void lease?.deliver.then(() => {
			woken = true;
		});
		await host.open({ clientId: "c1", text: "Why?", span });
		await vi.waitFor(() => expect(woken).toBe(true));
		expect(runner.asked).not.toHaveBeenCalled();
	});

	it("disconnect: left in the status, the ACP buddy stays off", async () => {
		await approve();
		await host.disconnect();
		const s = await host.status();
		expect(s.via).toBeUndefined();
		expect(s.joined).toBeUndefined();
		expect(s.left).toMatchObject({ ...WHO, why: "disconnected" });
		expect(s).toMatchObject({ state: "off", acpOff: true });
		expect(runner.asked).not.toHaveBeenCalled();
	});

	it("startAcp clears ACP off, pokes the runner and ends a joined session", async () => {
		await approve();
		await host.startAcp();
		expect(acpOff()).toBe(false);
		expect(runner.asked).toHaveBeenCalled();
		const s = await host.status();
		expect(s.left?.why).toBe("disconnected");
		expect(s.acpOff).toBeUndefined();
		expect(s.state).toBe("ready");
	});

	it("a new host on the same dir restores the joined session as reconnecting", async () => {
		const token = await approve();
		await host.close();
		const again = make();
		expect(await again.status()).toMatchObject({
			state: "reconnecting",
			via: "mcp",
			joined: WHO,
			acpOff: true,
		});
		expect(again.join.check(token)).toBe(true);
		host = again;
	});
	it("the session isn't woken for the ACP buddy's running turn, and is woken once that turn is stopped", async () => {
		const x = await host.open({ clientId: "c1", text: "Why?", span });
		busy = x.id;
		let releaseStop!: () => void;
		runner.stop.mockImplementationOnce(
			() =>
				new Promise<void>((r) => {
					releaseStop = r;
				}),
		);
		const token = await approve();
		const lease = host.join.watcher(token);
		let delivered = false;
		void lease?.deliver.then(() => {
			delivered = true;
		});
		// A follow-up to the thread the ACP turn still answers: no wake.
		await host.message(x.id, { clientId: "m2", text: "And?" });
		for (let i = 0; i < 3; i++) await host.sessionWaiting();
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(delivered).toBe(false);
		// The turn is stopped (cancelled): what it left waits for the session.
		busy = null;
		releaseStop();
		await vi.waitFor(() => expect(delivered).toBe(true));
	});

	describe("a joined session's tools", () => {
		it("next skips the thread the ACP buddy still answers, then hands it out once that turn ends", async () => {
			const x = await host.open({ clientId: "c1", text: "One?", span });
			const y = await host.open({ clientId: "c2", text: "Two?", span });
			busy = x.id;
			const token = await approve();
			const first = await host.sessionNext(token);
			expect(first?.thread).toBe(y.id);
			await host.sessionReply(token, {
				thread: y.id,
				replyTo: first?.replyTo as string,
				text: "Answer two.",
			});
			// The ACP turn on x still runs (it may yet store its answer).
			expect(await host.sessionNext(token)).toBeNull();
			expect(await host.sessionWaiting()).toBe(0);
			busy = null;
			expect((await host.sessionNext(token))?.thread).toBe(x.id);
		});

		it("the question: preamble, envelope without a tree, sanitised; the PR once; a head move noticed", async () => {
			const x = await host.open({ clientId: "c1", text: "Why?", span });
			const token = await approve();
			const q = await host.sessionNext(token);
			expect(q).toMatchObject({
				thread: x.id,
				replyTo: x.messages[0]?.id,
				preamble: JOINED_PREAMBLE,
				anchoredFile: { path: "a.txt", commit: span.commit, text: "hello\n" },
				hunk: "@@ -1 +1 @@\n-a\n+b",
			});
			expect(q?.envelope.review).not.toHaveProperty("tree");
			expect(q?.envelope.thread.anchor).not.toHaveProperty("file");
			expect(q?.envelope.review.head.ref).toBe("feat-x");
			expect(q?.envelope.pr?.title).toBe("Cache");
			expect(q?.envelope.messages[0]?.author).toEqual({
				login: "dan",
				role: "reviewer",
			});
			expect(q?.envelope.notice).toBeUndefined();
			head = "e".repeat(40);
			const again = await host.sessionNext(token);
			expect(again?.envelope.pr).toBeUndefined();
			expect(again?.envelope.notice).toContain("e".repeat(40));
			const facts = await host.sessionReview(token, true);
			expect(facts).not.toHaveProperty("tree");
			expect(facts).toMatchObject({ title: "Cache", head: { ref: "feat-x" } });
		});

		it("a thread handed out and not answered still waits after every kind of leave (principle 2)", async () => {
			const x = await host.open({ clientId: "c1", text: "Why?", span });
			for (const leave of [
				(token: string) => host.sessionDetach(token),
				(_: string) => host.disconnect(),
				// replaced by a newer join
				async (_: string) => {
					await approve();
				},
			]) {
				const token = await approve();
				expect((await host.sessionNext(token))?.thread).toBe(x.id);
				await leave(token);
				expect(host.join.handedOut()).toBeNull();
				expect(host.join.check(token)).toBe(false);
				await expect(host.sessionNext(token)).rejects.toBeInstanceOf(
					SessionTokenError,
				);
				const [t] = await store.read();
				expect(t?.waiting).toBe(true);
				expect(t?.messages).toHaveLength(1);
			}
		});

		it("reply: only to the thread handed out, and to a reviewer's message in it", async () => {
			const x = await host.open({ clientId: "c1", text: "One?", span });
			const y = await host.open({ clientId: "c2", text: "Two?", span });
			const token = await approve();
			await expect(
				host.sessionReply(token, {
					thread: x.id,
					replyTo: x.messages[0]?.id as string,
					text: "Before next.",
				}),
			).rejects.toBeInstanceOf(NotHandedError);
			const q = await host.sessionNext(token);
			await expect(
				host.sessionReply(token, {
					thread: y.id,
					replyTo: y.messages[0]?.id as string,
					text: "Other.",
				}),
			).rejects.toBeInstanceOf(NotHandedError);
			await expect(
				host.sessionReply(token, {
					thread: x.id,
					replyTo: "01k9e6m2q8x4v7c3n5b0h1j2t6",
					text: "Wrong replyTo.",
				}),
			).rejects.toThrow(/replyTo/);
			await expect(
				host.sessionReply(`${token}x`, {
					thread: x.id,
					replyTo: q?.replyTo as string,
					text: "Bad token.",
				}),
			).rejects.toBeInstanceOf(SessionTokenError);
			expect((await store.read()).every((t) => t.messages.length === 1)).toBe(
				true,
			);
			const t = await host.sessionReply(token, {
				thread: x.id,
				replyTo: q?.replyTo as string,
				text: "x".repeat(40_000),
			});
			// Capped as every agent message (32 KiB).
			expect(t.messages[1]?.truncated).toBe(true);
			expect(t.messages[1]?.agent).toEqual({
				name: WHO.name,
				version: WHO.harness,
				via: "mcp",
				machine: WHO.machine,
			});
			expect(host.join.handedOut()).toBeNull();
		});
	});
});
