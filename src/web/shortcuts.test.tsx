// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageActive } from "./pageActive";
import {
	helpGroups,
	isTypingTarget,
	matchesKeys,
	type Shortcut,
	ShortcutsProvider,
	useOpenShortcutsHelp,
	useShortcut,
	useShortcutHelp,
} from "./shortcuts";

function Uses(props: Omit<Shortcut, "label" | "group"> & Partial<Shortcut>) {
	useShortcut({ label: "Do it", group: "Global", ...props });
	return null;
}

function Help(props: { entries: Parameters<typeof useShortcutHelp>[0] }) {
	useShortcutHelp(props.entries);
	return null;
}

function OpenButton() {
	const open = useOpenShortcutsHelp();
	return (
		<button type="button" onClick={open}>
			Open help
		</button>
	);
}

const press = (key: string, init: KeyboardEventInit = {}, target?: Element) =>
	fireEvent.keyDown(target ?? document.body, { key, ...init });

const help = () => screen.queryByTestId("shortcuts-help");
const helpOpen = () => help()?.hasAttribute("open") ?? false;

afterEach(() => {
	cleanup();
	window.history.replaceState(null, "", "/");
});

describe("matchesKeys", () => {
	const ev = (key: string, init: KeyboardEventInit = {}) =>
		new KeyboardEvent("keydown", { key, ...init });
	it("matches a printed key whatever Shift made it, and nothing with Ctrl, Cmd or Alt", () => {
		expect(matchesKeys("?", ev("?", { shiftKey: true }))).toBe(true);
		expect(matchesKeys("c", ev("c"))).toBe(true);
		expect(matchesKeys("c", ev("C", { shiftKey: true }))).toBe(false);
		expect(matchesKeys("c", ev("c", { ctrlKey: true }))).toBe(false);
		expect(matchesKeys("c", ev("c", { metaKey: true }))).toBe(false);
		expect(matchesKeys("c", ev("c", { altKey: true }))).toBe(false);
	});
	it("matches a letter with Caps Lock on, and on a non-Latin layout by its physical key", () => {
		expect(matchesKeys("c", ev("C", { code: "KeyC" }))).toBe(true);
		expect(matchesKeys("c", ev("ב", { code: "KeyC" }))).toBe(true);
		expect(matchesKeys("c", ev("ב", { code: "KeyC", shiftKey: true }))).toBe(
			false,
		);
		// A Latin layout's own letter wins over the physical key (Dvorak).
		expect(matchesKeys("c", ev("j", { code: "KeyC" }))).toBe(false);
		expect(matchesKeys("Shift+c", ev("C", { shiftKey: true }))).toBe(true);
	});
	it("matches named keys with exactly their modifiers", () => {
		expect(matchesKeys("Ctrl+Enter", ev("Enter", { ctrlKey: true }))).toBe(
			true,
		);
		expect(matchesKeys("Enter", ev("Enter", { ctrlKey: true }))).toBe(false);
		expect(matchesKeys("Shift+Enter", ev("Enter", { shiftKey: true }))).toBe(
			true,
		);
		expect(matchesKeys("Enter", ev("Enter", { shiftKey: true }))).toBe(false);
	});
});

describe("isTypingTarget", () => {
	it("is a text field, a select or contenteditable; not a button or checkbox", () => {
		const el = (html: string) => {
			const d = document.createElement("div");
			d.innerHTML = html;
			return d.firstElementChild as Element;
		};
		expect(isTypingTarget(el("<input>"))).toBe(true);
		expect(isTypingTarget(el('<input type="search">'))).toBe(true);
		// An unknown type is a text field.
		expect(isTypingTarget(el('<input type="foo">'))).toBe(true);
		expect(isTypingTarget(el("<textarea></textarea>"))).toBe(true);
		expect(isTypingTarget(el("<select></select>"))).toBe(true);
		const editable = el('<div contenteditable="true"><span>x</span></div>');
		expect(isTypingTarget(editable.firstElementChild)).toBe(true);
		expect(isTypingTarget(el('<input type="checkbox">'))).toBe(false);
		expect(isTypingTarget(el("<button></button>"))).toBe(false);
		expect(isTypingTarget(el('<div contenteditable="false"></div>'))).toBe(
			false,
		);
	});
});

