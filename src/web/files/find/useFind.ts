import {
	type QueryObserverResult,
	useQueries,
	useQueryClient,
} from "@tanstack/react-query";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type {
	DiffLine,
	DiffSide,
	FileHunks,
	FileView,
} from "../../../shared/types";
import { contextQuery, hunksQuery } from "../../api";
import type { FindMark } from "../../code/Invisibles";
import { matchCase as matchCaseSetting } from "../../viewSettings";
import { contextRanges } from "../contextRanges";
import type { DiffFind } from "../DiffBody";
import type { TreeFind } from "../FileTree";
import {
	type Caret,
	caretAfterTyping,
	countsByFile,
	findInPr,
	type Hit,
	hitIndex,
	samePos,
	stepCaret,
} from "./findInPr";
import { type FindState, findState } from "./findState";
import {
	HunksPrefetcher,
	type PrefetchSnapshot,
	prefetchOrder,
} from "./hunksPrefetch";
import { headerPathMarks, nameMarks, oldNameMarks } from "./pathMarks";

/** What Files changed needs from the search, for the files of `revision` in tree order. */
export interface Find {
	state: FindState;
	hits: Hit[];
	/** The caret: a step's, while its hit still exists, else caretAfterTyping's (unshown). Null with no hits. */
	caret: Caret | null;
	count: { at: number; of: number } | null;
	searching: boolean;
	failed: number;
	retry: () => void;
	/** Moves the caret (stepCaret) and returns the hit stepped to, or null. */
	step: (dir: 1 | -1) => Hit | null;
	matchCase: boolean;
	setMatchCase: (on: boolean) => void;
	/** Per-file views, built once per hits/caret change. */
	tree: TreeFind;
	diffOf: (index: number) => DiffFind | undefined;
	pathOf: (index: number) => readonly FindMark[];
	/** Bumps a file's DiffFind.stepSeq (a line hit stepped to). */
	stepInto: (index: number) => void;
}

const NO_HITS: Hit[] = [];
const NO_MARKS: readonly FindMark[] = [];
const NO_LINES: readonly DiffLine[] = [];
const IDLE: PrefetchSnapshot = { pending: 0, failed: [] };
const noSubscribe = () => () => {};

/** Stable across renders while the results are (useQueries runs a stable combine only on change). */
const hunksData = (results: QueryObserverResult<FileHunks>[]) => ({
	data: results.map((r) => r.data),
	/** Some file's own request is out (the open file's diff asked): the prefetch skips it. */
	fetching: results.some((r) => r.fetchStatus === "fetching"),
	/** Per file: its request failed and nothing came. */
	failed: results.map((r) => r.status === "error" && r.data === undefined),
});
const contextData = (results: QueryObserverResult<DiffLine[]>[]) => ({
	data: results.map((r) => r.data),
	/** Per range: not answered yet (never asked, dropped, or on its way). */
	waiting: results.map((r) => r.status === "pending"),
	/** Per range: its request failed and nothing came. */
	failed: results.map((r) => r.status === "error" && r.data === undefined),
});

/**
 * The Find in PR search over Files changed: the hits (paths and changed
 * lines at once, context lines as each file's hunks arrive), the caret, the
 * hunk prefetch while the bar is open, and the per-file views the tree,
 * headers and diffs paint. Typing never moves anything: only `step` (and
 * the page acting on what it returns) does.
 */
