import { describe, expect, it } from "vitest";
import type { AgentAnchor } from "../../shared/agent.js";
import type { ReviewThread } from "../../shared/types.js";
import { joinGithub, orphanAnchor, resolveView } from "./githubJoin.js";
import type { AgentThreadFold } from "./store.js";

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const H3 = "3".repeat(40);
const MB = "b".repeat(40);

type ThreadAnchor = Extract<AgentAnchor, { subject: "thread" }>;

const threadAnchor = (over: Partial<ThreadAnchor> = {}): ThreadAnchor => ({
	subject: "thread",
	thread: "T1",
	path: "src/a.ts",
	commit: H1,
	side: "RIGHT",
	line: 12,
	startSide: "RIGHT",
	startLine: 10,
	...over,
});

const fold = (
	anchor: AgentAnchor,
	over: Partial<AgentThreadFold> = {},
): AgentThreadFold => ({
	id: "01k9e6m2q8x4v7c3n5b0h1j2t6",
	anchor,
	openedBy: "human",
	at: "2026-01-01T00:00:00.000Z",
	messages: [],
	resolved: false,
	waiting: false,
	unread: false,
	...over,
});

/** Only what the join reads of a GitHub thread. */
const gh = (id: string, over: Partial<ReviewThread> = {}): ReviewThread =>
	({ id, resolved: false, ...over }) as ReviewThread;

describe("joinGithub", () => {
	it("resolved follows the GitHub thread, not agent-thread-resolved", () => {
		// Its own events said resolved; GitHub says open.
		const ownResolved = fold(threadAnchor(), { resolved: true });
		expect(joinGithub([ownResolved], [gh("T1")])).toEqual([
			{ ...ownResolved, resolved: false },
		]);
		// Its own events said open; GitHub says resolved.
		const ownOpen = fold(threadAnchor());
		const [joined] = joinGithub([ownOpen], [gh("T1", { resolved: true })]);
		expect(joined).toMatchObject({ resolved: true, anchor: threadAnchor() });
		expect(joined).not.toHaveProperty("orphaned");
	});

	it("a thread gone from GitHub becomes a span thread on its lines", () => {
		const t = fold(threadAnchor());
		const line = {
			subject: "line",
			path: "src/a.ts",
			commit: H1,
			side: "RIGHT",
			line: 12,
			startSide: "RIGHT",
			startLine: 10,
		};
		// No longer listed.
		expect(joinGithub([t], [gh("T2")])).toEqual([
			{ ...t, anchor: line, orphaned: true },
		]);
		// Listed, but deleted since the list was read.
		expect(
			joinGithub([t], [gh("T1", { unavailable: "deleted", resolved: true })]),
		).toEqual([{ ...t, anchor: line, orphaned: true }]);
	});

	it("an orphan without lines or commit is a file anchor", () => {
		const file = { subject: "file", path: "src/a.ts", commit: H1 };
		const noLines = threadAnchor({
			side: undefined,
			line: undefined,
			startSide: undefined,
			startLine: undefined,
		});
		for (const k of ["side", "line", "startSide", "startLine"] as const) {
			delete noLines[k];
		}
		expect(joinGithub([fold(noLines)], [])[0]?.anchor).toEqual(file);
		expect(
			joinGithub([fold(threadAnchor({ commit: "" }))], [])[0]?.anchor,
		).toEqual({ ...file, commit: "" });
		expect(orphanAnchor(noLines)).toEqual(file);
	});

	it("an orphan without a start keeps its one line", () => {
		const one = threadAnchor({ line: 7 });
		delete one.startSide;
		delete one.startLine;
		expect(orphanAnchor(one)).toEqual({
			subject: "line",
			path: "src/a.ts",
			commit: H1,
			side: "RIGHT",
			line: 7,
			startSide: "RIGHT",
			startLine: 7,
		});
	});

	it("an orphan resolves with agent-thread-resolved", () => {
		const t = fold(threadAnchor(), { resolved: true });
		expect(joinGithub([t], [])[0]).toMatchObject({
			resolved: true,
			orphaned: true,
		});
		expect(joinGithub([{ ...t, resolved: false }], [])[0]?.resolved).toBe(
			false,
		);
	});

	it('a GitHub thread with id "" never joins one', () => {
		const t = fold(threadAnchor({ thread: "T1" }));
		expect(joinGithub([t], [gh("")])[0]?.orphaned).toBe(true);
	});

	it("span threads pass through unchanged", () => {
		const line = fold({
			subject: "line",
			path: "src/a.ts",
			commit: H1,
			side: "RIGHT",
			line: 3,
			startSide: "RIGHT",
			startLine: 3,
		});
		const file = fold(
			{ subject: "file", path: "src/b.ts", commit: H1 },
			{ id: "01k9e6m2q8x4v7c3n5b0h1j2t7", resolved: true },
		);
		const out = joinGithub([line, file], [gh("T1", { resolved: true })]);
		expect(out).toEqual([line, file]);
	});
});

describe("resolveView", () => {
	const patchsets = [
		{ number: 1, head: H1, mergeBase: MB },
		{ number: 2, head: H2, mergeBase: H3 },
	];

	it("resolveView fills left/right for a patch set and for {head}", () => {
		expect(
			resolveView(
				{ target: { patchset: 2 }, from: { branch: true } },
				patchsets,
				MB,
			),
		).toEqual({
			target: { patchset: 2 },
			from: { branch: true },
			left: H3,
			right: H2,
		});
		expect(
			resolveView(
				{ target: { patchset: 2 }, from: { patchset: 1 } },
				patchsets,
				MB,
			),
		).toEqual({
			target: { patchset: 2 },
			from: { patchset: 1 },
			left: H1,
			right: H2,
		});
		const head = "4".repeat(40);
		// A head no patch set holds: the snapshot's merge base.
		expect(
			resolveView({ target: { head }, from: { branch: true } }, patchsets, MB),
		).toEqual({
			target: { head },
			from: { branch: true },
			left: MB,
			right: head,
		});
		// A head that is a patch set's: that patch set's merge base.
		expect(
			resolveView(
				{ target: { head: H2 }, from: { branch: true } },
				patchsets,
				MB,
			)?.left,
		).toBe(H3);
		expect(
			resolveView({ target: { head }, from: { patchset: 1 } }, patchsets, MB),
		).toEqual({
			target: { head },
			from: { patchset: 1 },
			left: H1,
			right: head,
		});
	});

	it("resolveView is null for an unknown patch set", () => {
		expect(
			resolveView(
				{ target: { patchset: 3 }, from: { branch: true } },
				patchsets,
				MB,
			),
		).toBeNull();
		expect(
			resolveView(
				{ target: { patchset: 2 }, from: { patchset: 9 } },
				patchsets,
				MB,
			),
		).toBeNull();
		expect(
			resolveView(
				{ target: { head: "main" }, from: { branch: true } },
				patchsets,
				MB,
			),
		).toBeNull();
	});
});
