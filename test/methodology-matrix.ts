import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { clonePath } from "../src/server/clone";
import { buildSnapshot } from "../src/server/diff/snapshot";
import { computeRereview } from "../src/server/rereview/engine";
import { RefStore } from "../src/server/review/refStore";
import { ReviewService } from "../src/server/review/reviews";
import { Session } from "../src/server/session";
import type { Snapshot } from "../src/shared/types";
import {
	fakeGhEnv,
	reviewThread,
	threadComment,
	writeScenario,
} from "./fake-gh/scenario";
import { GIT_TEST_TIMEOUTS, testGitEnv } from "./git-fixture";
import {
	BEFORE_LANDING,
	BEFORE_REVIEW,
	BEFORE_UPDATE,
	createMethodologyRepo,
	forcePushed,
	headMoves,
	METHODOLOGIES,
	type MethodologyRepo,
	mergesBase,
	type Stage,
	TIMES,
	type Update,
} from "./methodology-fixture";
import { settleGh } from "./settle-gh";

/**
 * The git-methodology matrix (docs/git-methodology.md): however the PR branch
 * was kept current and however the PR landed, carbonless shows the PR's own
 * changes, refuses only what GitHub says is merged, and keeps a started
 * review pinned.
 *
 * One test file per way of keeping the branch current
 * (src/server/methodology-<update>.test.ts), so the matrix runs on several workers.
 */
const NUMBER = 12;
const ARG = `acme/widget#${NUMBER}`;

export function methodologyMatrix(update: Update) {
	// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
	vi.setConfig(GIT_TEST_TIMEOUTS);
	describe.each(METHODOLOGIES.filter((m) => m.update === update))(
		"$name",
		matrix,
	);
}

/**
 * What the engine must find moving from the opened head to the updated
 * one, every cluster of PS1 marked: the shape, the author's commits, the
 * conflicted files, and how many clusters carried, were reworked, are new
 * or gone (docs/git-methodology.md).
 */
const RE_REVIEW: Record<
	Update,
	{
		shape: string;
		commits: number;
		conflicts: string[];
		carried: number;
		reworked: number;
		fresh: number;
		gone: number;
		absorbed: number;
	}
> = {
	none: {
		shape: "S1",
		commits: 0,
		conflicts: [],
		carried: 3,
		reworked: 0,
		fresh: 0,
		gone: 0,
		absorbed: 0,
	},
	rebase: {
		shape: "S4a",
		commits: 2,
		conflicts: [],
		carried: 3,
		reworked: 0,
		fresh: 0,
		gone: 0,
		absorbed: 0,
	},
	"merge-base-in": {
		shape: "S3",
		commits: 1,
		conflicts: [],
		carried: 3,
		reworked: 0,
		fresh: 0,
		gone: 0,
		absorbed: 0,
	},
	"rebase-amend": {
		shape: "S4c",
		commits: 2,
		conflicts: [],
		carried: 2,
		reworked: 1,
		fresh: 0,
		gone: 0,
		absorbed: 0,
	},
	"merge-base-in-conflict": {
		shape: "S3",
		commits: 1,
		conflicts: ["a.txt"],
		carried: 1,
		reworked: 0,
		fresh: 2,
		gone: 0,
		absorbed: 0,
	},
	"stacked-squash": {
		shape: "S4a",
		commits: 2,
		conflicts: [],
		carried: 3,
		reworked: 0,
		fresh: 0,
		gone: 0,
		absorbed: 2,
	},
	"base-absorbs": {
		shape: "S3",
		commits: 0,
		conflicts: [],
		carried: 1,
		reworked: 0,
		fresh: 0,
		gone: 0,
		absorbed: 2,
	},
};

