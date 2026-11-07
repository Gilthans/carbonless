import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { clusterKeys } from "../../server/diff/identity";
import { createLineMapper, IDENTITY, type MapHunk } from "../tracer/index";
import type { Cluster, ClusterState } from "../types";
import {
	type CarryInput,
	carryClusters,
	carryTraced,
	type SourceFile,
	type SourcePatchset,
	type SourceState,
	type TargetFile,
	traceClusters,
} from "./carry";

/** A line cluster; `removed`/`added` default to one line each at the start. */
function cluster(
	key: string,
	range: {
		oldStart: number;
		oldCount: number;
		newStart: number;
		newCount: number;
	},
	lines: { removed?: string[]; added?: string[] } = {},
	extra: Partial<Cluster> = {},
): Cluster {
	const removed =
		lines.removed ?? (range.oldCount ? [`old ${range.oldStart}`] : []);
	const added =
		lines.added ?? (range.newCount ? [`new ${range.newStart}`] : []);
	return {
		key,
		kind: "lines",
		...range,
		removed,
		added,
		lines: removed.length + added.length,
		...extra,
	};
}

/** A one-line modification at `line` on both sides. */
const mod = (key: string, line: number, removed: string, added: string) =>
	cluster(
		key,
		{ oldStart: line, oldCount: 1, newStart: line, newCount: 1 },
		{ removed: [removed], added: [added] },
	);

const fileCluster = (key: string, label: string): Cluster => ({
	key,
	kind: "file",
	label,
	oldStart: 0,
	oldCount: 0,
	newStart: 0,
	newCount: 0,
	removed: [],
	added: [],
	lines: 0,
});

const states = (
	entries: Record<string, ClusterState | SourceState>,
): Map<string, SourceState> =>
	new Map(
		Object.entries(entries).map(([key, s]) => [
			key,
			typeof s === "string" ? { state: s } : s,
		]),
	);

const source = (
	path: string,
	clusters: Cluster[],
	marks: Record<string, ClusterState | SourceState>,
): SourceFile => ({ path, clusters, states: states(marks) });

const ps = (number: number, files: SourceFile[]): SourcePatchset => ({
	number,
	files,
});

const target = (
	path: string,
	clusters: Cluster[],
	mappers: Partial<Pick<TargetFile, "bd" | "ac" | "oldPath" | "earlier">> = {},
): TargetFile => ({
	path,
	clusters,
	bd: IDENTITY,
	ac: IDENTITY,
	...mappers,
});

const input = (
	sources: SourcePatchset[],
	targets: TargetFile[],
	interdiffPaths: string[] = [],
): CarryInput => ({
	sources,
	target: targets,
	interdiffPaths: new Set(interdiffPaths),
});

const mapper = (...hunks: MapHunk[]) => createLineMapper(hunks);

