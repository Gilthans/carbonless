import {
	ChevronDownIcon,
	ChevronRightIcon,
	InfoIcon,
} from "@primer/octicons-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
	Fragment,
	type PointerEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	ClusterView,
	DiffLine,
	DiffSide,
	DisplayHunk,
	FileView,
	ReviewThread,
} from "../../shared/types";
import { contextQuery, hunksQuery } from "../api";
import { CodeLine } from "../code/Invisibles";
import { Tooltip } from "../Tooltip";
import { ErrorMessage } from "../ui";
import { ignoreWhitespace, sideBySide } from "../viewSettings";
import { EXPAND_STEP, fileGaps, type Gap, gapState } from "./gaps";
import { languageFor } from "./highlight";
import type { Landing } from "./landing";
import { layoutRows, type SideRow } from "./sideBySide";
import { CONTROLS, SLOT, useStickyControls } from "./stickyControls";
import { ThreadBubble } from "./ThreadBubble";
import { ThreadRow } from "./ThreadRow";
import {
	type FilePlacement,
	type LineKey,
	lineKey,
	placeThreads,
} from "./threadPlacement";
import {
	type DiffRow,
	matchHunk,
	pairRun,
	runs,
	whitespaceOnly,
} from "./whitespace";

/** Review threads to show in a file's diff (FilesPage), and the read they come from. */
export interface DiffThreads {
	readId: string;
	snapshotHead: string;
	/** The PR's threads; placeThreads picks this file's. */
	threads: ReviewThread[];
}

/** What a row needs of the file's threads: the placement and which bubbles are open. */
interface RowThreads {
	readId: string;
	placement: FilePlacement;
	open: ReadonlySet<LineKey>;
	/** Opens the row's threads under `key` (the one they end on), or closes them (open under any of `keys`). */
	toggle: (key: LineKey, keys: LineKey[]) => void;
	idOf: (key: LineKey) => string;
	/** A row whose bubble takes focus once it shows (a gap thread opened). */
	focus: LineKey | null;
	onFocused: () => void;
}

/**
 * A whitespace-only row ("Ignore whitespace", see whitespace.ts): a removed
 * and an added line as one row with both numbers and the new side's text,
 * or one line whose twin is elsewhere, with its own number and text. Side
 * by side, each side's cell shows its own line this way.
 */
interface WsLine {
	kind: "ws";
	oldNo?: number;
	newNo?: number;
	text: string;
	noNewline?: boolean;
}

/** What a diff row shows: a line as it is, or a whitespace-only pair. */
type RowLine = DiffLine | WsLine;

const rowLine = (row: DiffRow): RowLine => {
	if (row.kind === "line") return row.line;
	const shown = (row.add ?? row.del) as DiffLine;
	return {
		kind: "ws",
		oldNo: row.del?.oldNo,
		newNo: row.add?.newNo,
		text: shown.text,
		noNewline: shown.noNewline,
	};
};

/** One side's line of a side-by-side row: as it is, or as its own whitespace-only line. */
const sideLine = (line: DiffLine, ws: boolean): RowLine =>
	ws
		? {
				kind: "ws",
				oldNo: line.oldNo,
				newNo: line.newNo,
				text: line.text,
				noNewline: line.noNewline,
			}
		: line;

/** Which side(s) a whitespace-only row shows (tests). */
const wsSide = (line: WsLine) =>
	line.oldNo !== undefined && line.newNo !== undefined
		? "pair"
		: line.oldNo !== undefined
			? "old"
			: "new";

/** The key a row's bubble (or highlight) is under: its number on either side. */
const rowKeys = (line: RowLine) =>
	[lineKey("RIGHT", line), lineKey("LEFT", line)].filter(
		(k): k is LineKey => k !== null,
	);

/**
 * The diff table's views ("Side by side" in Settings): one line per row, or
 * old-left / new-right pair rows (sideBySide.ts). The hunks are the same;
 * the view only lays their lines out.
 */
type View = "unified" | "side-by-side";

/**
 * The table's columns: rail, controls, old number, new number and code; side
 * by side, rail, controls, old number, old code, new number, new code. Every
 * row that spans the table takes this.
 */
const columnsOf = (view: View) => (view === "side-by-side" ? 6 : 5);

/** The table's shape, the same for every row. */
interface Shape {
	view: View;
	/** Digits the file's widest line number needs (three at least): the number cells' width. */
	digits: number;
}

const numberWidth = (digits: number) => ({ width: `calc(${digits}ch + 1rem)` });

/** The number columns' digits: the new file's length or the hunks' last old line, whichever is longer. */
function digitsOf(newLineCount: number, hunks: DisplayHunk[]): number {
	let max = newLineCount;
	for (const h of hunks) max = Math.max(max, h.oldStart + h.oldCount - 1);
	return Math.max(3, String(max).length);
}

const RAIL: Record<ClusterView["state"], string> = {
	unreviewed: "bg-unreviewed",
	reviewed: "bg-ok-fill",
	"crossed-off": "hatch",
};

/**
 * A reviewed cluster's lines settle down: their added/deleted tint fades to
 * a quieter one, the text keeping full contrast (the green rail and checked
 * box say it's reviewed).
 */
const REVIEWED_ROW_BG: Record<RowLine["kind"], string> = {
	context: "",
	add: "bg-add-done",
	del: "bg-del-done",
	ws: "bg-band",
};
const REVIEWED_NUMBER_BG: Record<RowLine["kind"], string> = {
	context: "text-faint",
	add: "bg-add-done text-add-ink",
	del: "bg-del-done text-del-ink",
	ws: "text-faint",
};
// A whitespace-only row is still a change, only a quiet one: no add/del
// tint, a band behind it and a `~` sign.
const ROW_BG: Record<RowLine["kind"], string> = {
	context: "",
	add: "bg-add",
	del: "bg-del",
	ws: "bg-band",
};
const NUMBER_BG: Record<RowLine["kind"], string> = {
	context: "text-faint",
	add: "bg-add-gutter text-add-ink",
	del: "bg-del-gutter text-del-ink",
	ws: "text-faint",
};
const SIGN_COLOR: Record<RowLine["kind"], string> = {
	context: "text-faint",
	add: "text-add-ink",
	del: "text-del-ink",
	ws: "text-faint",
};
const SIGN: Record<RowLine["kind"], string> = {
	context: " ",
	add: "+",
	del: "−",
	ws: "~",
};

const NO_NEWLINE = "\\ No newline at end of file";

