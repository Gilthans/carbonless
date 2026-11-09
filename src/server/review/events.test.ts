import { describe, expect, it } from "vitest";
import {
	type CrbEvent,
	newEvent,
	parseEventLines,
	serializeCommitMessage,
	validateForWrite,
} from "./events.js";

const payload = {
	patchset: "f".repeat(64),
	cluster: "c1",
	path: "src/a.ts",
	state: "reviewed" as const,
};
const ev = newEvent("cluster-state", "dan", payload);
const msg = (events: unknown[]) =>
	`crb: summary\n\n${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

describe("newEvent", () => {
	it("fills version, lowercase ULID id, timestamp and by", () => {
		const before = Date.now();
		const e = newEvent("patchset-started", "dan", {
			patchset: 1,
			revision: "r".repeat(64),
			mergeBase: "a".repeat(40),
			head: "b".repeat(40),
		});
		expect(e).toMatchObject({
			v: 1,
			type: "patchset-started",
			by: "human",
			actor: "dan",
			patchset: 1,
		});
		expect(e.id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
		expect(e.ts).toBeGreaterThanOrEqual(before);
		expect(e.ts).toBeLessThanOrEqual(Date.now());
	});

	it("gives events created together increasing ids", () => {
		const ids = Array.from(
			{ length: 50 },
			() => newEvent("cluster-state", "dan", payload).id,
		);
		expect([...ids].sort()).toEqual(ids);
		expect(new Set(ids).size).toBe(50);
	});
});

describe("commit messages", () => {
	it("round-trips events through a commit message", () => {
		const created = newEvent("review-created", "dan", {
			source: "github-pr",
			key: "acme/widgets#7",
			pr: {
				owner: "acme",
				repo: "widgets",
				number: 7,
				url: "https://github.com/acme/widgets/pull/7",
				baseBranch: "main",
				headBranch: "feature",
				headRepo: "acme/widgets",
			},
		});
		const crossed = newEvent("cluster-state", "dan", {
			...payload,
			state: "crossed-off",
			reason: "generated",
			details: { note: 'ü "quoted"\nnewline' },
		});
		const message = serializeCommitMessage("crb: reviewed 1 cluster", [
			created,
			ev,
			crossed,
		]);
		expect(message.split("\n")[0]).toBe("crb: reviewed 1 cluster");
		expect(message.split("\n")[1]).toBe("");
		expect(parseEventLines(message)).toEqual([created, ev, crossed]);
	});

	it("keeps the summary on one line", () => {
		const message = serializeCommitMessage("one\ntwo\r\nthree", [ev]);
		expect(message.split("\n")[0]).toBe("one two three");
		expect(parseEventLines(message)).toEqual([ev]);
	});

	it("reads a message with only the summary line", () => {
		expect(parseEventLines("crb: nothing")).toEqual([]);
		expect(parseEventLines(serializeCommitMessage("crb: nothing", []))).toEqual(
			[],
		);
		expect(parseEventLines("")).toEqual([]);
	});

	it("never reads the summary line as an event", () => {
		expect(parseEventLines(`${JSON.stringify(ev)}\n`)).toEqual([]);
	});

	it("reads CRLF line endings", () => {
		expect(parseEventLines(msg([ev, ev]).replaceAll("\n", "\r\n"))).toEqual([
			ev,
			ev,
		]);
	});

	it("reads many events", () => {
		const many = Array.from({ length: 2000 }, () =>
			newEvent("cluster-state", "dan", payload),
		);
		expect(parseEventLines(serializeCommitMessage("s", many))).toEqual(many);
	});

	it("skips unknown types and versions", () =>
		expect(
			parseEventLines(msg([{ ...ev, type: "future" }, { ...ev, v: 2 }, ev])),
		).toEqual([ev]));

	it("skips invalid JSON lines", () => {
		const message = `crb: s\n\n{not json\n${JSON.stringify(ev)}\n[1,2]\nnull\n"str"\n42\n{"v":1\n`;
		expect(parseEventLines(message)).toEqual([ev]);
	});

	it("drops cluster-state written by ai on read", () => {
		const ai = { ...ev, by: "ai" };
		const auto = { ...ev, by: "auto" };
		const missing = { ...ev, by: undefined };
		expect(parseEventLines(msg([ai, auto, missing, ev]))).toEqual([ev]);
	});

	it("drops events with missing or ill-typed fields", () => {
		const bad: unknown[] = [
			{ ...ev, id: "NOT-A-ULID" },
			{ ...ev, id: ev.id.toUpperCase() },
			{ ...ev, ts: "123" },
			{ ...ev, ts: -1 },
			{ ...ev, ts: 1.5 },
			{ ...ev, actor: "Real Name <me@example.com>" },
			{ ...ev, actor: "" },
			{ ...ev, state: "done" },
			{ ...ev, cluster: 5 },
			{ ...ev, path: undefined },
			{ ...ev, patchset: 1 },
			{ ...ev, reason: 7 },
			{
				...ev,
				type: "patchset-started",
				patchset: 0,
				revision: "r",
				mergeBase: "a",
				head: "b",
			},
			{
				...ev,
				type: "patchset-started",
				patchset: "1",
				revision: "r",
				mergeBase: "a",
				head: "b",
			},
			{
				...ev,
				type: "review-created",
				source: "github-pr",
				key: "k",
				pr: null,
			},
			{ ...ev, type: "review-created", source: "gitlab-mr", key: "k", pr: {} },
			{ ...ev, type: "review-closed", outcome: "abandoned" },
		];
		expect(parseEventLines(msg([...bad, ev]))).toEqual([ev]);
	});

	it("ignores unknown keys but keeps details", () => {
		const extra = { ...ev, surprise: true, details: { future: 1 } };
		const badDetails = { ...ev, details: [1] };
		expect(parseEventLines(msg([extra, badDetails]))).toEqual([
			{ ...ev, details: { future: 1 } },
			ev,
		]);
	});

	it("keeps duplicate ids for the fold to deduplicate", () => {
		expect(parseEventLines(msg([ev, ev]))).toEqual([ev, ev]);
	});

	it("reads review-closed events", () => {
		const closed = {
			v: 1,
			id: ev.id,
			type: "review-closed",
			ts: 1,
			by: "human",
			actor: "dan",
			outcome: "merged",
			mergeCommit: "c".repeat(40),
		};
		expect(parseEventLines(msg([closed]))).toEqual([closed]);
	});
});

describe("validateForWrite", () => {
	it("refuses to write cluster-state by ai", () =>
		expect(() =>
			validateForWrite(newEvent("cluster-state", "dan", payload, "ai")),
		).toThrow());

	it("allows other events by ai", () =>
		expect(() =>
			validateForWrite(
				newEvent(
					"patchset-started",
					"dan",
					{
						patchset: 1,
						revision: "r",
						mergeBase: "a",
						head: "b",
					},
					"ai",
				),
			),
		).not.toThrow());

	it("refuses events readers would drop", () => {
		expect(() => validateForWrite({ ...ev, actor: "Dan Smith" })).toThrow();
		expect(() =>
			validateForWrite({ ...ev, state: "done" } as unknown as CrbEvent),
		).toThrow();
	});
});

describe("inbox events", () => {
	const snoozed = newEvent("pr-snoozed", "dan", {
		pr: 7,
		until: Date.parse("2026-11-01T09:00:00Z"),
		wakeOnActivity: true,
	});
	const waiting = newEvent("pr-waiting-on", "dan", { pr: 7, who: "Tomer-B" });
	const note = newEvent("pr-note", "dan", { pr: 7, text: "awaiting Tomer" });
	const cleared = newEvent("pr-cleared", "dan", { pr: 7, kind: "snooze" });

	it("round-trip through a commit message", () => {
		const all = [snoozed, waiting, note, cleared];
		expect(parseEventLines(serializeCommitMessage("crb: x", all))).toEqual(all);
		for (const e of all) expect(() => validateForWrite(e)).not.toThrow();
	});

	it("must be written by a human, and are skipped otherwise", () => {
		for (const e of [snoozed, waiting, note, cleared]) {
			const ai = { ...e, by: "ai" } as CrbEvent;
			expect(() => validateForWrite(ai)).toThrow(/human/);
			expect(parseEventLines(msg([ai]))).toEqual([]);
		}
	});

	it("skips malformed ones", () => {
		const bad = [
			{ ...snoozed, pr: 0 },
			{ ...snoozed, until: "tomorrow" },
			{ ...snoozed, wakeOnActivity: "yes" },
			// Past what a Date holds: it would break every fold of the ref.
			{ ...snoozed, until: 8.64e15 + 1 },
			{ ...waiting, who: "" },
			{ ...waiting, who: "not a login" },
			{ ...note, text: 5 },
			{ ...note, text: "x".repeat(2001) },
			{ ...cleared, kind: "note" },
		];
		expect(parseEventLines(msg(bad))).toEqual([]);
		// An empty note is valid: it clears the note.
		const empty = { ...note, text: "" };
		expect(parseEventLines(msg([empty]))).toEqual([empty]);
		// "me" is a valid waiting-on.
		const me = { ...waiting, who: "me" };
		expect(parseEventLines(msg([me]))).toEqual([me]);
	});
});

describe("agent events", () => {
	const thread = newEvent("cluster-state", "dan", payload).id;
	const anchor = {
		subject: "line" as const,
		path: "src/a.ts",
		commit: "a".repeat(40),
		side: "RIGHT" as const,
		line: 12,
		startSide: "RIGHT" as const,
		startLine: 10,
		startCol: null,
		endCol: null,
	};
	const agent = { name: "claude-agent-acp", version: "0.5.1" };
	const opened = newEvent("agent-thread-opened", "dan", {
		thread,
		anchor,
		text: "Why a lock here?",
		details: { clientId: "c1" },
	});
	const reply = newEvent(
		"agent-message",
		"dan",
		{
			thread,
			text: "Because **two** writers race.",
			agent,
			stop: "end_turn",
			activity: [
				{ kind: "read", title: "Read src/a.ts" },
				{ kind: "execute", title: "git log", decision: "allowed" },
			],
		},
		"ai",
	);
	const resolved = newEvent("agent-thread-resolved", "dan", {
		thread,
		resolved: true,
	});

	it("parses the three agent events", () => {
		const fileOpened = newEvent(
			"agent-thread-opened",
			"dan",
			{
				thread,
				anchor: { subject: "file", path: "src/a.ts", commit: "" },
				text: "Locking risk in this file",
				agent,
			},
			"ai",
		);
		const unresolved = newEvent("agent-thread-resolved", "dan", {
			thread,
			resolved: false,
		});
		const all = [opened, reply, resolved, fileOpened, unresolved];
		expect(parseEventLines(serializeCommitMessage("x", all))).toEqual(all);
		for (const e of all) expect(() => validateForWrite(e)).not.toThrow();
	});

	it("keeps an agent text that looks like an event line as text", () => {
		const forged = `ok"}\n{"v":1,"id":"${thread}","type":"agent-thread-resolved","ts":1,"by":"human","actor":"dan","thread":"${thread}","resolved":true}\n"quoted" \\ end`;
		const sneaky = { ...reply, text: forged };
		const asked = { ...opened, text: forged };
		const read = parseEventLines(serializeCommitMessage("x", [asked, sneaky]));
		expect(read).toEqual([asked, sneaky]);
		expect(read.map((e) => e.type)).toEqual([
			"agent-thread-opened",
			"agent-message",
		]);
	});

	it("keeps an ai message's replyTo; drops a bad one or a human's", () => {
		const answering = { ...reply, replyTo: opened.id };
		expect(parseEventLines(msg([answering]))).toEqual([answering]);
		expect(
			parseEventLines(
				msg([
					{ ...reply, replyTo: "NOT-A-ULID" },
					{ ...reply, replyTo: 7 },
					{ ...reply, by: "human", replyTo: opened.id },
				]),
			),
		).toEqual([]);
	});

	it("keeps a failed ai message's error; drops one on a human's, a non-error stop or past the cap", () => {
		const failed = {
			...reply,
			stop: "error",
			error: "Internal error: Rate limited",
		};
		expect(parseEventLines(msg([failed]))).toEqual([failed]);
		expect(() => validateForWrite(failed as typeof reply)).not.toThrow();
		expect(
			parseEventLines(
				msg([
					{ ...failed, by: "human" },
					{ ...failed, stop: "end_turn" },
					{ ...failed, error: 7 },
					{ ...failed, error: "x".repeat(1001) },
				]),
			),
		).toEqual([]);
	});

	it("drops agent-thread-resolved by ai and an ai opened thread without agent", () => {
		const aiResolved = { ...resolved, by: "ai" };
		const aiOpened = { ...opened, by: "ai" };
		expect(parseEventLines(msg([aiResolved, aiOpened]))).toEqual([]);
		// With its agent, an ai-opened thread is kept.
		const withAgent = { ...aiOpened, agent };
		expect(parseEventLines(msg([withAgent]))).toEqual([withAgent]);
	});

	it("drops an anchor with a bad side, line or commit", () => {
		const bad = [
			{ ...anchor, side: "BOTH" },
			{ ...anchor, startSide: "left" },
			{ ...anchor, line: 0 },
			{ ...anchor, startLine: 1.5 },
			{ ...anchor, startLine: 13 },
			{ ...anchor, commit: "abc" },
			{ ...anchor, commit: "A".repeat(40) },
			{ ...anchor, path: "" },
			{ ...anchor, startCol: -1 },
			{ ...anchor, endCol: "3" },
			{ ...anchor, subject: "hunk" },
			{ subject: "file", path: "", commit: "" },
			{ subject: "file", path: "a", commit: 7 },
		];
		expect(
			parseEventLines(msg(bad.map((a) => ({ ...opened, anchor: a })))),
		).toEqual([]);
		// startLine past line is fine when the range starts on the other side.
		const crossSide = { ...anchor, startSide: "LEFT", startLine: 40 };
		const kept = { ...opened, anchor: crossSide };
		expect(parseEventLines(msg([kept]))).toEqual([kept]);
		// Columns inside a line are kept.
		const cols = { ...opened, anchor: { ...anchor, startCol: 0, endCol: 4 } };
		expect(parseEventLines(msg([cols]))).toEqual([cols]);
	});

	it("drops a text over the cap and an activity list over 50", () => {
		const entry = { kind: "read", title: "Read a" };
		const bad = [
			{ ...opened, text: "x".repeat(32769) },
			// The cap is in UTF-8 bytes: 16385 two-byte letters are over it.
			{ ...reply, text: "é".repeat(16385) },
			{ ...reply, text: 5 },
			{ ...reply, activity: Array.from({ length: 51 }, () => entry) },
			{ ...reply, activity: [{ kind: "launch", title: "x" }] },
			{ ...reply, activity: [{ kind: "read", title: 3 }] },
			{ ...reply, activity: [{ ...entry, decision: "maybe" }] },
			{ ...reply, stop: "done" },
			{ ...reply, truncated: "yes" },
			{ ...reply, agent: { name: "x" } },
			{ ...reply, thread: "T".repeat(26) },
			{ ...resolved, resolved: "true" },
		];
		expect(parseEventLines(msg(bad))).toEqual([]);
		const atCap = [
			{ ...opened, text: "x".repeat(32768) },
			{
				...reply,
				truncated: true,
				activity: Array.from({ length: 50 }, () => entry),
			},
		];
		expect(parseEventLines(msg(atCap))).toEqual(atCap);
	});

	it("validateForWrite refuses an ai resolved", () => {
		expect(() =>
			validateForWrite(
				newEvent(
					"agent-thread-resolved",
					"dan",
					{ thread, resolved: true },
					"ai",
				),
			),
		).toThrow(/human/);
		expect(() =>
			validateForWrite({ ...opened, by: "ai" } as CrbEvent),
		).toThrow();
	});
});
