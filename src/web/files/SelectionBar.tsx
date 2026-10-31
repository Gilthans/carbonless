import { useQuery } from "@tanstack/react-query";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type { FileView } from "../../shared/types";
import { overviewQuery, sessionQuery } from "../api";
import { useShortcut } from "../shortcuts";
import { Tooltip } from "../Tooltip";
import { NOT_PHONE, useMedia } from "../useMedia";
import {
	backwards,
	CODE_CELL,
	inHunk,
	spanOfCells,
	spanOfRange,
} from "./codeSpan";
import { getPicks, type Picks, setPicks, usePicks } from "./linePicks";
import {
	type CodeSpan,
	type SelectionAction,
	type SelectionContext,
	selectionActions,
	subscribeSelectionActions,
} from "./selectionActions";

/** What the bar acts on: a span, where it ends on screen, and its text. */
export interface BarTarget {
	span: CodeSpan;
	/** Both ends are lines of GitHub's diff. */
	inDiff: boolean;
	/** Its start comes after its end in GitHub's order. */
	backwards: boolean;
	/** Viewport rects: the selection's first and last line, and all of it. */
	first: DOMRect;
	last: DOMRect;
	box: DOMRect;
	/**
	 * The viewport x the bar goes by: centered on it (where a selection was
	 * let go), or starting at it (`after`: just right of picked numbers, so
	 * it never covers the numbers a pick extends to).
	 */
	anchor: number;
	after?: boolean;
	/** Text selected (vs lines picked). */
	text: boolean;
}

const GAP = 6;
const MARGIN = 8;
/**
 * Below text selected on a touch screen: room for the selection's end
 * handle, which hangs under the last line, so it stays grabbable.
 */
export const HANDLE_GAP = 28;

/**
 * The part of the layout viewport the bar may use, in its (and
 * getBoundingClientRect's) coordinates: what the visual viewport shows
 * (pinch zoom pans and shrinks it), inside the safe-area insets.
 */
export interface BarView {
	left?: number;
	top?: number;
	w: number;
	h: number;
}

/** A span as one string, to tell spans apart. */
const keyOf = (span: CodeSpan) => JSON.stringify(span);

/**
 * Where the floating bar goes, never over the selection when it can help
 * it: `below` its visible end (GAP, or HANDLE_GAP under text on a touch
 * screen), else above its start, else beside it (right, then left), else
 * the view's bottom right corner. Below or above, it goes by the target's
 * `anchor`. It always stays inside `view`.
 */
export function placeBar(
	target: Pick<BarTarget, "first" | "last" | "box" | "anchor" | "after">,
	size: { w: number; h: number },
	view: BarView,
	below = GAP,
): { top: number; left: number } {
	const { w, h } = size;
	const x0 = view.left ?? 0;
	const y0 = view.top ?? 0;
	const x1 = x0 + view.w;
	const y1 = y0 + view.h;
	const clampX = (x: number) =>
		Math.round(Math.min(Math.max(x0 + MARGIN, x), x1 - w - MARGIN));
	// The visible end: the last line, or the view's bottom when it's below.
	const end = Math.min(target.last.bottom, y1);
	const left = clampX(target.after ? target.anchor : target.anchor - w / 2);
	if (target.last.bottom <= y1 && end + below + h <= y1 - MARGIN) {
		return { top: Math.round(end + below), left };
	}
	if (target.first.top >= y0 && target.first.top - GAP - h >= y0 + MARGIN) {
		return { top: Math.round(target.first.top - GAP - h), left };
	}
	const top = Math.round(
		Math.min(Math.max(y0 + MARGIN, end - h), y1 - h - MARGIN),
	);
	if (target.box.right + GAP + w <= x1 - MARGIN) {
		return { top, left: Math.round(target.box.right + GAP) };
	}
	if (target.box.left - GAP - w >= x0 + MARGIN) {
		return { top, left: Math.round(target.box.left - GAP - w) };
	}
	return {
		top: Math.round(y1 - h - MARGIN),
		left: Math.round(x1 - w - MARGIN),
	};
}

/**
 * What the screen shows of the page now (BarView): the visual viewport.
 * (The safe-area insets are 0 without `viewport-fit=cover`, which
 * index.html doesn't set: the browser keeps the page out of them.)
 */