function matrix(m: (typeof METHODOLOGIES)[number]) {
	let repo: MethodologyRepo;
	/** The PR's intended change set at each stage: what every comparison must show. */
	let references: { opened: Snapshot; updated: Snapshot };
	let tmp: string;
	const saved: Record<string, string | undefined> = {};

	beforeAll(async () => {
		repo = createMethodologyRepo(m, NUMBER);
		const build = (r: { base: string; head: string }) =>
			buildSnapshot(repo.path, r.base, r.head);
		references = {
			opened: await build(repo.references.opened),
			updated: await build(repo.references.updated),
		};
	});
	afterAll(() => repo.cleanup());

	const stage = (s: Stage) => {
		repo.setStage(s);
		process.env.CRB_FAKE_GH = writeScenario(tmp, {
			repoPath: repo.path,
			user: { login: "Octo_Cat" },
			nameWithOwner: "acme/widget",
			prs: { [NUMBER]: repo.prEntry(s) },
		});
	};

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "crb-matrix-"));
		for (const k of [
			"PATH",
			"CRB_FAKE_GH_SERVER",
			"XDG_CACHE_HOME",
			"CRB_FAKE_GH",
		]) {
			saved[k] = process.env[k];
		}
		Object.assign(process.env, fakeGhEnv());
		process.env.XDG_CACHE_HOME = join(tmp, "cache");
		stage("opened");
	});
	afterEach(async () => {
		// Background reads stop before the fake gh and the cache go.
		await Session.closeAll();
		try {
			await settleGh(process.env.CRB_FAKE_GH);
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	/** The snapshot shows exactly the PR's own changes of that stage. */
	const expectPrOwnChanges = (
		s: Session,
		stage: "opened" | "updated" = "opened",
	) => {
		expect(s.snapshot().files.map((f) => f.path)).toEqual(
			repo.references[stage].paths,
		);
		expect(s.snapshot().files).toEqual(references[stage].files);
	};
	const open = (asOf?: string) =>
		Session.open(ARG, process.cwd(), () => {}, asOf ? { asOf } : {});

	it("shows only the PR's own changes while it is open, through its update", async () => {
		const s = await open();
		expect(s.info().snapshotHead).toBe(repo.heads.opened);
		expectPrOwnChanges(s);
		stage("updated");
		expect(await s.refresh()).toMatchObject({
			snapshotHead: repo.heads.updated,
			headMoved: false,
			patchset: null,
		});
		expectPrOwnChanges(s, "updated");
		const again = await open();
		expect(again.info().snapshotHead).toBe(repo.heads.updated);
		expectPrOwnChanges(again, "updated");
	});

	it(
		m.landing === "open"
			? "keeps showing a PR that is still open"
			: "refuses an unstarted review once GitHub says merged; an open session keeps its snapshot",
		async () => {
			stage("updated");
			const s = await open();
			stage("landed");
			expect(await s.refresh()).toMatchObject({
				snapshotHead: repo.heads.updated,
				currentHead: repo.heads.updated,
				headMoved: false,
				patchset: null,
			});
			expectPrOwnChanges(s, "updated");
			if (m.landing === "open") {
				expectPrOwnChanges(await open(), "updated");
			} else {
				await expect(open()).rejects.toThrow(
					`PR ${ARG} is already merged; nothing to review`,
				);
			}
		},
	);

	it("keeps a started review pinned through the update and the landing, and gc", async () => {
		const s = await open();
		const key = s.snapshot().files[0]?.clusters[0]?.key ?? "";
		await s.setStates(s.snapshot().revision, [{ key, state: "reviewed" }]);
		stage("updated");
		await s.refresh();
		stage("landed");
		await s.refresh();
		expect(s.info()).toMatchObject({
			snapshotHead: repo.heads.opened,
			patchset: 1,
		});
		const clone = clonePath("acme", "widget");
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", clone, ...args], { env: testGitEnv() });
		git("reflog", "expire", "--expire=now", "--all");
		git("gc", "--quiet", "--prune=now");
		const again = await open();
		expect(again.info()).toMatchObject({
			snapshotHead: repo.heads.opened,
			currentHead: repo.heads.updated,
			headMoved: headMoves(m.update),
			patchset: 1,
		});
		expectPrOwnChanges(again);
		expect((await again.review()).progress.clusters.reviewed).toBe(1);
	});

	it("pinned on the reviewed head (--head reviewed): that head's own changes against today's base, though a force-push dropped it, through the landing and gc", async () => {
		// The clone first sees the PR updated: a rebase's first head is
		// fetched by OID.
		stage("updated");
		// Against today's base: one that took in the PR's first commit leaves
		// the updated stage's change.
		const pinnedStage = m.update === "base-absorbs" ? "updated" : "opened";
		const pinned = () =>
			Session.open(ARG, process.cwd(), () => {}, {
				head: { kind: "reviewed" },
				viewer: "rev1",
			});
		const s = await pinned();
		expect(s.info()).toMatchObject({
			snapshotHead: repo.heads.opened,
			currentHead: repo.heads.updated,
			pinnedHead: repo.heads.opened,
			headMoved: headMoves(m.update),
		});
		expectPrOwnChanges(s, pinnedStage);
		const key = s.snapshot().files[0]?.clusters[0]?.key ?? "";
		await s.setStates(s.snapshot().revision, [{ key, state: "reviewed" }]);
		stage("landed");
		await s.refresh();
		expect(s.info()).toMatchObject({
			snapshotHead: repo.heads.opened,
			patchset: 1,
		});
		expectPrOwnChanges(s, pinnedStage);
		const clone = clonePath("acme", "widget");
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", clone, ...args], { env: testGitEnv() });
		git("reflog", "expire", "--expire=now", "--all");
		git("gc", "--quiet", "--prune=now");
		// Started, so it opens once landed too; the PR's own review never started.
		const again = await pinned();
		expect(again.info()).toMatchObject({
			snapshotHead: repo.heads.opened,
			patchset: 1,
		});
		expectPrOwnChanges(again, pinnedStage);
		expect((await again.review()).progress.clusters.reviewed).toBe(1);
		if (m.landing === "open") {
			expect((await open()).info().patchset).toBeNull();
		} else {
			await expect(open()).rejects.toThrow("already merged");
		}
	});

	it("builds thread code from the clone: the PR's own diff at each comment's commit, through the update and the landing", async () => {
		/** A RIGHT line comment on a.txt, on `commit`, made `at`. */
		const thread = (
			line: number,
			commit: string,
			at: string,
			diffHunk?: string,
		) =>
			reviewThread({ path: "a.txt", line, diffSide: "RIGHT" }, [
				threadComment({
					login: "rev1",
					text: `On ${line}`,
					commit,
					createdAt: at,
					diffHunk,
				}),
			]);
		const threads = [
			// On the first head, before the base moved, with the PR's own hunk.
			thread(
				30,
				repo.heads.opened,
				TIMES.review,
				"@@ -27,4 +27,4 @@\n line 27\n line 28\n line 29\n-line 30\n+line 30 changed",
			),
			// On the updated head, after the update: next to the base's line 15.
			thread(14, repo.heads.updated, "2026-01-04T12:00:00Z"),
		];
		const withThreads = (s: Stage) => {
			repo.setStage(s);
			const entry = repo.prEntry(s);
			process.env.CRB_FAKE_GH = writeScenario(tmp, {
				repoPath: repo.path,
				user: { login: "Octo_Cat" },
				nameWithOwner: "acme/widget",
				prs: {
					[NUMBER]: {
						...entry,
						graphql: { ...entry.graphql, reviewThreads: threads },
					},
				},
			});
		};
		const rows = async (s: Session) =>
			(await s.threads((await s.overview(0)).readId, "full")).threads.map(
				(t) => ({
					source: t.code?.source,
					snapshot: t.code?.snapshot,
					rows: t.code?.rows.map(
						(r) =>
							`${r.marked ? ">" : " "}${r.kind[0]} ${r.oldNo ?? "."}/${r.newNo ?? "."} ${r.text}`,
					),
				}),
			);
		// The updated head holds the base's line 15 only if it moved onto it.
		const base15 = headMoves(m.update) ? "line 15 base" : "line 15";
		// A stacked parent's line 10 is in the base too, past the window.
		const firstRows = [
			" c 27/27 line 27",
			" c 28/28 line 28",
			" c 29/29 line 29",
			" d 30/. line 30",
			">a ./30 line 30 changed",
			" c 31/31 line 31",
			" c 32/32 line 32",
			" c 33/33 line 33",
		].slice(1);
		const want = [
			// The commenter's view, whatever happened to the branch since: an
			// absorbing base gives the head another merge base than at the
			// comment's time, so the clone can't vouch for the old side and
			// GitHub's own hunk is shown.
			m.update === "base-absorbs"
				? {
						source: "github",
						snapshot: { same: true },
						rows: firstRows.slice(0, 4),
					}
				: { source: "clone", snapshot: { same: true }, rows: firstRows },
			{
				// The base's own change is context on both sides: never the PR's.
				source: "clone",
				// No hunk to check it against.
				snapshot: { same: false, reason: "no-host-diff" },
				rows: [
					" c 11/11 line 11",
					" c 12/12 line 12",
					" c 13/13 line 13",
					">c 14/14 line 14",
					` c 15/15 ${base15}`,
					" c 16/16 line 16",
					" c 17/17 line 17",
				],
			},
		];
		withThreads("updated");
		const s = await open();
		// Most recent activity first.
		expect((await rows(s)).reverse()).toEqual(want);
		withThreads("landed");
		await s.refresh();
		expect((await rows(s)).reverse()).toEqual(want);
	});

	it("orders the timeline by GitHub's facts: a rebase's commits by their new times, then its force-push; the merge, not the close", async () => {
		const shape = async (s: Session) =>
			(await s.timeline((await s.overview(0)).readId)).events.map((e) =>
				e.kind === "commits"
					? `commits:${e.actor.login}:${e.items.map((c) => c.oid.slice(0, 7)).join(",")}`
					: e.kind === "force-push"
						? `force-push:${e.before.slice(0, 7)}>${e.after.slice(0, 7)}`
						: `${e.kind}:${e.actor.login}`,
			);
		const short = (oid: string) => oid.slice(0, 7);
		const own = repo.prEntry("updated").graphql?.commits as {
			commit: { oid: string };
		}[];
		const ownOids = own.map((c) => short(c.commit.oid)).join(",");
		const updated = forcePushed(m.update)
			? [
					// The rebased commits replace the first ones, after the review.
					"review:rev1",
					`commits:dev:${ownOids}`,
					`force-push:${short(repo.heads.opened)}>${short(repo.heads.updated)}`,
				]
			: mergesBase(m.update)
				? [
						`commits:dev:${own
							.slice(0, 2)
							.map((c) => short(c.commit.oid))
							.join(",")}`,
						"review:rev1",
						`commits:dev:${short(repo.heads.updated)}`,
					]
				: [`commits:dev:${ownOids}`, "review:rev1"];
		stage("updated");
		const s = await open();
		expect(await shape(s)).toEqual(updated);
		stage("landed");
		await s.refresh();
		expect(await shape(s)).toEqual(
			m.landing === "open" ? updated : [...updated, "merged:maintainer"],
		);
	});

	it("as of before any review, the head is the last of the commits sharing a second", async () => {
		stage("opened");
		const beforeReview = await open(BEFORE_REVIEW);
		expect(beforeReview.info().snapshotHead).toBe(repo.heads.opened);
		expectPrOwnChanges(beforeReview);
	});

	it("as of before the update and before the landing shows those snapshots", async () => {
		stage("landed");
		const beforeUpdate = await open(BEFORE_UPDATE);
		expect(beforeUpdate.info().snapshotHead).toBe(repo.heads.opened);
		expectPrOwnChanges(beforeUpdate);
		const beforeLanding = await open(BEFORE_LANDING);
		expect(beforeLanding.info().snapshotHead).toBe(repo.heads.updated);
		expectPrOwnChanges(beforeLanding, "updated");
	});

	it("re-review from the opened head to the updated one: the shape, the interdiff and the carry; the first action on the viewed head starts PS2 with them", async () => {
		const want = RE_REVIEW[m.update];
		const s = await open();
		const ps1 = s.snapshot();
		await s.setStates(
			ps1.revision,
			ps1.files.flatMap((f) =>
				f.clusters.map((c) => ({ key: c.key, state: "reviewed" as const })),
			),
		);
		stage("updated");
		// The head check (no refresh) finds GitHub's three-dot merge base,
		// also when only the base moved (and took in some of the PR).
		const mergeBase = execFileSync(
			"git",
			["merge-base", "main", repo.heads.updated],
			{ cwd: repo.path, env: testGitEnv(), encoding: "utf8" },
		).trim();
		expect((await s.checkHead()).head).toEqual({
			oid: repo.heads.updated,
			mergeBase,
			baseBranch: "main",
			commits: want.commits,
		});
		const info = await s.refresh();
		expect(info).toMatchObject({
			snapshotHead: repo.heads.opened,
			patchset: 1,
			head: { oid: repo.heads.updated, commits: want.commits },
		});
		let answer = await s.rereview(1, { head: repo.heads.updated });
		while ("pending" in answer) {
			await new Promise((r) => setTimeout(r, 20));
			answer = await s.rereview(1, { head: repo.heads.updated });
		}
		expect(answer.shape).toMatchObject({
			code: want.shape,
			commits: want.commits,
			conflicts: want.conflicts,
		});
		expect(answer.interdiff).toBe("available");
		const clusters = answer.files.flatMap((f) => f.clusters);
		const count = (kind: string) =>
			clusters.filter((c) => c.kind === kind).length;
		expect({
			carried: count("carried"),
			reworked: count("reworked"),
			fresh: count("new"),
			gone: count("gone"),
		}).toEqual({
			carried: want.carried,
			reworked: want.reworked,
			fresh: want.fresh,
			gone: want.gone,
		});
		expect(answer.toRead).toEqual({
			files: new Set(
				answer.files
					.filter(
						(f) =>
							f.conflict ||
							f.clusters.some((c) => c.kind === "reworked" || c.kind === "new"),
					)
					.map((f) => f.path),
			).size,
			clusters: want.reworked + want.fresh,
		});
		// Absorbed clusters (a landed stacked parent's) are neither shown nor
		// counted: the engine's own result says so.
		const clone = clonePath("acme", "widget");
		const progress = await new ReviewService(new RefStore(clone)).getProgress(
			s.id,
			"octo-cat",
		);
		const head = info.head;
		if (!head) throw new Error("no head");
		const record = progress.patchsets[0];
		if (!record) throw new Error("no PS1");
		const direct = await computeRereview(
			clone,
			{
				...record,
				baseBranch: "main",
				snapshot: ps1,
				states: progress.statesByRevision.get(ps1.revision) ?? new Map(),
			},
			[],
			{
				...(await buildSnapshot(clone, head.mergeBase, head.oid)),
				baseBranch: "main",
			},
		);
		expect(direct.absorbed).toHaveLength(want.absorbed);
		expect(direct.answer.files).toEqual(answer.files);
		// Nothing written by asking or viewing.
		const view = await s.viewHead(repo.heads.updated);
		expect(s.info().patchsets).toHaveLength(1);
		if (m.update === "none") {
			// The head is PS1's own snapshot: it shows PS1.
			expect(view).toMatchObject({ patchset: 1, revision: ps1.revision });
			return;
		}
		expect(view.patchset).toBeNull();
		expect(view.progress.clusters.reviewed).toBe(want.carried);
		const first = view.files[0]?.clusters[0];
		if (!first) throw new Error("no cluster");
		await s.setStates(view.revision, [
			{ key: first.key, state: "crossed-off", reason: "matrix" },
		]);
		expect(s.info()).toMatchObject({
			patchset: 2,
			snapshotHead: repo.heads.updated,
			headMoved: false,
		});
		const again = await open();
		expect(again.info()).toMatchObject({
			patchset: 2,
			snapshotHead: repo.heads.updated,
		});
		expect(again.info().patchsets[1]).toMatchObject({
			number: 2,
			since: 1,
			shape: want.shape,
		});
		expectPrOwnChanges(again, "updated");
		const review = await again.review();
		const carriedKeys = new Set(
			clusters.filter((c) => c.kind === "carried").map((c) => c.key),
		);
		expect(review.progress.clusters).toEqual({
			total: references.updated.files.flatMap((f) => f.clusters).length,
			reviewed: carriedKeys.size - (carriedKeys.has(first.key) ? 1 : 0),
			crossedOff: 1,
		});
		expect((await again.reviewAt(1)).progress.clusters.reviewed).toBe(
			ps1.files.flatMap((f) => f.clusters).length,
		);
	});
}
