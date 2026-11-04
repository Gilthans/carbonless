// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TreeResizer } from "./TreeResizer";

describe("TreeResizer", () => {
	const capture = { set: vi.fn(), release: vi.fn() };
	beforeEach(() => {
		// jsdom has no pointer capture.
		HTMLElement.prototype.setPointerCapture = capture.set;
		HTMLElement.prototype.releasePointerCapture = capture.release;
		HTMLElement.prototype.hasPointerCapture = () => true;
	});
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		document.documentElement.removeAttribute("data-resizing");
	});
	const resizing = () => document.documentElement.hasAttribute("data-resizing");

	const setup = (width = 300) => {
		const onWidth = vi.fn();
		render(<TreeResizer width={width} min={160} max={640} onWidth={onWidth} />);
		return {
			onWidth,
			handle: screen.getByRole("separator", { name: "Resize file tree" }),
		};
	};

	it("is a focusable vertical separator that reports its width", () => {
		const { handle } = setup();
		expect(handle).toHaveAttribute("aria-orientation", "vertical");
		expect(handle).toHaveAttribute("aria-valuenow", "300");
		expect(handle).toHaveAttribute("aria-valuemin", "160");
		expect(handle).toHaveAttribute("aria-valuemax", "640");
		expect(handle).toHaveAttribute("tabindex", "0");
		expect(handle.textContent).toBe("");
		expect(handle.className).toContain("cursor-col-resize");
	});

	it("drags with the pointer: captures it, blocks selection, follows the x delta", () => {
		const { handle, onWidth } = setup();
		fireEvent.pointerDown(handle, { pointerId: 7, button: 0, clientX: 300 });
		expect(capture.set).toHaveBeenCalledWith(7);
		// html[data-resizing] (index.css): the resize cursor everywhere, no selection.
		expect(resizing()).toBe(true);
		expect(handle).toHaveAttribute("data-dragging");
		fireEvent.pointerMove(handle, { pointerId: 7, clientX: 420 });
		expect(onWidth).toHaveBeenLastCalledWith(420);
		fireEvent.pointerMove(handle, { pointerId: 7, clientX: 250 });
		expect(onWidth).toHaveBeenLastCalledWith(250);
		fireEvent.pointerUp(handle, { pointerId: 7, clientX: 250 });
		expect(capture.release).toHaveBeenCalledWith(7);
		expect(resizing()).toBe(false);
		expect(handle).not.toHaveAttribute("data-dragging");
		// A move after release does nothing.
		fireEvent.pointerMove(handle, { pointerId: 7, clientX: 500 });
		expect(onWidth).toHaveBeenCalledTimes(2);
	});

	it("ignores secondary buttons and ends a cancelled drag", () => {
		const { handle, onWidth } = setup();
		fireEvent.pointerDown(handle, { pointerId: 1, button: 2, clientX: 300 });
		expect(capture.set).not.toHaveBeenCalled();
		fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: 300 });
		fireEvent.pointerCancel(handle, { pointerId: 2 });
		expect(resizing()).toBe(false);
		fireEvent.pointerMove(handle, { pointerId: 2, clientX: 400 });
		expect(onWidth).not.toHaveBeenCalled();
	});

	it("forgets a drag whose capture was lost, and a fresh press starts a new one", () => {
		const { handle, onWidth } = setup();
		fireEvent.pointerDown(handle, { pointerId: 3, button: 0, clientX: 300 });
		expect(resizing()).toBe(true);
		// The window lost the pointer (a dialog, the node detached): no up, no cancel.
		fireEvent.lostPointerCapture(handle, { pointerId: 3 });
		expect(resizing()).toBe(false);
		expect(handle).not.toHaveAttribute("data-dragging");
		fireEvent.pointerMove(handle, { pointerId: 3, clientX: 400 });
		expect(onWidth).not.toHaveBeenCalled();
		// The next press drags again.
		fireEvent.pointerDown(handle, { pointerId: 4, button: 0, clientX: 300 });
		expect(capture.set).toHaveBeenLastCalledWith(4);
		expect(resizing()).toBe(true);
		fireEvent.pointerMove(handle, { pointerId: 4, clientX: 350 });
		expect(onWidth).toHaveBeenLastCalledWith(350);
		fireEvent.pointerUp(handle, { pointerId: 4, clientX: 350 });
		expect(resizing()).toBe(false);
	});

	it("resizes from the keyboard and resets on Enter or a double click", () => {
		const { handle, onWidth } = setup();
		handle.focus();
		fireEvent.keyDown(handle, { key: "ArrowLeft" });
		expect(onWidth).toHaveBeenLastCalledWith(284);
		fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
		expect(onWidth).toHaveBeenLastCalledWith(364);
		fireEvent.keyDown(handle, { key: "Home" });
		expect(onWidth).toHaveBeenLastCalledWith(160);
		fireEvent.keyDown(handle, { key: "End" });
		expect(onWidth).toHaveBeenLastCalledWith(640);
		fireEvent.keyDown(handle, { key: "Enter" });
		expect(onWidth).toHaveBeenLastCalledWith(288);
		// Keys it doesn't use pass through (Tab moves on).
		const tab = fireEvent.keyDown(handle, { key: "Tab" });
		expect(tab).toBe(true);
		expect(onWidth).toHaveBeenCalledTimes(5);
		fireEvent.doubleClick(handle);
		expect(onWidth).toHaveBeenLastCalledWith(288);
	});
});
