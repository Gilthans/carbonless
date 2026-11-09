// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutsProvider } from "../shortcuts";
import { ignoreWhitespace, showInvisibles, sideBySide } from "../viewSettings";
import { useViewShortcuts, VIEW_KEYS } from "./viewShortcuts";

function Uses() {
	useViewShortcuts();
	return <input aria-label="field" />;
}

const press = (key: string, target: Element = document.body) =>
	fireEvent.keyDown(target, { key });

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

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
	ignoreWhitespace.reset();
	sideBySide.reset();
	showInvisibles.reset();
	window.history.replaceState(null, "", "/");
});

describe("useViewShortcuts", () => {
	it("w toggles Ignore whitespace and s toggles Side by side", () => {
		render(
			<ShortcutsProvider>
				<Uses />
			</ShortcutsProvider>,
		);
		expect(VIEW_KEYS).toEqual({
			showInvisibles: "h",
			ignoreWhitespace: "w",
			sideBySide: "s",
		});
		press("w");
		expect(ignoreWhitespace.read()).toBe(true);
		press("w");
		expect(ignoreWhitespace.read()).toBe(false);
		press("s");
		expect(sideBySide.read()).toBe(true);
		press("s");
		expect(sideBySide.read()).toBe(false);
	});

	it("h toggles Show hidden characters", () => {
		render(
			<ShortcutsProvider>
				<Uses />
			</ShortcutsProvider>,
		);
		expect(showInvisibles.read()).toBe(true);
		press("h");
		expect(showInvisibles.read()).toBe(false);
		press("h");
		expect(showInvisibles.read()).toBe(true);
	});

	it("does nothing while typing in a field", () => {
		render(
			<ShortcutsProvider>
				<Uses />
			</ShortcutsProvider>,
		);
		press("w", screen.getByLabelText("field"));
		press("s", screen.getByLabelText("field"));
		press("h", screen.getByLabelText("field"));
		expect(ignoreWhitespace.read()).toBe(false);
		expect(sideBySide.read()).toBe(false);
		expect(showInvisibles.read()).toBe(true);
	});

	it("does nothing on a phone", () => {
		phone();
		render(
			<ShortcutsProvider>
				<Uses />
			</ShortcutsProvider>,
		);
		press("w");
		press("s");
		press("h");
		expect(ignoreWhitespace.read()).toBe(false);
		expect(sideBySide.read()).toBe(false);
		expect(showInvisibles.read()).toBe(true);
	});

	it("is listed in the help under Files changed", () => {
		window.history.replaceState(null, "", "/files");
		render(
			<ShortcutsProvider>
				<Uses />
			</ShortcutsProvider>,
		);
		fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
		const group = screen.getByRole("region", { name: "Files changed" });
		const rows = [...group.querySelectorAll("li")].map((li) => [
			li.querySelector("span")?.textContent,
			li.querySelector("kbd")?.textContent,
		]);
		expect(rows).toEqual([
			["Show hidden characters", "h"],
			["Ignore whitespace", "w"],
			["Side by side", "s"],
		]);
	});
});
