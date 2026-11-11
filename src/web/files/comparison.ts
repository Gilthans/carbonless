import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "../../shared/types";
import type { ReviewTarget } from "../api";
import { usePageActive } from "../pageActive";
import { useReviewId } from "../reviewId";
import { type FilesSearch, parseFilesSearch } from "./landing";

/**
 * The comparison the Files page shows (the patch set graph's two markers):
 * the viewed dot, a patch set of the reviewer's or the PR's head (the
 * snapshot of that commit, not yet a patch set), and the comparison base,
 * the base branch (the full diff) or an earlier patch set (the interdiff
 * since it). In the address as `ps=<n>` | `head=<oid>` and `from=<n>` |
 * `from=branch`, so a reload and a shared link land on the same view.
 */
export type Viewing =
	| { kind: "patchset"; number: number }
	| { kind: "head"; oid: string };
export type ComparisonBase =
	| { kind: "branch" }
	| { kind: "patchset"; number: number };

export interface Comparison {
	/** Null until the session is known (nothing to compare yet). */
	viewing: Viewing | null;
	base: ComparisonBase;
	/** The review to show: the session's own, an earlier patch set's, or a head's. */
	target: ReviewTarget;
	/** The patch set numbers, in order (the dots between the branch and the head). */
	patchsets: number[];
	/** The reviewer put the base where it is (`from` in the address). */
	baseChosen: boolean;
	setViewing(v: Viewing): void;
	setBase(b: ComparisonBase): void;
	/** Both markers at once (moveMarker's answer). */
	set(v: Viewing, b: ComparisonBase): void;
}

export type ComparisonSearch = Pick<FilesSearch, "ps" | "head" | "from">;

/**
 * A dot's place on the rail: the branch is 0, patch set n is n, and the
 * head comes after the newest patch set.
 */
export function positionOf(
	dot: Viewing | ComparisonBase,
	patchsets: readonly number[],
): number {
	if (dot.kind === "branch") return 0;
	if (dot.kind === "patchset") return dot.number;
	return (patchsets.at(-1) ?? 0) + 1;
}

/** The dot before `viewing`: the newest patch set left of it, else the branch. */
export function defaultBase(
	viewing: Viewing,
	patchsets: readonly number[],
): ComparisonBase {
	const at = positionOf(viewing, patchsets);
	const previous = patchsets.filter((n) => n < at).at(-1);
	return previous === undefined
		? { kind: "branch" }
		: { kind: "patchset", number: previous };
}

const sameBase = (a: ComparisonBase, b: ComparisonBase) =>
	a.kind === "branch"
		? b.kind === "branch"
		: b.kind === "patchset" && a.number === b.number;

/**
 * Where the comparison base goes when the comparison target moves (the owner's
 * rule, 2026-11-04): on the branch dot it stays; on the previous patch set
 * it follows by one (it stays "the previous"); anywhere else it is
 * remembered, unless that would put it on or after the viewed dot, when
 * it falls back to the previous one.
 */
export function nextBase(
	prev: { viewing: Viewing; base: ComparisonBase },
	viewing: Viewing,
	patchsets: readonly number[],
): ComparisonBase {
	if (prev.base.kind === "branch") return prev.base;
	const previous = defaultBase(viewing, patchsets);
	if (sameBase(prev.base, defaultBase(prev.viewing, patchsets)))
		return previous;
	return positionOf(prev.base, patchsets) < positionOf(viewing, patchsets)
		? prev.base
		: previous;
}

/**
 * The comparison the address names, against what the session knows: an
 * unknown patch set, or a head that is a patch set's, is read as that
 * patch set; a base not left of the viewed dot is the default one.
 */
export function parseComparison(
	search: ComparisonSearch,
	session: SessionInfo | undefined,
): { viewing: Viewing | null; base: ComparisonBase } {
	if (!session) return { viewing: null, base: { kind: "branch" } };
	const patchsets = session.patchsets.map((p) => p.number);
	const latest = patchsets.at(-1);
	let viewing: Viewing;
	const asPatchset = search.head
		? session.patchsets.find((p) => p.head === search.head)
		: undefined;
	if (asPatchset) viewing = { kind: "patchset", number: asPatchset.number };
	else if (search.head) viewing = { kind: "head", oid: search.head };
	else if (search.ps !== undefined && patchsets.includes(search.ps)) {
		viewing = { kind: "patchset", number: search.ps };
	} else if (latest !== undefined)
		viewing = { kind: "patchset", number: latest };
	else viewing = { kind: "head", oid: session.snapshotHead };
	let base = defaultBase(viewing, patchsets);
	if (search.from === "branch") base = { kind: "branch" };
	else if (
		typeof search.from === "number" &&
		patchsets.includes(search.from) &&
		search.from < positionOf(viewing, patchsets)
	) {
		base = { kind: "patchset", number: search.from };
	}
	return { viewing, base };
}

