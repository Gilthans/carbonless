// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings";
import { ShortcutsProvider } from "./shortcuts";
import { ignoreWhitespace, sideBySide } from "./viewSettings";

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

const open = () => {
	render(
		<ShortcutsProvider>
			<Settings />
		</ShortcutsProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
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
});

describe("Settings", () => {
	it("shows the shortcut key on the rows that have one, on a desktop", () => {
		open();
		expect(caps("Show hidden characters")).toEqual([]);
		expect(caps("Ignore whitespace")).toEqual(["w"]);
		expect(caps("Side by side")).toEqual(["s"]);
		// The switch is still named by its label alone.
		expect(
			screen.getByRole("switch", { name: "Side by side" }),
		).toHaveAttribute("aria-checked", "false");
	});

	it("shows no keys on a phone: there are no shortcuts there", () => {
		phone();
		open();
		expect(caps("Ignore whitespace")).toEqual([]);
		expect(caps("Side by side")).toEqual([]);
	});
});
