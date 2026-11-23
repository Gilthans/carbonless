import "github-markdown-css/github-markdown-dark.css";
import "../../../githubHtml.css";
import "./markdownView.css";
import { ChevronRightIcon, CommentIcon } from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import {
	type MouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { SpanAgentThread } from "../../../../shared/agent";
import { type LineRanges, size } from "../../../../shared/lineRanges";
import type { SincePiece } from "../../../../shared/pieces";
import type {
	ClusterView,
	DiffLine,
	DiffSide,
	FileView,
	ReviewThread,
	SinceMark,
} from "../../../../shared/types";
import { AgentBubble } from "../../../agent/AgentBubble";
import { AgentComposer } from "../../../agent/AgentComposer";
import { takeJustAsked } from "../../../agent/agentWrites";
import { useAgentComposers } from "../../../agent/askAgentAction";
import { shownOutsideCard, useHeldByCard } from "../../../agent/pendingThread";
import type { AgentPlaceable } from "../../../agent/placeable";
import {
	contextQuery,
	hunksQuery,
	overviewQuery,
	sessionQuery,
} from "../../../api";
import { SkeletonBar, Spinner } from "../../../Spinner";
import { Tooltip } from "../../../Tooltip";
import { spanTexts } from "../../../threads/draftMove";
import { useDrafts } from "../../../threads/drafts";
import { LOADING, NewThread, quoteOf } from "../../../threads/NewThread";
import {
	newThreadItems,
	openComposer,
	useComposers,
} from "../../../threads/newThreads";
import type { SpanRange } from "../../../threads/spanMarks";
import { ErrorMessage } from "../../../ui";
import { NOT_PHONE, useMedia } from "../../../useMedia";
import { ignoreWhitespace } from "../../../viewSettings";
import { ClusterControls } from "../../ClusterControls";
import { noLineIn, type SpanCell, spanOfCells } from "../../codeSpan";
import {
	agentCommentOn,
	type DiffFind,
	type DiffThreads,
} from "../../DiffBody";
import { KindChip } from "../../KindChip";
import type { Landing } from "../../landing";
import { pieceMark } from "../../pieceMark";
import { useResolveCollapse } from "../../resolveCollapse";
import {
	type CodeSpan,
	commentAvailable,
	describeSpan,
	noLineReason,
} from "../../selectionActions";
import type { KindEntry } from "../../since";
import { SinceNotes } from "../../sinceNotes";
import { ThreadBubble } from "../../ThreadBubble";
import { AgentThreadCards, ThreadBlock } from "../../ThreadRow";
import { useFocusAmong } from "../../threadFocus";
import {
	type FilePlacement,
	type LineKey,
	lineKey,
	onSinceRows,
	sinceEarlier,
	sinceLeft,
} from "../../threadPlacement";
import { type ImageFile, imageResolver, remoteImageUrl } from "./images";
import {
	blockCommentSpan,
	blocksOf,
	buildDoc,
	type CommentUnit,
	clusterLines,
	type DocRow,
	type DocUnit,
	type LineAnchor,
	lineAnchor,
	rebuildSides,
	type Tone,
} from "./markdownDoc";
import {
	type PairHtml,
	renderBlocks,
	renderPair,
	sideBlocks,
} from "./renderBlocks";
import { alignTables, syncTableScroll } from "./tableAlign";

/**
 * The Rendered view of a Markdown file (CAR-167, spec "The Rendered
 * view"): the new document rendered block by block, each changed block on
 * a bar (green added, red struck removed, amber changed with its words
 * marked) with one box per unit on it, in source order. The units are the
 * server's: the full diff's clusters, the since view's pieces (`from`);
 * this view only places them (principle 2: a unit it can't place sends the
 * file to Text, `onShowText`). Both sides are rebuilt from what the line
 * view reads (the hunks, and the file's unchanged lines).
 */
export function MarkdownView(props: {
	file: FileView;
	revision: string;
	sideBySide: boolean;
	readOnly?: boolean;
	/** A cluster's box; in the since view, one piece of it. */
	onToggle: (cluster: ClusterView, piece?: LineRanges) => void;
	onCrossOff: (cluster: ClusterView, piece?: LineRanges) => void;
	/**
	 * The review's threads, and where FileDiff placed this file's on its
	 * lines (the hunks and the whole document): each shows under the block
	 * holding its line; what no line is stays in the file's header.
	 */
	threads?: DiffThreads;
	placement?: FilePlacement | null;
	/** The agent's threads on this file, placed by FileDiff the same way. */
	agentPlacement?: FilePlacement<AgentPlaceable> | null;
	/** These hunks are the viewed head's (not a Refresh's moment of the old ones). */
	headSure?: boolean;
	/** The find: a step lands on the block holding its hit. */
	find?: DiffFind;
	/**
	 * The find's current step is spent (FileDiff's: it already showed Text
	 * for it, or was mounted with it): landed on, never sent to Text again.
	 */
	findSpent?: boolean;
	/** A step's hit the rendered text doesn't show: Text for the view, this step spent. */
	onFindText?: () => void;
	/** A thread link: FileDiff shows Text for it (its exact line). */
	landing?: Landing;
	/** The view switch. */
	view: ReactNode;
	/** What shows above the document (the file's rows and bubble). */
	head?: ReactNode;
	/** The document can't be shown whole: Text takes over for the view. */
	onShowText: () => void;
	/** The since view's compared patch set. */
	from?: number;
	kinds?: Map<string, KindEntry>;
	onSinceMark?: (piece: SincePiece, cross: boolean) => void;
	sinceMarks?: SinceMark[];
	/** The review's files: a relative image loads only from one of them. */
	files?: readonly ImageFile[];
}) {
	const { file, revision, from } = props;
	const hunks = useQuery(hunksQuery(revision, file.index, from));
	const count = hunks.data?.newLineCount ?? 0;
	const context = useQuery({
		...documentContextQuery(revision, file.index, count, from),
		enabled: hunks.isSuccess && count > 0,
	});
	const ignoreWs = ignoreWhitespace.use();
	const wide = useMedia(NOT_PHONE);
	const split = props.sideBySide && wide;
	const pending = hunks.isPending || (count > 0 && context.isPending);
	const error = hunks.error ?? (count > 0 ? context.error : null);
	// The review's files as the images read them: a new list every mark
	// (the review is read again) but the same images, so the rendered HTML
	// isn't built again for a tick.
	const imagesKey = JSON.stringify(
		(props.files ?? []).map((f) => [
			f.index,
			f.path,
			f.status,
			f.binary,
			f.lfs ?? false,
			f.submodule,
		]),
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the list.
	const files = useMemo(() => props.files ?? [], [imagesKey]);

	// The marks go through the latest callbacks; the document is built once.
	const marks = useRef({
		onToggle: props.onToggle,
		onCrossOff: props.onCrossOff,
		onSinceMark: props.onSinceMark,
	});
	marks.current = {
		onToggle: props.onToggle,
		onCrossOff: props.onCrossOff,
		onSinceMark: props.onSinceMark,
	};
	// The file's two sides, their blocks and HTML: from what was read alone,
	// never again for a mark.
	const base = useMemo(() => {
		if (!hunks.data || (count > 0 && !context.data)) return null;
		try {
			const sides = rebuildSides(hunks.data, context.data ?? []);
			if (!sides) return "failed" as const;
			const oldBlocks = blocksOf(sides.old);
			const newBlocks = blocksOf(sides.new);
			const side = (s: "old" | "new") =>
				imageResolver({ mdPath: file.path, files, revision, side: s, from });
			const oldSide = sideBlocks(sides.old, oldBlocks);
			const newSide = sideBlocks(sides.new, newBlocks);
			const pairs = new Map<string, PairHtml | null>();
			return {
				sides,
				oldBlocks,
				newBlocks,
				oldHtml: renderBlocks(sides.old, oldBlocks, { image: side("old") }),
				newHtml: renderBlocks(sides.new, newBlocks, { image: side("new") }),
				pair: (o: number, n: number): PairHtml | null => {
					const key = `${o}:${n}`;
					if (!pairs.has(key)) {
						pairs.set(
							key,
							renderPair(oldSide, o, newSide, n, { image: side("new") }),
						);
					}
					return pairs.get(key) ?? null;
				},
			};
		} catch {
			return "failed" as const;
		}
	}, [hunks.data, context.data, count, file.path, files, revision, from]);
	// The units on it (the clusters or the since pieces, with their marks)
	// and where each sits: again on each mark, cheaply.
	const model = useMemo(() => {
		if (base === null || base === "failed") return base;
		try {
			const clusters = new Map(file.clusters.map((c) => [c.key, c]));
			const units: (DocUnit & { control: UnitControl })[] = [];
			if (from === undefined) {
				for (const c of file.clusters) {
					if (c.kind !== "lines") continue;
					if (ignoreWs && c.whitespaceOnly) continue;
					units.push({
						key: c.key,
						...clusterLines(c),
						control: {
							cluster: c,
							toggle: () => marks.current.onToggle(c),
							crossOff: () => marks.current.onCrossOff(c),
							ws: c.whitespaceOnly === true,
							entry: props.kinds?.get(c.key),
							carried: c.carried,
							linesCarried: c.linesCarried,
						},
					});
				}
			} else {
				for (const piece of hunks.data?.pieces ?? []) {
					const mark = pieceMark(piece, {
						clusters,
						since: from,
						path: file.path,
						sinceMarks: props.sinceMarks,
						onToggle: (c, p) => marks.current.onToggle(c, p),
						onCrossOff: (c, p) => marks.current.onCrossOff(c, p),
						onSinceMark: (p, cross) => marks.current.onSinceMark?.(p, cross),
					});
					if (!mark) continue;
					const entry = piece.key ? props.kinds?.get(piece.key) : undefined;
					const control: UnitControl = {
						cluster: mark.cluster,
						toggle: mark.marker.toggle,
						crossOff: mark.marker.crossOff,
						ws: mark.cluster.whitespaceOnly === true,
						// A piece of its own isn't its neighbour's: only gone says
						// where it came from.
						entry: mark.whole || entry?.kind === "gone" ? entry : undefined,
						carried: mark.whole?.carried,
						sinceOnly: piece.kind,
					};
					if (ignoreWs && control.ws) continue;
					units.push({
						key: `p:${piece.hunk}:${piece.line}`,
						old: piece.old,
						new: piece.new,
						control,
					});
				}
			}
			const doc = buildDoc({
				sides: base.sides,
				oldBlocks: base.oldBlocks,
				newBlocks: base.newBlocks,
				units,
			});
			if (doc.unplaced.length > 0) return "failed" as const;
			return {
				doc,
				units: new Map(units.map((u) => [u.key, u.control])),
				lines: new Map<string, CommentUnit>(
					units.map((u) => [
						u.key,
						{ old: u.old, new: u.new, ws: u.control.ws },
					]),
				),
				oldHtml: base.oldHtml,
				newHtml: base.newHtml,
				pair: base.pair,
			};
		} catch {
			return "failed" as const;
		}
	}, [
		base,
		hunks.data,
		file.clusters,
		file.path,
		from,
		ignoreWs,
		props.kinds,
		props.sinceMarks,
	]);
	const failed = model === "failed";
	const showText = useRef(props.onShowText);
	showText.current = props.onShowText;
	useEffect(() => {
		if (failed) showText.current();
	}, [failed]);

	const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
	const root = useRef<HTMLDivElement>(null);
	// A changed block's body is never hidden: content's own <details> stay open.
	// A table's rows, one table each, line their columns up (tableAlign.ts).
	useLayoutEffect(() => {
		for (const d of root.current?.querySelectorAll("details") ?? []) {
			d.open = true;
		}
	});
	const realign = useCallback(() => {
		if (root.current) alignTables(root.current);
	}, []);
	// Again only when the document's HTML may differ: its rows (a mark, a
	// whitespace setting), a fold opened, side by side.
	// biome-ignore lint/correctness/useExhaustiveDependencies: these change the rendered tables.
	useLayoutEffect(realign, [model, open, split, ignoreWs, realign]);
	const ready = model !== null && model !== "failed";
	useEffect(() => {
		const el = root.current;
		if (!ready || !el) return;
		el.addEventListener("scroll", syncTableScroll, true);
		// What changes a cell's width after the pass: the document's width,
		// a font face arriving, an image in a cell loading. Aligning never
		// changes the document's width (tables scroll in their boxes).
		const onLoad = (e: Event) => {
			if (e.target instanceof Element && e.target.closest("table")) realign();
		};
		el.addEventListener("load", onLoad, true);
		let width = el.clientWidth;
		const resized =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(() => {
						if (el.clientWidth === width) return;
						width = el.clientWidth;
						realign();
					});
		resized?.observe(el);
		let live = true;
		void document.fonts?.ready.then(() => {
			if (live) realign();
		});
		return () => {
			live = false;
			resized?.disconnect();
			el.removeEventListener("load", onLoad, true);
			el.removeEventListener("scroll", syncTableScroll, true);
		};
	}, [ready, realign]);
	const idBase = useId();

	// Where each line shows: the row of the block holding it (a folded
	// block's fold while it is closed), by a key the rows carry.
	const where = useMemo(() => {
		if (!base || base === "failed" || !model || model === "failed") {
			return null;
		}
		const { doc } = model;
		const blockRow = new Map<number, number>();
		doc.rows.forEach((r, i) => {
			const blocks =
				r.kind === "same"
					? [r.block]
					: r.kind === "fold"
						? r.blocks
						: r.newBlocks;
			for (const b of blocks) blockRow.set(b, i);
		});
		return {
			doc,
			blockRow,
			anchor: (side: DiffSide, line: number): LineAnchor | null =>
				lineAnchor(doc, base.sides, base.oldBlocks, base.newBlocks, side, line),
			text: (side: DiffSide, line: number) =>
				(side === "LEFT" ? base.sides.old : base.sides.new)[line - 1] ?? "",
		};
	}, [base, model]);
	/** The key of the row that shows a line (TOP: a document with no rows). */
	const rowKeyOf = (side: DiffSide, line: number): string => {
		const a = where?.anchor(side, line);
		if (!where || !a) return TOP;
		if ("row" in a) return `c${a.row}`;
		const i = where.blockRow.get(a.block);
		const row = i === undefined ? undefined : where.doc.rows[i];
		if (!row) return TOP;
		if (row.kind === "change") return `c${i}`;
		if (row.kind === "fold") {
			const first = row.blocks[0] as number;
			return open.has(first) ? `s${a.block}` : `f${first}`;
		}
		return `s${a.block}`;
	};
	const keyOfLineKey = (key: LineKey) => {
		const [side, n] = key.split(":");
		return rowKeyOf(side as DiffSide, Number(n));
	};

	// The file's threads by the row that shows their line: every one
	// FileDiff placed on a line (none dropped: a blank line, a line no
	// block holds, goes with the nearest block).
	const threadsAt = new Map<string, ReviewThread[]>();
	const rowOfThread = new Map<string, string>();
	const addThread = (key: LineKey, t: ReviewThread) => {
		const row = keyOfLineKey(key);
		threadsAt.set(row, [...(threadsAt.get(row) ?? []), t]);
		if (t.id) rowOfThread.set(t.id, row);
	};
	if (where && props.placement) {
		for (const [key, list] of props.placement.end) {
			for (const t of list) addThread(key, t);
		}
		for (const [t, target] of props.placement.gapTargets) {
			addThread(target.key, t);
		}
	}
	const threadsId = (key: string) => `${idBase}-threads-${key}`;
	const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
	const openRow = (key: string) =>
		setOpenRows((was) => (was.has(key) ? was : new Set(was).add(key)));
	const [focusBubble, setFocusBubble] = useState<string | null>(null);
	// Resolve closes a thread down to its block's bubble, as in the line
	// view (resolveCollapse.ts).
	const collapse = useResolveCollapse<string>(props.threads?.threads, {
		open: openRow,
		close: (key) =>
			setOpenRows((was) => {
				if (!was.has(key)) return was;
				const next = new Set(was);
				next.delete(key);
				return next;
			}),
		focus: setFocusBubble,
		element: (key) =>
			root.current?.querySelector(
				`[aria-controls="${CSS.escape(threadsId(key))}"]`,
			) ?? null,
	});
	// A card asked for (a Threads tab row, a link to a conversation): its
	// block's threads open, and the card takes it.
	const rowOfThreadNow = useRef(rowOfThread);
	rowOfThreadNow.current = rowOfThread;
	useFocusAmong(
		(id) => rowOfThreadNow.current.has(id),
		(f) => {
			const key = rowOfThreadNow.current.get(f.id);
			if (!key) return;
			collapse.toggled(key);
			openRow(key);
		},
	);

	// The agent's threads on lines: placed as the review threads are
	// (FileDiff, on the document), each under its block with its own
	// bubble, as the line view has them beside a line's comments.
	const agentAt = new Map<string, SpanAgentThread[]>();
	const rowOfAgent = new Map<string, string>();
	const addAgent = (key: LineKey, p: AgentPlaceable) => {
		const row = keyOfLineKey(key);
		agentAt.set(row, [...(agentAt.get(row) ?? []), p.thread]);
		rowOfAgent.set(p.thread.id, row);
	};
	if (where && props.agentPlacement) {
		for (const [key, list] of props.agentPlacement.end) {
			for (const p of list) addAgent(key, p);
		}
		for (const [p, target] of props.agentPlacement.gapTargets) {
			addAgent(target.key, p);
		}
	}
	const [openAgent, setOpenAgent] = useState<ReadonlySet<string>>(new Set());
	const openAgentRow = (key: string) =>
		setOpenAgent((was) => (was.has(key) ? was : new Set(was).add(key)));
	const rowOfAgentNow = useRef(rowOfAgent);
	rowOfAgentNow.current = rowOfAgent;
	useFocusAmong(
		(id) => rowOfAgentNow.current.has(id),
		(f) => {
			const key = rowOfAgentNow.current.get(f.id);
			if (key) openAgentRow(key);
		},
	);
	// A thread just asked from this page opens where it lands.
	const agentEnded = props.agentPlacement?.end;
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per placement, by the rows as drawn now.
	useEffect(() => {
		if (!agentEnded) return;
		for (const [key, list] of agentEnded) {
			if (list.some((p) => takeJustAsked(p.thread.id))) {
				openAgentRow(
					rowOfAgentNow.current.get(list[0]?.thread.id ?? "") ??
						keyOfLineKey(key),
				);
			}
		}
	}, [agentEnded]);

	// Line comments being written on this file: under the block holding
	// the line they end on, as the line view has them under theirs.
	const session = useQuery({ ...sessionQuery, enabled: false }).data;
	const overview = useQuery({ ...overviewQuery, enabled: false }).data;
	const snapshotHead =
		props.threads?.snapshotHead ?? session?.snapshotHead ?? "";
	const earlierHead =
		from === undefined
			? undefined
			: session?.patchsets.find((p) => p.number === from)?.head;
	const drafts = useDrafts();
	const composerList = useComposers();
	const allItems = useMemo(
		() => newThreadItems(drafts, composerList),
		[drafts, composerList],
	);
	const heldByCard = useHeldByCard();
	const onEarlier = (span: CodeSpan) =>
		span.earlier === true &&
		earlierHead !== undefined &&
		span.commit === earlierHead;
	const lineItems = allItems.filter(
		(i) =>
			i.span.path === file.path &&
			i.span.subject === "line" &&
			(i.span.commit === snapshotHead || onEarlier(i.span)) &&
			shownOutsideCard(i, snapshotHead, heldByCard),
	);
	// The since view numbers its old side in the compared patch set: a span
	// (GitHub's numbers) goes on the rows that show it there (CAR-217/233).
	const sinceRows = useMemo(
		() =>
			from === undefined || !hunks.data
				? null
				: {
						left: sinceLeft(file.clusters, hunks.data.hunks),
						early:
							earlierHead === undefined
								? undefined
								: sinceEarlier(earlierHead, hunks.data.hunks),
					},
		[from, hunks.data, file.clusters, earlierHead],
	);
	const rowsOf = (span: CodeSpan): SpanRange | null => {
		if (span.side === undefined || span.line === undefined) return null;
		const range = {
			earlier: span.earlier,
			startSide: span.startSide ?? span.side,
			startLine: span.startLine ?? span.line,
			side: span.side,
			line: span.line,
			startCol: span.startCol,
			endCol: span.endCol,
		};
		return sinceRows
			? onSinceRows(range, sinceRows.left, sinceRows.early)
			: from === undefined
				? range
				: null;
	};
	const composersAt = new Map<string, typeof lineItems>();
	for (const item of lineItems) {
		const rows = where ? rowsOf(item.span) : null;
		const key = rows ? rowKeyOf(rows.side, rows.line) : TOP;
		composersAt.set(key, [...(composersAt.get(key) ?? []), item]);
	}
	// Ask agent on lines: under the block, as comments being written are.
	const agentItems = useAgentComposers().filter(
		(c) =>
			c.span.path === file.path &&
			c.span.subject === "line" &&
			(c.span.commit === snapshotHead || onEarlier(c.span)),
	);
	const askingAt = new Map<string, typeof agentItems>();
	for (const item of agentItems) {
		const rows = where ? rowsOf(item.span) : null;
		const key = rows ? rowKeyOf(rows.side, rows.line) : TOP;
		askingAt.set(key, [...(askingAt.get(key) ?? []), item]);
	}
	/** What a row shows under or beside it besides its block. */
	const hasExtra = (key: string) =>
		threadsAt.has(key) ||
		composersAt.has(key) ||
		agentAt.has(key) ||
		askingAt.has(key);
	// GitHub's diff's own lines (a hunk's), by side: where a comment goes.
	const hunkKeys = useMemo(() => {
		const out = new Set<string>();
		for (const h of hunks.data?.hunks ?? []) {
			for (const l of h.lines) {
				for (const side of ["LEFT", "RIGHT"] as const) {
					const k = lineKey(side, l);
					if (k) out.add(k);
				}
			}
		}
		return out;
	}, [hunks.data]);
	/** The span's quote and where it is, as this view numbers its rows. */
	const quoteAndWhere = (span: CodeSpan) => {
		const rows = rowsOf(span);
		const texts =
			rows && where
				? [
						where.text(rows.startSide, rows.startLine),
						...(rows.startSide === rows.side && rows.startLine === rows.line
							? []
							: [where.text(rows.side, rows.line)]),
					]
				: [];
		return {
			rows,
			quote: quoteOf(span, texts),
			where: describeSpan(rows ? { ...span, ...rows } : span),
			lineTexts:
				rows && hunks.data
					? (spanTexts(hunks.data.hunks, rows) ?? undefined)
					: undefined,
		};
	};
	// The since view's removed rows by their own old number: GitHub's
	// numbers for them (CAR-217: the base; CAR-233: the compared patch
	// set's commit).
	const removedRows = useMemo(() => {
		const out = new Map<number, DiffLine>();
		for (const h of hunks.data?.hunks ?? []) {
			for (const l of h.lines) {
				if (l.kind !== "add" && l.kind !== "context" && l.oldNo !== undefined) {
					out.set(l.oldNo, l);
				}
			}
		}
		return out;
	}, [hunks.data]);
	/** A block's comment as GitHub takes it, or why it can't be. */
	const githubSpan = (
		range: SpanRange,
	): { span: CodeSpan } | { why: string } => {
		const cell = (side: DiffSide, line: number): SpanCell => {
			if (side === "RIGHT" || from === undefined) {
				return { path: file.path, side, line };
			}
			const row = removedRows.get(line);
			return {
				path: file.path,
				side,
				line,
				base: row?.baseNo === undefined ? "unknown" : row.baseNo,
				...(row?.psNo !== undefined ? { ps: row.psNo } : {}),
				...(row?.psMoved ? { psMoved: true } : {}),
			};
		};
		const start = cell(range.startSide, range.startLine);
		const end = cell(range.side, range.line);
		if (from !== undefined) {
			// Every line of it, as the line view checks every picked line: a
			// middle line GitHub has none for (or of the other commit) refuses
			// the span; the earlier patch set's lines must be one run there.
			const cells =
				range.startSide === range.side
					? Array.from({ length: range.line - range.startLine + 1 }, (_, i) =>
							cell(range.side, range.startLine + i),
						)
					: [start, end];
			const why = noLineIn(cells, earlierHead);
			if (why) return { why: noLineReason(why) };
		}
		return {
			span: spanOfCells(start, end, snapshotHead, undefined, earlierHead),
		};
	};

	// The find: a step onto a hit in this file lands on the block that
	// shows it; a hit its rendered text doesn't show (a link's URL, markup)
	// shows the file as Text for the view (the stored pick unchanged).
	const findSeq = props.find?.current ? props.find.stepSeq : 0;
	const findCurrent = props.find?.current ?? null;
	const findDone = useRef(0);
	const findNow = useRef({
		find: props.find,
		rowKeyOf,
		text: where?.text,
		spent: props.findSpent,
		toText: props.onFindText,
	});
	findNow.current = {
		find: props.find,
		rowKeyOf,
		text: where?.text,
		spent: props.findSpent,
		toText: props.onFindText,
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: again once a fold it opened is drawn (`open`).
	useEffect(() => {
		const el = root.current;
		if (!where || !el || findSeq === 0 || findDone.current === findSeq) return;
		const { find, rowKeyOf: keyOf, text, spent, toText } = findNow.current;
		const current = find?.current;
		if (!current || !text) return;
		const side: DiffSide = current.old ? "LEFT" : "RIGHT";
		const key = keyOf(side, current.line);
		if (key.startsWith("f")) {
			// A folded block: its fold opens, then this runs again.
			setOpen((was) => new Set(was).add(Number(key.slice(1))));
			return;
		}
		findDone.current = findSeq;
		const marks = find.marksOf(side, current.line);
		const mark = marks.find((m) => m.current) ?? marks[0];
		const hit = mark ? text(side, current.line).slice(mark.from, mark.to) : "";
		const row = el.querySelector(`[data-row="${CSS.escape(key)}"]`);
		if (!row || !shows(row, hit)) {
			// A step FileDiff already spent (it switched for it, or the file
			// remounted with it) lands here without bouncing back to Text.
			if (!spent) toText?.();
			return;
		}
		row.scrollIntoView?.({ block: "center" });
	}, [where, findSeq, open]);
	const findKey = findCurrent
		? rowKeyOf(findCurrent.old ? "LEFT" : "RIGHT", findCurrent.line)
		: null;

	/** A row's bubbles (in its gutter): its comments', and its agent threads'. */
	const bubbleOf = (key: string) => {
		const list = threadsAt.get(key) ?? [];
		const asked = agentAt.get(key) ?? [];
		if (list.length === 0 && asked.length === 0) return null;
		const shown = openRows.has(key);
		const agentShown = openAgent.has(key);
		return (
			<>
				{list.length > 0 && (
					<ThreadBubble
						threads={list}
						where="on this block"
						open={shown}
						controls={shown ? threadsId(key) : undefined}
						focus={focusBubble === key}
						onFocused={() => setFocusBubble(null)}
						onToggle={() => {
							collapse.toggled(key);
							setOpenRows((was) => {
								const next = new Set(was);
								if (shown) next.delete(key);
								else next.add(key);
								return next;
							});
						}}
					/>
				)}
				{asked.length > 0 && (
					<AgentBubble
						threads={asked}
						where="on this block"
						open={agentShown}
						controls={agentShown ? `${threadsId(key)}-agent` : undefined}
						onToggle={() =>
							setOpenAgent((was) => {
								const next = new Set(was);
								if (agentShown) next.delete(key);
								else next.add(key);
								return next;
							})
						}
					/>
				)}
			</>
		);
	};
	/**
	 * Under a row: its threads once opened (Resolve closes one down to the
	 * bubble), its agent threads once opened, and comments and questions
	 * being written on it.
	 */
	const threadsOf = (key: string) => {
		const list = openRows.has(key)
			? (threadsAt.get(key) ?? []).filter(collapse.shows)
			: [];
		const asked = openAgent.has(key) ? (agentAt.get(key) ?? []) : [];
		const writing = composersAt.get(key) ?? [];
		const asking = askingAt.get(key) ?? [];
		if (
			list.length === 0 &&
			asked.length === 0 &&
			writing.length === 0 &&
			asking.length === 0
		) {
			return null;
		}
		return (
			<div
				data-testid="md-threads"
				data-threads-of={key}
				className="md-threads space-y-2"
			>
				{list.length > 0 && (
					<div id={threadsId(key)} className="space-y-2">
						{list.map((t, i) => (
							<ThreadBlock
								key={t.id || `#${i}`}
								readId={props.threads?.readId ?? ""}
								thread={t}
								onResolved={(thread, from) =>
									collapse.resolved({ key, thread, shown: list, from })
								}
							/>
						))}
					</div>
				)}
				{asked.length > 0 && (
					<div
						id={`${threadsId(key)}-agent`}
						data-testid="md-agent-threads"
						className="space-y-2"
					>
						<AgentThreadCards threads={asked} />
					</div>
				)}
				{writing.map((item) => {
					const at = quoteAndWhere(item.span);
					return (
						<NewThread
							key={item.clientId}
							item={item}
							quote={at.quote}
							where={at.where}
							lineTexts={at.lineTexts}
							onPosted={() => openRow(key)}
							headUnsure={props.headSure === false}
						/>
					);
				})}
				{asking.map((item) => {
					const at = quoteAndWhere(item.span);
					return (
						<AgentComposer
							key={item.clientId}
							clientId={item.clientId}
							span={item.span}
							quote={at.quote}
							where={at.where}
							lineTexts={at.lineTexts}
							comment={agentCommentOn(item.span, {
								rowsOf: (range) => rowsOf({ ...item.span, ...range }),
								hunkKeys: hunks.data ? hunkKeys : null,
								head: snapshotHead || undefined,
								file,
								headUnsure: props.headSure === false,
								readOnly: props.readOnly === true,
							})}
						/>
					);
				})}
			</div>
		);
	};
	const bar = (
		<div
			data-testid="view-bar"
			className="flex min-h-12 flex-wrap items-center gap-2 border-line border-b bg-band px-2 py-1"
		>
			{props.view}
		</div>
	);

	if (error) {
		return (
			<>
				{bar}
				{props.head}
				<div className="p-2">
					<ErrorMessage error={error} />
				</div>
				{/* Comments and questions being written on its lines: above, never lost. */}
				{threadsOf(TOP)}
			</>
		);
	}
	if (pending || model === null || failed) {
		return (
			<>
				{bar}
				{props.head}
				<div
					aria-busy="true"
					data-testid="md-loading"
					className="min-h-[100dvh] space-y-3 px-3 py-3"
				>
					<Spinner label="Loading document" />
					<SkeletonBar className="w-2/5" />
					<SkeletonBar className="w-11/12" />
					<SkeletonBar className="w-4/5" />
				</div>
			</>
		);
	}

	const { doc, units, oldHtml, newHtml, pair } = model;
	const htmlOf = (list: readonly { html: string }[], ids: number[]) =>
		ids.map((i) => list[i]?.html ?? "").join("");
	const noteId = (key: string) => `${idBase}-note-${key}`;

	const content = (html: string, extra = "") => (
		<div
			className={`markdown-body md-content min-w-0 ${extra}`}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: renderBlocks/renderPair output only, sanitized there (renderBlocks.ts).
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
	/**
	 * A row's cells. Unified: the gutter, then the body on its bar. Side by
	 * side (desktop): each column its own gutter and body, the gutter's
	 * boxes on the new column, a removal's (no new column) on the old.
	 */
	const cells = (o: {
		gutter: ReactNode;
		tone?: Tone;
		/** Above the block, on the boxes' side: its chips and notes. */
		top?: ReactNode;
		unified: ReactNode;
		left?: ReactNode;
		right?: ReactNode;
		onOld?: boolean;
	}) => {
		const tone = (shown: boolean) =>
			o.tone && shown ? `md-body md-${o.tone}` : "md-body";
		if (!split) {
			return (
				<>
					<div className="md-gutter">{o.gutter}</div>
					<div className={tone(true)} data-col="doc">
						{o.top}
						{o.unified}
					</div>
				</>
			);
		}
		const left = o.left ?? null;
		const right = o.right ?? null;
		return (
			<>
				<div className="md-gutter" data-col="old">
					{o.onOld ? o.gutter : null}
				</div>
				<div className={tone(left !== null)} data-col="old">
					{o.onOld ? o.top : null}
					{left}
				</div>
				<div className="md-gutter" data-col="new">
					{o.onOld ? null : o.gutter}
				</div>
				<div className={tone(right !== null)} data-col="new">
					{o.onOld ? null : o.top}
					{right}
				</div>
			</>
		);
	};
	const rowClass = split ? "md-row md-split" : "md-row";

	const rowMarks = (key: string) => ({
		"data-row": key,
		"data-find-current": findKey === key || undefined,
	});

	const sameRow = (block: number) => {
		const html = newHtml[block]?.html ?? "";
		const key = `s${block}`;
		return (
			<div
				key={key}
				data-testid="md-block"
				data-tone="same"
				data-block={block}
				className={rowClass}
				{...rowMarks(key)}
			>
				{cells({
					gutter: bubbleOf(key),
					unified: content(html),
					left: content(html),
					right: content(html),
				})}
				{threadsOf(key)}
			</div>
		);
	};

	/** A changed block's comment button: on its last cluster's changed lines. */
	const commentOf = (row: Extract<DocRow, { kind: "change" }>) => {
		const range = blockCommentSpan(
			row.units.flatMap((k) => {
				const u = model.lines.get(k);
				return u ? [u] : [];
			}),
		);
		if (!range) return null;
		const github = githubSpan(range);
		const ok =
			"why" in github
				? github.why
				: overview
					? commentAvailable(github.span, {
							writes: overview.writes,
							commentLeft: overview.commentLeft !== false,
							file: { binary: file.binary, submodule: file.submodule },
							// A cluster's changed lines: GitHub's diff's own.
							inDiff: true,
							headUnsure: props.headSure === false,
							readOnly: props.readOnly === true,
						})
					: LOADING;
		return (
			<Tooltip content={ok === true ? "Comment on block" : ok}>
				{(trigger) => (
					<button
						type="button"
						{...trigger}
						data-testid="md-comment"
						aria-label="Comment on block"
						aria-disabled={ok !== true || undefined}
						onClick={() => {
							if (ok === true && "span" in github && snapshotHead) {
								openComposer(github.span);
							}
						}}
						className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent aria-disabled:cursor-not-allowed aria-disabled:text-faint aria-disabled:hover:bg-transparent"
					>
						<CommentIcon size={16} aria-hidden />
					</button>
				)}
			</Tooltip>
		);
	};

	const changeRow = (
		row: Extract<DocRow, { kind: "change" }>,
		index: number,
	) => {
		const key = `c${index}`;
		const controls = row.units.flatMap((k) => {
			const u = units.get(k);
			return u ? [{ key: k, u }] : [];
		});
		// A gone cluster's lines (the compared patch set's) are red until marked.
		const gone = controls.some(
			({ u }) => u.entry?.kind === "gone" && u.cluster.state === "unreviewed",
		);
		const tone: Tone = gone ? "removed" : row.tone;
		const struck = (html: string) => content(html, "md-old");
		let left: ReactNode = null;
		let right: ReactNode = null;
		let unified: ReactNode;
		if (row.tone === "removed") {
			left = struck(htmlOf(oldHtml, row.oldBlocks));
			unified = left;
		} else if (row.tone === "added") {
			right = content(htmlOf(newHtml, row.newBlocks), "md-new");
			unified = right;
		} else {
			const marked =
				row.oldBlocks.length === 1 && row.newBlocks.length === 1
					? pair(row.oldBlocks[0] as number, row.newBlocks[0] as number)
					: null;
			if (marked) {
				left = content(marked.old);
				right = content(marked.new);
				unified = content(marked.merged);
			} else {
				left = struck(htmlOf(oldHtml, row.oldBlocks));
				right = content(htmlOf(newHtml, row.newBlocks), "md-new");
				unified = (
					<>
						{left}
						{right}
					</>
				);
			}
		}
		const chips = controls.flatMap(({ key, u }) => {
			const chip = unitChips(u, from);
			return chip ? [<span key={key}>{chip}</span>] : [];
		});
		const notes = controls.filter(({ u }) => u.cluster.state === "crossed-off");
		return (
			<div
				key={`c${row.units.join(",")}`}
				data-testid="md-block"
				data-tone={tone}
				data-block={row.newBlocks.join(",") || undefined}
				data-old-block={row.oldBlocks.join(",") || undefined}
				data-units={row.units.join(" ")}
				className={rowClass}
				{...rowMarks(key)}
			>
				{cells({
					tone,
					onOld: row.tone === "removed",
					gutter: (
						<>
							{controls.map(({ key, u }) => (
								<div
									key={key}
									data-testid="md-box"
									data-unit={key}
									data-ws={u.ws || undefined}
									className="md-box"
								>
									<ClusterControls
										cluster={u.cluster}
										noteId={noteId(key)}
										onToggle={u.toggle}
										onCrossOff={u.crossOff}
										readOnly={props.readOnly}
									/>
									{u.ws && (
										<Tooltip content="Whitespace only" describe={false} lazy>
											{(trigger) => (
												// Focusable without a tab stop, so a tap shows the name.
												<span
													{...trigger}
													tabIndex={-1}
													role="img"
													aria-label="Whitespace only"
													data-testid="md-ws"
													className="font-mono text-faint text-xs"
												>
													~
												</span>
											)}
										</Tooltip>
									)}
								</div>
							))}
							{commentOf(row)}
							{bubbleOf(key)}
						</>
					),
					top: (chips.length > 0 || notes.length > 0) && (
						<div className="flex flex-wrap items-center gap-1 pb-1">
							{chips}
							{notes.map(({ key, u }) => (
								<span
									key={key}
									id={noteId(key)}
									className="rounded bg-crossed/20 px-1 text-done text-xs"
								>
									{u.cluster.reason
										? `Crossed off: ${u.cluster.reason}`
										: "Crossed off"}
								</span>
							))}
						</div>
					),
					unified,
					left,
					right,
				})}
				{threadsOf(key)}
			</div>
		);
	};

	const foldRow = (row: Extract<DocRow, { kind: "fold" }>) => {
		const first = row.blocks[0] as number;
		const shown = open.has(first);
		if (shown) return row.blocks.map(sameRow);
		const names = row.headings.slice(0, 3);
		const key = `f${first}`;
		const button = (
			<button
				type="button"
				data-testid="md-fold"
				aria-expanded={false}
				onClick={() => setOpen((s) => new Set(s).add(first))}
				className="md-fold"
			>
				<ChevronRightIcon size={12} aria-hidden />
				<span className="shrink-0 text-hunk-ink">
					{row.blocks.length} unchanged
				</span>
				{names.map((n) => (
					<span key={n} className="truncate">
						· {n}
					</span>
				))}
			</button>
		);
		// Threads on its blocks, or comments being written there: beside it
		// and under it, never hidden by it.
		const bubble = bubbleOf(key);
		return bubble || hasExtra(key) ? (
			<div key={key} className="md-row" {...rowMarks(key)}>
				<div className="md-gutter">{bubble}</div>
				<div className="md-body">{button}</div>
				{threadsOf(key)}
			</div>
		) : (
			<div key={key} className="md-fold-row" {...rowMarks(key)}>
				{button}
			</div>
		);
	};

	const changed = doc.rows.some((r) => r.kind === "change");
	return (
		<>
			{bar}
			{props.head}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: delegates the remote-image placeholders' and summaries' clicks. */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the placeholders are buttons, keyboard included. */}
			<div
				ref={root}
				data-testid="md-doc"
				data-changed={changed || undefined}
				onClick={onDocClick}
				className="md-doc bg-surface py-2"
			>
				{hasExtra(TOP) && (
					<div className="md-row" {...rowMarks(TOP)}>
						<div className="md-gutter">{bubbleOf(TOP)}</div>
						<div className="md-body" />
						{threadsOf(TOP)}
					</div>
				)}
				{doc.rows.map((row, i) =>
					row.kind === "same"
						? sameRow(row.block)
						: row.kind === "fold"
							? foldRow(row)
							: changeRow(row, i),
				)}
			</div>
			{from !== undefined && hunks.data && (
				// As the line view says them (SinceNotes): to read only in the
				// full diff, or nothing to read since.
				<SinceNotes
					from={from}
					clusters={file.clusters}
					kinds={props.kinds}
					hunks={hunks.data}
				/>
			)}
		</>
	);
}

/**
 * The file's unchanged lines, all of them (the context route over its
 * whole new side, `count` lines): with the hunks, both sides of the file.
 * FileDiff reads it too, so marks wait for the document as for lines.
 */
export const documentContextQuery = (
	revision: string,
	index: number,
	count: number,
	from?: number,
) => contextQuery(revision, index, 1, Math.max(count, 1), from);

/** The row key of what no block holds (a document with no rows). */
const TOP = "top";

/**
 * Whether a row's rendered text shows a find's hit: its characters, case
 * and runs of whitespace aside, in the text of the row's blocks (not its
 * threads). A link's URL, or markup, isn't there.
 */
function shows(row: Element, hit: string): boolean {
	const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
	const wanted = norm(hit);
	if (!wanted) return false;
	const text = [...row.querySelectorAll(".md-content")]
		.map((c) => c.textContent ?? "")
		.join(" ");
	return norm(text).includes(wanted);
}

/**
 * The document's clicks: a remote image's placeholder loads it (http(s)
 * only, `remoteImageUrl`), and a summary never closes its details.
 */
function onDocClick(event: MouseEvent<HTMLDivElement>) {
	const target = event.target as Element;
	if (target.closest("summary")) {
		event.preventDefault();
		return;
	}
	const button = target.closest("button.md-remote-image");
	if (!button || !event.currentTarget.contains(button)) return;
	const url = remoteImageUrl(button.getAttribute("data-remote-src"));
	if (!url) return;
	const img = document.createElement("img");
	img.referrerPolicy = "no-referrer";
	img.alt = "";
	img.src = url;
	button.replaceWith(img);
}

/** A unit's box and what it says of itself. */
interface UnitControl {
	cluster: ClusterView;
	toggle: () => void;
	crossOff: () => void;
	ws: boolean;
	entry?: KindEntry;
	carried?: ClusterView["carried"];
	linesCarried?: ClusterView["linesCarried"];
	sinceOnly?: "reverted" | "removed";
}

/** A unit's chips, as the line view's kind row shows them. */
function unitChips(u: UnitControl, from: number | undefined): ReactNode {
	const kind =
		u.entry?.kind === "gone"
			? "gone"
			: u.entry?.kind === "reworked" || u.entry?.kind === "new"
				? u.entry.kind
				: u.carried
					? "carried"
					: null;
	const lines =
		from === undefined && u.linesCarried ? size(u.linesCarried.lines) : 0;
	if (!kind && !u.sinceOnly && lines === 0) return null;
	return (
		<span data-testid="cluster-kind" className="flex items-center gap-1">
			{kind && (
				<KindChip
					kind={kind}
					from={kind === "carried" ? u.carried?.from : u.entry?.from}
					rule={u.carried?.rule}
				/>
			)}
			{u.sinceOnly && <KindChip kind={u.sinceOnly} from={from} />}
			{lines > 0 && (
				<KindChip
					kind="carried"
					count={lines}
					testId="lines-carried"
					tip={`${lines} line${lines === 1 ? "" : "s"} unchanged since PS${u.linesCarried?.from}: your marks carried over`}
				/>
			)}
		</span>
	);
}