describe("carryClusters", () => {
	const two = mod("k2", 2, "line 2", "two");
	const thirty = mod("k30", 30, "line 30", "thirty");

	it("P1: an identical cluster carries, exact, from the patch set", () => {
		const r = carryClusters(
			input(
				[ps(1, [source("a.txt", [two, thirty], { k2: "reviewed" })])],
				[target("a.txt", [two, thirty])],
			),
		);
		expect(r).toEqual({
			carried: [
				{ key: "k2", fromKey: "k2", from: 1, rule: "exact", state: "reviewed" },
			],
			reworked: new Set(),
			gone: [],
			absorbed: [],
		});
	});

	it("P2: context that differs (the base changed a line next to it) still carries", () => {
		// The base changed line 4 (B1 → B2), the head has it too (H1 → H2):
		// the cluster at line 2 is untouched, its context not.
		const shifted = mapper({
			oldStart: 4,
			oldCount: 1,
			newStart: 4,
			newCount: 1,
		});
		const r = carryClusters(
			input(
				[ps(1, [source("a.txt", [two], { k2: "reviewed" })])],
				[
					target("a.txt", [mod("k2b", 2, "line 2", "two")], {
						bd: shifted,
						ac: shifted,
					}),
				],
			),
		);
		expect(r.carried).toEqual([
			{ key: "k2b", fromKey: "k2", from: 1, rule: "exact", state: "reviewed" },
		]);
	});

	it("P3: an edited cluster is reworked, never carried", () => {
		const r = carryClusters(
			input(
				[ps(1, [source("a.txt", [two], { k2: "reviewed" })])],
				[
					target("a.txt", [mod("k2x", 2, "line 2", "two!")], {
						bd: mapper({ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }),
					}),
				],
			),
		);
		expect(r).toEqual({
			carried: [],
			reworked: new Set(["k2x"]),
			gone: [],
			absorbed: [],
		});
	});

	it("P4: a cluster split in two by the author is neither carried nor gone: both halves reworked", () => {
		const three = cluster(
			"k10",
			{ oldStart: 10, oldCount: 3, newStart: 10, newCount: 3 },
			{ removed: ["l10", "l11", "l12"], added: ["a", "b", "c"] },
		);
		// The middle line went back to the base's: two clusters remain.
		const r = carryClusters(
			input(
				[ps(1, [source("a.txt", [three], { k10: "reviewed" })])],
				[
					target(
						"a.txt",
						[mod("t10", 10, "l10", "a"), mod("t12", 12, "l12", "c")],
						{
							bd: mapper({
								oldStart: 11,
								oldCount: 1,
								newStart: 11,
								newCount: 1,
							}),
						},
					),
				],
			),
		);
		expect(r).toEqual({
			carried: [],
			reworked: new Set(["t10", "t12"]),
			gone: [],
			absorbed: [],
		});
		// Grown by a line in the middle: one target cluster, reworked.
		const grown = carryClusters(
			input(
				[ps(1, [source("a.txt", [three], { k10: "reviewed" })])],
				[
					target(
						"a.txt",
						[
							cluster(
								"t10",
								{ oldStart: 10, oldCount: 3, newStart: 10, newCount: 4 },
								{ removed: ["l10", "l11", "l12"], added: ["a", "x", "b", "c"] },
							),
						],
						{
							bd: mapper({
								oldStart: 10,
								oldCount: 0,
								newStart: 11,
								newCount: 1,
							}),
						},
					),
				],
			),
		);
		expect(grown).toEqual({
			carried: [],
			reworked: new Set(["t10"]),
			gone: [],
			absorbed: [],
		});
	});

	it("P5: a cluster moved down by lines added above it carries (numbers aren't identity)", () => {
		const added = mapper({
			oldStart: 0,
			oldCount: 0,
			newStart: 1,
			newCount: 2,
		});
		const r = carryClusters(
			input(
				[ps(1, [source("a.txt", [two], { k2: "crossed-off" })])],
				[
					target(
						"a.txt",
						[
							cluster("top", {
								oldStart: 0,
								oldCount: 0,
								newStart: 1,
								newCount: 2,
							}),
							cluster(
								"k2m",
								{ oldStart: 2, oldCount: 1, newStart: 4, newCount: 1 },
								{ removed: ["line 2"], added: ["two"] },
							),
						],
						{ bd: added },
					),
				],
			),
		);
		expect(r.carried).toEqual([
			{
				key: "k2m",
				fromKey: "k2",
				from: 1,
				rule: "exact",
				state: "crossed-off",
			},
		]);
		expect(r.reworked.size).toBe(0);
	});

	it("P6: a renamed file carries through the rename pair under rule rename", () => {
		const r = carryClusters(
			input(
				[ps(1, [source("a.txt", [two], { k2: "reviewed" })])],
				[
					target("b.txt", [mod("k2r", 2, "line 2", "two")], {
						oldPath: "a.txt",
					}),
				],
			),
		);
		expect(r.carried).toEqual([
			{ key: "k2r", fromKey: "k2", from: 1, rule: "rename", state: "reviewed" },
		]);
	});

	it("P7: a crossed-off cluster regenerated with new content is not carried; an identical one carries crossed off", () => {
		const gen = cluster(
			"g",
			{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2 },
			{ removed: ["x1", "x2"], added: ["y1", "y2"] },
		);
		const regenerated = cluster(
			"g2",
			{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2 },
			{ removed: ["x1", "x2"], added: ["z1", "z2"] },
		);
		const r = carryClusters(
			input(
				[ps(1, [source("lock", [gen], { g: { state: "crossed-off" } })])],
				[
					target("lock", [regenerated], {
						bd: mapper({ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2 }),
					}),
				],
			),
		);
		expect(r).toEqual({
			carried: [],
			reworked: new Set(["g2"]),
			gone: [],
			absorbed: [],
		});
		const same = carryClusters(
			input(
				[ps(1, [source("lock", [gen], { g: "crossed-off" })])],
				[target("lock", [gen])],
			),
		);
		expect(same.carried).toEqual([
			{ key: "g", fromKey: "g", from: 1, rule: "exact", state: "crossed-off" },
		]);
	});

	it("P8: reworked in PS2, back to PS1's content in PS3: carried from PS1", () => {
		const changed = mapper({
			oldStart: 30,
			oldCount: 1,
			newStart: 30,
			newCount: 1,
		});
		const r = carryClusters(
			input(
				[
					ps(2, [
						source("a.txt", [mod("k30b", 30, "line 30", "thirty-two")], {
							k30b: "reviewed",
						}),
					]),
					ps(1, [source("a.txt", [thirty], { k30: "reviewed" })]),
				],
				[
					target("a.txt", [thirty], {
						bd: changed,
						earlier: new Map([[1, { bd: IDENTITY, ac: IDENTITY }]]),
					}),
				],
			),
		);
		expect(r).toEqual({
			carried: [
				{
					key: "k30",
					fromKey: "k30",
					from: 1,
					rule: "exact",
					state: "reviewed",
				},
			],
			reworked: new Set(),
			gone: [],
			absorbed: [],
		});
	});

	it("P9: every cluster identical: all carried", () => {
		const files = [
			source("a.txt", [two, thirty], { k2: "reviewed", k30: "reviewed" }),
		];
		const r = carryClusters(
			input([ps(1, files)], [target("a.txt", [two, thirty])]),
		);
		expect(r.carried.map((c) => c.key)).toEqual(["k2", "k30"]);
	});

	it("P10: a whitespace-only change is a change: not carried", () => {
		const r = carryClusters(
			input(
				[ps(1, [source("a.txt", [two], { k2: "reviewed" })])],
				[
					target("a.txt", [mod("k2w", 2, "line 2", "two ")], {
						bd: mapper({ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }),
					}),
				],
			),
		);
		expect(r.carried).toEqual([]);
		expect(r.reworked).toEqual(new Set(["k2w"]));
	});

	it("P11: a reverted change has no image: gone", () => {
		const r = carryClusters(
			input(
				[
					ps(1, [
						source("a.txt", [two, thirty], { k30: "reviewed", k2: "reviewed" }),
					]),
				],
				[
					target("a.txt", [two], {
						// Line 30 went back to the base's text.
						bd: mapper({
							oldStart: 30,
							oldCount: 1,
							newStart: 30,
							newCount: 1,
						}),
					}),
				],
			),
		);
		expect(r).toEqual({
			carried: [
				{ key: "k2", fromKey: "k2", from: 1, rule: "exact", state: "reviewed" },
			],
			reworked: new Set(),
			gone: [{ fromKey: "k30", from: 1, path: "a.txt" }],
			absorbed: [],
		});
	});

	it("P12: duplicate identities carry by occurrence while the counts agree, else none of them", () => {
		const dup = (key: string, line: number) =>
			cluster(
				key,
				{ oldStart: line, oldCount: 1, newStart: line, newCount: 1 },
				{ removed: ["x"], added: ["y"] },
			);
		const h = "a".repeat(64);
		const sources = [
			ps(1, [
				source("a.txt", [dup(h, 5), dup(`${h}:2`, 20)], {
					[h]: "reviewed",
					[`${h}:2`]: "reviewed",
				}),
			]),
		];
		const agree = carryClusters(
			input(sources, [target("a.txt", [dup(h, 5), dup(`${h}:2`, 20)])]),
		);
		expect(agree.carried.map((c) => [c.key, c.fromKey])).toEqual([
			[h, h],
			[`${h}:2`, `${h}:2`],
		]);
		const third = carryClusters(
			input(sources, [
				target("a.txt", [dup(h, 5), dup(`${h}:2`, 20), dup(`${h}:3`, 35)]),
			]),
		);
		expect(third.carried).toEqual([]);
		expect(third.gone).toEqual([]);
		// Both are shown as reworked: the reviewer looks again.
		expect(third.reworked).toEqual(new Set([h, `${h}:2`]));
	});

	it("Review focus 2: the added lines trace but the base changed the removed ones: reworked", () => {
		const r = carryClusters(
			input(
				[ps(1, [source("a.txt", [thirty], { k30: "reviewed" })])],
				[
					target("a.txt", [mod("k30b", 30, "line 30 base", "thirty")], {
						ac: mapper({
							oldStart: 30,
							oldCount: 1,
							newStart: 30,
							newCount: 1,
						}),
					}),
				],
			),
		);
		expect(r).toEqual({
			carried: [],
			reworked: new Set(["k30b"]),
			gone: [],
			absorbed: [],
		});
	});

	it("the untick guard: a human unreviewed in PS2 blocks PS1's mark; a carried state in PS2 doesn't", () => {
		const earlier = new Map([[1, { bd: IDENTITY, ac: IDENTITY }]]);
		const unticked = carryClusters(
			input(
				[
					ps(2, [source("a.txt", [two], { k2: "unreviewed" })]),
					ps(1, [source("a.txt", [two], { k2: "reviewed" })]),
				],
				[target("a.txt", [two], { earlier })],
			),
		);
		expect(unticked).toEqual({
			carried: [],
			reworked: new Set(),
			gone: [],
			absorbed: [],
		});
		const carriedBefore = carryClusters(
			input(
				[
					ps(2, [
						source("a.txt", [two], {
							k2: { state: "reviewed", carried: { from: 1, rule: "exact" } },
						}),
					]),
					ps(1, [source("a.txt", [two], { k2: "reviewed" })]),
				],
				[target("a.txt", [two], { earlier })],
			),
		);
		expect(carriedBefore.carried).toEqual([
			{ key: "k2", fromKey: "k2", from: 1, rule: "exact", state: "reviewed" },
		]);
	});

	it("an unmarked source cluster is neither carried, reworked nor gone; only the latest patch set's are gone", () => {
		const r = carryClusters(
			input(
				[
					ps(2, [source("a.txt", [two], {})]),
					ps(1, [source("a.txt", [two, thirty], { k30: "reviewed" })]),
				],
				[
					target("a.txt", [], {
						bd: mapper({ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }),
						earlier: new Map([[1, { bd: IDENTITY, ac: IDENTITY }]]),
					}),
				],
			),
		);
		expect(r).toEqual({
			carried: [],
			reworked: new Set(),
			gone: [],
			absorbed: [],
		});
	});

	it("file-level clusters carry on an equal key, else are reworked", () => {
		const bin = fileCluster("fb", "Binary file changed");
		const same = carryClusters(
			input(
				[ps(1, [source("x.png", [bin], { fb: "reviewed" })])],
				[target("x.png", [bin])],
			),
		);
		expect(same.carried).toEqual([
			{ key: "fb", fromKey: "fb", from: 1, rule: "exact", state: "reviewed" },
		]);
		const other = carryClusters(
			input(
				[ps(1, [source("x.png", [bin], { fb: "reviewed" })])],
				[target("x.png", [fileCluster("fb2", "Binary file changed")])],
			),
		);
		expect(other).toEqual({
			carried: [],
			reworked: new Set(["fb2"]),
			gone: [],
			absorbed: [],
		});
	});

	it("an earlier patch set without mappers for a file is not traced into it", () => {
		const r = carryClusters(
			input(
				[
					ps(2, [source("a.txt", [], {})]),
					ps(1, [source("a.txt", [two], { k2: "reviewed" })]),
				],
				[target("a.txt", [two])],
			),
		);
		expect(r.carried).toEqual([]);
	});

	it("interdiffPaths is advisory: a carry in an interdiff path still carries", () => {
		const r = carryClusters(
			input(
				[ps(1, [source("a.txt", [two], { k2: "reviewed" })])],
				[target("a.txt", [two])],
				["a.txt"],
			),
		);
		expect(r.carried).toHaveLength(1);
	});

	it("a traced cluster the caller marked absorbed is absorbed, not gone; never from an earlier patch set", () => {
		const traced = traceClusters({
			sources: [ps(1, [source("a.txt", [two, thirty], {})])],
			target: [target("a.txt", [two])],
		});
		const k30 = traced.find((t) => t.fromKey === "k30");
		if (!k30) throw new Error("no k30");
		k30.absorbed = true;
		const marks = ps(1, [source("a.txt", [two, thirty], { k30: "reviewed" })]);
		expect(carryTraced(traced, [marks])).toEqual({
			carried: [],
			reworked: new Set(),
			gone: [],
			absorbed: [{ fromKey: "k30", from: 1, path: "a.txt" }],
		});
		const older = carryTraced(traced, [ps(2, []), marks]);
		expect(older.absorbed).toEqual([]);
		expect(older.gone).toEqual([]);
	});

	it("traceClusters is state-free and carryTraced applies the marks of the moment", () => {
		const traced = traceClusters({
			sources: [ps(1, [source("a.txt", [two, thirty], {})])],
			target: [target("a.txt", [two])],
		});
		expect(traced).toEqual([
			{
				from: 1,
				fromKey: "k2",
				path: "a.txt",
				images: ["k2"],
				equal: true,
				rule: "exact",
			},
			{
				from: 1,
				fromKey: "k30",
				path: "a.txt",
				images: [],
				equal: false,
				rule: "exact",
			},
		]);
		const later = ps(1, [
			source("a.txt", [two, thirty], { k2: "reviewed", k30: "crossed-off" }),
		]);
		expect(carryTraced(traced, [later])).toEqual({
			carried: [
				{ key: "k2", fromKey: "k2", from: 1, rule: "exact", state: "reviewed" },
			],
			reworked: new Set(),
			gone: [{ fromKey: "k30", from: 1, path: "a.txt" }],
			absorbed: [],
		});
		// JSON-safe: what the server caches.
		expect(JSON.parse(JSON.stringify(traced))).toEqual(traced);
	});
});

