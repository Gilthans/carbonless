import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testGitEnv } from "../../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../../test/pr-fixture";
import { seedStartedReviews } from "../../../test/started-seed";
import type { Snapshot } from "../../shared/types.js";
import { ensureClone, ensureRepoInit, fetchPr } from "../clone.js";
import { buildSnapshot, clearSnapshotCaches } from "../diff/snapshot.js";
import { runGit } from "../git.js";
import { cacheDir } from "../paths.js";
import { newEvent } from "../review/events.js";
import { RefStore } from "../review/refStore.js";
import { ReviewService } from "../review/reviews.js";
import type { BuildInfo } from "../version.js";
import { buildKey, StartedReviews } from "./started.js";

// Each fake gh call is a node process, and the scaling test starts 32
// reviews through them: give a loaded machine time.
vi.setConfig({ testTimeout: 60_000 });

// Pass-through spy, so a test can count the gits a scan starts.
vi.mock("../git.js", async (importOriginal) => {
	const git = await importOriginal<typeof import("../git.js")>();
	return { ...git, runGit: vi.fn(git.runGit) };
});
const gits = vi.mocked(runGit);

/** The build the scanners count as (a clean one: its coverage is kept on disk). */
const BUILD_A: BuildInfo = { version: "9.9.9-rc.1", commit: "a".repeat(40) };

