import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bestCpuRatio, bestCpuRatioAsync, repeat } from "../../../test/cpu";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	testGitEnv,
} from "../../../test/git-fixture";
import {
	aTxt,
	createRereviewHistory,
	type RereviewHistory,
} from "../../../test/rereview-fixture";
import type { ClusterState, Snapshot } from "../../shared/types";
import { buildSnapshot } from "../diff/snapshot";
import type { PatchsetRecord, StateEntry } from "../review/fold";
import { RereviewCache } from "./cache";
import {
	answerRereview,
	computeRereview,
	type EarlierPatchset,
	interdiffBlobName,
	interdiffFileHunks,
	rereviewKey,
	type SincePatchset,
	type TargetSnapshot,
	traceRereview,
} from "./engine";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const record = (
	number: number,
	snapshot: Snapshot,
	since: number | null = null,
): PatchsetRecord => ({
	number,
	revision: snapshot.revision,
	mergeBase: snapshot.base,
	head: snapshot.head,
	startedAt: 0,
	since,
	shape: null,
	baseBranch: "main",
	interdiff: null,
});

/** Every cluster of the snapshot in `state` (a human mark). */
const marked = (
	snapshot: Snapshot,
	state: ClusterState = "reviewed",
	except: Record<string, ClusterState> = {},
): Map<string, StateEntry> =>
	new Map(
		snapshot.files.flatMap((f) =>
			f.clusters.map((c) => [c.key, { state: except[c.key] ?? state }]),
		),
	);

const since = (
	number: number,
	snapshot: Snapshot,
	states: Map<string, StateEntry>,
	sinceNumber: number | null = null,
): SincePatchset => ({
	...record(number, snapshot, sinceNumber),
	baseBranch: "main",
	snapshot,
	states,
});
const earlierOf = (
	number: number,
	snapshot: Snapshot,
	states: Map<string, StateEntry>,
): EarlierPatchset => ({ ...record(number, snapshot), snapshot, states });
const targetOf = (snapshot: Snapshot): TargetSnapshot => ({
	...snapshot,
	baseBranch: "main",
});

/** The key of the cluster of `path` whose new side starts at `newStart` (or the file's only one). */
function keyOf(snapshot: Snapshot, path: string, newStart?: number): string {
	const file = snapshot.files.find((f) => f.path === path);
	const c =
		newStart === undefined
			? file?.clusters[0]
			: file?.clusters.find((c) => c.newStart === newStart);
	if (!c) throw new Error(`no cluster ${path}:${newStart}`);
	return c.key;
}

/** `files` of an answer as `path: kind[,from] …`. */
const kinds = (answer: {
	files: {
		path: string;
		conflict: boolean;
		clusters: { kind: string; from?: number }[];
	}[];
}) =>
	Object.fromEntries(
		answer.files.map((f) => [
			f.conflict ? `${f.path} (conflict)` : f.path,
			f.clusters.map((c) =>
				c.from === undefined ? c.kind : `${c.kind}:${c.from}`,
			),
		]),
	);

