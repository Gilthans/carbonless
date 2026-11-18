// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickQuestionChips } from "./QuickQuestionChips";

const SHORT = "Why this change?";
const LONG =
	"Please confirm all comments I wrote have been addressed and highlight those that haven't";

// jsdom has no layout: a chip's text is 6px a character on a line `width`
// wide, and a resize tells every observer.
let width = 200;
const observers = new Set<() => void>();
function resize(to: number) {
	width = to;
	act(() => {
		for (const cb of observers) cb();
	});
}

beforeEach(() => {
	width = 200;
	vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
		function (this: HTMLElement) {
			return (this.textContent ?? "").length * 6;
		},
	);
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
		function (this: HTMLElement) {
			return Math.min(width, (this.textContent ?? "").length * 6);
		},
	);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			cb: () => void;
			constructor(cb: () => void) {
				this.cb = cb;
			}
			observe() {
				observers.add(this.cb);
			}
			disconnect() {
				observers.delete(this.cb);
			}
		},
	);
});

afterEach(() => {
	cleanup();
	observers.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function show() {
	const onPick = vi.fn();
	render(<QuickQuestionChips questions={[SHORT, LONG]} onPick={onPick} />);
	return { onPick, user: userEvent.setup() };
}
const chip = (q: string) =>
	screen
		.getAllByTestId("agent-quick-question")
		.find((b) => b.textContent === q) as HTMLElement;
const item = (q: string) => chip(q).closest("li") as HTMLElement;
const more = (q: string) =>
	within(item(q)).queryByRole("button", { name: /Show (more|less)/ });

describe("long question chips (CAR-203 follow-up)", () => {
	it("a long chip is one line with an ellipsis and Show more; a short one has neither", () => {
		show();
		const longText = within(chip(LONG)).getByTestId(
			"agent-quick-question-text",
		);
		expect(longText).toHaveClass("truncate");
		const toggle = more(LONG);
		expect(toggle).toHaveAccessibleName("Show more");
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(more(SHORT)).toBeNull();
	});

	it("the chip's name is the whole question, cut or not", () => {
		show();
		expect(more(LONG)).not.toBeNull();
		expect(screen.getByRole("button", { name: LONG })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: SHORT })).toBeInTheDocument();
	});

	it("Show more unfolds without picking, keeps focus where it was, then Show less folds", async () => {
		const { onPick, user } = show();
		const toggle = more(LONG) as HTMLElement;
		const down = fireEvent.mouseDown(toggle);
		// preventDefault: the Ask box keeps focus.
		expect(down).toBe(false);
		await user.click(toggle);
		expect(onPick).not.toHaveBeenCalled();
		expect(toggle).toHaveAccessibleName("Show less");
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(
			within(chip(LONG)).getByTestId("agent-quick-question-text"),
		).not.toHaveClass("truncate");
		await user.click(toggle);
		expect(onPick).not.toHaveBeenCalled();
		expect(more(LONG)).toHaveAccessibleName("Show more");
		expect(
			within(chip(LONG)).getByTestId("agent-quick-question-text"),
		).toHaveClass("truncate");
	});

	it("tapping a cut chip picks the whole question", async () => {
		const { onPick, user } = show();
		expect(more(LONG)).not.toBeNull();
		await user.click(chip(LONG));
		expect(onPick).toHaveBeenCalledExactlyOnceWith(LONG);
	});

	it("is measured again on a resize: cut on a phone, whole on a desktop", () => {
		show();
		expect(more(LONG)).not.toBeNull();
		resize(2000);
		expect(more(LONG)).toBeNull();
		resize(200);
		expect(more(LONG)).not.toBeNull();
	});
});
