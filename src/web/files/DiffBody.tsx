import {
	AlertIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	InfoIcon,
} from "@primer/octicons-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
	type CSSProperties,
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
import type { AgentThread } from "../../shared/agent";
import type {
	ClusterView,
	DiffLine,
	DiffSide,
	DisplayHunk,
	FileHunks,
	FileView,
	ReviewThread,
} from "../../shared/types";
import { AgentBubble } from "../agent/AgentBubble";
import { AgentComposer } from "../agent/AgentComposer";
import { takeJustAsked } from "../agent/agentWrites";
import { agentThreadsQuery } from "../agent/api";
import {
	type AgentComposerItem,
	useAgentComposers,
} from "../agent/askAgentAction";
import { type AgentPlaceable, agentPlaceable } from "../agent/placeable";
import { contextQuery, hunksQuery, overviewQuery, sessionQuery } from "../api";
import {
	CodeLine,
	type Mark,
	useShowInvisibles,
	type Words,
} from "../code/Invisibles";
import { DEFAULT_TAB_WIDTH } from "../code/invisibleChars";
import { Spinner } from "../Spinner";
import { clickPointer, isTap, Tooltip } from "../Tooltip";
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
import { ignoreWhitespace, showInvisibles, sideBySide } from "../viewSettings";
import { type CellLine, CODE_CELL, cellLine } from "./codeSpan";
import { EXPAND_STEP, fileGaps, type Gap, gapState } from "./gaps";
import { Labelled, labelReserve } from "./HunkHeading";
import { hiddenLines } from "./hiddenLines";
import { languageFor } from "./highlight";
import type { Landing } from "./landing";
import {
	getPicks,
	type Picks,
	picked,
	pickKey,
	pickRange,
	setPicks,
	usePicks,
} from "./linePicks";
import { useResolveCollapse } from "./resolveCollapse";
import { type CodeSpan, describeSpan } from "./selectionActions";
import { layoutRows, type SideRow } from "./sideBySide";
import { CONTROLS, SLOT, useStickyControls } from "./stickyControls";
import { BubbleSlot, ThreadBubble } from "./ThreadBubble";
import {
	AgentThreadRow,
	type CardPlace,
	TailRow,
	ThreadRow,
} from "./ThreadRow";
import {
	type FilePlacement,
	type LineKey,
	lineKey,
	placeThreads,
} from "./threadPlacement";
import { VIEW_KEYS } from "./viewShortcuts";
import { type DiffRow, viewRuns, whitespaceOnly } from "./whitespace";
import { hunkWordMarks } from "./wordBlocks";

/** Review threads to show in a file's diff (FilesPage), and the read they come from. */
export interface DiffThreads {
	readId: string;
	snapshotHead: string;
	/** The PR's threads; placeThreads picks this file's. */
	threads: ReviewThread[];
}

/**
 * The file's own bubble and its threads' row (FileDiff): on the diff's
 * first row, whatever kind it is (side by side, in a pair row's right cell),
 * and right under it, across the table's `columns`.
 */
export interface FileLead {
	bubble: ReactNode;
	/** How many bubbles `bubble` holds (the comment and agent ones): 1 if unset. */
	count?: number;
	/** The row of its threads, with the rail of the cluster it sits in. */
	row: (columns: number, rail?: string) => ReactNode;
}

/**
 * Where the file bubble sits in the unified view: centred on the diff's
 * visible width, sticky so it stays there as long lines scroll (a sticky
 * inset's percentage is of the scroller), taking no room from the row's
 * text. Only on rows that aren't code (a hunk header, a gap, a cluster's
 * label, a row of its own), so it never covers a line or its selection.
 * Side by side it sits at the right with the line bubbles, in the first
 * row's right cell when that is code (PairRow).
 */
export function FileBubbleSlot(props: { children: ReactNode; count?: number }) {
	return (
		<span
			data-testid="file-bubble-slot"
			className={`sticky z-[4] float-left flex justify-center select-none ${
				(props.count ?? 1) > 1
					? "left-[calc(50%-2.5rem)] -mr-20 w-20"
					: "left-[calc(50%-1.25rem)] -mr-10 w-10"
			}`}
		>
			{props.children}
		</span>
	);
}

/**
 * A row's text beside the file bubble: on touch the bubble is 40px tall, so
 * the text's line is too, centring it on the bubble (`@@`, "N hidden lines").
 */
const LEAD_LINE = "pointer-coarse:leading-10";

/**
 * The file bubble's own row (no row to share; unified, also when the first
 * row is code), and its threads' row: centred unified, at the right side
 * by side.
 */
function LeadRow(props: { lead: FileLead; columns: number; centred: boolean }) {
	const { lead, columns, centred } = props;
	return (
		<>
			<tr>
				<td
					colSpan={columns}
					className={`${centred ? "px-2" : bubblePad(lead.count ?? 1)} h-5`}
				>
					<LeadSlot lead={lead} centred={centred} />
				</td>
			</tr>
			{lead.row(columns)}
		</>
	);
}

/** The file bubble on a row that isn't code: centred unified, at the right side by side. */
function LeadSlot(props: { lead: FileLead; centred: boolean }) {
	return props.centred ? (
		<FileBubbleSlot count={props.lead.count}>
			{props.lead.bubble}
		</FileBubbleSlot>
	) : (
		<BubbleSlot>{props.lead.bubble}</BubbleSlot>
	);
}

/** A non-code row's text cell beside the file bubble: its padding and line. */
const leadText = (lead: FileLead | undefined, centred: boolean, others = 0) =>
	`${bubblePad(others + (lead && !centred ? (lead.count ?? 1) : 0))} ${lead && centred ? LEAD_LINE : ""}`;

/** The cell padding that keeps `n` bubbles clear of the code. */
const bubblePad = (n: number) =>
	n === 0
		? "px-2"
		: n === 1
			? "pr-12 pl-2"
			: n === 2
				? "pr-24 pl-2"
				: "pr-36 pl-2";

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
	/** Resolve closes a thread to its bubble (resolveCollapse.ts). */
	collapse: RowCollapse;
}

/** Resolve closing a row's thread: its bubble's key and row keys (what closes it). */
interface RowCollapse {
	shows: (thread: ReviewThread) => boolean;
	resolved: (
		endKey: LineKey,
		keys: LineKey[],
		thread: ReviewThread,
		shown: readonly ReviewThread[],
		from: Element,
	) => void;
}

/**
 * What a row needs of the file's agent threads (their own bubble, beside
 * the comment bubble, and their own open set) and of the Ask agent
 * composers ending on it.
 */
interface AgentRows {
	placement: FilePlacement<AgentPlaceable>;
	open: ReadonlySet<LineKey>;
	toggle: (key: LineKey, keys: LineKey[]) => void;
	idOf: (key: LineKey) => string;
	composersAt: (keys: LineKey[]) => AgentComposerItem[];
	quote: (span: CodeSpan) => string;
}

/** A cell's agent threads: those ending on its keys, the key, whether open. */
function cellAgent(keys: LineKey[], agent: AgentRows | undefined) {
	const endKey = keys.find((k) => agent?.placement.end.has(k));
	const ending = keys.flatMap(
		(k) => agent?.placement.end.get(k)?.map((p) => p.thread) ?? [],
	);
	const open = keys.some((k) => agent?.open.has(k));
	return { endKey, ending, open };
}

