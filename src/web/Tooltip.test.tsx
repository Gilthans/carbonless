// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOVER_DELAY_MS, Tooltip } from "./Tooltip";

function setup(hoverDelay?: number) {
	render(
		<Tooltip content="Explains it" hoverDelay={hoverDelay}>
			{(trigger) => (
				<button type="button" {...trigger}>
					Go
				</button>
			)}
		</Tooltip>,
	);
	return { button: screen.getByRole("button", { name: "Go" }) };
}

describe("Tooltip", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("shows on hover only after a short delay, and hides at once on leave", () => {
		const { button } = setup();
		fireEvent.mouseEnter(button);
		expect(screen.queryByRole("tooltip")).toBeNull();
		act(() => vi.advanceTimersByTime(HOVER_DELAY_MS - 1));
		expect(screen.queryByRole("tooltip")).toBeNull();
		act(() => vi.advanceTimersByTime(1));
		expect(screen.getByRole("tooltip")).toHaveTextContent("Explains it");
		fireEvent.mouseLeave(button);
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("never shows when the pointer passes through", () => {
		const { button } = setup();
		fireEvent.mouseEnter(button);
		act(() => vi.advanceTimersByTime(HOVER_DELAY_MS - 50));
		fireEvent.mouseLeave(button);
		act(() => vi.advanceTimersByTime(1000));
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("shows at once on keyboard focus and closes on Escape", () => {
		const { button } = setup();
		act(() => button.focus());
		expect(button).toHaveFocus();
		expect(screen.getByRole("tooltip")).toHaveTextContent("Explains it");
		expect(button).toHaveAccessibleDescription("Explains it");
		fireEvent.keyDown(button, { key: "Escape" });
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("shows at once on a tap (focus), even while a hover delay is pending", () => {
		const { button } = setup();
		fireEvent.mouseEnter(button);
		act(() => vi.advanceTimersByTime(HOVER_DELAY_MS - 50));
		expect(screen.queryByRole("tooltip")).toBeNull();
		act(() => button.focus());
		expect(screen.getByRole("tooltip")).toBeInTheDocument();
	});

	it("takes a custom hover delay", () => {
		const { button } = setup(500);
		fireEvent.mouseEnter(button);
		act(() => vi.advanceTimersByTime(499));
		expect(screen.queryByRole("tooltip")).toBeNull();
		act(() => vi.advanceTimersByTime(1));
		expect(screen.getByRole("tooltip")).toBeInTheDocument();
	});
});
