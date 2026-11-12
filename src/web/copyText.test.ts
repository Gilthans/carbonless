// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./copyText";

/** What the fallback's textarea held when "copy" ran. */
function fakeExecCommand(result: boolean | "throw") {
	const seen: string[] = [];
	const exec = vi.fn((command: string) => {
		const area = document.activeElement;
		if (command === "copy" && area instanceof HTMLTextAreaElement) {
			seen.push(area.value.slice(area.selectionStart, area.selectionEnd));
		}
		if (result === "throw") throw new Error("no");
		return result;
	});
	Object.defineProperty(document, "execCommand", {
		configurable: true,
		value: exec,
	});
	return { exec, seen };
}

function setContext(secure: boolean, writeText?: (t: string) => Promise<void>) {
	vi.stubGlobal("isSecureContext", secure);
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: writeText ? { writeText } : undefined,
	});
}

afterEach(() => {
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
});
