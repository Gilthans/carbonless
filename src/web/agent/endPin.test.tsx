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

/** Lays `el` out from `top` to `bottom` (px from the viewport's top). */
function rect(el: Element, top: number, bottom: number) {
	el.getBoundingClientRect = () =>
		({ top, bottom, height: bottom - top, left: 0, right: 100 }) as DOMRect;
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
	document.body.replaceChildren();
	globalThis.ResizeObserver = saved;
});

function setup(
	height: number,
	options: Parameters<typeof useEndPin>[2] = {},
	active = true,
) {
	const box = scrollBox(height);
	const content = document.createElement("div");
	document.body.append(box.el);
	box.el.append(content);
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
	return { box, content, hook, scroll };
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

	it("scrolled up, a change above what is read is made up for; one below moves nothing (CAR-316)", () => {
		const { box, content, scroll } = setup(1000);
		const above = document.createElement("div");
		const read = document.createElement("p");
		content.append(above, read);
		rect(box.el, 0, 100);
		rect(content, -300, 700);
		rect(above, -300, 30);
		rect(read, 30, 80);
		// Scrolled up: the paragraph across the middle (50) is what is read.
		scroll(300);
		// Something above it went: it moved 48px up, and is put back.
		rect(read, -18, 32);
		box.grow(952);
		resize();
		expect(box.el.scrollTop).toBe(252);
		// A change below it (it didn't move): nothing moves.
		rect(read, 30, 80);
		box.grow(1300);
		resize();
		expect(box.el.scrollTop).toBe(252);
	});

	it("a focused box whose top is scrolled out keeps its bottom (CAR-316)", () => {
		const { box, content, scroll } = setup(1000);
		const text = document.createElement("textarea");
		content.append(text);
		rect(box.el, 0, 100);
		rect(text, -40, 60);
		text.focus();
		scroll(300);
		// It grew 20px by its top (the other way would move its bottom).
		rect(text, -60, 60);
		resize();
		expect(box.el.scrollTop).toBe(300);
		rect(text, -60, 80);
		resize();
		expect(box.el.scrollTop).toBe(320);
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
