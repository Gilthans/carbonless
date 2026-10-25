// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHeight } from "./sticky";

const withHeight = (h: number) => {
	const el = document.createElement("div");
	Object.defineProperty(el, "offsetHeight", { configurable: true, value: h });
	return el;
};

describe("useHeight", () => {
	it("keeps the last height while paused (a hidden page measures 0), then measures again", () => {
		let node = withHeight(63);
		const { result, rerender } = renderHook(
			({ paused }) => useHeight(() => node, "bar", paused),
			{ initialProps: { paused: false } },
		);
		expect(result.current).toBe(63);
		node = withHeight(0);
		rerender({ paused: true });
		expect(result.current).toBe(63);
		node = withHeight(70);
		rerender({ paused: false });
		expect(result.current).toBe(70);
	});
});
