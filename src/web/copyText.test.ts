// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./copyText";

/**
 * What the fallback's textarea held when "copy" ran, and where it sat (its
 * parent).
 */
function fakeExecCommand(result: boolean | "throw") {
	const seen: string[] = [];
	const parents: (Element | null)[] = [];
	const exec = vi.fn((command: string) => {
		const area = document.activeElement;
		if (command === "copy" && area instanceof HTMLTextAreaElement) {
			seen.push(area.value.slice(area.selectionStart, area.selectionEnd));
			parents.push(area.parentElement);
		}
		if (result === "throw") throw new Error("no");
		return result;
	});
	Object.defineProperty(document, "execCommand", {
		configurable: true,
		value: exec,
	});
	return { exec, seen, parents };
}

function setContext(secure: boolean, writeText?: (t: string) => Promise<void>) {
	vi.stubGlobal("isSecureContext", secure);
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: writeText ? { writeText } : undefined,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	Reflect.deleteProperty(document, "execCommand");
	Reflect.deleteProperty(navigator, "clipboard");
	document.body.innerHTML = "";
});

describe("copyText", () => {
	it("uses the Clipboard API in a secure context", async () => {
		const writeText = vi.fn(async () => {});
		setContext(true, writeText);
		const { exec } = fakeExecCommand(true);
		expect(await copyText("crb mcp")).toBe(true);
		expect(writeText).toHaveBeenCalledWith("crb mcp");
		expect(exec).not.toHaveBeenCalled();
	});

	it("over plain http (no Clipboard API) copies a selected textarea, then removes it and gives focus back", async () => {
		setContext(false);
		const button = document.createElement("button");
		document.body.append(button);
		button.focus();
		const { exec, seen } = fakeExecCommand(true);
		const line = 'claude mcp add crb "http://100.1.2.3:4781/mcp?key=k"';
		expect(await copyText(line)).toBe(true);
		expect(exec).toHaveBeenCalledWith("copy");
		expect(seen).toEqual([line]);
		expect(document.querySelector("textarea")).toBeNull();
		expect(document.activeElement).toBe(button);
	});

	it("ignores a Clipboard API outside a secure context", async () => {
		const writeText = vi.fn(async () => {});
		setContext(false, writeText);
		fakeExecCommand(true);
		expect(await copyText("x")).toBe(true);
		expect(writeText).not.toHaveBeenCalled();
	});

	it("falls back when the Clipboard API refuses", async () => {
		setContext(
			true,
			vi.fn(async () => {
				throw new DOMException("denied", "NotAllowedError");
			}),
		);
		const { seen } = fakeExecCommand(true);
		expect(await copyText("x")).toBe(true);
		expect(seen).toEqual(["x"]);
	});

	it("is false when the fallback fails or throws", async () => {
		setContext(false);
		fakeExecCommand(false);
		expect(await copyText("x")).toBe(false);
		fakeExecCommand("throw");
		expect(await copyText("x")).toBe(false);
		expect(document.querySelector("textarea")).toBeNull();
	});

	it("inside a modal dialog, puts the textarea in the dialog (the rest of the page is inert)", async () => {
		setContext(false);
		const dialog = document.createElement("dialog");
		dialog.setAttribute("open", "");
		const field = document.createElement("input");
		const button = document.createElement("button");
		dialog.append(field, button);
		document.body.append(dialog);
		button.focus();
		const { seen, parents } = fakeExecCommand(true);
		expect(await copyText("crb mcp", field)).toBe(true);
		expect(seen).toEqual(["crb mcp"]);
		expect(parents).toEqual([dialog]);
		expect(dialog.querySelector("textarea")).toBeNull();
		expect(document.activeElement).toBe(button);
	});

	it("finds the dialog from the focused button when not told where", async () => {
		setContext(false);
		const dialog = document.createElement("dialog");
		dialog.setAttribute("open", "");
		const button = document.createElement("button");
		dialog.append(button);
		document.body.append(dialog);
		button.focus();
		const { parents } = fakeExecCommand(true);
		expect(await copyText("x")).toBe(true);
		expect(parents).toEqual([dialog]);
	});

	it("outside any dialog, still uses the body", async () => {
		setContext(false);
		const field = document.createElement("input");
		document.body.append(field);
		const { parents } = fakeExecCommand(true);
		expect(await copyText("x", field)).toBe(true);
		expect(parents).toEqual([document.body]);
	});

	it("is false when the textarea couldn't take focus, even if execCommand says true", async () => {
		setContext(false);
		const button = document.createElement("button");
		document.body.append(button);
		button.focus();
		// What an inert page does: focus() and select() on the textarea
		// do nothing, yet execCommand("copy") still answers true.
		vi.spyOn(HTMLTextAreaElement.prototype, "focus").mockImplementation(
			() => {},
		);
		const { exec } = fakeExecCommand(true);
		expect(await copyText("x")).toBe(false);
		expect(exec).not.toHaveBeenCalled();
		expect(document.querySelector("textarea")).toBeNull();
		expect(document.activeElement).toBe(button);
	});

	it("is false when the selection doesn't cover the text, even if execCommand says true", async () => {
		setContext(false);
		vi.spyOn(
			HTMLTextAreaElement.prototype,
			"setSelectionRange",
		).mockImplementation(() => {});
		vi.spyOn(HTMLTextAreaElement.prototype, "select").mockImplementation(
			() => {},
		);
		fakeExecCommand(true);
		expect(await copyText("some text")).toBe(false);
	});

	it.each([
		["CRLF", "a\r\nb"],
		["a lone CR", "a\rb"],
	])(
		"copies text with %s line ends (the textarea makes them \\n)",
		async (_, text) => {
			setContext(false);
			const { seen } = fakeExecCommand(true);
			expect(await copyText(text)).toBe(true);
			expect(seen).toEqual(["a\nb"]);
		},
	);
});
