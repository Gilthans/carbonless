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
	describeSpan,
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
	/** A short quote of what is selected (the phone's bar). */
	quote: string;
	/** Text selected (vs lines picked). */
	text: boolean;
}

const GAP = 6;
const MARGIN = 8;

/** A span as one string, to tell spans apart. */
const keyOf = (span: CodeSpan) => JSON.stringify(span);

/**
 * Where the floating bar goes (desktop), never over the selection when it
 * can help it: below its visible end, else above its start, else beside it
 * (right, then left), else the viewport's bottom right corner.
 */
export function placeBar(
	target: Pick<BarTarget, "first" | "last" | "box" | "text">,
	size: { w: number; h: number },
	view: { w: number; h: number },
): { top: number; left: number } {
	const { w, h } = size;
	const clampX = (x: number) =>
		Math.round(Math.min(Math.max(MARGIN, x), view.w - w - MARGIN));
	// The visible end: the last line, or the viewport's bottom when it's below.
	const end = Math.min(target.last.bottom, view.h);
	const anchor = target.text ? target.last.right : target.last.left + 8;
	if (target.last.bottom <= view.h && end + GAP + h <= view.h - MARGIN) {
		return { top: Math.round(end + GAP), left: clampX(anchor - w / 2) };
	}
	if (target.first.top >= 0 && target.first.top - GAP - h >= MARGIN) {
		return {
			top: Math.round(target.first.top - GAP - h),
			left: clampX(anchor - w / 2),
		};
	}
	const top = Math.round(
		Math.min(Math.max(MARGIN, end - h), view.h - h - MARGIN),
	);
	if (target.box.right + GAP + w <= view.w - MARGIN) {
		return { top, left: Math.round(target.box.right + GAP) };
	}
	if (target.box.left - GAP - w >= MARGIN) {
		return { top, left: Math.round(target.box.left - GAP - w) };
	}
	return { top: view.h - h - MARGIN, left: view.w - w - MARGIN };
}

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
			? [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0)
			: [];
	const box =
		typeof range.getBoundingClientRect === "function"
			? range.getBoundingClientRect()
			: new DOMRect();
	const first = rects[0] ?? box;
	const last = rects[rects.length - 1] ?? box;
	const text = selection.toString().trim().split("\n")[0] ?? "";
	return {
		...found,
		first,
		last,
		box,
		quote: text.length > 40 ? `${text.slice(0, 40)}…` : text,
		text: true,
	};
};

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
		quote: "",
		text: false,
	};
};

/**
 * The actions for what is selected in Files changed: text in the code, or
 * lines picked by their numbers. One icon button per registered action
 * (selectionActions.ts), disabled with its reason as the tooltip when it
 * can't run there. On a desktop the bar floats just below the selection's
 * end (above it when there's no room), never over it; on a phone it is
 * pinned to the bottom, quoting the selection. It never takes the
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
		return () => {
			clearTimeout(timer);
			document.removeEventListener("selectionchange", later);
			document.removeEventListener("pointerup", now);
			document.removeEventListener("keyup", now);
		};
	}, [read]);
	const target = text ?? (picks && commit ? ofPicks(picks, commit) : null);
	const hidden = !target || dismissed === keyOf(target.span);
	// Rects move with the page: read again on scroll and resize, once a frame.
	const [, setTick] = useState(0);
	const reading = text !== null;
	useEffect(() => {
		if (hidden || !wide) return;
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
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("scroll", move, { capture: true });
			window.removeEventListener("resize", move);
		};
	}, [hidden, wide, reading, commit]);
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
	useEffect(() => {
		if (!shownKey) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Tab" || e.shiftKey || e.defaultPrevented) return;
			const el = bar.current;
			if (!el || el.contains(document.activeElement)) return;
			if (tabbed.current === shownKey) return;
			// Not from a field being typed in.
			const active = document.activeElement;
			if (
				active instanceof HTMLTextAreaElement ||
				active instanceof HTMLInputElement
			) {
				return;
			}
			tabbed.current = shownKey;
			e.preventDefault();
			el.querySelector<HTMLButtonElement>("button")?.focus({
				preventScroll: true,
			});
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [shownKey]);
	const [place, setPlace] = useState<{ top: number; left: number } | null>(
		null,
	);
	useLayoutEffect(() => {
		const el = bar.current;
		if (hidden || !target || !el || !wide) {
			setPlace(null);
			return;
		}
		const next = placeBar(
			target,
			{ w: el.offsetWidth, h: el.offsetHeight },
			{ w: document.documentElement.clientWidth, h: window.innerHeight },
		);
		setPlace((p) => (p?.top === next.top && p.left === next.left ? p : next));
	});
	// A phone's bar sits at the bottom: the page can scroll past it
	// (--selection-bar pads the file list), and a selection under it moves
	// up once, when the bar comes.
	const scrolledFor = useRef<string | null>(null);
	useLayoutEffect(() => {
		const el = bar.current;
		const root = document.documentElement;
		if (hidden || !target || !el || wide) {
			root.style.removeProperty("--selection-bar");
			return;
		}
		const top = el.getBoundingClientRect().top;
		root.style.setProperty(
			"--selection-bar",
			`${Math.ceil(el.offsetHeight + MARGIN)}px`,
		);
		const key = keyOf(target.span);
		if (scrolledFor.current !== key) {
			scrolledFor.current = key;
			const under = target.last.bottom - (top - MARGIN);
			if (under > 0) window.scrollBy(0, under);
		}
	});
	useEffect(
		() => () => {
			document.documentElement.style.removeProperty("--selection-bar");
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
			style={
				wide
					? ((place ?? { top: -9999, left: -9999 }) satisfies CSSProperties)
					: undefined
			}
			className={
				wide
					? "fixed z-40 flex gap-0.5 rounded-lg border border-edge bg-overlay p-0.5 shadow-float"
					: "fixed inset-x-0 bottom-0 z-40 flex items-center gap-1 border-t border-edge bg-overlay px-3 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] shadow-sheet"
			}
		>
			{!wide && (
				<p className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
					{target.quote && (
						<span className="text-code-ink">{target.quote} · </span>
					)}
					{describeSpan(target.span)}
				</p>
			)}
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