/** The PR keys Home asks coverage for: acme/widget's PRs `numbers`. */
const prs = (...numbers: number[]) =>
	new Set(numbers.map((n) => `acme/widget#${n}`));

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
	const scanner = (buildInfo: BuildInfo = BUILD_A) =>
		new StartedReviews({
			build: (...args) => {
				builds++;
				return buildSnapshot(...args);
			},
			buildInfo,
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

	it("reads coverage only for the PRs asked: none for one with no row (CAR-324)", async () => {
		const id = await reviews.findOrCreateReview(PR, "octo");
		await reviews.recordStates(id, "octo", snap, [
			{ key: keys()[0] as string, state: "reviewed" },
		]);
		const [outside] = await scanner().list("octo", new Set(["acme/api#12"]));
		expect(outside).toMatchObject({ id, coverage: null });
		// Another PR of the same repo (its row shown, this one's not).
		const [otherPr] = await scanner().list("octo", prs(13));
		expect(otherPr).toMatchObject({ id, coverage: null });
		expect(builds).toBe(0);
		const [inView] = await scanner().list("octo", prs(12));
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
		const cold = await s.list("octo", prs(100, 101, 102, 103));
		expect(cold.every((r) => (r.coverage?.done ?? 0) > 0)).toBe(true);
		gits.mockClear();
		const warm = await s.list("octo", prs(100, 101, 102, 103), "acme/widget");
		expect(gits.mock.calls.length).toBe(1);
		expect(warm).toEqual(cold);
	});

	/** A scanner whose snapshots are `snap`, built without git. */
	const gitless = (build: () => Promise<Snapshot> = async () => snap) =>
		new StartedReviews({ build, buildInfo: BUILD_A });

	it("Home's view, then its repo's read on the same scanner: coverage with one git log", async () => {
		await startMany(100, 3);
		const s = gitless();
		const listed = await s.list("octo", new Set());
		expect(listed.map((r) => r.coverage)).toEqual([null, null, null]);
		gits.mockClear();
		const repo = await s.list("octo", prs(100, 101, 102), "acme/widget");
		expect(repo).toHaveLength(3);
		expect(repo.every((r) => (r.coverage?.done ?? 0) > 0)).toBe(true);
		// The for-each-ref, and one git log of the three progress tips.
		expect(gits.mock.calls.length).toBe(2);
		gits.mockClear();
		await s.list("octo", prs(100, 101, 102), "acme/widget");
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

	/** `k` started reviews written straight into the clone (PRs from `from`). */
	const seed = async (from: number, k: number) =>
		seedStartedReviews(await ensureClone("acme", "widget"), {
			owner: "acme",
			repo: "widget",
			slug: "octo",
			k,
			from,
			base: snap.base,
		});

	/** A cold scan of the Home repo view, its rows PRs 1..3 (CAR-324). */
	const repoView = async (s: StartedReviews) => {
		clearSnapshotCaches();
		gits.mockClear();
		builds = 0;
		const list = await s.list("octo", prs(1, 2, 3), "acme/widget");
		return { list, count: gits.mock.calls.length, built: builds };
	};

	it("a cold repo view counts coverage for its rows alone: as many builds and gits with 4x the started reviews (CAR-324)", async () => {
		await seed(1, 3);
		await seed(1000, 6);
		const small = await repoView(scanner());
		await seed(2000, 18);
		// Cold again: no coverage kept from the first count.
		rmSync(join(cacheDir(), "coverage"), { recursive: true, force: true });
		const large = await repoView(scanner());
		expect(small.list).toHaveLength(9);
		expect(large.list).toHaveLength(27);
		// Only the rows' three reviews have coverage, and only they are built.
		expect(large.list.filter((r) => r.coverage).map((r) => r.number)).toEqual(
			expect.arrayContaining([1, 2, 3]),
		);
		expect(large.list.filter((r) => r.coverage)).toHaveLength(3);
		expect(small.built).toBe(3);
		expect(large.built).toBe(3);
		expect(large.count).toBe(small.count);
	});

	it("a restart counts no coverage again while no tip moved; a moved tip is counted again (CAR-324)", async () => {
		await seed(1, 3);
		await seed(1000, 24);
		const first = await repoView(scanner());
		expect(first.built).toBe(3);
		// A second server (a restart): nothing in memory, the same refs.
		const again = await repoView(scanner());
		expect(again.built).toBe(0);
		expect(again.list).toEqual(first.list);
		// The for-each-ref, and the git log of the moved (all, cold) tips.
		expect(again.count).toBe(2);
		// A review marked elsewhere: its progress tip moved, it alone is counted.
		const [one] = first.list.filter((r) => r.number === 1);
		const store = new RefStore(await ensureClone("acme", "widget"));
		await store.appendEvent(
			`refs/crb/reviews/${one?.id}/reviewers/octo/progress`,
			"crb: one more",
			newEvent("cluster-state", "octo", {
				patchset: "x",
				cluster: "d".repeat(64),
				path: "seed/f1.txt",
				state: "reviewed",
			} as never),
			"octo",
		);
		const moved = await repoView(scanner());
		expect(moved.built).toBe(1);
	});

	/** The one coverage file the scans wrote, parsed, with a writer back. */
	const coverageFile = () => {
		const dir = join(cacheDir(), "coverage");
		const [name] = readdirSync(dir).filter((f) => f.endsWith(".json"));
		const path = join(dir, name as string);
		return {
			data: JSON.parse(readFileSync(path, "utf8")),
			write: (value: unknown) => writeFileSync(path, JSON.stringify(value)),
			raw: (text: string) => writeFileSync(path, text),
		};
	};

	it("a coverage file that can't be trusted is counted again, never believed (principle 2, CAR-324)", async () => {
		await startMany(1, 1);
		const truth = await repoView(scanner());
		const [review] = truth.list;
		const real = review?.coverage;
		expect(real?.done).toBeGreaterThan(0);
		const file = coverageFile();
		expect(file.data.version).toBe(buildKey(BUILD_A));
		const entry = file.data.reviews[review?.id as string];
		const tampered = (reviewsField: unknown, over: object = {}) => ({
			...file.data,
			...over,
			reviews: reviewsField,
		});
		const inflated = { ...entry.coverage, done: entry.coverage.total };
		const cases: [string, () => void][] = [
			["not JSON", () => file.raw("{not json")],
			[
				"another version",
				() =>
					file.write(
						tampered(
							{ [review?.id as string]: { ...entry, coverage: inflated } },
							{
								version: buildKey({ ...BUILD_A, commit: "b".repeat(40) }),
							},
						),
					),
			],
			[
				"another clone",
				() =>
					file.write(
						tampered(
							{ [review?.id as string]: { ...entry, coverage: inflated } },
							{ repo: "/elsewhere/acme/widget.git" },
						),
					),
			],
			[
				"done over total",
				() =>
					file.write(
						tampered({
							[review?.id as string]: {
								...entry,
								coverage: { ...entry.coverage, done: entry.coverage.total + 1 },
							},
						}),
					),
			],
			[
				"another reviewer",
				() =>
					file.write(
						tampered(
							{ [review?.id as string]: { ...entry, coverage: inflated } },
							{ slug: "someone-else" },
						),
					),
			],
			[
				"another meta tip",
				() =>
					file.write(
						tampered({
							[review?.id as string]: {
								...entry,
								metaTip: "e".repeat(40),
								coverage: inflated,
							},
						}),
					),
			],
			[
				"a tip that isn't an OID",
				() =>
					file.write(
						tampered({
							[review?.id as string]: {
								...entry,
								progressTip: ` ${entry.progressTip}`,
								coverage: inflated,
							},
						}),
					),
			],
			[
				"an unknown unit",
				() =>
					file.write(
						tampered({
							[review?.id as string]: {
								...entry,
								coverage: { ...inflated, unit: "hunks" },
							},
						}),
					),
			],
			[
				"another progress tip",
				() =>
					file.write(
						tampered({
							[review?.id as string]: {
								...entry,
								progressTip: "f".repeat(40),
								coverage: inflated,
							},
						}),
					),
			],
		];
		for (const [what, spoil] of cases) {
			spoil();
			const after = await repoView(scanner());
			expect(after.built, what).toBe(1);
			expect(after.list[0]?.coverage, what).toEqual(real);
		}
		// Rewritten by the recount: the next restart trusts it again.
		expect((await repoView(scanner())).built).toBe(0);
	});

	it("coverage counted by another build is never read: each build keeps its own file (CAR-324)", async () => {
		await startMany(1, 1);
		const a = await repoView(scanner());
		expect(a.built).toBe(1);
		// The next RC, or a branch instance on the same cache: counted again.
		const other = { version: "9.9.9-rc.2", commit: "b".repeat(40) };
		const b = await repoView(scanner(other));
		expect(b.built).toBe(1);
		expect(b.list).toEqual(a.list);
		// Neither overwrote the other's file.
		const files = readdirSync(join(cacheDir(), "coverage"));
		expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(2);
		expect((await repoView(scanner())).built).toBe(0);
		expect((await repoView(scanner(other))).built).toBe(0);
	});

	it("a build its commit doesn't name (dirty tree, no git) neither reads nor keeps coverage (CAR-324)", async () => {
		await startMany(1, 1);
		await repoView(scanner());
		for (const commit of [`${"a".repeat(40)}-dirty`, "unknown"]) {
			const dev = { ...BUILD_A, commit };
			const first = await repoView(scanner(dev));
			expect(first.built, commit).toBe(1);
			expect((await repoView(scanner(dev))).built, commit).toBe(1);
		}
		// Only the clean build's file.
		const files = readdirSync(join(cacheDir(), "coverage"));
		expect(files).toHaveLength(1);
	});

	it("coverage files and crashed temp files not written for two weeks are deleted on the first write (CAR-324)", async () => {
		await startMany(1, 1);
		const dir = join(cacheDir(), "coverage");
		mkdirSync(dir, { recursive: true });
		const old = Date.now() / 1000 - 15 * 24 * 60 * 60;
		const stale = join(dir, `${"0".repeat(64)}.json`);
		const crashed = join(dir, `${"1".repeat(64)}.json.x.tmp`);
		const recent = join(dir, `${"2".repeat(64)}.json`);
		for (const f of [stale, crashed, recent]) writeFileSync(f, "{}");
		utimesSync(stale, old, old);
		utimesSync(crashed, old, old);
		await repoView(scanner());
		const left = readdirSync(dir);
		expect(left).toContain(`${"2".repeat(64)}.json`);
		expect(left).not.toContain(`${"0".repeat(64)}.json`);
		expect(left).not.toContain(`${"1".repeat(64)}.json.x.tmp`);
		expect(left).toHaveLength(2);
	});

	it("scans side by side count each review once, at most four builds at a time (CAR-324)", async () => {
		await seed(1, 8);
		let running = 0;
		let most = 0;
		let started = 0;
		const gate: (() => void)[] = [];
		const s = gitless(async () => {
			started++;
			running++;
			most = Math.max(most, running);
			await new Promise<void>((go) => gate.push(go));
			running--;
			return snap;
		});
		const want = prs(1, 2, 3, 4, 5, 6, 7, 8);
		const one = s.list("octo", want, "acme/widget");
		const two = s.list("octo", want, "acme/widget");
		// Let the builds through as they come, one at a time.
		while (started < 8 || gate.length > 0) {
			const go = gate.shift();
			if (go) go();
			await new Promise((r) => setImmediate(r));
		}
		const [a, b] = await Promise.all([one, two]);
		expect(started).toBe(8);
		expect(most).toBeLessThanOrEqual(4);
		expect(a.filter((r) => r.coverage)).toHaveLength(8);
		expect(b).toEqual(a);
	});

	it("the MCP door counts coverage only for the reviews it asks, after a list without (CAR-324)", async () => {
		await seed(1, 2);
		await seed(1000, 12);
		const s = scanner();
		const listed = await s.list("octo", new Set());
		expect(listed.every((r) => r.coverage === null)).toBe(true);
		expect(builds).toBe(0);
		const picked = listed.filter((r) => r.number <= 2);
		gits.mockClear();
		const coverage = await s.coverage("octo", picked);
		expect([...coverage.keys()].sort()).toEqual(picked.map((r) => r.id).sort());
		expect([...coverage.values()].every((c) => c !== null)).toBe(true);
		expect(builds).toBe(2);
		// One git log of the two progress tips; the builds' own gits beside.
		const logs = gits.mock.calls.filter((c) => c[1]?.includes("log"));
		expect(logs).toHaveLength(1);
		// A restart: from disk, no build.
		const cold = scanner();
		await cold.list("octo", new Set());
		builds = 0;
		expect(await cold.coverage("octo", picked)).toEqual(coverage);
		expect(builds).toBe(0);
	});

	it("a reviewer who acted nowhere started nothing", async () => {
		expect(await new StartedReviews().list("nobody")).toEqual([]);
	});
});