/** An agent bubble for a cell's threads, when it has any. */
function agentBubbleOf(
	cell: ReturnType<typeof cellAgent>,
	keys: LineKey[],
	agent: AgentRows | undefined,
	where: string,
): ReactNode {
	const { endKey } = cell;
	if (!agent || !endKey) return undefined;
	return (
		<AgentBubble
			inline
			threads={cell.ending}
			where={where}
			open={cell.open}
			controls={cell.open ? agent.idOf(endKey) : undefined}
			onToggle={() => agent.toggle(endKey, keys)}
		/>
	);
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
	/**
	 * Side by side on a screen wide enough: an opened thread or a composer
	 * sits under its side, in that side's half (TailRow). On a phone it
	 * spans the table as in unified: half of 360px is unreadable.
	 */
	split: boolean;
}

/**
 * How many digits the file's number columns hold: its largest line number
 * on either side, three at least (the side-by-side spec's "Gutters").
 */
export function numberDigits(data: FileHunks | undefined): number {
	if (!data) return 3;
	// The old file's length: the new one's, less what the hunks added.
	let max = Math.max(
		data.newLineCount,
		data.hunks.reduce((n, h) => n + h.oldCount - h.newCount, data.newLineCount),
	);
	for (const h of data.hunks) {
		for (const l of h.lines) max = Math.max(max, l.oldNo ?? 0, l.newNo ?? 0);
	}
	return Math.max(3, String(max).length);
}

/**
 * A number column's width: its digits (`--num-w`, set on the table from
 * numberDigits) and padding; on touch it keeps 48px, its tap target. On the
 * number cells in both views, and on the side-by-side table's `col`s.
 */
const NUMBER_W =
	"w-[var(--num-w,3rem)] pointer-coarse:w-[max(3rem,var(--num-w,3rem))]";

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
	/** The number button in the tab order, by `stopOf`. */
	roving: string | null;
	onPointerDown: (e: PointerEvent<HTMLElement>) => void;
	onPointerEnter: (e: PointerEvent<HTMLElement>) => void;
	onClick: (e: MouseEvent<HTMLElement>) => void;
	onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
	onFocus: (stop: string) => void;
}

/**
 * A number button's tab stop: its column and its pick's key (a context
 * row's two buttons pick one line, so the key alone names both).
 */
const stopOf = (column: DiffSide, key: string) => `${column} ${key}`;

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
 * number of a unified row picks by pointer only). Side by side, both
 * numbers of a context row carry one, each picking its one RIGHT line.
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
 * Before a warning goes, moves focus it holds to its line: the line's number
 * button (its own side's first), else the code cell itself.
 */
function keepFocusOnLine(warning: HTMLElement) {
	if (document.activeElement !== warning) return;
	const cell = warning.closest("td");
	const row = cell?.closest("tr");
	const target =
		cell?.previousElementSibling?.querySelector<HTMLElement>("button") ??
		row?.querySelector<HTMLElement>(
			'td[data-testid="old"] button, td[data-testid="new"] button',
		) ??
		cell;
	if (!target) return;
	if (target === cell) cell.tabIndex = -1;
	target.focus({ preventScroll: true });
}

/**
 * The ⚠'s touch target: 40px square (`::before`), reaching into the rows
 * above and below, and over it its own line's 20px band (`::after`), so
 * where two warned rows' squares overlap the tap goes to the row it's on.
 * The button makes no stacking context: the two layers order across rows.
 */
const WARNING_TARGET =
	"pointer-coarse:before:absolute pointer-coarse:before:top-1/2 pointer-coarse:before:-left-2 pointer-coarse:before:z-[1] pointer-coarse:before:size-10 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-[''] pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:-left-2 pointer-coarse:after:z-[2] pointer-coarse:after:h-5 pointer-coarse:after:w-10 pointer-coarse:after:-translate-y-1/2 pointer-coarse:after:content-['']";

/**
 * In the sign's place, on a line whose change doesn't show while hidden
 * characters are off (hiddenChange.ts): a warning that turns them on. As
 * wide as the sign, so the code doesn't move; a finger gets 40px from the
 * cell's edge rightwards (never over the number). The sign comes back once
 * they show. Not a tab stop (a changed line ending can put one on every
 * line): the keyboard has `h`. A touch or pen tap only opens its tooltip,
 * which says where the switch is (owner, 2026-11-04: a tap shouldn't change
 * a setting the reader may not know); decided by the click's own pointer
 * (clickPointer), not the screen width, so a phone in landscape behaves the
 * same. On a screen without hover its name says where the switch is too (a
 * screen reader's activation there is a tap).
 */
function HiddenWarning({ kind }: { kind: RowLine["kind"] }) {
	const show = useShowInvisibles();
	const wide = useMedia(NOT_PHONE);
	const hover = useMedia("(hover: hover)");
	// The tooltip after a tap says where the switch is, until focus leaves.
	const [tapped, setTapped] = useState(false);
	if (show) return <Sign kind={kind} />;
	const turnOn = `Hidden characters changed. Turn on Show hidden characters${wide ? ` (${VIEW_KEYS.showInvisibles})` : ""}`;
	const inSettings =
		"Hidden characters changed. Turn on Show hidden characters in Settings";
	const label = hover ? turnOn : inSettings;
	return (
		<Tooltip content={tapped ? inSettings : label} describe={false} lazy>
			{(trigger) => (
				<button
					{...trigger}
					onBlur={() => {
						setTapped(false);
						trigger.onBlur();
					}}
					type="button"
					aria-label={label}
					tabIndex={-1}
					data-hidden-change=""
					onClick={(e) => {
						if (isTap(clickPointer(e))) {
							setTapped(true);
							// Focus opens the tooltip (and a tap elsewhere closes it).
							e.currentTarget.focus({ preventScroll: true });
							return;
						}
						keepFocusOnLine(e.currentTarget);
						showInvisibles.set(true);
					}}
					className={`relative mr-2 inline-flex w-[1ch] cursor-pointer select-none justify-center align-[-1px] text-warn focus-visible:outline-2 focus-visible:outline-accent ${WARNING_TARGET}`}
				>
					<AlertIcon size={12} aria-hidden />
				</button>
			)}
		</Tooltip>
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
			onPointerDown={picker?.onPointerDown}
			onPointerEnter={picker?.onPointerEnter}
			onClick={picker?.onClick}
			className={`${NUMBER_W} px-2 text-right align-top select-none ${props.className} ${picker ? "cursor-pointer" : ""}`}
		>
			{picker && pick?.button && n !== undefined ? (
				<button
					type="button"
					data-pick={pick.key}
					tabIndex={picker.roving === stopOf(props.side, pick.key) ? 0 : -1}
					aria-label={pick.label}
					aria-pressed={pick.picked}
					onKeyDown={picker.onKeyDown}
					onFocus={() => picker.onFocus(stopOf(props.side, pick.key))}
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
 * A line's code: its bubbles (the file's, `lead`, side by side on the diff's first row;
 * threads ending on it, `bubble`), sign and text, with the spans painted
 * over its characters (`marks`). Unified, the row carries the
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
	/** Its agent threads' bubble, after the comment bubble. */
	agentBubble?: ReactNode;
	lead?: ReactNode;
	/** The file bubble's slot holds this many bubbles (FileLead.count). */
	leadCount?: number;
	/** The hunk (`h<i>`) or gap (`g<i>`) the cell is in (codeSpan.ts). */
	hunk: string;
	/** In a hunk: its line's index in GitHub's order of it. */
	order?: number;
	marks: readonly Mark[];
	/** A pair's changed tokens on the line, tinted (wordBlocks.ts). */
	words?: Words;
	/** Side by side only: the cell's own paint, kind, landing, mark and pick. */
	cell?: {
		paint: string;
		landed: boolean;
		commented: boolean;
		picked: boolean;
	};
}) {
	const { line, cell, bubble, lead, agentBubble } = props;
	const bubbles =
		(bubble ? 1 : 0) +
		(lead ? (props.leadCount ?? 1) : 0) +
		(agentBubble ? 1 : 0);
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
			className={`${cell ? "align-top whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"} ${bubblePad(bubbles)} ${cell?.paint ?? ""}`}
		>
			{bubbles > 0 && (
				<BubbleSlot>
					{lead}
					{bubble}
					{agentBubble}
				</BubbleSlot>
			)}
			{props.words?.hidden ? (
				<HiddenWarning kind={line.kind} />
			) : (
				<Sign kind={line.kind} />
			)}
			<CodeLine
				text={line.text}
				lang={props.lang}
				tabWidth={props.tabWidth}
				newline={!line.noNewline}
				marks={props.marks}
				words={props.words}
			/>
		</td>
	);
}

/** A side with no line: both its cells say so, in the band tone, with nothing in them. */
function BlankCells({ side }: { side: DiffSide }) {
	return (
		<>
			<td
				data-testid={side === "LEFT" ? "old" : "new"}
				data-blank=""
				className={`${NUMBER_W} bg-band`}
			/>
			<td data-testid="code" data-blank="" className="bg-band" />
		</>
	);
}

const NO_LINES: ReadonlySet<DiffLine> = new Set();

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
	agent?: AgentRows;
	/** The hunk's paired lines' word marks (hunkWordMarks), by line. */
	words?: ReadonlyMap<DiffLine, readonly Mark[]>;
	/** The marked lines whose change doesn't show with hidden characters off (hiddenLines). */
	hidden?: ReadonlySet<DiffLine>;
}

