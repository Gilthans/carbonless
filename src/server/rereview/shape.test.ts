import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GIT_TEST_TIMEOUTS, testGitEnv } from "../../../test/git-fixture";
import {
	createRereviewHistory,
	type RereviewHistory,
} from "../../../test/rereview-fixture";
import { checkOid, detectShape, type Endpoints } from "./shape";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

type History = RereviewHistory;

const ep = (
	mergeBase: string,
	head: string,
	baseBranch = "main",
): Endpoints => ({
	mergeBase,
	head,
	baseBranch,
});

describe("detectShape", () => {
	let h: History;
	let tree: (rev: string) => string;
	beforeAll(() => {
		h = createRereviewHistory();
		tree = (rev) =>
			execFileSync("git", ["rev-parse", `${rev}^{tree}`], {
				cwd: h.path,
				encoding: "utf8",
				env: testGitEnv(),
			}).trim();
	});
	afterAll(() => h.cleanup());

	const ps = () => ep(h.b0, h.p2);

	it("S1: commits appended on the same base", async () => {
		expect(await detectShape(h.path, ps(), ep(h.b0, h.h3))).toEqual({
			code: "S1",
			commits: 1,
			identical: false,
			conflicts: [],
			virtualRebase: "ok",
			virtualHead: tree(h.p2),
		});
	});

	it("S3: the base merged into the PR, nothing else", async () => {
		const shape = await detectShape(h.path, ps(), ep(h.b1, h.merged));
		expect(shape).toMatchObject({
			code: "S3",
			commits: 1,
			identical: true,
			conflicts: [],
			virtualRebase: "ok",
		});
		// The virtual rebase is the PR as if rebased: the merge's own tree.
		expect(shape.virtualHead).toBe(tree(h.merged));
	});

	it("S4a: a trivial rebase", async () => {
		expect(await detectShape(h.path, ps(), ep(h.b1, h.rebased))).toMatchObject({
			code: "S4a",
			commits: 2,
			identical: true,
			conflicts: [],
			virtualRebase: "ok",
			virtualHead: tree(h.rebased),
		});
	});

	it("S4b: a rebase with a conflict the author resolved", async () => {
		expect(
			await detectShape(h.path, ps(), ep(h.b1c, h.resolved)),
		).toMatchObject({
			code: "S4b",
			commits: 2,
			identical: false,
			conflicts: ["a.txt"],
			virtualRebase: "conflict",
		});
	});

	it("S4c: a rebase plus an amend", async () => {
		expect(await detectShape(h.path, ps(), ep(h.b1, h.amended))).toMatchObject({
			code: "S4c",
			commits: 3,
			identical: false,
			conflicts: [],
			virtualRebase: "ok",
		});
	});

	it("S5: a squash on the same base, same content", async () => {
		expect(await detectShape(h.path, ps(), ep(h.b0, h.squashed))).toMatchObject(
			{
				code: "S5",
				commits: 1,
				identical: true,
				virtualRebase: "ok",
				virtualHead: tree(h.p2),
			},
		);
	});

	it("S6: the head moved back to an earlier commit", async () => {
		expect(await detectShape(h.path, ps(), ep(h.b0, h.p1))).toMatchObject({
			code: "S6",
			commits: 1,
			identical: false,
			virtualRebase: "ok",
		});
	});

	it("S7: retargeted to another base branch, whatever the history", async () => {
		expect(
			await detectShape(h.path, ps(), ep(h.b0, h.h3, "develop")),
		).toMatchObject({ code: "S7", commits: 1 });
		expect(
			await detectShape(h.path, ep(h.b0, h.p2, "develop"), ep(h.b1, h.rebased)),
		).toMatchObject({ code: "S7", identical: true });
	});

	it("the same snapshot twice is S1 with nothing new", async () => {
		expect(await detectShape(h.path, ps(), ps())).toMatchObject({
			code: "S1",
			commits: 0,
			identical: true,
		});
	});

	it("unrelated histories: the virtual rebase can't be built", async () => {
		expect(
			await detectShape(h.path, ps(), ep(h.orphan, h.orphanHead)),
		).toMatchObject({
			code: "S4c",
			identical: false,
			conflicts: [],
			virtualRebase: "unrelated",
			virtualHead: null,
		});
	});

	it("a shallow clone: the virtual rebase can't be built either", async () => {
		const dir = mkdtempSync(join(tmpdir(), "crb-shallow-"));
		try {
			execFileSync(
				"git",
				[
					"clone",
					"--quiet",
					"--depth",
					"1",
					"--no-single-branch",
					`file://${h.path}`,
					join(dir, "clone"),
				],
				{ env: testGitEnv(), stdio: "pipe" },
			);
			expect(
				await detectShape(join(dir, "clone"), ps(), ep(h.b1, h.rebased)),
			).toMatchObject({ virtualRebase: "shallow", virtualHead: null });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses anything but an object id before running git", async () => {
		for (const bad of ["main", "--output=/tmp/x", "", "HEAD", "abc"]) {
			await expect(
				detectShape(h.path, ep(bad, h.p2), ep(h.b0, h.h3)),
			).rejects.toThrow(/Not an object id/);
			await expect(detectShape(h.path, ps(), ep(h.b0, bad))).rejects.toThrow(
				/Not an object id/,
			);
		}
		expect(() => checkOid("--all")).toThrow(/Not an object id/);
		expect(checkOid(h.b0)).toBe(h.b0);
	});

	it("stops when the signal aborts", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			detectShape(h.path, ps(), ep(h.b0, h.h3), controller.signal),
		).rejects.toThrow(/stopped/);
	});
});