/** The left rail: cluster state, the accent while the cluster has focus or the pointer. */
function Rail({ state }: { state?: ClusterView["state"] }) {
	const color = state
		? `${RAIL[state]} group-hover:bg-accent group-hover:bg-none group-focus-within:bg-accent group-focus-within:bg-none`
		: "";
	return <td aria-hidden className={`w-1 min-w-1 p-0 ${color}`} />;
}

/** The cluster's controls column (empty but on a cluster's first row); `className` adds to it (a taller row's padding). */
function ControlsCell(props: { children?: ReactNode; className?: string }) {
	return (
		<td
			className={`w-11 px-1 align-top whitespace-nowrap pointer-coarse:w-20 ${props.className ?? ""}`}
		>
			{props.children}
		</td>
	);
}

/**
 * What a row or cell's threads make of it: the commented mark, its bubble's
 * threads, the key they end on (what the opened row is kept under, the same
 * in both views: a unified `~` pair's old-side thread is under LEFT, where
 * the side-by-side left cell finds it) and whether its row is open.
 */
function cellThreads(keys: LineKey[], threads: RowThreads | undefined) {
	const commented = keys.some((k) => threads?.placement.covered.has(k));
	const endKey = keys.find((k) => threads?.placement.end.has(k));
	const ending = keys.flatMap((k) => threads?.placement.end.get(k) ?? []);
	const open = keys.some((k) => threads?.open.has(k));
	return { commented, ending, endKey, open };
}

/** The sign before a line's text: `+`, `−`, a space, or `~` named "Whitespace only". */
function Sign({ kind }: { kind: RowLine["kind"] }) {
	if (kind === "ws") {
		return (
			<Tooltip content="Whitespace only" describe={false} lazy>
				{(trigger) => (
					// Focusable without a tab stop, so a tap shows the name.
					<span
						{...trigger}
						role="img"
						aria-label="Whitespace only"
						tabIndex={-1}
						className={`mr-2 select-none ${SIGN_COLOR.ws} focus-visible:outline-2 focus-visible:outline-accent`}
					>
						{SIGN.ws}
					</span>
				)}
			</Tooltip>
		);
	}
	return (
		<span aria-hidden className={`mr-2 select-none ${SIGN_COLOR[kind]}`}>
			{SIGN[kind]}
		</span>
	);
}

/** A line's number on one side (`old`/`new`), as wide as the file's numbers need. */
function NumberCell(props: {
	side: DiffSide;
	n?: number;
	digits: number;
	className: string;
}) {
	return (
		<td
			data-testid={props.side === "LEFT" ? "old" : "new"}
			data-side={props.side}
			style={numberWidth(props.digits)}
			className={`px-2 text-right align-top select-none ${props.className}`}
		>
			{props.n}
		</td>
	);
}

/**
 * A line's code: its bubble (threads ending on it), sign and text. Unified,
 * the row carries the paint and the line keeps its width (the table scrolls
 * sideways); side by side the cell is painted and wraps (tabs keep their
 * width), so a long line grows its row and the other side stays aligned.
 */
function CodeCell(props: {
	side: DiffSide;
	line: RowLine;
	lang: string | null;
	tabWidth?: number;
	bubble?: ReactNode;
	/** Side by side only: the cell's own paint, kind, landing and mark. */
	cell?: { paint: string; landed: boolean; commented: boolean };
}) {
	const { line, cell } = props;
	return (
		<td
			data-testid="code"
			data-side={props.side}
			data-kind={cell ? line.kind : undefined}
			data-landed={cell?.landed || undefined}
			data-commented={cell?.commented ? "" : undefined}
			// Top-aligned next to its number, however tall the other side makes the row.
			className={`${cell ? "align-top whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"} ${props.bubble ? "pr-12 pl-2" : "px-2"} ${cell?.paint ?? ""}`}
		>
			{props.bubble}
			<Sign kind={line.kind} />
			<CodeLine
				text={line.text}
				lang={props.lang}
				tabWidth={props.tabWidth}
				newline={!line.noNewline}
			/>
		</td>
	);
}

/** A side with no line: both its cells say so, in the band tone, with nothing in them. */
function BlankCells({ side, digits }: { side: DiffSide; digits: number }) {
	return (
		<>
			<td
				data-testid={side === "LEFT" ? "old" : "new"}
				data-blank=""
				style={numberWidth(digits)}
				className="bg-band"
			/>
			<td data-testid="code" data-blank="" className="bg-band" />
		</>
	);
}

/** What every row of a line takes from its hunk and file. */
interface RowProps {
	shape: Shape;
	lang: string | null;
	tabWidth?: number;
	state?: ClusterView["state"];
	checkbox?: ReactNode;
	landed: Landed | null;
	threads?: RowThreads;
}

/**
 * git's "No newline at end of file" under a line: unified, one note across
 * the row; side by side, the note in the cell of each side whose line lacks
 * it (a context line lacking it shows it on both).
 */
function NoNewlineRow(props: {
	shape: Shape;
	state?: ClusterView["state"];
	left?: boolean;
	right?: boolean;
}) {
	const columns = columnsOf(props.shape.view);
	if (props.shape.view === "unified") {
		return (
			<tr data-testid="no-newline">
				<Rail state={props.state} />
				<td colSpan={columns - 1} className="px-2 text-muted italic">
					{NO_NEWLINE}
				</td>
			</tr>
		);
	}
	return (
		<tr data-testid="no-newline" className="text-muted italic">
			<Rail state={props.state} />
			<ControlsCell />
			<td />
			<td className="px-2">{props.left && NO_NEWLINE}</td>
			<td />
			<td className="px-2">{props.right && NO_NEWLINE}</td>
		</tr>
	);
}