export function currentView(): BarView {
	const vv = window.visualViewport;
	return {
		left: vv?.offsetLeft ?? 0,
		top: vv?.offsetTop ?? 0,
		w: vv?.width ?? document.documentElement.clientWidth,
		h: vv?.height ?? window.innerHeight,
	};
}

/**
 * Touch decides the handle's room and the scroll-once, not the screen's
 * width (a phone in landscape, a tablet): the last press's pointer type,
 * else whether the main pointer is coarse.
 */
let lastPointer: string | null = null;
/** A finger is on the screen (a selection may still be in the making). */
let fingerDown = false;
const lifted = new Set<() => void>();
if (typeof document !== "undefined") {
	document.addEventListener(
		"pointerdown",
		(e) => {
			lastPointer = e.pointerType || lastPointer;
		},
		true,
	);
	document.addEventListener(
		"touchstart",
		() => {
			fingerDown = true;
		},
		{ capture: true, passive: true },
	);
	const lift = (e: TouchEvent) => {
		if (e.touches.length > 0) return;
		fingerDown = false;
		for (const f of lifted) f();
	};
	document.addEventListener("touchend", lift, true);
	document.addEventListener("touchcancel", lift, true);
}

/** Whether the selection was made by touch (or a pen). */
export function byTouch(): boolean {
	if (lastPointer) return lastPointer !== "mouse";
	return (
		typeof window.matchMedia === "function" &&
		window.matchMedia("(pointer: coarse)").matches
	);
}

/** For tests: forget the last press and any finger. */
export function resetPointer() {
	lastPointer = null;
	fingerDown = false;
}

/**
 * Where a text selection shows: the selected text on its first and last
 * line, from the range's rects within each line's code (`code`: its
 * `[data-code]` box). A range across whole rows also reports the rows' and
 * cells' own boxes, the full table wide, and a row's bubble sits at the
 * cell's far end: neither is the text. A line with no text selected in it
 * stands at its code's start. The bar centers where the drag ended: the
 * selection's end, or its start when it was made backwards.
 */
export function textGeometry(
	rects: readonly DOMRect[],
	code: { head: DOMRect; last: DOMRect },
	reversed: boolean,
): { first: DOMRect; last: DOMRect; anchor: number } {
	const lineOf = (c: DOMRect) => {
		const on = rects.filter(
			(r) =>
				r.left >= c.left - 1 &&
				r.right <= c.right + 1 &&
				r.top >= c.top - 1 &&
				r.bottom <= c.bottom + 1 &&
				(r.width > 0 || r.height > 0),
		);
		if (on.length === 0) return new DOMRect(c.left, c.top, 0, c.height);
		const left = Math.min(...on.map((r) => r.left));
		const right = Math.max(...on.map((r) => r.right));
		return new DOMRect(left, c.top, right - left, c.height);
	};
	const first = lineOf(code.head);
	const last = lineOf(code.last);
	return { first, last, anchor: reversed ? first.left : last.right };
}

/** A rect's box, or none where the engine has no geometry (test DOMs). */
const rectOf = (el: Element | null | undefined) =>
	el && typeof el.getBoundingClientRect === "function"
		? el.getBoundingClientRect()
		: new DOMRect();

const ofSelection = (commit: string): BarTarget | null => {
	const selection = document.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
		return null;
	}
	const range = selection.getRangeAt(0);
	const found = spanOfRange(range, commit);
	if (!found) return null;
	// (Engines without range geometry, such as test DOMs: no rects.)
	const rects =
		typeof range.getClientRects === "function"
			? [...range.getClientRects()]
			: [];
	const box =
		typeof range.getBoundingClientRect === "function"
			? range.getBoundingClientRect()
			: new DOMRect();
	// Made backwards: the drag ended at the start (the focus before the anchor).
	let reversed = false;
	if (selection.anchorNode && selection.focusNode) {
		const at = document.createRange();
		at.setStart(selection.anchorNode, selection.anchorOffset);
		try {
			reversed =
				at.comparePoint(selection.focusNode, selection.focusOffset) < 0;
		} catch {
			reversed = false;
		}
	}
	const codeOf = (cell: Element) =>
		rectOf(cell.querySelector("[data-code]") ?? cell);
	return {
		...found,
		...textGeometry(
			rects,
			{ head: codeOf(found.cells.head), last: codeOf(found.cells.last) },
			reversed,
		),
		box,
		text: true,
	};
};

