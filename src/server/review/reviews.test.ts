import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createDiffFixture } from "../../../test/diff-fixture.js";
import {
	createBareRepo,
	GIT_TEST_TIMEOUTS,
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
	findReviewById,
	InvalidChangeError,
	listReviews,
	type PatchsetStart,
	prKey,
	ReadOnlyPatchsetError,
	type ReviewPr,
	ReviewService,
	StaleSnapshotError,
	UnknownClusterError,
} from "./reviews.js";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

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
/** Same tree again, on top of the rewritten head: a third distinct head. */
let thirdHead: string;
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
	thirdHead = fixtureGit(
		"commit-tree",
		`${head}^{tree}`,
		"-p",
		rewrittenHead,
		"-m",
		"head, rebased again",
	);
	fixtureGit("branch", "third", thirdHead);
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
		"third:refs/heads/third",
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
		expect(progress.patchset).toMatchObject({
			number: 1,
			revision: snap.revision,
			mergeBase: snap.base,
			head: snap.head,
			since: null,
			shape: null,
		});
		expect(progress.patchsets).toEqual([progress.patchset]);
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
				{ key: "ghost2", state: "reviewed" },
			]),
		).rejects.toMatchObject({
			constructor: UnknownClusterError,
			keys: ["ghost", "ghost2"],
		});
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

describe("listReviews and findReviewById", () => {
	const ASOF = "2026-01-03T10:00:00.000Z";
	const HEAD = "a".repeat(40);

	it("lists every review of a repo with its PR and view", async () => {
		const asOf = await svc.findOrCreateReview(pr, "dan", { asOf: ASOF });
		const pinned = await svc.findOrCreateReview(pr, "dan", { head: HEAD });
		const other = await svc.findOrCreateReview({ ...pr, number: 43 }, "eve");
		const listed = await listReviews(repo);
		const byId = new Map(listed.map((r) => [r.id, r]));
		expect(listed).toHaveLength(4);
		expect(byId.get(id)).toEqual({ id, key: "acme/widgets#42", pr });
		expect(byId.get(asOf)).toEqual({
			id: asOf,
			key: `acme/widgets#42@${ASOF}`,
			pr,
			asOf: ASOF,
		});
		expect(byId.get(pinned)).toEqual({
			id: pinned,
			key: `acme/widgets#42^${HEAD}`,
			pr,
			head: HEAD,
		});
		expect(byId.get(other)?.pr.number).toBe(43);
	});

	it("skips a review whose meta ref holds no review-created event", async () => {
		const junk = await store.commit(null, "junk", [], "dan");
		await store.transaction([
			{
				ref: "refs/crb/reviews/01jjjjjjjjjjjjjjjjjjjjjjjj/meta",
				newOid: junk,
				oldOid: null,
			},
		]);
		expect((await listReviews(repo)).map((r) => r.id)).toEqual([id]);
	});

	it("an empty repo has none", async () => {
		const empty = createBareRepo();
		try {
			expect(await listReviews(empty.path)).toEqual([]);
		} finally {
			empty.cleanup();
		}
	});

	it("finds a review by id among the cache's clones", async () => {
		const cache = mkdtempSync(join(tmpdir(), "crb-cache-"));
		try {
			const clone = join(cache, "repos", "acme", "widgets.git");
			const noise = join(cache, "repos", "acme", "other.git");
			mkdirSync(join(cache, "repos", "acme"), { recursive: true });
			execFileSync("git", ["clone", "--quiet", "--bare", repo, clone], {
				env: testGitEnv(),
			});
			execFileSync("git", ["init", "--quiet", "--bare", noise], {
				env: testGitEnv(),
			});
			await runGit(clone, ["fetch", "--quiet", repo, "refs/crb/*:refs/crb/*"]);
			expect(await findReviewById(cache, id)).toEqual({
				repoDir: clone,
				review: { id, key: "acme/widgets#42", pr },
			});
			expect(
				await findReviewById(cache, "01zzzzzzzzzzzzzzzzzzzzzzzz"),
			).toBeNull();
			expect(await findReviewById(cache, "../../etc")).toBeNull();
			expect(await findReviewById(join(cache, "nope"), id)).toBeNull();
		} finally {
			rmSync(cache, { recursive: true, force: true });
		}
	});
});