/** One line as a unified row: its numbers on both sides and its code. */
function LineRow(props: RowProps & { line: RowLine }) {
	const { line, state, threads, shape } = props;
	const reviewed = state === "reviewed";
	const keys = threads ? rowKeys(line) : [];
	// A context row is two lines, RIGHT by its new number and LEFT by its
	// old one: threads ending on either share its bubble.
	const { commented, ending, endKey, open } = cellThreads(keys, threads);
	const landed = landedPhase(props.landed, line);
	const rowBg = (reviewed ? REVIEWED_ROW_BG : ROW_BG)[line.kind];
	const numberBg = (reviewed ? REVIEWED_NUMBER_BG : NUMBER_BG)[line.kind];
	// A pair row has both numbers: a thread on its old side is named by it.
	const onOld =
		line.newNo === undefined ||
		(line.kind === "ws" &&
			ending.length > 0 &&
			ending.every((t) => t.anchor?.side === "LEFT"));
	const where = onOld ? `on old line ${line.oldNo}` : `on line ${line.newNo}`;
	// The commented range: the accent stripe and tinted numbers (thread-mark),
	// unlike a landed line's tint and rail; not while it is landed on.
	const mark = commented && landed !== "on" ? "thread-mark" : "";
	return (
		<>
			<tr
				data-testid="diff-line"
				data-kind={line.kind}
				data-ws={line.kind === "ws" ? wsSide(line) : undefined}
				data-reviewed={reviewed || undefined}
				data-old-no={line.oldNo}
				data-new-no={line.newNo}
				data-landed={landed === "on" || undefined}
				data-commented={commented ? "" : undefined}
				className={`${rowBg} ${landed ? LANDED_CLASS[landed] : ""} ${mark}`}
			>
				<Rail state={state} />
				<ControlsCell>{props.checkbox}</ControlsCell>
				<NumberCell
					side="LEFT"
					n={line.oldNo}
					digits={shape.digits}
					className={numberBg}
				/>
				<NumberCell
					side="RIGHT"
					n={line.newNo}
					digits={shape.digits}
					className={numberBg}
				/>
				<CodeCell
					side={line.newNo === undefined ? "LEFT" : "RIGHT"}
					line={line}
					lang={props.lang}
					tabWidth={props.tabWidth}
					bubble={
						endKey &&
						threads && (
							<ThreadBubble
								inline
								threads={ending}
								where={where}
								open={open}
								controls={open ? threads.idOf(endKey) : undefined}
								onToggle={() => threads.toggle(endKey, keys)}
								focus={threads.focus !== null && keys.includes(threads.focus)}
								onFocused={threads.onFocused}
							/>
						)
					}
				/>
			</tr>
			{line.noNewline && <NoNewlineRow shape={shape} state={state} />}
			{open && endKey && threads && (
				<ThreadRow
					id={threads.idOf(endKey)}
					readId={threads.readId}
					threads={ending}
					columns={columnsOf(shape.view)}
					rail={state ? RAIL[state] : undefined}
				/>
			)}
		</>
	);
}

/** One side's cell of a pair row: its line, what its threads make of it, and its landing. */
interface Cell {
	line: RowLine;
	keys: LineKey[];
	commented: boolean;
	ending: ReviewThread[];
	endKey?: LineKey;
	open: boolean;
	landed?: Landed["phase"];
	where: string;
}

/**
 * One row of the side-by-side table: a context line on both sides, or a
 * pair with a line on each side that has one (sideBySide.ts). Each cell is
 * under its own side's key, with its own paint, mark, bubble, landing and
 * opened thread row (the left side's first); a context line is one line
 * shown twice: its bubble is in the right cell, under both its keys, and
 * its mark and landing paint both cells.
 */
function PairRow(props: RowProps & { row: SideRow }) {
	const { row, state, threads, shape } = props;
	const reviewed = state === "reviewed";
	const cellOf = (line: RowLine, keys: LineKey[], where: string): Cell => ({
		line,
		keys,
		...cellThreads(keys, threads),
		landed: landedPhase(props.landed, line),
		where,
	});
	let left: Cell | undefined;
	let right: Cell | undefined;
	if (row.kind === "context") {
		const line = row.line;
		right = cellOf(line, threads ? rowKeys(line) : [], `on line ${line.newNo}`);
		left = { ...right, keys: [], ending: [], endKey: undefined, open: false };
	} else {
		if (row.del) {
			const line = sideLine(row.del, row.ws);
			left = cellOf(
				line,
				threads ? rowKeys(line) : [],
				`on old line ${line.oldNo}`,
			);
		}
		if (row.add) {
			const line = sideLine(row.add, row.ws);
			right = cellOf(
				line,
				threads ? rowKeys(line) : [],
				`on line ${line.newNo}`,
			);
		}
	}
	const phase = left?.landed ?? right?.landed;
	const commented = Boolean(left?.commented || right?.commented);
	const cells = (side: DiffSide, cell: Cell | undefined) => {
		if (!cell) return <BlankCells side={side} digits={shape.digits} />;
		const { line, keys, endKey } = cell;
		// The landing's tint, else the commented range's stripe and numbers.
		const mark =
			cell.landed === "on"
				? "mark-tint-cell"
				: cell.commented
					? "thread-mark-cell"
					: "";
		const numberBg = (reviewed ? REVIEWED_NUMBER_BG : NUMBER_BG)[line.kind];
		const bg = (reviewed ? REVIEWED_ROW_BG : ROW_BG)[line.kind];
		return (
			<>
				<NumberCell
					side={side}
					n={side === "LEFT" ? line.oldNo : line.newNo}
					digits={shape.digits}
					className={`${numberBg} ${mark}`}
				/>
				<CodeCell
					side={side}
					line={line}
					lang={props.lang}
					tabWidth={props.tabWidth}
					cell={{
						paint: `${bg} ${mark}`,
						landed: cell.landed === "on",
						commented: cell.commented,
					}}
					bubble={
						endKey &&
						threads && (
							<ThreadBubble
								inline
								threads={cell.ending}
								where={cell.where}
								open={cell.open}
								controls={cell.open ? threads.idOf(endKey) : undefined}
								onToggle={() => threads.toggle(endKey, keys)}
								focus={threads.focus !== null && keys.includes(threads.focus)}
								onFocused={threads.onFocused}
							/>
						)
					}
				/>
			</>
		);
	};
	const noNewline = {
		left: Boolean(left?.line.noNewline),
		right: Boolean(right?.line.noNewline),
	};
	return (
		<>
			<tr
				data-testid="diff-line"
				data-kind={row.kind}
				data-reviewed={reviewed || undefined}
				data-old-no={left?.line.oldNo}
				data-new-no={right?.line.newNo}
				data-landed={phase === "on" || undefined}
				data-commented={commented ? "" : undefined}
				className={phase ? LANDED_ROW[phase] : ""}
			>
				<Rail state={state} />
				<ControlsCell>{props.checkbox}</ControlsCell>
				{cells("LEFT", left)}
				{cells("RIGHT", right)}
			</tr>
			{(noNewline.left || noNewline.right) && (
				<NoNewlineRow shape={shape} state={state} {...noNewline} />
			)}
			{[left, right].map(
				(cell) =>
					cell?.open &&
					cell.endKey &&
					threads && (
						<ThreadRow
							key={cell.endKey}
							id={threads.idOf(cell.endKey)}
							readId={threads.readId}
							threads={cell.ending}
							columns={columnsOf(shape.view)}
							rail={state ? RAIL[state] : undefined}
						/>
					),
			)}
		</>
	);
}

