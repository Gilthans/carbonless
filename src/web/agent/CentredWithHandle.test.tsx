// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CentredWithHandle } from "./ThreadAgentButton";

afterEach(cleanup);

/** The row as a card without an agent draws it: its end there or not. */
const row = (end: boolean, columns: boolean) => (
	<CentredWithHandle
		handle
		columns={columns}
		end={end ? <button type="button">Resolve</button> : undefined}
	>
		<button type="button">Show more</button>
	</CentredWithHandle>
);

describe("CentredWithHandle", () => {
	it("keeps the toggle (and its focus) while its end comes and goes, with columns", () => {
		const { rerender } = render(row(true, true));
		const toggle = screen.getByRole("button", { name: "Show more" });
		toggle.focus();
		// Opened: Resolve leaves the row.
		rerender(row(false, true));
		expect(screen.getByRole("button", { name: "Show more" })).toBe(toggle);
		expect(toggle).toHaveFocus();
		// Closed: back.
		rerender(row(true, true));
		expect(screen.getByRole("button", { name: "Show more" })).toBe(toggle);
		expect(toggle).toHaveFocus();
	});

	it("without columns and an agent, a bare centred row", () => {
		render(row(false, false));
		expect(
			screen.getByRole("button", { name: "Show more" }).parentElement,
		).toHaveClass("flex", "justify-center");
	});
});
