import {
	ChevronDownIcon,
	ChevronRightIcon,
	InfoIcon,
} from "@primer/octicons-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
	Fragment,
	type KeyboardEvent,
	type MouseEvent,
	type PointerEvent,
	type ReactNode,
	type RefObject,
	useCallback,
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
import { contextQuery, hunksQuery, overviewQuery } from "../api";
import { CodeLine, type Mark } from "../code/Invisibles";
import { Tooltip } from "../Tooltip";
import { canMove, spanTexts } from "../threads/draftMove";
import { type LineTexts, useDrafts } from "../threads/drafts";
import { NewThread, quoteOf } from "../threads/NewThread";
import {
	closeComposer,
	type NewThreadItem,
	newThreadItems,
	useComposers,
} from "../threads/newThreads";
import { OrphanDraft } from "../threads/OrphanDraft";
import type { SpanRange } from "../threads/spanMarks";
import { useThreadWriter } from "../threads/threadWrites";
import { ErrorMessage } from "../ui";
import { NOT_PHONE, useMedia } from "../useMedia";
import { ignoreWhitespace, sideBySide } from "../viewSettings";
import { type CellLine, CODE_CELL, cellLine } from "./codeSpan";
import { EXPAND_STEP, fileGaps, type Gap, gapState } from "./gaps";
import { languageFor } from "./highlight";
import type { Landing } from "./landing";
import {
	getPicks,
	picked,
	pickKey,
	pickRange,
	setPicks,
	usePicks,
} from "./linePicks";
import { describeSpan } from "./selectionActions";
import { layoutRows, type SideRow } from "./sideBySide";
import { CONTROLS, SLOT, useStickyControls } from "./stickyControls";
import { ThreadBubble } from "./ThreadBubble";
import { type CardPlace, TailRow, ThreadRow } from "./ThreadRow";
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
	/**
	 * Side by side on a screen wide enough: an opened thread or a composer
	 * sits under its side, in that side's half (TailRow). On a phone it
	 * spans the table as in unified: half of 360px is unreadable.
	 */
	split: boolean;
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

/**
 * The line GitHub numbers a row's code cell by (codeSpan.ts): added and
 * context rows by their new number, deleted rows by their old one, a
 * whitespace-only row by the side it shows (the new one for a pair). Side
 * by side, each cell's own line: a left cell's deleted line is LEFT, a
 * context line (shown twice) RIGHT in either cell.
 */
export function codeCellOf(line: RowLine): {
	side: "LEFT" | "RIGHT";
	line: number;
} {
	// A context line is one line, always RIGHT (the spec's cells contract).
	if (line.kind === "del" || line.newNo === undefined) {
		return { side: "LEFT", line: line.oldNo as number };
	}
	return { side: "RIGHT", line: line.newNo };
}

/** Picking lines by their numbers (DiffBody): the picked rows and the handlers. */
interface Picker {
	/** Picked rows, by pickKey. */
	keys: ReadonlySet<string>;
	/** The row whose number button is in the tab order. */
	roving: string | null;
	onPointerDown: (e: PointerEvent<HTMLElement>) => void;
	onPointerEnter: (e: PointerEvent<HTMLElement>) => void;
	onClick: (e: MouseEvent<HTMLElement>) => void;
	onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
	onFocus: (key: string) => void;
}

/** New threads being written, by the row they end on, and how to show one. */
interface RowComposers {
	at: (keys: LineKey[]) => NewThreadItem[];
	quote: (item: NewThreadItem) => string;
	/** Its first and last line's text as shown (kept with its draft). */
	texts: (item: NewThreadItem) => LineTexts | undefined;
	onPosted: (item: NewThreadItem) => void;
}

/**
 * What a number cell picks (linePicks.ts): the key of the code cell it
 * stands for, and whether it is that cell's own number (the one GitHub
 * knows the line by: it carries the pick's button and tab stop; the other
 * number of a unified row picks by pointer only).
 */
interface NumberPick {
	key: string;
	label: string;
	button: boolean;
	picked: boolean;
}

/** The pick a number makes for code cell `code`: its key, its name, whether it is picked. */
const pickOf = (
	code: ReturnType<typeof codeCellOf>,
	button: boolean,
	picker: Picker | undefined,
): NumberPick => {
	const key = pickKey(code);
	return {
		key,
		label: `${code.side === "LEFT" ? "Old line" : "Line"} ${code.line}`,
		button,
		picked: picker?.keys.has(key) ?? false,
	};
};