/**
 * A cluster's controls. The checkbox is checked when reviewed; a crossed-off
 * cluster shows a mixed box named "Undo cross-off" and described by its note,
 * and clicking it makes the cluster unreviewed again, never reviewed. Next to
 * it, a toggle crosses the cluster off or undoes that (to unreviewed); a
 * reviewed cluster must be unchecked first.
 */
function ClusterControls(props: {
	cluster: ClusterView;
	noteId?: string;
	onToggle: (cluster: ClusterView) => void;
	onCrossOff: (cluster: ClusterView) => void;
}) {
	const crossedOff = props.cluster.state === "crossed-off";
	// On touch each control gets its own 40×40 target, side by side so a
	// mis-tap can't reach the other one; the negative margins keep the row
	// height. With a mouse they stay compact.
	const target =
		"flex items-center justify-center pointer-coarse:-my-2.5 pointer-coarse:h-10 pointer-coarse:w-10";
	return (
		// The slot keeps its size while the controls float (stickyControls.ts).
		<span {...{ [SLOT]: "" }} className="block">
			<span
				{...{ [CONTROLS]: "" }}
				className="z-[5] flex w-fit items-center gap-1 rounded-md pointer-coarse:gap-0 data-[stuck]:bg-raised data-[stuck]:shadow-control data-[stuck]:ring-1 data-[stuck]:ring-line-strong"
			>
				<label
					data-testid="cluster-box-target"
					className={`${target} cursor-pointer`}
				>
					<input
						type="checkbox"
						aria-label={crossedOff ? "Undo cross-off" : "Mark cluster reviewed"}
						aria-describedby={crossedOff ? props.noteId : undefined}
						ref={(box) => {
							if (box) box.indeterminate = crossedOff;
						}}
						checked={props.cluster.state === "reviewed"}
						onChange={() => props.onToggle(props.cluster)}
						className={`h-3.5 w-3.5 cursor-pointer ${
							crossedOff ? "accent-crossed" : "accent-ok-fill"
						}`}
					/>
				</label>
				<Tooltip
					content={crossedOff ? "Undo cross-off" : "Cross off cluster"}
					describe={false}
				>
					{(trigger) => (
						<button
							type="button"
							{...trigger}
							aria-label="Cross off cluster"
							aria-pressed={crossedOff}
							disabled={props.cluster.state === "reviewed"}
							onClick={() => props.onCrossOff(props.cluster)}
							className={`${target} group/x rounded focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-30`}
						>
							<span
								aria-hidden
								className={`flex h-4 w-4 items-center justify-center rounded font-sans text-xs leading-none ${
									crossedOff
										? "bg-crossed-strong text-ink"
										: "text-done group-hover/x:bg-crossed/25"
								}`}
							>
								⊘
							</span>
						</button>
					)}
				</Tooltip>
			</span>
		</span>
	);
}

function CrossedOffNote(props: { cluster: ClusterView; id?: string }) {
	if (props.cluster.state !== "crossed-off") return null;
	return (
		<span
			id={props.id}
			className="ml-2 rounded bg-crossed/20 px-1 font-sans text-done"
		>
			{props.cluster.reason
				? `Crossed off: ${props.cluster.reason}`
				: "Crossed off"}
		</span>
	);
}

/**
 * A thread's lines further than this from a gap's loaded edge load on
 * their own (a few around them), not the whole way from the edge.
 */
const FAR = 200;

/**
 * The runs of a gap's lines that aren't loaded, top down (lines on their way
 * or failed are in them: their run's row says so).
 */
function hiddenRuns(
	gap: Gap,
	loaded: ReadonlyMap<number, DiffLine>,
): { from: number; to: number }[] {
	const runs: { from: number; to: number }[] = [];
	for (let n = gap.from; n <= gap.to; n++) {
		if (loaded.has(n)) continue;
		const last = runs[runs.length - 1];
		if (last && last.to === n - 1) last.to = n;
		else runs.push({ from: n, to: n });
	}
	return runs;
}

/** One click's worth of lines for each way a gap can grow. */
function expansions(gap: Gap, top: number, bottom: number, remaining: number) {
	const start = gap.from + top;
	const end = gap.to - bottom;
	const plural = (n: number) => `${n} ${n === 1 ? "line" : "lines"}`;
	if (gap.above && gap.below && remaining <= EXPAND_STEP) {
		return [
			{
				glyph: "↕",
				label: `Load all ${plural(remaining)}`,
				from: start,
				to: end,
			},
		];
	}
	const step = Math.min(EXPAND_STEP, remaining);
	const result = [];
	if (gap.above) {
		result.push({
			glyph: "↓",
			label: `Load ${plural(step)} below`,
			from: start,
			to: start + step - 1,
		});
	}
	if (gap.below) {
		result.push({
			glyph: "↑",
			label: `Load ${plural(step)} above`,
			from: end - step + 1,
			to: end,
		});
	}
	return result;
}

const hunkHeader = (h: DisplayHunk) =>
	`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`;

