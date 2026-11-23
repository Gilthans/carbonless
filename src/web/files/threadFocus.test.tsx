// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { type ReactNode, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestConversationOpen } from "../agent/conversationLinks";
import { PageActive } from "../pageActive";
import {
	keepInPlace,
	threadFocus,
	useFocusAmong,
	useFocusCard,
	useFocusWhere,
	useOutlinedMessage,
} from "./threadFocus";

function Card(props: {
	id: string;
	onOpen?: () => void;
	children?: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	useFocusCard(props.id, ref, props.onOpen);
	return (
		<div ref={ref} data-card={props.id}>
			{props.children}
		</div>
	);
}

function Holder(props: { ids: string[]; onOpen: (id: string) => void }) {
	useFocusAmong(
		(id) => props.ids.includes(id),
		(f) => props.onOpen(f.id),
	);
	return null;
}

let scrollTo: ReturnType<typeof vi.fn>;
beforeEach(() => {
	threadFocus.reset();
	// Drawn: jsdom lays nothing out.
	vi.spyOn(Element.prototype, "getClientRects").mockImplementation(
		() => [{}] as unknown as DOMRectList,
	);
	// Frames at once.
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		cb(0);
		return 0;
	});
	scrollTo = vi.fn();
	vi.stubGlobal("scrollTo", scrollTo);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	threadFocus.reset();
});

