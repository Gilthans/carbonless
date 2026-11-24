import { describe, expect, it, vi } from "vitest";
import {
	createGitFixture,
	type FixtureCommit,
	GIT_TEST_TIMEOUTS,
} from "../../../test/git-fixture";
import {
	FILE_LEVEL,
	type SinceUnit,
	sinceFileChange,
	sinceToggleChange,
	sinceUnits,
} from "../../shared/pieces";
import type {
	ClusterView,
	RereviewAnswer,
	SinceMark,
	Snapshot,
} from "../../shared/types";
import { buildSnapshot } from "../diff/snapshot";
import type { StateEntry } from "../review/fold";
import {
	answerRereview,
	interdiffFileHunks,
	type SincePatchset,
	traceRereview,
} from "./engine";

/*
 * CAR-297: a file whose only change between two patch sets is file-level
 * (a mode, a binary file, a submodule pointer) has no lines in the
 * interdiff. The since view must still show it, count it as to read and
 * let it be marked: never "Nothing to read since" while it is there.
 */

vi.setConfig(GIT_TEST_TIMEOUTS);

const SUB_A = "1".repeat(40);
const SUB_B = "2".repeat(40);
const SUB_C = "3".repeat(40);
const bytes = (n: number) => Uint8Array.from([0, n, 0xff]);

const base: FixtureCommit = {
	message: "base",
	files: { "a.txt": "a\n", "run.sh": "echo 1\necho 2\n" },
	binary: { "bin.dat": bytes(1) },
	submodule: { lib: SUB_A },
};
/** PS1: a line, the mode, the binary and the submodule all changed. */
const ps1All: FixtureCommit = {
	message: "ps1",
	files: { "a.txt": "a\nb\n" },
	chmod: { "run.sh": "755" },
	binary: { "bin.dat": bytes(2) },
	submodule: { lib: SUB_B },
};

/**
 * The since view from PS1 (every cluster reviewed) to PS2, as the page
 * reads it: the engine's answer, its units under `marks` with the target's
 * clusters unmarked (but what the engine carried), and each file's hunks.
 */
async function sinceView(commits: FixtureCommit[]) {
	const fx = createGitFixture(commits);
	try {
		const [b0, p1, p2] = fx.shas as [string, string, string];
		const ps1 = await buildSnapshot(fx.path, b0, p1);
		const target = await buildSnapshot(fx.path, b0, p2);
		const ps: SincePatchset = {
			number: 1,
			revision: ps1.revision,
			mergeBase: ps1.base,
			head: ps1.head,
			startedAt: 0,
			since: null,
			shape: null,
			baseBranch: "main",
			interdiff: null,
			snapshot: ps1,
			states: reviewedAll(ps1),
		};
		const t = { ...target, baseBranch: "main" };
		const traced = await traceRereview(fx.path, ps, [], t);
		const { answer } = answerRereview(traced, ps, [], t);
		const hunks = (path: string) => {
			const f = answer.files.find((x) => x.path === path);
			if (!f) throw new Error(`no ${path}`);
			return interdiffFileHunks(traced, target, answer, f.index);
		};
		return {
			answer,
			target,
			hunks,
			units: (marks?: SinceMark[]) =>
				sinceUnits(answer.files, 1, clustersOf(answer, target), marks),
		};
	} finally {
		fx.cleanup();
	}
}

const reviewedAll = (s: Snapshot) =>
	new Map<string, StateEntry>(
		s.files.flatMap((f) =>
			f.clusters.map((c) => [c.key, { state: "reviewed" as const }]),
		),
	);

/** The target's clusters, carried ones with the engine's mark, the rest unreviewed. */
const clustersOf =
	(answer: RereviewAnswer, target: Snapshot) =>
	(index: number): ClusterView[] => {
		const kinds = new Map(
			answer.files.flatMap((f) => f.clusters.map((c) => [c.key, c])),
		);
		return (target.files.find((f) => f.index === index)?.clusters ?? []).map(
			(c) => {
				const k = kinds.get(c.key);
				return k?.kind === "carried" && k.state && k.from
					? {
							...c,
							state: k.state,
							carried: { from: k.from, rule: k.rule ?? "exact" },
						}
					: { ...c, state: "unreviewed" };
			},
		);
	};

/** Units as `path kind state` (lines count only for file-level, always 0). */
const brief = (units: SinceUnit[]) =>
	units.map((u) => `${u.path} ${u.kind} ${u.state} ${u.lines}`).sort();

