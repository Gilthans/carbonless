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
		document.body.style.cursor = "";
		document.body.style.userSelect = "";
	});

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
		expect(document.body.style.userSelect).toBe("none");
		expect(document.body.style.cursor).toBe("col-resize");
		expect(handle).toHaveAttribute("data-dragging");
		fireEvent.pointerMove(handle, { pointerId: 7, clientX: 420 });
		expect(onWidth).toHaveBeenLastCalledWith(420);
		fireEvent.pointerMove(handle, { pointerId: 7, clientX: 250 });
		expect(onWidth).toHaveBeenLastCalledWith(250);
		fireEvent.pointerUp(handle, { pointerId: 7, clientX: 250 });
		expect(capture.release).toHaveBeenCalledWith(7);
		expect(document.body.style.userSelect).toBe("");
		expect(document.body.style.cursor).toBe("");
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
		expect(document.body.style.userSelect).toBe("");
		fireEvent.pointerMove(handle, { pointerId: 2, clientX: 400 });
		expect(onWidth).not.toHaveBeenCalled();
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