/** The expanded file: file-level clusters, then hunks with loadable context between them. */
export function DiffBody(props: {
	file: FileView;
	revision: string;
	onToggle: (cluster: ClusterView) => void;
	onCrossOff: (cluster: ClusterView) => void;
	landing?: Landing;
	/** Review threads to place on the lines (annotations only: they change no review state). */
	threads?: DiffThreads;
}) {
	const { file, revision } = props;
	const hunks = useQuery(hunksQuery(revision, file.index));
	const ignoreWs = ignoreWhitespace.use();
	const view: View = sideBySide.use() ? "side-by-side" : "unified";
	const digits = hunks.data
		? digitsOf(hunks.data.newLineCount, hunks.data.hunks)
		: 3;
	const shape = useMemo<Shape>(() => ({ view, digits }), [view, digits]);
	const columns = columnsOf(view);
	const [ranges, setRanges] = useState<[number, number][]>([]);
	const contexts = useQueries({
		queries: ranges.map(([from, to]) =>
			contextQuery(revision, file.index, from, to),
		),
	});
	const lang = languageFor(file.path);
	const clusters = new Map(file.clusters.map((c) => [c.key, c]));
	const idBase = useId();
	const noteIds = new Map(
		file.clusters.map((c, i) => [c.key, `${idBase}-note-${i}`]),
	);
	const noteId = (cluster: ClusterView) => noteIds.get(cluster.key);
	const fileClusters = file.clusters.filter((c) => c.kind === "file");
	const root = useRef<HTMLDivElement>(null);
	const scroller = useRef<HTMLDivElement>(null);
	const table = useRef<HTMLTableElement>(null);
	useStickyControls(root, scroller);
	useVisibleWidth(scroller);
	const onPointerDown = useOneSideSelection(table, view);
	const { hint, landed, pending } = useLanding(
		root,
		props.landing,
		hunks.isSuccess,
	);
	// The line a thread link is about to land on (so a collapsed cluster
	// holding it is open by the time the landing looks); once it has
	// landed, `landed` keeps the cluster open while the highlight lasts.
	const landingLine: LandingLine | null =
		pending && props.landing?.line !== undefined && !props.landing.moved
			? { old: props.landing.side === "LEFT", line: props.landing.line }
			: null;

	const loaded = new Map<number, DiffLine>();
	for (const result of contexts) {
		for (const line of result.data ?? []) {
			if (line.newNo !== undefined) loaded.set(line.newNo, line);
		}
	}
	/**
	 * Lines that are shown, on their way, or failed (and wait for Retry). A
	 * line a finished range didn't return stays hidden, so it can be loaded
	 * again instead of waiting forever.
	 */
	const taken = new Set(loaded.keys());
	const loadedRanges = ranges.map(([from, to], i) => ({
		from,
		to,
		result: contexts[i],
	}));
	for (const { from, to, result } of loadedRanges) {
		if (result && !result.isSuccess) {
			for (let n = from; n <= to; n++) taken.add(n);
		}
	}
	const addRange = (from: number, to: number) =>
		setRanges((r) =>
			r.some(([f, t]) => f === from && t === to) ? r : [...r, [from, to]],
		);

	// Where the file's threads sit (all start closed). Opening one only
	// shows it: no review state changes.
	const placement = props.threads
		? placeThreads({
				threads: props.threads.threads,
				path: file.path,
				snapshotHead: props.threads.snapshotHead,
				hunks: hunks.data ?? null,
				loadedContext: [...loaded.values()],
				noLines: file.binary || file.submodule,
			})
		: null;
	const [openThreads, setOpenThreads] = useState<ReadonlySet<LineKey>>(
		() => new Set(),
	);
	const [focusThread, setFocusThread] = useState<LineKey | null>(null);
	// A gap's window that failed drops its focus target, so a later Retry
	// doesn't take focus from wherever the reader is by then.
	const windowFailed = contexts.some((c) => c.isError);
	useEffect(() => {
		if (windowFailed) setFocusThread(null);
	}, [windowFailed]);
	const toggleThreads = (key: LineKey, keys: LineKey[]) => {
		setFocusThread(null);
		setOpenThreads((open) => {
			const next = new Set(open);
			if (keys.some((k) => next.has(k))) for (const k of keys) next.delete(k);
			else next.add(key);
			return next;
		});
	};
	const rowThreads: RowThreads | undefined =
		placement && props.threads
			? {
					readId: props.threads.readId,
					placement,
					open: openThreads,
					toggle: toggleThreads,
					idOf: (key) => `${idBase}-thread-${key}`,
					focus: focusThread,
					onFocused: () => setFocusThread(null),
				}
			: undefined;

	const checkbox = (cluster: ClusterView) => (
		<ClusterControls
			cluster={cluster}
			noteId={noteId(cluster)}
			onToggle={props.onToggle}
			onCrossOff={props.onCrossOff}
		/>
	);

	const contextRows = (from: number, to: number) => {
		const rows: ReactNode[] = [];
		for (let n = from; n <= to; n++) {
			const line = loaded.get(n);
			if (line) {
				const row = {
					shape,
					lang,
					tabWidth: file.tabWidth,
					landed,
					threads: rowThreads,
				};
				rows.push(
					view === "side-by-side" ? (
						<PairRow key={`c${n}`} row={{ kind: "context", line }} {...row} />
					) : (
						<LineRow key={`c${n}`} line={line} {...row} />
					),
				);
			}
		}
		return rows;
	};

	/**
	 * A gap: its loaded lines, and a row for each run still hidden between
	 * them (its ↑/↓ buttons, "N hidden lines", loading or Retry, and a bubble
	 * for the threads whose line is in it).
	 */
	const gapRows = (gap: Gap | undefined) => {
		if (!gap) return null;
		const gapThreads = placement?.gaps.get(gap.index) ?? [];
		const runs = hiddenRuns(gap, loaded);
		const targetOf = (t: ReviewThread) => placement?.gapTargets.get(t);
		// Each thread goes on the run holding its line (the nearest one if
		// none does; a run of its own if the gap has none left).
		const threadsOf = new Map<number, ReviewThread[]>();
		for (const t of gapThreads) {
			const n = targetOf(t)?.show[1] ?? gap.from;
			let at = runs.findIndex((r) => r.from <= n && n <= r.to);
			if (at < 0 && runs.length === 0) {
				// Every line is loaded: an empty run after them carries it.
				runs.push({ from: gap.to + 1, to: gap.to });
				at = 0;
			}
			if (at < 0) {
				at = runs.reduce(
					(best, r, i) =>
						Math.abs(r.from - n) < Math.abs((runs[best]?.from ?? 0) - n)
							? i
							: best,
					0,
				);
			}
			threadsOf.set(at, [...(threadsOf.get(at) ?? []), t]);
		}
		const rows: ReactNode[] = [];
		let next = gap.from;
		runs.forEach((run, i) => {
			rows.push(...contextRows(next, run.from - 1));
			next = run.to + 1;
			const part: Gap = {
				index: gap.index,
				from: run.from,
				to: run.to,
				above: run.from > gap.from || gap.above,
				below: run.to < gap.to || gap.below,
			};
			const { top, bottom, remaining } = gapState(part, taken);
			const inRun = loadedRanges.filter(
				(r) => r.from <= run.to && r.to >= run.from,
			);
			const failed = inRun.flatMap((r) =>
				r.result?.isError ? [r.result] : [],
			);
			const pending = inRun.some((r) => r.result?.isPending);
			const buttons =
				remaining > 0 ? expansions(part, top, bottom, remaining) : [];
			const runThreads = threadsOf.get(i) ?? [];
			if (
				remaining === 0 &&
				!pending &&
				failed.length === 0 &&
				runThreads.length === 0
			) {
				return;
			}
			const start = run.from + top;
			const end = run.to - bottom;
			/**
			 * Opens the run's threads where they are: loads their lines (from
			 * the nearer edge when it's close, else just around them) and opens
			 * each on its row, its bubble focused.
			 */
			const openRunThreads = () => {
				for (const t of runThreads) {
					const target = targetOf(t);
					if (!target) continue;
					const [from, to] = target.show;
					const window: [number, number] =
						from - start <= FAR && from - start <= end - to
							? [start, Math.min(end, to + 3)]
							: end - to <= FAR
								? [Math.max(start, from - 3), end]
								: [Math.max(start, from - 10), Math.min(end, to + 3)];
					if (window[0] <= window[1]) addRange(window[0], window[1]);
					setOpenThreads((open) => new Set(open).add(target.key));
					setFocusThread(target.key);
				}
			};
			const where =
				run.from === run.to
					? `on hidden line ${run.from}`
					: `on hidden lines ${run.from}–${run.to}`;
			rows.push(
				<tr
					key={`gap${gap.index}:${run.from}`}
					data-testid="gap-row"
					className="bg-hunk text-hunk-ink"
				>
					<td colSpan={2} className="px-1">
						<div className="flex">
							{buttons.map((b) => (
								<Tooltip key={b.glyph} content={b.label} describe={false}>
									{(trigger) => (
										<button
											type="button"
											{...trigger}
											aria-label={b.label}
											onClick={() => addRange(b.from, b.to)}
											className="rounded px-1 hover:bg-pressed hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
										>
											{b.glyph}
										</button>
									)}
								</Tooltip>
							))}
						</div>
					</td>
					<td
						colSpan={columns - 2}
						className={`font-sans ${runThreads.length ? "pr-12 pl-2" : "px-2"}`}
					>
						{runThreads.length > 0 && (
							<ThreadBubble
								inline
								threads={runThreads}
								where={where}
								open={false}
								onToggle={openRunThreads}
							/>
						)}
						{failed.length > 0 ? (
							<span role="alert" className="text-bad">
								{failed[0]?.error?.message}{" "}
								<button
									type="button"
									onClick={() => {
										for (const f of failed) void f.refetch();
									}}
									className="rounded border border-bad/60 px-1.5 text-xs hover:bg-bad/15 focus-visible:outline-2 focus-visible:outline-accent"
								>
									Retry
								</button>
							</span>
						) : pending ? (
							"Loading…"
						) : remaining > 0 ? (
							`${remaining} hidden ${remaining === 1 ? "line" : "lines"}`
						) : null}
					</td>
				</tr>,
			);
		});
		rows.push(...contextRows(next, gap.to));
		return <tbody key={`gap${gap.index}`}>{rows}</tbody>;
	};

	const gaps = hunks.data
		? fileGaps(hunks.data.hunks, hunks.data.newLineCount)
		: [];
	const gapAt = (index: number) => gaps.find((g) => g.index === index);

	return (
		<div ref={root}>
			{hint && <LandingHint hint={hint} />}
			<div ref={scroller} className="overflow-x-auto">
				{/*
				 * Unified, the table is as wide as its longest line and scrolls in
				 * the div; side by side it is the div's width, its two code columns
				 * equal (the fixed layout with the other columns' widths), and the
				 * lines wrap in their cells.
				 */}
				<table
					ref={table}
					data-view={view}
					onPointerDown={onPointerDown}
					className={`border-collapse bg-code font-mono text-xs leading-5 text-code-ink ${
						view === "side-by-side" ? "w-full table-fixed" : "min-w-full"
					}`}
				>
					{view === "side-by-side" && (
						<colgroup>
							<col className="w-1" />
							<col className="w-11 pointer-coarse:w-20" />
							<col style={numberWidth(digits)} />
							<col />
							<col style={numberWidth(digits)} />
							<col />
						</colgroup>
					)}
					{fileClusters.map((cluster) => (
						<tbody key={cluster.key} className="group">
							<tr className={cluster.state === "reviewed" ? "text-muted" : ""}>
								<Rail state={cluster.state} />
								<ControlsCell className="py-1">
									{checkbox(cluster)}
								</ControlsCell>
								<td
									colSpan={columns - 2}
									className="px-2 py-1 font-sans text-sm"
								>
									{cluster.label}
									<CrossedOffNote cluster={cluster} id={noteId(cluster)} />
								</td>
							</tr>
						</tbody>
					))}
					{hunks.data?.hunks.map((hunk, index) => (
						<Fragment key={hunkHeader(hunk)}>
							{gapRows(gapAt(index))}
							<HunkRows
								hunk={hunk}
								clusters={clusters}
								lang={lang}
								tabWidth={file.tabWidth}
								checkbox={checkbox}
								noteId={noteId}
								landed={landed}
								landingLine={landingLine}
								threads={rowThreads}
								ignoreWhitespace={ignoreWs}
								shape={shape}
							/>
						</Fragment>
					))}
					{hunks.data && gapRows(gapAt(hunks.data.hunks.length))}
				</table>
			</div>
			{hunks.isPending && (
				// A screen tall while loading, so a file picked in the tree can
				// scroll its header to the top before its lines arrive.
				<p className="min-h-[100dvh] px-3 py-2 text-sm text-muted">
					Loading diff…
				</p>
			)}
			{hunks.isError && (
				<div className="p-2">
					<ErrorMessage error={hunks.error} />
				</div>
			)}
		</div>
	);
}

