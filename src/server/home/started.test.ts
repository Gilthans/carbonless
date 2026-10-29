import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testGitEnv } from "../../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../../test/pr-fixture";
import type { Snapshot } from "../../shared/types.js";
import { ensureClone, ensureRepoInit, fetchPr } from "../clone.js";
import { buildSnapshot } from "../diff/snapshot.js";
import { RefStore } from "../review/refStore.js";
import { ReviewService } from "../review/reviews.js";
import { StartedReviews } from "./started.js";

// Each fake gh call is a node process: give a loaded machine time.
vi.setConfig({ testTimeout: 30_000 });

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
		expect(after?.coverage.done).toBeGreaterThan(0);
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

	it("a reviewer who acted nowhere started nothing", async () => {
		expect(await new StartedReviews().list("nobody")).toEqual([]);
	});
});