/**
 * The base once the comparison target moves to `viewing`: by nextBase when
 * the reviewer put it somewhere (`chosen`: `from` in the address), else
 * the new default (a base left where it was by default was never
 * "chosen": it keeps being the previous dot). Either way it ends left of
 * `viewing`.
 */
function baseAfterTarget(
	prev: { viewing: Viewing; base: ComparisonBase },
	viewing: Viewing,
	patchsets: readonly number[],
	chosen: boolean,
): ComparisonBase {
	return chosen
		? nextBase(prev, viewing, patchsets)
		: defaultBase(viewing, patchsets);
}

/** The params after the comparison target moves to `viewing` (baseAfterTarget). */
export function movedSearch(
	current: ComparisonSearch,
	prev: { viewing: Viewing; base: ComparisonBase },
	viewing: Viewing,
	patchsets: readonly number[],
): ComparisonSearch {
	const base = baseAfterTarget(
		prev,
		viewing,
		patchsets,
		current.from !== undefined,
	);
	return comparisonSearch(viewing, base, patchsets);
}

/** A dot of the patch set graph, left to right, as the markers see it. */
export interface RailStop {
	/** The comparison target it can be (none for the branch). */
	viewing?: Viewing;
	/** The comparison base it can be (none for a head or a snapshot). */
	base?: ComparisonBase;
}

/** Why a dot's Comparison Base or Comparison Target is disabled. */
export const MOVE_REASONS = {
	alreadyBase: "Already the comparison base",
	alreadyTarget: "Already the comparison target",
	rightmost: "Nothing right of it for the comparison target",
	leftmost: "Nothing left of it for the comparison base",
	notBase: "Only the branch or a patch set can be the comparison base",
} as const;

const sameViewingOf = (a: Viewing | undefined, b: Viewing) =>
	!!a &&
	(a.kind === "patchset"
		? b.kind === "patchset" && a.number === b.number
		: b.kind === "head" && a.oid === b.oid);

/**
 * The comparison after giving the dot at `at` a role (its Comparison Base
 * or Comparison Target; the owner, 2026-11-09): the markers move together
 * and never cross or stack. A base on or right of the target pushes the
 * target to the dot just right of it; a target on or left of the base
 * pushes the base to the dot just left of it (baseAfterTarget, which also
 * keeps nextBase's rule otherwise). Disabled, with the reason, on the dot
 * that already has the role, a base on the rightmost dot, a target on the
 * leftmost (the branch), and a base on a dot that can't be one.
 */
export function moveMarker(
	role: "base" | "target",
	at: number,
	rail: readonly RailStop[],
	current: { viewing: Viewing; base: ComparisonBase; baseChosen: boolean },
): { viewing: Viewing; base: ComparisonBase } | { disabled: string } {
	const stop = rail[at];
	const patchsets = rail.flatMap((s) =>
		s.base?.kind === "patchset" ? [s.base.number] : [],
	);
	if (role === "target") {
		if (!stop?.viewing) return { disabled: MOVE_REASONS.leftmost };
		if (sameViewingOf(stop.viewing, current.viewing))
			return { disabled: MOVE_REASONS.alreadyTarget };
		return {
			viewing: stop.viewing,
			base: baseAfterTarget(
				current,
				stop.viewing,
				patchsets,
				current.baseChosen,
			),
		};
	}
	if (stop?.base && sameBase(stop.base, current.base))
		return { disabled: MOVE_REASONS.alreadyBase };
	if (at >= rail.length - 1) return { disabled: MOVE_REASONS.rightmost };
	if (!stop?.base) return { disabled: MOVE_REASONS.notBase };
	const target = rail.findIndex((s) =>
		sameViewingOf(s.viewing, current.viewing),
	);
	if (at < target) return { viewing: current.viewing, base: stop.base };
	const next = rail[at + 1]?.viewing;
	if (!next) return { disabled: MOVE_REASONS.rightmost };
	return { viewing: next, base: stop.base };
}

/** The address's params for a comparison; `from` only when it isn't the default. */
export function comparisonSearch(
	viewing: Viewing,
	base: ComparisonBase,
	patchsets: readonly number[],
): ComparisonSearch {
	const out: ComparisonSearch = {};
	if (viewing.kind === "patchset") out.ps = viewing.number;
	else out.head = viewing.oid;
	if (!sameBase(base, defaultBase(viewing, patchsets))) {
		out.from = base.kind === "branch" ? "branch" : base.number;
	}
	return out;
}

