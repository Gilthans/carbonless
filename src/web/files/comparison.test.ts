import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../shared/types";
import {
	type ComparisonBase,
	comparisonSearch,
	defaultBase,
	MOVE_REASONS,
	movedSearch,
	moveMarker,
	nextBase,
	parseComparison,
	type RailStop,
	reviewTargetOf,
	type Viewing,
} from "./comparison";

const oid = (c: string) => c.repeat(40);

const patchset = (number: number, head: string) => ({
	number,
	head,
	mergeBase: oid("0"),
	baseBranch: "main",
	startedAt: 1,
	since: number === 1 ? null : number - 1,
	shape: null,
	commits: number,
});

const session = (
	patchsets: number[],
	head: string | null = null,
): SessionInfo => ({
	pr: { owner: "acme", repo: "widget", number: 7, title: "T", url: "" },
	viewer: "octo",
	snapshotHead: patchsets.length ? oid(String(patchsets.at(-1))) : oid("a"),
	currentHead: head ?? oid("a"),
	headMoved: false,
	patchset: patchsets.at(-1) ?? null,
	asOf: null,
	pinnedHead: null,
	patchsets: patchsets.map((n) => patchset(n, oid(String(n)))),
	lastSeen: null,
	head: head
		? { oid: head, mergeBase: oid("0"), baseBranch: "main", commits: 1 }
		: null,
});

const ps = (number: number): Viewing => ({ kind: "patchset", number });
const head = (o: string): Viewing => ({ kind: "head", oid: o });
const branch: ComparisonBase = { kind: "branch" };
const from = (number: number): ComparisonBase => ({ kind: "patchset", number });

describe("defaultBase", () => {
	it("is the previous patch set, else the branch", () => {
		expect(defaultBase(ps(1), [1, 2, 3])).toEqual(branch);
		expect(defaultBase(ps(2), [1, 2, 3])).toEqual(from(1));
		expect(defaultBase(ps(3), [1, 2, 3])).toEqual(from(2));
		// The head sits after the newest patch set.
		expect(defaultBase(head(oid("f")), [1, 2, 3])).toEqual(from(3));
		expect(defaultBase(head(oid("f")), [])).toEqual(branch);
	});
});

describe("nextBase", () => {
	const all = [1, 2, 3];
	it("stays on the branch dot", () => {
		expect(nextBase({ viewing: ps(2), base: branch }, ps(3), all)).toEqual(
			branch,
		);
		expect(
			nextBase({ viewing: ps(2), base: branch }, head(oid("f")), all),
		).toEqual(branch);
	});
	it("follows by one from the previous patch set", () => {
		expect(nextBase({ viewing: ps(2), base: from(1) }, ps(3), all)).toEqual(
			from(2),
		);
		expect(
			nextBase({ viewing: ps(3), base: from(2) }, head(oid("f")), all),
		).toEqual(from(3));
		// Backwards too: the previous of PS1 is the branch.
		expect(nextBase({ viewing: ps(2), base: from(1) }, ps(1), all)).toEqual(
			branch,
		);
	});
	it("remembers any other patch set", () => {
		expect(nextBase({ viewing: ps(3), base: from(1) }, ps(2), all)).toEqual(
			from(1),
		);
		expect(
			nextBase({ viewing: ps(3), base: from(1) }, head(oid("f")), all),
		).toEqual(from(1));
	});
	it("never lands on or after the viewed dot: then the previous", () => {
		// Remembered PS2, viewing moves back to PS2: the base can't stay there.
		expect(
			nextBase({ viewing: head(oid("f")), base: from(2) }, ps(2), all),
		).toEqual(from(1));
		expect(
			nextBase({ viewing: head(oid("f")), base: from(2) }, ps(1), all),
		).toEqual(branch);
	});
});