/** The spans painted over a cell's characters: those of the threads on its keys. */
const marksOf = (keys: LineKey[], threads: RowThreads | undefined): Mark[] =>
	threads ? keys.flatMap((k) => threads.placement.marks.get(k) ?? []) : [];

const NO_MARKS: readonly Mark[] = [];

/**
 * A line's word marks and their tint: its kind's, faded on a reviewed
 * cluster (as REVIEWED_ROW_BG fades the row). A whitespace-only row has none.
 */
function wordsOf(
	line: RowLine,
	props: Pick<RowProps, "words" | "hidden">,
	reviewed: boolean,
): Words | undefined {
	if (line.kind !== "add" && line.kind !== "del") return undefined;
	const marks = props.words?.get(line);
	// A BOM may be hidden on a line without marks (hiddenLines).
	const hidden = props.hidden?.has(line) || undefined;
	if (!marks && !hidden) return undefined;
	return {
		marks: marks ?? NO_MARKS,
		tone: reviewed ? `${line.kind}-done` : line.kind,
		hidden,
	};
}

/**
 * What follows a row of lines: the opened rows of the threads ending on it
 * (a pair row may open one per side, the left side's first), then the new
 * threads being written under it. When the shape splits them, each row
 * sits under its side, the composers a row per side with any (a context
 * line's are RIGHT: what is written on it goes to GitHub on RIGHT); else every row spans the table and
 * both sides' composers share one.
 */
