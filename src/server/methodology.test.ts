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
} from "vitest";
import { FAKE_GH_DIR, writeScenario } from "../../test/fake-gh/scenario";
import { testGitEnv } from "../../test/git-fixture";
import {
	BEFORE_LANDING,
	BEFORE_REVIEW,
	BEFORE_UPDATE,
	createMethodologyRepo,
	METHODOLOGIES,
	type MethodologyRepo,
	type Stage,
} from "../../test/methodology-fixture";
import type { Snapshot } from "../shared/types";
import { clonePath } from "./clone";
import { buildSnapshot } from "./diff/snapshot";
import { Session } from "./session";

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
	afterEach(() => {
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
