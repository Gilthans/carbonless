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
	setViewing(v: Viewing): void;
	setBase(b: ComparisonBase): void;
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
 * Where the comparison base goes when the viewing marker moves (the owner's
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
 * The params after the viewing marker moves to `viewing`: the base by
 * nextBase when the reviewer put it somewhere (`from` in the address),
 * else the new default (a base left where it was by default was never
 * "chosen": it keeps being the previous dot).
 */
export function movedSearch(
	current: ComparisonSearch,
	prev: { viewing: Viewing; base: ComparisonBase },
	viewing: Viewing,
	patchsets: readonly number[],
): ComparisonSearch {
	const base =
		current.from === undefined
			? defaultBase(viewing, patchsets)
			: nextBase(prev, viewing, patchsets);
	return comparisonSearch(viewing, base, patchsets);
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
	return {
		viewing,
		base,
		target: reviewTargetOf(viewing, session),
		patchsets,
		setViewing: (v) => {
			if (!viewing) return;
			go(movedSearch(named, { viewing, base }, v, patchsets));
		},
		setBase: (b) => {
			if (!viewing) return;
			go(comparisonSearch(viewing, b, patchsets));
		},
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