function RowTail(props: {
	opened: {
		endKey: LineKey;
		/** The bubble's keys: what closes it. */
		keys: LineKey[];
		ending: ReviewThread[];
		side: DiffSide;
	}[];
	composing: { side: DiffSide; items: NewThreadItem[] }[];
	threads?: RowThreads;
	composers?: RowComposers;
	/** Opened agent threads ending on the row, and Ask agent composers. */
	agentOpened?: { endKey: LineKey; ending: AgentThread[]; side: DiffSide }[];
	agentComposing?: { side: DiffSide; items: AgentComposerItem[] }[];
	agent?: AgentRows;
	shape: Shape;
	state?: ClusterView["state"];
}) {
	const { threads, shape, composers, agent } = props;
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
	const asking = shape.split
		? (props.agentComposing ?? [])
		: [
				{
					side: "RIGHT" as const,
					items: (props.agentComposing ?? []).flatMap(({ items }) => items),
				},
			];
	return (
		<>
			{threads &&
				props.opened.map((cell) => {
					const shown = cell.ending.filter(threads.collapse.shows);
					return (
						<ThreadRow
							key={cell.endKey}
							id={threads.idOf(cell.endKey)}
							readId={threads.readId}
							threads={shown}
							place={place(cell.side)}
							rail={rail}
							onResolved={(t, from) =>
								threads.collapse.resolved(
									cell.endKey,
									cell.keys,
									t,
									shown,
									from,
								)
							}
						/>
					);
				})}
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
			{agent &&
				(props.agentOpened ?? []).map((cell) => (
					<AgentThreadRow
						key={`agent:${cell.endKey}`}
						id={agent.idOf(cell.endKey)}
						threads={cell.ending}
						place={place(cell.side)}
						rail={rail}
					/>
				))}
			{agent &&
				asking
					.filter(({ items }) => items.length > 0)
					.map(({ side, items }) => (
						<TailRow
							key={`agent:${side}`}
							testId="agent-composer-row"
							place={place(side)}
							rail={rail}
						>
							{items.map((item) => (
								<AgentComposer
									key={item.clientId}
									clientId={item.clientId}
									span={item.span}
									quote={agent.quote(item.span)}
								/>
							))}
						</TailRow>
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
 * it (a context line lacking it shows it on both). Not code, so not part of
 * a text selection.
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
			<tr data-testid="no-newline" className="select-none">
				<Rail state={props.state} />
				<td colSpan={columns - 1} className="px-2 text-muted italic">
					{NO_NEWLINE}
				</td>
			</tr>
		);
	}
	return (
		<tr data-testid="no-newline" className="text-muted italic select-none">
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
	// The agent's threads and composers, whether or not comments are in.
	const agentKeys = props.agent ? rowKeys(line) : [];
	const asked = cellAgent(agentKeys, props.agent);
	const asking = props.agent?.composersAt(agentKeys) ?? [];
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
					className={numberBg}
					picker={picker}
					pick={pick("LEFT")}
				/>
				<NumberCell
					side="RIGHT"
					n={line.newNo}
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
					words={wordsOf(line, props, reviewed)}
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
					agentBubble={agentBubbleOf(asked, agentKeys, props.agent, where)}
				/>
			</tr>
			{line.noNewline && <NoNewlineRow shape={shape} state={state} />}
			<RowTail
				opened={
					open && endKey ? [{ endKey, keys, ending, side: cell.side }] : []
				}
				composing={[{ side: cell.side, items: composing }]}
				threads={threads}
				composers={props.composers}
				agentOpened={
					asked.open && asked.endKey
						? [{ endKey: asked.endKey, ending: asked.ending, side: cell.side }]
						: []
				}
				agentComposing={[{ side: cell.side, items: asking }]}
				agent={props.agent}
				shape={shape}
				state={state}
			/>
		</>
	);
}

/** A cell's bubbles: the file's (`lead`) and its line's threads'. */
interface Bubbles {
	lead?: ReactNode;
	bubble?: ReactNode;
	agent?: ReactNode;
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
	words?: Words;
	order?: number;
	pick: NumberPick;
	/** Its agent threads (a context line's: in the right cell only). */
	agentKeys: LineKey[];
	/**
	 * A context line's bubble, shown in both cells: the row's keys (what
	 * closes it), whether its threads are open under either cell, and
	 * whether this cell's bubble takes a focus asked of the line.
	 */
	shared?: { keys: LineKey[]; expanded?: LineKey; focus: boolean };
}

/**
 * One row of the side-by-side table: a context line on both sides, or a
 * pair with a line on each side that has one (sideBySide.ts). Each cell is
 * under its own side's key, with its own paint, mark, bubble, landing, pick
 * and opened thread row (the left side's first); a context line is one line
 * shown twice: its threads' bubble is in both cells (each opening them under
 * its own side), and its mark, spans, pick and landing paint both cells
 * (what is written on it is under the right cell; either cell, and
 * either number's button, picks or selects it as RIGHT, the cells contract). The file's bubble (`lead`, on
 * the diff's first row: a context row, with a cell on each side) sits in
 * the right cell beside the line's, its row right under the pair row. On a
 * phone (the shape that isn't `split`) a half is too narrow to keep room
 * for bubbles: they sit in a BubbleRow of their own right under the pair
 * row instead (a context line's once, on the right).
 */
function PairRow(
	props: RowProps & {
		row: SideRow;
		/** The file's bubble and its threads' row (the diff's first row). */
		lead?: FileLead;
	},
) {
	const { row, state, threads, shape, picker, lead, agent } = props;
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
			words: wordsOf(line, props, reviewed),
			order: props.orderOf?.(source),
			pick: pickOf(codeCellOf(line), true, picker),
			agentKeys: agent ? rowKeys(line) : [],
		};
	};
	let left: Cell | undefined;
	let right: Cell | undefined;
	if (row.kind === "context") {
		const line = row.line;
		const keys = threads ? rowKeys(line) : [];
		const both = cellOf(line, line, keys, `on line ${line.newNo}`);
		// One line shown twice, its threads' bubble in both cells: each
		// opens them under its own side's key, so under the side clicked.
		// Opened under both keys (a comment posted on it while open), the
		// first opened keeps them (the open set keeps the order they came in).
		const leftKey = lineKey("LEFT", line) ?? undefined;
		const rightKey = lineKey("RIGHT", line) ?? undefined;
		let firstOpen: LineKey | undefined;
		if (threads && both.endKey) {
			for (const k of threads.open) {
				if (k === leftKey || k === rightKey) {
					firstOpen = k;
					break;
				}
			}
		}
		const openLeft = Boolean(leftKey && firstOpen === leftKey);
		// The key the opened row is under (its id), for both bubbles.
		const expanded = both.open ? (openLeft ? leftKey : rightKey) : undefined;
		const shared = (focus: boolean) =>
			both.endKey ? { keys, expanded, focus } : undefined;
		right = {
			...both,
			endKey: both.endKey && rightKey,
			open: both.open && !openLeft,
			shared: shared(!shape.split || !openLeft),
		};
		// Each number a button for it, named by the number it shows; what
		// is written on it is under the right cell.
		left = {
			...both,
			keys: [],
			endKey: both.endKey && leftKey,
			open: openLeft,
			where: `on old line ${line.oldNo}`,
			pick: { ...both.pick, label: `Old line ${line.oldNo}` },
			shared: shared(openLeft),
			agentKeys: [],
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
	// right cell, so what is written on it is on the right).
	const sides: [DiffSide, Cell | undefined][] = [
		["LEFT", left],
		["RIGHT", right],
	];
	// A cell's bubbles: the file's (right, first row) then its threads'.
	const bubblesOf = (side: DiffSide, cell: Cell | undefined): Bubbles => {
		const fileBubble = side === "RIGHT" ? lead?.bubble : undefined;
		const endKey = cell?.endKey;
		const shared = cell?.shared;
		// A context line's: open under either cell, the row's keys.
		const expanded = shared ? shared.expanded : cell?.open && endKey;
		const keys = shared?.keys ?? cell?.keys ?? [];
		const lineBubble = cell && endKey && threads && (
			<ThreadBubble
				inline
				threads={cell.ending}
				where={cell.where}
				open={Boolean(expanded)}
				controls={expanded ? threads.idOf(expanded) : undefined}
				onToggle={() => threads.toggle(endKey, keys)}
				focus={
					threads.focus !== null &&
					keys.includes(threads.focus) &&
					(shared?.focus ?? true)
				}
				onFocused={threads.onFocused}
			/>
		);
		const agentKeys = cell?.agentKeys ?? [];
		return {
			lead: fileBubble,
			bubble: lineBubble || undefined,
			agent: cell
				? agentBubbleOf(
						cellAgent(agentKeys, agent),
						agentKeys,
						agent,
						cell.where,
					)
				: undefined,
		};
	};
	const own = !shape.split;
	const cells = (side: DiffSide, cell: Cell | undefined) => {
		if (!cell) return <BlankCells side={side} />;
		const { line } = cell;
		const bubbles: Bubbles = own ? {} : bubblesOf(side, cell);
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
					words={cell.words}
					lead={bubbles.lead}
					leadCount={lead?.count}
					agentBubble={bubbles.agent}
					cell={{
						paint: `${bg} ${mark}`,
						landed: cell.landed === "on",
						commented: cell.commented,
						picked: cell.pick.picked,
					}}
					bubble={bubbles.bubble}
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
			{own && (
				<BubbleRow
					// A context line's bubble once, on the right.
					left={row.kind === "context" ? {} : bubblesOf("LEFT", left)}
					right={bubblesOf("RIGHT", right)}
					state={state}
				/>
			)}
			{lead?.row(columnsOf(shape.view), state ? RAIL[state] : undefined)}
			{(noNewline.left || noNewline.right) && (
				<NoNewlineRow shape={shape} state={state} {...noNewline} />
			)}
			<RowTail
				opened={sides.flatMap(([side, cell]) =>
					cell?.open && cell.endKey
						? [
								{
									endKey: cell.endKey,
									keys: cell.shared?.keys ?? cell.keys,
									ending: cell.ending,
									side,
								},
							]
						: [],
				)}
				composing={sides.map(([side, cell]) => ({
					side,
					items: props.composers?.at(cell?.keys ?? []) ?? [],
				}))}
				threads={threads}
				composers={props.composers}
				agentOpened={sides.flatMap(([side, cell]) => {
					const asked = cellAgent(cell?.agentKeys ?? [], agent);
					return asked.open && asked.endKey
						? [{ endKey: asked.endKey, ending: asked.ending, side }]
						: [];
				})}
				agentComposing={sides.map(([side, cell]) => ({
					side,
					items: agent?.composersAt(cell?.agentKeys ?? []) ?? [],
				}))}
				agent={agent}
				shape={shape}
				state={state}
			/>
		</>
	);
}

/**
 * Side by side on a phone: a pair row's bubbles in a slim row of their own
 * right under it, so its narrow code cells keep their width. A left cell's
 * bubbles sit at the left, a right cell's at the right; the cluster's rail
 * carries on beside them. Not a line (no `diff-line`, numbers or code
 * cells) and not a thread row: the scroll anchor, the line picks and the
 * floating cluster controls pass it by, and so does a text selection
 * (select-none). None when neither cell has any.
 */
function BubbleRow(props: {
	left: Bubbles;
	right: Bubbles;
	state?: ClusterView["state"];
}) {
	const { left, right } = props;
	const has = (b: Bubbles) => Boolean(b.lead || b.bubble || b.agent);
	if (!has(left) && !has(right)) return null;
	const group = (side: DiffSide, b: Bubbles) => (
		<div
			data-bubbles={side}
			className={`flex ${side === "RIGHT" ? "justify-end" : ""}`}
		>
			{b.lead}
			{b.bubble}
			{b.agent}
		</div>
	);
	return (
		<tr data-testid="bubble-row" className="select-none">
			<Rail state={props.state} />
			<td colSpan={columnsOf("side-by-side") - 1} className="px-2 py-0">
				<div className="grid grid-cols-2">
					{group("LEFT", left)}
					{group("RIGHT", right)}
				</div>
			</td>
		</tr>
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
				glyph: "↕" as const,
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
			glyph: "↓" as const,
			label: `Load ${plural(step)} below`,
			from: start,
			to: start + step - 1,
		});
	}
	if (gap.below) {
		result.push({
			glyph: "↑" as const,
			label: `Load ${plural(step)} above`,
			from: end - step + 1,
			to: end,
		});
	}
	return result;
}

