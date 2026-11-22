import {
	AlertIcon,
	GrabberIcon,
	PinIcon,
	SparkleFillIcon,
	UndoIcon,
	XIcon,
} from "@primer/octicons-react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type {
	AgentPlacementsAnswer,
	SpanAgentThread,
} from "../../shared/agent";
import {
	type MovedInfo,
	type ThreadRef,
	threadKey,
} from "../../shared/rereview/moves";
import type { ThreadPlacement } from "../../shared/rereview/placement";
import type { PlacementsAnswer, ThreadAnchorRef } from "../../shared/types";
import { useAgentPlacing } from "../agent/placeable";
import {
	AGENT_PLACEMENTS_KEY,
	ApiError,
	deleteMove,
	placementsQuery,
	postMove,
	type RereviewTo,
} from "../api";
import { Chip } from "../overview/parts";
import { MoveSlot } from "../sticky";
import { Tooltip } from "../Tooltip";
import { setPicks } from "./linePicks";
import { usePlacementInfo } from "./ThreadFate";
import { threadFocus } from "./threadFocus";

/*
 * Thread moves in Files changed (CAR-139): the handle on a traced thread's
 * card (drag onto a line of its file, or press for move mode), move mode's
 * bar and "Place here", the `moved` chip with Undo, and the writes
 * (POST /moves, DELETE /moves/:id), optimistic on whichever placements
 * query holds the thread. A move never touches coverage, counts or
 * GitHub: it only says where the reviewer reads a thread.
 */

/** A placements answer's entry. */
type Entry = { id: string; placement: ThreadPlacement; moved?: MovedInfo };

/** Each thread's move, by thread id, from a placements answer. */
export function movesOf(
	answer: { threads: readonly Entry[] } | null | undefined,
): ReadonlyMap<string, MovedInfo> | null {
	if (!answer) return null;
	const out = new Map<string, MovedInfo>();
	for (const t of answer.threads) if (t.moved) out.set(t.id, t.moved);
	return out;
}

/**
 * Where a move on this view writes (CAR-139): the target viewed when it
 * takes writes, the latest patch set or a head that is no patch set yet
 * (an earlier one is read-only), once its placements are in; else none.
 * Only the target decides: the comparison base (the branch, or an earlier
 * patch set in the since view) never does (principle 9), as a move's
 * anchor is the target's full diff's in either view (moveEnd).
 */
export function moveTargetOf(
	to: RereviewTo | null,
	answer: { patchset: number | null } | null,
	latest: number | null,
): RereviewTo | null {
	if (to === null || answer === null) return null;
	return answer.patchset === null || answer.patchset === latest ? to : null;
}

// ---------------------------------------------------------------------------
// Move mode: one thread at a time, page-wide.

export interface Moving {
	thread: ThreadRef;
	/** The thread's first words (text, never HTML). */
	words: string;
}

let moving: Moving | null = null;
const listeners = new Set<() => void>();
const notify = () => {
	for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
};

export const getMoving = (): Moving | null => moving;

/** Starts move mode for a thread (any lines picked before are dropped). */
export function startMoveMode(next: Moving): void {
	setPicks(null);
	moving = next;
	notify();
}

/** Leaves move mode, writing nothing. */
export function endMoveMode(): void {
	if (moving === null) return;
	moving = null;
	notify();
}

export function useMoveMode(): Moving | null {
	return useSyncExternalStore(subscribe, getMoving, getMoving);
}

// ---------------------------------------------------------------------------
// Writes.

/** A refused or failed write, shown under its card. */
export interface MoveFailure {
	message: string;
	/** Present when trying again can help (not a refusal: 400, 404, 409). */
	retry?: () => void;
}

export interface MoveWrites {
	/** The target writes go to (the latest patch set or a head); null: none here. */
	to: RereviewTo | null;
	move: (thread: ThreadRef, anchor: ThreadAnchorRef) => void;
	undo: (thread: ThreadRef, move: string) => void;
	failure: (thread: ThreadRef) => MoveFailure | undefined;
	dismiss: (thread: ThreadRef) => void;
	busy: (thread: ThreadRef) => boolean;
}

