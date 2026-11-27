// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inRouter } from "../../../test/in-router";
import { useKeptSlot } from "./keptSlot";

let setShown: (shown: boolean) => void = () => {};

function Line({ initial }: { initial: boolean }) {
	const [shown, set] = useState(initial);
	setShown = set;
	const slot = useKeptSlot<HTMLParagraphElement>(shown);
	return (
		<div>
			{shown && (
				<p ref={slot.ref} data-testid="line">
					On abc1234, an older commit
				</p>
			)}
			{!shown && slot.kept !== null && (
				<div data-testid="kept" style={{ height: slot.kept }} />
			)}
			<input data-testid="box" />
		</div>
	);
}

describe("useKeptSlot", () => {
	beforeEach(() => {
		// jsdom lays nothing out: the line is 24px tall.
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(24);
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	async function shownThenGone() {
		render(inRouter(() => <Line initial />));
		await screen.findByTestId("line");
		act(() => setShown(false));
		expect(screen.queryByTestId("line")).toBeNull();
		const kept = screen.getByTestId("kept");
		expect(kept.style.height).toBe("24px");
		return kept;
	}

	it("a line gone on its own keeps its room, empty, until the reader scrolls with the wheel", async () => {
		await shownThenGone();
		act(() => {
			fireEvent.wheel(window);
		});
		expect(screen.queryByTestId("kept")).toBeNull();
	});

	it("a touch scroll or a scroll key lets it go too; a tap, a click or typing in a field doesn't", async () => {
		await shownThenGone();
		act(() => {
			fireEvent.pointerDown(document.body);
			fireEvent.click(document.body);
			fireEvent.keyDown(screen.getByTestId("box"), { key: "PageDown" });
			fireEvent.keyDown(window, { key: "Enter" });
		});
		expect(screen.getByTestId("kept")).toBeTruthy();
		act(() => {
			fireEvent.touchMove(window);
		});
		expect(screen.queryByTestId("kept")).toBeNull();

		act(() => setShown(true));
		await screen.findByTestId("line");
		act(() => setShown(false));
		expect(screen.getByTestId("kept")).toBeTruthy();
		act(() => {
			fireEvent.keyDown(window, { key: "PageDown" });
		});
		expect(screen.queryByTestId("kept")).toBeNull();
	});

	it("a line that never showed keeps nothing; one back again needs no room", async () => {
		render(inRouter(() => <Line initial={false} />));
		await screen.findByTestId("box");
		expect(screen.queryByTestId("kept")).toBeNull();
		act(() => setShown(true));
		await screen.findByTestId("line");
		act(() => setShown(false));
		expect(screen.getByTestId("kept")).toBeTruthy();
		act(() => setShown(true));
		expect(screen.queryByTestId("kept")).toBeNull();
		expect(screen.getByTestId("line")).toBeTruthy();
	});
});
