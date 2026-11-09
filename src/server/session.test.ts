import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