describe("patch set n+1", () => {
	const start = (over: Partial<PatchsetStart> = {}): PatchsetStart => ({
		since: 1,
		shape: "S4a",
		baseBranch: "main",
		interdiff: "available",
		carried: [],
		...over,
	});
	const pinRef = (n: number, base = false) =>
		`refs/crb/reviews/${id}/reviewers/dan/patchsets/${n}${base ? "-base" : ""}`;
	const tipOf = (ref: string) =>
		runGit(repo, ["rev-parse", "--verify", ref]).then((o) => o.trim());

	it("the first mark on a second snapshot starts PS2 with since 1 and both pin refs", async () => {
		await svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]);
		const progress = await svc.recordStates(
			id,
			"dan",
			otherSnap,
			[{ key: k2, state: "reviewed" }],
			start(),
		);
		expect(progress.patchsets.map((p) => p.number)).toEqual([1, 2]);
		expect(progress.patchset).toMatchObject({
			number: 2,
			revision: otherSnap.revision,
			mergeBase: otherSnap.base,
			head: otherSnap.head,
			since: 1,
			shape: "S4a",
			baseBranch: "main",
			interdiff: "available",
		});
		expect(progress.states.get(k2)).toEqual({ state: "reviewed" });
		expect(progress.states.has(k1)).toBe(false);
		expect(progress.statesByRevision.get(snap.revision)?.get(k1)).toEqual({
			state: "reviewed",
		});
		expect(await tipOf(pinRef(2))).toBe(otherSnap.head);
		expect(await tipOf(pinRef(2, true))).toBe(otherSnap.base);
		// PS1 got its base pin too.
		expect(await tipOf(pinRef(1, true))).toBe(snap.base);
	});

	it("the pinned base survives gc after the base branch is rewritten", async () => {
		// A snapshot whose base is the rewritten branch's tip: the only thing
		// that keeps it alive once the branch is gone is the -base pin.
		const onRewritten = await buildSnapshot(
			repo,
			rewrittenHead,
			fixture.shas[1] as string,
		);
		await svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]);
		await svc.ensurePatchset(id, "dan", onRewritten, start());
		await runGit(repo, ["update-ref", "-d", "refs/heads/rewritten"]);
		await runGit(repo, ["reflog", "expire", "--expire=now", "--all"]);
		await runGit(repo, ["gc", "--quiet", "--prune=now"]);
		expect(await tipOf(pinRef(2, true))).toBe(rewrittenHead);
		await expect(runGit(repo, ["cat-file", "-e", rewrittenHead])).resolves.toBe(
			"",
		);
		const again = await buildSnapshot(
			repo,
			rewrittenHead,
			fixture.shas[1] as string,
		);
		expect(again).toEqual(onRewritten);
	});

	it("a mark against an old patch set is refused as read-only", async () => {
		await svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]);
		await svc.ensurePatchset(id, "dan", otherSnap, start());
		const write = svc.recordStates(id, "dan", snap, [
			{ key: k2, state: "reviewed" },
		]);
		await expect(write).rejects.toBeInstanceOf(ReadOnlyPatchsetError);
		await expect(write).rejects.toBeInstanceOf(StaleSnapshotError);
		// Even with a start: an old patch set never takes a write.
		await expect(
			svc.recordStates(
				id,
				"dan",
				snap,
				[{ key: k2, state: "reviewed" }],
				start(),
			),
		).rejects.toBeInstanceOf(ReadOnlyPatchsetError);
		const progress = await svc.getProgress(id, "dan");
		expect(progress.statesByRevision.get(snap.revision)?.has(k2)).toBe(false);
	});

	it("a mark against an unknown snapshot without a start is stale", async () => {
		await svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]);
		const write = svc.recordStates(id, "dan", otherSnap, [
			{ key: k2, state: "reviewed" },
		]);
		await expect(write).rejects.toBeInstanceOf(StaleSnapshotError);
		await expect(write).rejects.not.toBeInstanceOf(ReadOnlyPatchsetError);
		expect((await svc.getProgress(id, "dan")).patchsets).toHaveLength(1);
		expect(await store.tip(pinRef(2))).toBeNull();
	});

	it("ensurePatchset is idempotent", async () => {
		await svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]);
		const first = await svc.ensurePatchset(id, "dan", otherSnap, start());
		const second = await svc.ensurePatchset(
			id,
			"dan",
			otherSnap,
			start({ shape: "S1" }),
		);
		expect(second).toEqual(first);
		expect(second.patchsets.map((p) => p.number)).toEqual([1, 2]);
		const events = await store.readEvents(progressRef());
		expect(events.filter((e) => e.type === "patchset-started")).toHaveLength(2);
		// On the latest patch set it changes nothing either.
		expect(await svc.ensurePatchset(id, "dan", snap, start())).toEqual(first);
	});

	it("without a patch set, the first mark starts PS1 with no start given", async () => {
		const progress = await svc.recordStates(id, "dan", snap, [
			{ key: k1, state: "reviewed" },
		]);
		expect(progress.patchset).toMatchObject({ number: 1, since: null });
		expect(await tipOf(pinRef(1, true))).toBe(snap.base);
	});

	it("the carried events land in the start's commit and fold into PS2", async () => {
		await svc.recordStates(id, "dan", snap, [
			{ key: k1, state: "reviewed" },
			{ key: k2, state: "crossed-off", reason: "generated" },
		]);
		const progress = await svc.ensurePatchset(
			id,
			"dan",
			otherSnap,
			start({
				carried: [
					{
						type: "carried",
						from: 1,
						rule: "exact",
						states: [{ key: k1, fromKey: k1, state: "reviewed" }],
					},
					{
						type: "carried",
						from: 1,
						rule: "rename",
						states: [{ key: k2, fromKey: k2, state: "crossed-off" }],
					},
				],
			}),
		);
		expect(progress.states.get(k1)).toEqual({
			state: "reviewed",
			carried: { from: 1, rule: "exact" },
		});
		expect(progress.states.get(k2)).toEqual({
			state: "crossed-off",
			reason: "generated",
			carried: { from: 1, rule: "rename" },
		});
		const tip = (await store.tip(progressRef())) as string;
		const message = await runGit(repo, ["log", "-1", "--format=%B", tip]);
		const lines = message.trim().split("\n").slice(2);
		expect(lines.map((l) => JSON.parse(l).type)).toEqual([
			"patchset-started",
			"carried",
			"carried",
		]);
		expect(lines.map((l) => JSON.parse(l).by)).toEqual([
			"human",
			"auto",
			"auto",
		]);
		expect(JSON.parse(lines[1] as string).to).toBe(2);
		// A human mark on PS2 then wins over the carry.
		const after = await svc.recordStates(id, "dan", otherSnap, [
			{ key: k1, state: "unreviewed" },
		]);
		expect(after.states.get(k1)).toEqual({ state: "unreviewed" });
	});

	it("a carried entry whose source isn't a human state is written but never counts", async () => {
		await svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]);
		const progress = await svc.ensurePatchset(
			id,
			"dan",
			otherSnap,
			start({
				carried: [
					{
						type: "carried",
						from: 1,
						rule: "exact",
						states: [{ key: k2, fromKey: k2, state: "reviewed" }],
					},
				],
			}),
		);
		expect(progress.states.has(k2)).toBe(false);
		expect(
			buildReviewView(otherSnap, progress).progress.clusters.reviewed,
		).toBe(0);
	});

	it("recordPlacement appends a thread-placed by the reviewer", async () => {
		await svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]);
		const anchor = {
			path: "mod.ts",
			startSide: "RIGHT" as const,
			startLine: 2,
			side: "RIGHT" as const,
			line: 2,
		};
		const progress = await svc.recordPlacement(
			id,
			"dan",
			1,
			"PRRT_1",
			anchor,
			1,
		);
		expect(progress.placements.get(1)?.get("PRRT_1")).toMatchObject({
			type: "thread-placed",
			by: "human",
			actor: "dan",
			thread: "PRRT_1",
			patchset: 1,
			anchor,
			engine: 1,
		});
		const log = await runGit(repo, ["log", "--format=%s", "-1", progressRef()]);
		expect(log).toContain("placed thread");
		// Not for a patch set that doesn't exist.
		await expect(
			svc.recordPlacement(id, "dan", 2, "PRRT_1", anchor, 1),
		).rejects.toBeInstanceOf(StaleSnapshotError);
	});

	it("two tabs starting PS2 at once end with one PS2 and one set of pins", async () => {
		await svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]);
		const [a, b] = await Promise.all([
			svc.ensurePatchset(id, "dan", otherSnap, start()),
			svc.recordStates(
				id,
				"dan",
				otherSnap,
				[{ key: k2, state: "reviewed" }],
				start(),
			),
		]);
		expect(a.patchsets.map((p) => p.number)).toEqual([1, 2]);
		expect(b.patchsets.map((p) => p.number)).toEqual([1, 2]);
		expect(b.states.get(k2)).toEqual({ state: "reviewed" });
		const events = await store.readEvents(progressRef());
		expect(events.filter((e) => e.type === "patchset-started")).toHaveLength(2);
		expect(await tipOf(pinRef(2))).toBe(otherSnap.head);
		expect(await store.tip(pinRef(3))).toBeNull();
	});

	it("a start that loses the progress ref to a mark retries and lands", async () => {
		await svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]);
		const [progress] = await Promise.all([
			svc.ensurePatchset(id, "dan", otherSnap, start()),
			svc.recordStates(id, "dan", snap, [{ key: k2, state: "reviewed" }]),
		]);
		expect(progress.patchsets.map((p) => p.number)).toEqual([1, 2]);
		const final = await svc.getProgress(id, "dan");
		expect(final.statesByRevision.get(snap.revision)?.get(k2)).toEqual({
			state: "reviewed",
		});
		expect(final.patchset?.number).toBe(2);
	});

	it("a start whose since isn't the latest patch set is stale, however it arrives", async () => {
		// PS1: k1 reviewed. PS2 carries it; the reviewer unticks it there.
		await svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]);
		const carryK1 = {
			type: "carried" as const,
			from: 1,
			rule: "exact" as const,
			states: [{ key: k1, fromKey: k1, state: "reviewed" as const }],
		};
		await svc.ensurePatchset(
			id,
			"dan",
			otherSnap,
			start({ carried: [carryK1] }),
		);
		await svc.recordStates(id, "dan", otherSnap, [
			{ key: k1, state: "unreviewed" },
		]);
		// A tab whose engine answer was computed while PS1 was the latest:
		// landing it would carry PS1's reviewed over PS2's untick.
		const third = await buildSnapshot(
			repo,
			fixture.shas[0] as string,
			thirdHead,
		);
		expect(third.revision).not.toBe(otherSnap.revision);
		const stale = svc.ensurePatchset(
			id,
			"dan",
			third,
			start({ since: 1, carried: [carryK1] }),
		);
		await expect(stale).rejects.toBeInstanceOf(StaleSnapshotError);
		await expect(stale).rejects.not.toBeInstanceOf(ReadOnlyPatchsetError);
		await expect(
			svc.recordStates(
				id,
				"dan",
				third,
				[
					{
						key: k1,
						state: "reviewed",
					},
				],
				start({ since: 1, carried: [carryK1] }),
			),
		).rejects.toBeInstanceOf(StaleSnapshotError);
		const progress = await svc.getProgress(id, "dan");
		expect(progress.patchsets.map((p) => p.number)).toEqual([1, 2]);
		expect(progress.states.get(k1)).toEqual({ state: "unreviewed" });
		expect(await store.tip(pinRef(3))).toBeNull();
		// With the right since it lands as PS3.
		const landed = await svc.ensurePatchset(
			id,
			"dan",
			third,
			start({ since: 2 }),
		);
		expect(landed.patchset).toMatchObject({ number: 3, since: 2 });
	});

	it("a start for PS1 that names a since is stale, not an invalid event", async () => {
		const stale = svc.recordStates(
			id,
			"dan",
			snap,
			[{ key: k1, state: "reviewed" }],
			start({ since: 1 }),
		);
		await expect(stale).rejects.toBeInstanceOf(StaleSnapshotError);
		await expect(
			svc.ensurePatchset(id, "dan", snap, start({ since: 1 })),
		).rejects.toBeInstanceOf(StaleSnapshotError);
		expect((await svc.getProgress(id, "dan")).patchsets).toEqual([]);
		// since: null is PS1's start.
		const first = await svc.ensurePatchset(
			id,
			"dan",
			snap,
			start({ since: null }),
		);
		expect(first.patchset).toMatchObject({ number: 1, since: null });
	});

	it("storage: a start carrying 200 clusters is one small commit", async () => {
		await svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]);
		const hex = (i: number) =>
			createHash("sha256").update(`cluster ${i}`).digest("hex");
		const states = Array.from({ length: 200 }, (_, i) => ({
			key: hex(i),
			fromKey: hex(1000 + i),
			state: i % 3 === 0 ? ("crossed-off" as const) : ("reviewed" as const),
		}));
		await svc.ensurePatchset(
			id,
			"dan",
			otherSnap,
			start({ carried: [{ type: "carried", from: 1, rule: "exact", states }] }),
		);
		const tip = (await store.tip(progressRef())) as string;
		const size = Number((await runGit(repo, ["cat-file", "-s", tip])).trim());
		const raw = await runGit(repo, ["cat-file", "commit", tip]);
		const packed = deflateSync(Buffer.from(raw, "utf8")).length;
		const events = await store.readEvents(progressRef());
		expect(events.filter((e) => e.type === "carried")).toHaveLength(1);
		// Measured for docs/review-data-storage.md ("Measurements"): each
		// entry is two 64-hex keys and a state, about 170 bytes; git stores
		// the object deflated. The plan's 16 KiB raw assumed 32-hex keys.
		console.log(
			`carried commit, 200 entries: ${size} bytes raw, ${packed} deflated`,
		);
		expect(size).toBeLessThan(40 * 1024);
		expect(packed).toBeLessThan(20 * 1024);
	});
});
