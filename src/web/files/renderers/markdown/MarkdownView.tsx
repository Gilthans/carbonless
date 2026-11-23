import "github-markdown-css/github-markdown-dark.css";
import "../../../githubHtml.css";
import "./markdownView.css";
import { ChevronRightIcon } from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import {
	type MouseEvent,
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { type LineRanges, size } from "../../../../shared/lineRanges";
import {
	pieceState,
	type SincePiece,
	sinceMarkKey,
	sinceOnlyState,
} from "../../../../shared/pieces";
import type {
	ClusterView,
	FileView,
	SinceMark,
} from "../../../../shared/types";
import { contextQuery, hunksQuery } from "../../../api";
import { SkeletonBar, Spinner } from "../../../Spinner";
import { Tooltip } from "../../../Tooltip";
import { ErrorMessage } from "../../../ui";
import { NOT_PHONE, useMedia } from "../../../useMedia";
import { ignoreWhitespace } from "../../../viewSettings";
import { ClusterControls } from "../../ClusterControls";
import type { DiffFind, DiffThreads } from "../../DiffBody";
import { KindChip } from "../../KindChip";
import type { Landing } from "../../landing";
import type { KindEntry } from "../../since";
import { type ImageFile, imageResolver, remoteImageUrl } from "./images";
import {
	blocksOf,
	buildDoc,
	clusterLines,
	type DocRow,
	type DocUnit,
	rebuildSides,
	type Tone,
} from "./markdownDoc";
import {
	type PairHtml,
	renderBlocks,
	renderPair,
	sideBlocks,
} from "./renderBlocks";

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
	/** Threads, find and landings: Task 7 places them on blocks. */
	threads?: DiffThreads;
	find?: DiffFind;
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
		...contextQuery(revision, file.index, 1, Math.max(count, 1), from),
		enabled: hunks.isSuccess && count > 0,
	});
	const ignoreWs = ignoreWhitespace.use();
	const wide = useMedia(NOT_PHONE);
	const split = props.sideBySide && wide;
	const pending = hunks.isPending || (count > 0 && context.isPending);
	const error = hunks.error ?? (count > 0 ? context.error : null);
	const files = props.files ?? [];

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
	const model = useMemo(() => {
		if (!hunks.data || (count > 0 && !context.data)) return null;
		try {
			const sides = rebuildSides(hunks.data, context.data ?? []);
			if (!sides) return "failed" as const;
			const oldBlocks = blocksOf(sides.old);
			const newBlocks = blocksOf(sides.new);
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
				for (const piece of hunks.data.pieces ?? []) {
					const control = pieceControl(piece, {
						clusters,
						from,
						path: file.path,
						kinds: props.kinds,
						sinceMarks: props.sinceMarks,
						onToggle: (c, p) => marks.current.onToggle(c, p),
						onCrossOff: (c, p) => marks.current.onCrossOff(c, p),
						onSinceMark: (p, cross) => marks.current.onSinceMark?.(p, cross),
					});
					if (!control) continue;
					if (ignoreWs && control.ws) continue;
					units.push({
						key: `p:${piece.hunk}:${piece.line}`,
						old: piece.old,
						new: piece.new,
						control,
					});
				}
			}
			const doc = buildDoc({ sides, oldBlocks, newBlocks, units });
			if (doc.unplaced.length > 0) return "failed" as const;
			const side = (s: "old" | "new") =>
				imageResolver({ mdPath: file.path, files, revision, side: s, from });
			const oldSide = sideBlocks(sides.old, oldBlocks);
			const newSide = sideBlocks(sides.new, newBlocks);
			return {
				doc,
				units: new Map(units.map((u) => [u.key, u.control])),
				oldHtml: renderBlocks(sides.old, oldBlocks, { image: side("old") }),
				newHtml: renderBlocks(sides.new, newBlocks, { image: side("new") }),
				pair: (o: number, n: number): PairHtml | null =>
					renderPair(oldSide, o, newSide, n, { image: side("new") }),
			};
		} catch {
			return "failed" as const;
		}
	}, [
		hunks.data,
		context.data,
		count,
		file.clusters,
		file.path,
		from,
		ignoreWs,
		props.kinds,
		props.sinceMarks,
		files,
		revision,
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
	useLayoutEffect(() => {
		for (const d of root.current?.querySelectorAll("details") ?? []) {
			d.open = true;
		}
	});
	const idBase = useId();

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
	const columns = (left: ReactNode, right: ReactNode) =>
		split ? (
			<div className="grid grid-cols-2 gap-3">
				<div className="min-w-0">{left}</div>
				<div className="min-w-0">{right}</div>
			</div>
		) : (
			<>
				{left}
				{right}
			</>
		);

	const sameRow = (block: number) => {
		const html = newHtml[block]?.html ?? "";
		return (
			<div
				key={`s${block}`}
				data-testid="md-block"
				data-tone="same"
				data-block={block}
				className="md-row"
			>
				<div className="md-gutter" />
				<div className="md-body">
					{split ? columns(content(html), content(html)) : content(html)}
				</div>
			</div>
		);
	};

	const changeRow = (row: Extract<DocRow, { kind: "change" }>) => {
		const controls = row.units.flatMap((k) => {
			const u = units.get(k);
			return u ? [{ key: k, u }] : [];
		});
		// A gone cluster's lines (the compared patch set's) are red until marked.
		const gone = controls.some(
			({ u }) => u.entry?.kind === "gone" && u.cluster.state === "unreviewed",
		);
		const tone: Tone = gone ? "removed" : row.tone;
		let body: ReactNode;
		const struck = (html: string) => content(html, "md-old");
		if (row.tone === "removed") {
			const html = struck(htmlOf(oldHtml, row.oldBlocks));
			body = split ? columns(html, null) : html;
		} else if (row.tone === "added") {
			body = split
				? columns(null, content(htmlOf(newHtml, row.newBlocks), "md-new"))
				: content(htmlOf(newHtml, row.newBlocks), "md-new");
		} else {
			const marked =
				row.oldBlocks.length === 1 && row.newBlocks.length === 1
					? pair(row.oldBlocks[0] as number, row.newBlocks[0] as number)
					: null;
			body = marked
				? split
					? columns(content(marked.old), content(marked.new))
					: content(marked.merged)
				: columns(
						struck(htmlOf(oldHtml, row.oldBlocks)),
						content(htmlOf(newHtml, row.newBlocks), "md-new"),
					);
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
				className="md-row"
			>
				<div className="md-gutter">
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
				</div>
				<div className={`md-body md-${tone}`}>
					{(chips.length > 0 || notes.length > 0) && (
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
					)}
					{body}
				</div>
			</div>
		);
	};

	const foldRow = (row: Extract<DocRow, { kind: "fold" }>) => {
		const first = row.blocks[0] as number;
		const shown = open.has(first);
		if (shown) return row.blocks.map(sameRow);
		const names = row.headings.slice(0, 3);
		return (
			<div key={`f${first}`} className="md-fold-row">
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
			</div>
		);
	};

	const changed = doc.rows.some((r) => r.kind === "change");
	return (
		<>
			{bar}
			{props.head}
			{from !== undefined && (hunks.data?.hunks.length ?? 0) === 0 && (
				// The since view of a file the author left alone: say so, never a
				// document that reads as "nothing changed" by mistake.
				<p
					data-testid="since-empty"
					className="flex min-h-10 items-center gap-2 px-3 text-muted text-xs"
				>
					Nothing to read since PS{from} ·{" "}
					{file.clusters.filter((c) => c.carried).length} carried
				</p>
			)}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: delegates the remote-image placeholders' and summaries' clicks. */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the placeholders are buttons, keyboard included. */}
			<div
				ref={root}
				data-testid="md-doc"
				data-changed={changed || undefined}
				onClick={onDocClick}
				className="md-doc bg-surface py-2"
			>
				{doc.rows.map((row) =>
					row.kind === "same"
						? sameRow(row.block)
						: row.kind === "fold"
							? foldRow(row)
							: changeRow(row),
				)}
			</div>
		</>
	);
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

