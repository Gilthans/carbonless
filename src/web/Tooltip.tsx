import {
	type FocusEvent,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { usePageActive } from "./pageActive";

/** Props the trigger element spreads onto itself. */
export interface TooltipTriggerProps {
	ref: (el: HTMLElement | null) => void;
	"aria-describedby"?: string;
	onMouseEnter: () => void;
	onMouseLeave: () => void;
	onFocus: (e: FocusEvent) => void;
	onBlur: () => void;
	onKeyDown: (e: KeyboardEvent) => void;
}

/** How long the pointer rests on a trigger before its tooltip shows. */
export const HOVER_DELAY_MS = 150;

// Whether the last input was the keyboard or a touch (focus-visible's own
// heuristic, tracked here so it also holds where :focus-visible is missing).
// Their focus keeps a tooltip open until blur; a mouse click's focus does not.
let lastInputKeepsOpen = false;
let lastPointerType = "";
if (typeof window !== "undefined") {
	window.addEventListener(
		"keydown",
		(e) => {
			if (e.key !== "Escape") lastInputKeepsOpen = true;
		},
		true,
	);
	window.addEventListener(
		"pointerdown",
		(e) => {
			lastPointerType = e.pointerType;
			lastInputKeepsOpen = e.pointerType === "touch";
		},
		true,
	);
	// A mouse event after a touch is emulated; one with no pointer event
	// before it (old engines, test tools) is a plain click.
	window.addEventListener(
		"mousedown",
		() => {
			lastInputKeepsOpen = lastPointerType === "touch";
		},
		true,
	);
}

/** Whether the element has focus that should hold its tooltip open. */
function keepOpenFocus(el: HTMLElement | null): boolean {
	return !!el && el.contains(document.activeElement) && lastInputKeepsOpen;
}

const GAP = 6;
const MARGIN = 8;

/**
 * A text tooltip that opens on hover and on keyboard focus (or a tap, which
 * focuses), closes on Escape, blur, mouse leave and a scroll that moves its
 * trigger, and is the
 * trigger's accessible description (unless `describe` is false). It is `position: fixed` and kept inside
 * the viewport, so it never widens the page on a phone.
 */
export function Tooltip(props: {
	/** Text; a path inside it goes in <TooltipPath> (monospace). */
	content: ReactNode;
	/**
	 * Whether the text is the trigger's accessible description. Turn it off
	 * when it repeats the trigger's accessible name.
	 */
	describe?: boolean;
	/** Mouse-hover delay in ms (focus and tap show at once). */
	hoverDelay?: number;
	/**
	 * No element while closed (for many triggers, e.g. every escape in code).
	 * Only with `describe` false: a description must always exist.
	 */
	lazy?: boolean;
	/** Closes the tip whenever this changes (a toggle that just switched). */
	dismissKey?: unknown;
	children: (trigger: TooltipTriggerProps) => ReactNode;
}) {
	const id = useId();
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLElement | null>(null);
	const tip = useRef<HTMLSpanElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

	useLayoutEffect(() => {
		if (!open) {
			setPos(null);
			return;
		}
		const t = trigger.current?.getBoundingClientRect();
		const box = tip.current?.getBoundingClientRect();
		if (!t || !box) return;
		const vw = document.documentElement.clientWidth || window.innerWidth;
		const vh = window.innerHeight;
		const left = Math.max(
			MARGIN,
			Math.min(t.left + t.width / 2 - box.width / 2, vw - box.width - MARGIN),
		);
		const below = t.bottom + GAP;
		const top =
			below + box.height > vh - MARGIN ? t.top - GAP - box.height : below;
		setPos({ left, top: Math.max(MARGIN, top) });
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const close = () => setOpen(false);
		// A scroll closes it only once its trigger has moved: one on a sticky
		// header stays put (focusing it can fire a scroll that moves nothing).
		const at = trigger.current?.getBoundingClientRect();
		const onScroll = () => {
			const now = trigger.current?.getBoundingClientRect();
			if (
				!at ||
				!now ||
				Math.abs(now.top - at.top) > 1 ||
				Math.abs(now.left - at.left) > 1
			) {
				close();
			}
		};
		// Escape dismisses it wherever focus is (a hover-opened one has none).
		const onKey = (e: globalThis.KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", close);
		window.addEventListener("keydown", onKey);
		// A focused button that becomes disabled gets no blur in Chrome.
		const el = trigger.current;
		const observer = new MutationObserver(close);
		if (el) {
			observer.observe(el, {
				attributes: true,
				attributeFilter: ["disabled"],
				subtree: true,
			});
		}
		return () => {
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", close);
			window.removeEventListener("keydown", onKey);
			observer.disconnect();
		};
	}, [open]);

	useEffect(() => () => clearTimeout(timer.current), []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on each change of the key.
	useEffect(() => {
		clearTimeout(timer.current);
		setOpen(false);
	}, [props.dismissKey]);

	// Its page was hidden (another page shows): nothing to point at.
	const active = usePageActive();
	useEffect(() => {
		if (!active) {
			clearTimeout(timer.current);
			setOpen(false);
		}
	}, [active]);

	const show = () => {
		clearTimeout(timer.current);
		setOpen(true);
	};
	const hide = () => {
		clearTimeout(timer.current);
		setOpen(false);
	};

	return (
		<>
			{props.children({
				ref: (el) => {
					trigger.current = el;
				},
				"aria-describedby": props.describe === false ? undefined : id,
				onMouseEnter: () => {
					clearTimeout(timer.current);
					timer.current = setTimeout(
						() => setOpen(true),
						props.hoverDelay ?? HOVER_DELAY_MS,
					);
				},
				onMouseLeave: () => {
					clearTimeout(timer.current);
					// Keyboard or touch focus keeps it open; a click's focus does not.
					if (!keepOpenFocus(trigger.current)) setOpen(false);
				},
				onFocus: show,
				onBlur: hide,
				onKeyDown: (e) => {
					if (e.key === "Escape") hide();
				},
			})}
			{/* A lazy tooltip has no element while closed. */}
			{(open || !props.lazy) &&
				createPortal(
					<span
						ref={tip}
						id={id}
						role="tooltip"
						aria-hidden={props.describe === false ? true : undefined}
						hidden={!open}
						style={{
							left: pos?.left ?? 0,
							top: pos?.top ?? 0,
							visibility: pos ? "visible" : "hidden",
						}}
						className="pointer-events-none fixed z-[1000] w-max max-w-[min(20rem,calc(100vw-1rem))] rounded-md border border-edge bg-overlay px-2 py-1 text-xs leading-5 font-normal whitespace-normal text-ink shadow-float"
					>
						{props.content}
					</span>,
					document.body,
				)}
		</>
	);
}

/** A file path inside tooltip content: monospace, like paths everywhere. */
export function TooltipPath({ children }: { children: ReactNode }) {
	return (
		<code data-tooltip-path className="font-mono [overflow-wrap:anywhere]">
			{children}
		</code>
	);
}
