// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visualTop } from "../sticky";
import { useCurrentFile } from "./FilesPage";

/** A stand-in IntersectionObserver the test drives by hand. */
class FakeObserver {
	static all: FakeObserver[] = [];
	targets: Element[] = [];
	connected = true;
	constructor(
		readonly callback: IntersectionObserverCallback,
		readonly options: IntersectionObserverInit = {},
	) {
		FakeObserver.all.push(this);
	}
	/** Each target's last reported state: like a real observer, only changes are reported. */
	reported = new Map<Element, boolean>();
	/** Calls back with the targets whose state changed (all on the first report). */
	deliver(entries: { target: Element; isIntersecting: boolean }[]) {
		const changed = entries.filter(
			(e) => this.reported.get(e.target) !== e.isIntersecting,
		);
		for (const e of changed) this.reported.set(e.target, e.isIntersecting);
		if (changed.length === 0) return;
		act(() =>
			this.callback(
				changed as unknown as IntersectionObserverEntry[],
				this as unknown as IntersectionObserver,
			),
		);
	}
	/**
	 * Reports what crosses the band its rootMargin's top sets (down to 300px),
	 * from the targets' boxes.
	 */
	measure() {
		const top = -Number.parseFloat(this.options.rootMargin ?? "0");
		this.deliver(
			this.targets.map((target) => {
				const r = target.getBoundingClientRect();
				return { target, isIntersecting: r.bottom > top && r.top < 300 };
			}),
		);
	}
	observe(el: Element) {
		this.targets.push(el);
	}
	disconnect() {
		this.connected = false;
	}
	/** Reports which file indexes cross the band now. */
	report(indexes: number[]) {
		this.deliver(
			this.targets.map((target) => ({
				target,
				isIntersecting: indexes.includes(
					Number((target as HTMLElement).dataset.fileIndex),
				),
			})),
		);
	}
}
const live = () => FakeObserver.all.filter((o) => o.connected);

let shown: number | null = null;
function Files({ active, top = 100 }: { active: boolean; top?: number }) {
	const box = useRef<HTMLDivElement>(null);
	const [current] = useCurrentFile(box, "r1:3", top, active);
	shown = current;
	return (
		<div ref={box}>
			{[0, 1, 2].map((i) => (
				<section key={i} data-file-index={i} />
			))}
		</div>
	);
}

describe("useCurrentFile", () => {
	beforeEach(() => {
		FakeObserver.all = [];
		vi.stubGlobal("IntersectionObserver", FakeObserver);
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("pauses while the page is hidden and follows the files again once shown", () => {
		const { rerender } = render(<Files active />);
		expect(live()).toHaveLength(1);
		live()[0]?.report([1, 2]);
		expect(shown).toBe(1);

		// Hidden: nothing observes; the file in view stays the one left on.
		const before = live()[0];
		rerender(<Files active={false} />);
		expect(live()).toHaveLength(0);
		before?.report([]);
		expect(shown).toBe(1);

		// Shown again: observed afresh, and the current file recomputed.
		rerender(<Files active />);
		expect(live()).toHaveLength(1);
		expect(live()[0]?.targets).toHaveLength(3);
		live()[0]?.report([2]);
		expect(shown).toBe(2);
	});

	it("counts the visual viewport's pan in the band's top: a pan moves the file in view on", () => {
		render(<Files active />);
		// File 0 ends 150px down, file 1 starts there.
		const boxes = [
			{ top: -500, bottom: 150 },
			{ top: 150, bottom: 900 },
			{ top: 900, bottom: 1500 },
		];
		for (const [i, box] of boxes.entries()) {
			const el = document.querySelector(`[data-file-index="${i}"]`);
			if (el) el.getBoundingClientRect = () => box as DOMRect;
		}
		live()[0]?.measure();
		expect(shown).toBe(0);
		// The keyboard pans the visual viewport 80px down: the stack sits lower.
		act(() => visualTop.set(80));
		expect(live()).toHaveLength(1);
		live()[0]?.measure();
		expect(shown).toBe(1);
		act(() => visualTop.set(0));
	});

	it("holds the file in view as the stack's height changes (the find bar opening or closing), and the next scroll picks it afresh, crossing or not", () => {
		let scrollY = 0;
		vi.spyOn(window, "scrollY", "get").mockImplementation(() => scrollY);
		/** A scroll by `by` px: the boxes move up, then the page's scroll event. */
		const scroll = (by: number) => {
			scrollY += by;
			for (const box of boxes) {
				box.top -= by;
				box.bottom -= by;
			}
			live()[0]?.measure();
			act(() => {
				window.dispatchEvent(new Event("scroll"));
			});
		};
		const { rerender } = render(<Files active />);
		// File 0 ends 150px down, file 1 runs on far below the band.
		const boxes = [
			{ top: -500, bottom: 150 },
			{ top: 150, bottom: 2900 },
			{ top: 2900, bottom: 3500 },
		];
		for (const i of boxes.keys()) {
			const el = document.querySelector(`[data-file-index="${i}"]`);
			if (el) el.getBoundingClientRect = () => boxes[i] as DOMRect;
		}
		live()[0]?.measure();
		expect(shown).toBe(0);

		// The bar opens: the stack grows 60px, over file 0's end, while the
		// page keeps the line being read in place (the boxes stay). The new
		// observer reports file 0 out of the band; it stays current.
		rerender(<Files active top={160} />);
		expect(live()).toHaveLength(1);
		live()[0]?.measure();
		expect(shown).toBe(0);
		// A scroll event at the same scroll (the compensation's) holds it.
		act(() => {
			window.dispatchEvent(new Event("scroll"));
		});
		expect(shown).toBe(0);
		// A real scroll that crosses nothing (file 1 stays in the band, file 0
		// out of it) picks file 1.
		scroll(10);
		expect(shown).toBe(1);

		// Scrolled back up until file 0's end shows under the open bar again.
		scroll(-40);
		expect(shown).toBe(0);
		scroll(25);
		expect(shown).toBe(1);
		// The bar closes: the stack shrinks back to 100px, uncovering file
		// 0's end (at 125px); file 1 stays current.
		rerender(<Files active top={100} />);
		live()[0]?.measure();
		expect(shown).toBe(1);
		// A small scroll up, crossing nothing (file 0 stays in the band),
		// picks file 0.
		scroll(-5);
		expect(shown).toBe(0);
	});
});
