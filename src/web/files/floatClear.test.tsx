// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bestCpuRatio } from "../../../test/cpu";
import { FilesFab } from "./FilesFab";
import { controlUnder, useFloatClearCard, watchFloat } from "./floatClear";

/** jsdom has no layout: each element's rect is what a test gives it. */
const rects = new WeakMap<Element, DOMRect>();
const rect = (left: number, top: number, width: number, height: number) =>
	({
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		x: left,
		y: top,
		toJSON: () => ({}),
	}) as DOMRect;
const place = (el: Element, r: DOMRect) => {
	rects.set(el, r);
	return el;
};
const NOWHERE = rect(0, 0, 0, 0);
/** The phone's Files button: 16px from the right and bottom of 360x800. */
const FAB = rect(248, 736, 96, 48);

let frames: FrameRequestCallback[] = [];
const flush = () => {
	const now = frames;
	frames = [];
	for (const f of now) f(0);
};

beforeEach(() => {
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
		function (this: Element) {
			return rects.get(this) ?? NOWHERE;
		},
	);
	frames = [];
	vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => {
		frames.push(f);
		return frames.length;
	});
	vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
	cleanup();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** A card with `controls` (HTML) whose first element sits at `at`. */
function card(controls: string, at: DOMRect, cardAt = rect(0, 600, 360, 200)) {
	const el = document.createElement("div");
	el.innerHTML = controls;
	place(el, cardAt);
	const first = el.firstElementChild;
	if (first) place(first, at);
	document.body.append(el);
	return el;
}

describe("controlUnder", () => {
	const under = rect(300, 740, 40, 40);

	it("a button, link, box or select under the button counts", () => {
		for (const html of [
			"<button>Comment</button>",
			'<a href="#x">a link</a>',
			"<textarea></textarea>",
			"<select></select>",
			"<input>",
		]) {
			expect(controlUnder([card(html, under)], FAB), html).toBe(true);
		}
	});

	it("only what a tap acts on: not a time stamp, a preview, a disabled button or a bare link", () => {
		for (const html of [
			'<span tabindex="0">2h ago</span>',
			'<section tabindex="0">preview</section>',
			"<button disabled>Ask</button>",
			"<a>no href</a>",
			'<input type="hidden">',
		]) {
			expect(controlUnder([card(html, under)], FAB), html).toBe(false);
		}
	});

	it("a control beside the button, or a card that doesn't reach it, doesn't", () => {
		// Left of it, on its row (a composer's Cancel).
		expect(
			controlUnder(
				[card("<button>Cancel</button>", rect(16, 740, 80, 40))],
				FAB,
			),
		).toBe(false);
		// Just above, past the 4px slack.
		expect(
			controlUnder([card("<button>Ask</button>", rect(300, 690, 40, 40))], FAB),
		).toBe(false);
		// Within the slack: under.
		expect(
			controlUnder([card("<button>Ask</button>", rect(300, 694, 40, 40))], FAB),
		).toBe(true);
		// The card ends above the button: its controls aren't even read.
		const high = card("<button>Ask</button>", under, rect(0, 100, 360, 200));
		const read = vi.spyOn(high, "querySelectorAll");
		expect(controlUnder([high], FAB)).toBe(false);
		expect(read).not.toHaveBeenCalled();
	});
});

/** A diff of `lines` rows, each with three gutter buttons, outside any card. */
function diffLines(lines: number) {
	const table = document.createElement("table");
	const body = document.createElement("tbody");
	for (let i = 0; i < lines; i++) {
		const tr = document.createElement("tr");
		tr.innerHTML =
			"<td><button>+</button><button>✓</button></td><td><code>const x = 1;</code></td><td><button>…</button></td>";
		body.append(tr);
	}
	table.append(body);
	document.body.append(table);
	return body;
}

/** Five registered cards with five controls each, the last under the button. */
function Cards() {
	const ref = useFloatClearCard();
	return (
		<>
			{[0, 1, 2, 3, 4].map((i) => (
				<div key={i} ref={ref} data-card={i}>
					<button type="button">Reply</button>
					<a href="#a">the PR</a>
					<textarea />
					<button type="button">Resolve</button>
					<button type="button" data-last={i === 4 || undefined}>
						Comment instead
					</button>
				</div>
			))}
		</>
	);
}

