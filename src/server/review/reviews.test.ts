import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { createDiffFixture } from "../../../test/diff-fixture.js";
import {
	createBareRepo,
	type GitFixture,
	testGitEnv,
} from "../../../test/git-fixture.js";
import type { Snapshot, StateChange } from "../../shared/types.js";
import { buildSnapshot } from "../diff/snapshot.js";
import { runGit } from "../git.js";
import { buildReviewView } from "./coverage.js";
import { newEvent } from "./events.js";
import { RefStore } from "./refStore.js";
import {
	InvalidChangeError,
	prKey,
	type ReviewPr,
	ReviewService,
	StaleSnapshotError,
	UnknownClusterError,
} from "./reviews.js";

const pr: ReviewPr = {
	owner: "Acme",
	repo: "Widgets",
	number: 42,
	url: "https://github.com/Acme/Widgets/pull/42",
	baseBranch: "main",
	headBranch: "feature",
	headRepo: "Acme/Widgets",
};

let fixture: GitFixture;
/** Same tree and parent as the PR head, different commit: a force-push. */
let rewrittenHead: string;
let repo: string;
let cleanup: () => void;
let store: RefStore;
let svc: ReviewService;
let snap: Snapshot;
let otherSnap: Snapshot;
let k1: string;
let k2: string;
let id: string;

const fixtureGit = (...args: string[]) =>
	execFileSync("git", args, {
		cwd: fixture.path,
		encoding: "utf8",
		env: testGitEnv(),
	}).trim();

beforeAll(() => {
	fixture = createDiffFixture();
	const head = fixture.shas[1] as string;
	rewrittenHead = fixtureGit(
		"commit-tree",
		`${head}^{tree}`,
		"-p",
		fixture.shas[0] as string,
		"-m",
		"head, rebased",
	);
	fixtureGit("branch", "rewritten", rewrittenHead);
});
afterAll(() => fixture.cleanup());

beforeEach(async () => {
	({ path: repo, cleanup } = createBareRepo());
	await runGit(repo, [
		"fetch",
		"--quiet",
		fixture.path,
		"main:refs/heads/main",
		"rewritten:refs/heads/rewritten",
	]);
	store = new RefStore(repo);
	svc = new ReviewService(store);
	snap = await buildSnapshot(
		repo,
		fixture.shas[0] as string,
		fixture.shas[1] as string,
	);
	otherSnap = await buildSnapshot(
		repo,
		fixture.shas[0] as string,
		rewrittenHead,
	);
	const keys = snap.files.flatMap((f) => f.clusters.map((c) => c.key));
	[k1, k2] = keys as [string, string];
	id = await svc.findOrCreateReview(pr, "dan");
});
afterEach(() => cleanup());

const progressRef = (slug = "dan") =>
	`refs/crb/reviews/${id}/reviewers/${slug}/progress`;

