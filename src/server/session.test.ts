import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acpLog, releaseAcp, useFakeAcp } from "../../test/fake-acp/scenario";
import { writeFileAtomic } from "../../test/fake-gh/atomic.mjs";
import {
	letThrough,
	prView,
	release,
	reviewThread,
	threadComment,
	timelineCommit,
	timelineReview,
} from "../../test/fake-gh/scenario";
import { GIT_TEST_TIMEOUTS, testGitEnv } from "../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import { agentsDir } from "./agent/checkout";
import { clonePath } from "./clone";
import { buildSnapshot } from "./diff/snapshot";
import { GhError } from "./errors";
import { parseHead } from "./pinnedHead";
import { RefStore } from "./review/refStore";
import { ReviewService, StaleSnapshotError } from "./review/reviews";
import { refusal, Session, UnknownReadError } from "./session";
import { ThreadCodeSource } from "./threadCode";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: testGitEnv(),
	}).trim();

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
			pinnedHead: null,
			patchsets: [],
			lastSeen: null,
			head: {
				oid: pr.head(),
				mergeBase: pr.mergeBase,
				baseBranch: "main",
				commits: 0,
			},
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
			hold: ["prView"],
		});
		const views = () => (pr.ghLog().match(/^pr view /gm) ?? []).length;
		const before = views();
		const check = s.checkHead();
		// The check's gh has read the old head and is now held.
		await vi.waitFor(() => expect(views()).toBe(before + 1), {
			timeout: 10_000,
		});
		const newHead = pr.moveHead({ "later.txt": "later\n" });
		// The refresh's own pr view goes; the check's answers after it.
		letThrough(process.env.CRB_FAKE_GH ?? "", "prView");
		expect((await s.refresh()).currentHead).toBe(newHead);
		release(process.env.CRB_FAKE_GH ?? "", "prView");
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
			expect(a).toEqual(b);
			expect(reads()).toBe(1);
			expect(Date.parse(a.fetchedAt)).not.toBeNaN();
			titled("Renamed on GitHub");
			const kept = await s.overview();
			expect(kept).toEqual(a);
			expect(reads()).toBe(1);
			// Young enough: still the kept one.
			expect(await s.overview(60_000)).toEqual(a);
			const fresh = await s.overview(0);
			expect(reads()).toBe(2);
			expect(fresh.title).toBe("Renamed on GitHub");
			expect(Date.parse(fresh.fetchedAt)).toBeGreaterThanOrEqual(
				Date.parse(a.fetchedAt),
			);
			// The fresh read is the one kept now.
			expect(await s.overview()).toEqual(fresh);
		});

		it("reads again on Refresh, and doesn't keep a failed read", async () => {
			const s = await Session.open(pr.arg, process.cwd());
			await s.overview();
			titled("After refresh");
			await s.refresh();
			const after = await s.overview();
			expect(after.title).toBe("After refresh");
			pr.scenario({ loggedOut: true });
			await expect(s.overview(0)).rejects.toThrow(GhError);
			// The failure isn't kept: the last good read is served.
			expect(await s.overview()).toEqual(after);
			titled("Back");
			expect((await s.overview(0)).title).toBe("Back");
		});

		it("builds thread code, checks and fallbacks included, at most eight at a time", async () => {
			const head = pr.head();
			pr.scenario({
				threadContentDelayMs: 100,
				prs: {
					12: {
						view: prView({ headRefOid: head, baseRefName: "main" }),
						graphql: {
							reviewThreads: Array.from({ length: 20 }, (_, i) =>
								reviewThread(
									{ path: i % 2 ? "a.txt" : `gone${i}.txt`, line: 2 },
									[
										threadComment({
											login: "rev1",
											text: `On ${i}`,
											commit: head,
											createdAt: `2099-01-01T00:00:${String(i).padStart(2, "0")}Z`,
											// Odd: checked against it; even: the fallback.
											diffHunk:
												"@@ -1,2 +1,2 @@\n line 1\n-line 2\n+line 2 changed",
										}),
									],
								),
							),
						},
					},
				},
			});
			let running = 0;
			let most = 0;
			const counted = <A extends unknown[], R>(
				fn: (this: ThreadCodeSource, ...args: A) => Promise<R>,
			) =>
				async function (this: ThreadCodeSource, ...args: A): Promise<R> {
					running++;
					most = Math.max(most, running);
					try {
						return await fn.apply(this, args);
					} finally {
						running--;
					}
				};
			const proto = ThreadCodeSource.prototype;
			const { window: build, code } = proto;
			const spies = [
				vi.spyOn(proto, "window").mockImplementation(counted(build)),
				vi.spyOn(proto, "code").mockImplementation(counted(code)),
			];
			try {
				const s = await Session.open(pr.arg, process.cwd());
				const { threads } = await s.threads(
					(await s.overview()).readId,
					"full",
				);
				expect(threads.filter((t) => t.code?.source === "clone")).toHaveLength(
					10,
				);
				expect(threads.filter((t) => t.code?.source === "github")).toHaveLength(
					10,
				);
				expect(most).toBeGreaterThan(1);
				expect(most).toBeLessThanOrEqual(8);
			} finally {
				for (const spy of spies) spy.mockRestore();
			}
		});

		it("reads the threads apart, in stages: every summary, then the listed-first text, then the rest", async () => {
			const head = pr.head();
			// Twelve human threads, the later the more recent.
			const at = (i: number) =>
				`2026-01-0${1 + Math.floor(i / 10)}T0${i % 10}:00:00Z`;
			pr.scenario({
				// The text waits for the test: the summary must come without it.
				hold: ["threadContent"],
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
			release(process.env.CRB_FAKE_GH ?? "", "threadContent");
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

		it("says which threads' text will never come: deleted since the list was read, or with no id", async () => {
			const head = pr.head();
			const thread = (path: string, at: string) =>
				reviewThread({ path, line: 1 }, [
					threadComment({
						login: "rev1",
						text: path,
						commit: head,
						createdAt: at,
					}),
				]);
			pr.scenario({
				// The second thread is deleted between the summary and its text.
				deletedThreads: ["T12-1"],
				prs: {
					12: {
						view: prView({ headRefOid: head, baseRefName: "main" }),
						graphql: {
							reviewThreads: [
								thread("kept.txt", "2026-01-01T03:00:00Z"),
								thread("deleted.txt", "2026-01-01T02:00:00Z"),
								// GitHub gave no usable id.
								{ ...thread("no-id.txt", "2026-01-01T01:00:00Z"), id: "" },
							],
						},
					},
				},
			});
			const s = await Session.open(pr.arg, process.cwd());
			const { readId } = await s.overview();
			const full = await s.threads(readId, "full");
			expect(full.complete).toBe(true);
			expect(
				full.threads.map((t) => [t.path, t.loaded, t.unavailable, t.excerpt]),
			).toEqual([
				["kept.txt", true, undefined, "kept.txt"],
				["deleted.txt", true, "deleted", ""],
				["no-id.txt", true, "unreadable", ""],
			]);
			// Each stage gets there, none fails on the deleted thread.
			expect((await s.threads(readId, "first")).threads[1]?.unavailable).toBe(
				"deleted",
			);
		});

		it("stops its background reads on close: no gh or git starts after", async () => {
			// The summary is held until the test lets it go: a close that
			// waited for it would never finish.
			pr.scenario({
				hold: ["threads"],
				prs: {
					12: {
						view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
						graphql: { reviewThreads: [reviewThread({ path: "a.txt" })] },
					},
				},
			});
			const s = await Session.open(pr.arg, process.cwd());
			const { readId } = await s.overview();
			await s.close();
			release(process.env.CRB_FAKE_GH ?? "", "threads");
			await expect(s.threads(readId, "full")).rejects.toThrow();
			const calls = pr.ghLog();
			await new Promise((r) => setTimeout(r, 200));
			expect(pr.ghLog()).toBe(calls);
			await expect(s.overview(0)).rejects.toThrow(/closed/);
		});

		it("stops on close the reads it no longer keeps: a failed overview's, and those pushed out", async () => {
			const slowThreads = (over: Record<string, unknown> = {}) =>
				pr.scenario({
					hold: ["threads"],
					...over,
					prs: {
						12: {
							view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
							graphql: { reviewThreads: [reviewThread({ path: "a.txt" })] },
						},
					},
				});
			const s = await Session.open(pr.arg, process.cwd());
			// Its overview fails (no description) while its threads go on.
			slowThreads({ failGraphql: "{ bodyHTML }" });
			await expect(s.overview(0)).rejects.toThrow();
			// More reads than are kept: the oldest is pushed out, still running.
			slowThreads();
			for (let i = 0; i < 4; i++) await s.overview(0);
			// Closes while every summary is still held (not waiting for them).
			await s.close();
			// Then they may answer: no content or other gh call follows, from
			// any of them.
			const calls = pr.ghLog();
			release(process.env.CRB_FAKE_GH ?? "", "threads");
			await new Promise((r) => setTimeout(r, 1800));
			expect(pr.ghLog()).toBe(calls);
		});

		it("stops a Refresh under way on close, not waiting for its gh", async () => {
			const s = await Session.open(pr.arg, process.cwd());
			const views = () => pr.ghLog().match(/^pr view/gm)?.length ?? 0;
			const before = views();
			// GitHub answers the Refresh's pr view only once the test lets it.
			pr.scenario({ hold: ["prView"] });
			const refreshing = s.refresh();
			refreshing.catch(() => {});
			await vi.waitFor(() => expect(views()).toBeGreaterThan(before), {
				timeout: 10_000,
			});
			await s.close();
			await expect(refreshing).rejects.toThrow();
			release(process.env.CRB_FAKE_GH ?? "", "prView");
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
			// Checked against GitHub's hunk, read with the comment's text.
			expect(code?.snapshot).toEqual({ same: true });
		});
	});

	it("reads the timeline with the overview, its review comments tied to their threads", async () => {
		const head = pr.head();
		pr.scenario({
			prs: {
				12: {
					view: prView({ headRefOid: head, baseRefName: "main" }),
					graphql: {
						reviewThreads: [
							reviewThread({ path: "a.txt", line: 1, isResolved: true }, [
								threadComment({ login: "rev", text: "Why?" }),
							]),
						],
						timelineItems: [
							timelineCommit({
								login: "ann",
								at: "2026-01-02T00:00:00Z",
								oid: head,
							}),
							timelineReview({
								login: "rev",
								at: "2026-01-03T09:00:00Z",
								comments: [
									{
										// The fake gh's id for thread 0's opening comment.
										id: "C12-0",
										path: "a.txt",
										line: 1,
										at: "2026-01-03T09:00:00Z",
										text: "Why?",
									},
								],
							}),
						],
					},
				},
			},
		});
		const s = await Session.open(pr.arg, process.cwd());
		const { readId } = await s.overview();
		const timeline = await s.timeline(readId);
		expect(timeline.gaps).toEqual([]);
		expect(timeline.events.map((e) => e.kind)).toEqual(["commits", "review"]);
		const review = timeline.events[1];
		expect(review?.kind === "review" && review.items[0]).toMatchObject({
			kind: "comment",
			path: "a.txt",
			threadId: "T12-0",
		});
		expect(() => s.timeline("gone")).toThrow(UnknownReadError);
	});

	it("shows a timeline that fails to read as its own error, the overview unaffected", async () => {
		pr.scenario({
			failGraphql: "timelineItems",
			prs: {
				12: { view: prView({ headRefOid: pr.head(), baseRefName: "main" }) },
			},
		});
		const s = await Session.open(pr.arg, process.cwd());
		const overview = await s.overview();
		expect(overview.title).toBeTruthy();
		await expect(s.timeline(overview.readId)).rejects.toThrow(GhError);
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

	describe("pinned on a head (--head)", () => {
		const user = (login: string) => ({ login, __typename: "User" });
		/** Octo_Cat reviewed `then` (and has a pending review on `now`). */
		const scenarioReviewed = (
			then: string,
			now: string,
			state = "OPEN",
			/** Later reviews, and other scenario fields. */
			later: {
				reviews?: unknown[];
				reviewComments?: Record<string, unknown[]>;
			} = {},
		) =>
			pr.scenario({
				reviewComments: later.reviewComments,
				prs: {
					12: {
						view: prView({ headRefOid: now, baseRefName: "main", state }),
						graphql: {
							commits: [
								{
									commit: { oid: then, committedDate: "2026-01-02T00:00:00Z" },
								},
								{ commit: { oid: now, committedDate: "2026-01-04T00:00:00Z" } },
							],
							reviews: [
								{
									author: user("Octo_Cat"),
									state: "CHANGES_REQUESTED",
									submittedAt: "2026-01-03T00:00:00Z",
									commit: { oid: then },
								},
								{
									author: user("rev1"),
									state: "APPROVED",
									submittedAt: "2026-01-05T00:00:00Z",
									commit: { oid: now },
								},
								{
									author: user("Octo_Cat"),
									state: "PENDING",
									submittedAt: null,
									commit: { oid: now },
								},
								...(later.reviews ?? []),
							],
							reviewThreads: [],
							comments: [],
						},
					},
				},
			});
		const openPinned = (head: string, viewer?: string) =>
			Session.open(pr.arg, process.cwd(), () => {}, {
				head: parseHead(head),
				...(viewer ? { viewer } : {}),
			});

		it("opens on the viewer's last submitted review's commit, against the current base, and says newer commits exist", async () => {
			const then = pr.head();
			const now = pr.moveHead({ "later.txt": "later\n" });
			scenarioReviewed(then, now);
			const s = await openPinned("reviewed");
			expect(s.info()).toMatchObject({
				snapshotHead: then,
				currentHead: now,
				headMoved: true,
				patchset: null,
				pinnedHead: then,
				asOf: null,
			});
			expect(s.snapshot().base).toBe(pr.mergeBase);
			expect(s.snapshot().files.map((f) => f.path)).toEqual([
				"a.txt",
				"new.txt",
			]);
			// Everything else is live: today's reviews, not those of then.
			const o = await s.overview();
			expect(o.asOf).toBeUndefined();
			expect(o.reviews.map((r) => r.author)).toContain("rev1");
		});

		it("takes --viewer's reviews", async () => {
			const then = pr.head();
			const now = pr.moveHead({ "later.txt": "later\n" });
			scenarioReviewed(then, now);
			const s = await openPinned("reviewed", "rev1");
			expect(s.info()).toMatchObject({
				snapshotHead: now,
				headMoved: false,
				pinnedHead: now,
			});
		});

		it("takes a full or abbreviated sha of the PR's commits", async () => {
			const then = pr.head();
			const now = pr.moveHead({ "later.txt": "later\n" });
			scenarioReviewed(then, now);
			expect((await openPinned(then.slice(0, 7))).info().snapshotHead).toBe(
				then,
			);
			expect((await openPinned(now)).info()).toMatchObject({
				snapshotHead: now,
				pinnedHead: now,
				headMoved: false,
			});
		});

		it("fails clearly: no submitted review, a commit not of the PR, with --as-of", async () => {
			const then = pr.head();
			const now = pr.moveHead({ "later.txt": "later\n" });
			scenarioReviewed(then, now);
			await expect(openPinned("reviewed", "nobody")).rejects.toThrow(
				"nobody has no submitted review on acme/widget#12",
			);
			await expect(openPinned("1234567")).rejects.toThrow(
				"1234567 is not a commit of acme/widget#12",
			);
			await expect(
				Session.open(pr.arg, process.cwd(), () => {}, {
					head: parseHead("reviewed"),
					asOf: "2026-01-03T00:00:00Z",
				}),
			).rejects.toThrow("--head can't be combined with --as-of");
		});

		it("never moves off the pinned commit on refresh or a head check", async () => {
			const then = pr.head();
			const now = pr.moveHead({ "later.txt": "later\n" });
			scenarioReviewed(then, now);
			const s = await openPinned("reviewed");
			const newer = pr.moveHead({ "newer.txt": "newer\n" });
			scenarioReviewed(then, newer);
			expect(await s.checkHead()).toMatchObject({
				snapshotHead: then,
				currentHead: newer,
				headMoved: true,
			});
			expect(await s.refresh()).toMatchObject({
				snapshotHead: then,
				currentHead: newer,
				headMoved: true,
				pinnedHead: then,
			});
			expect(s.snapshot().files.map((f) => f.path)).toEqual([
				"a.txt",
				"new.txt",
			]);
		});

		it("follows the base branch on refresh: its own changes stay out, the merge base follows", async () => {
			const then = pr.head();
			const now = pr.moveHead({ "later.txt": "later\n" });
			scenarioReviewed(then, now);
			const s = await openPinned("reviewed");
			// main moves on with a change of its own.
			const git = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: pr.repo.path,
					encoding: "utf8",
					env: testGitEnv(),
				}).trim();
			writeFileSync(join(pr.repo.path, "base-only.txt"), "base\n");
			git("add", "base-only.txt");
			git("commit", "--quiet", "-m", "base moves on");
			const main = git("rev-parse", "HEAD");
			expect(await s.refresh()).toMatchObject({
				snapshotHead: then,
				pinnedHead: then,
			});
			expect(s.snapshot().files.map((f) => f.path)).toEqual([
				"a.txt",
				"new.txt",
			]);
			expect(s.snapshot().base).toBe(git("merge-base", main, then));
			expect(s.snapshot().base).toBe(pr.mergeBase);
			// Base landing the PR's reviewed commit: nothing of it is left to show.
			git("merge", "--quiet", "--no-ff", "-m", "land part", then);
			await s.refresh();
			expect(s.snapshot().base).toBe(then);
			expect(s.snapshot().files).toEqual([]);
		});

		it("doesn't count a later review that only replied to threads, all its pages read; one starting a thread counts", async () => {
			const then = pr.head();
			const now = pr.moveHead({ "later.txt": "later\n" });
			/** Octo_Cat's later COMMENTED review on `now`: no body, 2 pages of comments. */
			const replies = (secondIsReply: boolean) =>
				scenarioReviewed(then, now, "OPEN", {
					reviews: [
						{
							id: "R1",
							author: user("Octo_Cat"),
							state: "COMMENTED",
							submittedAt: "2026-01-06T00:00:00Z",
							body: "",
							commit: { oid: now },
							comments: {
								pageInfo: { hasNextPage: true, endCursor: "cursor:1" },
								nodes: [{ replyTo: { id: "C1" } }],
							},
						},
					],
					reviewComments: {
						R1: [
							{ replyTo: { id: "C1" } },
							{ replyTo: secondIsReply ? { id: "C2" } : null },
						],
					},
				});
			replies(true);
			expect((await openPinned("reviewed")).info().snapshotHead).toBe(then);
			replies(false);
			expect((await openPinned("reviewed")).info().snapshotHead).toBe(now);
			// The rest unreadable: no guess.
			pr.scenario({
				...JSON.parse(readFileSync(process.env.CRB_FAKE_GH ?? "", "utf8")),
				reviewComments: {},
			});
			await expect(openPinned("reviewed")).rejects.toThrow(
				/Could not tell whether octo-cat's review of .* only replies to threads/,
			);
		});

		it("keeps its progress in a review of its own; the PR's own review is untouched", async () => {
			const normal = await Session.open(pr.arg, process.cwd());
			await normal.setStates(normal.snapshot().revision, [
				{ key: firstKey(normal), state: "reviewed" },
			]);
			const then = pr.head();
			const now = pr.moveHead({ "later.txt": "later\n" });
			scenarioReviewed(then, now);
			// The same commit as the PR's patch set, still a review of its own.
			const s = await openPinned("reviewed");
			const view = await s.review();
			expect(view.patchset).toBeNull();
			expect(view.progress.clusters.reviewed).toBe(0);
			await s.setStates(s.snapshot().revision, [
				{ key: firstKey(s), state: "crossed-off" },
			]);
			const again = await Session.open(pr.arg, process.cwd());
			expect(again.info()).toMatchObject({ pinnedHead: null, patchset: 1 });
			expect((await again.review()).progress.clusters).toMatchObject({
				reviewed: 1,
				crossedOff: 0,
			});
			const pinnedAgain = await openPinned("reviewed");
			expect((await pinnedAgain.review()).progress.clusters).toMatchObject({
				reviewed: 0,
				crossedOff: 1,
			});
		});

		it("refuses an unstarted pinned review of a merged PR", async () => {
			const then = pr.head();
			const now = pr.moveHead({ "later.txt": "later\n" });
			pr.moveMain(now);
			scenarioReviewed(then, now, "MERGED");
			await expect(openPinned("reviewed")).rejects.toThrow(
				"PR acme/widget#12 is already merged; nothing to review",
			);
		});
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
			// The past can't be answered: no writes to GitHub.
			expect(o.writes).toBe("as-of");
			expect(s.writes()).toBe("as-of");
			expect(o.state).toBe("OPEN");
			expect(o.reviews.map((r) => r.author)).toEqual(["Octo_Cat"]);
			expect(o.checks).toEqual([{ name: "ci", status: "passing" }]);
			// Nothing moves as of a cutoff: the read is kept, gh isn't asked again.
			const ghCalls = pr.ghLog().length;
			expect(await s.overview()).toEqual(o);
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
			const { readFileSync } = await import("node:fs");
			const sc = JSON.parse(readFileSync(scenarioPath, "utf8"));
			const ctx = (name: string) => ({
				__typename: "StatusContext",
				context: name,
				state: "PENDING",
				createdAt: "2026-01-02T01:00:00Z",
			});
			sc.pageSize = 1;
			sc.commits[then].contexts = [ctx("a"), ctx("b"), ctx("c")];
			writeFileAtomic(scenarioPath, JSON.stringify(sc));
			const s = await Session.open(pr.arg, process.cwd(), () => {}, {
				asOf: CUTOFF,
			});
			expect((await s.overview()).checks.map((c) => c.name)).toEqual([
				"a",
				"b",
				"c",
			]);
			sc.commits = {};
			writeFileAtomic(scenarioPath, JSON.stringify(sc));
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

	describe("patch sets", () => {
		/** Starts PS2 for octo-cat on the PR's new head, as a later crb would. */
		const startSecond = async (s: Session) => {
			const newHead = pr.moveHead({ "later.txt": "later\n" });
			// Fetches the new head into the clone; the session stays on PS1.
			await s.refresh();
			const clone = clonePath("acme", "widget");
			const reviews = new ReviewService(new RefStore(clone));
			const snap2 = await buildSnapshot(clone, pr.mergeBase, newHead);
			const key = snap2.files.find((f) => f.path === "later.txt")?.clusters[0]
				?.key;
			if (!key) throw new Error("no cluster in later.txt");
			await reviews.recordStates(
				s.id,
				"octo-cat",
				snap2,
				[{ key, state: "reviewed" }],
				{
					since: 1,
					shape: "S1",
					baseBranch: "main",
					interdiff: "available",
					carried: [],
				},
			);
			return { newHead, snap2 };
		};

		it("remembers the head seen on the previous open", async () => {
			const first = await Session.open(pr.arg, process.cwd());
			expect(first.info().lastSeen).toBeNull();
			const head1 = pr.head();
			const head2 = pr.moveHead({ "later.txt": "later\n" });
			const second = await Session.open(pr.arg, process.cwd());
			expect(second.info().lastSeen?.head).toBe(head1);
			expect(second.info().currentHead).toBe(head2);
			const third = await Session.open(pr.arg, process.cwd());
			expect(third.info().lastSeen?.head).toBe(head2);
		});

		it("lists every patch set and serves an earlier one as reviewed, read-only", async () => {
			const s = await Session.open(pr.arg, process.cwd());
			const ps1 = s.snapshot();
			const key = firstKey(s);
			await s.setStates(ps1.revision, [{ key, state: "reviewed" }]);
			const { newHead, snap2 } = await startSecond(s);

			const again = await Session.open(pr.arg, process.cwd());
			const info = again.info();
			expect(info.patchset).toBe(2);
			expect(info.snapshotHead).toBe(newHead);
			expect(info.patchsets).toMatchObject([
				{ number: 1, head: ps1.head, mergeBase: ps1.base, since: null },
				{
					number: 2,
					head: newHead,
					mergeBase: pr.mergeBase,
					since: 1,
					shape: "S1",
				},
			]);
			expect(info.patchsets.map((p) => typeof p.startedAt)).toEqual([
				"number",
				"number",
			]);
			expect((await again.review()).revision).toBe(snap2.revision);

			const old = await again.reviewAt(1);
			expect(old.patchset).toBe(1);
			expect(old.revision).toBe(ps1.revision);
			expect(old.files.map((f) => f.path)).toEqual(["a.txt", "new.txt"]);
			expect(old.progress.clusters).toMatchObject({ total: 3, reviewed: 1 });
			// Its hunks and context load by its revision, as the current one's do.
			const hunks = await again.fileHunks(ps1.revision, 0);
			expect(hunks.hunks.length).toBeGreaterThan(0);
			expect(
				(await again.context(ps1.revision, 0, 10, 12)).map((l) => l.text),
			).toEqual(["line 10", "line 11", "line 12"]);
			// And it takes no writes.
			await expect(
				again.setStates(ps1.revision, [{ key, state: "unreviewed" }]),
			).rejects.toBeInstanceOf(StaleSnapshotError);
			expect((await again.reviewAt(1)).progress.clusters.reviewed).toBe(1);
			// The latest one is still the session's.
			expect(again.snapshot().revision).toBe(snap2.revision);
			await expect(again.reviewAt(9)).rejects.toBeInstanceOf(RangeError);
			await expect(again.reviewAt(0)).rejects.toBeInstanceOf(RangeError);
		});

		it("counts each patch set's commits over its merge base in the background, null until known", async () => {
			const s = await Session.open(pr.arg, process.cwd());
			const ps1 = s.snapshot();
			await s.setStates(ps1.revision, [
				{ key: firstKey(s), state: "reviewed" },
			]);
			const { newHead } = await startSecond(s);
			const again = await Session.open(pr.arg, process.cwd());
			// The page read never waits for git: unknown at first.
			expect(again.info().patchsets.map((p) => p.commits)).toEqual([
				null,
				null,
			]);
			const clone = clonePath("acme", "widget");
			const count = (head: string) =>
				Number(
					execFileSync(
						"git",
						["-C", clone, "rev-list", "--count", `${pr.mergeBase}..${head}`],
						{ env: testGitEnv() },
					)
						.toString()
						.trim(),
				);
			const expected = [count(ps1.head), count(newHead)];
			expect(expected[0]).toBeGreaterThan(0);
			expect(expected[1]).toBe((expected[0] as number) + 1);
			await vi.waitFor(() =>
				expect(again.info().patchsets.map((p) => p.commits)).toEqual(expected),
			);
		});

		it("rebuilds an earlier patch set from its pins, with the recorded merge base when -base is missing", async () => {
			const s = await Session.open(pr.arg, process.cwd());
			const ps1 = s.snapshot();
			await s.setStates(ps1.revision, [
				{ key: firstKey(s), state: "reviewed" },
			]);
			await startSecond(s);
			const clone = clonePath("acme", "widget");
			execFileSync(
				"git",
				[
					"-C",
					clone,
					"update-ref",
					"-d",
					`refs/crb/reviews/${s.id}/reviewers/octo-cat/patchsets/1-base`,
				],
				{ env: testGitEnv() },
			);
			const again = await Session.open(pr.arg, process.cwd());
			const old = await again.reviewAt(1);
			expect(old).toMatchObject({ patchset: 1, revision: ps1.revision });
			expect(old.progress.clusters.reviewed).toBe(1);
		});
	});

	describe("re-review", () => {
		const thread = () =>
			reviewThread({ path: "a.txt", line: 2, diffSide: "RIGHT" }, [
				threadComment({ login: "rev1", text: "Why?", commit: pr.head() }),
			]);
		const withThreads = () =>
			pr.scenario({
				prs: {
					12: {
						view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
						graphql: { reviewThreads: [thread()], reviews: [] },
					},
				},
			});
		const now = () => new Date().toISOString();
		/** The answer once the background job is done. */
		const settled = async (
			s: Session,
			from: number,
			to: { head: string } | { patchset: number },
		) => {
			for (;;) {
				const answer = await s.rereview(from, to);
				if (!("pending" in answer)) return answer;
				await new Promise((r) => setTimeout(r, 20));
			}
		};
		const kinds = (answer: Awaited<ReturnType<typeof settled>>) =>
			Object.fromEntries(
				answer.files.map((f) => [
					f.path,
					f.clusters.map((c) =>
						c.from === undefined ? c.kind : `${c.kind}:${c.from}`,
					),
				]),
			);

		it("answers pending at once, then the answer; the viewed head carries provisionally; the first mark starts PS2 with the carries", async () => {
			const s = await Session.open(pr.arg, process.cwd());
			const ps1 = s.snapshot();
			await s.setStates(ps1.revision, [
				{ key: firstKey(s), state: "reviewed" },
			]);
			const newHead = pr.moveHead({ "later.txt": "later\n" });
			const checked = await s.checkHead();
			expect(checked).toMatchObject({
				headMoved: true,
				snapshotHead: ps1.head,
				head: {
					oid: newHead,
					mergeBase: pr.mergeBase,
					baseBranch: "main",
					commits: 1,
				},
			});
			// Pending before any git could answer: the first ask settles
			// ahead of an immediate, which no child process can.
			const first = await Promise.race([
				s.rereview(1, { head: newHead }),
				new Promise<"late">((r) => setImmediate(() => r("late"))),
			]);
			expect(first).toEqual({ pending: true });
			const answer = await settled(s, 1, { head: newHead });
			expect(answer).toMatchObject({
				from: 1,
				toHead: newHead,
				shape: { code: "S1", commits: 1 },
				interdiff: "available",
				toRead: { files: 3, clusters: 3 },
				threads: [],
			});
			expect(kinds(answer)).toEqual({
				"a.txt": ["carried:1", "new"],
				"new.txt": ["new"],
				"later.txt": ["new"],
			});
			// Served from memory now: the same answer, at once.
			expect(await s.rereview(1, { head: newHead })).toEqual(answer);
			// Nothing written yet.
			expect(s.info().patchsets).toHaveLength(1);

			const view = await s.viewHead(newHead);
			expect(view.patchset).toBeNull();
			expect(view.revision).toBe(answer.toRevision);
			expect(view.files[0]?.clusters[0]).toMatchObject({
				state: "reviewed",
				carried: { from: 1, rule: "exact" },
			});
			expect(view.progress.clusters).toEqual({
				total: 4,
				reviewed: 1,
				crossedOff: 0,
			});
			expect(s.info().patchsets).toHaveLength(1);

			// The since view's hunks: the old side numbered in H1', the new in H2.
			const later = view.files.find((f) => f.path === "later.txt");
			if (!later) throw new Error("no later.txt");
			const since = await s.interdiffHunks(1, view.revision, later.index);
			const laterKey = later.clusters[0]?.key;
			expect(since).toEqual({
				hunks: [
					{
						oldStart: 0,
						oldCount: 0,
						newStart: 1,
						newCount: 1,
						lines: [
							{ kind: "add", newNo: 1, text: "later", clusterKey: laterKey },
						],
					},
				],
				newLineCount: 1,
				// One piece, all of later.txt's cluster.
				pieces: [
					{
						hunk: 0,
						line: 0,
						key: laterKey,
						owns: [[0, 1]],
						old: [],
						new: [[1, 2]],
					},
				],
			});
			// a.txt is untouched since PS1: one whole-file gap.
			expect(await s.interdiffHunks(1, view.revision, 0)).toEqual({
				hunks: [],
				newLineCount: 30,
				wholeGap: true,
			});

			// The first mark starts PS2, carrying PS1's mark.
			if (!laterKey) throw new Error("no cluster in later.txt");
			const after = await s.setStates(view.revision, [
				{ key: laterKey, state: "reviewed" },
			]);
			expect(after.patchset).toBe(2);
			expect(after.progress.clusters).toEqual({
				total: 4,
				reviewed: 2,
				crossedOff: 0,
			});
			expect(after.files[0]?.clusters[0]).toMatchObject({
				state: "reviewed",
				carried: { from: 1, rule: "exact" },
			});
			expect(s.info()).toMatchObject({
				patchset: 2,
				snapshotHead: newHead,
				headMoved: false,
				head: { oid: newHead, commits: 0 },
			});
			expect(
				s.info().patchsets.map((p) => [p.number, p.since, p.shape]),
			).toEqual([
				[1, null, null],
				[2, 1, "S1"],
			]);
			expect((await s.review()).revision).toBe(view.revision);
			// PS1 is read-only now; a fresh open lands on PS2 with the carry.
			await expect(
				s.setStates(ps1.revision, [{ key: firstKey(s), state: "unreviewed" }]),
			).rejects.toBeInstanceOf(StaleSnapshotError);
			const again = await Session.open(pr.arg, process.cwd());
			expect(again.info().patchset).toBe(2);
			expect((await again.review()).progress.clusters.reviewed).toBe(2);
			expect((await again.reviewAt(1)).progress.clusters.reviewed).toBe(1);
			await expect(s.rereview(9, { head: newHead })).rejects.toBeInstanceOf(
				RangeError,
			);
			await expect(s.rereview(1, { patchset: 9 })).rejects.toBeInstanceOf(
				RangeError,
			);
			await expect(s.rereview(1, { head: "main" })).rejects.toThrow(
				/Not an object id/,
			);
			// By patch set: PS2 against PS1, its pinned snapshot.
			const toPs2 = await settled(again, 1, { patchset: 2 });
			expect(toPs2).toMatchObject({
				from: 1,
				toHead: newHead,
				toRevision: view.revision,
				shape: { code: "S1" },
			});
			expect(kinds(toPs2)).toEqual(kinds(answer));
		});

		it("the since view's context comes from the interdiff (PS1 numbering on the old side); a file it doesn't touch is one whole-file gap", async () => {
			const s = await Session.open(pr.arg, process.cwd());
			const ps1 = s.snapshot();
			await s.setStates(ps1.revision, [
				{ key: firstKey(s), state: "reviewed" },
			]);
			// PS2 changes a.txt's line 15 and adds a line after it (the new
			// side shifts by one below it); new.txt is untouched since PS1.
			const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
			lines[1] = "line 2 changed";
			lines[25] = "line 26 changed";
			const ps2Lines = [...lines];
			ps2Lines[14] = "line 15 again";
			ps2Lines.splice(15, 0, "inserted");
			const newHead = pr.moveHead({
				"a.txt": `${ps2Lines.join("\n")}\n`,
				"new.txt": "new\n",
			});
			await s.checkHead();
			const answer = await settled(s, 1, { head: newHead });
			const view = await s.viewHead(newHead);
			expect(view.revision).toBe(answer.toRevision);
			const a = view.files.find((f) => f.path === "a.txt");
			const added = view.files.find((f) => f.path === "new.txt");
			if (!a || !added) throw new Error("no a.txt or new.txt");

			const since = await s.interdiffHunks(1, view.revision, a.index);
			expect(
				since.hunks.map((h) => [h.oldStart, h.newStart, h.newCount]),
			).toEqual([[12, 12, 8]]);
			// Lines 1–3 hold line 2, which the PR added at PS1 and left
			// unchanged since: the interdiff's context, PS1 and PS2 numbering.
			expect(await s.interdiffContext(1, view.revision, a.index, 1, 3)).toEqual(
				[
					{ kind: "context", oldNo: 1, newNo: 1, text: "line 1" },
					{ kind: "context", oldNo: 2, newNo: 2, text: "line 2 changed" },
					{ kind: "context", oldNo: 3, newNo: 3, text: "line 3" },
				],
			);
			// Below the change, the old side is PS1's (one line behind).
			expect(
				await s.interdiffContext(1, view.revision, a.index, 26, 27),
			).toEqual([
				{ kind: "context", oldNo: 25, newNo: 26, text: "line 25" },
				{ kind: "context", oldNo: 26, newNo: 27, text: "line 26 changed" },
			]);
			// The full diff's context for the same lines is unchanged: line 2
			// is its own change there.
			expect(await s.context(view.revision, a.index, 1, 3)).toEqual([
				{ kind: "context", oldNo: 1, newNo: 1, text: "line 1" },
				{ kind: "context", oldNo: 3, newNo: 3, text: "line 3" },
			]);

			// new.txt is untouched since PS1: no hunks, one whole-file gap.
			expect(await s.interdiffHunks(1, view.revision, added.index)).toEqual({
				hunks: [],
				newLineCount: 1,
				wholeGap: true,
			});
			expect(
				await s.interdiffContext(1, view.revision, added.index, 1, 1),
			).toEqual([{ kind: "context", oldNo: 1, newNo: 1, text: "new" }]);
		});

		/**
		 * A push made by hand on `from` (git commands in a worktree of the
		 * GitHub-side repo), the fake gh pointed at it (base `baseRefOid`).
		 */
		const pushByHand = (
			from: string,
			steps: (git: (...args: string[]) => string, dir: string) => void,
			baseRefOid?: string,
		) => {
			const dir = mkdtempSync(join(tmpdir(), "crb-push-"));
			const repoGit = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: pr.repo.path,
					encoding: "utf8",
					env: testGitEnv(),
				}).trim();
			repoGit("worktree", "add", "--quiet", "--detach", dir, from);
			const w = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: dir,
					encoding: "utf8",
					env: testGitEnv(),
				}).trim();
			steps(w, dir);
			const head = w("rev-parse", "HEAD");
			repoGit("worktree", "remove", "--force", dir);
			rmSync(dir, { recursive: true, force: true });
			repoGit("update-ref", "refs/pull/12/head", head);
			pr.scenario({
				prs: {
					12: {
						view: prView({
							headRefOid: head,
							baseRefName: "main",
							...(baseRefOid ? { baseRefOid } : {}),
						}),
					},
				},
			});
			return head;
		};
		/** PS1 marked, then `push()`: the since view of the new head. */
		const sinceAfter = async (push: () => string) => {
			const s = await Session.open(pr.arg, process.cwd());
			const ps1 = s.snapshot();
			await s.setStates(ps1.revision, [
				{ key: firstKey(s), state: "reviewed" },
			]);
			const newHead = push();
			await s.checkHead();
			const answer = await settled(s, 1, { head: newHead });
			expect(answer.interdiff).toBe("available");
			const view = await s.viewHead(newHead);
			const index = (path: string) => {
				const f = view.files.find((x) => x.path === path);
				if (!f) throw new Error(`no ${path}`);
				return f.index;
			};
			return { s, view, index };
		};
		const lines30 = () => {
			const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
			lines[1] = "line 2 changed";
			lines[25] = "line 26 changed";
			return lines;
		};

		it("since view, a file the interdiff only renames: one whole-file gap of its lines", async () => {
			const { s, view, index } = await sinceAfter(() =>
				pushByHand(pr.head(), (git) => {
					git("mv", "new.txt", "renamed.txt");
					git("commit", "--quiet", "-m", "rename");
				}),
			);
			const renamed = index("renamed.txt");
			expect(await s.interdiffHunks(1, view.revision, renamed)).toEqual({
				hunks: [],
				newLineCount: 1,
				wholeGap: true,
			});
			expect(await s.interdiffContext(1, view.revision, renamed, 1, 1)).toEqual(
				[{ kind: "context", oldNo: 1, newNo: 1, text: "new" }],
			);
		});

		it("since view, an untouched file without a newline at its end: its last line says so", async () => {
			pr.moveHead({ "nonl.txt": "x\ny" });
			const { s, view, index } = await sinceAfter(() =>
				pr.moveHead({ "later.txt": "later\n" }),
			);
			const nonl = index("nonl.txt");
			expect(await s.interdiffHunks(1, view.revision, nonl)).toEqual({
				hunks: [],
				newLineCount: 2,
				wholeGap: true,
			});
			expect(await s.interdiffContext(1, view.revision, nonl, 1, 2)).toEqual([
				{ kind: "context", oldNo: 1, newNo: 1, text: "x" },
				{ kind: "context", oldNo: 2, newNo: 2, text: "y", noNewline: true },
			]);
		});

		it("since view after the base moved: gap lines are the head's on the new side, the rebased PS1's on the old", async () => {
			// main inserts 5 lines after base line 14; PS2 merges it and
			// changes line 10.
			const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
			const mid = ["mid 1", "mid 2", "mid 3", "mid 4", "mid 5"];
			const insert = (lines: string[]) => [
				...lines.slice(0, 14),
				...mid,
				...lines.slice(14),
			];
			writeFileSync(
				join(pr.repo.path, "a.txt"),
				`${insert(base).join("\n")}\n`,
			);
			const main = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: pr.repo.path,
					encoding: "utf8",
					env: testGitEnv(),
				}).trim();
			main("commit", "--quiet", "-am", "main inserts mid lines");
			const b2 = main("rev-parse", "HEAD");
			const ps2 = insert(lines30());
			ps2[9] = "line 10 again";
			const { s, view, index } = await sinceAfter(() =>
				pushByHand(
					pr.head(),
					(git, dir) => {
						git("merge", "--quiet", "--no-edit", b2);
						writeFileSync(join(dir, "a.txt"), `${ps2.join("\n")}\n`);
						git("commit", "--quiet", "-am", "line 10 again");
					},
					b2,
				),
			);
			const a = index("a.txt");
			const since = await s.interdiffHunks(1, view.revision, a);
			expect(since.hunks.map((h) => [h.oldStart, h.newStart])).toEqual([
				[7, 7],
			]);
			// Below base's insertion: head 30–32 are base 25–27, line 26 the
			// PR's own (unchanged since PS1). The rebased PS1 has the mid
			// lines too, so its numbers are the head's.
			expect(await s.interdiffContext(1, view.revision, a, 30, 32)).toEqual([
				{ kind: "context", oldNo: 30, newNo: 30, text: "line 25" },
				{ kind: "context", oldNo: 31, newNo: 31, text: "line 26 changed" },
				{ kind: "context", oldNo: 32, newNo: 32, text: "line 27" },
			]);
			// The new side is the head's numbering, as a RIGHT anchor's is:
			// the full diff (base B2 → head) agrees on the line at 30.
			expect(await s.context(view.revision, a, 30, 30)).toEqual([
				{ kind: "context", oldNo: 30, newNo: 30, text: "line 25" },
			]);
		});

		it("a new thread and a verdict start a patch set; a reply, a resolve and an unresolve never do", async () => {
			withThreads();
			const s = await Session.open(pr.arg, process.cwd());
			await s.overview(0);
			expect(s.info().patchset).toBeNull();
			const reply = { attemptedAt: now(), retry: false, knownCommentIds: [] };
			await s.replyToThread("T12-0", { ...reply, body: "ok", clientId: "r1" });
			await s.setThreadResolved("T12-0", true);
			await s.setThreadResolved("T12-0", false);
			expect(s.info().patchset).toBeNull();
			expect(s.info().patchsets).toEqual([]);
			await s.startThread({
				clientId: "n1",
				body: "Why?",
				attemptedAt: now(),
				retry: false,
				path: "a.txt",
				commit: pr.head(),
				subject: "line",
				side: "RIGHT",
				line: 2,
			});
			expect(s.info()).toMatchObject({ patchset: 1, snapshotHead: pr.head() });
			expect(s.info().patchsets[0]).toMatchObject({ number: 1, since: null });

			// A verdict on a viewed head starts the next one, with the carries.
			const key = firstKey(s);
			const ps1Head = pr.head();
			await s.setStates(s.snapshot().revision, [{ key, state: "reviewed" }]);
			const newHead = pr.moveHead({ "later.txt": "later\n" });
			await s.checkHead();
			await s.viewHead(newHead);
			await s.submitVerdict({
				clientId: "v1",
				event: "APPROVE",
				commit: newHead,
				attemptedAt: now(),
				retry: false,
			});
			expect(s.info()).toMatchObject({ patchset: 2, snapshotHead: newHead });
			expect(s.info().patchsets[1]).toMatchObject({
				number: 2,
				since: 1,
				shape: "S1",
			});
			const view = await s.review();
			expect(view.patchset).toBe(2);
			expect(view.files[0]?.clusters[0]).toMatchObject({
				state: "reviewed",
				carried: { from: 1, rule: "exact" },
			});
			// A thread on the earlier patch set's head is refused: read-only.
			const stale = await s
				.startThread({
					clientId: "n2",
					body: "Late",
					attemptedAt: now(),
					retry: false,
					path: "a.txt",
					commit: ps1Head,
					subject: "file",
				})
				.then(
					() => null,
					(e: unknown) => e,
				);
			expect(stale).toMatchObject({ code: "stale" });
		});

		it("viewing the head of an earlier patch set shows that patch set (a force-push back)", async () => {
			const s = await Session.open(pr.arg, process.cwd());
			const ps1 = s.snapshot();
			await s.setStates(ps1.revision, [
				{ key: firstKey(s), state: "reviewed" },
			]);
			const newHead = pr.moveHead({ "later.txt": "later\n" });
			await s.checkHead();
			const view = await s.viewHead(newHead);
			const laterKey = view.files.find((f) => f.path === "later.txt")
				?.clusters[0]?.key;
			if (!laterKey) throw new Error("no cluster in later.txt");
			await s.setStates(view.revision, [{ key: laterKey, state: "reviewed" }]);
			expect(s.info().patchset).toBe(2);
			const back = await s.viewHead(ps1.head);
			expect(back).toMatchObject({ patchset: 1, revision: ps1.revision });
			expect(back.progress.clusters.reviewed).toBe(1);
			// The engine for PS2 → PS1's head: a move back, with what is gone.
			const answer = await settled(s, 2, { head: ps1.head });
			expect(answer.shape.code).toBe("S6");
			expect(kinds(answer)).toEqual({
				"a.txt": ["carried:1", "new"],
				"new.txt": ["new"],
				// Only PS2 had it: listed past the snapshot's files.
				"later.txt": ["gone:2"],
			});
			expect(answer.files.at(-1)).toMatchObject({
				index: 2,
				path: "later.txt",
			});
		});

		it("M2: a retarget under the same head gives a fresh answer by snapshot id, and viewHead overlays it", async () => {
			const s = await Session.open(pr.arg, process.cwd());
			const ps1 = s.snapshot();
			await s.setStates(ps1.revision, [
				{ key: firstKey(s), state: "reviewed" },
			]);
			const newHead = pr.moveHead({ "later.txt": "later\n" });
			await s.checkHead();
			const before = await settled(s, 1, { head: newHead });
			// The base branch becomes one that holds the new head itself: the
			// merge base is the head, the comparison empty.
			execFileSync("git", ["branch", "develop", newHead], {
				cwd: pr.repo.path,
				env: testGitEnv(),
			});
			pr.scenario({
				prs: {
					12: { view: prView({ headRefOid: newHead, baseRefName: "develop" }) },
				},
			});
			const checked = await s.checkHead();
			expect(checked.head).toMatchObject({ oid: newHead, mergeBase: newHead });
			const after = await settled(s, 1, { head: newHead });
			expect(after.toRevision).not.toBe(before.toRevision);
			expect(after.files).toEqual([]);
			const view = await s.viewHead(newHead);
			expect(view.revision).toBe(after.toRevision);
			expect(view.files).toEqual([]);
		});

		it("the base taking in the PR's first commit under the same head moves the merge base; a mark starts PS2 on it", async () => {
			const first = pr.head();
			const view = (baseRefOid: string) =>
				pr.scenario({
					prs: {
						12: {
							view: prView({
								headRefOid: pr.head(),
								baseRefName: "main",
								baseRefOid,
							}),
						},
					},
				});
			const h2 = pr.moveHead({ "later.txt": "later\n" });
			view(pr.mergeBase);
			const s = await Session.open(pr.arg, process.cwd());
			const ps1 = s.snapshot();
			expect(ps1.base).toBe(pr.mergeBase);
			await s.setStates(ps1.revision, [
				{ key: firstKey(s), state: "reviewed" },
			]);
			// main takes in the PR's first commit (same sha); the head stays.
			pr.moveMain(first);
			view(first);
			const checked = await s.checkHead();
			expect(checked).toMatchObject({
				headMoved: false,
				snapshotHead: h2,
				head: { oid: h2, mergeBase: first, baseBranch: "main", commits: 0 },
			});
			const clone = clonePath("acme", "widget");
			const tracking = () =>
				execFileSync(
					"git",
					["-C", clone, "rev-parse", "refs/remotes/origin/main"],
					{ env: testGitEnv(), encoding: "utf8" },
				).trim();
			expect(tracking()).toBe(first);
			// Once per triple: main moves on the origin only (GitHub still
			// reports the same base oid), and nothing is fetched again.
			pr.moveMain(h2);
			await s.checkHead();
			expect(tracking()).toBe(first);
			expect(s.info().head).toMatchObject({ mergeBase: first });
			const answer = await settled(s, 1, { head: h2 });
			// PS1's first commit is in the base now: only later.txt is the PR's.
			expect(kinds(answer)).toEqual({ "later.txt": ["new"] });
			expect(answer.toRead).toEqual({ files: 1, clusters: 1 });
			const viewed = await s.viewHead(h2);
			expect(viewed.revision).toBe(answer.toRevision);
			expect(viewed.revision).not.toBe(ps1.revision);
			const later = viewed.files.find((f) => f.path === "later.txt");
			const laterKey = later?.clusters[0]?.key;
			if (!laterKey) throw new Error("no cluster in later.txt");
			const after = await s.setStates(viewed.revision, [
				{ key: laterKey, state: "reviewed" },
			]);
			expect(after.patchset).toBe(2);
			expect(s.info().patchsets.map((p) => [p.number, p.mergeBase])).toEqual([
				[1, pr.mergeBase],
				[2, first],
			]);
		});

		it("L2: a thread on a head two kept snapshots share goes to the patch set's: read-only", async () => {
			withThreads();
			const s = await Session.open(pr.arg, process.cwd());
			await s.overview(0);
			const ps1 = s.snapshot();
			await s.setStates(ps1.revision, [
				{ key: firstKey(s), state: "reviewed" },
			]);
			const newHead = pr.moveHead({ "later.txt": "later\n" });
			await s.checkHead();
			const view = await s.viewHead(newHead);
			const laterKey = view.files.find((f) => f.path === "later.txt")
				?.clusters[0]?.key;
			if (!laterKey) throw new Error("no cluster in later.txt");
			await s.setStates(view.revision, [{ key: laterKey, state: "reviewed" }]);
			// Back on PS1's head with the base retargeted to it: another
			// snapshot with that head, kept after the patch set's.
			execFileSync("git", ["branch", "develop", ps1.head], {
				cwd: pr.repo.path,
				env: testGitEnv(),
			});
			pr.scenario({
				prs: {
					12: {
						view: prView({ headRefOid: ps1.head, baseRefName: "develop" }),
						graphql: { reviewThreads: [thread()], reviews: [] },
					},
				},
			});
			await s.checkHead();
			const viewed = await s.viewHead(ps1.head);
			expect(viewed.revision).not.toBe(ps1.revision);
			expect(s.info().patchsets).toHaveLength(2);
			const refused = await s
				.startThread({
					clientId: "n9",
					body: "Late",
					attemptedAt: now(),
					retry: false,
					path: "a.txt",
					commit: ps1.head,
					subject: "file",
				})
				.then(
					() => null,
					(e: unknown) => e,
				);
			expect(refused).toMatchObject({ code: "stale" });
			expect(s.info().patchsets).toHaveLength(2);
		});

		it("S7: each patch set keeps its own base branch; after a retarget PS1 still says main, PS2 the new base", async () => {
			const s = await Session.open(pr.arg, process.cwd());
			await s.overview(0);
			const ps1 = s.snapshot();
			await s.setStates(ps1.revision, [
				{ key: firstKey(s), state: "reviewed" },
			]);
			// Retargeted to develop (at main's tip), then a push.
			execFileSync("git", ["branch", "develop", pr.mergeBase], {
				cwd: pr.repo.path,
				env: testGitEnv(),
			});
			const newHead = pr.moveHead({ "later.txt": "later\n" });
			pr.scenario({
				prs: {
					12: {
						view: prView({ headRefOid: newHead, baseRefName: "develop" }),
						graphql: { reviewThreads: [], reviews: [] },
					},
				},
			});
			await s.checkHead();
			const view = await s.viewHead(newHead);
			const laterKey = view.files.find((f) => f.path === "later.txt")
				?.clusters[0]?.key;
			if (!laterKey) throw new Error("no cluster in later.txt");
			await s.setStates(view.revision, [{ key: laterKey, state: "reviewed" }]);
			expect(s.info().patchsets.map((p) => [p.number, p.baseBranch])).toEqual([
				[1, "main"],
				[2, "develop"],
			]);
			const again = await Session.open(pr.arg, process.cwd());
			expect(again.info().patchsets.map((p) => p.baseBranch)).toEqual([
				"main",
				"develop",
			]);
		});

		it("checkHead compares the triple: the same head costs no fetch; a base branch change fetches once and reports the merge base", async () => {
			const s = await Session.open(pr.arg, process.cwd());
			const clone = clonePath("acme", "widget");
			const git = (...args: string[]) =>
				execFileSync("git", ["-C", clone, ...args], {
					env: testGitEnv(),
					encoding: "utf8",
				}).trim();
			const origin = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: pr.repo.path,
					env: testGitEnv(),
					encoding: "utf8",
				}).trim();
			// main moves on without the merge base changing (S2).
			origin("checkout", "--quiet", "main");
			writeFileSync(join(pr.repo.path, "x.txt"), "x\n");
			origin("add", "--all");
			origin("commit", "--quiet", "-m", "base: x.txt");
			const mainNow = origin("rev-parse", "HEAD");
			expect((await s.checkHead()).head).toEqual({
				oid: pr.head(),
				mergeBase: pr.mergeBase,
				baseBranch: "main",
				commits: 0,
			});
			expect(git("rev-parse", "refs/remotes/origin/main")).toBe(pr.mergeBase);
			// Retargeted (S7): the new base branch is fetched, the merge base moves.
			origin("branch", "develop", pr.head());
			pr.scenario({
				prs: {
					12: {
						view: prView({ headRefOid: pr.head(), baseRefName: "develop" }),
					},
				},
			});
			expect((await s.checkHead()).head).toEqual({
				oid: pr.head(),
				mergeBase: pr.head(),
				baseBranch: "develop",
				commits: 0,
			});
			expect(git("rev-parse", "refs/remotes/origin/develop")).toBe(pr.head());
			// The same pair again: nothing fetched (develop moved on the origin only).
			origin("update-ref", "refs/heads/develop", mainNow);
			await s.checkHead();
			expect(git("rev-parse", "refs/remotes/origin/develop")).toBe(pr.head());
			// A merged PR reports no head.
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
			expect((await s.checkHead()).head).toBeNull();
		});
	});

	describe("agent", () => {
		let fake: ReturnType<typeof useFakeAcp>;
		beforeEach(() => {
			fake = useFakeAcp(pr.repo.path, {
				agent: { name: "fake-acp", version: "1.0.0" },
				hold: ["initialize"],
			});
		});
		afterEach(() => fake.restore());

		it("a --viewer session has no agent host; an as-of one neither", async () => {
			const theirs = await Session.open(pr.arg, process.cwd(), () => {}, {
				viewer: "someone-else",
			});
			expect(theirs.agent).toBeNull();
			const mine = await Session.open(pr.arg, process.cwd());
			expect(mine.agent).not.toBeNull();
		});

		it("close() closes the host (checkout removed)", async () => {
			const s = await Session.open(pr.arg, process.cwd());
			const host = s.agent;
			if (!host) throw new Error("no agent");
			host.start();
			await vi.waitFor(
				async () => expect((await host.status()).state).toBe("starting"),
				{ timeout: 20_000, interval: 20 },
			);
			releaseAcp(fake.scenario, "initialize");
			await vi.waitFor(
				async () => expect((await host.status()).state).toBe("ready"),
				{ timeout: 20_000, interval: 20 },
			);
			const tree = join(agentsDir(), s.id, "tree");
			expect(git(tree, "rev-parse", "HEAD")).toBe(pr.head());
			const pid = acpLog(fake.log)[0]?.pid as number;
			await s.close();
			expect(() => readFileSync(join(tree, "a.txt"))).toThrow();
			expect(() => process.kill(pid, 0)).toThrow();
			expect((await host.status()).state).toBe("off");
		});
	});
});
