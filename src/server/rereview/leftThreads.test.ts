import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
	testGitEnv,
} from "../../../test/git-fixture";
import type { ThreadPlacement } from "../../shared/rereview/placement";
import type { CodeAnchor, Snapshot } from "../../shared/types";
import { buildSnapshot } from "../diff/snapshot";
import { ThreadCodeSource } from "../threadCode";
import { ThreadPlacer, type TraceableThread } from "./threads";

vi.setConfig(GIT_TEST_TIMEOUTS);

/*
 * CAR-8: a LEFT thread's old side. GitHub keeps no commit for it, so its
 * line number may count on another merge base than ours; GitHub's diff
 * hunk tells which, and with no hunk the base branch as it stood at the
 * comment's time does.
 */

const L = Array.from({ length: 20 }, (_, i) => `l ${i + 1}`);
const TOP = ["top 1", "top 2", "top 3"];
const text = (lines: string[]) => `${lines.join("\n")}\n`;
/** `lines` without line `n` (1-based). */
const without = (lines: string[], n: number) =>
	lines.filter((_, i) => i !== n - 1);

let repo: GitFixture;
const git = (args: string[], date = "2026-01-01T00:00:00Z") =>
	execFileSync("git", args, {
		cwd: repo.path,
		encoding: "utf8",
		env: testGitEnv({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
	}).trim();

/** A commit of `l.ts` as `lines` on `parents`, dated `date`. */
function commit(parents: string[], lines: string[], date: string): string {
	writeFileSync(join(repo.path, "l.ts"), text(lines));
	git(["add", "--all"]);
	const tree = git(["write-tree"]);
	return git(
		["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", "c"],
		date,
	);
}

let B0: string;
/** The base moved: three lines on top. */
let B1: string;
/** The PR on B0: line 10 deleted. */
let H0: string;
/** B1 merged into the PR: line 10 (now 13) deleted on top of B1. */
let Hm: string;
/** A PR whose first commit puts TOP on, then deletes line 10. */
let P: string;
let Hp: string;
/** The base absorbing P later (a merge of it). */
let Babs: string;

beforeAll(() => {
	repo = createGitFixture([
		{
			message: "base",
			files: { "l.ts": text(L) },
			date: "2026-01-01T00:00:00Z",
		},
	]);
	B0 = repo.shas[0] ?? "";
	B1 = commit([B0], [...TOP, ...L], "2026-01-02T00:00:00Z");
	H0 = commit([B0], without(L, 10), "2026-01-02T00:00:00Z");
	Hm = commit([H0, B1], [...TOP, ...without(L, 10)], "2026-01-03T00:00:00Z");
	P = commit([B0], [...TOP, ...L], "2026-01-02T00:00:00Z");
	Hp = commit([P], [...TOP, ...without(L, 10)], "2026-01-02T01:00:00Z");
	Babs = commit([B0, P], [...TOP, ...L], "2026-01-10T00:00:00Z");
});

afterAll(() => repo.cleanup());

/** GitHub's hunk of a LEFT comment on line 10 of B0's numbering. */
const HUNK_B0 = "@@ -8,3 +8,2 @@\n l 8\n l 9\n-l 10";

let ids = 0;
function leftThread(
	commit: string,
	line: number,
	hunk: string | undefined,
	at = "2026-01-05T00:00:00Z",
): TraceableThread {
	ids += 1;
	const anchor: CodeAnchor = {
		path: "l.ts",
		commit,
		side: "LEFT",
		line,
		startSide: "LEFT",
		startLine: line,
		at,
	};
	return {
		id: `T${ids}`,
		path: "l.ts",
		commit,
		createdAt: at,
		anchor,
		...(hunk === undefined ? {} : { hunk: async () => hunk }),
	};
}

async function place(
	target: Snapshot,
	ref: string,
	t: TraceableThread,
): Promise<ThreadPlacement | undefined> {
	git(["update-ref", "refs/heads/main", ref]);
	const placer = new ThreadPlacer(
		repo.path,
		new ThreadCodeSource(repo.path, async () => true),
	);
	const base = { snapshot: target.base, ref: "refs/heads/main" };
	const inputs = await placer.inputs(target, [t], base);
	const [placed] = await placer.placeMoved(
		target,
		inputs,
		() => undefined,
		base,
	);
	return placed?.placement;
}

const leftAt = (line: number) => ({
	kind: "placed",
	anchor: {
		path: "l.ts",
		side: "LEFT",
		line,
		startSide: "LEFT",
		startLine: line,
	},
});

describe("LEFT threads' old side (CAR-8)", () => {
	it("a hunk numbered on an older base: the line found by the hunk's text, 3 lines down, never the line number's", async () => {
		// The comment is on Hm (B1 merged in), but its line counts on B0:
		// B1's line 10 is "l 7", the commented "l 10" is B1's 13.
		const target = await buildSnapshot(repo.path, B1, Hm);
		const got = await place(target, B1, leftThread(Hm, 10, HUNK_B0));
		expect(got).toMatchObject(leftAt(13));
	});

	it("a hunk that matches no old side is never placed on its line number: unplaced, base unknown", async () => {
		const target = await buildSnapshot(repo.path, B1, Hm);
		const hunk = "@@ -8,3 +8,2 @@\n zz 8\n zz 9\n-zz 10";
		const got = await place(target, B1, leftThread(Hm, 10, hunk));
		expect(got).toMatchObject({
			kind: "unplaced",
			fate: "base-unknown",
			path: "l.ts",
		});
	});

	it("a hunk matching as numbered is placed as today", async () => {
		const target = await buildSnapshot(repo.path, B0, H0);
		const got = await place(target, B0, leftThread(H0, 10, HUNK_B0));
		expect(got).toMatchObject(leftAt(10));
	});

	it("an empty hunk with the base unchanged since the comment: placed as today", async () => {
		const target = await buildSnapshot(repo.path, B0, H0);
		const got = await place(target, B0, leftThread(H0, 10, ""));
		expect(got).toMatchObject(leftAt(10));
	});

	it("an empty hunk after the base absorbed the PR's first commit: traced from the base as it stood then, not today's merge base", async () => {
		// At the comment (01-05) main was B0: LEFT 10 is "l 10". Main has
		// since merged P (01-10), so merge-base(Hp, main) is P, whose line
		// 10 is "l 7"; "l 10" is P's (and Babs's) 13.
		const target = await buildSnapshot(repo.path, P, Hp);
		expect(target.base).toBe(P);
		const got = await place(target, Babs, leftThread(Hp, 10, ""));
		expect(got).toMatchObject(leftAt(13));
	});

	it("a hunk on the base then agrees with the trace from it", async () => {
		const target = await buildSnapshot(repo.path, P, Hp);
		const got = await place(target, Babs, leftThread(Hp, 10, HUNK_B0));
		expect(got).toMatchObject(leftAt(13));
	});

	it("a thread with no hunk getter (an agent's, a move's) is traced as before", async () => {
		const target = await buildSnapshot(repo.path, B1, Hm);
		const got = await place(target, B1, leftThread(Hm, 10, undefined));
		// Its own number, on the merge base: B1's line 10 ("l 7", context).
		expect(got).toMatchObject({ kind: "placed", anchor: { line: 10 } });
	});
});