describe("findOrCreateReview", () => {
	it("creates meta and lookup refs for a new PR", async () => {
		expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
		const hash = createHash("sha256").update("acme/widgets#42").digest("hex");
		const blob = await runGit(repo, [
			"cat-file",
			"blob",
			`refs/crb/lookup/github-pr/${hash}`,
		]);
		expect(blob.trim()).toBe(id);
		const [created] = await store.readEvents(`refs/crb/reviews/${id}/meta`);
		expect(created).toMatchObject({
			type: "review-created",
			by: "human",
			actor: "dan",
			source: "github-pr",
			key: "acme/widgets#42",
			pr,
		});
	});

	it("finds the same review for the same PR, ignoring owner/repo case", async () => {
		const again = await svc.findOrCreateReview(
			{ ...pr, owner: "ACME", repo: "widgets" },
			"eve",
		);
		expect(again).toBe(id);
		expect(await store.readEvents(`refs/crb/reviews/${id}/meta`)).toHaveLength(
			1,
		);
		expect(await svc.findOrCreateReview({ ...pr, number: 43 }, "dan")).not.toBe(
			id,
		);
	});

	it("keeps a review as of a cutoff apart from the PR's own, under its own key", async () => {
		const cutoff = "2026-09-15T11:35:52Z";
		expect(await svc.findReview(pr, { asOf: cutoff })).toBeNull();
		const asOf = await svc.findOrCreateReview(pr, "dan", { asOf: cutoff });
		expect(asOf).not.toBe(id);
		expect(await svc.findOrCreateReview(pr, "dan", { asOf: cutoff })).toBe(
			asOf,
		);
		expect(await svc.findReview(pr, { asOf: cutoff })).toBe(asOf);
		expect(await svc.findReview(pr)).toBe(id);
		const key = `acme/widgets#42@${cutoff}`;
		const hash = createHash("sha256").update(key).digest("hex");
		const blob = await runGit(repo, [
			"cat-file",
			"blob",
			`refs/crb/lookup/github-pr/${hash}`,
		]);
		expect(blob.trim()).toBe(asOf);
		const [created] = await store.readEvents(`refs/crb/reviews/${asOf}/meta`);
		expect(created).toMatchObject({ key, details: { asOf: cutoff } });
		// Progress on one never shows on the other.
		await svc.recordStates(asOf, "dan", snap, [{ key: k1, state: "reviewed" }]);
		expect((await svc.getProgress(id, "dan")).patchset).toBeNull();
		expect((await svc.getProgress(asOf, "dan")).patchset).not.toBeNull();
	});

	it("keeps a review pinned on a head apart from the PR's own and as-of ones, under its own key", async () => {
		const head = "c".repeat(40);
		const cutoff = "2026-09-15T11:35:52Z";
		expect(await svc.findReview(pr, { head })).toBeNull();
		const pinned = await svc.findOrCreateReview(pr, "dan", { head });
		expect(pinned).not.toBe(id);
		expect(await svc.findOrCreateReview(pr, "dan", { head })).toBe(pinned);
		expect(await svc.findReview(pr, { head })).toBe(pinned);
		// The PR's own review is found unchanged; another head is another review.
		expect(await svc.findReview(pr)).toBe(id);
		expect(await svc.findReview(pr, { head: "d".repeat(40) })).toBeNull();
		expect(await svc.findReview(pr, { asOf: cutoff })).toBeNull();
		const key = `acme/widgets#42^${head}`;
		expect(prKey(pr, { head })).toBe(key);
		const hash = createHash("sha256").update(key).digest("hex");
		const blob = await runGit(repo, [
			"cat-file",
			"blob",
			`refs/crb/lookup/github-pr/${hash}`,
		]);
		expect(blob.trim()).toBe(pinned);
		const [created] = await store.readEvents(`refs/crb/reviews/${pinned}/meta`);
		expect(created).toMatchObject({ key, details: { head } });
		expect(created?.details).not.toHaveProperty("asOf");
		await svc.recordStates(pinned, "dan", snap, [
			{ key: k1, state: "reviewed" },
		]);
		expect((await svc.getProgress(id, "dan")).patchset).toBeNull();
		expect((await svc.getProgress(pinned, "dan")).patchset).not.toBeNull();
	});

	it("two concurrent openings of a new PR agree on one review", async () => {
		const other = { ...pr, number: 7 };
		const ids = await Promise.all(
			Array.from({ length: 4 }, () => svc.findOrCreateReview(other, "dan")),
		);
		expect(new Set(ids).size).toBe(1);
		const metas = await runGit(repo, [
			"for-each-ref",
			"--format=%(refname)",
			"refs/crb/reviews/*/meta",
		]);
		expect(metas.trim().split("\n")).toHaveLength(2);
	});

	it("rejects an invalid actor slug", async () => {
		await expect(
			svc.findOrCreateReview({ ...pr, number: 9 }, "Dan"),
		).rejects.toThrow(/slug/);
	});
});

