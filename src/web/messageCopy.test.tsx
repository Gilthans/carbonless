// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	COPIED_MS,
	LONG_PRESS_MS,
	PRESS_SLOP,
	useLongPress,
} from "./longPress";
import { menuPlace, useMessageCopy } from "./messageCopy";

const copied = vi.hoisted(() => ({ ok: true, texts: [] as string[] }));
vi.mock("./copyText", () => ({
	copyText: async (text: string) => {
		copied.texts.push(text);
		return copied.ok;
	},
}));

function Pressable(props: { onPress: () => void }) {
	const press = useLongPress(props.onPress);
	return (
		<div data-testid="msg" {...press}>
			Hello <a href="#x">the docs</a> <button type="button">Resolve</button>
		</div>
	);
}

function Message(props: { text: string }) {
	const { press, menu } = useMessageCopy(props.text);
	return (
		<>
			<div data-testid="msg" {...press}>
				Rendered <b>text</b>
			</div>
			{menu}
		</>
	);
}

const down = (el: Element, init: Partial<PointerEventInit> = {}) =>
	fireEvent.pointerDown(el, {
		pointerType: "touch",
		pointerId: 1,
		clientX: 100,
		clientY: 200,
		...init,
	});

describe("useLongPress", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("fires once a finger rests LONG_PRESS_MS, not before", () => {
		const onPress = vi.fn();
		render(<Pressable onPress={onPress} />);
		down(screen.getByTestId("msg"));
		act(() => vi.advanceTimersByTime(LONG_PRESS_MS - 1));
		expect(onPress).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(1));
		expect(onPress).toHaveBeenCalledTimes(1);
		expect(onPress.mock.calls[0]?.[0]).toMatchObject({ x: 100, y: 200 });
	});

	it("a finger moving past the slop (a scroll, a drag) cancels it; within it, it holds", () => {
		const onPress = vi.fn();
		render(<Pressable onPress={onPress} />);
		const el = screen.getByTestId("msg");
		down(el);
		fireEvent.pointerMove(el, {
			pointerId: 1,
			clientX: 100 + PRESS_SLOP - 1,
			clientY: 200,
		});
		act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
		expect(onPress).toHaveBeenCalledTimes(1);

		down(el);
		fireEvent.pointerUp(el, { pointerId: 1 });
		down(el);
		fireEvent.pointerMove(el, {
			pointerId: 1,
			clientX: 100,
			clientY: 200 + PRESS_SLOP + 1,
		});
		act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2));
		expect(onPress).toHaveBeenCalledTimes(1);
	});

	it("lifting, a cancel (the browser took the scroll) or a second finger ends it", () => {
		const onPress = vi.fn();
		render(<Pressable onPress={onPress} />);
		const el = screen.getByTestId("msg");
		down(el);
		fireEvent.pointerUp(el, { pointerId: 1 });
		down(el);
		fireEvent.pointerCancel(el, { pointerId: 1 });
		down(el);
		down(el, { pointerId: 2 });
		act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2));
		expect(onPress).not.toHaveBeenCalled();
	});

	it("never from a mouse or a pen, nor on a link or a button inside", () => {
		const onPress = vi.fn();
		render(<Pressable onPress={onPress} />);
		down(screen.getByTestId("msg"), { pointerType: "mouse" });
		fireEvent.pointerUp(screen.getByTestId("msg"), { pointerId: 1 });
		down(screen.getByTestId("msg"), { pointerType: "pen" });
		fireEvent.pointerUp(screen.getByTestId("msg"), { pointerId: 1 });
		down(screen.getByRole("link"));
		fireEvent.pointerUp(screen.getByRole("link"), { pointerId: 1 });
		down(screen.getByRole("button"));
		act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2));
		expect(onPress).not.toHaveBeenCalled();
		// A right click (desktop's context menu) is left alone.
		const menu = fireEvent.contextMenu(screen.getByTestId("msg"));
		expect(menu).toBe(true);
	});

	it("the browser's own long press on the same press is cancelled, and opens it at once", () => {
		const onPress = vi.fn();
		render(<Pressable onPress={onPress} />);
		const el = screen.getByTestId("msg");
		down(el);
		// fireEvent returns false when the default was prevented.
		expect(fireEvent.contextMenu(el)).toBe(false);
		expect(onPress).toHaveBeenCalledTimes(1);
		act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2));
		expect(onPress).toHaveBeenCalledTimes(1);
		// The click the lifted finger sends goes nowhere.
		fireEvent.pointerUp(el, { pointerId: 1 });
		expect(fireEvent.click(el)).toBe(false);
		// The next one does.
		expect(fireEvent.click(el)).toBe(true);
	});

	it("a long press no click followed never eats the next tap on a link or a button inside", () => {
		const onPress = vi.fn();
		render(<Pressable onPress={onPress} />);
		const el = screen.getByTestId("msg");
		// As on a phone: a long press is never followed by a click.
		down(el);
		act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
		fireEvent.pointerUp(el, { pointerId: 1 });
		const link = screen.getByRole("link");
		down(link);
		fireEvent.pointerUp(link, { pointerId: 1 });
		expect(fireEvent.click(link)).toBe(true);
		// The same with a mouse click on a button.
		down(el);
		act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
		fireEvent.pointerUp(el, { pointerId: 1 });
		const button = screen.getByRole("button");
		down(button, { pointerType: "mouse" });
		expect(fireEvent.click(button)).toBe(true);
	});

	it("while a finger rests on it, the browser can't start its own selection or callout there; lifting, a cancel or a move puts them back", () => {
		render(<Pressable onPress={() => {}} />);
		const el = screen.getByTestId("msg");
		// index.css: [data-pressing] can't be selected, and has no callout.
		const armed = () => el.hasAttribute("data-pressing");
		down(el);
		expect(armed()).toBe(true);
		// Kept through the fire, until the finger lifts (iOS's own long
		// press comes after ours).
		act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
		expect(armed()).toBe(true);
		fireEvent.pointerUp(el, { pointerId: 1 });
		expect(armed()).toBe(false);
		down(el);
		fireEvent.pointerCancel(el, { pointerId: 1 });
		expect(armed()).toBe(false);
		down(el);
		fireEvent.pointerMove(el, { pointerId: 1, clientX: 140, clientY: 200 });
		expect(armed()).toBe(false);
		// A mouse arms nothing.
		down(el, { pointerType: "mouse" });
		expect(armed()).toBe(false);
	});

	it("leaves the press to the browser while text is selected in the message", () => {
		const onPress = vi.fn();
		render(<Pressable onPress={onPress} />);
		const el = screen.getByTestId("msg");
		document.getSelection()?.selectAllChildren(el);
		down(el);
		act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2));
		expect(onPress).not.toHaveBeenCalled();
		document.getSelection()?.removeAllRanges();
	});
});