// The fail-closed property: two synthetic snapshots with random edits
// between them (the tracer's property world); every carried entry names a
// target cluster whose removed and added lines equal its source's, in the
// state the source holds.
interface Step {
	gap: number;
	remove: number;
	insert: string[];
}
const lineArb = fc.constantFrom("a", "b", "c", "d", "", " a", "a ");
const fileArb = fc.array(lineArb, { minLength: 1, maxLength: 20 });
const stepsArb = fc.array(
	fc.record({
		gap: fc.integer({ min: 1, max: 4 }),
		remove: fc.integer({ min: 0, max: 3 }),
		insert: fc.array(lineArb, { maxLength: 3 }),
	}),
	{ maxLength: 6 },
);
const stateArb = fc.constantFrom<ClusterState | null>(
	"reviewed",
	"crossed-off",
	"unreviewed",
	null,
);

/** `steps` applied to `lines`: the edited file and the -U0 hunks with their lines. */
function applyScript(
	lines: readonly string[],
	steps: readonly Step[],
	atTop: boolean,
): {
	out: string[];
	hunks: (MapHunk & { removed: string[]; added: string[] })[];
} {
	const out: string[] = [];
	const hunks: (MapHunk & { removed: string[]; added: string[] })[] = [];
	let oldPos = 0;
	steps.forEach((step, i) => {
		const gap = Math.min(
			i === 0 && atTop ? 0 : step.gap,
			lines.length - oldPos,
		);
		out.push(...lines.slice(oldPos, oldPos + gap));
		oldPos += gap;
		const remove = Math.min(step.remove, lines.length - oldPos);
		if (remove + step.insert.length === 0) return;
		hunks.push({
			oldStart: remove > 0 ? oldPos + 1 : oldPos,
			oldCount: remove,
			newStart: step.insert.length > 0 ? out.length + 1 : out.length,
			newCount: step.insert.length,
			removed: lines.slice(oldPos, oldPos + remove),
			added: [...step.insert],
		});
		oldPos += remove;
		out.push(...step.insert);
	});
	out.push(...lines.slice(oldPos));
	return { out, hunks };
}