describe("recordStates", () => {
	it("first state starts patch set 1 and pins its head", async () => {
		await svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]);
		expect(
			await runGit(repo, [
				"rev-parse",
				`refs/crb/reviews/${id}/reviewers/dan/patchsets/1`,
			]),
		).toBe(`${snap.head}\n`);
		const progress = await svc.getProgress(id, "dan");
		expect(progress.patchset).toEqual({
			number: 1,
			revision: snap.revision,
			mergeBase: snap.base,
			head: snap.head,
		});
		expect(progress.states.get(k1)).toEqual({ state: "reviewed" });
	});

	it("writes one commit per event with a readable summary", async () => {
		const file = snap.files.find((f) => f.clusters.some((c) => c.key === k1));
		await svc.recordStates(id, "dan", snap, [
			{ key: k1, state: "reviewed" },
			{ key: k2, state: "crossed-off", reason: "generated" },
		]);
		const log = await runGit(repo, ["log", "--format=%s", progressRef()]);
		expect(log.trim().split("\n")).toHaveLength(3);
		expect(log).toContain("crb: started PS1");
		expect(log).toContain(`crb: reviewed 1 cluster in ${file?.path}`);
		expect(log).toContain("crb: crossed off 1 cluster in");
	});

	it("returns the updated progress and appends to an existing patch set", async () => {
		await svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]);
		const progress = await svc.recordStates(id, "dan", snap, [
			{ key: k1, state: "unreviewed" },
			{ key: k2, state: "reviewed" },
		]);
		expect(progress.states.get(k1)?.state).toBe("unreviewed");
		expect(progress.states.get(k2)?.state).toBe("reviewed");
		const events = await store.readEvents(progressRef());
		expect(events.filter((e) => e.type === "patchset-started")).toHaveLength(1);
	});

	it("a reset after a backward clock step still wins over the earlier state", async () => {
		await svc.recordStates(id, "dan", snap, [{ key: k2, state: "reviewed" }]);
		// A "reviewed" stamped a minute ahead, as if the clock then stepped back.
		const future = newEvent(
			"cluster-state",
			"dan",
			{ patchset: snap.revision, cluster: k1, path: "x", state: "reviewed" },
			"human",
			Date.now() + 60_000,
		);
		await store.appendEvent(progressRef(), "crb: future", future, "dan");
		expect((await svc.getProgress(id, "dan")).states.get(k1)?.state).toBe(
			"reviewed",
		);
		const progress = await svc.recordStates(id, "dan", snap, [
			{ key: k1, state: "unreviewed" },
		]);
		expect(progress.states.get(k1)?.state).toBe("unreviewed");
		const events = await store.readEvents(progressRef());
		expect(events.at(-1)?.ts).toBeGreaterThan(future.ts);
	});

	it("several changes to one cluster in one batch resolve to the last", async () => {
		const ch: StateChange[] = [
			{ key: k1, state: "reviewed" },
			{ key: k1, state: "unreviewed" },
			{ key: k1, state: "crossed-off", reason: "generated" },
			{ key: k1, state: "reviewed" },
			{ key: k1, state: "unreviewed" },
		];
		const progress = await svc.recordStates(id, "dan", snap, ch);
		expect(progress.states.get(k1)?.state).toBe("unreviewed");
		const ts = (await store.readEvents(progressRef())).map((e) => e.ts);
		expect(ts).toEqual([...ts].sort((a, b) => a - b));
		expect(new Set(ts).size).toBe(ts.length);
	});

	it("rejects unknown cluster keys", async () => {
		await expect(
			svc.recordStates(id, "dan", snap, [
				{ key: k1, state: "reviewed" },
				{ key: "ghost", state: "reviewed" },
			]),
		).rejects.toBeInstanceOf(UnknownClusterError);
		expect(await store.tip(progressRef())).toBeNull();
	});

	it("rejects unknown states", async () => {
		await expect(
			svc.recordStates(id, "dan", snap, [{ key: k1, state: "done" as never }]),
		).rejects.toBeInstanceOf(InvalidChangeError);
		expect(await store.tip(progressRef())).toBeNull();
	});

	it("crosses off without a reason; a blank reason is not stored", async () => {
		const progress = await svc.recordStates(id, "dan", snap, [
			{ key: k1, state: "crossed-off" },
			{ key: k2, state: "crossed-off", reason: "  " },
		]);
		expect(progress.states.get(k1)).toEqual({ state: "crossed-off" });
		expect(progress.states.get(k2)).toEqual({ state: "crossed-off" });
		const view = buildReviewView(snap, progress);
		expect(view.progress.clusters.reviewed).toBe(0);
		expect(view.progress.clusters.crossedOff).toBe(2);
	});

	it("rejects writes against a different snapshot once a patch set exists", async () => {
		const ch = [{ key: k1, state: "reviewed" as const }];
		// Same content after a force-push, so the keys match; only the revision differs.
		expect(
			otherSnap.files.flatMap((f) => f.clusters.map((c) => c.key)),
		).toContain(k1);
		expect(otherSnap.revision).not.toBe(snap.revision);
		await svc.recordStates(id, "dan", snap, [{ key: k2, state: "reviewed" }]);
		await expect(
			svc.recordStates(id, "dan", otherSnap, ch),
		).rejects.toBeInstanceOf(StaleSnapshotError);
		expect((await svc.getProgress(id, "dan")).states.has(k1)).toBe(false);
	});

	it("two tabs starting patch set 1 at once on the same snapshot both keep their states", async () => {
		await Promise.all([
			svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]),
			svc.recordStates(id, "dan", snap, [{ key: k2, state: "reviewed" }]),
		]);
		const progress = await svc.getProgress(id, "dan");
		expect(progress.patchset?.number).toBe(1);
		expect(progress.states.get(k1)?.state).toBe("reviewed");
		expect(progress.states.get(k2)?.state).toBe("reviewed");
	});

	it("two tabs starting patch set 1 at once on different snapshots: one gets a stale error", async () => {
		const results = await Promise.allSettled([
			svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]),
			svc.recordStates(id, "dan", otherSnap, [{ key: k2, state: "reviewed" }]),
		]);
		const rejected = results.filter((r) => r.status === "rejected");
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
			StaleSnapshotError,
		);
		const progress = await svc.getProgress(id, "dan");
		const winner = results[0]?.status === "fulfilled" ? snap : otherSnap;
		expect(progress.patchset?.revision).toBe(winner.revision);
		expect(progress.states.size).toBe(1);
	});

	it("rejects invalid reviewer slugs and review ids", async () => {
		const ch = [{ key: k1, state: "reviewed" as const }];
		await expect(
			svc.recordStates(id, "dan/patchsets", snap, ch),
		).rejects.toThrow(/slug/);
		await expect(svc.recordStates("../x", "dan", snap, ch)).rejects.toThrow(
			/review id/,
		);
		await expect(svc.getProgress(id, "Dan")).rejects.toThrow(/slug/);
	});

	it("a reviewer's progress is their own", async () => {
		await svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]);
		const eve = buildReviewView(snap, await svc.getProgress(id, "eve"));
		expect(eve.progress.clusters.reviewed).toBe(0);
	});

	it("a progress ref with a bad line and an ai cluster-state only loses those", async () => {
		await svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]);
		const tip = (await store.tip(progressRef())) as string;
		let n = 0;
		const forged = (fields: Record<string, unknown>) =>
			JSON.stringify({
				v: 1,
				id: `01jb${"0".repeat(21)}${n++}`,
				type: "cluster-state",
				ts: Date.now() - 1000,
				by: "human",
				actor: "dan",
				patchset: snap.revision,
				path: "x",
				state: "reviewed",
				...fields,
			});
		const message = [
			"crb: forged",
			"",
			'{"v":1,"id":"not json',
			forged({ cluster: k2, by: "ai" }),
			forged({ cluster: k2, state: "crossed-off" }),
			forged({ cluster: k2, v: 2 }),
			forged({ cluster: k2, type: "cluster-state-v9" }),
			forged({ cluster: "ghost" }),
			"",
		].join("\n");
		const commit = (
			await runGit(
				repo,
				["commit-tree", await store.emptyTree(), "-p", tip, "-F", "-"],
				{
					input: message,
					env: {
						GIT_AUTHOR_NAME: "x",
						GIT_AUTHOR_EMAIL: "x@x",
						GIT_COMMITTER_NAME: "x",
						GIT_COMMITTER_EMAIL: "x@x",
					},
				},
			)
		).trim();
		await runGit(repo, ["update-ref", progressRef(), commit, tip]);
		const view = buildReviewView(snap, await svc.getProgress(id, "dan"));
		expect(view.progress.clusters.reviewed).toBe(1);
		// The human, reasonless cross-off is valid: it crosses k2 off, and
		// crossed off never counts as reviewed.
		expect(view.progress.clusters.crossedOff).toBe(1);
		// The reviewer can keep working on top of the foreign commit.
		await svc.recordStates(id, "dan", snap, [{ key: k2, state: "reviewed" }]);
		expect(
			buildReviewView(snap, await svc.getProgress(id, "dan")).progress.clusters
				.reviewed,
		).toBe(2);
	});

	it("the pinned head survives a force-push and gc", async () => {
		await svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]);
		await runGit(repo, [
			"fetch",
			"--quiet",
			fixture.path,
			"+rewritten:refs/heads/main",
		]);
		const holders = await runGit(repo, [
			"for-each-ref",
			"--contains",
			snap.head,
			"--format=%(refname)",
		]);
		expect(holders).toBe(`refs/crb/reviews/${id}/reviewers/dan/patchsets/1\n`);
		await runGit(repo, ["reflog", "expire", "--expire=now", "--all"]);
		await runGit(repo, ["gc", "--quiet", "--prune=now"]);
		await expect(runGit(repo, ["cat-file", "-e", snap.head])).resolves.toBe("");
		const after = await buildSnapshot(repo, snap.base, snap.head);
		expect(after).toEqual(snap);
	});
});
