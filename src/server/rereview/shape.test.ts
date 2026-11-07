import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	testGitEnv,
} from "../../../test/git-fixture";
import { checkOid, detectShape, type Endpoints } from "./shape";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const LINES = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
const aTxt = (changes: Record<number, string>) =>
	`${LINES.map((l, i) => changes[i + 1] ?? l).join("\n")}\n`;

/**
 * One PR history with every shape the engine tells apart: the PR (two
 * commits on b0) and the base moving on (b1), with and without touching a
 * line the PR changed (b1c), and each way the author may have updated.
 */
function history() {
	const fx = createGitFixture([
		{ message: "base", files: { "a.txt": aTxt({}) } },
	]);
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: fx.path,
			encoding: "utf8",
			stdio: "pipe",
			env: testGitEnv(),
		}).trim();
	const commit = (message: string, files: Record<string, string>) => {
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(fx.path, name), content);
		}
		git("add", "--all");
		git("commit", "--quiet", "-m", message);
		return git("rev-parse", "HEAD");
	};
	const checkout = (sha: string) => git("checkout", "--quiet", "--detach", sha);
	const b0 = fx.shas[0] as string;
	const p1 = commit("PR: line 2", { "a.txt": aTxt({ 2: "two" }) });
	const p2 = commit("PR: line 30", {
		"a.txt": aTxt({ 2: "two", 30: "thirty" }),
	});
	const h3 = commit("PR: line 35", {
		"a.txt": aTxt({ 2: "two", 30: "thirty", 35: "thirty-five" }),
	});
	checkout(b0);
	const b1 = commit("base: line 15", { "a.txt": aTxt({ 15: "fifteen" }) });
	checkout(b0);
	const b1c = commit("base: line 30", { "a.txt": aTxt({ 30: "thirty-base" }) });
	// S3: the base merged into the PR.
	checkout(p2);
	git("merge", "--quiet", "--no-ff", "-m", "Merge base", b1);
	const merged = git("rev-parse", "HEAD");
	// S4a: a trivial rebase onto b1.
	checkout(b1);
	git("cherry-pick", "--quiet", p1, p2);
	const rebased = git("rev-parse", "HEAD");
	// S4c: a rebase plus an amend.
	git("commit", "--quiet", "--amend", "--no-edit", "--allow-empty");
	const amended = commit("PR: line 30, amended", {
		"a.txt": aTxt({ 2: "two", 15: "fifteen", 30: "thirty!" }),
	});
	// S4b: a rebase onto a base that changed line 30 too, resolved by hand.
	checkout(b1c);
	git("cherry-pick", "--quiet", p1);
	const resolved = commit("PR: line 30 (resolved)", {
		"a.txt": aTxt({ 2: "two", 30: "thirty resolved" }),
	});
	// S5: the two PR commits squashed into one, same content.
	checkout(b0);
	git("merge", "--quiet", "--squash", p2);
	git("commit", "--quiet", "-m", "PR (squashed)");
	const squashed = git("rev-parse", "HEAD");
	// Unrelated: another root.
	git("checkout", "--quiet", "--orphan", "other");
	git("rm", "-rfq", ".");
	const orphan = commit("orphan", { "z.txt": "z\n" });
	const orphanHead = commit("orphan: more", { "z.txt": "zz\n" });
	git("checkout", "--quiet", "main");
	// Branches for the shallow clone to fetch.
	git("branch", "-f", "pr", p2);
	git("branch", "-f", "rebased", rebased);
	git("branch", "-f", "moved", b1);
	return {
		path: fx.path,
		cleanup: fx.cleanup,
		b0,
		p1,
		p2,
		h3,
		b1,
		b1c,
		merged,
		rebased,
		amended,
		resolved,
		squashed,
		orphan,
		orphanHead,
	};
}

type History = ReturnType<typeof history>;

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
		h = history();
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
