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
function lineBoxes(section: Element): LineBox[] {
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

/** What the reader does that ends the hold: theirs wins over a late restore. */
const INPUTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/**
 * The view's own regions still loading (principle 8 puts `aria-busy` on
 * each): Text's lines and changed words, the Rendered document, the
 * image, the since chips over them. Not a conversation's (an agent
 * answering in a thread card): those take as long as they take, and
 * don't move the view's lines.
 */
const VIEW_BUSY = [
	'[data-testid="diff-loading"]',
	'[data-testid="md-loading"][aria-busy="true"]',
	'[data-testid="code"][aria-busy="true"]',
	'[data-testid="image-stage"][aria-busy="true"]',
	'[data-testid="since-chips"][aria-busy="true"]',
].join(", ");

/** How the hold waits a frame: the page's, or a test's. */
export interface Frames {
	request: (run: () => void) => number;
	cancel: (id: number) => void;
}

const pageFrames: Frames = {
	request: (run) => requestAnimationFrame(run),
	cancel: (id) => cancelAnimationFrame(id),
};

/**
 * Before a pick: where the reader is in `section`'s view. Returns null
 * when there's no place to keep (the file's start is in view); else a
 * hold to start once the pick is made, for the new view (`renderer`, on
 * the section's `data-renderer`).
 *
 * The hold puts that place back where it was once the new view shows its
 * lines, and again whenever the section changes, until nothing in the
 * view is busy any more (VIEW_BUSY) and one more frame has passed; at
 * once, once a view other than the pick's settles in (a fallback). A view with no lines (Image) puts its view bar back
 * where it was pinned instead. Never on a timer: the reader's own input
 * (a wheel, a touch, a key, a pointer) or a scroll the hold didn't make
 * (a scrollbar drag, a link that scrolls) ends it at once. While it holds,
 * the browser's own scroll anchoring is off, so every scroll it sees is
 * the hold's or someone else's.
 */
export function keepPlace(
	section: HTMLElement,
	frames: Frames = pageFrames,
): ((renderer: string) => () => void) | null {
	const bar = section.querySelector<HTMLElement>("[data-view-bar]");
	const stack = stickyBottom(bar ?? section);
	const place = placeAt(lineBoxes(section), stack);
	const barTop = bar?.getBoundingClientRect().top;
	if (!place) return null;
	const { line, y: was } = place;
	return (renderer) => {
		let frame = 0;
		let stopped = false;
		// The scroll position the hold last left: a scroll elsewhere is
		// someone else's. Before its first write, only the switch's own
		// clamp (a shorter view: the page's last scroll position) isn't.
		let wrote: number | undefined;
		// Nothing busy at the last frame: one more, then the hold ends.
		let quiet = false;
		const root = document.documentElement;
		const anchor = root.style.overflowAnchor;
		root.style.overflowAnchor = "none";
		const schedule = () => {
			if (!frame && !stopped) frame = frames.request(attempt);
		};
		const observer = new MutationObserver(() => {
			quiet = false;
			schedule();
		});
		const resized =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(() => {
						quiet = false;
						schedule();
					});
		const onScroll = () => {
			const y = window.scrollY;
			if (wrote === undefined) {
				const end = root.scrollHeight - window.innerHeight;
				if (Math.abs(y - Math.max(0, end)) >= 1) stop();
			} else if (Math.abs(y - wrote) >= 1) stop();
		};
		function stop() {
			if (stopped) return;
			stopped = true;
			if (frame) frames.cancel(frame);
			frame = 0;
			observer.disconnect();
			resized?.disconnect();
			root.style.overflowAnchor = anchor;
			window.removeEventListener("scroll", onScroll, true);
			for (const e of INPUTS) window.removeEventListener(e, stop, true);
		}
		const scrollBy = (dy: number) => {
			if (Math.abs(dy) >= 1) window.scrollBy({ top: dy, behavior: "instant" });
			wrote = window.scrollY;
		};
		function attempt() {
			frame = 0;
			if (!section.isConnected) return stop();
			const busy = section.querySelector(VIEW_BUSY) !== null;
			// Another view than the one picked (Rendered fell back to Text,
			// a line target's Text): once it's in, nothing to keep.
			if (section.getAttribute("data-renderer") !== renderer)
				return busy ? undefined : stop();
			const y = yOfLine(lineBoxes(section), line);
			const image = section.querySelector("[data-testid=image-view]");
			if (y !== null) scrollBy(y - was);
			else if (image && barTop !== undefined) {
				// No lines: the image's view, its bar first in it. The bar
				// goes back to where it was pinned, the image under it.
				const top = image.getBoundingClientRect().top;
				scrollBy(top < barTop ? top - barTop : 0);
			} else if (!busy) return stop();
			if (busy) {
				quiet = false;
				return;
			}
			if (quiet) return stop();
			quiet = true;
			schedule();
		}
		observer.observe(section, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["data-renderer", "aria-busy"],
		});
		resized?.observe(section);
		window.addEventListener("scroll", onScroll, {
			capture: true,
			passive: true,
		});
		for (const e of INPUTS)
			window.addEventListener(e, stop, { capture: true, passive: true });
		schedule();
		return stop;
	};
}
