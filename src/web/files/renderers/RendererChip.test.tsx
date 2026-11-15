// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutsProvider, useShortcut } from "../../shortcuts";
import { RendererChip } from "./RendererChip";

function Page(props: { run: () => void; onPick: () => void }) {
	useShortcut({
		keys: "j",
		label: "Next file",
		group: "Files changed",
		run: props.run,
	});
	return (
		<RendererChip
			current="image"
			choices={["image", "binary"]}
			onPick={props.onPick}
		/>
	);
}

describe("RendererChip", () => {
	afterEach(cleanup);

	it("keeps the page's shortcuts out while its menu is open", async () => {
		const run = vi.fn();
		const onPick = vi.fn();
		const user = userEvent.setup();
		render(
			<ShortcutsProvider>
				<Page run={run} onPick={onPick} />
			</ShortcutsProvider>,
		);
		const chip = screen.getByRole("button", { name: "Show as: Image" });
		// Closed: the shortcut runs as usual.
		chip.focus();
		await user.keyboard("j");
		expect(run).toHaveBeenCalledTimes(1);
		await user.click(chip);
		expect(screen.getByRole("menuitemradio", { name: "Image" })).toHaveFocus();
		await user.keyboard("j");
		await user.keyboard("{ArrowDown}");
		expect(screen.getByRole("menuitemradio", { name: "Binary" })).toHaveFocus();
		expect(run).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("menu", { name: "Show as" })).toBeInTheDocument();
		expect(onPick).not.toHaveBeenCalled();
	});
});
