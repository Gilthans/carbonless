// @vitest-environment jsdom

import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
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
let setVacant: (vacant: boolean) => void = () => {};

function Line({ initial }: { initial: boolean }) {
	const [shown, set] = useState(initial);
	const [vacant, setV] = useState(true);
	setShown = set;
	setVacant = setV;
	const slot = useKeptSlot<HTMLParagraphElement>(shown, vacant);
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
			<button type="button" data-testid="press">
				Approve
			</button>
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

	it("a touch scroll or a scroll key lets it go too; a tap, a click, typing in a field or a key on a button doesn't", async () => {
		await shownThenGone();
		act(() => {
			fireEvent.pointerDown(document.body);
			fireEvent.click(document.body);
			fireEvent.keyDown(screen.getByTestId("box"), { key: "PageDown" });
			fireEvent.keyDown(screen.getByTestId("press"), { key: " " });
			fireEvent.keyDown(screen.getByTestId("press"), { key: "ArrowDown" });
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

	it("another line in its place (a since line, a comparing row) needs no room kept", async () => {
		render(inRouter(() => <Line initial />));
		await screen.findByTestId("line");
		act(() => {
			setVacant(false);
			setShown(false);
		});
		expect(screen.queryByTestId("kept")).toBeNull();
	});

	it("another page lets it go", async () => {
		const root = createRootRoute({
			component: () => (
				<>
					<Line initial />
					<Outlet />
				</>
			),
		});
		const page = (path: string) =>
			createRoute({ getParentRoute: () => root, path, component: () => null });
		const router = createRouter({
			routeTree: root.addChildren([page("/r/x/files"), page("/r/x/verdict")]),
			history: createMemoryHistory({ initialEntries: ["/r/x/files"] }),
			scrollRestoration: () => false,
		});
		const go = (to: string) =>
			act(async () => {
				router.history.push(to);
				await router.load();
			});
		render(<RouterProvider router={router} />);
		await screen.findByTestId("line");
		act(() => setShown(false));
		expect(screen.getByTestId("kept")).toBeTruthy();
		// The same page's address changing (a comparison landing) holds on.
		await go("/r/x/files?head=abc");
		expect(screen.getByTestId("kept")).toBeTruthy();
		await go("/r/x/verdict");
		expect(screen.queryByTestId("kept")).toBeNull();
	});
});