describe("useMessageCopy", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		copied.ok = true;
		copied.texts = [];
	});
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		document.getSelection()?.removeAllRanges();
	});

	const open = () => {
		down(screen.getByTestId("msg"));
		act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
		fireEvent.pointerUp(screen.getByTestId("msg"), { pointerId: 1 });
		return screen.getByRole("menu", { name: "Message" });
	};

	it("Copy message copies the Markdown source, says Copied, then the menu goes", async () => {
		render(<Message text={"**source** with `code`"} />);
		open();
		await act(async () => {
			fireEvent.click(screen.getByRole("menuitem", { name: "Copy message" }));
		});
		expect(copied.texts).toEqual(["**source** with `code`"]);
		expect(screen.getByRole("menuitem", { name: "Copied" })).toBeTruthy();
		act(() => vi.advanceTimersByTime(COPIED_MS));
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("a refused copy says Copy failed, stays, and selects the message to copy by hand", async () => {
		copied.ok = false;
		render(<Message text="x" />);
		open();
		await act(async () => {
			fireEvent.click(screen.getByRole("menuitem", { name: "Copy message" }));
		});
		expect(screen.getByRole("menuitem", { name: "Copy failed" })).toBeTruthy();
		act(() => vi.advanceTimersByTime(COPIED_MS * 3));
		expect(screen.getByRole("menu")).toBeTruthy();
		expect(document.getSelection()?.toString()).toBe("Rendered text");
	});

	it("Select text selects the word under the finger, for the phone's own handles, and closes", () => {
		render(<Message text="x" />);
		const word = screen.getByText("text").firstChild as Text;
		const at = vi.fn(() => {
			const r = document.createRange();
			r.setStart(word, 2);
			return r;
		});
		Object.assign(document, { caretRangeFromPoint: at });
		try {
			open();
			fireEvent.click(screen.getByRole("menuitem", { name: "Select text" }));
			expect(at).toHaveBeenCalledWith(100, 200);
			expect(screen.queryByRole("menu")).toBeNull();
			expect(document.getSelection()?.toString()).toBe("text");
		} finally {
			Reflect.deleteProperty(document, "caretRangeFromPoint");
		}
	});

	it("Select text selects the whole message when no word is under the finger", () => {
		render(<Message text="x" />);
		open();
		fireEvent.click(screen.getByRole("menuitem", { name: "Select text" }));
		expect(document.getSelection()?.toString()).toBe("Rendered text");
	});

	it("gives the focus back to where it was (a reply being written) when it closes", () => {
		render(
			<>
				<textarea aria-label="Reply" />
				<Message text="x" />
			</>,
		);
		const box = screen.getByRole("textbox", { name: "Reply" });
		box.focus();
		open();
		expect(
			screen.getByRole("menuitem", { name: "Copy message" }),
		).toHaveFocus();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(box).toHaveFocus();
	});

	it("stays while content scrolls by itself (a growing answer re-pinned); a scroll by the reader closes it", () => {
		render(<Message text="x" />);
		open();
		fireEvent.scroll(window);
		expect(screen.getByRole("menu")).toBeTruthy();
		fireEvent.wheel(document.body);
		fireEvent.scroll(window);
		expect(screen.queryByRole("menu")).toBeNull();
		open();
		fireEvent.touchMove(document.body);
		fireEvent.scroll(window);
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("closes on Escape, a tap elsewhere and a scroll by the reader; a tap inside keeps it", () => {
		render(<Message text="x" />);
		open();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("menu")).toBeNull();
		const menu = open();
		fireEvent.pointerDown(menu);
		expect(screen.getByRole("menu")).toBeTruthy();
		fireEvent.pointerDown(document.body);
		expect(screen.queryByRole("menu")).toBeNull();
		open();
		fireEvent.keyDown(document, { key: "PageDown" });
		fireEvent.scroll(window);
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("an empty message opens nothing", () => {
		render(<Message text="" />);
		down(screen.getByTestId("msg"));
		act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
		expect(screen.queryByRole("menu")).toBeNull();
	});
});

describe("menuPlace", () => {
	const screenSize = { w: 360, h: 640 };
	it("centres above the finger", () => {
		expect(
			menuPlace({ x: 180, y: 300 }, { w: 176, h: 88 }, screenSize),
		).toEqual({
			left: 92,
			top: 300 - 16 - 88,
		});
	});
	it("goes below near the top, and stays inside the screen's edges", () => {
		const p = menuPlace({ x: 350, y: 40 }, { w: 176, h: 88 }, screenSize);
		expect(p).toEqual({ left: 360 - 176 - 8, top: 40 + 32 });
		const q = menuPlace({ x: 2, y: 20 }, { w: 176, h: 88 }, screenSize);
		expect(q.left).toBe(8);
	});
});
