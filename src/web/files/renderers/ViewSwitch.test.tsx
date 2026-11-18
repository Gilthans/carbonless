// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RendererFile } from "./index";
import { pressedView, ViewSwitch, viewOptions } from "./ViewSwitch";

const file = (
	path: string,
	over: Partial<RendererFile> = {},
): RendererFile => ({
	path,
	binary: false,
	submodule: false,
	...over,
});

describe("viewOptions", () => {
	it.each([
		[
			"a PNG, two versions",
			file("a.png", { binary: true }),
			true,
			["slider", "fade", "binary"],
		],
		[
			"a PNG, one version (added)",
			file("a.png", { binary: true }),
			false,
			["image", "binary"],
		],
		["an SVG", file("a.svg"), true, ["slider", "fade", "text"]],
		["an SVG, one version", file("a.svg"), false, ["image", "text"]],
		[
			"an unknown binary (Image by its bytes)",
			file("a.dat", { binary: true }),
			true,
			["slider", "fade", "binary"],
		],
		["a .ts file", file("a.ts"), true, []],
		["an unknown text file", file("notes.txt"), true, []],
		["an LFS pointer", file("a.png", { lfs: true }), true, []],
		["a submodule", file("vendor", { submodule: true }), true, []],
	] as const)("%s", (_, f, modes, ids) => {
		expect(viewOptions(f, modes).map((o) => o.id)).toEqual(ids);
	});

	it("the pressed button: Image's mode when split, else the renderer", () => {
		expect(pressedView("image", "fade", true)).toBe("fade");
		expect(pressedView("image", "fade", false)).toBe("image");
		expect(pressedView("text", "slider", true)).toBe("text");
		expect(pressedView("binary", "slider", true)).toBe("binary");
	});
});

describe("ViewSwitch", () => {
	afterEach(cleanup);

	it("icon buttons named by their tooltip, the current one pressed; a press picks", async () => {
		const onPick = vi.fn();
		render(
			<ViewSwitch
				options={viewOptions(file("a.svg"), true)}
				pressed="text"
				onPick={onPick}
			/>,
		);
		const group = screen.getByRole("group", { name: "View" });
		const buttons = [...group.querySelectorAll("button")];
		expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
			"Slider",
			"Fade",
			"Text",
		]);
		expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual([
			"false",
			"false",
			"true",
		]);
		for (const b of buttons) expect(b.querySelector("svg")).not.toBeNull();
		await userEvent.setup().click(screen.getByRole("button", { name: "Fade" }));
		expect(onPick).toHaveBeenCalledWith(
			expect.objectContaining({ renderer: "image", mode: "fade" }),
		);
	});

	it("renders nothing with no options", () => {
		const { container } = render(
			<ViewSwitch options={[]} pressed="text" onPick={() => {}} />,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
