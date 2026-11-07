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

describe("re-review events", () => {
	const K = "a".repeat(64);
	const K2 = "b".repeat(64);
	const K3 = "c".repeat(64);
	const carried = newEvent(
		"carried",
		"dan",
		{
			from: 1,
			to: 2,
			rule: "exact",
			states: [
				{ key: K, fromKey: K2, state: "reviewed" },
				{ key: `${K3}:2`, fromKey: `${K3}:3`, state: "crossed-off" },
			],
		},
		"auto",
	);
	const anchor = {
		path: "src/a.ts",
		startSide: "RIGHT" as const,
		startLine: 3,
		side: "RIGHT" as const,
		line: 5,
	};
	const placed = newEvent("thread-placed", "dan", {
		thread: "PRRT_x",
		patchset: 2,
		anchor,
		engine: 1,
	});
	const startedFull = newEvent("patchset-started", "dan", {
		patchset: 2,
		revision: "r".repeat(64),
		mergeBase: "a".repeat(40),
		head: "b".repeat(40),
		since: 1,
		shape: "S4b",
		baseBranch: "main",
		interdiff: "available",
	});

	it("round-trip through a commit message", () => {
		const all = [carried, placed, startedFull];
		expect(parseEventLines(serializeCommitMessage("crb: x", all))).toEqual(all);
		for (const e of all) expect(() => validateForWrite(e)).not.toThrow();
		expect(carried.by).toBe("auto");
		expect(placed.by).toBe("human");
	});

	it("thread-placed may be by ai, never by auto", () => {
		const ai = { ...placed, by: "ai" as const };
		expect(parseEventLines(msg([ai]))).toEqual([ai]);
		expect(() => validateForWrite(ai)).not.toThrow();
		const auto = { ...placed, by: "auto" } as CrbEvent;
		expect(parseEventLines(msg([auto]))).toEqual([]);
		expect(() => validateForWrite(auto)).toThrow(/human or ai/);
	});

	it("carried must be by auto: human and ai ones are dropped and refused", () => {
		for (const by of ["human", "ai"] as const) {
			const e = { ...carried, by } as CrbEvent;
			expect(parseEventLines(msg([e]))).toEqual([]);
			expect(() => validateForWrite(e)).toThrow(/auto/);
		}
	});

	it("cluster-state by auto is dropped and refused", () => {
		const auto = { ...ev, by: "auto" } as CrbEvent;
		expect(parseEventLines(msg([auto]))).toEqual([]);
		expect(() => validateForWrite(auto)).toThrow(/human/);
		expect(() =>
			validateForWrite(newEvent("cluster-state", "dan", payload, "auto")),
		).toThrow(/human/);
	});

	it("skips malformed carried events", () => {
		const entry = { key: K, fromKey: K2, state: "reviewed" };
		const bad: unknown[] = [
			{ ...carried, states: [{ ...entry, state: "unreviewed" }] },
			{ ...carried, states: [{ ...entry, state: "done" }] },
			{ ...carried, states: [{ ...entry, key: "k1" }] },
			{ ...carried, states: [{ ...entry, fromKey: `${K2}:x` }] },
			{ ...carried, states: [{ ...entry, key: K.toUpperCase() }] },
			{ ...carried, states: [entry, { key: K3 }] },
			{ ...carried, states: entry },
			{ ...carried, states: undefined },
			{ ...carried, from: 2, to: 2 },
			{ ...carried, from: 3, to: 2 },
			{ ...carried, from: 0, to: 1 },
			{ ...carried, from: "1" },
			{ ...carried, to: 1.5 },
			{ ...carried, rule: "fuzzy" },
			{ ...carried, rule: undefined },
		];
		expect(parseEventLines(msg([...bad, carried]))).toEqual([carried]);
		expect(() =>
			validateForWrite({
				...carried,
				states: [{ ...entry, state: "unreviewed" }],
			} as unknown as CrbEvent),
		).toThrow();
		// An empty list is valid: nothing carried under that rule.
		const empty = { ...carried, states: [] };
		expect(parseEventLines(msg([empty]))).toEqual([empty]);
	});

	it("skips malformed thread-placed events", () => {
		const bad: unknown[] = [
			{ ...placed, thread: "" },
			{ ...placed, thread: 7 },
			{ ...placed, patchset: 0 },
			{ ...placed, patchset: "2" },
			{ ...placed, engine: 0 },
			{ ...placed, engine: 1.5 },
			{ ...placed, engine: "1" },
			{ ...placed, anchor: null },
			{ ...placed, anchor: { ...anchor, path: "" } },
			{ ...placed, anchor: { ...anchor, side: "left" } },
			{ ...placed, anchor: { ...anchor, startSide: undefined } },
			{ ...placed, anchor: { ...anchor, line: 0 } },
			{ ...placed, anchor: { ...anchor, startLine: -1 } },
			{ ...placed, anchor: { ...anchor, startLine: "3" } },
		];
		expect(parseEventLines(msg([...bad, placed]))).toEqual([placed]);
		expect(() =>
			validateForWrite({ ...placed, engine: 0 } as unknown as CrbEvent),
		).toThrow();
	});

	it("patchset-started parses without the new fields, and drops ill-typed ones", () => {
		const old = newEvent("patchset-started", "dan", {
			patchset: 1,
			revision: "r".repeat(64),
			mergeBase: "a".repeat(40),
			head: "b".repeat(40),
		});
		expect(parseEventLines(msg([old]))).toEqual([old]);
		expect(parseEventLines(msg([old]))[0]).not.toHaveProperty("since");
		const bad: unknown[] = [
			{ ...startedFull, since: 0 },
			{ ...startedFull, since: "1" },
			{ ...startedFull, since: 2 },
			{ ...startedFull, shape: "S2" },
			{ ...startedFull, shape: 4 },
			{ ...startedFull, baseBranch: "" },
			{ ...startedFull, baseBranch: 1 },
			{ ...startedFull, interdiff: "maybe" },
		];
		expect(parseEventLines(msg([...bad, startedFull]))).toEqual([startedFull]);
		// A since of n-1 is the usual; any earlier patch set is allowed too.
		const sinceEarlier = { ...startedFull, patchset: 3, since: 1 };
		expect(parseEventLines(msg([sinceEarlier]))).toEqual([sinceEarlier]);
	});
});