const invert = (hunks: readonly MapHunk[]): MapHunk[] =>
	hunks.map((h) => ({
		oldStart: h.newStart,
		oldCount: h.newCount,
		newStart: h.oldStart,
		newCount: h.oldCount,
	}));

/** A -U0 diff of two files by longest common subsequence, as clusters. */
function diffLines(
	a: readonly string[],
	b: readonly string[],
): (MapHunk & { removed: string[]; added: string[] })[] {
	const n = a.length;
	const m = b.length;
	const lcs: number[][] = Array.from({ length: n + 1 }, () =>
		new Array<number>(m + 1).fill(0),
	);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			(lcs[i] as number[])[j] =
				a[i] === b[j]
					? ((lcs[i + 1] as number[])[j + 1] as number) + 1
					: Math.max(
							(lcs[i + 1] as number[])[j] as number,
							(lcs[i] as number[])[j + 1] as number,
						);
		}
	}
	const hunks: (MapHunk & { removed: string[]; added: string[] })[] = [];
	let i = 0;
	let j = 0;
	let current: (MapHunk & { removed: string[]; added: string[] }) | null = null;
	const open = () => {
		if (!current) {
			current = {
				oldStart: i + 1,
				oldCount: 0,
				newStart: j + 1,
				newCount: 0,
				removed: [],
				added: [],
			};
			hunks.push(current);
		}
		return current;
	};
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) {
			current = null;
			i++;
			j++;
		} else if (
			j < m &&
			(i >= n ||
				((lcs[i] as number[])[j + 1] as number) >=
					((lcs[i + 1] as number[])[j] as number))
		) {
			const h = open();
			h.added.push(b[j] as string);
			h.newCount++;
			j++;
		} else {
			const h = open();
			h.removed.push(a[i] as string);
			h.oldCount++;
			i++;
		}
	}
	// git's convention for an empty side: the line it sits after.
	for (const h of hunks) {
		if (h.oldCount === 0) h.oldStart--;
		if (h.newCount === 0) h.newStart--;
	}
	return hunks;
}

