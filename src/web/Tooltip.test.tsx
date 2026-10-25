// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

describe("Tooltip dismissal and clicks", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	function Host(props: { onAction: () => void }) {
		const [disabled, setDisabled] = useState(false);
		return (
			<Tooltip content="Explains it">
				{(trigger) => (
					<button
						type="button"
						{...trigger}
						disabled={disabled}
						onClick={() => {
							props.onAction();
							setDisabled(true);
						}}
					>
						Go
					</button>
				)}
			</Tooltip>
		);
	}

	it("performs the action on the first click, with the tooltip open", async () => {
		const onAction = vi.fn();
		render(<Host onAction={onAction} />);
		const button = screen.getByRole("button", { name: "Go" });
		fireEvent.mouseEnter(button);
		act(() => vi.advanceTimersByTime(HOVER_DELAY_MS));
		expect(screen.getByRole("tooltip")).toBeInTheDocument();
		fireEvent.click(button);
		expect(onAction).toHaveBeenCalledTimes(1);
	});

	it("hides when the focused button becomes disabled", async () => {
		render(<Host onAction={() => {}} />);
		const button = screen.getByRole("button", { name: "Go" });
		act(() => button.focus());
		expect(screen.getByRole("tooltip")).toBeInTheDocument();
		fireEvent.click(button);
		// Mutation observers run as microtasks.
		await act(async () => {});
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("hides on mouse leave after a click, which focused the button", () => {
		render(<Host onAction={() => {}} />);
		const button = screen.getByRole("button", { name: "Go" });
		fireEvent.mouseEnter(button);
		fireEvent.mouseDown(button);
		act(() => button.focus()); // a click's focus is not :focus-visible
		expect(screen.getByRole("tooltip")).toBeInTheDocument();
		fireEvent.mouseLeave(button);
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("stays open on mouse leave while keyboard focus is on it", async () => {
		vi.useRealTimers();
		const user = userEvent.setup({ delay: null });
		render(<Host onAction={() => {}} />);
		const button = screen.getByRole("button", { name: "Go" });
		await user.tab();
		expect(button).toHaveFocus();
		fireEvent.mouseEnter(button);
		fireEvent.mouseLeave(button);
		expect(screen.getByRole("tooltip")).toBeInTheDocument();
	});

	it("closes on Escape after a hover-only open", () => {
		render(<Host onAction={() => {}} />);
		const button = screen.getByRole("button", { name: "Go" });
		fireEvent.mouseEnter(button);
		act(() => vi.advanceTimersByTime(HOVER_DELAY_MS));
		expect(screen.getByRole("tooltip")).toBeInTheDocument();
		expect(button).not.toHaveFocus();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("does nothing when unmounted with the hover delay pending", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const { unmount } = render(<Host onAction={() => {}} />);
		fireEvent.mouseEnter(screen.getByRole("button", { name: "Go" }));
		unmount();
		act(() => vi.advanceTimersByTime(1000));
		expect(document.querySelector("[role=tooltip]")).toBeNull();
		expect(errors).not.toHaveBeenCalled();
		errors.mockRestore();
	});
});