/**
 * Where the bar starts for picked lines: just right of the row's last
 * number cell (the new numbers), whichever side's number was picked, so it
 * never covers the numbers a pick extends to.
 */
export function pickAnchor(row: Element): number {
	const numbers = row.querySelectorAll(
		'td[data-testid="old"], td[data-testid="new"]',
	);
	return rectOf(numbers[numbers.length - 1] ?? row).right + GAP;
}

const ofPicks = (picks: Picks, commit: string): BarTarget | null => {
	const head = picks.lines[0];
	const tail = picks.lines[picks.lines.length - 1];
	if (!head || !tail) return null;
	const rowOf = (line: number, side: string) =>
		document
			.querySelector(
				`[data-path="${CSS.escape(picks.path)}"] tr[data-${side === "LEFT" ? "old" : "new"}-no="${line}"] > [${CODE_CELL}][data-side="${side}"]`,
			)
			?.closest("tr") ?? null;
	const firstRow = rowOf(head.line, head.side);
	const lastRow = rowOf(tail.line, tail.side);
	if (!firstRow || !lastRow) return null;
	const span = spanOfCells(
		{ ...head, cell: firstRow },
		{ ...tail, cell: lastRow },
		commit,
	);
	const first = firstRow.getBoundingClientRect();
	const last = lastRow.getBoundingClientRect();

	return {
		span,
		inDiff: inHunk(head) && inHunk(tail),
		backwards: backwards(head, tail),
		first,
		last,
		box: new DOMRect(
			Math.min(first.left, last.left),
			first.top,
			Math.max(first.right, last.right) - Math.min(first.left, last.left),
			last.bottom - first.top,
		),
		anchor: pickAnchor(lastRow),
		after: true,
		text: false,
	};
};

/**
 * The actions for what is selected in Files changed: text in the code, or
 * lines picked by their numbers. One icon button per registered action
 * (selectionActions.ts), disabled with its reason as the tooltip when it
 * can't run there. The bar floats just below the selection's end (above
 * it when there's no room), never over it; on a phone a little lower,
 * clear of the selection's end handle, inside what the screen shows of
 * the page (pinch zoom, the safe area). It never takes the
 * selection (a mouse press on it doesn't clear it: copying still works),
 * and the span is read when the selection settles, so an action gets it
 * even if a tap clears the selection first. Escape dismisses it and clears
 * picked lines; an action clears both.
 */