const toClusters = (
	path: string,
	hunks: (MapHunk & { removed: string[]; added: string[] })[],
	newLines: string[],
): Cluster[] => {
	const unkeyed = hunks.map((h) => ({
		kind: "lines" as const,
		oldStart: h.oldStart,
		oldCount: h.oldCount,
		newStart: h.newStart,
		newCount: h.newCount,
		removed: h.removed,
		added: h.added,
		lines: h.removed.length + h.added.length,
	}));
	const keys = clusterKeys(path, unkeyed, newLines);
	return unkeyed.map((c, i) => ({ ...c, key: keys[i] as string }));
};

const worldArb = fc
	.record({
		base2: fileArb,
		cdSteps: stepsArb,
		cdTop: fc.boolean(),
		h1Steps: stepsArb,
		h1Top: fc.boolean(),
		b1Steps: stepsArb,
		b1Top: fc.boolean(),
		marks: fc.array(stateArb, { minLength: 12, maxLength: 12 }),
	})
	.map((w) => {
		const cd = applyScript(w.base2, w.cdSteps, w.cdTop);
		const head2 = cd.out;
		const h1 = applyScript(head2, w.h1Steps, w.h1Top);
		const b1 = applyScript(w.base2, w.b1Steps, w.b1Top);
		const sourceClusters = toClusters("f", diffLines(b1.out, h1.out), h1.out);
		const targetClusters = toClusters("f", cd.hunks, head2);
		const marks = new Map<string, SourceState>();
		sourceClusters.forEach((c, i) => {
			const s = w.marks[i % w.marks.length];
			if (s) marks.set(c.key, { state: s });
		});
		return {
			sourceClusters,
			targetClusters,
			marks,
			bd: createLineMapper(invert(h1.hunks)),
			ac: createLineMapper(invert(b1.hunks)),
		};
	});