describe("parseComparison", () => {
	it("defaults to the latest patch set over the previous one", () => {
		expect(parseComparison({}, session([1, 2]))).toEqual({
			viewing: ps(2),
			base: from(1),
		});
		expect(parseComparison({}, session([1]))).toEqual({
			viewing: ps(1),
			base: branch,
		});
	});
	it("views the snapshot's head when there is no patch set", () => {
		expect(parseComparison({}, session([]))).toEqual({
			viewing: head(oid("a")),
			base: branch,
		});
		expect(parseComparison({}, undefined)).toEqual({
			viewing: null,
			base: branch,
		});
	});
	it("reads ps, head and from", () => {
		const s = session([1, 2, 3], oid("f"));
		expect(parseComparison({ ps: 2 }, s)).toEqual({
			viewing: ps(2),
			base: from(1),
		});
		expect(parseComparison({ ps: 2, from: "branch" }, s)).toEqual({
			viewing: ps(2),
			base: branch,
		});
		expect(parseComparison({ ps: 3, from: 1 }, s)).toEqual({
			viewing: ps(3),
			base: from(1),
		});
		expect(parseComparison({ head: oid("f") }, s)).toEqual({
			viewing: head(oid("f")),
			base: from(3),
		});
	});
	it("a head that is a patch set's is that patch set", () => {
		const s = session([1, 2], oid("f"));
		expect(parseComparison({ head: oid("1") }, s)).toEqual({
			viewing: ps(1),
			base: branch,
		});
	});
	it("drops an unknown patch set, and a base not left of the viewed dot", () => {
		const s = session([1, 2, 3]);
		expect(parseComparison({ ps: 9 }, s).viewing).toEqual(ps(3));
		expect(parseComparison({ ps: 2, from: 2 }, s).base).toEqual(from(1));
		expect(parseComparison({ ps: 2, from: 3 }, s).base).toEqual(from(1));
		expect(parseComparison({ ps: 2, from: 9 }, s).base).toEqual(from(1));
	});
});

describe("movedSearch", () => {
	const all = [1, 2, 3];
	it("a base left at its default keeps being the previous dot", () => {
		// PS1 over the branch (nothing else possible), then the head: since PS3.
		expect(
			movedSearch(
				{ ps: 1 },
				{ viewing: ps(1), base: branch },
				head(oid("f")),
				all,
			),
		).toEqual({ head: oid("f") });
		expect(
			movedSearch({ ps: 3 }, { viewing: ps(3), base: from(2) }, ps(2), all),
		).toEqual({ ps: 2 });
	});
	it("a base the reviewer put on the branch stays there", () => {
		expect(
			movedSearch(
				{ ps: 2, from: "branch" },
				{ viewing: ps(2), base: branch },
				head(oid("f")),
				all,
			),
		).toEqual({ head: oid("f"), from: "branch" });
	});
	it("a base the reviewer put on an earlier patch set is remembered", () => {
		expect(
			movedSearch(
				{ ps: 3, from: 1 },
				{ viewing: ps(3), base: from(1) },
				head(oid("f")),
				all,
			),
		).toEqual({ head: oid("f"), from: 1 });
		// Unless it would sit on or after the viewed dot.
		expect(
			movedSearch(
				{ ps: 3, from: 1 },
				{ viewing: ps(3), base: from(1) },
				ps(1),
				all,
			),
		).toEqual({ ps: 1 });
	});
});