/**
 * Each arrow's name on its gap row while the pointer is where a click would
 * press it (`data-hot`), and how the arrow lights up then: as when hovered.
 */
const HOT = {
	"↓": {
		name: "down",
		lit: "group-data-[hot=down]/gap:bg-pressed group-data-[hot=down]/gap:text-ink",
	},
	"↑": {
		name: "up",
		lit: "group-data-[hot=up]/gap:bg-pressed group-data-[hot=up]/gap:text-ink",
	},
	"↕": {
		name: "all",
		lit: "group-data-[hot=all]/gap:bg-pressed group-data-[hot=all]/gap:text-ink",
	},
} as const;

type Glyph = keyof typeof HOT;

/**
 * A hidden-lines row that is its arrows' pointer target (gapRowTarget): a
 * click anywhere presses the arrow under the pointer, which is lit while
 * the pointer is there (`data-hot`, set on the element: no re-render per
 * move). When the arrows change under a still pointer (↑ turned ↓ ↑ into
 * ↕), the light follows at once. A pointer convenience only: the
 * keyboard has the buttons, and the row is never focusable.
 */
function GapRowTr(props: {
	glyphs: Glyph[];
	onPress: (index: number) => void;
	className: string;
	children: ReactNode;
}) {
	const row = useRef<HTMLTableRowElement>(null);
	const pointer = useRef<{ target: EventTarget | null; clientY: number }>(null);
	const glyphs = props.glyphs.join("");
	// biome-ignore lint/correctness/useExhaustiveDependencies: the arrows, by their glyphs.
	const light = useCallback(() => {
		const el = row.current;
		if (!el) return;
		const at = pointer.current;
		if (!at || props.glyphs.length === 0) {
			delete el.dataset.hot;
			return;
		}
		const index = gapRowTarget(
			{ ...at, currentTarget: el },
			props.glyphs.length,
		);
		const glyph = index === null ? undefined : props.glyphs[index];
		el.dataset.hot = glyph ? HOT[glyph].name : "";
	}, [glyphs]);
	useLayoutEffect(light, [light]);
	const reactive = props.glyphs.length > 0;
	return (
		<tr
			ref={row}
			data-testid="gap-row"
			onPointerMove={(e) => {
				pointer.current = { target: e.target, clientY: e.clientY };
				light();
			}}
			onPointerLeave={() => {
				pointer.current = null;
				light();
			}}
			onClick={
				reactive
					? (e) => {
							const index = gapRowTarget(e, props.glyphs.length);
							if (index !== null) props.onPress(index);
						}
					: undefined
			}
			className={`${props.className} ${reactive ? "cursor-pointer" : ""}`}
		>
			{props.children}
		</tr>
	);
}

/** What a pointer on a gap row can't press through: its own controls. */
const OWN_CONTROLS = "button, a, input, textarea, select, [role=button]";

/**
 * Which of a gap row's `count` arrows a pointer event at this point presses:
 * the one arrow anywhere on the row; with two (↓ above ↑, like GitHub's), ↓
 * on the row's top half and ↑ on its bottom half. None over the row's other
 * controls (a bubble, Retry), which keep their own clicks.
 */