/**
 * The cluster's controls column (empty but on a cluster's first row);
 * `className` adds to it (a taller row's padding). Out of a text
 * selection, like the numbers and signs: a copy of the code never carries
 * the ⊘.
 */
function ControlsCell(props: { children?: ReactNode; className?: string }) {
	return (
		<td
			className={`w-11 px-1 align-top whitespace-nowrap select-none pointer-coarse:w-20 ${props.className ?? ""}`}
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

/**
 * A line's number on one side (`old`/`new`), as wide as the file's numbers
 * need. With a picker, the pointer picks its row's line from it (the
 * number's own cell side by side, the code cell's line in unified), and the
 * cell's own number is a button for the keyboard (Enter or Space clicks it,
 * the click bubbles to the cell).
 */
function NumberCell(props: {
	side: DiffSide;
	n?: number;
	digits: number;
	className: string;
	picker?: Picker;
	pick?: NumberPick;
}) {
	const { picker, pick, n } = props;
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard uses the number button (see above).
		<td
			data-testid={props.side === "LEFT" ? "old" : "new"}
			data-side={props.side}
			data-picked={pick?.picked || undefined}
			style={numberWidth(props.digits)}
			onPointerDown={picker?.onPointerDown}
			onPointerEnter={picker?.onPointerEnter}
			onClick={picker?.onClick}
			className={`px-2 text-right align-top select-none ${props.className} ${picker ? "cursor-pointer" : ""}`}
		>
			{picker && pick?.button && n !== undefined ? (
				<button
					type="button"
					data-pick={pick.key}
					tabIndex={picker.roving === pick.key ? 0 : -1}
					aria-label={pick.label}
					aria-pressed={pick.picked}
					onKeyDown={picker.onKeyDown}
					onFocus={() => picker.onFocus(pick.key)}
					className="block w-full cursor-pointer text-right hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
				>
					{n}
				</button>
			) : (
				n
			)}
		</td>
	);
}

/**
 * A line's code: its bubble (threads ending on it), sign and text, with the
 * spans painted over its characters (`marks`). Unified, the row carries the
 * paint and the line keeps its width (the table scrolls sideways); side by
 * side the cell is painted and wraps (tabs keep their width), so a long line
 * grows its row and the other side stays aligned. The cell is what a
 * selection maps to a span from (codeSpan.ts): its side, its length, the
 * hunk or gap it is in and its line's place in GitHub's order.
 */
function CodeCell(props: {
	side: DiffSide;
	line: RowLine;
	lang: string | null;
	tabWidth?: number;
	bubble?: ReactNode;
	/** The hunk (`h<i>`) or gap (`g<i>`) the cell is in (codeSpan.ts). */
	hunk: string;
	/** In a hunk: its line's index in GitHub's order of it. */
	order?: number;
	marks: readonly Mark[];
	/** Side by side only: the cell's own paint, kind, landing, mark and pick. */
	cell?: {
		paint: string;
		landed: boolean;
		commented: boolean;
		picked: boolean;
	};
}) {
	const { line, cell } = props;
	return (
		<td
			data-testid="code"
			{...{ [CODE_CELL]: "" }}
			data-side={props.side}
			data-len={line.text.length}
			data-hunk={props.hunk}
			data-order={props.order}
			data-kind={cell ? line.kind : undefined}
			data-landed={cell?.landed || undefined}
			data-commented={cell?.commented ? "" : undefined}
			data-picked={cell?.picked || undefined}
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
				marks={props.marks}
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
	/** The hunk (`h<i>`) or gap (`g<i>`) the row is in (codeSpan.ts). */
	hunk: string;
	/** In a hunk: a line's index in GitHub's order of it. */
	orderOf?: (line: DiffLine) => number | undefined;
	picker?: Picker;
	composers?: RowComposers;
}

/** The spans painted over a cell's characters: those of the threads on its keys. */
const marksOf = (keys: LineKey[], threads: RowThreads | undefined): Mark[] =>
	threads ? keys.flatMap((k) => threads.placement.marks.get(k) ?? []) : [];

/**
 * What follows a row of lines: the opened rows of the threads ending on it
 * (a pair row may open one per side, the left side's first), then the new
 * threads being written under it. When the shape splits them, each row
 * sits under its side, the composers a row per side with any (a context
 * line's are RIGHT: its bubble's cell); else every row spans the table and
 * both sides' composers share one.
 */
function RowTail(props: {
	opened: { endKey: LineKey; ending: ReviewThread[]; side: DiffSide }[];
	composing: { side: DiffSide; items: NewThreadItem[] }[];
	threads?: RowThreads;
	composers?: RowComposers;
	shape: Shape;
	state?: ClusterView["state"];
}) {
	const { threads, shape, composers } = props;
	const rail = props.state ? RAIL[props.state] : undefined;
	const place = (side: DiffSide): CardPlace =>
		shape.split ? { side } : { columns: columnsOf(shape.view) };
	// Across the table, both sides' composers share the one row.
	const composing = shape.split
		? props.composing
		: [
				{
					side: "RIGHT" as const,
					items: props.composing.flatMap(({ items }) => items),
				},
			];
	return (
		<>
			{threads &&
				props.opened.map((cell) => (
					<ThreadRow
						key={cell.endKey}
						id={threads.idOf(cell.endKey)}
						readId={threads.readId}
						threads={cell.ending}
						place={place(cell.side)}
						rail={rail}
					/>
				))}
			{composers &&
				composing
					.filter(({ items }) => items.length > 0)
					.map(({ side, items }) => (
						<NewThreadRow
							key={side}
							items={items}
							composers={composers}
							place={place(side)}
							rail={rail}
						/>
					))}
		</>
	);
}

/** New threads being written under their span's last row, like a ThreadRow. */
function NewThreadRow(props: {
	items: NewThreadItem[];
	composers: RowComposers;
	place: CardPlace;
	rail?: string;
}) {
	return (
		<TailRow testId="new-thread-row" place={props.place} rail={props.rail}>
			{props.items.map((item) => (
				<NewThread
					key={item.clientId}
					item={item}
					quote={props.composers.quote(item)}
					lineTexts={props.composers.texts(item)}
					onPosted={() => props.composers.onPosted(item)}
				/>
			))}
		</TailRow>
	);
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
function LineRow(props: RowProps & { line: RowLine; order?: number }) {
	const { line, state, threads, shape, picker } = props;
	const cell = codeCellOf(line);
	const isPicked = picker?.keys.has(pickKey(cell)) ?? false;
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
	const composing = props.composers?.at(keys) ?? [];
	// The number GitHub knows the row by takes the pick's button (and its
	// tab stop); the other number picks the row too, by pointer.
	const pick = (side: DiffSide) => pickOf(cell, side === cell.side, picker);
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
				data-picked={isPicked || undefined}
				className={`${rowBg} ${landed ? LANDED_CLASS[landed] : ""} ${mark} ${isPicked ? "line-picked" : ""}`}
			>
				<Rail state={state} />
				<ControlsCell>{props.checkbox}</ControlsCell>
				<NumberCell
					side="LEFT"
					n={line.oldNo}
					digits={shape.digits}
					className={numberBg}
					picker={picker}
					pick={pick("LEFT")}
				/>
				<NumberCell
					side="RIGHT"
					n={line.newNo}
					digits={shape.digits}
					className={numberBg}
					picker={picker}
					pick={pick("RIGHT")}
				/>
				<CodeCell
					side={cell.side}
					line={line}
					lang={props.lang}
					tabWidth={props.tabWidth}
					hunk={props.hunk}
					order={props.order}
					marks={marksOf(keys, threads)}
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
			<RowTail
				opened={open && endKey ? [{ endKey, ending, side: cell.side }] : []}
				composing={[{ side: cell.side, items: composing }]}
				threads={threads}
				composers={props.composers}
				shape={shape}
				state={state}
			/>
		</>
	);
}

/**
 * One side's cell of a pair row: its line, what its threads make of it, its
 * landing, the spans painted over its characters, its line's place in
 * GitHub's order and the pick its number makes.
 */
interface Cell {
	line: RowLine;
	keys: LineKey[];
	commented: boolean;
	ending: ReviewThread[];
	endKey?: LineKey;
	open: boolean;
	landed?: Landed["phase"];
	where: string;
	marks: Mark[];
	order?: number;
	pick: NumberPick;
}

/**
 * One row of the side-by-side table: a context line on both sides, or a
 * pair with a line on each side that has one (sideBySide.ts). Each cell is
 * under its own side's key, with its own paint, mark, bubble, landing, pick
 * and opened thread row (the left side's first); a context line is one line
 * shown twice: its bubble is in the right cell, under both its keys, and
 * its mark, spans, pick and landing paint both cells (either cell picks or
 * selects it as RIGHT, the cells contract).
 */
function PairRow(props: RowProps & { row: SideRow }) {
	const { row, state, threads, shape, picker } = props;
	const reviewed = state === "reviewed";
	const cellOf = (
		line: RowLine,
		source: DiffLine,
		keys: LineKey[],
		where: string,
	): Cell => {
		return {
			line,
			keys,
			...cellThreads(keys, threads),
			landed: landedPhase(props.landed, line),
			where,
			marks: marksOf(keys, threads),
			order: props.orderOf?.(source),
			pick: pickOf(codeCellOf(line), true, picker),
		};
	};
	let left: Cell | undefined;
	let right: Cell | undefined;
	if (row.kind === "context") {
		const line = row.line;
		right = cellOf(
			line,
			line,
			threads ? rowKeys(line) : [],
			`on line ${line.newNo}`,
		);
		// The same line, with its bubble and number button on the right.
		left = {
			...right,
			keys: [],
			ending: [],
			endKey: undefined,
			open: false,
			pick: { ...right.pick, button: false },
		};
	} else {
		if (row.del) {
			const line = sideLine(row.del, row.ws);
			left = cellOf(
				line,
				row.del,
				threads ? rowKeys(line) : [],
				`on old line ${line.oldNo}`,
			);
		}
		if (row.add) {
			const line = sideLine(row.add, row.ws);
			right = cellOf(
				line,
				row.add,
				threads ? rowKeys(line) : [],
				`on line ${line.newNo}`,
			);
		}
	}
	const phase = left?.landed ?? right?.landed;
	const commented = Boolean(left?.commented || right?.commented);
	const isPicked = Boolean(left?.pick.picked || right?.pick.picked);
	// Each side's cell, left first: what its threads open and what is being
	// written on its keys follows it (a context line's keys are all in its
	// right cell, so its rows are on the right).
	const sides: [DiffSide, Cell | undefined][] = [
		["LEFT", left],
		["RIGHT", right],
	];
	const cells = (side: DiffSide, cell: Cell | undefined) => {
		if (!cell) return <BlankCells side={side} digits={shape.digits} />;
		const { line, keys, endKey } = cell;
		// The landing's tint, else the commented range's stripe and numbers;
		// a pick's wash over either.
		const mark = `${
			cell.landed === "on"
				? "mark-tint-cell"
				: cell.commented
					? "thread-mark-cell"
					: ""
		} ${cell.pick.picked ? "line-picked-cell" : ""}`;
		const numberBg = (reviewed ? REVIEWED_NUMBER_BG : NUMBER_BG)[line.kind];
		const bg = (reviewed ? REVIEWED_ROW_BG : ROW_BG)[line.kind];
		return (
			<>
				<NumberCell
					side={side}
					n={side === "LEFT" ? line.oldNo : line.newNo}
					digits={shape.digits}
					className={`${numberBg} ${mark}`}
					picker={picker}
					pick={cell.pick}
				/>
				<CodeCell
					side={side}
					line={line}
					lang={props.lang}
					tabWidth={props.tabWidth}
					hunk={props.hunk}
					order={cell.order}
					marks={cell.marks}
					cell={{
						paint: `${bg} ${mark}`,
						landed: cell.landed === "on",
						commented: cell.commented,
						picked: cell.pick.picked,
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
				data-picked={isPicked || undefined}
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
			<RowTail
				opened={sides.flatMap(([side, cell]) =>
					cell?.open && cell.endKey
						? [{ endKey: cell.endKey, ending: cell.ending, side }]
						: [],
				)}
				composing={sides.map(([side, cell]) => ({
					side,
					items: props.composers?.at(cell?.keys ?? []) ?? [],
				}))}
				threads={threads}
				composers={props.composers}
				shape={shape}
				state={state}
			/>
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
			className="ml-2 rounded bg-crossed/20 px-1 font-sans text-done select-none"
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
	/** These hunks are the viewed head's (not a Refresh's moment of the old ones). */
	headSure?: boolean;
}) {
	const { file, revision } = props;
	const hunks = useQuery(hunksQuery(revision, file.index));
	const ignoreWs = ignoreWhitespace.use();
	const view: View = sideBySide.use() ? "side-by-side" : "unified";
	const digits = hunks.data
		? digitsOf(hunks.data.newLineCount, hunks.data.hunks)
		: 3;
	const wide = useMedia(NOT_PHONE);
	const shape = useMemo<Shape>(
		() => ({ view, digits, split: view === "side-by-side" && wide }),
		[view, digits, wide],
	);
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
	const gaps = hunks.data
		? fileGaps(hunks.data.hunks, hunks.data.newLineCount)
		: [];
	const addRange = (from: number, to: number) =>
		setRanges((r) =>
			r.some(([f, t]) => f === from && t === to) ? r : [...r, [from, to]],
		);

	// New threads being written on this file's lines, on the viewed head;
	// those on another head are orphans (their lines are gone).
	const snapshotHead = props.threads?.snapshotHead;
	const drafts = useDrafts();
	const composerList = useComposers();
	const allItems = useMemo(
		() => newThreadItems(drafts, composerList),
		[drafts, composerList],
	);
	const mineNew = allItems.filter(
		(i) => i.span.path === file.path && i.span.subject === "line",
	);
	const lineItems = mineNew.filter((i) => i.span.commit === snapshotHead);
	const orphanItems = snapshotHead
		? mineNew.filter((i) => i.span.commit !== snapshotHead)
		: [];
	const writer = useThreadWriter();

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
				spans: lineItems.map((i) => i.span as SpanRange),
			})
		: null;
	// Written on a row that isn't shown (a gap): above the diff, never lost.
	const unshown = hunks.data
		? lineItems.filter((_, i) => !placement?.spansShown.has(i))
		: [];
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
	// Each line's text by both keys, to quote a span above its composer.
	const textAt = new Map<LineKey, string>();
	for (const l of [
		...(hunks.data?.hunks.flatMap((h) => h.lines) ?? []),
		...loaded.values(),
	]) {
		for (const side of ["LEFT", "RIGHT"] as const) {
			const k = lineKey(side, l);
			if (k) textAt.set(k, l.text);
		}
	}
	const composers: RowComposers = {
		at: (keys) =>
			lineItems.filter((i) =>
				keys.includes(`${i.span.side}:${i.span.line}` as LineKey),
			),
		quote: (item) => {
			const { span } = item;
			const start = textAt.get(
				`${span.startSide}:${span.startLine}` as LineKey,
			);
			const end = textAt.get(`${span.side}:${span.line}` as LineKey);
			const same = span.startSide === span.side && span.startLine === span.line;
			return quoteOf(span, same ? [end ?? ""] : [start ?? "", end ?? ""]);
		},
		texts: (item) =>
			hunks.data
				? (spanTexts(hunks.data.hunks, item.span as SpanRange) ?? undefined)
				: undefined,
		// The thread opens where it lands.
		onPosted: (item) => {
			const key = `${item.span.side}:${item.span.line}` as LineKey;
			setOpenThreads((open) => new Set(open).add(key));
		},
	};

	const picker = usePicker(scroller, file.path, hunks.data?.hunks[0], view);

	// The head moved under a draft: it moves along when its lines and the
	// lines around them read the same at the same numbers, in GitHub's diff
	// (draftMove.ts; a file comment always moves, FileDiff), and Comment can
	// go there; else it stays an orphan, its text kept. Never a guess at a
	// nearby line. Only against hunks known to be this head's (`headSure`:
	// a Refresh shows the new head before its diff).
	const commentLeft = useQuery({ ...overviewQuery, enabled: false }).data
		?.commentLeft;
	useEffect(() => {
		if (!snapshotHead || !hunks.data || !props.headSure) return;
		for (const item of orphanItems) {
			if (item.sending) continue;
			const draft = writer.drafts.newThread(item.clientId);
			// Opened on the earlier head and never typed in: nothing to keep.
			if (!draft) {
				closeComposer(item.clientId);
				continue;
			}
			const span = item.span as SpanRange;
			const left = span.startSide === "LEFT" || span.side === "LEFT";
			if (left && commentLeft === false) continue;
			if (canMove(draft.create?.texts, spanTexts(hunks.data.hunks, span))) {
				writer.drafts.retarget(item.clientId, snapshotHead);
			}
		}
	});
	/** An orphan's line isn't in the file any more (past its end). */
	const gone = (item: NewThreadItem) =>
		hunks.data !== undefined &&
		item.span.side === "RIGHT" &&
		(item.span.line ?? 0) > hunks.data.newLineCount;

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

	const hunkOf = (n: number) =>
		`g${gaps.find((g) => g.from <= n && n <= g.to)?.index ?? ""}`;
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
					hunk: hunkOf(n),
					picker,
					composers,
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

	const gapAt = (index: number) => gaps.find((g) => g.index === index);

	return (
		<div ref={root}>
			{hint && <LandingHint hint={hint} />}
			{(unshown.length > 0 || orphanItems.length > 0) && (
				<div
					data-testid="new-threads-unshown"
					className="space-y-2 border-b border-line bg-canvas p-2"
				>
					{unshown.map((item) => (
						<NewThread
							key={item.clientId}
							item={item}
							quote={composers.quote(item)}
							lineTexts={composers.texts(item)}
						/>
					))}
					{orphanItems.length > 0 && (
						<ul
							aria-label="Drafts written on an earlier version"
							className="space-y-2"
						>
							{orphanItems.map((item) => (
								<OrphanDraft
									key={item.clientId}
									label={`${
										gone(item) ? "Lines gone" : "Written on an earlier version"
									} · ${describeSpan(item.span)}`}
									text={item.text}
									onDiscard={() => writer.discard(`new:${item.clientId}`)}
								/>
							))}
						</ul>
					)}
				</div>
			)}
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
								hunkId={`h${index}`}
								picker={picker}
								composers={composers}
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

/** The side a node's cell is on, as the selection mark names it. */
const selectingSide = (node: Node | null): "old" | "new" | undefined => {
	const el = node instanceof Element ? node : node?.parentElement;
	const side = el?.closest<HTMLElement>("td[data-side]")?.dataset.side;
	return side === "LEFT" ? "old" : side === "RIGHT" ? "new" : undefined;
};

/** Writes or removes the table's `data-selecting`. */
const markSelecting = (
	table: HTMLTableElement,
	side: "old" | "new" | undefined,
) => {
	if (side) table.dataset.selecting = side;
	else delete table.dataset.selecting;
};

/**
 * Side by side, a text selection stays on one side: the table carries
 * `data-selecting="old" | "new"` while a selection is on that side, and the
 * CSS (index.css) makes the other side's code cells `user-select: none`, so
 * dragging across the table selects one side and Copy gives its lines. The
 * mark is set as soon as the pointer goes down on a code cell with a side
 * (before the selection exists; number cells can't start a selection, so a
 * mark from one would never be cleared), then follows the document's
 * selection: its anchor cell's side, or none once the selection is
 * collapsed, elsewhere, or the view is unified. The caret a mouse down
 * places is a collapsed selection too: while the pointer is down it keeps
 * the mark, or a fast drag could reach the other side before the first
 * move's selection set the mark again. Line numbers and signs are
 * `select-none` on their own.
 */
function useOneSideSelection(
	table: RefObject<HTMLTableElement | null>,
	view: View,
) {
	const pressed = useRef(false);
	useEffect(() => {
		const el = table.current;
		if (view !== "side-by-side" || !el) return;
		const onSelectionChange = () => {
			const selection = document.getSelection();
			if (!selection) return;
			if (selection.isCollapsed) {
				if (!pressed.current) markSelecting(el, undefined);
				return;
			}
			const anchor = selection.anchorNode;
			markSelecting(
				el,
				anchor && el.contains(anchor) ? selectingSide(anchor) : undefined,
			);
		};
		const onPointerUp = () => {
			pressed.current = false;
		};
		document.addEventListener("selectionchange", onSelectionChange);
		document.addEventListener("pointerup", onPointerUp);
		document.addEventListener("pointercancel", onPointerUp);
		return () => {
			document.removeEventListener("selectionchange", onSelectionChange);
			document.removeEventListener("pointerup", onPointerUp);
			document.removeEventListener("pointercancel", onPointerUp);
			pressed.current = false;
			markSelecting(el, undefined);
		};
	}, [table, view]);
	if (view !== "side-by-side") return undefined;
	return (event: PointerEvent<HTMLTableElement>) => {
		const target = event.target instanceof Element ? event.target : null;
		const cell = target?.closest<HTMLElement>(
			'td[data-testid="code"][data-side]',
		);
		if (!cell) return;
		pressed.current = true;
		markSelecting(event.currentTarget, selectingSide(cell));
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
	hunkId: string;
	picker?: Picker;
	composers?: RowComposers;
}) {
	const { threads, hunk, ignoreWhitespace, shape } = props;
	const { view } = shape;
	// Each line's index in the hunk: GitHub's order (codeSpan.ts spanOfRange, linePicks.ts pickRange).
	const orderOf = useMemo(() => {
		const order = new Map(hunk.lines.map((l, i) => [l, i] as const));
		return (line: DiffLine) => order.get(line);
	}, [hunk]);
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
					hunk: props.hunkId,
					orderOf,
					picker: props.picker,
					composers: props.composers,
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
								// GitHub's place of the line the code cell stands for.
								const shown = r.kind === "line" ? r.line : (r.add ?? r.del);
								return (
									<LineRow
										key={`${line.kind}${line.oldNo ?? ""}:${line.newNo ?? ""}`}
										line={line}
										order={shown ? orderOf(shown) : undefined}
										checkbox={i === 0 ? controls : undefined}
										{...rowProps}
									/>
								);
							});
				if (state && ignoreWhitespace && whitespaceOnly(rows)) {
					// A bubble, a pick or a landed-on line must never be hidden by
					// the setting: the cluster stays open while it has one. (Keys
					// are pick keys too: side by side, either side's cell picks.)
					const pinned = rows.some((r) => {
						const line = rowLine(r);
						const keys = rowKeys(line);
						return (
							keys.some(
								(k) =>
									threads?.placement.covered.has(k) ||
									threads?.placement.end.has(k) ||
									props.picker?.keys.has(k),
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
				{/* Its words stay out of a selection dragged across the row. */}
				<td
					colSpan={props.columns - 2}
					className="px-2 font-sans text-xs select-none"
				>
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

/** The arrow keys: a step through the number buttons, or a side to go to. */
const ARROWS: Record<
	string,
	{ step: 1 | -1; side?: undefined } | { side: DiffSide; step?: undefined }
> = {
	ArrowDown: { step: 1 },
	ArrowUp: { step: -1 },
	ArrowLeft: { side: "LEFT" },
	ArrowRight: { side: "RIGHT" },
};

/** The column a number button is in. */
const sideOf = (b: Element): DiffSide =>
	b.closest("td")?.getAttribute("data-side") === "LEFT" ? "LEFT" : "RIGHT";

/** The button's row shows one context line on both sides. */
const inContextRow = (b: Element) =>
	b.closest("tr")?.getAttribute("data-kind") === "context";

/**
 * Picking lines by their numbers: a click (or tap) picks the row, again
 * clears it; shift-click, or dragging down the numbers with a mouse,
 * extends from where the pick started; on touch a second tap extends. One
 * number button per code cell (a pair row has one per side), one of them
 * in the tab order (the last focused, else the first row's): Up/Down move
 * between them in the order shown (Shift extends), Enter or Space picks,
 * Escape (the selection bar) clears. A number picks the code cell on its
 * side of the row (side by side), else the row's one code cell (unified,
 * where a context row's old number picks its RIGHT line).
 *
 * Side by side, Up/Down stay in their column (the old numbers or the new
 * ones), past rows blank on that side, and Left/Right go to the other
 * number of the same row when it has one; Shift with any of them extends.
 * A context row is one line with one button, on the right: it stands in
 * both columns, and the column it was reached in is kept from there.
 */
function usePicker(
	scroller: RefObject<HTMLDivElement | null>,
	path: string,
	firstHunk: DisplayHunk | undefined,
	view: View,
): Picker {
	const picks = usePicks();
	const keys = useMemo(
		() =>
			new Set(picks?.path === path ? picks.lines.map((l) => pickKey(l)) : []),
		[picks, path],
	);
	const [roving, setRoving] = useState<string | null>(null);
	/** The column the keyboard last moved in (side by side). */
	const column = useRef<DiffSide | null>(null);
	const first = firstHunk?.lines[0];
	const dragging = useRef(false);
	const pointer = useRef("");
	useEffect(() => {
		const up = () => {
			dragging.current = false;
		};
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", up);
		return () => {
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", up);
		};
	}, []);
	// The file's code cells top down, one per line and side: a context line
	// shown twice (side by side) is one pick.
	const cells = useCallback(() => {
		const out: CellLine[] = [];
		for (const el of scroller.current?.querySelectorAll(`[${CODE_CELL}]`) ??
			[]) {
			const c = cellLine(el);
			if (!c) continue;
			const last = out[out.length - 1];
			if (last && last.side === c.side && last.line === c.line) continue;
			out.push(c);
		}
		return out;
	}, [scroller]);
	const targetOf = (el: Element) => {
		const row = el.closest("tr");
		const side = el.closest("td")?.getAttribute("data-side");
		const cell =
			row?.querySelector(`[${CODE_CELL}][data-side="${side}"]`) ??
			row?.querySelector(`[${CODE_CELL}]`);
		return cell ? cellLine(cell) : null;
	};
	const pickTo = (t: CellLine, extend: boolean) => {
		const cur = getPicks();
		const mine = cur?.path === t.path ? cur : null;
		if (extend && mine) {
			setPicks(pickRange(cells(), mine.anchor, picked(t)) ?? mine);
		} else if (
			mine?.lines.length === 1 &&
			pickKey(mine.anchor) === pickKey(t)
		) {
			setPicks(null);
		} else {
			setPicks(pickRange(cells(), picked(t), picked(t)));
		}
		// Picked lines, not text: one or the other makes the span.
		window.getSelection()?.removeAllRanges();
	};
	return {
		keys,
		roving: roving ?? (first ? pickKey(codeCellOf(first)) : null),
		onPointerDown: (e) => {
			pointer.current = e.pointerType;
			// A press chooses a button, not a column: the keyboard goes on
			// from that button's own.
			column.current = null;
			if (e.pointerType !== "mouse" || e.button !== 0) return;
			const t = targetOf(e.currentTarget);
			if (!t) return;
			// No text selection starts from the numbers.
			e.preventDefault();
			e.currentTarget
				.closest("tr")
				?.querySelector<HTMLButtonElement>(
					`button[data-pick="${CSS.escape(pickKey(t))}"]`,
				)
				?.focus({ preventScroll: true });
			dragging.current = true;
			pickTo(t, e.shiftKey);
		},
		onPointerEnter: (e) => {
			if (!dragging.current || (e.buttons & 1) === 0) return;
			const t = targetOf(e.currentTarget);
			const cur = getPicks();
			if (!t || cur?.path !== t.path) return;
			setPicks(pickRange(cells(), cur.anchor, picked(t)) ?? cur);
		},
		onClick: (e) => {
			const t = targetOf(e.currentTarget);
			if (!t) return;
			// The keyboard's Enter or Space on the number button.
			if (e.detail === 0) pickTo(t, e.shiftKey);
			// A tap: a second one extends (a mouse picked on pointer down).
			else if (pointer.current !== "mouse") {
				const cur = getPicks();
				pickTo(t, cur?.path === t.path && pickKey(cur.anchor) !== pickKey(t));
			}
		},
		onKeyDown: (e) => {
			const arrow = ARROWS[e.key];
			if (!arrow) return;
			const buttons = [
				...(scroller.current?.querySelectorAll<HTMLButtonElement>(
					"button[data-pick]",
				) ?? []),
			];
			const at = buttons.indexOf(e.currentTarget);
			let next: HTMLButtonElement | undefined;
			if (view !== "side-by-side") {
				if (arrow.side) return;
				next = buttons[at + arrow.step];
			} else if (arrow.side) {
				const row = e.currentTarget.closest("tr");
				next = buttons.find(
					(b) => b.closest("tr") === row && sideOf(b) === arrow.side,
				);
				if (next === e.currentTarget) return;
				if (next) column.current = arrow.side;
			} else {
				// A context row's button is in both columns: the column
				// it was reached in goes on from it.
				const col =
					(inContextRow(e.currentTarget) && column.current) ||
					sideOf(e.currentTarget);
				for (
					let i = at + arrow.step;
					i >= 0 && i < buttons.length;
					i += arrow.step
				) {
					const b = buttons[i] as HTMLButtonElement;
					if (sideOf(b) === col || inContextRow(b)) {
						next = b;
						break;
					}
				}
				column.current = col;
			}
			if (!next) return;
			e.preventDefault();
			next.focus();
			if (!e.shiftKey) return;
			const from = targetOf(e.currentTarget);
			const to = targetOf(next);
			if (!from || !to) return;
			const cur = getPicks();
			const anchor = cur?.path === from.path ? cur.anchor : picked(from);
			setPicks(pickRange(cells(), anchor, picked(to)));
		},
		onFocus: setRoving,
	};
}