/**
 * Side by side, a text selection stays on one side: the table carries
 * `data-selecting="old" | "new"` while a selection is on that side, and the
 * CSS (index.css) makes the other side's code cells `user-select: none`, so
 * dragging across the table selects one side and Copy gives its lines. The
 * mark is set as soon as the pointer goes down on a cell with a side (before
 * the selection exists), then follows the document's selection: its anchor
 * cell's side, or none once the selection is collapsed, elsewhere, or the
 * view is unified. Line numbers and signs are `select-none` on their own.
 */
const selectingSide = (node: Node | null): "old" | "new" | undefined => {
	const el = node instanceof Element ? node : node?.parentElement;
	const side = el?.closest<HTMLElement>("td[data-side]")?.dataset.side;
	return side === "LEFT" ? "old" : side === "RIGHT" ? "new" : undefined;
};

const markSelecting = (
	table: HTMLTableElement,
	side: "old" | "new" | undefined,
) => {
	if (side) table.dataset.selecting = side;
	else delete table.dataset.selecting;
};

function useOneSideSelection(
	table: RefObject<HTMLTableElement | null>,
	view: View,
) {
	useEffect(() => {
		const el = table.current;
		if (view !== "side-by-side" || !el) return;
		const onSelectionChange = () => {
			const selection = document.getSelection();
			const anchor =
				selection && !selection.isCollapsed ? selection.anchorNode : null;
			markSelecting(
				el,
				anchor && el.contains(anchor) ? selectingSide(anchor) : undefined,
			);
		};
		document.addEventListener("selectionchange", onSelectionChange);
		return () => {
			document.removeEventListener("selectionchange", onSelectionChange);
			markSelecting(el, undefined);
		};
	}, [table, view]);
	if (view !== "side-by-side") return undefined;
	return (event: PointerEvent<HTMLTableElement>) => {
		const side = selectingSide(event.target as Node);
		if (side) markSelecting(event.currentTarget, side);
	};
}