/**
 * Which review `viewing` is: the session's own (the latest patch set, or
 * the snapshot's head before any patch set), else that patch set's or
 * that head's (GET /review?patchset= | ?head=).
 */
export function reviewTargetOf(
	viewing: Viewing | null,
	session: SessionInfo | undefined,
): ReviewTarget {
	if (!viewing || !session) return { kind: "current" };
	if (viewing.kind === "patchset") {
		return viewing.number === session.patchsets.at(-1)?.number
			? { kind: "current" }
			: viewing;
	}
	return session.patchsets.length === 0 && viewing.oid === session.snapshotHead
		? { kind: "current" }
		: viewing;
}

const hasComparison = (s: ComparisonSearch) =>
	s.ps !== undefined || s.head !== undefined || s.from !== undefined;

/**
 * The page's comparison (see Comparison). The address is read whenever it
 * names one; a move writes it (replacing the entry, the scroll kept). The
 * page stays mounted behind the other tabs, whose addresses name none, so
 * the last comparison is kept and written back when the page shows again.
 */
export function useComparison(session: SessionInfo | undefined): Comparison {
	const raw = useSearch({ strict: false }) as Record<string, unknown>;
	const { ps, head, from } = parseFilesSearch(raw);
	// The comparison the address names (by value: the three params).
	const inAddress = useMemo(() => pick({ ps, head, from }), [ps, head, from]);
	const active = usePageActive();
	const navigate = useNavigate();
	const id = useReviewId();
	// The last comparison named by the address (or set here), as params.
	const [kept, setKept] = useState<ComparisonSearch>(inAddress);
	const fromAddress = active && hasComparison(inAddress);
	const named = fromAddress ? inAddress : kept;
	const latestKept = useRef(kept);
	latestKept.current = kept;
	useEffect(() => {
		if (fromAddress && !sameSearch(latestKept.current, inAddress)) {
			setKept(inAddress);
		}
	}, [fromAddress, inAddress]);
	const parsed = parseComparison(named, session);
	const patchsets = session?.patchsets.map((p) => p.number) ?? [];
	const go = useCallback(
		(next: ComparisonSearch) => {
			setKept(next);
			void navigate({
				to: "/r/$id/files",
				params: { id },
				search: (prev: Record<string, unknown>) => ({
					...withoutComparison(prev),
					...next,
				}),
				replace: true,
				resetScroll: false,
			});
		},
		[navigate, id],
	);
	// Back on the page from another tab: its address names the kept view again.
	useEffect(() => {
		if (!active || hasComparison(inAddress) || !hasComparison(kept)) return;
		go(kept);
	}, [active, kept, go, inAddress]);
	const { viewing, base } = parsed;
	// A viewed head that became a patch set (the first mark started it):
	// the address names the patch set from now on. Keyed by value, so the
	// one navigation it makes doesn't run it again.
	const started =
		inAddress.head !== undefined && viewing?.kind === "patchset"
			? comparisonSearch(viewing, base, patchsets)
			: null;
	const startedKey = started ? JSON.stringify(started) : null;
	useEffect(() => {
		if (!active || startedKey === null) return;
		go(JSON.parse(startedKey) as ComparisonSearch);
	}, [active, startedKey, go]);
	return {
		viewing,
		base,
		target: reviewTargetOf(viewing, session),
		patchsets,
		baseChosen: named.from !== undefined,
		setViewing: (v) => {
			if (!viewing) return;
			go(movedSearch(named, { viewing, base }, v, patchsets));
		},
		setBase: (b) => {
			if (!viewing) return;
			go(comparisonSearch(viewing, b, patchsets));
		},
		set: (v, b) => go(comparisonSearch(v, b, patchsets)),
	};
}

function pick(s: FilesSearch): ComparisonSearch {
	const out: ComparisonSearch = {};
	if (s.ps !== undefined) out.ps = s.ps;
	if (s.head !== undefined) out.head = s.head;
	if (s.from !== undefined) out.from = s.from;
	return out;
}

const sameSearch = (a: ComparisonSearch, b: ComparisonSearch) =>
	a.ps === b.ps && a.head === b.head && a.from === b.from;

function withoutComparison(
	prev: Record<string, unknown>,
): Record<string, unknown> {
	const { ps: _ps, head: _head, from: _from, ...rest } = prev;
	return rest;
}
