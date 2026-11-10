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
	/**
	 * Reports what crosses the band its rootMargin's top sets (down to 300px),
	 * from the targets' boxes.
	 */
	measure() {
		const top = -Number.parseFloat(this.options.rootMargin ?? "0");
		const entries = this.targets.map((target) => {
			const r = target.getBoundingClientRect();
			return { target, isIntersecting: r.bottom > top && r.top < 300 };
		});
		act(() =>
			this.callback(
				entries as unknown as IntersectionObserverEntry[],
				this as unknown as IntersectionObserver,
			),
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
		const entries = this.targets.map((target) => ({
			target,
			isIntersecting: indexes.includes(
				Number((target as HTMLElement).dataset.fileIndex),
			),
		}));
		act(() =>
			this.callback(
				entries as unknown as IntersectionObserverEntry[],
				this as unknown as IntersectionObserver,
			),
		);
	}
}
const live = () => FakeObserver.all.filter((o) => o.connected);

let shown: number | null = null;
function Files({ active }: { active: boolean }) {
	const box = useRef<HTMLDivElement>(null);
	const [current] = useCurrentFile(box, "r1:3", 100, active);
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
});