describe("the engine", () => {
	let h: RereviewHistory;
	const snap = (base: string, head: string) =>
		buildSnapshot(h.path, base, head);
	beforeAll(() => {
		h = createRereviewHistory();
	});
	afterAll(() => h.cleanup());

	it("S1 appended: carried and new clusters, the counts and the start's carried event", async () => {
		const ps1 = await snap(h.b0, h.p2);
		const r = await snap(h.b0, h.h3);
		const { answer, start, interdiff } = await computeRereview(
			h.path,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		expect(kinds(answer)).toEqual({
			"a.txt": ["carried:1", "carried:1", "new"],
			"new.txt": ["carried:1"],
		});
		expect(answer).toMatchObject({
			from: 1,
			toHead: h.h3,
			toRevision: r.revision,
			shape: { code: "S1", commits: 1 },
			interdiff: "available",
			toRead: { files: 1, clusters: 1 },
			threads: [],
		});
		expect(answer.files.map((f) => f.index)).toEqual([0, 1]);
		expect(interdiff.status).toBe("available");
		expect(start).toEqual({
			since: 1,
			shape: "S1",
			baseBranch: "main",
			interdiff: "available",
			carried: [
				{
					type: "carried",
					from: 1,
					rule: "exact",
					states: [
						{
							key: keyOf(ps1, "a.txt", 2),
							fromKey: keyOf(ps1, "a.txt", 2),
							state: "reviewed",
						},
						{
							key: keyOf(ps1, "a.txt", 30),
							fromKey: keyOf(ps1, "a.txt", 30),
							state: "reviewed",
						},
						{
							key: keyOf(ps1, "new.txt"),
							fromKey: keyOf(ps1, "new.txt"),
							state: "reviewed",
						},
					],
				},
			],
		});
	});

	it("a reworked cluster is reworked and counts; a crossed-off one carries crossed off", async () => {
		const ps1 = await snap(h.b0, h.p2);
		const r = await snap(h.b0, h.reworked);
		const states = marked(ps1, "reviewed", {
			[keyOf(ps1, "new.txt")]: "crossed-off",
		});
		const { answer, start } = await computeRereview(
			h.path,
			since(1, ps1, states),
			[],
			targetOf(r),
		);
		expect(kinds(answer)).toEqual({
			"a.txt": ["carried:1", "reworked"],
			"new.txt": ["carried:1"],
		});
		expect(answer.toRead).toEqual({ files: 1, clusters: 1 });
		expect(start.carried[0]?.states.map((s) => s.state)).toEqual([
			"reviewed",
			"crossed-off",
		]);
	});

	it("a reverted file is gone: listed past the snapshot's files, its removal keyed to it", async () => {
		const ps1 = await snap(h.b0, h.p3);
		const r = await snap(h.b0, h.reverted);
		const traced = await traceRereview(
			h.path,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		const { answer } = answerRereview(
			traced,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		const extraKey = keyOf(ps1, "extra.txt");
		expect(answer.files).toEqual([
			{
				index: 0,
				path: "a.txt",
				conflict: false,
				clusters: [
					{
						key: keyOf(ps1, "a.txt", 2),
						kind: "carried",
						from: 1,
						state: "reviewed",
						rule: "exact",
					},
					{
						key: keyOf(ps1, "a.txt", 30),
						kind: "carried",
						from: 1,
						state: "reviewed",
						rule: "exact",
					},
				],
			},
			{
				index: 1,
				path: "new.txt",
				conflict: false,
				clusters: [
					{
						key: keyOf(ps1, "new.txt"),
						kind: "carried",
						from: 1,
						state: "reviewed",
						rule: "exact",
					},
				],
			},
			{
				index: 2,
				path: "extra.txt",
				conflict: false,
				clusters: [{ key: extraKey, kind: "gone", from: 1 }],
				// Its removal is a piece of its own, back to the base: to read.
				pieces: [
					{
						hunk: 0,
						line: 0,
						key: extraKey,
						owns: null,
						old: [[1, 2]],
						new: [],
						kind: "reverted",
					},
				],
			},
		]);
		expect(answer.toRead).toEqual({ files: 1, clusters: 1 });
		const hunks = interdiffFileHunks(traced, r, answer, 2);
		expect(hunks).toEqual({
			hunks: [
				{
					oldStart: 1,
					oldCount: 1,
					newStart: 0,
					newCount: 0,
					lines: [
						{
							kind: "del",
							oldNo: 1,
							text: "extra",
							clusterKey: extraKey,
							// Only PS1 had it: no line on the head (CAR-217).
							baseNo: null,
							// Its line on PS1's commit, where a comment on it goes (CAR-233).
							psNo: 1,
						},
					],
				},
			],
			newLineCount: 0,
			pieces: [
				{
					hunk: 0,
					line: 0,
					key: extraKey,
					owns: null,
					old: [[1, 2]],
					new: [],
					kind: "reverted",
				},
			],
		});
		// A file the interdiff doesn't touch has no hunks since.
		expect(interdiffFileHunks(traced, r, answer, 0)).toEqual({
			hunks: [],
			newLineCount: 0,
		});
		expect(() => interdiffFileHunks(traced, r, answer, 3)).toThrow(/No file 3/);
	});

	it("an unavailable interdiff: everything new, nothing carried, the start says so", async () => {
		const ps1 = await snap(h.b0, h.p2);
		const r = await snap(h.orphan, h.orphanHead);
		const { answer, start } = await computeRereview(
			h.path,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		expect(answer).toMatchObject({
			interdiff: "unavailable",
			reason: "unrelated",
			toRead: { files: 1, clusters: 1 },
		});
		expect(kinds(answer)).toEqual({ "z.txt": ["new"] });
		expect(start).toMatchObject({
			since: 1,
			shape: "S4c",
			interdiff: "unavailable",
			carried: [],
		});
	});

	it("a conflicted file is all new and flagged; its since hunks are keyed to its own clusters; a clean file carries or reworks", async () => {
		const ps1 = await snap(h.b0, h.p2);
		const r = await snap(h.b1c, h.resolvedPlus);
		const traced = await traceRereview(
			h.path,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		const { answer, start } = answerRereview(
			traced,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		expect(kinds(answer)).toEqual({
			"a.txt (conflict)": ["new", "new"],
			// new.txt gained a line: the reviewed one-line addition grew.
			"new.txt": ["reworked"],
		});
		expect(answer.shape).toMatchObject({ code: "S4b", conflicts: ["a.txt"] });
		expect(answer.toRead).toEqual({ files: 2, clusters: 3 });
		expect(start.carried).toEqual([]);
		const hunks = interdiffFileHunks(traced, r, answer, 0);
		const keyed = hunks.hunks.flatMap((hk) =>
			hk.lines
				.filter((l) => l.clusterKey)
				.map((l) => [l.kind, l.oldNo ?? null, l.newNo ?? null, l.clusterKey]),
		);
		expect(keyed).toEqual([
			["del", 2, null, keyOf(r, "a.txt", 2)],
			["add", null, 2, keyOf(r, "a.txt", 2)],
			["del", 30, null, keyOf(r, "a.txt", 30)],
			["add", null, 30, keyOf(r, "a.txt", 30)],
		]);
	});

	it("P8: reworked in PS2, back to PS1's content in PS3: carried from PS1, the rest from PS2", async () => {
		const ps1 = await snap(h.b0, h.p2);
		const ps2 = await snap(h.b0, h.reworked);
		const r = await snap(h.b0, h.reworkedBack);
		const { answer, start } = await computeRereview(
			h.path,
			since(2, ps2, marked(ps2), 1),
			[earlierOf(1, ps1, marked(ps1))],
			targetOf(r),
		);
		expect(kinds(answer)).toEqual({
			"a.txt": ["carried:2", "carried:1"],
			"new.txt": ["carried:2"],
		});
		expect(start.carried.map((e) => [e.from, e.rule, e.states.length])).toEqual(
			[
				[2, "exact", 2],
				[1, "exact", 1],
			],
		);
	});

	it("the answer applies the marks of the moment to the traced result", async () => {
		const ps1 = await snap(h.b0, h.p2);
		const r = await snap(h.b0, h.h3);
		const traced = await traceRereview(
			h.path,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		const first = answerRereview(
			traced,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		expect(first.start.carried[0]?.states).toHaveLength(3);
		const unticked = marked(ps1, "reviewed", {
			[keyOf(ps1, "a.txt", 2)]: "unreviewed",
		});
		const second = answerRereview(
			traced,
			since(1, ps1, unticked),
			[],
			targetOf(r),
		);
		expect(kinds(second.answer)).toEqual({
			"a.txt": ["new", "carried:1", "new"],
			"new.txt": ["carried:1"],
		});
		expect(second.start.carried[0]?.states).toHaveLength(2);
		// JSON-safe: what the cache holds.
		expect(JSON.parse(JSON.stringify(traced))).toEqual(traced);
	});

	it("since hunks number the old side in the virtual rebase and key lines to the target's clusters", async () => {
		const ps1 = await snap(h.b0, h.p2);
		const r = await snap(h.b1, h.amended);
		const traced = await traceRereview(
			h.path,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		const { answer } = answerRereview(
			traced,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		expect(answer.shape.code).toBe("S4c");
		expect(kinds(answer)).toEqual({
			"a.txt": ["carried:1", "reworked"],
			"new.txt": ["carried:1"],
		});
		const k30 = keyOf(r, "a.txt", 30);
		const hunks = interdiffFileHunks(traced, r, answer, 0);
		expect(hunks.newLineCount).toBe(40);
		expect(hunks.hunks).toEqual([
			{
				oldStart: 27,
				oldCount: 7,
				newStart: 27,
				newCount: 7,
				lines: [
					{ kind: "context", oldNo: 27, newNo: 27, text: "line 27" },
					{ kind: "context", oldNo: 28, newNo: 28, text: "line 28" },
					{ kind: "context", oldNo: 29, newNo: 29, text: "line 29" },
					{
						kind: "del",
						oldNo: 30,
						text: "thirty",
						clusterKey: k30,
						// PS1's own line, in neither base nor head (CAR-217).
						baseNo: null,
						// Its line on PS1's commit (CAR-233).
						psNo: 30,
					},
					{ kind: "add", newNo: 30, text: "thirty!", clusterKey: k30 },
					{ kind: "context", oldNo: 31, newNo: 31, text: "line 31" },
					{ kind: "context", oldNo: 32, newNo: 32, text: "line 32" },
					{ kind: "context", oldNo: 33, newNo: 33, text: "line 33" },
				],
			},
		]);
		expect(interdiffFileHunks(traced, r, answer, 1)).toEqual({
			hunks: [],
			newLineCount: 0,
		});
	});

	it("a removed line of the since view carries its base number, GitHub's LEFT line on the head; one only the earlier patch set had carries null (CAR-217)", async () => {
		const ps1 = await snap(h.b0, h.p2);
		const r = await snap(h.b0, h.deletesLine);
		const traced = await traceRereview(
			h.path,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		const { answer } = answerRereview(
			traced,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		const removed = interdiffFileHunks(traced, r, answer, 0).hunks.flatMap(
			(hk) => hk.lines.filter((l) => l.kind === "del"),
		);
		expect(removed).toEqual([
			expect.objectContaining({ oldNo: 20, text: "line 20", baseNo: 20 }),
		]);
		// No other line carries one: added and context lines are the head's.
		const others = interdiffFileHunks(traced, r, answer, 0).hunks.flatMap(
			(hk) => hk.lines.filter((l) => l.kind !== "del"),
		);
		expect(others.every((l) => !("baseNo" in l))).toBe(true);
	});

	it("rebased between patch sets, a since-view removed line carries its number in the new base: master inserted lines above it, or changed the line itself (CAR-217)", async () => {
		const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
		const text = (ls: string[]) => `${ls.join("\n")}\n`;
		const fx = createGitFixture([
			{ message: "base", files: { "a.txt": text(lines) } },
		]);
		try {
			const git = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: fx.path,
					encoding: "utf8",
					stdio: "pipe",
					env: testGitEnv(),
				}).trim();
			const commit = (message: string, content: string[]) => {
				writeFileSync(join(fx.path, "a.txt"), text(content));
				git("commit", "--quiet", "-am", message);
				return git("rev-parse", "HEAD");
			};
			const b1 = fx.shas[0] as string;
			// PS1 on B1: line 5 changed.
			const ps1Lines = lines.map((l) => (l === "line 5" ? "five" : l));
			const h1 = commit("PR: five", ps1Lines);
			// B2: master inserts three lines on top and changes line 30.
			git("checkout", "--quiet", "--detach", b1);
			const masterLines = [
				"master 1",
				"master 2",
				"master 3",
				...lines.map((l) => (l === "line 30" ? "thirty on master" : l)),
			];
			const b2 = commit("base: three on top, line 30", masterLines);
			// PS2, rebased on B2: PS1's change, then lines 20 and 30 dropped.
			const h2 = commit(
				"PR: five, rebased; lines 20 and 30 dropped",
				masterLines
					.map((l) => (l === "line 5" ? "five" : l))
					.filter((l) => l !== "line 20" && l !== "thirty on master"),
			);
			const ps1 = await buildSnapshot(fx.path, b1, h1);
			const r = await buildSnapshot(fx.path, b2, h2);
			const traced = await traceRereview(
				fx.path,
				since(1, ps1, marked(ps1)),
				[],
				targetOf(r),
			);
			const { answer } = answerRereview(
				traced,
				since(1, ps1, marked(ps1)),
				[],
				targetOf(r),
			);
			const removed = interdiffFileHunks(traced, r, answer, 0).hunks.flatMap(
				(hk) =>
					hk.lines
						.filter((l) => l.kind === "del")
						.map((l) => [l.text, l.baseNo]),
			);
			// B2's numbers (three lines down), never B1's: "line 20" is B2's 23.
			// "thirty on master" is B2's 33, though PS1 never had that text.
			expect(removed).toEqual([
				["line 20", 23],
				["thirty on master", 33],
			]);
		} finally {
			fx.cleanup();
		}
	});

	it("a renamed file the head's diff pairs with another base file than the since view's map does: no base numbers, so no comment lands in the wrong file (CAR-217)", async () => {
		const block = (name: string) =>
			`${Array.from({ length: 30 }, (_, i) => `${name} ${i + 1}`).join("\n")}\n`;
		const fx = createGitFixture([
			{
				message: "base",
				files: { "x.txt": block("ex"), "y.txt": block("why") },
			},
		]);
		try {
			const git = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: fx.path,
					encoding: "utf8",
					stdio: "pipe",
					env: testGitEnv(),
				}).trim();
			const b0 = fx.shas[0] as string;
			// PS1: x.txt renamed to z.txt (its base file is x.txt).
			git("mv", "x.txt", "z.txt");
			git("commit", "--quiet", "-m", "PR: x.txt as z.txt");
			const h1 = git("rev-parse", "HEAD");
			// PS2: z.txt now reads as y.txt, which goes: the head's diff
			// pairs z.txt with y.txt, and x.txt is deleted.
			writeFileSync(
				join(fx.path, "z.txt"),
				block("why").replace("why 30", "why thirty"),
			);
			git("rm", "--quiet", "y.txt");
			git("commit", "--quiet", "-am", "PR: z.txt from y.txt");
			const h2 = git("rev-parse", "HEAD");
			const ps1 = await buildSnapshot(fx.path, b0, h1);
			const r = await buildSnapshot(fx.path, b0, h2);
			const z = r.files.find((f) => f.path === "z.txt");
			expect(z?.oldPath).toBe("y.txt");
			const traced = await traceRereview(
				fx.path,
				since(1, ps1, marked(ps1)),
				[],
				targetOf(r),
			);
			const { answer } = answerRereview(
				traced,
				since(1, ps1, marked(ps1)),
				[],
				targetOf(r),
			);
			const removed = interdiffFileHunks(
				traced,
				r,
				answer,
				z?.index ?? -1,
			).hunks.flatMap((hk) => hk.lines.filter((l) => l.kind === "del"));
			// z.txt's removed lines are x.txt's ("ex …"): no number in y.txt.
			expect(removed.length).toBeGreaterThan(0);
			expect(removed.every((l) => l.text.startsWith("ex "))).toBe(true);
			expect(removed.every((l) => l.baseNo === undefined)).toBe(true);
		} finally {
			fx.cleanup();
		}
	});

	it("a since removed line names its line in the full diff's old side (baseNo); one the patch set added names none (CAR-139)", async () => {
		const ps1 = await snap(h.b0, h.p2);
		const removed = async (head: string, base = h.b0) => {
			const r = await snap(base, head);
			const traced = await traceRereview(
				h.path,
				since(1, ps1, marked(ps1)),
				[],
				targetOf(r),
			);
			const { answer } = answerRereview(
				traced,
				since(1, ps1, marked(ps1)),
				[],
				targetOf(r),
			);
			const a = answer.files.find((f) => f.path === "a.txt");
			if (!a) throw new Error("no a.txt");
			return interdiffFileHunks(traced, r, answer, a.index)
				.hunks.flatMap((hk) => hk.lines)
				.filter((l) => l.kind === "del")
				.map((l) => [l.text, l.oldNo, l.baseNo ?? null]);
		};
		// Line 35 is the base's, unchanged in PS1: the base's line 35.
		expect(await removed(h.h3)).toEqual([["line 35", 35, 35]]);
		// "thirty" is PS1's own line: no line of the base.
		expect(await removed(h.reworked)).toEqual([["thirty", 30, null]]);
	});

	/** Commits `files` on top of `parent` (detached) in the history's repo. */
	const commitOn = (parent: string, files: Record<string, string>) => {
		h.git("checkout", "--quiet", "--detach", parent);
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(h.path, name), content);
		}
		h.git("add", "--all");
		h.git("commit", "--quiet", "-m", "fixture");
		const sha = h.git("rev-parse", "HEAD");
		h.git("checkout", "--quiet", "main");
		return sha;
	};
	/** The since view's removed lines of `path`: text, own number, baseNo. */
	const removedSince = async (
		ps1: Awaited<ReturnType<typeof snap>>,
		r: Awaited<ReturnType<typeof snap>>,
		path: string,
	) => {
		const traced = await traceRereview(
			h.path,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		const { answer } = answerRereview(
			traced,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		const f = answer.files.find((x) => x.path === path);
		if (!f) throw new Error(`no ${path}`);
		return interdiffFileHunks(traced, r, answer, f.index)
			.hunks.flatMap((hk) => hk.lines)
			.filter((l) => l.kind === "del")
			.map((l) => [l.text, l.oldNo, l.baseNo ?? null]);
	};

	it("the base moved on (three lines on top): baseNo is the new base's line, neither the since view's number nor the old base's (CAR-139)", async () => {
		// PS1 dropped line 20, so its line 35 is the since view's 34 + 3.
		const ps1 = await snap(h.b0, h.deletesLine);
		const top = "top 1\ntop 2\ntop 3\n";
		const moved = commitOn(h.b0, { "a.txt": `${top}${aTxt({})}` });
		const head = commitOn(moved, {
			"a.txt": `${top}${aTxt({ 2: "two", 30: "thirty", 35: "thirty-five" }).replace("line 20\n", "")}`,
			"new.txt": "new\n",
		});
		const r = await snap(moved, head);
		// Old base: 35; the since view (PS1 rebased on the new base): 37;
		// the new base: 38.
		expect(await removedSince(ps1, r, "a.txt")).toEqual([["line 35", 37, 38]]);
	});

	it("twins git aligns differently: a removed line's baseNo names the base line that reads the same, not the line its own number names (CAR-139, on CAR-217's map)", async () => {
		// Base "x q } b". PS1 drops x and adds a second "}" (git: after the
		// first): "q } } b". The head turns x into Y instead: "q Y } b". The
		// since view removes PS1's *first* "}" (its old 2; git trims the
		// common ends), which is base line 3. Its number (2) names base "q":
		// a map by number would put a move or comment on another line.
		const base = commitOn(h.b0, { "g.txt": "x\nq\n}\nb\n" });
		const ps = commitOn(base, { "g.txt": "q\n}\n}\nb\n" });
		const head = commitOn(base, { "g.txt": "q\nY\n}\nb\n" });
		const ps1 = await snap(base, ps);
		const r = await snap(base, head);
		const removed = await removedSince(ps1, r, "g.txt");
		expect(removed).toEqual([["}", 2, 3]]);
		// The text guarantee: the base line it names reads as the row does
		// (base 2, the row's own number, is "q").
		const baseLines = h.git("show", `${base}:g.txt`).split("\n");
		expect(baseLines[1]).toBe("q");
		for (const [text, , b] of removed) {
			expect(baseLines[(b as number) - 1]).toBe(text);
		}
	});

	it("rebased between patch sets, a since-view removed line only PS1 had carries its line on PS1's commit, an added line of PS1's diff (CAR-233)", async () => {
		const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
		const text = (ls: string[]) => `${ls.join("\n")}\n`;
		const fx = createGitFixture([
			{ message: "base", files: { "a.txt": text(lines) } },
		]);
		try {
			const git = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: fx.path,
					encoding: "utf8",
					stdio: "pipe",
					env: testGitEnv(),
				}).trim();
			const commit = (message: string, content: string[]) => {
				writeFileSync(join(fx.path, "a.txt"), text(content));
				git("commit", "--quiet", "-am", message);
				return git("rev-parse", "HEAD");
			};
			const b1 = fx.shas[0] as string;
			// PS1 on B1: a line of its own after line 20 (PS1's line 21).
			const ps1Lines = lines.flatMap((l) =>
				l === "line 20" ? [l, "PS1's own"] : [l],
			);
			const h1 = commit("PR: its own line", ps1Lines);
			// B2: master inserts three lines on top.
			git("checkout", "--quiet", "--detach", b1);
			const masterLines = ["master 1", "master 2", "master 3", ...lines];
			const b2 = commit("base: three on top", masterLines);
			// PS2 on B2: PS1's line dropped again, line 30 changed.
			const h2 = commit(
				"PR: line 30 instead",
				masterLines.map((l) => (l === "line 30" ? "thirty" : l)),
			);
			const ps1 = await buildSnapshot(fx.path, b1, h1);
			const r = await buildSnapshot(fx.path, b2, h2);
			const traced = await traceRereview(
				fx.path,
				since(1, ps1, marked(ps1)),
				[],
				targetOf(r),
			);
			const { answer } = answerRereview(
				traced,
				since(1, ps1, marked(ps1)),
				[],
				targetOf(r),
			);
			const removed = interdiffFileHunks(traced, r, answer, 0).hunks.flatMap(
				(hk) =>
					hk.lines
						.filter((l) => l.kind === "del")
						.map((l) => [l.text, l.oldNo, l.baseNo, l.psNo]),
			);
			// The virtual rebase numbers it 24 (three lines down); on PS1's
			// commit it is 21. A base line carries no psNo.
			expect(removed).toEqual([
				["PS1's own", 24, null, 21],
				["line 30", 34, 33, undefined],
			]);
		} finally {
			fx.cleanup();
		}
	});

	it("a file renamed between PS1 and the head: PS1's own removed line has no line to name on PS1's commit by the head's path (psMoved, no psNo; CAR-233)", async () => {
		const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
		const text = (ls: string[]) => `${ls.join("\n")}\n`;
		const fx = createGitFixture([
			{ message: "base", files: { "old.txt": text(lines) } },
		]);
		try {
			const git = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: fx.path,
					encoding: "utf8",
					stdio: "pipe",
					env: testGitEnv(),
				}).trim();
			const b0 = fx.shas[0] as string;
			writeFileSync(
				join(fx.path, "old.txt"),
				text(lines.flatMap((l) => (l === "line 20" ? [l, "PS1's own"] : [l]))),
			);
			git("commit", "--quiet", "-am", "PR: its own line");
			const h1 = git("rev-parse", "HEAD");
			git("mv", "old.txt", "new.txt");
			writeFileSync(join(fx.path, "new.txt"), text(lines));
			git("commit", "--quiet", "-am", "PR: renamed, the line dropped");
			const h2 = git("rev-parse", "HEAD");
			const ps1 = await buildSnapshot(fx.path, b0, h1);
			const r = await buildSnapshot(fx.path, b0, h2);
			const traced = await traceRereview(
				fx.path,
				since(1, ps1, marked(ps1)),
				[],
				targetOf(r),
			);
			const { answer } = answerRereview(
				traced,
				since(1, ps1, marked(ps1)),
				[],
				targetOf(r),
			);
			const file = r.files.find((f) => f.path === "new.txt");
			if (!file) throw new Error("no new.txt");
			const removed = interdiffFileHunks(traced, r, answer, file.index)
				.hunks.flatMap((hk) => hk.lines)
				.filter((l) => l.kind === "del");
			expect(removed).toEqual([
				expect.objectContaining({
					text: "PS1's own",
					baseNo: null,
					psMoved: true,
				}),
			]);
			expect(removed[0]?.psNo).toBeUndefined();
		} finally {
			fx.cleanup();
		}
	});

	it("a deletion the author restored: gone, its restored line keyed to it", async () => {
		const ps1 = await snap(h.b0, h.deletesLine);
		const r = await snap(h.b0, h.restoresLine);
		const traced = await traceRereview(
			h.path,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		const { answer } = answerRereview(
			traced,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		const file = ps1.files.find((f) => f.path === "a.txt");
		const del = file?.clusters.find(
			(c) => c.oldStart === 20 && c.newCount === 0,
		);
		if (!del) throw new Error("no deletion cluster");
		expect(kinds(answer)).toEqual({
			"a.txt": ["carried:1", "carried:1", "gone:1"],
			"new.txt": ["carried:1"],
		});
		const lines = interdiffFileHunks(traced, r, answer, 0).hunks.flatMap((hk) =>
			hk.lines.filter((l) => l.kind !== "context"),
		);
		expect(lines).toEqual([
			{ kind: "add", newNo: 20, text: "line 20", clusterKey: del.key },
		]);
	});

	it("S8: a stacked parent landed in the base: its clusters are absorbed, not gone; a reverted one stays gone", async () => {
		const ps1 = await snap(h.b0, h.child);
		const r = await snap(h.parentLanded, h.childRebased);
		const result = await computeRereview(
			h.path,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		expect(kinds(result.answer)).toEqual({
			"a.txt": ["carried:1", "carried:1"],
			"new.txt": ["carried:1"],
		});
		expect(result.answer.shape.code).toBe("S4a");
		expect(result.absorbed.map((a) => a.path).sort()).toEqual([
			"a.txt",
			"parent.txt",
		]);
		expect(result.answer.toRead).toEqual({ files: 0, clusters: 0 });
		const revertedPs = await snap(h.b0, h.p3);
		const reverted = await computeRereview(
			h.path,
			since(1, revertedPs, marked(revertedPs)),
			[],
			targetOf(await snap(h.b0, h.reverted)),
		);
		expect(reverted.absorbed).toEqual([]);
		expect(kinds(reverted.answer)["extra.txt"]).toEqual(["gone:1"]);
	});

	it("R1: a reviewed binary file the author removes again is gone, not absorbed", async () => {
		const fx = createGitFixture([
			{ message: "base", files: { "a.txt": "a1\na2\n" } },
		]);
		try {
			const git = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: fx.path,
					encoding: "utf8",
					stdio: "pipe",
					env: testGitEnv(),
				}).trim();
			const b0 = fx.shas[0] as string;
			writeFileSync(join(fx.path, "bin.dat"), Buffer.from([0, 1, 2]));
			git("add", "--all");
			git("commit", "--quiet", "-m", "PR: bin.dat");
			const p1 = git("rev-parse", "HEAD");
			git("rm", "--quiet", "bin.dat");
			git("commit", "--quiet", "-m", "PR: drop bin.dat");
			const h2 = git("rev-parse", "HEAD");
			const ps1 = await buildSnapshot(fx.path, b0, p1);
			expect(ps1.files.map((f) => f.clusters.map((c) => c.kind))).toEqual([
				["file"],
			]);
			const result = await computeRereview(
				fx.path,
				since(1, ps1, marked(ps1)),
				[],
				targetOf(await buildSnapshot(fx.path, b0, h2)),
			);
			expect(result.answer.shape.code).toBe("S1");
			expect(kinds(result.answer)).toEqual({ "bin.dat": ["gone:1"] });
			expect(result.absorbed).toEqual([]);
		} finally {
			fx.cleanup();
		}
	});

	it("the cache key names the since and earlier snapshots, not their numbers", () => {
		const a = "a".repeat(64);
		const b = "b".repeat(64);
		const c = "c".repeat(64);
		expect(rereviewKey(a, b)).not.toBe(rereviewKey(a, b, [c]));
		expect(rereviewKey(a, b, [c])).toBe(rereviewKey(a, b, [c]));
		expect(rereviewKey(a, b)).toContain(`${a}:${b}:`);
	});

	it("a path that looks like a glob is diffed literally", async () => {
		const ps1 = await snap(h.g0, h.g1);
		const r = await snap(h.g0, h.g2);
		const { answer } = await computeRereview(
			h.path,
			since(1, ps1, marked(ps1)),
			[],
			targetOf(r),
		);
		expect(kinds(answer)).toEqual({
			"a.txt": ["new"],
			"we[i]rd.txt": ["carried:1"],
		});
	});

	it("stops when the signal aborts", async () => {
		const ps1 = await snap(h.b0, h.p2);
		const r = await snap(h.b0, h.h3);
		const controller = new AbortController();
		controller.abort();
		await expect(
			computeRereview(
				h.path,
				since(1, ps1, marked(ps1)),
				[],
				targetOf(r),
				controller.signal,
			),
		).rejects.toThrow(/stopped/);
	});

	describe("interdiffBlobName", () => {
		/** The traced result and answer of PS1 → `r`. */
		const compare = async (ps1: Snapshot, r: Snapshot) => {
			const sincePs = since(1, ps1, marked(ps1));
			const traced = await traceRereview(h.path, sincePs, [], targetOf(r));
			const { answer } = answerRereview(traced, sincePs, [], targetOf(r));
			const index = (path: string) => {
				const f = answer.files.find((x) => x.path === path);
				if (!f) throw new Error(`no ${path}`);
				return f.index;
			};
			return { traced, answer, index };
		};
		const show = (name: string) =>
			execFileSync("git", ["cat-file", "-p", name], {
				cwd: h.path,
				encoding: "utf8",
				env: testGitEnv(),
			});

		it("clean file after the base moved: old is the virtual rebase's, new the head's", async () => {
			const ps1 = await snap(h.b0, h.p2);
			const r = await snap(h.b1, h.amended);
			const { traced, answer, index } = await compare(ps1, r);
			if (traced.interdiff.status !== "available")
				throw new Error("no interdiff");
			const a = index("a.txt");
			const old = interdiffBlobName(traced, r, answer, a, "old");
			expect(old).toBe(`${traced.interdiff.virtualHead}:a.txt`);
			// H1': PS1's lines on the moved base, never PS1's own commit.
			expect(show(old as string)).toBe(
				aTxt({ 2: "two", 15: "fifteen", 30: "thirty" }),
			);
			expect(interdiffBlobName(traced, r, answer, a, "new")).toBe(
				`${h.amended}:a.txt`,
			);
		});

		it("conflicted file: old is the target's merge base", async () => {
			const ps1 = await snap(h.b0, h.p2);
			const r = await snap(h.b1c, h.resolvedPlus);
			const { traced, answer, index } = await compare(ps1, r);
			const a = index("a.txt");
			expect(interdiffBlobName(traced, r, answer, a, "old")).toBe(
				`${h.b1c}:a.txt`,
			);
			expect(interdiffBlobName(traced, r, answer, a, "new")).toBe(
				`${h.resolvedPlus}:a.txt`,
			);
			// new.txt rebased cleanly: the virtual rebase's.
			if (traced.interdiff.status !== "available")
				throw new Error("no interdiff");
			expect(
				interdiffBlobName(traced, r, answer, index("new.txt"), "old"),
			).toBe(`${traced.interdiff.virtualHead}:new.txt`);
		});

		it("a file the interdiff doesn't list is the head's on both sides; added has no old, deleted no new", async () => {
			const ps1 = await snap(h.b0, h.p2);
			const r = await snap(h.b0, h.p3);
			const { traced, answer, index } = await compare(ps1, r);
			const n = index("new.txt");
			expect(interdiffBlobName(traced, r, answer, n, "old")).toBe(
				`${h.p3}:new.txt`,
			);
			expect(interdiffBlobName(traced, r, answer, n, "new")).toBe(
				`${h.p3}:new.txt`,
			);
			const extra = index("extra.txt");
			expect(interdiffBlobName(traced, r, answer, extra, "old")).toBeNull();
			expect(interdiffBlobName(traced, r, answer, extra, "new")).toBe(
				`${h.p3}:extra.txt`,
			);
			// PS3 had extra.txt; the revert deletes it since.
			const ps3 = await snap(h.b0, h.p3);
			const back = await snap(h.b0, h.reverted);
			const gone = await compare(ps3, back);
			if (gone.traced.interdiff.status !== "available") {
				throw new Error("no interdiff");
			}
			const e = gone.index("extra.txt");
			expect(interdiffBlobName(gone.traced, back, gone.answer, e, "old")).toBe(
				`${gone.traced.interdiff.virtualHead}:extra.txt`,
			);
			expect(
				interdiffBlobName(gone.traced, back, gone.answer, e, "new"),
			).toBeNull();
			expect(() => interdiffBlobName(traced, r, answer, 99, "old")).toThrow(
				/No file 99/,
			);
		});

		it("a file renamed and edited since: old is the virtual rebase's at its old path", async () => {
			const lines = (changes: Record<number, string>) =>
				`${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => changes[n] ?? `pic ${n}`).join("\n")}\n`;
			const fx = createGitFixture([
				{ message: "base", files: { "pic.txt": lines({}) } },
				{ message: "PS1", files: { "pic.txt": lines({ 2: "two" }) } },
				{
					message: "PS2: rename and edit",
					rename: { "pic.txt": "moved.txt" },
					files: { "moved.txt": lines({ 2: "two", 7: "seven" }) },
				},
			]);
			try {
				const [b0 = "", p1 = "", p2 = ""] = fx.shas;
				const ps1 = await buildSnapshot(fx.path, b0, p1);
				const r = await buildSnapshot(fx.path, b0, p2);
				const sincePs = since(1, ps1, marked(ps1));
				const traced = await traceRereview(fx.path, sincePs, [], targetOf(r));
				const { answer } = answerRereview(traced, sincePs, [], targetOf(r));
				if (traced.interdiff.status !== "available") {
					throw new Error("no interdiff");
				}
				expect(traced.interdiff.files[0]).toMatchObject({
					path: "moved.txt",
					oldPath: "pic.txt",
				});
				const moved = answer.files.find((f) => f.path === "moved.txt");
				if (!moved) throw new Error("no moved.txt");
				const old = interdiffBlobName(traced, r, answer, moved.index, "old");
				expect(old).toBe(`${traced.interdiff.virtualHead}:pic.txt`);
				expect(
					execFileSync("git", ["cat-file", "-p", old as string], {
						cwd: fx.path,
						encoding: "utf8",
						env: testGitEnv(),
					}),
				).toBe(lines({ 2: "two" }));
				expect(interdiffBlobName(traced, r, answer, moved.index, "new")).toBe(
					`${p2}:moved.txt`,
				);
			} finally {
				fx.cleanup();
			}
		});

		it("an unavailable interdiff has no old side", async () => {
			const ps1 = await snap(h.b0, h.p2);
			const r = await snap(h.orphan, h.orphanHead);
			const { traced, answer, index } = await compare(ps1, r);
			const z = index("z.txt");
			expect(interdiffBlobName(traced, r, answer, z, "old")).toBeNull();
			expect(interdiffBlobName(traced, r, answer, z, "new")).toBe(
				`${h.orphanHead}:z.txt`,
			);
		});
	});
});

describe("RereviewCache", () => {
	it("serves from memory, then from disk in a new instance; a corrupt or foreign file is a miss", async () => {
		const dir = mkdtempSync(join(tmpdir(), "crb-rereview-cache-"));
		try {
			const key = rereviewKey("a".repeat(64), "b".repeat(64));
			const cache = new RereviewCache<{ n: number }>(dir);
			expect(await cache.get(key)).toBeNull();
			await cache.set(key, { n: 1 });
			expect(await cache.get(key)).toEqual({ n: 1 });
			expect(await new RereviewCache<{ n: number }>(dir).get(key)).toEqual({
				n: 1,
			});
			expect(
				await new RereviewCache(dir).get(
					rereviewKey("a".repeat(64), "c".repeat(64)),
				),
			).toBeNull();
			const [file = ""] = execFileSync("ls", [dir], { encoding: "utf8" })
				.trim()
				.split("\n");
			expect(file).toMatch(/^[0-9a-f]{64}\.json$/);
			writeFileSync(join(dir, file), "{nope");
			expect(await new RereviewCache(dir).get(key)).toBeNull();
			writeFileSync(
				join(dir, file),
				JSON.stringify({ key: "other", value: 1 }),
			);
			expect(await new RereviewCache(dir).get(key)).toBeNull();
			// The memory copy stands whatever the disk says.
			expect(await cache.get(key)).toEqual({ n: 1 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the engine's cost", () => {
	/**
	 * A PR of `count` 60-line files, three lines changed in each, then a
	 * push that changes one more line in every 40th file; and a run of the
	 * engine over it (its trace and its answer).
	 */
	const pr = async (count: number) => {
		const files: Record<string, string> = {};
		const changed: Record<string, string> = {};
		const again: Record<string, string> = {};
		const body = (n: number, marks: number[]) =>
			`${Array.from({ length: 60 }, (_, i) => (marks.includes(i) ? `file ${n} line ${i + 1} changed` : `file ${n} line ${i + 1}`)).join("\n")}\n`;
		for (let n = 0; n < count; n++) {
			files[`src/f${n}.txt`] = body(n, []);
			changed[`src/f${n}.txt`] = body(n, [4, 20, 45]);
			again[`src/f${n}.txt`] = body(
				n,
				n % 40 === 0 ? [4, 20, 45, 50] : [4, 20, 45],
			);
		}
		const fx = createGitFixture([
			{ message: "base", files },
			{ message: "PR", files: changed },
			{ message: "PR: more", files: again },
		]);
		const [b0, h1, h2] = fx.shas as [string, string, string];
		const ps1 = await buildSnapshot(fx.path, b0, h1);
		const r = await buildSnapshot(fx.path, b0, h2);
		expect(ps1.files).toHaveLength(count);
		const states = marked(ps1);
		const trace = () =>
			traceRereview(fx.path, since(1, ps1, states), [], targetOf(r));
		const traced = await trace();
		const answer = () =>
			answerRereview(traced, since(1, ps1, states), [], targetOf(r)).answer;
		return { fx, trace, answer };
	};

	// Two PRs, built once for both tests (the fixtures are most of the time).
	let large: Awaited<ReturnType<typeof pr>>;
	let small: Awaited<ReturnType<typeof pr>>;
	beforeAll(async () => {
		large = await pr(200);
		small = await pr(50);
	});
	afterAll(() => {
		large?.fx.cleanup();
		small?.fx.cleanup();
	});

	it("answers a 200-file PR in linear time", () => {
		// Git is out of the loop (traced once, above): the answer's CPU
		// against four answers over a PR a quarter the size (CLAUDE.md):
		// linear is about 1x, a cost quadratic in the files 4x.
		const { best, ratio } = bestCpuRatio(large.answer, repeat(4, small.answer));
		console.info(
			`engine answer CPU for 200 files: ${(best / 1000).toFixed(1)} ms, ${ratio.toFixed(2)}x four 50-file answers`,
		);
		expect(ratio).toBeLessThan(2);
		const answer = large.answer();
		expect(answer.toRead).toEqual({ files: 5, clusters: 5 });
		expect(
			answer.files
				.flatMap((f) => f.clusters)
				.filter((c) => c.kind === "carried"),
		).toHaveLength(600);
		execFileSync("git", ["-C", large.fx.path, "status"], {
			env: testGitEnv(),
		});
	});

	it("traces a 200-file PR without git work per file", async () => {
		// A trace runs a fixed number of git commands, whatever the PR's
		// size; spawning and reading them is most of this thread's CPU for
		// 50 files. Against one 50-file trace, that is about 1.15x; a git
		// command per file (about 1 ms here each) would be about 4x. Too
		// coarse for the trace's own per-file work: a quadratic step there
		// fails only once it adds about 10 ms at 200 files.
		const { best, ratio, times } = await bestCpuRatioAsync(
			large.trace,
			small.trace,
		);
		// One trace's CPU: a side below the helper's floor runs `times` traces.
		const one = best / times;
		console.info(
			`engine trace CPU for 200 files: ${(one / 1000).toFixed(0)} ms, ${ratio.toFixed(2)}x a 50-file trace`,
		);
		expect(ratio).toBeLessThan(2);
		// The absolute backstop CLAUDE.md allows: both sides pay the fixed
		// per-run cost, so the ratio can't see it grow, even 100x. One
		// 200-file trace measured 16-27 ms CPU on the dev machine and
		// 15-35 ms on CI over 10 runs; 250 ms is about 7x CI's slowest.
		expect(one).toBeLessThan(250_000);
	});
});
