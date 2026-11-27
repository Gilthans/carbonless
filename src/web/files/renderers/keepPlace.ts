import { stickyBottom } from "../scrollAnchor";

/**
 * Switching a file's view mid-file keeps the reader's place (CAR-317): the
 * new-side line at the top of what they read stays where it was on screen.
 * Text's rows are one line each (`data-new-no`); a Rendered block spans
 * its source lines (`data-new-lines="from-to"`), a line inside it taken
 * proportionally down its height. A row with no new line (a removed one)
 * isn't a place: the next one is.
 */

/** A row or block's viewport box and the new-side lines it shows (1-based, inclusive). */
export interface LineBox {
	top: number;
	height: number;
	from: number;
	to: number;
}

/** Where the reader is: a new-side line and its viewport y. */
export interface Place {
	line: number;
	y: number;
}

const lineY = (b: LineBox, line: number) =>
	b.top + ((line - b.from) * b.height) / (b.to - b.from + 1);

/**
 * The line at `stack` (the sticky stack's bottom, viewport px): the first
 * box reaching below it, and inside a block the line that far down it.
 * Null when the view starts below the stack (the reader is at the file's
 * start: nothing above changes) or shows no lines.
 */
export function placeAt(
	boxes: readonly LineBox[],
	stack: number,
): Place | null {
	const first = boxes[0];
	if (!first || first.top >= stack) return null;
	const b = boxes.find((x) => x.top + x.height > stack);
	if (!b) return null;
	if (b.top >= stack) return { line: b.from, y: b.top };
	const per = b.height / (b.to - b.from + 1);
	const line = Math.min(b.to, b.from + Math.floor((stack - b.top) / per));
	return { line, y: lineY(b, line) };
}

/**
 * Where `line` shows in a view (viewport y): the box holding it; else (a
 * line the view folds away) the first box after it, or the end of the last
 * one before it. Null for a view with no lines.
 */
export function yOfLine(
	boxes: readonly LineBox[],
	line: number,
): number | null {
	let before: LineBox | undefined;
	for (const b of boxes) {
		if (line >= b.from && line <= b.to) return lineY(b, line);
		if (b.from > line) return b.top;
		before = b;
	}
	return before ? before.top + before.height : null;
}

/** A row or block as measured; `from` undefined: it shows no new line (a removed one). */
export interface Measured {
	top: number;
	height: number;
	from?: number;
	to?: number;
}

/**
 * The boxes of what was measured: a removed row joins the box of the new
 * line after it, as Rendered shows a changed block (old over new) in one
 * row. So the place read is the change's top either way.
 */
export function boxesOf(rows: readonly Measured[]): LineBox[] {
	const out: LineBox[] = [];
	let removed: number | undefined;
	for (const r of rows) {
		if (r.height === 0) continue;
		if (r.from === undefined) {
			removed ??= r.top;
			continue;
		}
		const top = removed ?? r.top;
		removed = undefined;
		out.push({
			top,
			height: r.top + r.height - top,
			from: r.from,
			to: r.to ?? r.from,
		});
	}
	return out;
}

const number = (v: string | undefined) => {
	const n = Number(v);
	return v && Number.isInteger(n) && n > 0 ? n : undefined;
};

/** The boxes of the view shown in `section`, top to bottom. */
export function lineBoxes(section: Element): LineBox[] {
	const rows: Measured[] = [];
	for (const el of section.querySelectorAll(
		"[data-testid=diff-line], [data-new-lines]",
	)) {
		const r = el.getBoundingClientRect();
		const lines = el.getAttribute("data-new-lines")?.split("-");
		const from = number(lines?.[0] ?? el.getAttribute("data-new-no") ?? "");
		rows.push({
			top: r.top,
			height: r.height,
			from,
			to: number(lines?.[1]),
		});
	}
	return boxesOf(rows);
}

/** What the reader does that ends the wait: theirs wins over a late restore. */
const INPUTS = ["wheel", "touchstart", "keydown"] as const;

/**
 * Before a pick: where the reader is in `section`'s view, and once the
 * new view (`renderer`, on the section's `data-renderer`) shows its lines,
 * scrolls that place back where it was. A view with no lines (Image) puts
 * its view bar back where it was pinned instead. Gives up after `wait` ms
 * or once the reader scrolls themselves. Returns null when there's no
 * place to keep (the file's start is in view).
 */
export function keepPlace(
	section: HTMLElement,
	wait = 5000,
): ((renderer: string) => () => void) | null {
	const bar = section.querySelector<HTMLElement>("[data-view-bar]");
	const stack = stickyBottom(bar ?? section);
	const place = placeAt(lineBoxes(section), stack);
	const barTop = bar?.getBoundingClientRect().top;
	if (!place) return null;
	const { line, y: was } = place;
	return (renderer) => {
		let frame = 0;
		const observer = new MutationObserver(() => {
			if (!frame) frame = requestAnimationFrame(attempt);
		});
		const stop = () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			clearTimeout(timer);
			for (const e of INPUTS) window.removeEventListener(e, stop, true);
		};
		const timer = setTimeout(stop, wait);
		function attempt() {
			frame = 0;
			if (!section.isConnected) return stop();
			if (section.getAttribute("data-renderer") !== renderer) return;
			const y = yOfLine(lineBoxes(section), line);
			if (y !== null) {
				window.scrollBy(0, y - was);
				return stop();
			}
			// No lines: the image's view, its bar first in it. The bar goes
			// back to where it was pinned, the image under it.
			const image = section.querySelector("[data-testid=image-view]");
			if (!image || barTop === undefined) return;
			const top = image.getBoundingClientRect().top;
			if (top < barTop) window.scrollBy(0, top - barTop);
			stop();
		}
		observer.observe(section, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["data-renderer"],
		});
		for (const e of INPUTS)
			window.addEventListener(e, stop, { capture: true, passive: true });
		frame = requestAnimationFrame(attempt);
		return stop;
	};
}
