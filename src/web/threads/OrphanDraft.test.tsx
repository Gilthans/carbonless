// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrphanDraft } from "./OrphanDraft";

// user-event stubs the Clipboard API; what reaches the clipboard is
// copyText's (copyText.test.ts). Here: what each outcome shows.
const copied = vi.hoisted(() => ({ ok: true, texts: [] as string[] }));
vi.mock("../copyText", () => ({
	copyText: async (text: string) => {
		copied.texts.push(text);
		return copied.ok;
	},
}));

afterEach(() => {
	cleanup();
	window.getSelection()?.removeAllRanges();
});

const TEXT = "Why not reuse total()?\nIt already sums.";

function show() {
	const user = userEvent.setup();
	render(
		<ul>
			<OrphanDraft label="Thread gone" text={TEXT} onDiscard={() => {}} />
		</ul>,
	);
	return user;
}

describe("OrphanDraft's Copy (CAR-121)", () => {
	it("copies the draft and says Copied", async () => {
		copied.ok = true;
		copied.texts = [];
		const user = show();
		await user.click(screen.getByRole("button", { name: "Copy" }));
		expect(copied.texts).toEqual([TEXT]);
		expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
		expect(window.getSelection()?.toString()).toBe("");
	});

	it("says Copy failed, and selects the draft to copy by hand, when the browser won't copy", async () => {
		copied.ok = false;
		copied.texts = [];
		const user = show();
		await user.click(screen.getByRole("button", { name: "Copy" }));
		expect(
			await screen.findByRole("button", { name: "Copy failed" }),
		).toBeTruthy();
		expect(window.getSelection()?.toString()).toBe(TEXT);
	});
});