/**
 * Keeps `--diff-w` on the scroller at its visible width, so an opened
 * thread inside the (sideways scrolling) table fits the screen.
 */
function useVisibleWidth(scroller: RefObject<HTMLDivElement | null>) {
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const set = () => el.style.setProperty("--diff-w", `${el.clientWidth}px`);
		set();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(set);
		observer.observe(el);
		return () => observer.disconnect();
	}, [scroller]);
}

/** How long a landed-on line stays highlighted before it fades. */
export const LANDED_MS = 2500;
/** How long its fade takes (the row's transition, below). */
const FADE_MS = 1000;
/**
 * A landed row's own part: the accent rail over the cluster's own while it
 * lasts; while fading, only the transition, so the tint fades out (and never
 * in: it shows at once). Side by side, the tint is the landed cell's
 * (mark-tint-cell).
 */
const LANDED_ROW = {
	on: "[&>td:first-child]:bg-accent!",
	fading:
		"[&>td]:transition-shadow [&>td]:duration-1000 motion-reduce:[&>td]:transition-none",
} as const;
/** A landed unified row: the tint over every cell, and the rail. */
const LANDED_CLASS = {
	on: `mark-tint ${LANDED_ROW.on}`,
	fading: LANDED_ROW.fading,
} as const;

/** The landed-on line, by its number on one side, and how far along it is. */
export interface Landed {
	old: boolean;
	line: number;
	phase: keyof typeof LANDED_CLASS;
}

const landedPhase = (landed: Landed | null, line: RowLine) =>
	landed && (landed.old ? line.oldNo : line.newNo) === landed.line
		? landed.phase
		: undefined;

/** A line a thread link is landing on, by its number on one side. */
interface LandingLine {
	old: boolean;
	line: number;
}

const landingOn = (target: LandingLine | null, line: RowLine) =>
	target !== null && (target.old ? line.oldNo : line.newNo) === target.line;

/** Why a landing found no line: the text and its tooltip. */
interface Hint {
	text: string;
	tip: string;
}

/**
 * Follows a thread link's landing once the hunks are in: scrolls the line
 * just below the sticky headers and highlights it for a moment, or, when the
 * line isn't shown (or was numbered on another commit), scrolls to the file
 * and returns the hint to show at its top. Each landing (`seq`) runs once.
 */
function useLanding(
	root: RefObject<HTMLDivElement | null>,
	landing: Landing | undefined,
	ready: boolean,
): { hint: Hint | null; landed: Landed | null; pending: boolean } {
	const [hint, setHint] = useState<Hint | null>(null);
	const [landed, setLanded] = useState<Landed | null>(null);
	const done = useRef(0);
	// Until the landing below has run (it sets state when it does).
	const pending =
		landing !== undefined && ready && done.current !== landing.seq;
	useEffect(() => {
		const el = root.current;
		if (!landing || !ready || !el || done.current === landing.seq) return;
		done.current = landing.seq;
		const section = el.closest("section");
		const header = section?.querySelector("header");
		const vars = getComputedStyle(el);
		const sticky =
			(Number.parseFloat(vars.getPropertyValue("--app-header")) || 0) +
			(Number.parseFloat(vars.getPropertyValue("--files-bar")) || 0) +
			(header?.offsetHeight ?? 0);
		const scrollTo = (target: Element, margin: number) =>
			window.scrollTo({
				top:
					target.getBoundingClientRect().top + window.scrollY - sticky - margin,
			});
		const old = landing.side === "LEFT";
		const where = `${old ? "Old line" : "Line"} ${landing.line}`;
		const row =
			landing.line === undefined || landing.moved
				? null
				: el.querySelector(
						`tr[data-${old ? "old" : "new"}-no="${landing.line}"]`,
					);
		if (!row) {
			setHint(
				landing.line === undefined
					? null
					: landing.moved
						? {
								text: `${where} is from another commit`,
								tip: "Commented on another commit: the line may have moved",
							}
						: {
								text: `${where} isn't in this diff`,
								tip: "Outdated, or an unchanged line the diff doesn't show",
							},
			);
			if (section) scrollTo(section, -1);
			return;
		}
		setHint(null);
		// A few lines of context above it stay in view.
		scrollTo(row, 60);
		const line = landing.line as number;
		setLanded({ old, line, phase: "on" });
		const fade = window.setTimeout(
			() => setLanded({ old, line, phase: "fading" }),
			LANDED_MS,
		);
		const end = window.setTimeout(() => setLanded(null), LANDED_MS + FADE_MS);
		return () => {
			window.clearTimeout(fade);
			window.clearTimeout(end);
			setLanded(null);
		};
	}, [root, landing, ready]);
	return { hint, landed, pending };
}

function LandingHint({ hint }: { hint: Hint }) {
	return (
		<Tooltip content={hint.tip}>
			{(trigger) => (
				<p
					{...trigger}
					role="status"
					data-testid="landing-hint"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
					tabIndex={0}
					className="flex min-h-10 items-center gap-2 border-b border-line bg-band px-3 text-xs text-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
				>
					<InfoIcon size={14} aria-hidden className="shrink-0 text-accent" />
					{hint.text}
				</p>
			)}
		</Tooltip>
	);
}

