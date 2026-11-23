import { type RefObject, useEffect, useLayoutEffect, useState } from "react";

/**
 * Marks a card in the diff (TailRow: a thread, a composer, an agent card):
 * the phone's floating Files button makes way whenever one of its controls
 * passes under it, so no card's button is ever covered (CAR-248).
 */
const FLOAT_CLEAR = "data-float-clear";

/** What a tap can land on inside a marked card. */
const CONTROLS = `[${FLOAT_CLEAR}] :is(button, a[href], input, textarea, select, summary, [role="button"], [tabindex]:not([tabindex="-1"]))`;

/** A fixed element's place by its distances from the viewport's right and bottom edges (how it's positioned). */
export type Footprint = {
	right: number;
	bottom: number;
	width: number;
	height: number;
};

/** Counted as under the button this close to it, not only on it. */
const SLACK = 4;

/**
 * The IntersectionObserver root margin that shrinks the viewport to the
 * footprint (grown by SLACK): a control intersects it exactly when it is
 * under the button.
 */
export function rootMarginFor(f: Footprint, vw: number, vh: number): string {
	const top = vh - f.bottom - f.height - SLACK;
	const left = vw - f.right - f.width - SLACK;
	const right = f.right - SLACK;
	const bottom = f.bottom - SLACK;
	const px = (n: number) => (n > 0 ? `-${Math.round(n)}px` : "0px");
	return `${px(top)} ${px(right)} ${px(bottom)} ${px(left)}`;
}

/**
 * Whether a control of a marked card (FLOAT_CLEAR) on the page sits under
 * the fixed element `float`, while `on`. The whole body is watched, not the
 * diff's container: that mounts on its own schedule, and a card is only
 * ever in the diff. Its footprint is measured while it
 * shows and kept while it's hidden (it hides for this), so hiding never
 * changes the answer.
 */
export function useControlUnder(
	float: RefObject<HTMLElement | null>,
	on: boolean,
): boolean {
	const [footprint, setFootprint] = useState<Footprint | null>(null);
	const [view, setView] = useState(() => viewSize());
	const [under, setUnder] = useState(false);

	// Measured after every render while it shows (it can move: the drawer's
	// push); a new state only when it did.
	useLayoutEffect(() => {
		const el = float.current;
		if (!on || !el) return;
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) return;
		const next: Footprint = {
			right: Math.round(window.innerWidth - r.right),
			bottom: Math.round(window.innerHeight - r.bottom),
			width: Math.round(r.width),
			height: Math.round(r.height),
		};
		setFootprint((was) =>
			was &&
			was.right === next.right &&
			was.bottom === next.bottom &&
			was.width === next.width &&
			was.height === next.height
				? was
				: next,
		);
	});

	useEffect(() => {
		if (!on) return;
		const resized = () =>
			setView((was) => {
				const next = viewSize();
				return was.w === next.w && was.h === next.h ? was : next;
			});
		window.addEventListener("resize", resized);
		return () => window.removeEventListener("resize", resized);
	}, [on]);

	useEffect(() => {
		const root = document.body;
		if (!on || !footprint) {
			setUnder(false);
			return;
		}
		const hits = new Set<Element>();
		const observed = new Set<Element>();
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting) hits.add(e.target);
					else hits.delete(e.target);
				}
				setUnder(hits.size > 0);
			},
			{ rootMargin: rootMarginFor(footprint, view.w, view.h), threshold: 0 },
		);
		const sync = () => {
			const now = new Set(root.querySelectorAll(CONTROLS));
			for (const el of observed) {
				if (now.has(el)) continue;
				io.unobserve(el);
				observed.delete(el);
				hits.delete(el);
			}
			for (const el of now) {
				if (observed.has(el)) continue;
				io.observe(el);
				observed.add(el);
			}
			setUnder(hits.size > 0);
		};
		// Cards and their controls come and go (a composer opens, chips
		// show): synced once a frame at most.
		let frame = 0;
		const mo = new MutationObserver(() => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				sync();
			});
		});
		mo.observe(root, { childList: true, subtree: true });
		sync();
		return () => {
			cancelAnimationFrame(frame);
			mo.disconnect();
			io.disconnect();
		};
	}, [on, footprint, view]);

	return on && under;
}

const viewSize = () => ({
	w: typeof window === "undefined" ? 0 : window.innerWidth,
	h: typeof window === "undefined" ? 0 : window.innerHeight,
});
