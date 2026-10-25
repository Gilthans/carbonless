import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prView } from "../../test/fake-gh/scenario";
import { testGitEnv } from "../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import { clonePath } from "./clone";
import { GhError } from "./errors";
import { StaleSnapshotError } from "./review/reviews";
import { Session } from "./session";

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

	it("refuses a PR already merged into its base", async () => {
		pr.moveMain();
		await expect(Session.open(pr.arg, process.cwd())).rejects.toThrow(
			"PR acme/widget#12 is already merged into main; nothing to review",
		);
	});

	it("refuses a merged PR without creating a review", async () => {
		pr.moveMain();
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
		pr.moveMain();
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

	it("keeps an unstarted review's snapshot when the new head is already merged", async () => {
		const s = await Session.open(pr.arg, process.cwd());
		const before = s.snapshot();
		const newHead = pr.moveHead({ "later.txt": "later\n" });
		pr.moveMain(newHead);
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
			const calls = pr.ghLog().split("\n").length;
			expect(await s.checkHead()).toMatchObject({ headMoved: false });
			expect(await s.refresh()).toMatchObject({ snapshotHead: then });
			expect(pr.ghLog().split("\n").length).toBe(calls);
			const o = await s.overview();
			expect(o.asOf).toBe(CUTOFF);
			expect(o.state).toBe("OPEN");
			expect(o.reviews.map((r) => r.author)).toEqual(["Octo_Cat"]);
			expect(o.checks).toEqual([{ name: "ci", status: "passing" }]);
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
			await expect(s.overview()).rejects.toThrow(/is missing on GitHub/);
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