/** A hunk's header and lines: context runs, and each cluster's run with its rail. */
function HunkRows(props: {
	hunk: DisplayHunk;
	clusters: Map<string, ClusterView>;
	lang: string | null;
	tabWidth?: number;
	checkbox: (cluster: ClusterView) => ReactNode;
	noteId: (cluster: ClusterView) => string | undefined;
	landed: Landed | null;
	landingLine: LandingLine | null;
	threads?: RowThreads;
	/** Settings' "Ignore whitespace": pair whitespace-only lines (whitespace.ts). */
	ignoreWhitespace: boolean;
	shape: Shape;
}) {
	const { threads, hunk, ignoreWhitespace, shape } = props;
	const { view } = shape;
	// The hunk's runs and their rows, once per hunk (the matching is O(n·m)
	// over the whole hunk): not again on a toggle, a landing, a thread
	// opening or a context load. Side by side, the rows laid out as pairs
	// (sideBySide.ts): the whitespace rows are its input, so the two settings
	// compose.
	const hunkRuns = useMemo(() => {
		const twins = ignoreWhitespace ? matchHunk(hunk.lines) : null;
		return runs(hunk.lines).map((run) => {
			const rows = (
				twins && run.key !== undefined
					? pairRun(run.lines, twins)
					: run.lines.map((line) => ({ kind: "line", line }))
			) as DiffRow[];
			return {
				...run,
				rows,
				side: view === "side-by-side" ? layoutRows(rows) : null,
			};
		});
	}, [hunk, ignoreWhitespace, view]);
	const columns = columnsOf(view);
	return (
		<>
			<tbody>
				<tr className="bg-hunk text-hunk-ink">
					<td colSpan={columns} className="px-2 py-0.5">
						{hunkHeader(hunk)}
					</td>
				</tr>
			</tbody>
			{hunkRuns.map((run) => {
				const first = run.lines[0];
				const runKey = `${run.key ?? ""}:${first?.oldNo}:${first?.newNo}`;
				const cluster =
					run.key === undefined ? undefined : props.clusters.get(run.key);
				// A cluster the review doesn't list still shows as unreviewed.
				const state =
					run.key === undefined ? undefined : (cluster?.state ?? "unreviewed");
				const { rows } = run;
				const rowProps = {
					shape,
					lang: props.lang,
					tabWidth: props.tabWidth,
					state,
					landed: props.landed,
					threads,
				};
				/** The run's rows, the cluster's controls on the first when given. */
				const runRows = (controls?: ReactNode) =>
					run.side
						? run.side.map((r, i) => {
								const old = r.kind === "context" ? r.line.oldNo : r.del?.oldNo;
								const nu = r.kind === "context" ? r.line.newNo : r.add?.newNo;
								return (
									<PairRow
										key={`${r.kind}${old ?? ""}:${nu ?? ""}`}
										row={r}
										checkbox={i === 0 ? controls : undefined}
										{...rowProps}
									/>
								);
							})
						: rows.map((r, i) => {
								const line = rowLine(r);
								return (
									<LineRow
										key={`${line.kind}${line.oldNo ?? ""}:${line.newNo ?? ""}`}
										line={line}
										checkbox={i === 0 ? controls : undefined}
										{...rowProps}
									/>
								);
							});
				if (state && ignoreWhitespace && whitespaceOnly(rows)) {
					// A bubble or a landed-on line must never be hidden by the
					// setting: the cluster stays open while it has one.
					const pinned = rows.some((r) => {
						const line = rowLine(r);
						const keys = rowKeys(line);
						return (
							keys.some(
								(k) =>
									threads?.placement.covered.has(k) ||
									threads?.placement.end.has(k),
							) ||
							landedPhase(props.landed, line) !== undefined ||
							landingOn(props.landingLine, line)
						);
					});
					return (
						<WhitespaceCluster
							key={runKey}
							state={state}
							lines={cluster?.lines ?? run.lines.length}
							pinned={pinned}
							columns={columns}
							controls={cluster ? props.checkbox(cluster) : undefined}
							note={
								cluster && (
									<CrossedOffNote
										cluster={cluster}
										id={props.noteId(cluster)}
									/>
								)
							}
						>
							{runRows()}
						</WhitespaceCluster>
					);
				}
				return (
					<tbody key={runKey} className={state ? "group" : undefined}>
						{runRows(cluster ? props.checkbox(cluster) : undefined)}
						{cluster?.state === "crossed-off" && (
							<tr>
								<Rail state={cluster.state} />
								<td colSpan={columns - 1} className="px-2 text-xs">
									<CrossedOffNote
										cluster={cluster}
										id={props.noteId(cluster)}
									/>
								</td>
							</tr>
						)}
					</tbody>
				);
			})}
		</>
	);
}

/**
 * A cluster that changes nothing but whitespace, collapsed to one row: its
 * rail and controls as on any cluster, and one disclosure button (a chevron
 * and "Whitespace only · N lines") that shows its rows (`children`) below
 * it. Collapsed each time it mounts (the file opens, or the setting turns
 * on); `pinned` keeps it open with the text alone, no button (the rows can't
 * go), for a thread or a landing on one of its lines, and opens it: once a
 * landing's highlight fades, the rows stay under the reviewer and the button
 * is back to collapse them.
 */
function WhitespaceCluster(props: {
	state: ClusterView["state"];
	lines: number;
	pinned: boolean;
	/** The table's column count: the row spans it. */
	columns: number;
	controls?: ReactNode;
	note?: ReactNode;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (props.pinned) setOpen(true);
	}, [props.pinned]);
	const shown = open || props.pinned;
	// The rows are the tbody's other rows: what the button controls.
	const id = useId();
	const words = `Whitespace only · ${props.lines} ${props.lines === 1 ? "line" : "lines"}`;
	return (
		<tbody id={id} className="group">
			<tr
				data-testid="ws-cluster"
				data-expanded={shown || undefined}
				data-reviewed={props.state === "reviewed" || undefined}
				className="bg-band"
			>
				<Rail state={props.state} />
				<ControlsCell>{props.controls}</ControlsCell>
				<td colSpan={props.columns - 2} className="px-2 font-sans text-xs">
					<span className="flex items-center gap-1">
						{props.pinned ? (
							<span className="text-muted">{words}</span>
						) : (
							// One disclosure button, chevron and words: its accessible
							// name is the visible text, `aria-expanded` the state.
							<Tooltip
								content={shown ? "Hide lines" : "Show lines"}
								describe={false}
							>
								{(trigger) => (
									<button
										type="button"
										{...trigger}
										aria-expanded={shown}
										aria-controls={id}
										onClick={() => setOpen(!shown)}
										className="group/ws -ml-1 flex h-5 items-center gap-1 rounded pr-1 text-faint hover:bg-pressed hover:text-ink focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:-my-2.5 pointer-coarse:h-10"
									>
										<span className="flex h-5 w-5 items-center justify-center">
											{shown ? (
												<ChevronDownIcon size={12} aria-hidden />
											) : (
												<ChevronRightIcon size={12} aria-hidden />
											)}
										</span>
										<span className="text-muted group-hover/ws:text-ink">
											{words}
										</span>
									</button>
								)}
							</Tooltip>
						)}
						{props.note}
					</span>
				</td>
			</tr>
			{shown && props.children}
		</tbody>
	);
}
