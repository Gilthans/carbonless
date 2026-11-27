// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { UIEvent } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAtEnd, useEndPin } from "./endPin";

/** A scroll box whose sizes the test sets; scrollTop clamps as a browser's does. */
function scrollBox(height: number, client = 100) {
	const el = document.createElement("div");
	const size = { height, client, top: 0 };
	const clamp = (v: number) =>
		Math.max(0, Math.min(v, size.height - size.client));
	Object.defineProperties(el, {
		scrollHeight: { get: () => size.height },
		clientHeight: { get: () => size.client },
		scrollTop: {
			get: () => size.top,
			set: (v: number) => {
				size.top = clamp(v);
			},
		},
	});
	return {
		el,
		size,
		/** The content's new height (the top clamped, as a shrink does). */
		grow(h: number) {
			size.height = h;
			size.top = clamp(size.top);
		},
	};
}

let observers: { cb: ResizeObserverCallback; on: boolean }[] = [];
const resize = () =>
	act(() => {
		for (const o of observers)
			if (o.on) o.cb([], o as unknown as ResizeObserver);
	});
const saved = globalThis.ResizeObserver;
beforeEach(() => {
	observers = [];
	globalThis.ResizeObserver = class {
		o: { cb: ResizeObserverCallback; on: boolean };
		constructor(cb: ResizeObserverCallback) {
			this.o = { cb, on: true };
			observers.push(this.o);
		}
		observe() {}
		unobserve() {}
		disconnect() {
			this.o.on = false;
		}
	} as unknown as typeof ResizeObserver;
});
afterEach(() => {
	cleanup();
	globalThis.ResizeObserver = saved;
});

function setup(
	height: number,
	options: Parameters<typeof useEndPin>[2] = {},
	active = true,
) {
	const box = scrollBox(height);
	const content = document.createElement("div");
	const refs = { box: { current: box.el }, content: { current: content } };
	const hook = renderHook(
		(p: { active: boolean }) =>
			useEndPin(refs.box, refs.content, { ...options, active: p.active }),
		{ initialProps: { active } },
	);
	const scroll = (top: number) => {
		box.el.scrollTop = top;
		act(() =>
			hook.result.current.onScroll({
				currentTarget: box.el,
			} as unknown as UIEvent<HTMLElement>),
		);
	};
	return { box, hook, scroll };
}

describe("useEndPin", () => {
	it("opens at the end and keeps there as the content grows", () => {
		const { box } = setup(500);
		expect(box.el.scrollTop).toBe(400);
		box.grow(700);
		resize();
		expect(box.el.scrollTop).toBe(600);
	});

	it("scrolled up, growth moves nothing; back at the end, it pins again", () => {
		const { box, scroll } = setup(500);
		scroll(150);
		box.grow(900);
		resize();
		expect(box.el.scrollTop).toBe(150);
		scroll(800);
		box.grow(1000);
		resize();
		expect(box.el.scrollTop).toBe(900);
	});

	it("its own pin's late scroll event doesn't read as leaving the end", () => {
		const { box, hook } = setup(500);
		// The content grew before the pin's scroll event came.
		box.grow(600);
		act(() =>
			hook.result.current.onScroll({
				currentTarget: box.el,
			} as unknown as UIEvent<HTMLElement>),
		);
		resize();
		expect(box.el.scrollTop).toBe(500);
	});

	it("moved by someone else as the content grew (a landing), it lets go", () => {
		const { box } = setup(500);
		box.el.scrollTop = 120;
		box.grow(550);
		resize();
		expect(box.el.scrollTop).toBe(120);
		box.grow(800);
		resize();
		expect(box.el.scrollTop).toBe(120);
	});

	it("a clamp from shrinking content pins again", () => {
		const { box } = setup(500);
		box.grow(300);
		resize();
		expect(box.el.scrollTop).toBe(200);
		box.grow(500);
		resize();
		expect(box.el.scrollTop).toBe(400);
	});

	it("leave() lets go; while held, reaching the end doesn't pin", () => {
		let held = true;
		const { box, hook, scroll } = setup(500, { held: () => held });
		act(() => hook.result.current.leave());
		box.grow(600);
		resize();
		expect(box.el.scrollTop).toBe(400);
		scroll(500);
		box.grow(700);
		resize();
		expect(box.el.scrollTop).toBe(500);
		held = false;
		scroll(600);
		box.grow(800);
		resize();
		expect(box.el.scrollTop).toBe(700);
	});

	it("starts once active, at the end", () => {
		const { box, hook } = setup(500, {}, false);
		expect(box.el.scrollTop).toBe(0);
		resize();
		expect(box.el.scrollTop).toBe(0);
		hook.rerender({ active: true });
		expect(box.el.scrollTop).toBe(400);
	});

	it("tells onChange of every resize and scroll", () => {
		let n = 0;
		const { scroll } = setup(500, { onChange: () => n++ });
		resize();
		const after = n;
		expect(after).toBeGreaterThan(0);
		scroll(10);
		expect(n).toBe(after + 1);
	});
});

describe("isAtEnd", () => {
	it("counts 2px of slack", () => {
		expect(
			isAtEnd({ scrollTop: 398, clientHeight: 100, scrollHeight: 500 }),
		).toBe(true);
		expect(
			isAtEnd({ scrollTop: 397, clientHeight: 100, scrollHeight: 500 }),
		).toBe(false);
	});
});
