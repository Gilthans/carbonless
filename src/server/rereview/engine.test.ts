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
import {
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
						{ kind: "del", oldNo: 1, text: "extra", clusterKey: extraKey },
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
					{ kind: "del", oldNo: 30, text: "thirty", clusterKey: k30 },
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
	it("traces and answers a 200-file PR within 2 s of CPU", async () => {
		const files: Record<string, string> = {};
		const changed: Record<string, string> = {};
		const again: Record<string, string> = {};
		const body = (n: number, marks: number[]) =>
			`${Array.from({ length: 60 }, (_, i) => (marks.includes(i) ? `file ${n} line ${i + 1} changed` : `file ${n} line ${i + 1}`)).join("\n")}\n`;
		for (let n = 0; n < 200; n++) {
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
		try {
			const [b0, h1, h2] = fx.shas as [string, string, string];
			const ps1 = await buildSnapshot(fx.path, b0, h1);
			const r = await buildSnapshot(fx.path, b0, h2);
			expect(ps1.files).toHaveLength(200);
			const states = marked(ps1);
			const before = process.threadCpuUsage();
			const traced = await traceRereview(
				fx.path,
				since(1, ps1, states),
				[],
				targetOf(r),
			);
			const { answer } = answerRereview(
				traced,
				since(1, ps1, states),
				[],
				targetOf(r),
			);
			const after = process.threadCpuUsage();
			const cpuMs =
				(after.user - before.user + after.system - before.system) / 1000;
			console.log(`engine CPU for 200 files: ${cpuMs.toFixed(0)} ms`);
			expect(cpuMs).toBeLessThan(2000);
			expect(answer.toRead).toEqual({ files: 5, clusters: 5 });
			expect(
				answer.files
					.flatMap((f) => f.clusters)
					.filter((c) => c.kind === "carried"),
			).toHaveLength(600);
			execFileSync("git", ["-C", fx.path, "status"], { env: testGitEnv() });
		} finally {
			fx.cleanup();
		}
	});
});