describe("moveMarker", () => {
	const H = oid("f");
	/** branch, PS1, PS2, PS3, then the head when `withHead`. */
	const rail = (withHead = true): RailStop[] => [
		{ base: branch },
		...[1, 2, 3].map((n) => ({ viewing: ps(n), base: from(n) })),
		...(withHead ? [{ viewing: head(H) }] : []),
	];
	const at = (r: RailStop[], v: Viewing | ComparisonBase) =>
		r.findIndex((s) =>
			v.kind === "branch"
				? s.base?.kind === "branch"
				: v.kind === "head"
					? s.viewing?.kind === "head" && s.viewing.oid === v.oid
					: s.viewing?.kind === "patchset" && s.viewing.number === v.number,
		);
	const cur = (viewing: Viewing, base: ComparisonBase, baseChosen = true) => ({
		viewing,
		base,
		baseChosen,
	});

	describe("Comparison Base (the comparison target on PS2, the base on PS1)", () => {
		const now = cur(ps(2), from(1));
		const on = (dot: Viewing | ComparisonBase, r = rail()) =>
			moveMarker("base", at(r, dot), r, now);
		it("left of the target, at the left end: the base moves, the target stays", () => {
			expect(on(branch)).toEqual({ viewing: ps(2), base: branch });
		});
		it("on its own dot: disabled", () => {
			expect(on(ps(1))).toEqual({ disabled: MOVE_REASONS.alreadyBase });
		});
		it("on the target: the target moves to the dot just right of it", () => {
			expect(on(ps(2))).toEqual({ viewing: ps(3), base: from(2) });
		});
		it("right of the target: the target sits just right of it, the head too (an explicit press)", () => {
			expect(on(ps(3))).toEqual({ viewing: head(H), base: from(3) });
		});
		it("at the right end (the head, or the newest patch set when up to date): disabled", () => {
			expect(on(head(H))).toEqual({ disabled: MOVE_REASONS.rightmost });
			expect(on(ps(3), rail(false))).toEqual({
				disabled: MOVE_REASONS.rightmost,
			});
		});
		it("a snapshot dot that isn't the right end can't be a base", () => {
			const S = oid("e");
			const r: RailStop[] = [
				...rail(false),
				{ viewing: head(S) },
				{ viewing: head(H) },
			];
			expect(moveMarker("base", 4, r, cur(head(S), from(3), false))).toEqual({
				disabled: MOVE_REASONS.notBase,
			});
		});
	});

	describe("Comparison Target (the target on PS3, the base on PS2)", () => {
		const on = (dot: Viewing | ComparisonBase, chosen = true, r = rail()) =>
			moveMarker("target", at(r, dot), r, cur(ps(3), from(2), chosen));
		it("at the left end (the branch): disabled", () => {
			expect(on(branch)).toEqual({ disabled: MOVE_REASONS.leftmost });
		});
		it("left of the base: the base sits just left of it", () => {
			expect(on(ps(1))).toEqual({ viewing: ps(1), base: branch });
		});
		it("on the base: the base moves to the dot just left of it", () => {
			expect(on(ps(2))).toEqual({ viewing: ps(2), base: from(1) });
			expect(on(ps(2), false)).toEqual({ viewing: ps(2), base: from(1) });
		});
		it("on its own dot: disabled", () => {
			expect(on(ps(3))).toEqual({ disabled: MOVE_REASONS.alreadyTarget });
		});
		it("right of the base, at the right end: the base stays where it was put (nextBase)", () => {
			// A base left at its default (the previous dot) keeps being that.
			expect(on(head(H), false)).toEqual({ viewing: head(H), base: from(3) });
			// One put further back is remembered.
			const r = rail();
			expect(
				moveMarker("target", r.length - 1, r, cur(ps(3), from(1))),
			).toEqual({ viewing: head(H), base: from(1) });
		});
	});

	it("never crosses or stacks the markers, from any comparison, for either role on any dot", () => {
		// With the head, up to date, and with a snapshot dot before the head.
		const snapshot: RailStop[] = [
			...rail(false),
			{ viewing: head(oid("e")) },
			{ viewing: head(H) },
		];
		for (const r of [rail(true), rail(false), snapshot]) {
			for (let t = 1; t < r.length; t++) {
				for (let b = 0; b < t; b++) {
					const viewing = r[t]?.viewing as Viewing;
					const base = r[b]?.base;
					if (!base) continue;
					for (const chosen of [true, false]) {
						for (const role of ["base", "target"] as const) {
							for (let i = 0; i < r.length; i++) {
								const got = moveMarker(role, i, r, {
									viewing,
									base,
									baseChosen: chosen,
								});
								if ("disabled" in got) continue;
								expect(at(r, got.base)).toBeLessThan(at(r, got.viewing));
								// The pressed dot has the role it was given.
								expect(at(r, role === "base" ? got.base : got.viewing)).toBe(i);
							}
						}
					}
				}
			}
		}
	});
});

describe("comparisonSearch", () => {
	const all = [1, 2, 3];
	it("writes the viewed dot, and the base only when it isn't the default", () => {
		expect(comparisonSearch(ps(3), from(2), all)).toEqual({ ps: 3 });
		expect(comparisonSearch(ps(3), from(1), all)).toEqual({ ps: 3, from: 1 });
		expect(comparisonSearch(ps(3), branch, all)).toEqual({
			ps: 3,
			from: "branch",
		});
		expect(comparisonSearch(head(oid("f")), from(3), all)).toEqual({
			head: oid("f"),
		});
		expect(comparisonSearch(ps(1), branch, all)).toEqual({ ps: 1 });
	});
	it("round-trips through parseComparison", () => {
		const s = session(all, oid("f"));
		for (const [viewing, base] of [
			[ps(3), from(1)],
			[ps(2), branch],
			[head(oid("f")), from(1)],
			[head(oid("f")), branch],
			[ps(1), branch],
		] as [Viewing, ComparisonBase][]) {
			expect(parseComparison(comparisonSearch(viewing, base, all), s)).toEqual({
				viewing,
				base,
			});
		}
	});
});

describe("reviewTargetOf", () => {
	it("the latest patch set is the session's own review", () => {
		expect(reviewTargetOf(ps(2), session([1, 2]))).toEqual({
			kind: "current",
		});
		expect(reviewTargetOf(ps(1), session([1, 2]))).toEqual({
			kind: "patchset",
			number: 1,
		});
	});
	it("the snapshot's head without a patch set is the session's own review", () => {
		expect(reviewTargetOf(head(oid("a")), session([]))).toEqual({
			kind: "current",
		});
		expect(reviewTargetOf(head(oid("f")), session([], oid("f")))).toEqual({
			kind: "head",
			oid: oid("f"),
		});
		expect(reviewTargetOf(head(oid("f")), session([1], oid("f")))).toEqual({
			kind: "head",
			oid: oid("f"),
		});
		expect(reviewTargetOf(null, undefined)).toEqual({ kind: "current" });
	});
});