/**
 * A since piece as a box (as DiffBody's `markOf`): a piece of a cluster
 * marks those of its lines; one that owns none of this snapshot's lines is
 * marked on its own (`onSinceMark`).
 */
function pieceControl(
	piece: SincePiece,
	ctx: {
		clusters: Map<string, ClusterView>;
		from: number;
		path: string;
		kinds?: Map<string, KindEntry>;
		sinceMarks?: SinceMark[];
		onToggle: (cluster: ClusterView, piece?: LineRanges) => void;
		onCrossOff: (cluster: ClusterView, piece?: LineRanges) => void;
		onSinceMark?: (piece: SincePiece, cross: boolean) => void;
	},
): UnitControl | undefined {
	const entry = piece.key ? ctx.kinds?.get(piece.key) : undefined;
	const { owns } = piece;
	if (owns) {
		const whole = piece.key ? ctx.clusters.get(piece.key) : undefined;
		if (!whole) return undefined;
		const { reviewedLines: _, crossedLines: __, reason: ___, ...rest } = whole;
		return {
			cluster: { ...rest, state: pieceState(whole, owns) },
			toggle: () => ctx.onToggle(whole, owns),
			crossOff: () => ctx.onCrossOff(whole, owns),
			ws: whole.whitespaceOnly === true,
			entry,
			carried: whole.carried,
			sinceOnly: piece.kind,
		};
	}
	return {
		cluster: {
			key: `${sinceMarkKey(ctx.from, ctx.path)}:${piece.hunk}:${piece.line}`,
			kind: "lines",
			oldStart: 0,
			oldCount: 0,
			newStart: 0,
			newCount: 0,
			removed: [],
			added: [],
			lines: size(piece.old) + size(piece.new),
			state: sinceOnlyState(ctx.sinceMarks, ctx.from, ctx.path, piece),
		},
		toggle: () => ctx.onSinceMark?.(piece, false),
		crossOff: () => ctx.onSinceMark?.(piece, true),
		ws: false,
		// A piece of its own isn't its neighbour's: only gone says where it came from.
		entry: entry?.kind === "gone" ? entry : undefined,
		sinceOnly: piece.kind,
	};
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
