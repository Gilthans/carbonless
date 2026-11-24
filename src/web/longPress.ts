import {
	type MouseEvent,
	type PointerEvent,
	useCallback,
	useEffect,
	useRef,
} from "react";

/**
 * A long press by a finger (CAR-280): what opens a message's menu
 * (messageCopy.tsx). No JSX here, so e2e specs can read its timings.
 */

/**
 * How long a finger rests on a message before its menu opens: Android's
 * own long press (its system timeout, 400 ms since Android 12), and
 * before iOS's text long press (~500 ms). Ours comes first or together;
 * while a finger rests, the message can't be selected anyway
 * (`data-pressing`), and Android's contextmenu, if it comes first, opens
 * ours at once.
 */
export const LONG_PRESS_MS = 400;
/** How far the finger may move and still be a press (not a scroll or a drag). */
export const PRESS_SLOP = 8;
/** How long "Copied" shows before the menu goes. */
export const COPIED_MS = 1000;

/** Where a press on these acts on them, never on the message. */
const OWN_PRESS =
	'a[href], button, input, textarea, select, summary, label, [role="button"], [contenteditable]:not([contenteditable="false"])';

/** Where a long press landed: the finger's point, and the message. */
export interface Press {
	x: number;
	y: number;
	el: HTMLElement;
}

/** The handlers a message takes for long presses. */
export interface PressHandlers {
	onPointerDown: (e: PointerEvent<HTMLElement>) => void;
	onPointerMove: (e: PointerEvent<HTMLElement>) => void;
	onPointerUp: (e: PointerEvent<HTMLElement>) => void;
	onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
	onContextMenu: (e: MouseEvent<HTMLElement>) => void;
	onClickCapture: (e: MouseEvent<HTMLElement>) => void;
}

/** Whether the document's selection reaches into `el`. */
export function selectedIn(el: HTMLElement): boolean {
	const s = document.getSelection();
	if (!s || s.isCollapsed || s.rangeCount === 0) return false;
	for (let i = 0; i < s.rangeCount; i++) {
		if (s.getRangeAt(i).intersectsNode(el)) return true;
	}
	return false;
}

/**
 * A long press by a finger: resting LONG_PRESS_MS without moving more
 * than PRESS_SLOP calls `onPress`. Not from a mouse or a pen, not on a
 * link or a control inside (they keep their own press), not by a second
 * finger (a pinch), and not while the reader has text selected in it (a
 * long press there is the browser's own, to adjust the selection). The
 * browser's long press on the same press can't select (`data-pressing`)
 * and its contextmenu (Android) is cancelled, opening the menu at once if
 * it comes first; the click a lifted finger may send right after is
 * swallowed (none comes on a phone: any next press clears it).
 */
export function useLongPress(onPress: (p: Press) => void): PressHandlers {
	const press = useRef<{
		id: number;
		x: number;
		y: number;
		el: HTMLElement;
		timer: ReturnType<typeof setTimeout>;
		fired: boolean;
	} | null>(null);
	/** A press that fired just lifted: its click goes nowhere. */
	const swallow = useRef(false);
	const latest = useRef(onPress);
	latest.current = onPress;
	const end = useCallback(() => {
		const p = press.current;
		if (!p) return;
		clearTimeout(p.timer);
		p.el.removeAttribute("data-pressing");
		press.current = null;
	}, []);
	useEffect(() => end, [end]);
	const fire = useCallback(() => {
		const p = press.current;
		if (!p || p.fired) return;
		clearTimeout(p.timer);
		p.fired = true;
		latest.current({ x: p.x, y: p.y, el: p.el });
	}, []);
	return {
		onPointerDown: (e) => {
			// Any new press: the click a fired press left to swallow never
			// came (phones send none after a long press), and this press's
			// own click goes through.
			swallow.current = false;
			// A second finger: a pinch, not a press.
			if (press.current) return end();
			if (e.pointerType !== "touch") return;
			const target = e.target instanceof Element ? e.target : null;
			if (target?.closest(OWN_PRESS)) return;
			const el = e.currentTarget;
			if (selectedIn(el)) return;
			// While the finger rests, the browser's own long press can't
			// select a word or bring its callout here (index.css); back on
			// lift, cancel or a move, not on firing: iOS's comes after ours.
			el.setAttribute("data-pressing", "");
			press.current = {
				id: e.pointerId,
				x: e.clientX,
				y: e.clientY,
				el,
				timer: setTimeout(fire, LONG_PRESS_MS),
				fired: false,
			};
		},
		onPointerMove: (e) => {
			const p = press.current;
			if (!p || p.fired || e.pointerId !== p.id) return;
			if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > PRESS_SLOP) end();
		},
		onPointerUp: (e) => {
			const p = press.current;
			if (!p || e.pointerId !== p.id) return;
			swallow.current = p.fired;
			end();
		},
		onPointerCancel: (e) => {
			if (press.current && e.pointerId === press.current.id) end();
		},
		onContextMenu: (e) => {
			if (!press.current) return;
			e.preventDefault();
			fire();
		},
		onClickCapture: (e) => {
			if (!swallow.current) return;
			swallow.current = false;
			e.preventDefault();
			e.stopPropagation();
		},
	};
}