export function useFind(opts: {
	revision: string | undefined;
	/** The page's files in tree order. */
	files: readonly FileView[];
	openIndex: number | null;
	/** The page shows (a hidden page runs no prefetch). */
	active: boolean;
	/**
	 * A hunks request answered 409 (the revision is gone: another tab or
	 * device refreshed): read the review again, so the page moves to the new
	 * revision and the prefetch starts over for it.
	 */
	onStale?: () => void;
}): Find {
	const { revision, files, openIndex, active } = opts;
	const onStale = useRef(opts.onStale);
	onStale.current = opts.onStale;
	const state = findState.use();
	const matchCase = matchCaseSetting.use();
	const client = useQueryClient();
	const { open, term } = state;
	const searchOn = open && revision !== undefined;

	// Every file's hunks and expanded context, observed while the bar is open.
	// Hunks are fetched by the prefetch and the open file's diff; an expanded
	// range that isn't loaded (dropped while the bar was closed) is fetched
	// below.
	const hunks = useQueries({
		queries: searchOn
			? files.map((f) => ({ ...hunksQuery(revision, f.index), enabled: false }))
			: [],
		combine: hunksData,
	});
	const allRanges = contextRanges.useAll(revision ?? "");
	const ranges = useMemo(
		() =>
			searchOn
				? files.flatMap((f) =>
						(allRanges.get(f.index) ?? []).map(([from, to]) => ({
							index: f.index,
							from,
							to,
						})),
					)
				: [],
		[searchOn, files, allRanges],
	);
	const context = useQueries({
		queries: ranges.map((r) => ({
			...contextQuery(revision ?? "", r.index, r.from, r.to),
			enabled: false,
		})),
		combine: contextData,
	});

	const hits = useMemo(() => {
		if (!searchOn || term === "") return NO_HITS;
		const hunksBy = new Map<number, FileHunks | undefined>();
		files.forEach((f, i) => {
			hunksBy.set(f.index, hunks.data[i]);
		});
		const contextBy = new Map<number, DiffLine[]>();
		ranges.forEach((r, i) => {
			const lines = context.data[i];
			if (!lines) return;
			contextBy.set(r.index, [...(contextBy.get(r.index) ?? []), ...lines]);
		});
		return findInPr(
			term,
			files,
			(f) => hunksBy.get(f.index),
			(f) => contextBy.get(f.index) ?? NO_LINES,
			matchCase,
		);
	}, [searchOn, term, matchCase, files, hunks, ranges, context]);

	// The caret. Typing (a new term, match case, a reopen, a new revision)
	// starts over from the file open at that moment: a pick in the tree
	// later doesn't move it. A step's caret holds until the next typing.
	const typingKey = `${open}\0${term}\0${matchCase}\0${revision}`;
	const [typed, setTyped] = useState({ key: typingKey, openIndex });
	if (typed.key !== typingKey) setTyped({ key: typingKey, openIndex });
	const typedOpen = typed.key === typingKey ? typed.openIndex : openIndex;
	const [stepped, setStepped] = useState<{
		key: string;
		caret: Caret | null;
	} | null>(null);
	const order = useMemo(() => files.map((f) => f.index), [files]);
	const caret = useMemo(() => {
		if (
			stepped?.key === typingKey &&
			stepped.caret &&
			hitIndex(hits, stepped.caret.pos) >= 0
		)
			return stepped.caret;
		return caretAfterTyping(hits, order, typedOpen);
	}, [stepped, typingKey, hits, order, typedOpen]);
	// Steps read the latest, also two in one frame.
	const latest = useRef({ hits, caret, typingKey });
	latest.current = { hits, caret, typingKey };
	const step = useCallback((dir: 1 | -1): Hit | null => {
		const now = latest.current;
		const next = stepCaret(now.hits, now.caret, dir);
		if (!next) return null;
		latest.current = { ...now, caret: next };
		setStepped({ key: now.typingKey, caret: next });
		return now.hits.find((h) => samePos(h, next.pos)) ?? null;
	}, []);

	// The step into a file's lines: a value never used before, and only for
	// the file it was taken in while that file stays open, so a file opened
	// again later (its diff mounted anew) never takes an old step again.
	const stepCount = useRef(0);
	const [lastStep, setLastStep] = useState<{
		index: number;
		seq: number;
	} | null>(null);
	if (lastStep && lastStep.index !== openIndex) setLastStep(null);
	const stepInto = useCallback((index: number) => {
		stepCount.current += 1;
		setLastStep({ index, seq: stepCount.current });
	}, []);

	// The prefetch: while the bar is open on a page that shows, for its revision.
	const filesRef = useRef(files);
	filesRef.current = files;
	const openRef = useRef(openIndex);
	openRef.current = openIndex;
	// Kept with its revision: on the render where the revision changes, the
	// old one (done) is still in state until the effect runs, and must count
	// as not started yet, never as a final answer.
	const [started, setStarted] = useState<{
		p: HunksPrefetcher;
		revision: string;
	} | null>(null);
	const prefetcher =
		started && started.revision === revision ? started.p : null;
	useEffect(() => {
		if (!open || revision === undefined || !active) return;
		const p = new HunksPrefetcher(client, revision, undefined, () =>
			onStale.current?.(),
		);
		setStarted({ p, revision });
		p.queue(prefetchOrder(filesRef.current, openRef.current));
		return () => {
			p.stop();
			setStarted(null);
		};
	}, [open, revision, active, client]);
	const subscribe = useMemo(
		() =>
			prefetcher ? (f: () => void) => prefetcher.subscribe(f) : noSubscribe,
		[prefetcher],
	);
	const snapshot = useSyncExternalStore(subscribe, () =>
		prefetcher ? prefetcher.snapshot() : IDLE,
	);
	// Files that couldn't be searched: the prefetch's, and those whose own
	// request (the open file's diff) failed while the prefetch left them to it;
	// never a file whose hunks came since (opened: its diff asked again).
	const failedFiles = useMemo(() => {
		const all = new Set(snapshot.failed);
		files.forEach((f, i) => {
			if (hunks.failed[i]) all.add(f.index);
			if (hunks.data[i] !== undefined) all.delete(f.index);
		});
		// And a file with an expanded range that couldn't be read.
		ranges.forEach((r, i) => {
			if (context.failed[i]) all.add(r.index);
		});
		return [...all];
	}, [snapshot.failed, files, hunks.failed, hunks.data, ranges, context]);
	// Expanded ranges not loaded: fetched while the bar is open on a page
	// that shows (a failed one waits for Retry).
	useEffect(() => {
		if (!active || revision === undefined) return;
		ranges.forEach((r, i) => {
			if (!context.waiting[i]) return;
			const query = contextQuery(revision, r.index, r.from, r.to);
			if (client.getQueryState(query.queryKey)?.fetchStatus === "fetching")
				return;
			void client.prefetchQuery(query);
		});
	}, [active, revision, ranges, context, client]);
	const retry = useCallback(() => {
		if (!prefetcher) return;
		prefetcher.retry();
		// A file whose own request failed isn't the prefetch's yet: ask for it.
		prefetcher.queue(
			files.filter((_, i) => hunks.failed[i]).map((f) => f.index),
		);
		if (revision === undefined) return;
		ranges.forEach((r, i) => {
			if (context.failed[i])
				void client.prefetchQuery(
					contextQuery(revision, r.index, r.from, r.to),
				);
		});
	}, [prefetcher, files, hunks.failed, revision, ranges, context, client]);

	const marking = searchOn && term !== "";
	// Not final while the prefetch has files out, a file's own request is out,
	// an expanded range isn't loaded yet, or (the first render of an open bar
	// on a page that shows, or of a new revision) the prefetch hasn't started.
	const searching =
		marking &&
		(snapshot.pending > 0 ||
			hunks.fetching ||
			context.waiting.some(Boolean) ||
			(active && prefetcher === null));
	const count = marking
		? { at: caret ? hitIndex(hits, caret.pos) + 1 : 0, of: hits.length }
		: null;

	// The per-file views.
	const views = useMemo(() => {
		const byFile = new Map<number, Hit[]>();
		for (const h of hits) {
			const list = byFile.get(h.index);
			if (list) list.push(h);
			else byFile.set(h.index, [h]);
		}
		const fileBy = new Map(files.map((f) => [f.index, f]));
		const pos = caret?.pos ?? null;
		const of = (index: number) => byFile.get(index) ?? NO_HITS;
		const marksBy = (
			index: number,
			mark: (f: FileView, h: Hit[], p: typeof pos) => FindMark[],
		) => {
			const f = fileBy.get(index);
			const h = of(index);
			return f && h.length > 0 ? mark(f, h, pos) : NO_MARKS;
		};
		const tree: TreeFind = {
			counts: countsByFile(hits),
			nameMarks: (index) => marksBy(index, nameMarks),
			oldNameMarks: (index) => marksBy(index, oldNameMarks),
		};
		const paths = new Map<number, readonly FindMark[]>();
		const pathOf = (index: number) => {
			let marks = paths.get(index);
			if (!marks) {
				marks = marksBy(index, headerPathMarks);
				paths.set(index, marks);
			}
			return marks;
		};
		// Each file's line marks, keyed `${side}:${line}`: an O(1) lookup per cell.
		const lineMarks = new Map<number, Map<string, FindMark[]>>();
		const linesOf = (index: number) => {
			let byLine = lineMarks.get(index);
			if (!byLine) {
				byLine = new Map();
				for (const h of of(index)) {
					if (h.side !== "LEFT" && h.side !== "RIGHT") continue;
					const key = `${h.side}:${h.line}`;
					const mark = {
						from: h.col,
						to: h.col + h.len,
						current: pos !== null && samePos(h, pos),
					};
					const list = byLine.get(key);
					if (list) list.push(mark);
					else byLine.set(key, [mark]);
				}
				lineMarks.set(index, byLine);
			}
			return byLine;
		};
		return { tree, pathOf, linesOf, pos };
	}, [hits, files, caret]);

	const diffs = useMemo(() => {
		const built = new Map<number, DiffFind>();
		return (index: number): DiffFind | undefined => {
			if (!marking) return undefined;
			let diff = built.get(index);
			if (!diff) {
				const byLine = views.linesOf(index);
				const pos = views.pos;
				diff = {
					marksOf: (side: DiffSide, line: number) =>
						byLine.get(`${side}:${line}`) ?? NO_MARKS,
					current:
						pos &&
						pos.index === index &&
						(pos.side === "LEFT" || pos.side === "RIGHT")
							? { old: pos.side === "LEFT", line: pos.line }
							: null,
					stepSeq: lastStep?.index === index ? lastStep.seq : 0,
				};
				built.set(index, diff);
			}
			return diff;
		};
	}, [marking, views, lastStep]);

	const pathOf = useCallback(
		(index: number) => (marking ? views.pathOf(index) : NO_MARKS),
		[marking, views],
	);

	return {
		state,
		hits,
		caret,
		count,
		searching,
		failed: marking ? failedFiles.length : 0,
		retry,
		step,
		matchCase,
		setMatchCase: matchCaseSetting.set,
		tree: views.tree,
		diffOf: diffs,
		pathOf,
		stepInto,
	};
}
