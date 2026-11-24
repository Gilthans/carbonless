import { TypographyIcon } from "@primer/octicons-react";
import {
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { type Copied, CopyMark, copyInto, copyWord } from "./CopyMark";
import {
	COPIED_MS,
	type Press,
	type PressHandlers,
	selectedIn,
	useLongPress,
} from "./longPress";

/**
 * A long press on a message, on touch (CAR-280): its menu offers Copy
 * message (the whole message's Markdown source) and Select text. A mouse
 * never opens it: desktop selects and copies as ever.
 */

/**
 * A message's long press and its menu: spread `press` on the element that
 * shows the message, and put `menu` anywhere beside it. `text` is what
 * Copy message copies: the message's Markdown source, as written, so it
 * pastes back into a comment or a prompt with its code blocks, links and
 * suggestions intact (rendered text would drop them). Empty: no menu.
 */
export function useMessageCopy(text: string): {
	press: PressHandlers;
	menu: ReactNode;
} {
	const [open, setOpen] = useState<Press | null>(null);
	const press = useLongPress((p) => {
		if (!text) return;
		// The browser's own selection from this press (iOS's word) goes:
		// the menu is what the press gave.
		if (selectedIn(p.el)) document.getSelection()?.removeAllRanges();
		setOpen(p);
	});
	const menu = open ? (
		<MessageMenu at={open} text={text} onClose={() => setOpen(null)} />
	) : null;
	return { press, menu };
}

const ITEM =
	"flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm whitespace-nowrap text-ink hover:bg-pressed focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/** Room kept between the menu and the finger, and the screen's edges. */
const GAP = 16;
const EDGE = 8;

/**
 * Where the menu goes: centred on the finger and above it (the finger
 * lifting never lands on it), else below; inside the screen.
 */
export function menuPlace(
	at: { x: number; y: number },
	size: { w: number; h: number },
	screen: { w: number; h: number },
): { left: number; top: number } {
	const clamp = (v: number, lo: number, hi: number) =>
		Math.max(lo, Math.min(v, Math.max(lo, hi)));
	const left = clamp(at.x - size.w / 2, EDGE, screen.w - size.w - EDGE);
	const above = at.y - GAP - size.h;
	const top =
		above >= EDGE
			? above
			: clamp(at.y + GAP * 2, EDGE, screen.h - size.h - EDGE);
	return { left, top };
}

/** The caret's place at a viewport point, by whichever API the browser has. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
	const d = document as Document & {
		caretPositionFromPoint?: (
			x: number,
			y: number,
		) => { offsetNode: Node; offset: number } | null;
		caretRangeFromPoint?: (x: number, y: number) => Range | null;
	};
	if (typeof d.caretPositionFromPoint === "function") {
		const p = d.caretPositionFromPoint(x, y);
		if (p) return { node: p.offsetNode, offset: p.offset };
	}
	if (typeof d.caretRangeFromPoint === "function") {
		const r = d.caretRangeFromPoint(x, y);
		if (r) return { node: r.startContainer, offset: r.startOffset };
	}
	return null;
}

/**
 * The word of `el` at a viewport point, as a range: in the text node the
 * caret lands in there, the word segment holding it (Intl.Segmenter, any
 * script). Null where there is none (a space, an image, outside `el`).
 */
export function wordAt(el: HTMLElement, x: number, y: number): Range | null {
	const at = caretAt(x, y);
	if (!at || at.node.nodeType !== Node.TEXT_NODE || !el.contains(at.node)) {
		return null;
	}
	const text = at.node.textContent ?? "";
	if (typeof Intl.Segmenter !== "function") return null;
	const words = new Intl.Segmenter(undefined, { granularity: "word" });
	for (const seg of words.segment(text)) {
		const end = seg.index + seg.segment.length;
		if (at.offset < seg.index || at.offset > end) continue;
		// On a boundary the word after wins; a space or a mark is none.
		if (at.offset === end && end < text.length) continue;
		if (!seg.isWordLike) return null;
		const range = document.createRange();
		range.setStart(at.node, seg.index);
		range.setEnd(at.node, end);
		return range;
	}
	return null;
}

/**
 * Select text: the word under the finger, so the phone shows its own
 * handles to widen it (as its long press would have); the whole message
 * where no word is there.
 */
function selectFrom(at: Press) {
	const selection = document.getSelection();
	if (!selection) return;
	const word = wordAt(at.el, at.x, at.y);
	if (word) {
		selection.removeAllRanges();
		selection.addRange(word);
	} else {
		selection.selectAllChildren(at.el);
	}
}

/** What a reader does to scroll: a scroll after one of these is theirs. */
const READER_SCROLLS = ["wheel", "touchmove", "keydown"] as const;

/**
 * The menu a long press opened: Copy message, Select text. Fixed by the
 * finger, over the page for as long as it is open: a tap elsewhere, a
 * scroll by the reader (not one the content makes, a growing answer
 * re-pinned) or Escape closes it, and the focus goes back where it was.
 * In the message's modal dialog when it is in one (the rest of the page
 * is inert there).
 */
function MessageMenu(props: { at: Press; text: string; onClose: () => void }) {
	const { at, text, onClose } = props;
	const menu = useRef<HTMLDivElement>(null);
	const first = useRef<HTMLButtonElement>(null);
	const [place, setPlace] = useState<{ left: number; top: number } | null>(
		null,
	);
	const [copied, setCopied] = useState<Copied>(null);
	const latestClose = useRef(onClose);
	latestClose.current = onClose;
	// Where the focus was (a reply being written): back there on close,
	// unless the menu left a selection to keep (Select text, Copy failed).
	useLayoutEffect(() => {
		const back = document.activeElement;
		return () => {
			if (!(back instanceof HTMLElement) || !back.isConnected) return;
			if (selectedIn(at.el)) return;
			back.focus({ preventScroll: true });
		};
	}, [at]);
	useLayoutEffect(() => {
		const el = menu.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		setPlace(
			menuPlace(
				at,
				{ w: r.width, h: r.height },
				{ w: window.innerWidth, h: window.innerHeight },
			),
		);
		first.current?.focus({ preventScroll: true });
	}, [at]);
	useEffect(() => {
		const close = () => latestClose.current();
		const outside = (e: Event) => {
			if (!menu.current?.contains(e.target as Node)) close();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			close();
		};
		let byReader = false;
		const reader = (e: Event) => {
			if (e instanceof KeyboardEvent && e.key === "Escape") return;
			byReader = true;
		};
		const scrolled = () => {
			if (byReader) close();
		};
		const opts = { capture: true, passive: true } as const;
		document.addEventListener("pointerdown", outside, true);
		document.addEventListener("keydown", onKey, true);
		for (const t of READER_SCROLLS) window.addEventListener(t, reader, opts);
		window.addEventListener("scroll", scrolled, opts);
		window.addEventListener("resize", close);
		return () => {
			document.removeEventListener("pointerdown", outside, true);
			document.removeEventListener("keydown", onKey, true);
			for (const t of READER_SCROLLS) {
				window.removeEventListener(t, reader, opts);
			}
			window.removeEventListener("scroll", scrolled, opts);
			window.removeEventListener("resize", close);
		};
	}, []);
	useEffect(() => {
		if (copied !== "ok") return;
		const timer = setTimeout(() => latestClose.current(), COPIED_MS);
		return () => clearTimeout(timer);
	}, [copied]);
	const host = at.el.closest("dialog") ?? document.body;
	return createPortal(
		<div
			ref={menu}
			role="menu"
			aria-label="Message"
			data-testid="message-menu"
			style={
				place
					? { left: place.left, top: place.top }
					: { left: 0, top: 0, visibility: "hidden" }
			}
			className="fixed z-50 min-w-44 rounded-lg border border-edge bg-surface p-1 text-ink shadow-float"
		>
			<button
				ref={first}
				type="button"
				role="menuitem"
				aria-label={copyWord(copied, "Copy message")}
				onClick={() => {
					// Refused: the message is selected, to copy by hand.
					void copyInto(text, at.el, setCopied);
				}}
				className={ITEM}
			>
				<CopyMark copied={copied} />
				<span aria-hidden>{copyWord(copied, "Copy message")}</span>
			</button>
			<button
				type="button"
				role="menuitem"
				onClick={() => {
					selectFrom(at);
					onClose();
				}}
				className={ITEM}
			>
				<TypographyIcon size={16} aria-hidden />
				Select text
			</button>
		</div>,
		host,
	);
}