describe("carry property", () => {
	it("every carried entry's target cluster has the source's removed and added lines and state", () => {
		fc.assert(
			fc.property(worldArb, (w) => {
				const sources = [
					ps(1, [{ path: "f", clusters: w.sourceClusters, states: w.marks }]),
				];
				const targets = [
					{ path: "f", clusters: w.targetClusters, bd: w.bd, ac: w.ac },
				];
				const r = carryClusters(input(sources, targets));
				const byKey = (cs: Cluster[]) => new Map(cs.map((c) => [c.key, c]));
				const srcBy = byKey(w.sourceClusters);
				const tgtBy = byKey(w.targetClusters);
				const seen = new Set<string>();
				for (const c of r.carried) {
					const s = srcBy.get(c.fromKey);
					const t = tgtBy.get(c.key);
					expect(s).toBeDefined();
					expect(t).toBeDefined();
					expect(t?.removed).toEqual(s?.removed);
					expect(t?.added).toEqual(s?.added);
					expect(w.marks.get(c.fromKey)?.state).toBe(c.state);
					expect(c.state).not.toBe("unreviewed");
					expect(seen.has(c.key)).toBe(false);
					seen.add(c.key);
					expect(r.reworked.has(c.key)).toBe(false);
				}
				for (const g of r.gone) {
					expect(["reviewed", "crossed-off"]).toContain(
						w.marks.get(g.fromKey)?.state,
					);
				}
				// Deterministic.
				expect(carryClusters(input(sources, targets))).toEqual(r);
			}),
		);
	});
});