const MoveWritesContext = createContext<MoveWrites | null>(null);
export const MoveWritesProvider = MoveWritesContext.Provider;
export const useMoveWrites = () => useContext(MoveWritesContext);

/** An optimistic edit's undo: each query's data as it was. */
type Saved = [readonly unknown[], unknown][];

const targetKey = (to: RereviewTo) =>
	"patchset" in to ? `ps:${to.patchset}` : `head:${to.head}`;

/** The placements queries that hold `thread` on target `to`: their keys. */
function queriesOf(
	client: QueryClient,
	thread: ThreadRef,
	readId: string | null,
	to: RereviewTo,
): (readonly unknown[])[] {
	if (thread.source === "github") {
		return readId ? [placementsQuery(readId, to).queryKey] : [];
	}
	return client
		.getQueriesData({ queryKey: AGENT_PLACEMENTS_KEY })
		.map(([key]) => key)
		.filter((key) => key[1] === targetKey(to));
}

/** Sets `thread`'s entry in the placements that hold it; returns what was there. */
function setEntry(
	client: QueryClient,
	keys: readonly (readonly unknown[])[],
	id: string,
	edit: (old: Entry) => Entry,
): Saved {
	const saved: Saved = [];
	for (const key of keys) {
		const before = client.getQueryData(key);
		saved.push([key, before]);
		client.setQueryData(key, (old: unknown) => {
			const a = old as PlacementsAnswer | AgentPlacementsAnswer | undefined;
			if (!a || "pending" in a || !Array.isArray(a.threads)) return old;
			return {
				...a,
				threads: a.threads.map((t) => (t.id === id ? edit(t) : t)),
			};
		});
	}
	return saved;
}

const restore = (client: QueryClient, saved: Saved) => {
	for (const [key, data] of saved) client.setQueryData(key, data);
};

/** A refusal (400, 404, 409) won't change by trying again. */
const refused = (e: unknown) =>
	e instanceof ApiError && e.status >= 400 && e.status < 500;

const messageOf = (e: unknown, undo: boolean): string => {
	if (e instanceof ApiError && e.status === 409) {
		return undo
			? "Already undone elsewhere"
			: "Read-only here: an earlier patch set";
	}
	return e instanceof Error ? e.message : String(e);
};

/**
 * The page's move writes (FilesPage): optimistic on the placements query
 * that holds the thread, rolled back on a failure, shown under the card
 * with a Retry where one can help. After a move lands, its card scrolls
 * into view on its new line and focus goes to its Undo.
 */
