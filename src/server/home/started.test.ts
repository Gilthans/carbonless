import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testGitEnv } from "../../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../../test/pr-fixture";
import type { Snapshot } from "../../shared/types.js";
import { ensureClone, ensureRepoInit, fetchPr } from "../clone.js";
import { buildSnapshot } from "../diff/snapshot.js";
import { runGit } from "../git.js";
import { RefStore } from "../review/refStore.js";
import { ReviewService } from "../review/reviews.js";
import { StartedReviews } from "./started.js";

// Each fake gh call is a node process, and the scaling test starts 32
// reviews through them: give a loaded machine time.
vi.setConfig({ testTimeout: 60_000 });

// Pass-through spy, so a test can count the gits a scan starts.
vi.mock("../git.js", async (importOriginal) => {
	const git = await importOriginal<typeof import("../git.js")>();
	return { ...git, runGit: vi.fn(git.runGit) };
});
const gits = vi.mocked(runGit);

const PR = {
	owner: "acme",
	repo: "widget",
	number: 12,
	url: "https://github.com/acme/widget/pull/12",
	baseBranch: "main",
	headBranch: "feature",
	headRepo: "acme/widget",
};

describe("StartedReviews", () => {
	let fx: PrFixture;
	let reviews: ReviewService;
	let snap: Snapshot;
	let builds: number;
	const scanner = () =>
		new StartedReviews({
			build: (...args) => {
				builds++;
				return buildSnapshot(...args);
			},
		});

	beforeEach(async () => {
		fx = createPrFixture();
		builds = 0;
		const repo = await ensureClone("acme", "widget");
		const { mergeBase, head } = await fetchPr(repo, {
			...PR,
			title: "t",
			headOid: fx.head(),
			state: "OPEN",
		});
		snap = await buildSnapshot(repo, mergeBase, head);
		reviews = new ReviewService(new RefStore(repo));
	});
	afterEach(() => fx.cleanup());

	const keys = () => snap.files.flatMap((f) => f.clusters.map((c) => c.key));

	it("a review opened but never acted on isn't started", async () => {
		await reviews.findOrCreateReview(PR, "octo");
		expect(await scanner().list("octo")).toEqual([]);
	});

	it("the viewer's first action starts it, with coverage and last action", async () => {
		const id = await reviews.findOrCreateReview(PR, "octo");
		const [first] = keys();
		const before = Date.now();
		await reviews.recordStates(id, "octo", snap, [
			{ key: first as string, state: "reviewed" },
		]);
		const [started, ...rest] = await scanner().list("octo");
		expect(rest).toEqual([]);
		const lines = snap.files
			.flatMap((f) => f.clusters)
			.reduce((n, c) => n + c.lines, 0);
		const firstLines = snap.files.flatMap((f) => f.clusters)[0]?.lines;
		expect(started).toMatchObject({
			owner: "acme",
			repo: "widget",
			number: 12,
			id,
			pinnedHead: null,
			head: snap.head,
			asOf: null,
			coverage: { done: firstLines, total: lines, unit: "lines" },
		});
		expect(Date.parse(started?.lastActedAt ?? "")).toBeGreaterThanOrEqual(
			before - 5,
		);
	});

	it("asked for one repo, scans only that repo's clone", async () => {
		const id = await reviews.findOrCreateReview(PR, "octo");
		const [first] = keys();
		await reviews.recordStates(id, "octo", snap, [
			{ key: first as string, state: "reviewed" },
		]);
		expect(await scanner().list("octo", undefined, "acme/other")).toEqual([]);
		expect(
			(await scanner().list("octo", undefined, "Acme/Widget")).map((s) => s.id),
		).toEqual([id]);
	});

	it("crossed-off lines leave the total; clusters stand in when lines look done", async () => {
		const id = await reviews.findOrCreateReview(PR, "octo");
		const all = keys();
		// new.txt's cluster has 1 line; cross off everything but one cluster.
		const [keep, ...others] = all;
		await reviews.recordStates(
			id,
			"octo",
			snap,
			others.map((key) => ({ key, state: "crossed-off" as const })),
		);
		const [s] = await scanner().list("octo");
		const keepLines = snap.files
			.flatMap((f) => f.clusters)
			.find((c) => c.key === keep)?.lines;
		expect(s?.coverage).toEqual({ done: 0, total: keepLines, unit: "lines" });
	});

	it("only the viewer's own progress counts", async () => {
		const id = await reviews.findOrCreateReview(PR, "octo");
		await reviews.recordStates(id, "someone-else", snap, [
			{ key: keys()[0] as string, state: "reviewed" },
		]);
		expect(await scanner().list("octo")).toEqual([]);
		expect(await scanner().list("someone-else")).toHaveLength(1);
	});

	it("as-of reviews never count; pinned ones do, with their head", async () => {
		const asOf = await reviews.findOrCreateReview(PR, "octo", {
			asOf: "2026-10-01T00:00:00Z",
		});
		const pinned = await reviews.findOrCreateReview(PR, "octo", {
			head: snap.head,
		});
		const change = [{ key: keys()[0] as string, state: "reviewed" as const }];
		await reviews.recordStates(asOf, "octo", snap, change);
		await reviews.recordStates(pinned, "octo", snap, change);
		const list = await scanner().list("octo");
		expect(list.map((s) => [s.id, s.pinnedHead])).toEqual([
			[pinned, snap.head],
		]);
	});

	it("reads coverage only for the repos asked: none for one outside the view", async () => {
		const id = await reviews.findOrCreateReview(PR, "octo");
		await reviews.recordStates(id, "octo", snap, [
			{ key: keys()[0] as string, state: "reviewed" },
		]);
		const [outside] = await scanner().list("octo", new Set(["acme/api"]));
		expect(outside).toMatchObject({ id, coverage: null });
		expect(builds).toBe(0);
		const [inView] = await scanner().list("octo", new Set(["acme/widget"]));
		expect(inView?.coverage?.done).toBeGreaterThan(0);
	});

	it("caches the snapshot by (repo, merge base, head), coverage by progress", async () => {
		const id = await reviews.findOrCreateReview(PR, "octo");
		const [a, b] = keys();
		await reviews.recordStates(id, "octo", snap, [
			{ key: a as string, state: "reviewed" },
		]);
		const s = scanner();
		await s.list("octo");
		await s.list("octo");
		expect(builds).toBe(1);
		await reviews.recordStates(id, "octo", snap, [
			{ key: b as string, state: "reviewed" },
		]);
		const [after] = await s.list("octo");
		expect(builds).toBe(1);
		expect(after?.coverage?.done).toBeGreaterThan(0);
	});

	it("a broken clone or review is skipped, not the whole scan", async () => {
		const id = await reviews.findOrCreateReview(PR, "octo");
		await reviews.recordStates(id, "octo", snap, [
			{ key: keys()[0] as string, state: "reviewed" },
		]);
		// Another clone whose progress ref's history is broken (a parent missing).
		const other = await ensureRepoInit("other", "tool");
		const git = (args: string[], input?: string) =>
			execFileSync("git", args, {
				cwd: other,
				input,
				encoding: "utf8",
				env: testGitEnv(),
			}).trim();
		const tree = git(["hash-object", "-w", "-t", "tree", "/dev/null"]);
		const broken = git(
			["hash-object", "-w", "-t", "commit", "--stdin"],
			`tree ${tree}\nparent ${"1".repeat(40)}\nauthor octo <octo@crb> 0 +0000\ncommitter crb <crb@crb> 0 +0000\n\ncrb: x\n`,
		);
		git([
			"update-ref",
			`refs/crb/reviews/${"0".repeat(26)}/reviewers/octo/progress`,
			broken,
		]);
		// And a directory that isn't a repo at all.
		mkdirSync(join(dirname(other), "junk.git"));
		const list = await scanner().list("octo");
		expect(list.map((s) => s.id)).toEqual([id]);
	});

	/** Starts `n` more reviews (PRs from `from` on), each with one mark. */
	const startMany = async (from: number, n: number) => {
		const [first] = keys();
		for (let i = 0; i < n; i++) {
			const id = await reviews.findOrCreateReview(
				{ ...PR, number: from + i, url: `${PR.url}${from + i}` },
				"octo",
			);
			await reviews.recordStates(id, "octo", snap, [
				{ key: first as string, state: "reviewed" },
			]);
		}
	};

	/** The gits one Home load's scan starts (view() asks for no coverage). */
	const homeScan = async (s: StartedReviews) => {
		gits.mockClear();
		const list = await s.list("octo", new Set());
		return { count: gits.mock.calls.length, list };
	};

	it("Home's scan starts as many gits with 32 started reviews as with 8 (CAR-307)", async () => {
		await startMany(100, 8);
		const eight = scanner();
		const cold8 = await homeScan(eight);
		const warm8 = await homeScan(eight);
		expect(cold8.list).toHaveLength(8);
		await startMany(200, 24);
		const many = scanner();
		const cold32 = await homeScan(many);
		const warm32 = await homeScan(many);
		expect(cold32.list).toHaveLength(32);
		expect(warm32.list).toHaveLength(32);
		// One clone: a for-each-ref, and a git log only when tips moved.
		expect(cold32.count).toBe(cold8.count);
		expect(warm32.count).toBe(warm8.count);
		expect(warm32.count).toBe(1);
		expect(cold32.count).toBe(2);
	});

	it("a repo's scan with coverage reads no git again while nothing moved", async () => {
		await startMany(100, 4);
		const s = scanner();
		const cold = await s.list("octo", new Set(["acme/widget"]));
		expect(cold.every((r) => (r.coverage?.done ?? 0) > 0)).toBe(true);
		gits.mockClear();
		const warm = await s.list("octo", new Set(["acme/widget"]), "acme/widget");
		expect(gits.mock.calls.length).toBe(1);
		expect(warm).toEqual(cold);
	});

	/** A scanner whose snapshots are `snap`, built without git. */
	const gitless = (build: () => Promise<Snapshot> = async () => snap) =>
		new StartedReviews({ build });

	it("Home's view, then its repo's read on the same scanner: coverage with one git log", async () => {
		await startMany(100, 3);
		const s = gitless();
		const listed = await s.list("octo", new Set());
		expect(listed.map((r) => r.coverage)).toEqual([null, null, null]);
		gits.mockClear();
		const repo = await s.list("octo", new Set(["acme/widget"]), "acme/widget");
		expect(repo).toHaveLength(3);
		expect(repo.every((r) => (r.coverage?.done ?? 0) > 0)).toBe(true);
		// The for-each-ref, and one git log of the three progress tips.
		expect(gits.mock.calls.length).toBe(2);
		gits.mockClear();
		await s.list("octo", new Set(["acme/widget"]), "acme/widget");
		expect(gits.mock.calls.length).toBe(1);
	});

	it("coverage that couldn't be read is tried again from the kept events, no git log", async () => {
		await startMany(100, 1);
		let fail = true;
		const s = gitless(async () => {
			if (fail) {
				fail = false;
				throw new Error("commits not fetched");
			}
			return snap;
		});
		const [first] = await s.list("octo");
		expect(first?.coverage).toEqual({ done: 0, total: 0, unit: "clusters" });
		gits.mockClear();
		const [again] = await s.list("octo");
		expect(again?.coverage?.done).toBeGreaterThan(0);
		expect(gits.mock.calls.length).toBe(1);
	});

	it("a review with a broken history is skipped once, not read again while its tips stay", async () => {
		await startMany(100, 1);
		const broken = await reviews.findOrCreateReview(
			{ ...PR, number: 13, url: `${PR.url}3` },
			"octo",
		);
		const repo = await ensureClone("acme", "widget");
		const git = (args: string[], input?: string) =>
			execFileSync("git", args, {
				cwd: repo,
				input,
				encoding: "utf8",
				env: testGitEnv(),
			}).trim();
		const tree = git(["hash-object", "-w", "-t", "tree", "/dev/null"]);
		const commit = git(
			["hash-object", "-w", "-t", "commit", "--stdin"],
			`tree ${tree}\nparent ${"1".repeat(40)}\nauthor octo <octo@crb> 0 +0000\ncommitter crb <crb@crb> 0 +0000\n\ncrb: x\n`,
		);
		git([
			"update-ref",
			`refs/crb/reviews/${broken}/reviewers/octo/progress`,
			commit,
		]);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const s = gitless();
		expect(await s.list("octo", new Set())).toHaveLength(1);
		expect(errors).toHaveBeenCalledTimes(1);
		gits.mockClear();
		expect(await s.list("octo", new Set())).toHaveLength(1);
		expect(gits.mock.calls.length).toBe(1);
		expect(errors).toHaveBeenCalledTimes(1);
		errors.mockRestore();
	});

	it("a review started, marked further or removed elsewhere shows on the next scan", async () => {
		const s = scanner();
		const [a, b] = keys();
		expect(await s.list("octo")).toEqual([]);
		// Started by another writer (another tab, the crb CLI): a new ref.
		const id = await reviews.findOrCreateReview(PR, "octo");
		await reviews.recordStates(id, "octo", snap, [
			{ key: a as string, state: "reviewed" },
		]);
		const [first] = await s.list("octo");
		expect(first?.id).toBe(id);
		// Marked further: the tip moved, coverage follows.
		await reviews.recordStates(id, "octo", snap, [
			{ key: b as string, state: "reviewed" },
		]);
		const [next] = await s.list("octo");
		expect(next?.coverage?.done).toBeGreaterThan(first?.coverage?.done ?? 0);
		expect(Date.parse(next?.lastActedAt ?? "")).toBeGreaterThanOrEqual(
			Date.parse(first?.lastActedAt ?? ""),
		);
		// Removed (its refs deleted): gone at once.
		const repo = await ensureClone("acme", "widget");
		execFileSync(
			"git",
			["update-ref", "-d", `refs/crb/reviews/${id}/reviewers/octo/progress`],
			{ cwd: repo, env: testGitEnv() },
		);
		expect(await s.list("octo")).toEqual([]);
	});

	it("a reviewer who acted nowhere started nothing", async () => {
		expect(await new StartedReviews().list("nobody")).toEqual([]);
	});
});
