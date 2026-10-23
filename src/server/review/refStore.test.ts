import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBareRepo } from "../../../test/git-fixture.js";
import { GitError, inheritedEnv, runGit } from "../git.js";
import { type CrbEvent, newEvent } from "./events.js";
import { RefConflictError, RefStore } from "./refStore.js";

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
		await expect(
			store.appendEvent(ref, "mine", ev, "dan"),
		).rejects.toBeInstanceOf(RefConflictError);
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
		).rejects.toBeInstanceOf(RefConflictError);
		expect(await store.tip(ref)).toBe(a);
		expect(await store.tip(meta)).toBe(a);
		await expect(
			store.transaction([{ ref: "refs/crb/new", newOid: b, oldOid: a }]),
		).rejects.toBeInstanceOf(RefConflictError);
		expect(await store.tip("refs/crb/new")).toBeNull();
	});

	it("fails fast on errors that aren't lost races", async () => {
		await store.appendEvent("refs/crb/a", "s", ev, "dan");
		const commits = vi.spyOn(store, "commit");
		// refs/crb/a exists, so refs/crb/a/b can never be created.
		const error = await store
			.appendEvent("refs/crb/a/b", "s", evN(1), "dan")
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(GitError);
		expect(error).not.toBeInstanceOf(RefConflictError);
		expect(commits).toHaveBeenCalledTimes(1);
	});

	it("rejects invalid ref names before running git", async () => {
		const commits = vi.spyOn(store, "commit");
		await expect(
			store.appendEvent("refs/crb/x.lock", "s", ev, "dan"),
		).rejects.toThrow(/Not a valid crb ref/);
		expect(commits).not.toHaveBeenCalled();
		expect(await runGit(repo, ["for-each-ref"])).toBe("");
	});

	it("accepts exactly the crb refs git accepts", async () => {
		const names = [
			"refs/crb/x.lock",
			"refs/crb/.hidden",
			"refs/crb/a..b",
			"refs/crb/a//b",
			"refs/crb/a/",
			"refs/crb/a.",
			"refs/crb/a b",
			"refs/crb/a@{1}",
			"refs/crb/lookup/github-pr/0123abcd",
			"refs/crb/reviews/01jb/reviewers/dan-2/patchsets/3",
			"refs/crb/a.b/c_d-E",
		];
		for (const name of names) {
			let gitOk = true;
			try {
				execFileSync("git", ["check-ref-format", name]);
			} catch {
				gitOk = false;
			}
			const oursOk = await store.tip(name).then(
				() => true,
				() => false,
			);
			expect({ name, ok: oursOk }).toEqual({ name, ok: gitOk });
		}
	});

	it("ignores inherited GIT_* variables that would redirect writes", async () => {
		const other = createBareRepo();
		const saved = { ...process.env };
		try {
			const before = execFileSync(
				"git",
				["-C", other.path, "count-objects", "-v"],
				{
					encoding: "utf8",
				},
			);
			Object.assign(process.env, {
				GIT_DIR: other.path,
				GIT_NAMESPACE: "evil",
				GIT_COMMITTER_DATE: "2005-04-07T22:13:13Z",
				GIT_AUTHOR_DATE: "2005-04-07T22:13:13Z",
				GIT_AUTHOR_EMAIL: "real@example.com",
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "user.email",
				GIT_CONFIG_VALUE_0: "real@example.com",
			});
			const tip = await store.appendEvent(ref, "s", ev, "dan");
			process.env = saved;
			expect(
				await runGit(repo, [
					"for-each-ref",
					"--format=%(refname) %(objectname)",
				]),
			).toBe(`${ref} ${tip}\n`);
			const [ct, at, email] = (
				await runGit(repo, ["log", "-1", "--format=%ct|%at|%ae", tip])
			)
				.trim()
				.split("|");
			const now = Date.now() / 1000;
			expect(Math.abs(Number(ct) - now)).toBeLessThan(300);
			expect(Math.abs(Number(at) - now)).toBeLessThan(300);
			expect(email).toBe("dan@crb");
			expect(await runGit(other.path, ["for-each-ref"])).toBe("");
			expect(
				execFileSync("git", ["-C", other.path, "count-objects", "-v"], {
					encoding: "utf8",
				}),
			).toBe(before);
		} finally {
			process.env = saved;
			other.cleanup();
		}
	});

	it("keeps the inherited config-location variables, drops injected config", async () => {
		const dir = mkdtempSync(join(tmpdir(), "crb-gitconfig-"));
		const global = join(dir, "global");
		writeFileSync(global, "[crb]\n\tprobe = from-global\n");
		const saved = { ...process.env };
		try {
			Object.assign(process.env, {
				GIT_CONFIG_GLOBAL: global,
				GIT_CONFIG_SYSTEM: "/nonexistent-system-config",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "crb.injected",
				GIT_CONFIG_VALUE_0: "yes",
				GIT_CONFIG_PARAMETERS: "'crb.params'='yes'",
			});
			const env = inheritedEnv();
			expect(env.GIT_CONFIG_GLOBAL).toBe(global);
			expect(env.GIT_CONFIG_SYSTEM).toBe("/nonexistent-system-config");
			expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
			for (const name of [
				"GIT_CONFIG_COUNT",
				"GIT_CONFIG_KEY_0",
				"GIT_CONFIG_VALUE_0",
				"GIT_CONFIG_PARAMETERS",
			]) {
				expect(env[name]).toBeUndefined();
			}
			expect(await runGit(repo, ["config", "--get", "crb.probe"])).toBe(
				"from-global\n",
			);
			for (const key of ["crb.injected", "crb.params"]) {
				expect(
					await runGit(repo, ["config", "--get", key], { allowFailure: true }),
				).toBe("");
			}
		} finally {
			process.env = saved;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads UTF-8 whatever the log output encoding is", async () => {
		await runGit(repo, ["config", "i18n.logOutputEncoding", "ISO-8859-1"]);
		await runGit(repo, ["config", "i18n.commitEncoding", "ISO-8859-1"]);
		const e = newEvent("cluster-state", "dan", {
			patchset: "f".repeat(64),
			cluster: "c",
			path: "docs/über.md",
			state: "reviewed",
		});
		await store.appendEvent(ref, "crb: reviewed docs/über.md", e, "dan");
		expect(await store.readEvents(ref)).toEqual([e]);
	});

	it("reads history as stored, ignoring replace refs", async () => {
		const first = await store.appendEvent(ref, "s", ev, "dan");
		const fake = await store.commit(null, "fake", [evN(5)], "dan");
		await runGit(repo, ["update-ref", `refs/replace/${first}`, fake]);
		expect(await store.readEvents(ref)).toEqual([ev]);
	});
});
