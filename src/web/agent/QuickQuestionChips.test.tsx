// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickQuestionChips } from "./QuickQuestionChips";

const SHORT = "Why this change?";
const LONG =
	"Please confirm all comments I wrote have been addressed and highlight those that haven't";

// jsdom has no layout: the list is `rowHeight` a question tall, shows
// 112px of it, and a reflow tells every observer.
let rowHeight = 40;
const observers = new Set<() => void>();
function reflow(to: number) {
	rowHeight = to;
	act(() => {
		for (const cb of observers) cb();
	});
}

beforeEach(() => {
	rowHeight = 40;
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
		function (this: HTMLElement) {
			return this.querySelectorAll("li").length * rowHeight;
		},
	);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(112);
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

function show(questions: readonly string[] | null = [SHORT, LONG]) {
	const onPick = vi.fn();
	const r = render(
		<QuickQuestionChips questions={questions} onPick={onPick} />,
	);
	return { onPick, user: userEvent.setup(), rerender: r.rerender };
}
const list = () => screen.getByTestId("agent-quick-questions");

describe("question chips (CAR-203)", () => {
	it("every chip's name is its whole question, and there is no Show more", () => {
		show();
		expect(screen.getByRole("button", { name: LONG })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: SHORT })).toBeInTheDocument();
		expect(screen.getAllByTestId("agent-quick-question")).toHaveLength(2);
		expect(
			screen.queryByRole("button", { name: /Show (more|less)/ }),
		).toBeNull();
	});

	it("a tap picks the whole question; the box keeps focus", async () => {
		const { onPick, user } = show();
		const chip = screen.getByRole("button", { name: LONG });
		// preventDefault: the Ask box keeps focus.
		expect(fireEvent.mouseDown(chip)).toBe(false);
		await user.click(chip);
		expect(onPick).toHaveBeenCalledExactlyOnceWith(LONG);
	});

	it("the list is capped and scrolls", () => {
		show();
		expect(list()).toHaveClass(
			"max-h-28",
			"overflow-y-auto",
			"overscroll-contain",
		);
	});

	it("starts scrolled all the way down, and again when the questions change", () => {
		const { rerender, onPick } = show();
		expect(list().scrollTop).toBe(80);
		list().scrollTop = 0;
		// The same questions in a new array: the reader's scroll stays.
		rerender(<QuickQuestionChips questions={[SHORT, LONG]} onPick={onPick} />);
		expect(list().scrollTop).toBe(0);
		rerender(
			<QuickQuestionChips
				questions={[SHORT, LONG, "Third?"]}
				onPick={onPick}
			/>,
		);
		expect(list().scrollTop).toBe(120);
	});

	it("a reflow keeps a list at its bottom there (a rotation, the drawer's width)", () => {
		show([SHORT, LONG, "Third?"]);
		expect(list().scrollTop).toBe(120);
		reflow(60);
		expect(list().scrollTop).toBe(180);
	});

	it("a reflow never yanks a reader who scrolled up", () => {
		show([SHORT, LONG, "Third?"]);
		list().scrollTop = 0;
		fireEvent.scroll(list());
		reflow(60);
		expect(list().scrollTop).toBe(0);
		// Back at the bottom (within 2px): pinned again.
		list().scrollTop = 180 - 112 - 1;
		fireEvent.scroll(list());
		reflow(80);
		expect(list().scrollTop).toBe(240);
	});

	it("scrolls down when the questions arrive after loading", () => {
		const { rerender, onPick } = show(null);
		rerender(<QuickQuestionChips questions={[SHORT, LONG]} onPick={onPick} />);
		expect(list().scrollTop).toBe(80);
	});

	it("while loading: a spinner and capped skeletons, never an empty list", () => {
		show(null);
		const loading = screen.getByTestId("agent-quick-questions-loading");
		expect(loading).toHaveAttribute("aria-busy", "true");
		expect(loading).toHaveClass("max-h-28", "overflow-hidden");
		expect(
			screen.getByRole("status", { name: "Loading suggested questions" }),
		).toBeInTheDocument();
		expect(screen.queryByTestId("agent-quick-questions")).toBeNull();
		expect(screen.queryByTestId("agent-quick-question")).toBeNull();
	});
});