describe("threadFocus", () => {
	it("a card asked for opens, scrolls in once, and ends the request", () => {
		const onOpen = vi.fn();
		render(<Card id="T1" onOpen={onOpen} />);
		act(() => {
			threadFocus.request({ id: "T1" });
		});
		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(scrollTo).toHaveBeenCalledTimes(1);
		expect(threadFocus.get()).toBeNull();
	});

	it("a card mounted later takes the request then", () => {
		act(() => {
			threadFocus.request({ id: "T1" });
		});
		const onOpen = vi.fn();
		render(<Card id="T1" onOpen={onOpen} />);
		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(scrollTo).toHaveBeenCalledTimes(1);
	});

	it("a request cancelled (the reviewer went elsewhere) opens and scrolls nothing later", () => {
		act(() => {
			threadFocus.request({ id: "T1" });
			threadFocus.cancel();
		});
		const onOpen = vi.fn();
		render(<Card id="T1" onOpen={onOpen} />);
		expect(onOpen).not.toHaveBeenCalled();
		expect(scrollTo).not.toHaveBeenCalled();
	});

	it("a newer request replaces an older one", () => {
		act(() => {
			threadFocus.request({ id: "T1" });
			threadFocus.request({ id: "T2" });
		});
		const one = vi.fn();
		const two = vi.fn();
		render(
			<>
				<Card id="T1" onOpen={one} />
				<Card id="T2" onOpen={two} />
			</>,
		);
		expect(one).not.toHaveBeenCalled();
		expect(two).toHaveBeenCalledTimes(1);
	});

	it("a hidden copy (an inert kept page) neither opens nor takes the request; the shown one does", () => {
		const hidden = vi.fn();
		const shown = vi.fn();
		render(
			<>
				<div inert>
					<Card id="T1" onOpen={hidden} />
				</div>
				<Card id="T1" onOpen={shown} />
			</>,
		);
		act(() => {
			threadFocus.request({ id: "T1" });
		});
		expect(hidden).not.toHaveBeenCalled();
		expect(shown).toHaveBeenCalledTimes(1);
		expect(scrollTo).toHaveBeenCalledTimes(1);
		expect(threadFocus.get()).toBeNull();
	});

	it("a card on a page that isn't showing waits", () => {
		const onOpen = vi.fn();
		const { rerender } = render(
			<PageActive value={false}>
				<Card id="T1" onOpen={onOpen} />
			</PageActive>,
		);
		act(() => {
			threadFocus.request({ id: "T1" });
		});
		expect(onOpen).not.toHaveBeenCalled();
		expect(threadFocus.get()).not.toBeNull();
		rerender(
			<PageActive value={true}>
				<Card id="T1" onOpen={onOpen} />
			</PageActive>,
		);
		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it("nested copies (a shell and its card) scroll once", () => {
		render(
			<Card id="T1">
				<Card id="T1" />
			</Card>,
		);
		act(() => {
			threadFocus.request({ id: "T1" });
		});
		expect(scrollTo).toHaveBeenCalledTimes(1);
	});

	it("a container opens for a request that names one of its threads, once", () => {
		const onOpen = vi.fn();
		const { rerender } = render(<Holder ids={["A", "B"]} onOpen={onOpen} />);
		act(() => {
			threadFocus.request({ id: "C" });
		});
		expect(onOpen).not.toHaveBeenCalled();
		act(() => {
			threadFocus.request({ id: "B" });
		});
		rerender(<Holder ids={["A", "B"]} onOpen={onOpen} />);
		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(onOpen).toHaveBeenCalledWith("B");
	});

	it("a link to a conversation goes through the same request: its card takes it, a hidden copy doesn't", () => {
		const A = "01k9e6m2q8x4v7c3n5b0h1j2aa";
		const hidden = vi.fn();
		const shown = vi.fn();
		render(
			<>
				<div hidden>
					<Card id={A} onOpen={hidden} />
				</div>
				<Card id={A} onOpen={shown} />
			</>,
		);
		act(() => requestConversationOpen(A));
		expect(hidden).not.toHaveBeenCalled();
		expect(shown).toHaveBeenCalledTimes(1);
		expect(scrollTo).toHaveBeenCalledTimes(1);
		expect(threadFocus.get()).toBeNull();
	});

	it("a link to a conversation on a review thread: that thread's card, its panel opens", () => {
		const A = "01k9e6m2q8x4v7c3n5b0h1j2aa";
		const panel = vi.fn();
		function Panel() {
			useFocusWhere((f) => f.conversation === A, panel);
			return null;
		}
		const card = vi.fn();
		render(
			<>
				<Card id="RT1" onOpen={card} />
				<Panel />
			</>,
		);
		act(() => requestConversationOpen(A, undefined, "RT1"));
		expect(card).toHaveBeenCalledTimes(1);
		expect(panel).toHaveBeenCalledTimes(1);
	});

	it("the message a link names is outlined once its card took it, once", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const A = "01k9e6m2q8x4v7c3n5b0h1j2aa";
			const M = "01k9e6m2q8x4v7c3n5b0h1j2mm";
			function Messages() {
				return <p data-lit={useOutlinedMessage([{ id: M }]) ?? ""} />;
			}
			const { container, rerender } = render(
				<>
					<Card id={A} />
					<Messages />
				</>,
			);
			act(() => requestConversationOpen(A, M));
			const lit = () => container.querySelector("p")?.dataset.lit;
			expect(lit()).toBe(M);
			act(() => vi.advanceTimersByTime(2000));
			expect(lit()).toBe("");
			// A later mount doesn't light it again.
			rerender(
				<>
					<Card id={A} />
					<Messages key="again" />
				</>,
			);
			expect(lit()).toBe("");
		} finally {
			vi.useRealTimers();
		}
	});

	it("a request is dropped once the reviewer moves to another page", () => {
		window.history.replaceState(null, "", "/r/RV1/files");
		try {
			act(() => {
				threadFocus.request({ id: "T1" });
			});
			window.history.pushState(null, "", "/r/RV1");
			const onOpen = vi.fn();
			render(<Card id="T1" onOpen={onOpen} />);
			expect(onOpen).not.toHaveBeenCalled();
		} finally {
			window.history.replaceState(null, "", "/");
		}
	});

	it("a row's request in another comparison is dropped; a link's waits", () => {
		act(() => {
			threadFocus.request({ id: "T1", scope: "ps1" });
		});
		threadFocus.cancelOutside("ps1");
		expect(threadFocus.get()?.id).toBe("T1");
		threadFocus.cancelOutside("ps2");
		expect(threadFocus.get()).toBeNull();
		act(() => requestConversationOpen("01k9e6m2q8x4v7c3n5b0h1j2aa"));
		threadFocus.cancelOutside("ps3");
		expect(threadFocus.get()).not.toBeNull();
	});

	it("a card waits for the conversation it's asked to open: taken once it is known (a cold link)", () => {
		const A = "01k9e6m2q8x4v7c3n5b0h1j2aa";
		const panel = vi.fn();
		const took = vi.fn();
		function ThreadCard(props: { conversation?: string }) {
			const ref = useRef<HTMLDivElement>(null);
			useFocusCard("RT1", ref, took, {
				ready: (f) => !f.conversation || props.conversation === f.conversation,
			});
			useFocusWhere(
				(f) =>
					props.conversation !== undefined &&
					f.conversation === props.conversation,
				panel,
			);
			return <div ref={ref} />;
		}
		const { rerender } = render(<ThreadCard />);
		act(() => requestConversationOpen(A, undefined, "RT1"));
		// The agent threads not in yet: nothing takes it, it waits.
		expect(took).not.toHaveBeenCalled();
		expect(threadFocus.get()?.conversation).toBe(A);
		rerender(<ThreadCard conversation={A} />);
		expect(took).toHaveBeenCalledTimes(1);
		expect(panel).toHaveBeenCalledTimes(1);
		expect(threadFocus.get()).toBeNull();
	});

	it("with a message named, the message is centred, not the card's top scrolled under the stack", () => {
		const A = "01k9e6m2q8x4v7c3n5b0h1j2aa";
		const M = "01k9e6m2q8x4v7c3n5b0h1j2mm";
		const centred = vi.fn();
		function WithMessage() {
			const ref = useRef<HTMLDivElement>(null);
			useFocusCard(A, ref);
			return (
				<div ref={ref}>
					<p data-message-id={M} />
				</div>
			);
		}
		render(<WithMessage />);
		const msg = document.querySelector(`[data-message-id="${M}"]`);
		if (!msg) throw new Error("no message");
		msg.scrollIntoView = centred;
		act(() => requestConversationOpen(A, M));
		expect(centred).toHaveBeenCalledWith({ block: "center" });
		expect(scrollTo).not.toHaveBeenCalled();
	});

	it("an outline nobody showed is gone after a cancel, a newer request, or its moment", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		try {
			const A = "01k9e6m2q8x4v7c3n5b0h1j2aa";
			const M = "01k9e6m2q8x4v7c3n5b0h1j2mm";
			function Messages() {
				return <p data-lit={useOutlinedMessage([{ id: M }]) ?? ""} />;
			}
			const lit = (c: HTMLElement) => c.querySelector("p")?.dataset.lit;
			// Taken (its card), no messages shown, then a cancel: the panel
			// opened by hand later outlines nothing.
			const card = render(<Card id={A} />);
			act(() => requestConversationOpen(A, M));
			act(() => threadFocus.cancel());
			const one = render(<Messages />);
			expect(lit(one.container)).toBe("");
			one.unmount();
			// Taken again, then a newer request.
			act(() => requestConversationOpen(A, M));
			act(() => {
				threadFocus.request({ id: "other" });
			});
			const two = render(<Messages />);
			expect(lit(two.container)).toBe("");
			two.unmount();
			act(() => threadFocus.cancel());
			// Taken, and its moment passed.
			act(() => requestConversationOpen(A, M));
			act(() => vi.advanceTimersByTime(2001));
			const three = render(<Messages />);
			expect(lit(three.container)).toBe("");
			card.unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	it("a row's request is gone after a move to another page and back, with nothing reading it meanwhile", () => {
		window.history.replaceState(null, "", "/r/RV1/files");
		try {
			threadFocus.request({ id: "T1", scope: "ps1" });
			window.history.pushState(null, "", "/r/RV1");
			window.history.pushState(null, "", "/r/RV1/files");
			expect(threadFocus.get()).toBeNull();
			const onOpen = vi.fn();
			render(<Card id="T1" onOpen={onOpen} />);
			expect(onOpen).not.toHaveBeenCalled();
		} finally {
			window.history.replaceState(null, "", "/");
		}
	});

	it("the scroll's frames survive the re-render that taking the request causes", () => {
		const queue: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			queue.push(cb);
			return queue.length;
		});
		vi.stubGlobal("cancelAnimationFrame", (n: number) => {
			queue[n - 1] = () => {};
		});
		const flush = () => {
			for (const cb of queue.splice(0)) cb(0);
		};
		render(<Card id="T1" />);
		act(() => {
			threadFocus.request({ id: "T1" });
		});
		// Taken at once (the card re-rendered); the frames still to run.
		expect(threadFocus.get()).toBeNull();
		expect(scrollTo).not.toHaveBeenCalled();
		act(flush);
		act(flush);
		expect(scrollTo).toHaveBeenCalledTimes(1);
	});

	it("a card that moves right after taking the request (placed once the tracer answers): its new copy takes it", () => {
		const first = vi.fn();
		const moved = vi.fn();
		const { rerender } = render(<Card key="header" id="T1" onOpen={first} />);
		act(() => {
			threadFocus.request({ id: "T1" });
		});
		expect(first).toHaveBeenCalledTimes(1);
		rerender(<Card key="fates" id="T1" onOpen={moved} />);
		expect(moved).toHaveBeenCalledTimes(1);
		expect(scrollTo).toHaveBeenCalledTimes(2);
		expect(threadFocus.get()).toBeNull();
	});

	it("a card going after a cancel, or long after, brings nothing back", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		try {
			const one = render(<Card id="T1" />);
			act(() => {
				threadFocus.request({ id: "T1" });
			});
			act(() => threadFocus.cancel());
			one.unmount();
			expect(threadFocus.get()).toBeNull();
			const two = render(<Card id="T2" />);
			act(() => {
				threadFocus.request({ id: "T2" });
			});
			act(() => vi.advanceTimersByTime(5000));
			two.unmount();
			expect(threadFocus.get()).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("a pick or a find step within the frames after a take: the card doesn't scroll", () => {
		const queue: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			queue.push(cb);
			return queue.length;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {});
		const flush = () => {
			for (const cb of queue.splice(0)) cb(0);
		};
		render(<Card id="T1" />);
		act(() => {
			threadFocus.request({ id: "T1" });
		});
		act(() => threadFocus.cancel());
		act(flush);
		act(flush);
		expect(scrollTo).not.toHaveBeenCalled();
	});

	describe("a card scrolled in stays where it landed as the page settles (CAR-239)", () => {
		/** The card's viewport top, as the test moves it. */
		let top = 8;
		let scrollBy: ReturnType<typeof vi.fn>;
		beforeEach(() => {
			top = 8;
			vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
				function (this: Element) {
					const t = this.hasAttribute("data-card") ? top : 0;
					return { top: t, bottom: t, left: 0, right: 0 } as DOMRect;
				},
			);
			scrollBy = vi.fn((_x: number, y: number) => {
				top -= y;
			});
			vi.stubGlobal("scrollBy", scrollBy);
		});
		/** Something above the card changes (the placements answer), moving it by `by`. */
		const shift = async (by: number) => {
			top += by;
			await act(async () => {
				document.body.append(document.createElement("p"));
				// The mutation observer's callback, then its frame.
				await Promise.resolve();
			});
		};

		it("content above it changing after the scroll: the page follows, the card stays", async () => {
			render(<Card id="T1" />);
			act(() => {
				threadFocus.request({ id: "T1" });
			});
			await shift(-183);
			expect(scrollBy).toHaveBeenCalledWith(0, -183);
			expect(top).toBe(8);
			await shift(40);
			expect(top).toBe(8);
		});

		it("once the reviewer acts (a wheel, a touch, a click, a key), it moves with the page", async () => {
			for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
				threadFocus.reset();
				const view = render(<Card id="T1" />);
				act(() => {
					threadFocus.request({ id: "T1" });
				});
				window.dispatchEvent(new Event(type));
				scrollBy.mockClear();
				await shift(-100);
				expect(scrollBy, type).not.toHaveBeenCalled();
				top = 8;
				view.unmount();
			}
		});

		it("a scroll it didn't make (the scrollbar, the page's code): it lets go", async () => {
			render(<Card id="T1" />);
			act(() => {
				threadFocus.request({ id: "T1" });
			});
			Object.defineProperty(window, "scrollY", {
				value: 300,
				configurable: true,
			});
			try {
				window.dispatchEvent(new Event("scroll"));
				await shift(-100);
				expect(scrollBy).not.toHaveBeenCalled();
			} finally {
				Object.defineProperty(window, "scrollY", {
					value: 0,
					configurable: true,
				});
			}
		});

		it("a newer request lets go of the card held", async () => {
			render(<Card id="T1" />);
			act(() => {
				threadFocus.request({ id: "T1" });
			});
			// For a card not drawn yet: nothing takes it, T1 is no longer asked for.
			act(() => {
				threadFocus.request({ id: "T2" });
			});
			await shift(-50);
			expect(scrollBy).not.toHaveBeenCalled();
		});

		it("a cancel lets go", async () => {
			render(<Card id="T1" />);
			act(() => {
				threadFocus.request({ id: "T1" });
			});
			act(() => threadFocus.cancel());
			await shift(-50);
			expect(scrollBy).not.toHaveBeenCalled();
		});

		it("the card unmounted lets go", async () => {
			const view = render(<Card id="T1" />);
			act(() => {
				threadFocus.request({ id: "T1" });
			});
			view.unmount();
			await shift(-50);
			expect(scrollBy).not.toHaveBeenCalled();
		});

		it("the card gone off screen (a hidden part) lets go", async () => {
			const view = render(
				<div data-testid="wrap">
					<Card id="T1" />
				</div>,
			);
			act(() => {
				threadFocus.request({ id: "T1" });
			});
			const wrap = view.getByTestId("wrap");
			await act(async () => {
				wrap.hidden = true;
				await Promise.resolve();
			});
			await shift(-50);
			expect(scrollBy).not.toHaveBeenCalled();
		});

		it("the browser's scroll anchoring is off while it holds, and back on after", () => {
			const root = document.documentElement;
			const view = render(<Card id="T1" />);
			act(() => {
				threadFocus.request({ id: "T1" });
			});
			expect(root.hasAttribute("data-focus-hold")).toBe(true);
			// A pending thread's landing has its own switch: neither clears the other.
			root.dataset.landing = "";
			act(() => threadFocus.cancel());
			expect(root.hasAttribute("data-focus-hold")).toBe(false);
			expect(root.hasAttribute("data-landing")).toBe(true);
			delete root.dataset.landing;
			view.unmount();
		});

		it("a scroll from elsewhere in the same frame as a change (one pending) still lets go", async () => {
			const queue: FrameRequestCallback[] = [];
			vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
				queue.push(cb);
				return queue.length;
			});
			vi.stubGlobal("cancelAnimationFrame", () => {});
			const flush = () => {
				for (const cb of queue.splice(0)) cb(0);
			};
			render(<Card id="T1" />);
			act(() => {
				threadFocus.request({ id: "T1" });
			});
			// The landing's two frames, then its first check.
			act(flush);
			act(flush);
			act(flush);
			// A change: its check waits for the next frame...
			await shift(-100);
			expect(queue.length).toBeGreaterThan(0);
			// ...and a scroll from elsewhere comes first (a scrollbar drag).
			Object.defineProperty(window, "scrollY", {
				value: 300,
				configurable: true,
			});
			try {
				window.dispatchEvent(new Event("scroll"));
				act(flush);
				expect(scrollBy).not.toHaveBeenCalled();
				expect(document.documentElement.hasAttribute("data-focus-hold")).toBe(
					false,
				);
			} finally {
				Object.defineProperty(window, "scrollY", {
					value: 0,
					configurable: true,
				});
			}
		});

		it("keepInPlace on its own: stop ends it", async () => {
			const el = document.createElement("div");
			el.setAttribute("data-card", "x");
			document.body.append(el);
			const stop = keepInPlace(el, () => true);
			await shift(-20);
			expect(scrollBy).toHaveBeenCalledTimes(1);
			stop();
			await shift(-20);
			expect(scrollBy).toHaveBeenCalledTimes(1);
			el.remove();
		});
	});
});
