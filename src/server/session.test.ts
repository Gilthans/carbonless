import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	prView,
	reviewThread,
	threadComment,
} from "../../test/fake-gh/scenario";
import { testGitEnv } from "../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import { clonePath } from "./clone";
import { GhError } from "./errors";
import { StaleSnapshotError } from "./review/reviews";
import { refusal, Session } from "./session";

describe("Session", () => {
	let pr: PrFixture;

	beforeEach(() => {
		pr = createPrFixture();
	});
	afterEach(() => pr.cleanup());

	const firstKey = (s: Session) => {
		const key = s.snapshot().files[0]?.clusters[0]?.key;
		if (!key) throw new Error("no cluster");
		return key;
	};

	it("opens a PR on merge-base → head with no patch set", async () => {
		const s = await Session.open(pr.arg, process.cwd());
		expect(s.info()).toEqual({
			pr: {
				owner: "acme",
				repo: "widget",
				number: 12,
				title: "Add widget cache",
				url: "https://github.com/acme/widget/pull/12",
			},
			viewer: "octo-cat",
			snapshotHead: pr.head(),
			currentHead: pr.head(),
			headMoved: false,
			patchset: null,
			asOf: null,
		});
		expect(s.snapshot().base).toBe(pr.mergeBase);
		expect(s.snapshot().files.map((f) => f.path)).toEqual(["a.txt", "new.txt"]);
		const view = await s.review();
		expect(view.progress.clusters).toEqual({
			total: 3,
			reviewed: 0,
			crossedOff: 0,
		});
	});

	it("resolves a bare PR number through the repo in cwd", async () => {
		const s = await Session.open("12", process.cwd());
		expect(s.info().pr.number).toBe(12);
	});

	/** GitHub reports the PR as `state` (by default merged, at its head). */
	const land = (state: "MERGED" | "CLOSED" = "MERGED") => {
		if (state === "MERGED") pr.moveMain();
		pr.scenario({
			prs: {
				12: {
					view: prView({ headRefOid: pr.head(), baseRefName: "main", state }),
				},
			},
		});
	};

	it("refuses a PR GitHub reports merged", async () => {
		land();
		await expect(Session.open(pr.arg, process.cwd())).rejects.toThrow(
			"PR acme/widget#12 is already merged; nothing to review",
		);
	});

	it("refuses a closed PR", async () => {
		land("CLOSED");
		await expect(Session.open(pr.arg, process.cwd())).rejects.toThrow(
			"PR acme/widget#12 is closed; reopen it on GitHub to review",
		);
	});

	it("words a refusal by GitHub's state, neutrally for an open PR", () => {
		const meta = { owner: "acme", repo: "widget", number: 12 };
		expect(refusal({ ...meta, state: "MERGED" })).toBe(
			"PR acme/widget#12 is already merged; nothing to review",
		);
		expect(refusal({ ...meta, state: "CLOSED" })).toBe(
			"PR acme/widget#12 is closed; reopen it on GitHub to review",
		);
		expect(refusal({ ...meta, state: "OPEN" })).toBe(
			"Could not open the review of PR acme/widget#12",
		);
	});

	it("refuses a squash-merged PR, though its head isn't in the base", async () => {
		pr.scenario({
			prs: {
				12: {
					view: prView({
						headRefOid: pr.head(),
						baseRefName: "main",
						state: "MERGED",
					}),
				},
			},
		});
		await expect(Session.open(pr.arg, process.cwd())).rejects.toThrow(
			"already merged",
		);
	});

	it("opens an open PR whose head is already in the base, with no changes", async () => {
		pr.moveMain();
		const s = await Session.open(pr.arg, process.cwd());
		expect(s.snapshot()).toMatchObject({ base: pr.head(), head: pr.head() });
		expect(s.snapshot().files).toEqual([]);
	});

	it("refuses a merged PR without creating a review", async () => {
		land();
		await expect(Session.open(pr.arg, process.cwd())).rejects.toThrow(
			"already merged",
		);
		const clone = clonePath("acme", "widget");
		expect(
			execFileSync("git", ["-C", clone, "for-each-ref", "refs/crb"], {
				encoding: "utf8",
				env: testGitEnv(),
			}),
		).toBe("");
	});

	it("opens a started review even once the PR is merged", async () => {
		const s = await Session.open(pr.arg, process.cwd());
		const reviewed = pr.head();
		await s.setStates(s.snapshot().revision, [
			{ key: firstKey(s), state: "reviewed" },
		]);
		land();
		const again = await Session.open(pr.arg, process.cwd());
		expect(again.info()).toMatchObject({
			snapshotHead: reviewed,
			currentHead: reviewed,
			headMoved: false,
			patchset: 1,
		});
		expect(again.snapshot().base).toBe(pr.mergeBase);
		expect((await again.review()).progress.clusters.reviewed).toBe(1);
	});

	it("keeps an unstarted review's snapshot when the PR is merged at a new head", async () => {
		const s = await Session.open(pr.arg, process.cwd());
		const before = s.snapshot();
		const newHead = pr.moveHead({ "later.txt": "later\n" });
		land();
		expect(await s.refresh()).toMatchObject({
			snapshotHead: before.head,
			currentHead: newHead,
			headMoved: true,
			patchset: null,
		});
		expect(s.snapshot()).toBe(before);
	});

	it("reports startup progress: cloning only on the first open", async () => {
		const first: string[] = [];
		await Session.open(pr.arg, process.cwd(), (m) => first.push(m));
		expect(first).toEqual(["cloning acme/widget…", "fetching PR #12…"]);
		const second: string[] = [];
		await Session.open(pr.arg, process.cwd(), (m) => second.push(m));
		expect(second).toEqual(["fetching PR #12…"]);
	});

	it("names a logged out gh", async () => {
		pr.scenario({ loggedOut: true });
		const open = Session.open(pr.arg, process.cwd());
		await expect(open).rejects.toBeInstanceOf(GhError);
		await expect(open).rejects.toThrow("gh is not logged in");
	});

	it("moves an unstarted review to the new head on refresh", async () => {
		const s = await Session.open(pr.arg, process.cwd());
		const newHead = pr.moveHead({ "later.txt": "later\n" });
		expect(await s.refresh()).toMatchObject({
			snapshotHead: newHead,
			currentHead: newHead,
			headMoved: false,
			patchset: null,
		});
		expect(s.snapshot().files.map((f) => f.path)).toContain("later.txt");
	});

	it("keeps a started review on its patch set when the PR moves", async () => {
		const s = await Session.open(pr.arg, process.cwd());
		const oldHead = pr.head();
		const view = await s.setStates(s.snapshot().revision, [
			{ key: firstKey(s), state: "reviewed" },
		]);
		expect(view.patchset).toBe(1);
		expect(view.progress.clusters.reviewed).toBe(1);

		const newHead = pr.moveHead({ "later.txt": "later\n" });
		expect(await s.checkHead()).toMatchObject({
			snapshotHead: oldHead,
			currentHead: newHead,
			headMoved: true,
		});
		expect(await s.refresh()).toMatchObject({
			snapshotHead: oldHead,
			currentHead: newHead,
			headMoved: true,
			patchset: 1,
		});
		expect((await s.review()).progress.clusters.reviewed).toBe(1);

		// A new session resumes on the patch set, not the PR's new head.
		const again = await Session.open(pr.arg, process.cwd());
		expect(again.info()).toMatchObject({
			snapshotHead: oldHead,
			headMoved: true,
			patchset: 1,
		});
		expect((await again.review()).progress.clusters.reviewed).toBe(1);
	});

	it("rejects a write against a head the session has moved off", async () => {
		const s = await Session.open(pr.arg, process.cwd());
		const old = s.snapshot().revision;
		const key = firstKey(s);
		pr.moveHead({ "later.txt": "later\n" });
		await s.refresh();
		await expect(
			s.setStates(old, [{ key, state: "reviewed" }]),
		).rejects.toBeInstanceOf(StaleSnapshotError);
		await expect(s.fileHunks(old, 0)).rejects.toBeInstanceOf(
			StaleSnapshotError,
		);
		await expect(s.context(old, 0, 1, 2)).rejects.toBeInstanceOf(
			StaleSnapshotError,
		);
		expect(s.info().patchset).toBeNull();
	});

	it("rejects a write against a base the session has moved off", async () => {
		const first = pr.head();
		pr.moveHead({ "later.txt": "later\n" });
		const s = await Session.open(pr.arg, process.cwd());
		const old = s.snapshot().revision;
		const key = firstKey(s);
		// main takes the PR's first commit: same head, new merge base.
		pr.moveMain(first);
		await s.refresh();
		expect(s.snapshot()).toMatchObject({ base: first, head: pr.head() });
		await expect(
			s.setStates(old, [{ key, state: "reviewed" }]),
		).rejects.toBeInstanceOf(StaleSnapshotError);
		expect(s.info().patchset).toBeNull();
	});

	it("keeps a refresh's head over a slower check that started before it", async () => {
		const s = await Session.open(pr.arg, process.cwd());
		pr.scenario({
			prs: {
				12: { view: prView({ headRefOid: pr.head(), baseRefName: "main" }) },
			},
			prViewDelayMs: 1500,
		});
		const views = () => (pr.ghLog().match(/^pr view /gm) ?? []).length;
		const before = views();
		const check = s.checkHead();
		// The check's gh has read the old head and is now sleeping.
		await vi.waitFor(() => expect(views()).toBe(before + 1), {
			timeout: 5000,
		});
		const newHead = pr.moveHead({ "later.txt": "later\n" });
		expect((await s.refresh()).currentHead).toBe(newHead);
		expect((await check).currentHead).toBe(newHead);
		expect(s.info()).toMatchObject({
			currentHead: newHead,
			snapshotHead: newHead,
		});
	});

	describe("overview", () => {
		/** gh calls reading the overview (its `pr view` asks for the author). */
		const reads = () => (pr.ghLog().match(/^pr view .*author/gm) ?? []).length;
		const titled = (title: string) =>
			pr.scenario({
				prs: {
					12: {
						view: prView({
							headRefOid: pr.head(),
							baseRefName: "main",
							title,
						}),
					},
				},
			});

		it("keeps the last read: served again without gh, or read anew past maxAge", async () => {
			const s = await Session.open(pr.arg, process.cwd());
			const [a, b] = await Promise.all([s.overview(), s.overview()]);
			expect(a).toBe(b);
			expect(reads()).toBe(1);
			expect(Date.parse(a.fetchedAt)).not.toBeNaN();
			titled("Renamed on GitHub");
			const kept = await s.overview();
			expect(kept).toBe(a);
			expect(reads()).toBe(1);
			// Young enough: still the kept one.
			expect(await s.overview(60_000)).toBe(a);
			const fresh = await s.overview(0);
			expect(reads()).toBe(2);
			expect(fresh.title).toBe("Renamed on GitHub");
			expect(Date.parse(fresh.fetchedAt)).toBeGreaterThanOrEqual(
				Date.parse(a.fetchedAt),
			);
			// The fresh read is the one kept now.
			expect(await s.overview()).toBe(fresh);
		});

		it("reads again on Refresh, and doesn't keep a failed read", async () => {
			const s = await Session.open(pr.arg, process.cwd());
			const first = await s.overview();
			titled("After refresh");
			await s.refresh();
			const after = await s.overview();
			expect(after).not.toBe(first);
			expect(after.title).toBe("After refresh");
			pr.scenario({ loggedOut: true });
			await expect(s.overview(0)).rejects.toThrow(GhError);
			// The failure isn't kept: the last good read is served.
			expect(await s.overview()).toBe(after);
			titled("Back");
			expect((await s.overview(0)).title).toBe("Back");
		});

		it("reads the threads apart, in stages: every summary, then the listed-first text, then the rest", async () => {
			const head = pr.head();
			// Twelve human threads, the later the more recent.
			const at = (i: number) =>
				`2026-01-0${1 + Math.floor(i / 10)}T0${i % 10}:00:00Z`;
			pr.scenario({
				threadContentDelayMs: 300,
				prs: {
					12: {
						view: prView({ headRefOid: head, baseRefName: "main" }),
						graphql: {
							reviewThreads: Array.from({ length: 12 }, (_, i) =>
								reviewThread({ path: `f${i}.txt`, line: 1 }, [
									threadComment({
										login: "rev1",
										text: `On ${i}`,
										commit: head,
										createdAt: at(i),
										diffHunk: "@@ -1 +1 @@\n+x",
									}),
								]),
							),
						},
					},
				},
			});
			const s = await Session.open(pr.arg, process.cwd());
			const { readId } = await s.overview();
			const summary = await s.threads(readId, "summary");
			expect(summary.threads).toHaveLength(12);
			expect(summary.complete).toBe(false);
			// Most recent first; counts and headers there, text on its way.
			expect(summary.threads[0]?.path).toBe("f11.txt");
			expect(summary.threads.some((t) => t.loaded)).toBe(false);
			expect(summary.threads[0]?.code?.anchor.line).toBe(1);
			const first = await s.threads(readId, "first");
			const loaded = first.threads.filter((t) => t.loaded).map((t) => t.path);
			expect(loaded).toEqual(
				expect.arrayContaining(
					Array.from({ length: 10 }, (_, i) => `f${11 - i}.txt`),
				),
			);
			const full = await s.threads(readId, "full");
			expect(full.complete).toBe(true);
			expect(full.threads.every((t) => t.loaded)).toBe(true);
			expect(full.threads.every((t) => t.code?.source !== "pending")).toBe(
				true,
			);
			expect(full.threads[0]?.html).toContain("On 11");
			// The listed-first ten were asked for on their own, ahead.
			const batches = pr
				.ghLog()
				.split("\n")
				.filter((l) => l.includes("nodes(ids:"))
				.map((l) => (l.match(/"T12-\d+"/g) ?? []).length)
				.sort((a, b) => a - b);
			expect(batches).toEqual([2, 10]);
		});

		it("builds thread code from the clone, with rows after the range", async () => {
			const head = pr.head();
			pr.scenario({
				prs: {
					12: {
						view: prView({ headRefOid: head, baseRefName: "main" }),
						graphql: {
							reviewThreads: [
								reviewThread({ path: "a.txt", line: 2, diffSide: "RIGHT" }, [
									threadComment({
										login: "rev1",
										text: "Why?",
										commit: head,
										// After the commits: the base then is the base now.
										createdAt: "2099-01-01T00:00:00Z",
										diffHunk:
											"@@ -1,2 +1,2 @@\n line 1\n-line 2\n+line 2 changed",
									}),
								]),
							],
						},
					},
				},
			});
			const s = await Session.open(pr.arg, process.cwd());
			const { threads } = await s.threads((await s.overview()).readId, "full");
			const code = threads[0]?.code;
			expect(code?.source).toBe("clone");
			expect(code?.rows.map((r) => `${r.marked ? ">" : " "}${r.text}`)).toEqual(
				[
					" line 1",
					" line 2",
					">line 2 changed",
					" line 3",
					" line 4",
					" line 5",
				],
			);
		});
	});

	it("serves hunks and context of a file", async () => {
		const s = await Session.open(pr.arg, process.cwd());
		const rev = s.snapshot().revision;
		const hunks = await s.fileHunks(rev, 0);
		expect(hunks.newLineCount).toBe(30);
		expect(hunks.hunks).toHaveLength(2);
		const lines = await s.context(rev, 0, 10, 12);
		expect(lines.map((l) => l.text)).toEqual(["line 10", "line 11", "line 12"]);
	});

	describe("as of a cutoff", () => {
		const CUTOFF = "2098-01-01T00:00:00Z";
		const user = (login: string) => ({ login, __typename: "User" });
		/** The PR moved on after the cutoff: `then` was its head, `now` is. */
		const scenarioAsOf = (then: string, now: string) =>
			pr.scenario({
				prs: {
					12: {
						view: prView({
							headRefOid: now,
							baseRefName: "main",
							state: "MERGED",
						}),
						graphql: {
							commits: [
								{
									commit: { oid: then, committedDate: "2026-01-02T00:00:00Z" },
								},
								{ commit: { oid: now, committedDate: "2099-01-01T00:00:00Z" } },
							],
							reviews: [
								{
									author: user("Octo_Cat"),
									state: "APPROVED",
									submittedAt: "2026-01-03T00:00:00Z",
									commit: { oid: then },
								},
								{
									author: user("rev9"),
									state: "COMMENTED",
									submittedAt: "2099-01-02T00:00:00Z",
									commit: { oid: now },
								},
							],
							reviewThreads: [],
							comments: [],
						},
					},
				},
				commits: {
					[then]: {
						contexts: [
							{
								__typename: "StatusContext",
								context: "ci",
								state: "SUCCESS",
								createdAt: "2026-01-02T01:00:00Z",
							},
						],
					},
				},
			});

		it("opens on the head of then, never reports it moved, and refreshes in place", async () => {
			const then = pr.head();
			const now = pr.moveHead({ "later.txt": "later\n" });
			scenarioAsOf(then, now);
			const s = await Session.open(pr.arg, process.cwd(), () => {}, {
				asOf: CUTOFF,
			});
			expect(s.info()).toMatchObject({
				snapshotHead: then,
				currentHead: then,
				headMoved: false,
				asOf: CUTOFF,
			});
			expect(s.snapshot().files.map((f) => f.path)).not.toContain("later.txt");
			// Neither asks GitHub for the head (Refresh only reads the overview again).
			const metas = () =>
				(pr.ghLog().match(/^pr view .*headRefOid/gm) ?? []).length;
			const calls = metas();
			expect(await s.checkHead()).toMatchObject({ headMoved: false });
			expect(await s.refresh()).toMatchObject({ snapshotHead: then });
			expect(metas()).toBe(calls);
			const o = await s.overview();
			expect(o.asOf).toBe(CUTOFF);
			expect(o.state).toBe("OPEN");
			expect(o.reviews.map((r) => r.author)).toEqual(["Octo_Cat"]);
			expect(o.checks).toEqual([{ name: "ci", status: "passing" }]);
			// Nothing moves as of a cutoff: the read is kept, gh isn't asked again.
			const ghCalls = pr.ghLog().length;
			expect(await s.overview()).toBe(o);
			expect(pr.ghLog().length).toBe(ghCalls);
		});

		it("treats --viewer as you, so the gh login shows as a third party", async () => {
			const then = pr.head();
			scenarioAsOf(then, pr.moveHead({ "later.txt": "later\n" }));
			const mine = await Session.open(pr.arg, process.cwd(), () => {}, {
				asOf: CUTOFF,
			});
			expect((await mine.overview()).reviews[0]).toMatchObject({ you: true });
			const theirs = await Session.open(pr.arg, process.cwd(), () => {}, {
				asOf: CUTOFF,
				viewer: "someone-else",
			});
			const o = await theirs.overview();
			expect(o.reviews[0]).toMatchObject({ author: "Octo_Cat", you: false });
			expect(o.humanStarted).toBe(true);
			// Refs still belong to the gh login.
			expect(theirs.info().viewer).toBe("octo-cat");
		});

		it("pages through the head's checks, and fails when GitHub lacks the commit", async () => {
			const then = pr.head();
			const now = pr.moveHead({ "later.txt": "later\n" });
			scenarioAsOf(then, now);
			const scenarioPath = process.env.CRB_FAKE_GH ?? "";
			const { readFileSync, writeFileSync } = await import("node:fs");
			const sc = JSON.parse(readFileSync(scenarioPath, "utf8"));
			const ctx = (name: string) => ({
				__typename: "StatusContext",
				context: name,
				state: "PENDING",
				createdAt: "2026-01-02T01:00:00Z",
			});
			sc.pageSize = 1;
			sc.commits[then].contexts = [ctx("a"), ctx("b"), ctx("c")];
			writeFileSync(scenarioPath, JSON.stringify(sc));
			const s = await Session.open(pr.arg, process.cwd(), () => {}, {
				asOf: CUTOFF,
			});
			expect((await s.overview()).checks.map((c) => c.name)).toEqual([
				"a",
				"b",
				"c",
			]);
			sc.commits = {};
			writeFileSync(scenarioPath, JSON.stringify(sc));
			// Read again (the last read is kept otherwise).
			await expect(s.overview(0)).rejects.toThrow(/is missing on GitHub/);
		});

		it("doesn't refuse a PR merged since", async () => {
			const then = pr.head();
			const now = pr.moveHead({ "later.txt": "later\n" });
			pr.moveMain(now);
			scenarioAsOf(then, now);
			const s = await Session.open(pr.arg, process.cwd(), () => {}, {
				asOf: CUTOFF,
			});
			expect(s.info().snapshotHead).toBe(then);
		});

		it("keeps its progress apart from the real review", async () => {
			const normal = await Session.open(pr.arg, process.cwd());
			await normal.setStates(normal.snapshot().revision, [
				{ key: firstKey(normal), state: "reviewed" },
			]);
			const then = pr.head();
			const now = pr.moveHead({ "later.txt": "later\n" });
			scenarioAsOf(then, now);
			const s = await Session.open(pr.arg, process.cwd(), () => {}, {
				asOf: CUTOFF,
			});
			const view = await s.review();
			expect(view.patchset).toBeNull();
			expect(view.progress.clusters.reviewed).toBe(0);
			await s.setStates(s.snapshot().revision, [
				{ key: firstKey(s), state: "crossed-off" },
			]);
			const again = await Session.open(pr.arg, process.cwd());
			const real = await again.review();
			expect(real.progress.clusters).toMatchObject({
				reviewed: 1,
				crossedOff: 0,
			});
		});
	});
});
