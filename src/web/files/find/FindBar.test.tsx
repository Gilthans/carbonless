// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutsProvider } from "../../shortcuts";
import { FindBar } from "./FindBar";

afterEach(cleanup);

function props(
	over: Partial<ComponentProps<typeof FindBar>> = {},
): ComponentProps<typeof FindBar> {
	return {
		term: "foo",
		onTerm: vi.fn(),
		count: { at: 3, of: 41 },
		searching: false,
		failed: 0,
		onRetry: vi.fn(),
		onNext: vi.fn(),
		onPrevious: vi.fn(),
		onClose: vi.fn(),
		focusSeq: 0,
		matchCase: false,
		onMatchCase: vi.fn(),
		...over,
	};
}

function bar(p: ComponentProps<typeof FindBar>) {
	return (
		<ShortcutsProvider>
			<FindBar {...p} />
		</ShortcutsProvider>
	);
}

const box = () => screen.getByTestId("find-box") as HTMLInputElement;

describe("FindBar", () => {
	it("shows the count, the spinner while searching, and 0 of 0", () => {
		const { rerender } = render(bar(props()));
		expect(screen.getByTestId("find-count")).toHaveTextContent(/3 of 41/);
		expect(screen.queryByRole("status")).toBeNull();
		rerender(bar(props({ searching: true })));
		expect(
			screen.getByRole("status", { name: "Searching files…" }),
		).toBeTruthy();
		rerender(bar(props({ count: { at: 0, of: 0 } })));
		expect(screen.getByTestId("find-count")).toHaveTextContent(/0 of 0/);
		expect(
			(
				screen.getByRole("button", {
					name: "Next (Enter)",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(
			(
				screen.getByRole("button", {
					name: "Previous (Shift+Enter)",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		rerender(bar(props({ count: null, searching: true })));
		expect(screen.getByTestId("find-count")).toBeEmptyDOMElement();
		expect(screen.queryByRole("status")).toBeNull();
		// Nothing found yet while files are still on their way: the spinner,
		// never "0 of 0" (principle 8).
		rerender(bar(props({ count: { at: 0, of: 0 }, searching: true })));
		expect(screen.getByTestId("find-count")).toBeEmptyDOMElement();
		expect(
			screen.getByRole("status", { name: "Searching files…" }),
		).toBeTruthy();
	});

	it("keeps the count's live region in place, so the first count is announced", () => {
		const { rerender } = render(bar(props({ count: null })));
		const region = screen.getByTestId("find-count");
		expect(region.getAttribute("aria-live")).toBe("polite");
		rerender(bar(props()));
		expect(screen.getByTestId("find-count")).toBe(region);
	});

	it("can be found by its search role", () => {
		render(bar(props()));
		expect(screen.getByRole("search", { name: "Find in PR" })).toBeTruthy();
	});

	it("marks its box for the sticky stack's focus rule (index.css)", () => {
		render(bar(props()));
		expect(box()).toHaveAttribute("data-find-box");
	});

	it("ignores Enter that confirms an IME composition", () => {
		const p = props();
		render(bar(p));
		fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
		fireEvent.keyDown(box(), { key: "Enter", keyCode: 229 });
		expect(p.onNext).not.toHaveBeenCalled();
		fireEvent.keyDown(box(), { key: "Enter" });
		expect(p.onNext).toHaveBeenCalledTimes(1);
	});

	it("shows the short count for a phone beside the long one", () => {
		render(bar(props()));
		expect(screen.getByTestId("find-count")).toHaveTextContent(/3\/41/);
	});

	it("types into the box", async () => {
		const onTerm = vi.fn();
		render(bar(props({ term: "", onTerm })));
		await userEvent.type(box(), "a");
		expect(onTerm).toHaveBeenCalledWith("a");
	});

	it("Enter steps next, Shift+Enter previous, Escape closes", async () => {
		const p = props();
		render(bar(p));
		await userEvent.click(box());
		await userEvent.keyboard("{Enter}");
		expect(p.onNext).toHaveBeenCalledTimes(1);
		await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
		expect(p.onPrevious).toHaveBeenCalledTimes(1);
		expect(p.onNext).toHaveBeenCalledTimes(1);
		await userEvent.keyboard("{Escape}");
		expect(p.onClose).toHaveBeenCalledTimes(1);
	});

	it("steps and closes from the buttons", async () => {
		const p = props();
		render(bar(p));
		await userEvent.click(screen.getByRole("button", { name: "Next (Enter)" }));
		await userEvent.click(
			screen.getByRole("button", { name: "Previous (Shift+Enter)" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "Close (Esc)" }));
		expect(p.onNext).toHaveBeenCalledTimes(1);
		expect(p.onPrevious).toHaveBeenCalledTimes(1);
		expect(p.onClose).toHaveBeenCalledTimes(1);
	});

	it("reports files that couldn't be searched with a Retry", async () => {
		const p = props({ failed: 2 });
		const { rerender } = render(bar(p));
		await userEvent.click(
			screen.getByRole("button", {
				name: "2 files couldn't be searched · Retry",
			}),
		);
		expect(p.onRetry).toHaveBeenCalledTimes(1);
		rerender(bar(props({ failed: 0 })));
		expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
		rerender(bar(props({ failed: 1 })));
		expect(
			screen.getByRole("button", {
				name: "1 file couldn't be searched · Retry",
			}),
		).toBeTruthy();
	});

	it("the Match case toggle is pressed when on and flips on click", async () => {
		const onMatchCase = vi.fn();
		const { rerender } = render(bar(props({ onMatchCase })));
		const toggle = screen.getByRole("button", { name: "Match case" });
		expect(toggle.getAttribute("aria-pressed")).toBe("false");
		await userEvent.click(toggle);
		expect(onMatchCase).toHaveBeenLastCalledWith(true);
		rerender(bar(props({ onMatchCase, matchCase: true })));
		expect(
			screen
				.getByRole("button", { name: "Match case" })
				.getAttribute("aria-pressed"),
		).toBe("true");
		await userEvent.click(screen.getByRole("button", { name: "Match case" }));
		expect(onMatchCase).toHaveBeenLastCalledWith(false);
	});

	it("takes focus and selects its text when focusSeq changes", () => {
		const { rerender } = render(bar(props({ term: "hello" })));
		expect(document.activeElement).not.toBe(box());
		rerender(bar(props({ term: "hello", focusSeq: 1 })));
		expect(document.activeElement).toBe(box());
		expect(box().selectionStart).toBe(0);
		expect(box().selectionEnd).toBe(5);
	});

	it("takes focus without scrolling the page (the box is always in the sticky bar)", () => {
		const focus = vi.spyOn(HTMLInputElement.prototype, "focus");
		try {
			const { rerender } = render(bar(props()));
			rerender(bar(props({ focusSeq: 1 })));
			expect(focus).toHaveBeenCalledWith({ preventScroll: true });
		} finally {
			focus.mockRestore();
		}
	});

	it("lists its keys in the shortcuts help under Files changed", async () => {
		render(bar(props()));
		await userEvent.keyboard("?");
		const help = screen.getByTestId("shortcuts-help");
		expect(help).toHaveTextContent("Next match");
		expect(help).toHaveTextContent("Previous match");
		expect(help).toHaveTextContent("Close Find in PR");
		expect(help).toHaveTextContent("Files changed");
	});
});
