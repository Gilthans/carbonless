import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import { GhError } from "./errors";
import { StaleSnapshotError } from "./review/reviews";
import { Session } from "./session";

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

	it("refuses a PR already merged into its base", async () => {
		pr.merge();
		await expect(Session.open(pr.arg, process.cwd())).rejects.toThrow(
			"PR acme/widget#12 is already merged into main; nothing to review",
		);
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
		const view = await s.setStates(oldHead, [
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
		const oldHead = pr.head();
		const key = firstKey(s);
		pr.moveHead({ "later.txt": "later\n" });
		await s.refresh();
		await expect(
			s.setStates(oldHead, [{ key, state: "reviewed" }]),
		).rejects.toBeInstanceOf(StaleSnapshotError);
		expect(s.info().patchset).toBeNull();
	});

	it("serves hunks and context of a file", async () => {
		const s = await Session.open(pr.arg, process.cwd());
		const hunks = await s.fileHunks(0);
		expect(hunks.newLineCount).toBe(30);
		expect(hunks.hunks).toHaveLength(2);
		const lines = await s.context(0, 10, 12);
		expect(lines.map((l) => l.text)).toEqual(["line 10", "line 11", "line 12"]);
	});
});