export function useMoveWritesHost(args: {
	readId: string | null;
	to: RereviewTo | null;
}): MoveWrites {
	const client = useQueryClient();
	const [failures, setFailures] = useState<ReadonlyMap<string, MoveFailure>>(
		() => new Map(),
	);
	const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
	/** Each move's thread entry before it, for an undo shown at once. */
	const before = useRef(new Map<string, Entry>());
	const { readId, to } = args;
	const setFailure = useCallback((key: string, f: MoveFailure | null) => {
		setFailures((old) => {
			const next = new Map(old);
			if (f) next.set(key, f);
			else next.delete(key);
			return next;
		});
	}, []);
	const setBusyKey = useCallback((key: string, on: boolean) => {
		setBusy((old) => {
			const next = new Set(old);
			if (on) next.add(key);
			else next.delete(key);
			return next;
		});
	}, []);
	const settle = useCallback(() => {
		void client.invalidateQueries({ queryKey: ["placements"] });
		void client.invalidateQueries({ queryKey: AGENT_PLACEMENTS_KEY });
	}, [client]);
	const move = useCallback(
		(thread: ThreadRef, anchor: ThreadAnchorRef) => {
			if (!to) return;
			const key = threadKey(thread);
			const keys = queriesOf(client, thread, readId, to);
			let prior: Entry | undefined;
			const saved = setEntry(client, keys, thread.id, (old) => {
				prior ??= old;
				return {
					id: old.id,
					placement: { kind: "placed", anchor, changed: false },
					moved: {
						id: "",
						on: to,
						at: new Date().toISOString(),
						here: true,
						path: anchor.path,
					},
				};
			});
			setFailure(key, null);
			setBusyKey(key, true);
			postMove({ thread, to, anchor })
				.then((answer) => {
					if (prior) before.current.set(answer.move, prior);
					setEntry(client, keys, thread.id, (old) => ({
						id: old.id,
						placement: answer.placement,
						moved: answer.moved,
					}));
					land(thread.id);
				})
				.catch((error) => {
					restore(client, saved);
					setFailure(key, {
						message: messageOf(error, false),
						...(refused(error) ? {} : { retry: () => move(thread, anchor) }),
					});
				})
				.finally(() => {
					setBusyKey(key, false);
					settle();
				});
		},
		[client, readId, to, setFailure, setBusyKey, settle],
	);
	const undo = useCallback(
		(thread: ThreadRef, id: string) => {
			if (!to) return;
			const key = threadKey(thread);
			const keys = queriesOf(client, thread, readId, to);
			const was = before.current.get(id);
			// Known (this page made the move): back at once; else it waits
			// for the answer with its place as it is.
			const saved = was
				? setEntry(client, keys, thread.id, () => was)
				: ([] as Saved);
			setFailure(key, null);
			setBusyKey(key, true);
			deleteMove(id, to)
				.then((answer) => {
					before.current.delete(id);
					const { placement, moved } = answer;
					if (placement) {
						setEntry(client, keys, thread.id, (old) => ({
							id: old.id,
							placement,
							...(moved ? { moved } : {}),
						}));
					}
				})
				.catch((error) => {
					restore(client, saved);
					setFailure(key, {
						message: messageOf(error, true),
						...(refused(error) ? {} : { retry: () => undo(thread, id) }),
					});
				})
				.finally(() => {
					setBusyKey(key, false);
					settle();
				});
		},
		[client, readId, to, setFailure, setBusyKey, settle],
	);
	return useMemo(
		() => ({
			to,
			move,
			undo,
			failure: (t) => failures.get(threadKey(t)),
			dismiss: (t) => setFailure(threadKey(t), null),
			busy: (t) => busy.has(threadKey(t)),
		}),
		[to, move, undo, failures, busy, setFailure],
	);
}

/**
 * After a place: the card scrolls into view on its new line (threadFocus),
 * lit for a moment, and keyboard focus goes to its Undo once it is there.
 */