export function gapRowTarget(
	e: { target: EventTarget | null; currentTarget: Element; clientY: number },
	count: number,
): number | null {
	if (count === 0) return null;
	const own =
		e.target instanceof Element ? e.target.closest(OWN_CONTROLS) : null;
	if (own && e.currentTarget.contains(own) && !own.hasAttribute("data-glyph")) {
		return null;
	}
	if (count === 1) return 0;
	const box = e.currentTarget.getBoundingClientRect();
	return e.clientY < box.top + box.height / 2 ? 0 : 1;
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
	/** The file's bubble and its threads' row (FileDiff). */
	lead?: FileLead;
}) {
	const { file, revision } = props;
	const hunks = useQuery(hunksQuery(revision, file.index));
	const ignoreWs = ignoreWhitespace.use();
	const view: View = sideBySide.use() ? "side-by-side" : "unified";
	const wide = useMedia(NOT_PHONE);
	const shape = useMemo<Shape>(
		() => ({ view, split: view === "side-by-side" && wide }),
		[view, wide],
	);
	const columns = columnsOf(view);
	// Unified, the file bubble is centred on rows that aren't code (FileBubbleSlot).
	const centred = view === "unified";
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
	useBubbleFocusKept(scroller, wide);
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

	// The agent's side: its threads (their own read) and open composers.
	const sessionHead = useQuery({ ...sessionQuery, enabled: false }).data
		?.snapshotHead;
	// FilesPage reads them (and the tree counts them); here, from the cache.
	const agentThreads = useQuery({ ...agentThreadsQuery, enabled: false }).data
		?.threads;
	const agentPlaceables = useMemo(
		() => (agentThreads ?? []).map(agentPlaceable),
		[agentThreads],
	);
	const agentComposerList = useAgentComposers();
	const agentHeadNow = snapshotHead ?? sessionHead;
	const agentMine = agentComposerList.filter(
		(c) => c.span.path === file.path && c.span.subject === "line",
	);
	const agentLineItems = agentMine.filter(
		(c) => c.span.commit === agentHeadNow,
	);
	const agentOrphans = agentHeadNow
		? agentMine.filter((c) => c.span.commit !== agentHeadNow)
		: [];

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
	// Resolve closes the thread to its bubble (resolveCollapse.ts): under
	// every key of its row, as the bubble closes it (a context line's is
	// open under either side's).
	const closing = useRef<LineKey[]>([]);
	const collapse = useResolveCollapse<LineKey>({
		open: (key) => setOpenThreads((open) => new Set(open).add(key)),
		close: (key) =>
			setOpenThreads((open) => {
				const next = new Set(open);
				for (const k of [key, ...closing.current]) next.delete(k);
				return next;
			}),
		focus: setFocusThread,
		element: (key) =>
			scroller.current?.querySelector(
				`[aria-controls="${CSS.escape(`${idBase}-thread-${key}`)}"]`,
			) ?? null,
	});
	// A gap's window that failed drops its focus target, so a later Retry
	// doesn't take focus from wherever the reader is by then.
	const windowFailed = contexts.some((c) => c.isError);
	useEffect(() => {
		if (windowFailed) setFocusThread(null);
	}, [windowFailed]);
	const toggleThreads = (key: LineKey, keys: LineKey[]) => {
		setFocusThread(null);
		for (const k of keys) collapse.toggled(k);
		collapse.toggled(key);
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

	const picker = usePicker(
		scroller,
		file.path,
		hunks.data?.hunks[0],
		view,
		ignoreWs,
	);

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
					collapse: {
						shows: collapse.shows,
						resolved: (endKey, keys, t, shown, from) => {
							closing.current = keys;
							collapse.resolved(endKey, t, shown, from);
						},
					},
				}
			: undefined;

	// The reviewer's agent threads on this file, with their own bubbles and
	// open set; the Ask agent composers under their span's last row. Apart
	// from GitHub's threads: they show while those are still on their way.
	const agentHead = snapshotHead ?? sessionHead;
	const agentPlacement = agentHead
		? placeThreads<AgentPlaceable>({
				threads: agentPlaceables,
				path: file.path,
				snapshotHead: agentHead,
				hunks: hunks.data ?? null,
				loadedContext: [...loaded.values()],
				noLines: file.binary || file.submodule,
				spans: agentLineItems.map((c) => c.span as SpanRange),
			})
		: null;
	const [openAgent, setOpenAgent] = useState<ReadonlySet<LineKey>>(
		() => new Set(),
	);
	const toggleAgent = (key: LineKey, keys: LineKey[]) =>
		setOpenAgent((open) => {
			const next = new Set(open);
			if (keys.some((k) => next.has(k))) for (const k of keys) next.delete(k);
			else next.add(key);
			return next;
		});
	const quoteSpan = (span: CodeSpan) => {
		const start = textAt.get(`${span.startSide}:${span.startLine}` as LineKey);
		const end = textAt.get(`${span.side}:${span.line}` as LineKey);
		const same = span.startSide === span.side && span.startLine === span.line;
		return quoteOf(span, same ? [end ?? ""] : [start ?? "", end ?? ""]);
	};
	const agentRows: AgentRows | undefined = agentPlacement
		? {
				placement: agentPlacement,
				open: openAgent,
				toggle: toggleAgent,
				idOf: (key) => `${idBase}-agent-${key}`,
				composersAt: (keys) =>
					agentLineItems.filter((c) =>
						keys.includes(`${c.span.side}:${c.span.line}` as LineKey),
					),
				quote: quoteSpan,
			}
		: undefined;
	// Asked on a row that isn't shown (a gap), or on an earlier head: above
	// the diff, never lost.
	const agentUnshown = [
		...(hunks.data
			? agentLineItems.filter((_, i) => !agentPlacement?.spansShown.has(i))
			: []),
		...agentOrphans,
	];
	// A thread just asked from this page opens where it lands.
	const agentEnded = agentPlacement?.end;
	useEffect(() => {
		if (!agentEnded) return;
		const fresh: LineKey[] = [];
		for (const [key, list] of agentEnded) {
			if (list.some((p) => takeJustAsked(p.thread.id))) fresh.push(key);
		}
		if (fresh.length) {
			setOpenAgent((open) => {
				const next = new Set(open);
				for (const k of fresh) next.add(k);
				return next;
			});
		}
	}, [agentEnded]);

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
	const contextRows = (
		from: number,
		to: number,
		lead?: () => FileLead | undefined,
	) => {
		const rows: ReactNode[] = [];
		for (let n = from; n <= to; n++) {
			const line = loaded.get(n);
			if (line) {
				// First in the table: the file bubble. Unified, a row of its
				// own above it, never over code; side by side, in its right cell.
				const first = rows.length === 0 ? lead?.() : undefined;
				if (first && centred) {
					rows.push(
						<LeadRow
							key={`c${n}:file`}
							lead={first}
							columns={columns}
							centred
						/>,
					);
				}
				const row = {
					shape,
					lang,
					tabWidth: file.tabWidth,
					landed,
					threads: rowThreads,
					hunk: hunkOf(n),
					picker,
					composers,
					agent: agentRows,
				};
				rows.push(
					view === "side-by-side" ? (
						<PairRow
							key={`c${n}`}
							row={{ kind: "context", line }}
							lead={first}
							{...row}
						/>
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
	const hunkAt = (index: number) => hunks.data?.hunks[index];
	/** Hunks whose heading went on the hidden-lines row above them, this render. */
	const headedOnGap = new Set<number>();
	const gapRows = (gap: Gap | undefined, lead?: () => FileLead | undefined) => {
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
		// The agent's threads in the gap, on runs the same way.
		const agentTargetOf = (p: AgentPlaceable) =>
			agentPlacement?.gapTargets.get(p);
		const agentOf = new Map<number, AgentPlaceable[]>();
		for (const p of agentPlacement?.gaps.get(gap.index) ?? []) {
			const n = agentTargetOf(p)?.show[1] ?? gap.from;
			let at = runs.findIndex((r) => r.from <= n && n <= r.to);
			if (at < 0 && runs.length === 0) {
				runs.push({ from: gap.to + 1, to: gap.to });
				at = 0;
			}
			if (at < 0) at = 0;
			agentOf.set(at, [...(agentOf.get(at) ?? []), p]);
		}
		const rows: ReactNode[] = [];
		let next = gap.from;
		runs.forEach((run, i) => {
			rows.push(...contextRows(next, run.from - 1, lead));
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
			const runAgent = agentOf.get(i) ?? [];
			if (
				remaining === 0 &&
				!pending &&
				failed.length === 0 &&
				runThreads.length === 0 &&
				runAgent.length === 0
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
			const loadAround = (target: { show: [number, number] }) => {
				const [from, to] = target.show;
				const window: [number, number] =
					from - start <= FAR && from - start <= end - to
						? [start, Math.min(end, to + 3)]
						: end - to <= FAR
							? [Math.max(start, from - 3), end]
							: [Math.max(start, from - 10), Math.min(end, to + 3)];
				if (window[0] <= window[1]) addRange(window[0], window[1]);
			};
			/** Opens the run's agent threads where they are, like its comments. */
			const openRunAgent = () => {
				for (const p of runAgent) {
					const target = agentTargetOf(p);
					if (!target) continue;
					loadAround(target);
					setOpenAgent((open) => new Set(open).add(target.key));
				}
			};
			const openRunThreads = () => {
				for (const t of runThreads) {
					const target = targetOf(t);
					if (!target) continue;
					loadAround(target);
					setOpenThreads((open) => new Set(open).add(target.key));
					setFocusThread(target.key);
				}
			};
			const runLead = lead?.();
			const where =
				run.from === run.to
					? `on hidden line ${run.from}`
					: `on hidden lines ${run.from}–${run.to}`;
			// The heading of the hunk below, once per hunk: here when this row
			// sits right above the hunk (its run ends at the gap's end, so no
			// loaded line comes between) and shows its count or its loading;
			// else on the hunk's @@ row (headedOnGap).
			const heading =
				run.to === gap.to && failed.length === 0 && (pending || remaining > 0)
					? hunkAt(gap.index)?.heading
					: undefined;
			if (heading) headedOnGap.add(gap.index);
			const bubbles =
				(runThreads.length > 0 ? 1 : 0) + (runAgent.length > 0 ? 1 : 0);
			rows.push(
				<GapRowTr
					key={`gap${gap.index}:${run.from}`}
					glyphs={buttons.map((b) => b.glyph)}
					onPress={(at) => {
						const b = buttons[at];
						if (b) addRange(b.from, b.to);
					}}
					// Not code: a selection across it leaves it out.
					className="group/gap bg-hunk text-hunk-ink select-none [--ctl-w:3rem] pointer-coarse:[--ctl-w:5.25rem]"
				>
					<td colSpan={2} className="px-1">
						<div
							className={`flex ${buttons.length > 1 ? "flex-col items-start" : ""}`}
						>
							{buttons.map((b) => (
								<Tooltip key={b.glyph} content={b.label} describe={false}>
									{(trigger) => (
										<button
											type="button"
											{...trigger}
											aria-label={b.label}
											data-glyph={b.glyph}
											onClick={(e) => {
												// The row's own click would load it again.
												e.stopPropagation();
												addRange(b.from, b.to);
											}}
											className={`rounded px-1 hover:bg-pressed hover:text-ink focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:min-h-10 pointer-coarse:min-w-10 ${HOT[b.glyph].lit}`}
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
						className={`font-sans ${leadText(runLead, centred, bubbles)}`}
					>
						{runLead && centred && (
							<FileBubbleSlot count={runLead.count}>
								{runLead.bubble}
							</FileBubbleSlot>
						)}
						{(runThreads.length > 0 ||
							runAgent.length > 0 ||
							(runLead && !centred)) && (
							<BubbleSlot>
								{!centred && runLead?.bubble}
								{runThreads.length > 0 && (
									<ThreadBubble
										inline
										threads={runThreads}
										where={where}
										open={false}
										onToggle={openRunThreads}
									/>
								)}
								{runAgent.length > 0 && (
									<AgentBubble
										inline
										threads={runAgent.map((p) => p.thread)}
										where={where}
										open={false}
										onToggle={openRunAgent}
									/>
								)}
							</BubbleSlot>
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
						) : pending || remaining > 0 ? (
							<Labelled
								label={
									pending ? (
										<Spinner label="Loading lines" size={14} />
									) : (
										`${remaining} hidden ${remaining === 1 ? "line" : "lines"}`
									)
								}
								heading={heading}
								reserve={labelReserve(
									"var(--ctl-w) + 0.5rem",
									bubbles + (runLead && !centred ? (runLead.count ?? 1) : 0),
									runLead && centred
										? { count: runLead.count ?? 1 }
										: undefined,
								)}
							/>
						) : null}
					</td>
				</GapRowTr>,
			);
			if (runLead) {
				rows.push(
					<Fragment key={`gap${gap.index}:${run.from}:file`}>
						{runLead.row(columns)}
					</Fragment>,
				);
			}
		});
		rows.push(...contextRows(next, gap.to, lead));
		return <tbody key={`gap${gap.index}`}>{rows}</tbody>;
	};

	const gapAt = (index: number) => gaps.find((g) => g.index === index);

	// The file's bubble goes on the first row shown, whichever it is: the
	// rows below are built in the table's order, and the first to ask takes it.
	let leadLeft = props.lead;
	const takeLead = () => {
		const lead = leadLeft;
		leadLeft = undefined;
		return lead;
	};
	const clusterRows = fileClusters.map((cluster) => {
		const lead = takeLead();
		return (
			<tbody key={cluster.key} className="group">
				<tr className={cluster.state === "reviewed" ? "text-muted" : ""}>
					<Rail state={cluster.state} />
					<ControlsCell className="py-1">{checkbox(cluster)}</ControlsCell>
					<td
						colSpan={columns - 2}
						className={`${leadText(lead, centred)} py-1 font-sans text-sm`}
					>
						{lead && <LeadSlot lead={lead} centred={centred} />}
						{cluster.label}
						<CrossedOffNote cluster={cluster} id={noteId(cluster)} />
					</td>
				</tr>
				{lead?.row(columns, RAIL[cluster.state])}
			</tbody>
		);
	});
	const hunkRows = hunks.data?.hunks.map((hunk, index) => (
		<Fragment key={hunkHeader(hunk)}>
			{gapRows(gapAt(index), takeLead)}
			<HunkRows
				hunk={hunk}
				// Once per hunk: not here when its hidden-lines row has it.
				heading={headedOnGap.has(index) ? undefined : hunk.heading}
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
				agent={agentRows}
				lead={takeLead()}
			/>
		</Fragment>
	));
	const tailRows =
		hunks.data && gapRows(gapAt(hunks.data.hunks.length), takeLead);
	// Nothing to show it on (no rows, or they failed to load): a row of its own.
	const lead = hunks.isPending ? undefined : takeLead();

	return (
		<div ref={root}>
			{hint && <LandingHint hint={hint} />}
			{agentUnshown.length > 0 && (
				<div
					data-testid="agent-composers-unshown"
					className="space-y-2 border-b border-line bg-canvas p-2"
				>
					{agentUnshown.map((c) => (
						<AgentComposer
							key={c.clientId}
							clientId={c.clientId}
							span={c.span}
							quote={quoteSpan(c.span)}
						/>
					))}
				</div>
			)}
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
					style={
						{
							"--num-w": `calc(${numberDigits(hunks.data)}ch + 1rem)`,
						} as CSSProperties
					}
					className={`border-collapse bg-code font-mono text-xs leading-5 text-code-ink ${
						view === "side-by-side" ? "w-full table-fixed" : "min-w-full"
					}`}
				>
					{view === "side-by-side" && (
						<colgroup>
							<col className="w-1" />
							<col className="w-11 pointer-coarse:w-20" />
							<col className={NUMBER_W} />
							<col />
							<col className={NUMBER_W} />
							<col />
						</colgroup>
					)}
					{lead && (
						<tbody>
							<LeadRow lead={lead} columns={columns} centred={centred} />
						</tbody>
					)}
					{clusterRows}
					{hunkRows}
					{tailRows}
				</table>
			</div>
			{hunks.isPending && (
				// A screen tall while loading, so a file picked in the tree can
				// scroll its header to the top before its lines arrive.
				<div aria-busy="true" className="min-h-[100dvh] px-3 py-2">
					<Spinner label="Loading diff" />
				</div>
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
 * Side by side, crossing the phone breakpoint (`wide`) moves a pair row's
 * bubbles between its code cells and a row of their own: new elements.
 * The bubble that had focus gets it back in its new place, found by its
 * name (unique in a file: a context line's two say which number they are
 * beside). Only when focus went nowhere else meanwhile: not when it left
 * for another file's bubble, which keeps it there.
 */
function useBubbleFocusKept(
	scroller: RefObject<HTMLDivElement | null>,
	wide: boolean,
) {
	const last = useRef<HTMLElement | null>(null);
	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const isBubble = (t: EventTarget | null): t is HTMLElement =>
			t instanceof HTMLElement && t.dataset.testid === "thread-bubble";
		const onIn = (e: FocusEvent) => {
			last.current = isBubble(e.target) ? e.target : null;
		};
		// Left for another file or the rest of the page, or for nowhere (not
		// for a re-render's removal, which names no element): forgotten.
		const onOut = (e: FocusEvent) => {
			const t = e.target;
			if (!isBubble(t)) return;
			const to = e.relatedTarget;
			if (to instanceof Node) {
				if (!el.contains(to)) last.current = null;
				return;
			}
			queueMicrotask(() => {
				if (last.current === t && t.isConnected) last.current = null;
			});
		};
		el.addEventListener("focusin", onIn);
		el.addEventListener("focusout", onOut);
		return () => {
			el.removeEventListener("focusin", onIn);
			el.removeEventListener("focusout", onOut);
		};
	}, [scroller]);
	// After every commit: a bubble gone in one that didn't cross the
	// breakpoint (its thread deleted, its cluster collapsed) is forgotten.
	const shownWide = useRef(wide);
	useLayoutEffect(() => {
		const crossed = shownWide.current !== wide;
		shownWide.current = wide;
		const was = last.current;
		if (!was || was.isConnected) return;
		last.current = null;
		if (!crossed) return;
		const active = document.activeElement;
		if (active && active !== document.body) return;
		const name = was.getAttribute("aria-label");
		if (!name) return;
		scroller.current
			?.querySelector<HTMLElement>(
				`[data-testid="thread-bubble"][aria-label="${CSS.escape(name)}"]`,
			)
			?.focus({ preventScroll: true });
	});
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
		// The wash fades on the cells and, through --wash, on their word marks
		// (Tailwind's easing, as transition-shadow had).
		"[&>td]:[transition-property:box-shadow,--wash] [&>td]:ease-(--default-transition-timing-function) [&>td]:duration-1000 motion-reduce:[&>td]:transition-none",
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
	/** The heading on its @@ row (none when the row above has it). */
	heading?: string;
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
	agent?: AgentRows;
	/** The file's bubble, on the hunk's header row (the diff's first row). */
	lead?: FileLead;
}) {
	const { threads, hunk, ignoreWhitespace, shape, lead } = props;
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
	// compose. The word marks of the hunk's pairs with them, over all its
	// runs' rows (a block may span two clusters), computed here, with the
	// rows: a pair is never shown plain while its marks are pending.
	const { hunkRuns, words } = useMemo(() => {
		const runs = viewRuns(hunk.lines, ignoreWhitespace).map((run) => ({
			...run,
			side: view === "side-by-side" ? layoutRows(run.rows) : null,
		}));
		return {
			hunkRuns: runs,
			words: hunkWordMarks(runs.flatMap((run) => run.rows)),
		};
	}, [hunk, ignoreWhitespace, view]);
	// The lines whose change doesn't show with hidden characters off (none
	// to look for while they show).
	const showHidden = useShowInvisibles();
	const hidden = useMemo(
		() =>
			showHidden
				? NO_LINES
				: hiddenLines(
						hunkRuns.flatMap((run) => run.rows),
						words,
						props.tabWidth ?? DEFAULT_TAB_WIDTH,
					),
		[showHidden, hunkRuns, words, props.tabWidth],
	);
	const columns = columnsOf(view);
	// Unified, the file bubble is centred on rows that aren't code (FileBubbleSlot).
	const centred = view === "unified";
	return (
		<>
			<tbody>
				{/* Not code: a selection across hunks leaves the header out. */}
				<tr
					data-testid="hunk-header"
					className="bg-hunk text-hunk-ink select-none"
				>
					<td colSpan={columns} className={`${leadText(lead, centred)} py-0.5`}>
						{lead && <LeadSlot lead={lead} centred={centred} />}
						<Labelled
							label={hunkHeader(hunk)}
							heading={props.heading}
							reserve={labelReserve(
								"0.5rem",
								lead && !centred ? (lead.count ?? 1) : 0,
								lead && centred ? { count: lead.count ?? 1 } : undefined,
							)}
						/>
					</td>
				</tr>
				{lead?.row(columns)}
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
					agent: props.agent,
					words,
					hidden,
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
									props.agent?.placement.end.has(k) ||
									(props.agent?.composersAt([k]).length ?? 0) > 0 ||
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

/**
 * Picking lines by their numbers: a click (or tap) picks the row, again
 * clears it (side by side, a context line's other number moves the pick
 * to its column instead); shift-click, or dragging down the numbers with a mouse,
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
 * A context row's two numbers are both buttons for its one line.
 */
function usePicker(
	scroller: RefObject<HTMLDivElement | null>,
	path: string,
	firstHunk: DisplayHunk | undefined,
	view: View,
	ignoreWs: boolean,
): Picker {
	const picks = usePicks();
	const keys = useMemo(
		() =>
			new Set(picks?.path === path ? picks.lines.map((l) => pickKey(l)) : []),
		[picks, path],
	);
	// The last focused button's stop, with the view and Ignore whitespace
	// it was focused under: under others it may name no button (a context
	// row's left number side by side, a line of a whitespace-only cluster
	// that collapsed), so they start from the first row's.
	const shown = `${view} ${ignoreWs}`;
	const [focused, setFocused] = useState<{
		shown: string;
		stop: string;
	} | null>(null);
	const roving = focused?.shown === shown ? focused.stop : null;
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
	// Side by side, picks with the number column their focus was picked
	// from (unified number cells name no side the line is shown on: a
	// removed line's blank new number picks it too).
	const withColumn = (next: Picks | null, column: Element) =>
		next && view === "side-by-side"
			? { ...next, column: sideOf(column) }
			: next;
	const pickTo = (t: CellLine, extend: boolean, column: Element) => {
		const cur = getPicks();
		const mine = cur?.path === t.path ? cur : null;
		if (extend && mine) {
			setPicks(
				withColumn(pickRange(cells(), mine.anchor, picked(t)), column) ?? mine,
			);
		} else if (
			mine?.lines.length === 1 &&
			pickKey(mine.anchor) === pickKey(t)
		) {
			// Its number again clears it; a context line's other number
			// (side by side) moves it to that column (none yet: its focus's).
			const moved = withColumn(mine, column);
			const was = mine.column ?? mine.focus.side;
			setPicks(!moved?.column || moved.column === was ? null : moved);
		} else {
			setPicks(withColumn(pickRange(cells(), picked(t), picked(t)), column));
		}
		// Picked lines, not text: one or the other makes the span.
		window.getSelection()?.removeAllRanges();
	};
	return {
		keys,
		roving:
			roving ??
			(first
				? stopOf(codeCellOf(first).side, pickKey(codeCellOf(first)))
				: null),
		onPointerDown: (e) => {
			pointer.current = e.pointerType;
			if (e.pointerType !== "mouse" || e.button !== 0) return;
			const t = targetOf(e.currentTarget);
			if (!t) return;
			// No text selection starts from the numbers.
			e.preventDefault();
			// The pressed number's own button, else (unified) its row's.
			const button = `button[data-pick="${CSS.escape(pickKey(t))}"]`;
			(
				e.currentTarget.querySelector<HTMLButtonElement>(button) ??
				e.currentTarget.closest("tr")?.querySelector<HTMLButtonElement>(button)
			)?.focus({ preventScroll: true });
			dragging.current = true;
			pickTo(t, e.shiftKey, e.currentTarget);
		},
		onPointerEnter: (e) => {
			if (!dragging.current || (e.buttons & 1) === 0) return;
			const t = targetOf(e.currentTarget);
			const cur = getPicks();
			if (!t || cur?.path !== t.path) return;
			setPicks(
				withColumn(
					pickRange(cells(), cur.anchor, picked(t)),
					e.currentTarget,
				) ?? cur,
			);
		},
		onClick: (e) => {
			const t = targetOf(e.currentTarget);
			if (!t) return;
			// The keyboard's Enter or Space on the number button.
			if (e.detail === 0) pickTo(t, e.shiftKey, e.currentTarget);
			// A tap: a second one extends (a mouse picked on pointer down).
			else if (pointer.current !== "mouse") {
				const cur = getPicks();
				pickTo(
					t,
					cur?.path === t.path && pickKey(cur.anchor) !== pickKey(t),
					e.currentTarget,
				);
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
			} else {
				const col = sideOf(e.currentTarget);
				for (
					let i = at + arrow.step;
					i >= 0 && i < buttons.length;
					i += arrow.step
				) {
					const b = buttons[i] as HTMLButtonElement;
					if (sideOf(b) === col) {
						next = b;
						break;
					}
				}
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
			setPicks(withColumn(pickRange(cells(), anchor, picked(to)), next));
		},
		onFocus: (stop) => setFocused({ shown, stop }),
	};
}