describe("file-level changes between patch sets (CAR-297)", () => {
	it("PS2 reverts PS1's mode, binary and submodule: each file is gone with its label, to read, and markable on its own", async () => {
		const v = await sinceView([
			base,
			ps1All,
			{
				message: "ps2: revert all but a.txt",
				files: {},
				chmod: { "run.sh": "644" },
				binary: { "bin.dat": bytes(1) },
				submodule: { lib: SUB_A },
			},
		]);
		const kinds = Object.fromEntries(
			v.answer.files.map((f) => [f.path, f.clusters.map((c) => c.kind)]),
		);
		expect(kinds).toEqual({
			"a.txt": ["carried"],
			"bin.dat": ["gone"],
			lib: ["gone"],
			"run.sh": ["gone"],
		});
		// Before CAR-297: no piece, no unit, toRead 0.
		expect(v.answer.toRead).toEqual({ files: 3, clusters: 3 });
		expect(brief(v.units())).toEqual([
			"bin.dat gone unreviewed 0",
			"lib gone unreviewed 0",
			"run.sh gone unreviewed 0",
		]);
		const labels = Object.fromEntries(
			["bin.dat", "lib", "run.sh"].map((p) => [
				p,
				v.hunks(p).pieces?.map((x) => x.file),
			]),
		);
		expect(labels).toEqual({
			"bin.dat": ["Binary file changed"],
			lib: ["Submodule moved 2222222 → 1111111"],
			"run.sh": ["Mode changed 100755 → 100644"],
		});
		const piece = v.hunks("run.sh").pieces?.[0];
		if (!piece) throw new Error("no piece");
		// Its key is the gone cluster it undoes (its chip says gone).
		const gone = v.answer.files.find((f) => f.path === "run.sh")?.clusters[0];
		expect(piece).toMatchObject({ key: gone?.key, owns: null, hunk: -1 });

		// A box of its own: a tick marks it reviewed on run.sh's since mark…
		const tick = sinceToggleChange(undefined, 1, "run.sh", piece);
		expect(tick.state).toBe("reviewed");
		const marks = [tick.sinceMark as SinceMark];
		expect(brief(v.units(marks))).toContain("run.sh gone reviewed 0");
		// …and an untick unmarks it again.
		const untick = sinceToggleChange(marks, 1, "run.sh", piece);
		expect(brief(v.units([untick.sinceMark as SinceMark]))).toContain(
			"run.sh gone unreviewed 0",
		);
		// The header's whole-file action marks it too; crossing off as well.
		const whole = sinceFileChange(undefined, 1, "lib", [piece], "crossed-off");
		expect(brief(v.units([whole?.sinceMark as SinceMark]))).toContain(
			"lib gone crossed-off 0",
		);
	});

	it("a mark on the file's lines never marks its file-level change (principle 2)", async () => {
		const v = await sinceView([
			base,
			{ ...ps1All, files: { "run.sh": "echo 1\necho two\n" } },
			{
				message: "ps2: mode back, a line more",
				files: { "run.sh": "echo 1\necho two\necho 3\n" },
				chmod: { "run.sh": "644" },
				binary: { "bin.dat": bytes(2) },
				submodule: { lib: SUB_B },
			},
		]);
		const pieces = v.hunks("run.sh").pieces ?? [];
		const file = pieces.find((p) => p.file !== undefined);
		expect(file?.file).toBe("Mode changed 100755 → 100644");
		expect(pieces.filter((p) => p.file === undefined).length).toBeGreaterThan(
			0,
		);
		// Every line of both sides marked: the file-level change stays to read.
		const everyLine: SinceMark = {
			since: 1,
			path: "run.sh",
			reviewed: { old: [[1, 10_000]], new: [[1, 10_000]] },
			crossed: { old: [], new: [] },
		};
		const fileUnits = (marks: SinceMark[]) =>
			v
				.units(marks)
				.filter((u) => u.path === "run.sh" && u.kind === "gone")
				.map((u) => u.state);
		expect(fileUnits([everyLine])).toEqual(["unreviewed"]);
		// Line 0 of the old side, which no line has, is that change's alone.
		expect(FILE_LEVEL).toEqual({ old: [[0, 1]], new: [] });
		expect(
			fileUnits([{ ...everyLine, reviewed: { old: [[0, 1]], new: [] } }]),
		).toEqual(["reviewed"]);
	});

	it("PS2 adds a file-level change PS1 hadn't: new, to read, with the snapshot's own file-level cluster (already worked)", async () => {
		const v = await sinceView([
			base,
			{
				message: "ps1",
				files: { "a.txt": "a\nb\n" },
				submodule: { lib: SUB_A },
			},
			{
				message: "ps2",
				files: {},
				chmod: { "run.sh": "755" },
				binary: { "bin.dat": bytes(2) },
				submodule: { lib: SUB_B },
			},
		]);
		expect(v.answer.toRead).toEqual({ files: 3, clusters: 3 });
		expect(brief(v.units())).toEqual([
			"bin.dat new unreviewed 0",
			"lib new unreviewed 0",
			"run.sh new unreviewed 0",
		]);
		// The snapshot's cluster shows it (its row and box): no piece of its own.
		for (const path of ["bin.dat", "lib", "run.sh"]) {
			expect(v.hunks(path).pieces ?? []).toEqual([]);
		}
		// Marked reviewed in the snapshot, it is read.
		const reviewed = (index: number) =>
			clustersOf(
				v.answer,
				v.target,
			)(index).map((c) => ({ ...c, state: "reviewed" as const }));
		expect(
			sinceUnits(v.answer.files, 1, reviewed, undefined).every(
				(u) => u.state === "reviewed",
			),
		).toBe(true);
	});

	it("PS1 and PS2 move the binary and the submodule to different values: reworked, to read (already worked)", async () => {
		const v = await sinceView([
			base,
			{
				message: "ps1",
				files: { "a.txt": "a\nb\n" },
				binary: { "bin.dat": bytes(2) },
				submodule: { lib: SUB_B },
			},
			{
				message: "ps2",
				files: {},
				binary: { "bin.dat": bytes(3) },
				submodule: { lib: SUB_C },
			},
		]);
		expect(v.answer.toRead).toEqual({ files: 2, clusters: 2 });
		expect(brief(v.units())).toEqual([
			"bin.dat reworked unreviewed 0",
			"lib reworked unreviewed 0",
		]);
		for (const path of ["bin.dat", "lib"]) {
			expect(v.hunks(path).pieces ?? []).toEqual([]);
		}
	});

	it("a binary file PS1 added and PS2 drops is gone and to read", async () => {
		const v = await sinceView([
			{ message: "base", files: { "a.txt": "a\n" } },
			{ message: "ps1", files: {}, binary: { "new.dat": bytes(4) } },
			{ message: "ps2", files: { "a.txt": "a\nb\n" }, delete: ["new.dat"] },
		]);
		expect(brief(v.units()).filter((u) => u.startsWith("new.dat"))).toEqual([
			"new.dat gone unreviewed 0",
		]);
	});
});