function land(id: string): void {
	threadFocus.request({ id });
	let frames = 0;
	const sel = `[data-thread="${CSS.escape(id)}"]`;
	const step = () => {
		const undo = document.querySelector<HTMLButtonElement>(
			`${sel} [data-testid="move-undo"]`,
		);
		if (undo) {
			undo.focus({ preventScroll: true });
			const card = undo.closest<HTMLElement>("[data-thread]");
			if (card) {
				card.removeAttribute("data-move-landed");
				// Restart the fade.
				void card.offsetWidth;
				card.setAttribute("data-move-landed", "");
				setTimeout(() => card.removeAttribute("data-move-landed"), 1600);
			}
			return;
		}
		if (++frames < 120) requestAnimationFrame(step);
	};
	requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// What a card shows.

/** The thread's move, from the placements that hold it. */
export function useMoved(thread: ThreadRef): MovedInfo | undefined {
	const info = usePlacementInfo();
	const agent = useAgentPlacing();
	return thread.source === "github"
		? info.moves?.get(thread.id)
		: agent.moves?.get(thread.id);
}

/**
 * Whether a card gets the handle: Files changed on a target that takes
 * writes, the placements in (principle 8: no handle while they load), a
 * thread on lines, and traced (one opened on the viewed snapshot sits
 * where it was made: no guess to correct), or moved already.
 */
export function useMovable(args: {
	thread: ThreadRef;
	/** The commit it was opened on. */
	commit: string;
	/** On lines (not a file thread, a conversation or the review's). */
	lines: boolean;
}): boolean {
	const info = usePlacementInfo();
	const agent = useAgentPlacing();
	const writes = useMoveWrites();
	const moved = useMoved(args.thread);
	if (!writes || writes.to === null || info.moveTo === null || !args.lines) {
		return false;
	}
	const placements =
		args.thread.source === "github" ? info.placements : agent.placements;
	if (!placements?.has(args.thread.id)) return false;
	return moved !== undefined || args.commit !== info.viewedHead;
}

/** A diff row's numbers, as DiffBody puts them on it (`data-*-no`). */
export interface RowNumbers {
	oldNo?: number;
	newNo?: number;
	/** The since view's removed line: its line in the full diff's old side. */
	baseNo?: number;
}

/**
 * The line of the target's full diff a row's `side` stands for: where a
 * move dropped or placed on it goes (CAR-139). A move's anchor is always
 * the full diff's (RIGHT the target's line, LEFT the base's), whatever the
 * view. A new line is the target's in any view. An old one is itself in
 * the full diff; in the since view (`interdiff`) its number is the
 * compared patch set's, so it stands for its base line (`baseNo`), and
 * for none when it has none (a line the branch added before that patch
 * set, gone since): no drop target. Never an interdiff number as a base one.
 */
export function moveEnd(
	row: RowNumbers,
	side: "LEFT" | "RIGHT",
	interdiff: boolean,
): { side: "LEFT" | "RIGHT"; line: number } | null {
	const valid = (n: number | undefined): n is number =>
		n !== undefined && Number.isInteger(n) && n > 0;
	if (side === "RIGHT") {
		return valid(row.newNo) ? { side, line: row.newNo } : null;
	}
	const line = interdiff ? row.baseNo : row.oldNo;
	return valid(line) ? { side, line } : null;
}

/** A row element's numbers (its data attributes; absent or empty: none). */
function numbersOf(row: HTMLElement): RowNumbers {
	const n = (v: string | undefined) =>
		v === undefined || v === "" ? undefined : Number(v);
	return {
		oldNo: n(row.dataset.oldNo),
		newNo: n(row.dataset.newNo),
		baseNo: n(row.dataset.baseNo),
	};
}

/** The row shows the since view's interdiff (DiffBody's table says so). */
const inInterdiff = (row: Element) =>
	row.closest("table")?.hasAttribute("data-interdiff") ?? false;

/** The row a point is over, in this file's diff, as a one-line anchor. */
export function lineAt(
	x: number,
	y: number,
	path: string,
): { row: HTMLElement; anchor: ThreadAnchorRef } | null {
	const row = document
		.elementFromPoint(x, y)
		?.closest<HTMLElement>('tr[data-testid="diff-line"]');
	if (!row) return null;
	const file = row.closest<HTMLElement>("[data-path]");
	if (file?.dataset.path !== path) return null;
	const numbers = numbersOf(row);
	// A row with a new line is that line; else its old one.
	const end = moveEnd(
		numbers,
		numbers.newNo !== undefined && numbers.newNo > 0 ? "RIGHT" : "LEFT",
		inInterdiff(row),
	);
	if (!end) return null;
	return {
		row,
		anchor: {
			path,
			startSide: end.side,
			startLine: end.line,
			side: end.side,
			line: end.line,
		},
	};
}

/**
 * Move mode's picked lines (a span of the view's numbers) as the anchor a
 * move stores (moveEnd): the full diff's as they are; the since view's
 * old lines through their base line. Null when either end stands for no
 * line of the full diff (the span isn't a place, Place here is off).
 */
export function moveAnchorOf(span: {
	path: string;
	startSide: "LEFT" | "RIGHT";
	startLine: number;
	side: "LEFT" | "RIGHT";
	line: number;
}): ThreadAnchorRef | null {
	const file = document.querySelector(`[data-path="${CSS.escape(span.path)}"]`);
	const endOf = (side: "LEFT" | "RIGHT", line: number) => {
		const row = file?.querySelector<HTMLElement>(
			`tr[data-testid="diff-line"][data-${side === "LEFT" ? "old" : "new"}-no="${line}"]`,
		);
		// Not on screen: as picked in the full diff (its numbers are the
		// anchor's); never in the since view (they are the interdiff's).
		if (!row) {
			return file?.querySelector("table[data-interdiff]")
				? null
				: { side, line };
		}
		return moveEnd(numbersOf(row), side, inInterdiff(row));
	};
	const start = endOf(span.startSide, span.startLine);
	const end = endOf(span.side, span.line);
	if (!start || !end) return null;
	return {
		path: span.path,
		startSide: start.side,
		// One side: never a start after its end.
		startLine:
			start.side === end.side ? Math.min(start.line, end.line) : start.line,
		side: end.side,
		line: end.line,
	};
}

/** How far a press may travel before it is a drag (px). */
const DRAG_SLOP = 6;
/** How near the viewport's top or bottom edge a drag scrolls (px). */
const EDGE = 56;

/**
 * The handle on a movable thread's card: Grabber, 40×40. Dragged (pointer
 * capture), a ghost with the thread's first words follows the pointer and
 * the line under it is outlined; let go on a line of the thread's file,
 * the thread goes there (one line). Pressed (click, tap, Enter, Space):
 * move mode. Escape cancels a drag.
 */
export function MoveHandle(props: {
	thread: ThreadRef;
	/** The thread's first words: the ghost's and move mode's text. */
	words: string;
	/** Its file, when the card sits in no file's section: a drag's drop targets. */
	path: string;
	/** The author's avatar, or the sparkle for an agent thread. */
	avatar?: ReactNode;
}) {
	const writes = useMoveWrites();
	const current = useMoveMode();
	const mine =
		current !== null && threadKey(current.thread) === threadKey(props.thread);
	const button = useRef<HTMLButtonElement>(null);
	const start = useRef<{ x: number; y: number } | null>(null);
	const dragged = useRef(false);
	const over = useRef<HTMLElement | null>(null);
	const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
	const card = () => button.current?.closest<HTMLElement>("[data-thread]");
	// The file the card is shown in now (a thread moved to another file
	// sits in that one), else the one given.
	const dropPath = () =>
		button.current?.closest<HTMLElement>("[data-path]")?.dataset.path ??
		props.path;
	// The card being moved: outlined while move mode is on for it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `card` reads the DOM; on `mine` only.
	useEffect(() => {
		const el = card();
		if (!el) return;
		if (mine) el.setAttribute("data-move-source", "");
		else el.removeAttribute("data-move-source");
		return () => el.removeAttribute("data-move-source");
	}, [mine]);
	const mark = (row: HTMLElement | null) => {
		if (over.current === row) return;
		over.current?.removeAttribute("data-drop-line");
		over.current = row;
		row?.setAttribute("data-drop-line", "true");
	};
	const stop = () => {
		start.current = null;
		mark(null);
		setGhost(null);
		card()?.removeAttribute("data-move-dragging");
	};
	// Escape cancels a drag under way.
	const dragging = ghost !== null;
	useEffect(() => {
		if (!dragging) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			dragged.current = true;
			stop();
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	});
	const onMove = (e: ReactPointerEvent) => {
		const s = start.current;
		if (!s) return;
		if (!dragging && Math.hypot(e.clientX - s.x, e.clientY - s.y) < DRAG_SLOP)
			return;
		if (!dragging) card()?.setAttribute("data-move-dragging", "");
		setGhost({ x: e.clientX, y: e.clientY });
		mark(lineAt(e.clientX, e.clientY, dropPath())?.row ?? null);
		// Near the top or bottom edge, the page scrolls on.
		if (e.clientY < EDGE) window.scrollBy(0, -16);
		else if (e.clientY > window.innerHeight - EDGE) window.scrollBy(0, 16);
	};
	const onUp = (e: ReactPointerEvent) => {
		if (!start.current) return;
		const wasDrag = dragging;
		const hit = wasDrag ? lineAt(e.clientX, e.clientY, dropPath()) : null;
		stop();
		if (!wasDrag) return;
		dragged.current = true;
		if (hit && writes) writes.move(props.thread, hit.anchor);
	};
	return (
		<>
			<Tooltip content="Drag to a line, or press to pick one" describe>
				{(trigger) => (
					<button
						{...trigger}
						ref={(el) => {
							button.current = el;
							trigger.ref(el);
						}}
						type="button"
						aria-label="Move thread"
						aria-pressed={mine}
						data-testid="move-handle"
						onPointerDown={(e) => {
							if (e.button !== 0) return;
							start.current = { x: e.clientX, y: e.clientY };
							dragged.current = false;
							e.currentTarget.setPointerCapture?.(e.pointerId);
						}}
						onPointerMove={onMove}
						onPointerUp={onUp}
						onPointerCancel={stop}
						onClick={() => {
							// A drag's release is no press.
							if (dragged.current) {
								dragged.current = false;
								return;
							}
							if (mine) endMoveMode();
							else startMoveMode({ thread: props.thread, words: props.words });
						}}
						className={`flex h-10 w-10 shrink-0 touch-none items-center justify-center rounded text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent aria-pressed:text-accent ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
					>
						<GrabberIcon size={16} aria-hidden />
					</button>
				)}
			</Tooltip>
			{ghost &&
				createPortal(
					<div
						data-testid="move-ghost"
						aria-hidden
						style={{ left: ghost.x + 12, top: ghost.y + 8 }}
						className="pointer-events-none fixed z-50 flex max-w-64 items-center gap-1.5 rounded-md border border-edge bg-overlay px-2 py-1 text-xs text-ink shadow-float"
					>
						{props.avatar}
						<span className="truncate">{props.words}</span>
					</div>,
					document.body,
				)}
		</>
	);
}

/** The sparkle an agent thread's ghost carries. */
export const AgentAvatar = () => (
	<SparkleFillIcon size={14} aria-hidden className="shrink-0 text-agent-ink" />
);

/** "PS3", or the head's short id. */
const onLabel = (on: MovedInfo["on"]) =>
	"patchset" in on ? `PS${on.patchset}` : on.head.slice(0, 7);

/** The `moved` chip's tooltip. */
export function movedTip(
	moved: MovedInfo,
	github?: { line: number | null; outdated: boolean },
): string {
	const where = onLabel(moved.on);
	const base = moved.here
		? `Moved here by you on ${where}`
		: `Moved by you on ${where}, followed here`;
	if (!github) return base;
	if (github.outdated || github.line === null)
		return `${base} · GitHub: outdated`;
	return `${base} · GitHub: line ${github.line}`;
}

/**
 * A moved thread's gray `moved` chip (pin; a fact, not a state), and
 * beside it a 40px Undo where writes go (Files changed). Nothing for a
 * thread not moved.
 */
export function MovedChip(props: {
	thread: ThreadRef;
	/** A GitHub thread's own place, for the tooltip. */
	github?: { line: number | null; outdated: boolean };
}) {
	const moved = useMoved(props.thread);
	const writes = useMoveWrites();
	if (!moved) return null;
	const canUndo = writes !== null && writes.to !== null && moved.id !== "";
	const busy = writes?.busy(props.thread) ?? false;
	return (
		<span className="inline-flex items-center gap-0.5" data-testid="moved">
			<Chip
				tone="gray"
				icon={PinIcon}
				tip={movedTip(moved, props.github)}
				testId="moved-chip"
			>
				moved
			</Chip>
			{canUndo && (
				<Tooltip content="Undo move" describe={false}>
					{(trigger) => (
						<button
							{...trigger}
							type="button"
							aria-label="Undo move"
							aria-busy={busy || undefined}
							disabled={busy}
							data-testid="move-undo"
							onClick={() => writes?.undo(props.thread, moved.id)}
							className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
						>
							<UndoIcon size={16} aria-hidden />
						</button>
					)}
				</Tooltip>
			)}
		</span>
	);
}

/** A move or undo refused or failed: under the card, in `bad`, with Retry where it helps. */
export function MoveFailureLine({ thread }: { thread: ThreadRef }) {
	const writes = useMoveWrites();
	const failure = writes?.failure(thread);
	if (!failure) return null;
	return (
		<p
			role="alert"
			data-testid="move-failure"
			className="flex min-h-10 flex-wrap items-center gap-2 text-xs text-bad"
		>
			<AlertIcon size={14} aria-hidden />
			<span className="min-w-0 break-words">{failure.message}</span>
			{failure.retry && (
				<button
					type="button"
					onClick={failure.retry}
					className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md px-2 font-medium text-link hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
				>
					Retry
				</button>
			)}
		</p>
	);
}

/**
 * Move mode's bar, pinned at the top of the page (App's MoveSlot, under
 * the find bar's; it pushes the page down): the pin, "Pick a line", the
 * thread's first words, and a 40px Cancel. Escape cancels too.
 */
export function MoveBar() {
	const current = useMoveMode();
	const slot = useContext(MoveSlot);
	useEffect(() => {
		if (!current) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") endMoveMode();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [current]);
	// Leaving the page leaves move mode, with nothing written.
	useEffect(() => () => endMoveMode(), []);
	if (!current) return null;
	const bar = (
		<section
			aria-label="Move thread"
			data-testid="move-bar"
			className="border-b border-line bg-surface shadow-header"
		>
			<div className="mx-auto flex min-h-12 max-w-screen-2xl min-w-0 items-center gap-2 px-3 sm:px-6">
				<PinIcon size={16} aria-hidden className="shrink-0 text-accent" />
				<span className="shrink-0 text-sm font-semibold text-ink">
					Pick a line
				</span>
				<span
					data-testid="move-bar-words"
					className="min-w-0 flex-1 truncate text-sm text-muted"
				>
					{current.words}
				</span>
				<Tooltip content="Cancel" describe={false}>
					{(trigger) => (
						<button
							{...trigger}
							type="button"
							aria-label="Cancel move"
							data-testid="move-cancel"
							onClick={endMoveMode}
							className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
						>
							<XIcon size={16} aria-hidden />
						</button>
					)}
				</Tooltip>
			</div>
		</section>
	);
	return slot ? createPortal(bar, slot) : bar;
}

/** A thread's first words, for the ghost and the bar: plain text, one line. */
export function firstWords(text: string, max = 80): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * An agent thread's move controls, as a review thread's: the handle (when
 * movable), the `moved` chip with Undo, and a refused move's line.
 */
export function useAgentMove(
	thread: SpanAgentThread,
	/** The file it is shown in (a drag's drop targets). */
	path: string,
): { handle: ReactNode; moved: ReactNode; failure: ReactNode } {
	const ref: ThreadRef = { source: "agent", id: thread.id };
	const movable = useMovable({
		thread: ref,
		commit: thread.anchor.commit,
		lines: thread.anchor.subject === "line",
	});
	const words = firstWords(
		thread.messages.find((m) => m.by === "human")?.text ??
			thread.messages[0]?.text ??
			"",
	);
	return {
		handle: movable ? (
			<MoveHandle
				thread={ref}
				words={words}
				path={path}
				avatar={<AgentAvatar />}
			/>
		) : null,
		moved: <MovedChip thread={ref} />,
		failure: <MoveFailureLine thread={ref} />,
	};
}
