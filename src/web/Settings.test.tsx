// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings";
import { ShortcutsProvider } from "./shortcuts";
import { ignoreWhitespace, showInvisibles, sideBySide } from "./viewSettings";

/** A phone: no media query matches. */
const phone = () =>
	vi.stubGlobal(
		"matchMedia",
		(query: string) =>
			({
				matches: false,
				media: query,
				addEventListener: () => {},
				removeEventListener: () => {},
			}) as unknown as MediaQueryList,
	);

/** The gear on a page at `/`, in a router with the Global settings page. */
const open = async (review = true) => {
	const root = createRootRoute({ component: Outlet });
	const router = createRouter({
		routeTree: root.addChildren([
			createRoute({
				getParentRoute: () => root,
				path: "/",
				component: () => (
					<ShortcutsProvider>
						<Settings review={review} />
					</ShortcutsProvider>
				),
			}),
			createRoute({
				getParentRoute: () => root,
				path: "/settings",
				component: () => <p>Global settings page</p>,
			}),
		]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
	return router;
};

const caps = (name: string) =>
	[...screen.getByRole("switch", { name }).querySelectorAll("kbd")].map(
		(k) => k.textContent,
	);

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
	ignoreWhitespace.reset();
	sideBySide.reset();
	showInvisibles.reset();
});

describe("Settings", () => {
	it("shows the shortcut key on the rows that have one, on a desktop", async () => {
		await open();
		expect(caps("Show hidden characters")).toEqual(["h"]);
		expect(caps("Ignore whitespace")).toEqual(["w"]);
		expect(caps("Side by side")).toEqual(["s"]);
		// The switch is still named by its label alone.
		expect(
			screen.getByRole("switch", { name: "Side by side" }),
		).toHaveAttribute("aria-checked", "false");
	});

	it("shows no keys on a phone: there are no shortcuts there", async () => {
		phone();
		await open();
		expect(caps("Show hidden characters")).toEqual([]);
		expect(caps("Ignore whitespace")).toEqual([]);
		expect(caps("Side by side")).toEqual([]);
	});

	it("on a review: the diff's switches, then Global settings, which goes to /settings", async () => {
		const router = await open();
		expect(screen.getAllByRole("switch")).toHaveLength(3);
		const link = screen.getByRole("link", { name: "Global settings" });
		expect(link).toHaveAttribute("href", "/settings");
		fireEvent.click(link);
		expect(await screen.findByText("Global settings page")).toBeTruthy();
		expect(router.state.location.pathname).toBe("/settings");
	});

	it("on Home: Global settings alone, no diff switches or shortcuts", async () => {
		await open(false);
		expect(screen.queryAllByRole("switch")).toHaveLength(0);
		expect(
			screen.queryByRole("button", { name: "Keyboard shortcuts" }),
		).toBeNull();
		const link = screen.getByRole("link", { name: "Global settings" });
		// Focus starts on it (the first row).
		expect(document.activeElement).toBe(link);
		fireEvent.click(link);
		expect(await screen.findByText("Global settings page")).toBeTruthy();
	});

	it("on a phone's sheet too", async () => {
		phone();
		await open(false);
		fireEvent.click(screen.getByRole("link", { name: "Global settings" }));
		expect(await screen.findByText("Global settings page")).toBeTruthy();
	});
});
