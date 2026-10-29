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
import {
	FAKE_GH_DIR,
	reviewThread,
	threadComment,
	writeScenario,
} from "../../test/fake-gh/scenario";
import { GIT_TEST_TIMEOUTS, testGitEnv } from "../../test/git-fixture";
import {
	BEFORE_LANDING,
	BEFORE_REVIEW,
	BEFORE_UPDATE,
	createMethodologyRepo,
	METHODOLOGIES,
	type MethodologyRepo,
	type Stage,
	TIMES,
} from "../../test/methodology-fixture";
import type { Snapshot } from "../shared/types";
import { clonePath } from "./clone";
import { buildSnapshot } from "./diff/snapshot";
import { Session } from "./session";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

/**
 * The git-methodology matrix (docs/git-methodology.md): however the PR branch
 * was kept current and however the PR landed, carbonless shows the PR's own
 * changes, refuses only what GitHub says is merged, and keeps a started
 * review pinned.
 */
const NUMBER = 12;
const ARG = `acme/widget#${NUMBER}`;

describe.each(METHODOLOGIES)("$name", (m) => {
	let repo: MethodologyRepo;
	/** The PR's intended change set: what every comparison must show. */
	let reference: Snapshot;
	let tmp: string;
	const saved: Record<string, string | undefined> = {};

	beforeAll(async () => {
		repo = createMethodologyRepo(m, NUMBER);
		reference = await buildSnapshot(
			repo.path,
			repo.reference.base,
			repo.reference.head,
		);
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
		for (const k of ["PATH", "XDG_CACHE_HOME", "CRB_FAKE_GH"]) {
			saved[k] = process.env[k];
		}
		process.env.PATH = `${FAKE_GH_DIR}:${process.env.PATH ?? ""}`;
		process.env.XDG_CACHE_HOME = join(tmp, "cache");
		stage("opened");
	});
	afterEach(async () => {
		// Background reads stop before the fake gh and the cache go.
		await Session.closeAll();
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(tmp, { recursive: true, force: true });
	});

	/** The snapshot shows exactly the PR's own changes. */
	const expectPrOwnChanges = (s: Session) => {
		expect(s.snapshot().files.map((f) => f.path)).toEqual(repo.prPaths);
		expect(s.snapshot().files).toEqual(reference.files);
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
		expectPrOwnChanges(s);
		const again = await open();
		expect(again.info().snapshotHead).toBe(repo.heads.updated);
		expectPrOwnChanges(again);
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
			expectPrOwnChanges(s);
			if (m.landing === "open") {
				expectPrOwnChanges(await open());
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
			headMoved: m.update !== "none",
			patchset: 1,
		});
		expectPrOwnChanges(again);
		expect((await again.review()).progress.clusters.reviewed).toBe(1);
	});

	it("pinned on the reviewed head (--head reviewed): that head's own changes against today's base, though a force-push dropped it, through the landing and gc", async () => {
		// The clone first sees the PR updated: a rebase's first head is
		// fetched by OID.
		stage("updated");
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
			headMoved: m.update !== "none",
		});
		expectPrOwnChanges(s);
		const key = s.snapshot().files[0]?.clusters[0]?.key ?? "";
		await s.setStates(s.snapshot().revision, [{ key, state: "reviewed" }]);
		stage("landed");
		await s.refresh();
		expect(s.info()).toMatchObject({
			snapshotHead: repo.heads.opened,
			patchset: 1,
		});
		expectPrOwnChanges(s);
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
		expectPrOwnChanges(again);
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
		const base15 = m.update === "none" ? "line 15" : "line 15 base";
		const want = [
			{
				source: "clone",
				// The commenter's view, whatever happened to the branch since.
				snapshot: { same: true },
				rows: [
					" c 27/27 line 27",
					" c 28/28 line 28",
					" c 29/29 line 29",
					" d 30/. line 30",
					">a ./30 line 30 changed",
					" c 31/31 line 31",
					" c 32/32 line 32",
					" c 33/33 line 33",
				].slice(1),
			},
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
		const updated =
			m.update === "rebase"
				? [
						// The rebased commits replace the first ones, after the review.
						"review:rev1",
						`commits:dev:${ownOids}`,
						`force-push:${short(repo.heads.opened)}>${short(repo.heads.updated)}`,
					]
				: m.update === "merge-base-in"
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
		expectPrOwnChanges(beforeLanding);
	});
});
