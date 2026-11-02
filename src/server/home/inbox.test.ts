import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testGitEnv } from "../../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../../test/pr-fixture";
import type { Annotations } from "../../shared/home.js";
import { clonePath, ensureClone } from "../clone.js";
import { type CrbEvent, newEvent } from "../review/events.js";
import { RefStore } from "../review/refStore.js";
import { ReviewService } from "../review/reviews.js";
import {
	foldInbox,
	hiddenReason,
	InboxStore,
	inboxRef,
	opEvents,
	WOKE_MS,
	waitHolds,
	wokeOf,
} from "./inbox.js";

// Each fake gh call is a node process: give a loaded machine time.
vi.setConfig({ testTimeout: 30_000 });

const T0 = Date.parse("2026-10-29T12:00:00Z");
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const snooze = (pr: number, until: number, wake: boolean, ts: number) =>
	newEvent(
		"pr-snoozed",
		"dan",
		{ pr, until, wakeOnActivity: wake },
		"human",
		ts,
	);
const wait = (pr: number, who: string, ts: number) =>
	newEvent("pr-waiting-on", "dan", { pr, who }, "human", ts);
const note = (pr: number, text: string, ts: number) =>
	newEvent("pr-note", "dan", { pr, text }, "human", ts);
const clear = (pr: number, kind: "snooze" | "waiting", ts: number) =>
	newEvent("pr-cleared", "dan", { pr, kind }, "human", ts);

describe("foldInbox", () => {
	it("last event per (PR, kind) wins, whatever order the events come in", () => {
		const events = [
			snooze(1, T0 + 24 * H, true, T0),
			note(1, "first", T0 + 1),
			snooze(1, T0 + 48 * H, false, T0 + 2),
			note(1, "second", T0 + 3),
			wait(1, "bob", T0 + 4),
			note(2, "other PR", T0 + 5),
		];
		const want = new Map<number, Annotations>([
			[
				1,
				{
					snooze: {
						until: iso(T0 + 48 * H),
						wakeOnActivity: false,
						at: iso(T0 + 2),
					},
					waiting: { who: "bob", at: iso(T0 + 4) },
					note: "second",
				},
			],
			[2, { note: "other PR" }],
		]);
		expect(foldInbox(events)).toEqual(want);
		expect(foldInbox([...events].reverse())).toEqual(want);
		expect(foldInbox([...events, ...events])).toEqual(want);
	});

	it("cleared removes its kind; an empty note clears the note", () => {
		const folded = foldInbox([
			snooze(1, T0 + H, true, T0),
			wait(1, "bob", T0),
			note(1, "x", T0),
			clear(1, "snooze", T0 + 1),
			note(1, "", T0 + 2),
		]);
		expect(folded.get(1)).toEqual({ waiting: { who: "bob", at: iso(T0) } });
		// A snooze after the clear counts again.
		const again = foldInbox([
			clear(1, "snooze", T0),
			snooze(1, T0 + H, true, T0 + 1),
		]);
		expect(again.get(1)?.snooze?.until).toBe(iso(T0 + H));
	});

	it("an empty PR entry is dropped", () => {
		expect(foldInbox([note(1, "x", T0), note(1, "", T0 + 1)]).size).toBe(0);
	});

	it("an until out of range is skipped on read, not the whole fold", () => {
		const bad = {
			...snooze(1, 9e15, true, T0),
			id: "01jbzzzzzzzzzzzzzzzzzzzzzz",
		};
		const folded = foldInbox([
			note(1, "kept", T0),
			bad as CrbEvent,
			note(2, "too", T0 + 1),
		]);
		expect(folded.get(1)).toEqual({ note: "kept" });
		expect(folded.get(2)).toEqual({ note: "too" });
	});

	it("skips events that aren't the inbox's", () => {
		const other = newEvent("patchset-started", "dan", {
			patchset: 1,
			revision: "r",
			mergeBase: "a".repeat(40),
			head: "b".repeat(40),
		});
		expect(foldInbox([other as CrbEvent]).size).toBe(0);
	});
});

describe("opEvents", () => {
	it("wake clears both snooze and waiting", () => {
		const events = opEvents("dan", 3, { op: "wake" }, T0);
		expect(events.map((e) => [e.type, "kind" in e ? e.kind : null])).toEqual([
			["pr-cleared", "snooze"],
			["pr-cleared", "waiting"],
		]);
		expect(events.every((e) => e.by === "human" && e.pr === 3)).toBe(true);
	});
	it("maps snooze, wait and note", () => {
		const [s] = opEvents(
			"dan",
			3,
			{ op: "snooze", until: iso(T0 + H), wakeOnActivity: false },
			T0,
		);
		expect(s).toMatchObject({
			type: "pr-snoozed",
			until: T0 + H,
			wakeOnActivity: false,
			ts: T0,
		});
		expect(opEvents("dan", 3, { op: "wait", who: "bob" }, T0)[0]).toMatchObject(
			{
				type: "pr-waiting-on",
				who: "bob",
			},
		);
		expect(
			opEvents("dan", 3, { op: "note", text: " hi " }, T0)[0],
		).toMatchObject({
			type: "pr-note",
			text: "hi",
		});
	});
});