function placeCards() {
	for (const el of document.querySelectorAll("[data-card]")) {
		place(el, rect(0, 600, 360, 200));
	}
	const last = document.querySelector("[data-last]");
	if (last) place(last, rect(300, 740, 40, 40));
}

describe("watchFloat", () => {
	function setUp(lines: number) {
		document.body.innerHTML = "";
		const fab = place(document.createElement("button"), FAB) as HTMLElement;
		document.body.append(fab);
		const rows = diffLines(lines);
		const page = render(<Cards />);
		placeCards();
		const reports: boolean[] = [];
		const stop = watchFloat(fab, (u) => reports.push(u));
		return { fab, rows, page, reports, stop };
	}

	it("tells before the first paint, then on a scroll, whether a card's control is under it", () => {
		const { reports, stop } = setUp(10);
		// Right away, not a frame later: no flash over the control.
		expect(reports).toEqual([true]);
		const last = document.querySelector("[data-last]");
		if (last) place(last, rect(300, 400, 40, 40));
		window.dispatchEvent(new Event("scroll"));
		flush();
		expect(reports.at(-1)).toBe(false);
		stop();
	});

	it("a change outside the cards (a diff line, a toast) never makes it look", async () => {
		const { rows, page, stop } = setUp(10);
		flush();
		rows.append(document.createElement("tr"));
		document.body.append(document.createElement("div"));
		await Promise.resolve();
		expect(frames).toHaveLength(0);
		// A card's own change does.
		const one = page.container.querySelector("[data-card]");
		one?.append(document.createElement("button"));
		await Promise.resolve();
		expect(frames).toHaveLength(1);
		stop();
	});

	it("a card that goes is no longer watched", async () => {
		const { page, reports, stop } = setUp(10);
		flush();
		expect(reports.at(-1)).toBe(true);
		page.unmount();
		flush();
		expect(reports.at(-1)).toBe(false);
		stop();
	});

	it("a frame's look costs the same on a diff 4x as long (CPU, the cards alike)", () => {
		// What a scroll frame does: the scroll's event, then the frame's look.
		// Each page's frame against the same reference (a look at five
		// detached cards): a query of the whole page grows with the diff's
		// lines (about 4x here), a look at the cards alone doesn't (about 1x).
		const detached = [0, 1, 2, 3, 4].map(() => {
			const el = document.createElement("div");
			el.innerHTML =
				"<button>a</button><a href='#'>b</a><textarea></textarea><button>c</button><button>d</button>";
			rects.set(el, rect(0, 600, 360, 200));
			return el;
		});
		const reference = () => {
			controlUnder(detached, FAB);
		};
		const frame = () => {
			window.dispatchEvent(new Event("scroll"));
			flush();
		};
		const perPage = (lines: number) => {
			const { stop } = setUp(lines);
			const r = bestCpuRatio(frame, reference).ratio;
			stop();
			cleanup();
			return r;
		};
		const small = perPage(1000);
		const big = perPage(4000);
		expect(big / small).toBeLessThan(2);
	});
});

const client = new QueryClient();

function Page(props: { under: boolean }) {
	const ref = useFloatClearCard();
	return (
		<>
			<div ref={ref} data-card="">
				<button type="button" data-last={props.under || undefined}>
					Comment instead
				</button>
			</div>
			<QueryClientProvider client={client}>
				<FilesFab onOpen={() => {}} />
			</QueryClientProvider>
		</>
	);
}

describe("FilesFab", () => {
	it("steps aside while a card's control is under it, kept in place (only invisible)", () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				if (this.getAttribute("aria-label") === "Files") return FAB;
				if (this.hasAttribute("data-card")) return rect(0, 600, 360, 200);
				if (this.hasAttribute("data-last")) return rect(300, 740, 40, 40);
				return NOWHERE;
			},
		);
		const { rerender } = render(<Page under />);
		const fab = screen.getByText("Files").closest("button");
		expect(fab).toHaveClass("invisible");
		expect(fab).toHaveAttribute("data-fab-hidden", "card");
		rerender(<Page under={false} />);
		act(() => flush());
		expect(fab).not.toHaveClass("invisible");
	});
});
