// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { type ReactNode, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestConversationOpen } from "../agent/conversationLinks";
import { PageActive } from "../pageActive";
import {
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
});