const facts = (
	updatedAt: number,
	lastActivity: Record<string, number> = {},
) => ({
	updatedAt: iso(updatedAt),
	lastActivity: Object.fromEntries(
		Object.entries(lastActivity).map(([k, v]) => [k, iso(v)]),
	),
});
const snoozed = (
	until: number,
	wakeOnActivity: boolean,
	at = T0,
): Annotations => ({
	snooze: { until: iso(until), wakeOnActivity, at: iso(at) },
});

describe("hiddenReason", () => {
	it("a snooze hides until its date", () => {
		const a = snoozed(T0 + 24 * H, true);
		expect(hiddenReason(a, facts(T0 - H), T0 + H)).toBe("snoozed");
		expect(hiddenReason(a, facts(T0 - H), T0 + 24 * H - 1)).toBe("snoozed");
		expect(hiddenReason(a, facts(T0 - H), T0 + 24 * H)).toBe(null);
	});

	it("wakes on activity strictly after the snooze (equal does not)", () => {
		const a = snoozed(T0 + 24 * H, true);
		expect(hiddenReason(a, facts(T0), T0 + H)).toBe("snoozed");
		expect(hiddenReason(a, facts(T0 + 1000), T0 + H)).toBe(null);
	});

	it("without wakeOnActivity, activity doesn't wake it", () => {
		const a = snoozed(T0 + 24 * H, false);
		expect(hiddenReason(a, facts(T0 + H), T0 + 2 * H)).toBe("snoozed");
	});

	it("waiting hides until the named login acts after it", () => {
		const a: Annotations = { waiting: { who: "Bob", at: iso(T0) } };
		expect(hiddenReason(a, facts(T0 + H), T0 + 2 * H)).toBe("waiting");
		// Someone else's activity doesn't clear it.
		expect(hiddenReason(a, facts(T0 + H, { carol: T0 + H }), T0 + 2 * H)).toBe(
			"waiting",
		);
		// Bob's activity before the annotation, or at its moment, doesn't either.
		expect(hiddenReason(a, facts(T0 + H, { bob: T0 }), T0 + 2 * H)).toBe(
			"waiting",
		);
		expect(hiddenReason(a, facts(T0 + H, { bob: T0 + 1 }), T0 + 2 * H)).toBe(
			null,
		);
	});

	it("waiting on the viewer's own login (me) never hides; a user named me is anyone", () => {
		expect(
			hiddenReason(
				{ waiting: { who: "Dan", at: iso(T0) } },
				facts(T0),
				T0,
				"dan",
			),
		).toBe(null);
		expect(
			hiddenReason(
				{ waiting: { who: "me", at: iso(T0) } },
				facts(T0),
				T0,
				"dan",
			),
		).toBe("waiting");
	});

	it("waitHolds: a wait holds under a snooze too", () => {
		const a: Annotations = {
			...snoozed(T0 + 24 * H, false),
			waiting: { who: "bob", at: iso(T0) },
		};
		expect(hiddenReason(a, facts(T0), T0 + 1, "dan")).toBe("snoozed");
		expect(waitHolds(a, facts(T0), "dan")).toBe(true);
		expect(waitHolds(a, facts(T0, { bob: T0 + 5 }), "dan")).toBe(false);
		expect(
			waitHolds({ waiting: { who: "dan", at: iso(T0) } }, facts(T0), "dan"),
		).toBe(false);
	});

	it("snoozed comes before waiting; nothing annotated hides nothing", () => {
		const a: Annotations = {
			...snoozed(T0 + H, false),
			waiting: { who: "bob", at: iso(T0) },
		};
		expect(hiddenReason(a, facts(T0), T0 + 1)).toBe("snoozed");
		expect(hiddenReason({ note: "x" }, facts(T0), T0)).toBe(null);
	});
});