describe("ShortcutsProvider", () => {
	it("runs a shortcut only while it is mounted", () => {
		const run = vi.fn();
		function Toggle() {
			const [on, setOn] = useState(true);
			return (
				<>
					{on && <Uses keys="j" run={run} />}
					<button type="button" onClick={() => setOn(false)}>
						Unmount
					</button>
				</>
			);
		}
		render(
			<ShortcutsProvider>
				<Toggle />
			</ShortcutsProvider>,
		);
		press("j");
		expect(run).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByText("Unmount"));
		press("j");
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("doesn't run while typing in a field, nor with a modifier held", () => {
		const run = vi.fn();
		render(
			<ShortcutsProvider>
				<Uses keys="j" run={run} />
				<input aria-label="field" />
				<textarea aria-label="area" />
				<div contentEditable suppressContentEditableWarning data-testid="ce">
					x
				</div>
			</ShortcutsProvider>,
		);
		press("j", {}, screen.getByLabelText("field"));
		press("j", {}, screen.getByLabelText("area"));
		press("j", {}, screen.getByTestId("ce"));
		press("j", { ctrlKey: true });
		press("j", { metaKey: true });
		press("j", { altKey: true });
		expect(run).not.toHaveBeenCalled();
		press("j");
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("respects `when`, and a hidden page's shortcuts don't run", () => {
		const run = vi.fn();
		let allowed = false;
		const { rerender } = render(
			<ShortcutsProvider>
				<Uses keys="j" run={run} when={() => allowed} />
				<PageActive value={false}>
					<Uses keys="k" group="Files changed" run={run} />
				</PageActive>
			</ShortcutsProvider>,
		);
		press("j");
		press("k");
		expect(run).not.toHaveBeenCalled();
		allowed = true;
		press("j");
		expect(run).toHaveBeenCalledTimes(1);
		rerender(
			<ShortcutsProvider>
				<Uses keys="j" run={run} when={() => allowed} />
				<PageActive value={true}>
					<Uses keys="k" group="Files changed" run={run} />
				</PageActive>
			</ShortcutsProvider>,
		);
		press("k");
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("a hidden page's shortcuts don't run, whatever their group", () => {
		const hidden = vi.fn();
		const shown = vi.fn();
		render(
			<ShortcutsProvider>
				<PageActive value={false}>
					<Uses keys="r" group="Threads" run={hidden} />
				</PageActive>
				<Uses keys="r" group="Threads" run={shown} />
			</ShortcutsProvider>,
		);
		press("r");
		expect(hidden).not.toHaveBeenCalled();
		expect(shown).toHaveBeenCalledTimes(1);
	});

	it("ignores a held key's repeats", () => {
		const run = vi.fn();
		render(
			<ShortcutsProvider>
				<Uses keys="j" run={run} />
			</ShortcutsProvider>,
		);
		press("j");
		press("j", { repeat: true });
		press("j", { repeat: true });
		expect(run).toHaveBeenCalledTimes(1);
		press("?", { shiftKey: true });
		press("?", { shiftKey: true, repeat: true });
		expect(helpOpen()).toBe(true);
	});

	it("doesn't run while typing in a field inside a shadow root", () => {
		const run = vi.fn();
		render(
			<ShortcutsProvider>
				<Uses keys="j" run={run} />
				<div data-testid="host" />
			</ShortcutsProvider>,
		);
		const root = screen.getByTestId("host").attachShadow({ mode: "open" });
		const input = document.createElement("input");
		root.append(input);
		input.dispatchEvent(
			new KeyboardEvent("keydown", { key: "j", bubbles: true, composed: true }),
		);
		expect(run).not.toHaveBeenCalled();
	});

	it("leaves a key a handler already took alone", () => {
		const run = vi.fn();
		render(
			<ShortcutsProvider>
				<Uses keys="j" run={run} />
				<button type="button" onKeyDown={(e) => e.preventDefault()}>
					Takes keys
				</button>
			</ShortcutsProvider>,
		);
		press("j", {}, screen.getByText("Takes keys"));
		expect(run).not.toHaveBeenCalled();
	});

	it("doesn't run while another modal dialog is open", () => {
		const run = vi.fn();
		render(
			<ShortcutsProvider>
				<Uses keys="j" run={run} />
				<dialog open data-testid="other">
					x
				</dialog>
			</ShortcutsProvider>,
		);
		// jsdom has no :modal; a browser's answer for the open dialog.
		const matches = Element.prototype.matches;
		const spy = vi
			.spyOn(Element.prototype, "matches")
			.mockImplementation(function (this: Element, sel: string) {
				if (sel === ":modal") return this === screen.getByTestId("other");
				return matches.call(this, sel);
			});
		press("j");
		press("?", { shiftKey: true });
		expect(run).not.toHaveBeenCalled();
		expect(helpOpen()).toBe(false);
		spy.mockRestore();
		press("j");
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("toggles the help with ?, not while typing, and closes it with Escape", () => {
		render(
			<ShortcutsProvider>
				<textarea aria-label="area" />
			</ShortcutsProvider>,
		);
		press("?", { shiftKey: true }, screen.getByLabelText("area"));
		expect(helpOpen()).toBe(false);
		press("?", { shiftKey: true });
		expect(helpOpen()).toBe(true);
		expect(
			screen.getByText("Keyboard shortcuts", { selector: "h2" }),
		).toBeVisible();
		press("?", { shiftKey: true });
		expect(helpOpen()).toBe(false);
		press("?", { shiftKey: true });
		fireEvent.keyDown(help() as HTMLElement, { key: "Escape" });
		expect(helpOpen()).toBe(false);
	});

	it("closes on a press on the backdrop, not on a drag out of the help", () => {
		render(<ShortcutsProvider>{null}</ShortcutsProvider>);
		press("?", { shiftKey: true });
		const d = help() as HTMLElement;
		const row = screen.getByText("Keyboard shortcuts", { selector: "li span" });
		fireEvent.pointerDown(row);
		fireEvent.click(d);
		expect(helpOpen()).toBe(true);
		fireEvent.pointerDown(d);
		fireEvent.click(d);
		expect(helpOpen()).toBe(false);
	});

	it("doesn't run other shortcuts while the help is open", () => {
		const run = vi.fn();
		render(
			<ShortcutsProvider>
				<Uses keys="j" run={run} />
			</ShortcutsProvider>,
		);
		press("?", { shiftKey: true });
		press("j");
		expect(run).not.toHaveBeenCalled();
	});

	it("lists registered and static entries by group, the current page's first", () => {
		window.history.replaceState(null, "", "/files");
		render(
			<ShortcutsProvider>
				<Uses keys="c" label="Comment" group="Files changed" run={() => {}} />
				<Uses keys="r" label="Reply" group="Overview" run={() => {}} />
				<Help
					entries={[
						{ keys: "Mod+Enter", label: "Send", group: "Threads" },
						{ keys: "Mod+Enter", label: "Send", group: "Threads" },
					]}
				/>
				<Help
					entries={[{ keys: "Mod+Enter", label: "Send", group: "Threads" }]}
				/>
			</ShortcutsProvider>,
		);
		press("?", { shiftKey: true });
		const groups = [...(help() as HTMLElement).querySelectorAll("section")];
		expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
			"Files changed",
			"Global",
			"Overview",
			"Threads",
		]);
		expect(groups[0]).toHaveTextContent("Comment");
		expect(groups[1]).toHaveTextContent("Keyboard shortcuts");
		// Listed once, however many register it.
		expect(screen.getAllByText("Send")).toHaveLength(1);
		const caps = [...(groups[3] as HTMLElement).querySelectorAll("kbd")].map(
			(k) => k.textContent,
		);
		expect(caps).toEqual(["Ctrl", "Enter"]);
	});

	it("puts Overview first on the overview", () => {
		const groups = helpGroups(
			[
				{ entry: { keys: "c", label: "Comment", group: "Files changed" } },
				{ entry: { keys: "r", label: "Reply", group: "Overview" } },
			],
			"Overview",
		);
		expect(groups.map((g) => g.group)).toEqual([
			"Overview",
			"Global",
			"Files changed",
		]);
	});

	it("opens from useOpenShortcutsHelp and gives focus back on close", () => {
		render(
			<ShortcutsProvider>
				<OpenButton />
			</ShortcutsProvider>,
		);
		const button = screen.getByText("Open help");
		button.focus();
		fireEvent.click(button);
		expect(helpOpen()).toBe(true);
		const close = screen.getByRole("button", { name: "Close" });
		expect(close).toHaveFocus();
		// Tab stays inside.
		fireEvent.keyDown(close, { key: "Tab" });
		expect(close).toHaveFocus();
		act(() => close.click());
		expect(helpOpen()).toBe(false);
		expect(button).toHaveFocus();
	});

	it("gives focus to the menu's button when the menu it was in has closed", () => {
		render(
			<ShortcutsProvider>
				<button type="button" aria-controls="menu">
					Menu
				</button>
				<dialog id="menu" open>
					<button type="button">Inside</button>
				</dialog>
			</ShortcutsProvider>,
		);
		const inside = screen.getByText("Inside");
		inside.focus();
		press("?", { shiftKey: true }, inside);
		expect(helpOpen()).toBe(true);
		// The menu closes as focus leaves it.
		document.getElementById("menu")?.removeAttribute("open");
		fireEvent.keyDown(help() as HTMLElement, { key: "Escape" });
		expect(helpOpen()).toBe(false);
		expect(screen.getByText("Menu")).toHaveFocus();
	});

	it("is a no-op outside the provider", () => {
		render(
			<>
				<Uses keys="j" run={() => {}} />
				<OpenButton />
			</>,
		);
		fireEvent.click(screen.getByText("Open help"));
		expect(help()).toBeNull();
	});
});
