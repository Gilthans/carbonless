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

const GAP = 6;
const MARGIN = 8;

/**
 * A text tooltip that opens on hover and on keyboard focus (or a tap, which
 * focuses), closes on Escape, blur, mouse leave and scroll, and is the
 * trigger's accessible description (unless `describe` is false). It is `position: fixed` and kept inside
 * the viewport, so it never widens the page on a phone.
 */
export function Tooltip(props: {
	content: string;
	/**
	 * Whether the text is the trigger's accessible description. Turn it off
	 * when it repeats the trigger's accessible name.
	 */
	describe?: boolean;
	/** Mouse-hover delay in ms (focus and tap show at once). */
	hoverDelay?: number;
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
		window.addEventListener("scroll", close, true);
		window.addEventListener("resize", close);
		return () => {
			window.removeEventListener("scroll", close, true);
			window.removeEventListener("resize", close);
		};
	}, [open]);

	useEffect(() => () => clearTimeout(timer.current), []);

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
					if (trigger.current !== document.activeElement) setOpen(false);
				},
				onFocus: show,
				onBlur: hide,
				onKeyDown: (e) => {
					if (e.key === "Escape") hide();
				},
			})}
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
				className="pointer-events-none fixed z-50 w-max max-w-[min(20rem,calc(100vw-1rem))] rounded-md bg-slate-900 px-2 py-1 text-xs leading-5 font-normal whitespace-normal text-white shadow-lg"
			>
				{props.content}
			</span>
		</>
	);
}