describe("wokeOf", () => {
	it("by time, for 24 hours after the date", () => {
		const a = snoozed(T0 + H, true);
		expect(wokeOf(a, facts(T0 - H), T0 + H - 1)).toBe(null);
		expect(wokeOf(a, facts(T0 - H), T0 + H)).toEqual({
			at: iso(T0 + H),
			by: "time",
		});
		expect(wokeOf(a, facts(T0 - H), T0 + H + WOKE_MS - 1)).not.toBe(null);
		expect(wokeOf(a, facts(T0 - H), T0 + H + WOKE_MS)).toBe(null);
	});

	it("by activity, when the snooze allows it", () => {
		const a = snoozed(T0 + 24 * H, true);
		expect(wokeOf(a, facts(T0 + 2 * H), T0 + 3 * H)).toEqual({
			at: iso(T0 + 2 * H),
			by: "activity",
		});
		expect(
			wokeOf(snoozed(T0 + 24 * H, false), facts(T0 + 2 * H), T0 + 3 * H),
		).toBe(null);
	});

	it("a wait the person ended", () => {
		const a: Annotations = { waiting: { who: "bob", at: iso(T0) } };
		expect(wokeOf(a, facts(T0 + H, { bob: T0 + H }), T0 + 2 * H)).toEqual({
			at: iso(T0 + H),
			by: "activity",
		});
		expect(wokeOf(a, facts(T0 + H), T0 + 2 * H)).toBe(null);
	});

	it("still hidden: not woke", () => {
		expect(wokeOf(snoozed(T0 + 24 * H, true), facts(T0), T0 + H)).toBe(null);
		expect(wokeOf({}, facts(T0), T0)).toBe(null);
	});
});

describe("InboxStore (git)", () => {
	let pr: PrFixture;
	beforeEach(() => {
		pr = createPrFixture();
	});
	afterEach(() => pr.cleanup());
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: testGitEnv(),
		}).trim();

	it("reads nothing for a repo never cloned, and makes no repo doing so", async () => {
		const inbox = new InboxStore();
		expect((await inbox.read("dan", "acme", "widget")).size).toBe(0);
		expect(existsSync(clonePath("acme", "widget"))).toBe(false);
	});

	it("writes into a bare repo with no project objects, then a clone keeps it", async () => {
		const inbox = new InboxStore();
		const row = await inbox.append("dan", "acme", "widget", 12, {
			op: "note",
			text: "awaiting Tomer",
		});
		expect(row).toEqual({ note: "awaiting Tomer" });
		const path = clonePath("acme", "widget");
		// No clone happened: only crb's own (empty-tree) objects are there.
		expect(pr.ghLog()).not.toMatch(/repo clone/);
		expect(git(path, "for-each-ref", "--format=%(refname)")).toBe(
			inboxRef("dan"),
		);
		expect(
			git(path, "log", "--format=%an <%ae>|%cn <%ce>|%s", inboxRef("dan")),
		).toBe("dan <dan@crb>|crb <crb@crb>|crb: note on #12");

		// A review's first open clones the project into the same repo.
		await ensureClone("acme", "widget");
		expect(pr.ghLog()).toMatch(/repo clone/);
		const reviews = new ReviewService(new RefStore(path));
		const meta = {
			owner: "acme",
			repo: "widget",
			number: 12,
			url: "https://github.com/acme/widget/pull/12",
			baseBranch: "main",
			headBranch: "feature",
			headRepo: "acme/widget",
		};
		const id = await reviews.findOrCreateReview(meta, "dan");
		expect(await new ReviewService(new RefStore(path)).findReview(meta)).toBe(
			id,
		);
		await inbox.append("dan", "acme", "widget", 12, {
			op: "wait",
			who: "tomer",
		});
		const folded = await inbox.read("dan", "acme", "widget");
		expect(folded.get(12)).toMatchObject({
			note: "awaiting Tomer",
			waiting: { who: "tomer" },
		});
	});

	it("two writers racing keep every event (compare-and-swap)", async () => {
		const a = new InboxStore();
		const b = new InboxStore();
		await a.append("dan", "acme", "widget", 1, { op: "note", text: "seed" });
		await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				(i % 2 ? a : b).append("dan", "acme", "widget", 100 + i, {
					op: "note",
					text: `n${i}`,
				}),
			),
		);
		const folded = await new InboxStore().read("dan", "acme", "widget");
		expect(folded.size).toBe(11);
		const path = clonePath("acme", "widget");
		expect(git(path, "rev-list", "--merges", inboxRef("dan"))).toBe("");
		expect(git(path, "rev-list", "--count", inboxRef("dan"))).toBe("11");
	});

	it("wake is one commit of two events", async () => {
		const inbox = new InboxStore();
		await inbox.append("dan", "acme", "widget", 5, {
			op: "snooze",
			until: iso(Date.now() + H),
			wakeOnActivity: true,
		});
		await inbox.append("dan", "acme", "widget", 5, { op: "wait", who: "bob" });
		expect(
			await inbox.append("dan", "acme", "widget", 5, { op: "wake" }),
		).toEqual({});
		const path = clonePath("acme", "widget");
		expect(git(path, "rev-list", "--count", inboxRef("dan"))).toBe("3");
	});

	it("refuses an invalid slug", async () => {
		await expect(
			new InboxStore().append("Dan Real", "acme", "widget", 1, { op: "wake" }),
		).rejects.toThrow();
	});
});
