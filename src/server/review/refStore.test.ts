import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBareRepo } from "../../../test/git-fixture.js";
import { runGit } from "../git.js";
import { type CrbEvent, newEvent } from "./events.js";
import { RefStore } from "./refStore.js";

const ref = "refs/crb/reviews/r1/reviewers/dan/progress";
const all: CrbEvent[] = Array.from({ length: 20 }, (_, i) =>
	newEvent("cluster-state", "dan", {
		patchset: "f".repeat(64),
		cluster: `c${i}`,
		path: "src/a.ts",
		state: "reviewed",
	}),
);
const evN = (i: number) => all[i] as CrbEvent;
const ev = evN(0);

let repo: string;
let cleanup: () => void;
let store: RefStore;

beforeEach(() => {
	({ path: repo, cleanup } = createBareRepo());
	store = new RefStore(repo);
});
afterEach(() => {
	vi.restoreAllMocks();
	cleanup();
});

describe("RefStore", () => {
	it("commits carry only slug and tool identities", async () => {
		await runGit(repo, ["config", "user.name", "Real Name"]);
		await runGit(repo, ["config", "user.email", "real@example.com"]);
		const tip = await store.appendEvent(ref, "crb: test", ev, "dan");
		expect(
			await runGit(repo, ["log", "-1", "--format=%an <%ae>|%cn <%ce>", tip]),
		).toBe("dan <dan@crb>|crb <crb@crb>\n");
		const raw = await runGit(repo, ["cat-file", "-p", tip]);
		expect(raw).not.toContain("real@example.com");
		expect(raw).not.toContain("Real Name");
	});

	it("uses the empty tree", async () => {
		const tip = await store.appendEvent(ref, "crb: test", ev, "dan");
		expect(await runGit(repo, ["cat-file", "-p", `${tip}^{tree}`])).toBe("");
		expect(await store.emptyTree()).toBe(
			(await runGit(repo, ["rev-parse", `${tip}^{tree}`])).trim(),
		);
	});

	it("writes the summary line and one event per commit", async () => {
		const first = await store.appendEvent(ref, "crb: first", ev, "dan");
		const second = await store.appendEvent(ref, "crb: second", evN(1), "dan");
		expect(await store.tip(ref)).toBe(second);
		expect(await runGit(repo, ["rev-list", "--parents", ref])).toBe(
			`${second} ${first}\n${first}\n`,
		);
		expect(await runGit(repo, ["log", "-1", "--format=%B", second])).toBe(
			`crb: second\n\n${JSON.stringify(evN(1))}\n\n`,
		);
	});

	it("reads events oldest first across commits", async () => {
		const events = Array.from({ length: 5 }, (_, i) => evN(i));
		for (const e of events) await store.appendEvent(ref, "s", e, "dan");
		expect(await store.readEvents(ref)).toEqual(events);
	});

	it("reads several events from one commit and skips foreign lines", async () => {
		const events = [evN(1), evN(2)];
		const oid = await store.commit(null, "crb: batch", events, "dan");
		await store.transaction([{ ref, newOid: oid, oldOid: null }]);
		const foreign = await runGit(
			repo,
			["commit-tree", await store.emptyTree(), "-p", oid, "-F", "-"],
			{
				input: `hello\n\nnot an event\n${JSON.stringify({ ...evN(3), by: "ai" })}\n`,
				env: {
					GIT_AUTHOR_NAME: "x",
					GIT_AUTHOR_EMAIL: "x@x",
					GIT_COMMITTER_NAME: "x",
					GIT_COMMITTER_EMAIL: "x@x",
				},
			},
		);
		await store.transaction([{ ref, newOid: foreign.trim(), oldOid: oid }]);
		expect(await store.readEvents(ref)).toEqual(events);
	});

	it("reads nothing from a missing ref", async () => {
		expect(await store.tip(ref)).toBeNull();
		expect(await store.readEvents(ref)).toEqual([]);
	});

	it("concurrent appends keep every event", async () => {
		const events = Array.from({ length: 10 }, (_, i) => evN(i));
		const ids = events.map((e) => e.id);
		const stores = events.map(() => new RefStore(repo));
		const commits = vi.spyOn(RefStore.prototype, "commit");
		await Promise.all(
			events.map((e, i) => stores[i]?.appendEvent(ref, "s", e, "dan")),
		);
		// Writers really collided and retried on the new tip.
		expect(commits.mock.calls.length).toBeGreaterThan(10);
		expect((await store.readEvents(ref)).map((e) => e.id).sort()).toEqual(
			ids.sort(),
		);
		expect(await runGit(repo, ["rev-list", "--merges", ref])).toBe("");
		expect(await runGit(repo, ["rev-list", "--count", ref])).toBe("10\n");
	});

	it("re-commits onto the new tip when the ref moved", async () => {
		const other = new RefStore(repo);
		const original = store.commit.bind(store);
		let moved = false;
		vi.spyOn(store, "commit").mockImplementation(async (...args) => {
			const oid = await original(...args);
			if (!moved) {
				moved = true;
				await other.appendEvent(ref, "other", evN(1), "dan");
			}
			return oid;
		});
		await store.appendEvent(ref, "mine", ev, "dan");
		expect(store.commit).toHaveBeenCalledTimes(2);
		expect(await store.readEvents(ref)).toEqual([evN(1), ev]);
		expect(await runGit(repo, ["rev-list", "--merges", ref])).toBe("");
	});

	it("gives up after 5 tries", async () => {
		const other = new RefStore(repo);
		const original = store.commit.bind(store);
		let n = 0;
		vi.spyOn(store, "commit").mockImplementation(async (...args) => {
			const oid = await original(...args);
			await other.appendEvent(ref, "other", evN(++n), "dan");
			return oid;
		});
		await expect(store.appendEvent(ref, "mine", ev, "dan")).rejects.toThrow();
		expect(store.commit).toHaveBeenCalledTimes(5);
		expect((await store.readEvents(ref)).map((e) => e.id)).not.toContain(ev.id);
	});

	it("refuses to write cluster-state by ai", async () => {
		const ai = newEvent(
			"cluster-state",
			"dan",
			{ patchset: "p", cluster: "c", path: "a", state: "reviewed" },
			"ai",
		);
		await expect(store.appendEvent(ref, "s", ai, "dan")).rejects.toThrow();
		expect(await store.tip(ref)).toBeNull();
	});

	it("refuses author names that aren't slugs", async () => {
		await expect(
			store.commit(null, "s", [ev], "Dan <real@example.com>"),
		).rejects.toThrow();
	});

	it("only writes refs under refs/crb/", async () => {
		await expect(
			store.appendEvent("refs/heads/main", "s", ev, "dan"),
		).rejects.toThrow();
	});

	it("transaction creates several refs at once", async () => {
		const a = await store.commit(null, "a", [evN(1)], "dan");
		const blob = await store.writeBlob("pinned\n");
		await store.transaction([
			{ ref, newOid: a, oldOid: null },
			{ ref: "refs/crb/reviews/r1/meta", newOid: a, oldOid: null },
		]);
		expect(await store.tip(ref)).toBe(a);
		expect(await store.tip("refs/crb/reviews/r1/meta")).toBe(a);
		expect(await runGit(repo, ["cat-file", "-p", blob])).toBe("pinned\n");
	});

	it("transaction fails as a whole when one old value is stale", async () => {
		const meta = "refs/crb/reviews/r1/meta";
		const a = await store.commit(null, "a", [evN(1)], "dan");
		const b = await store.commit(a, "b", [evN(2)], "dan");
		await store.transaction([
			{ ref, newOid: a, oldOid: null },
			{ ref: meta, newOid: a, oldOid: null },
		]);
		await expect(
			store.transaction([
				{ ref, newOid: b, oldOid: a },
				{ ref: meta, newOid: b, oldOid: b },
			]),
		).rejects.toThrow();
		expect(await store.tip(ref)).toBe(a);
		expect(await store.tip(meta)).toBe(a);
		await expect(
			store.transaction([{ ref: "refs/crb/new", newOid: b, oldOid: a }]),
		).rejects.toThrow();
		expect(await store.tip("refs/crb/new")).toBeNull();
	});
});