export function SelectionBar(props: { files: readonly FileView[] }) {
	const commit =
		useQuery({ ...sessionQuery, enabled: false }).data?.snapshotHead ?? "";
	const overview = useQuery({ ...overviewQuery, enabled: false }).data;
	const picks = usePicks();
	const wide = useMedia(NOT_PHONE);
	const actions = useSyncExternalStore(
		subscribeSelectionActions,
		selectionActions,
		selectionActions,
	);
	const [text, setText] = useState<BarTarget | null>(null);
	/** Escape put the bar away for this span (until the span changes). */
	const [dismissed, setDismissed] = useState<string | null>(null);
	/** A press on the bar: the selection it may clear is still the bar's. */
	const pressing = useRef(false);
	const bar = useRef<HTMLDivElement>(null);
	const read = useCallback(() => {
		if (!commit) return;
		const next = ofSelection(commit);
		// A tap on the bar may clear the selection before its click: the
		// bar keeps the span it shows until then.
		if (!next && pressing.current) return;
		// Text selected: it, not picked lines, is what the bar acts on.
		if (next && getPicks()) setPicks(null);
		setText(next);
	}, [commit]);
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		// While a selection is being made it changes on every move: read it
		// once it settles, and at once when the pointer or key lets go.
		const later = () => {
			clearTimeout(timer);
			timer = setTimeout(read, 200);
		};
		const now = () => {
			clearTimeout(timer);
			timer = setTimeout(read, 0);
		};
		document.addEventListener("selectionchange", later);
		document.addEventListener("pointerup", now);
		document.addEventListener("keyup", now);
		lifted.add(now);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("selectionchange", later);
			document.removeEventListener("pointerup", now);
			document.removeEventListener("keyup", now);
			lifted.delete(now);
		};
	}, [read]);
	const target = text ?? (picks && commit ? ofPicks(picks, commit) : null);
	const targetKey = target ? keyOf(target.span) : null;
	const hidden = !target || dismissed === targetKey;
	// Escape's dismissal lasts while its span does: gone or changed, a span
	// picked or selected again (even the same one) brings the bar back.
	useEffect(() => {
		if (dismissed !== null && dismissed !== targetKey) setDismissed(null);
	}, [dismissed, targetKey]);
	// Rects move with the page: read again on scroll and resize, once a frame.
	const [, setTick] = useState(0);
	const reading = text !== null;
	useEffect(() => {
		if (hidden) return;
		let frame = 0;
		const move = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				if (reading) setText(ofSelection(commit));
				else setTick((n) => n + 1);
			});
		};
		window.addEventListener("scroll", move, { passive: true, capture: true });
		window.addEventListener("resize", move);
		// Pinch zoom pans and resizes what the screen shows, page unmoved.
		const vv = window.visualViewport;
		vv?.addEventListener("scroll", move);
		vv?.addEventListener("resize", move);
		// Lines moving under it without a scroll (a thread or composer
		// opening, context loading, highlighting arriving): the page's
		// files section changes size.
		const section = bar.current?.closest("section");
		const observer =
			section && typeof ResizeObserver !== "undefined"
				? new ResizeObserver(move)
				: null;
		if (section) observer?.observe(section);
		return () => {
			observer?.disconnect();
			cancelAnimationFrame(frame);
			window.removeEventListener("scroll", move, { capture: true });
			window.removeEventListener("resize", move);
			vv?.removeEventListener("scroll", move);
			vv?.removeEventListener("resize", move);
		};
	}, [hidden, reading, commit]);
	const clear = useCallback(() => {
		setPicks(null);
		setText(null);
		document.getSelection()?.removeAllRanges();
	}, []);
	const shownKey = hidden || !target ? null : keyOf(target.span);
	const isText = target?.text ?? false;
	useEffect(() => {
		if (!shownKey) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			// Away until the span changes (the selection itself stays).
			setDismissed(shownKey);
			if (!isText) setPicks(null);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [shownKey, isText]);
	// The first Tab after a selection goes to the bar (it is last in the
	// page's order), without touching the selection.
	const tabbed = useRef<string | null>(null);
	const shownPath = target?.span.path;
	useEffect(() => {
		if (!shownKey || !shownPath) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Tab" || e.shiftKey || e.defaultPrevented) return;
			const el = bar.current;
			if (!el || el.contains(document.activeElement)) return;
			if (tabbed.current === shownKey) return;
			// Only from the page itself or the diff: never from a form
			// control, a dialog or popover, or anything else with its own
			// next stop.
			const active = document.activeElement;
			const fromPage = !active || active === document.body;
			const fromDiff =
				active instanceof HTMLElement &&
				active.closest(`[data-path="${CSS.escape(shownPath)}"]`) !== null &&
				!active.matches("input, select, textarea, [contenteditable]") &&
				active.closest("dialog, [role=dialog], [popover]") === null;
			if (!fromPage && !fromDiff) return;
			tabbed.current = shownKey;
			e.preventDefault();
			el.querySelector<HTMLButtonElement>("button")?.focus({
				preventScroll: true,
			});
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [shownKey, shownPath]);
	const [place, setPlace] = useState<{ top: number; left: number } | null>(
		null,
	);
	// By touch, room under text for its end handle.
	const touch = byTouch();
	const below = touch && target?.text ? HANDLE_GAP : GAP;
	// A phone's own Copy menu sits above a selection: when the bar first
	// comes for a selection by touch with no room under it, the page moves
	// up once to make it (the list's end padded by --selection-room so it
	// can), once the finger is off the screen: never under a finger, and
	// not again as the handles are dragged. Per kind: picks giving way to
	// a text selection get theirs.
	const scrolled = useRef<"text" | "picks" | null>(null);
	useLayoutEffect(() => {
		const el = bar.current;
		const root = document.documentElement;
		if (!target) scrolled.current = null;
		if (hidden || !target || !el) {
			root.style.removeProperty("--selection-room");
			setPlace(null);
			return;
		}
		const size = { w: el.offsetWidth, h: el.offsetHeight };
		const room = below + size.h + MARGIN;
		if (touch) root.style.setProperty("--selection-room", `${room}px`);
		else root.style.removeProperty("--selection-room");
		const view = currentView();
		let at = target;
		const kind = target.text ? "text" : "picks";
		if (touch && !fingerDown && scrolled.current !== kind) {
			scrolled.current = kind;
			const top = view.top ?? 0;
			const short = target.last.bottom + room - (top + view.h);
			// Only while the selection's start stays on screen.
			if (short > 0 && target.first.top - short >= top) {
				const y = window.scrollY;
				window.scrollBy({ top: short, behavior: "instant" });
				// Where it is now (a scroll event reads it again a frame later).
				const moved = window.scrollY - y;
				const up = (r: DOMRect) =>
					new DOMRect(r.x, r.y - moved, r.width, r.height);
				at = {
					...target,
					first: up(target.first),
					last: up(target.last),
					box: up(target.box),
				};
			}
		}
		const next = placeBar(at, size, view, below);
		setPlace((p) => (p?.top === next.top && p.left === next.left ? p : next));
	});
	useEffect(
		() => () => {
			document.documentElement.style.removeProperty("--selection-room");
		},
		[],
	);
	const file = target
		? props.files.find((f) => f.path === target.span.path)
		: undefined;
	const ctx: SelectionContext | null =
		target && overview
			? {
					writes: overview.writes,
					commentLeft: overview.commentLeft !== false,
					file: {
						binary: file?.binary ?? false,
						submodule: file?.submodule ?? false,
					},
					inDiff: target.inDiff,
					backwards: target.backwards,
				}
			: null;
	const run = (action: SelectionAction) => {
		if (!target) return;
		action.start(target.span);
		clear();
	};
	// `c` starts a comment on what is selected (desktop only: a phone has
	// no keyboard shortcuts). Ctrl/Cmd+C stays the browser's copy.
	const shown = target && ctx && !hidden ? { target, ctx } : null;
	const now = useRef(shown);
	now.current = shown;
	useShortcut({
		keys: "c",
		label: "Comment on selection",
		group: "Files changed",
		when: () => {
			const cur = now.current;
			const comment = selectionActions().find((a) => a.shortcut === "c");
			return (
				wide &&
				cur !== null &&
				comment !== undefined &&
				comment.available(cur.target.span, cur.ctx) === true
			);
		},
		run: (e) => {
			const comment = selectionActions().find((a) => a.shortcut === "c");
			if (!comment || !now.current) return;
			e.preventDefault();
			run(comment);
		},
	});
	if (!target || hidden || !ctx) return null;
	return (
		<div
			ref={bar}
			role="toolbar"
			aria-label="Selection actions"
			data-testid="selection-bar"
			onPointerDown={() => {
				pressing.current = true;
				setTimeout(() => {
					pressing.current = false;
				}, 600);
			}}
			// A mouse press on the bar keeps the selection (and so copying).
			onMouseDown={(e) => e.preventDefault()}
			style={(place ?? { top: -9999, left: -9999 }) satisfies CSSProperties}
			className="fixed z-40 flex gap-0.5 rounded-lg border border-edge bg-overlay p-0.5 shadow-float"
		>
			{actions.map((action) => {
				const ok = action.available(target.span, ctx);
				const IconEl = action.icon;
				// The key shows on a desktop only: a phone has no shortcuts.
				const tip =
					ok !== true
						? ok
						: wide && action.shortcut
							? `${action.label} (${action.shortcut})`
							: action.label;
				return (
					<Tooltip key={action.id} content={tip} describe={ok !== true}>
						{({ ref, onMouseEnter, onMouseLeave, ...rest }) => (
							// biome-ignore lint/a11y/noStaticElementInteractions: hover only; the button inside is the control.
							<span
								ref={ref}
								onMouseEnter={onMouseEnter}
								onMouseLeave={onMouseLeave}
								className="flex shrink-0"
							>
								{/* Disabled but focusable: a tap or Tab shows why. */}
								<button
									type="button"
									{...rest}
									data-action={action.id}
									aria-label={action.label}
									aria-disabled={ok !== true || undefined}
									onClick={() => {
										if (ok === true) run(action);
									}}
									className="flex h-10 w-10 items-center justify-center rounded-md text-ink hover:bg-pressed focus-visible:outline-2 focus-visible:outline-accent aria-disabled:cursor-not-allowed aria-disabled:text-faint aria-disabled:hover:bg-transparent"
								>
									<IconEl size={18} aria-hidden />
								</button>
							</span>
						)}
					</Tooltip>
				);
			})}
		</div>
	);
}
