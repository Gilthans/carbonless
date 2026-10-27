// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ignoreWhitespace, showInvisibles, viewSetting } from "./viewSettings";

describe("viewSetting", () => {
	afterEach(() => {
		localStorage.clear();
		showInvisibles.reset();
		ignoreWhitespace.reset();
	});

	it("reads the default until set, then remembers the choice", () => {
		const s = viewSetting("crb.test.x", false);
		expect(s.read()).toBe(false);
		const { result } = renderHook(() => s.use());
		expect(result.current).toBe(false);
		act(() => s.set(true));
		expect(result.current).toBe(true);
		expect(localStorage.getItem("crb.test.x")).toBe("on");
		// A fresh store (a reload) reads what was stored.
		expect(viewSetting("crb.test.x", false).read()).toBe(true);
		act(() => s.set(false));
		expect(localStorage.getItem("crb.test.x")).toBe("off");
		expect(viewSetting("crb.test.x", true).read()).toBe(false);
	});

	it("falls back to the default when storage is unavailable or odd", () => {
		localStorage.setItem("crb.test.y", "maybe");
		expect(viewSetting("crb.test.y", true).read()).toBe(true);
		const getItem = Storage.prototype.getItem;
		const setItem = Storage.prototype.setItem;
		Storage.prototype.getItem = () => {
			throw new Error("blocked");
		};
		Storage.prototype.setItem = () => {
			throw new Error("blocked");
		};
		try {
			const s = viewSetting("crb.test.z", true);
			expect(s.read()).toBe(true);
			expect(() => s.set(false)).not.toThrow();
			expect(s.use).toBeTypeOf("function");
		} finally {
			Storage.prototype.getItem = getItem;
			Storage.prototype.setItem = setItem;
		}
	});

	it("has hidden characters on and ignore whitespace off by default", () => {
		expect(showInvisibles.key).toBe("crb.code.invisibles");
		expect(showInvisibles.read()).toBe(true);
		expect(ignoreWhitespace.key).toBe("crb.diff.ignoreWhitespace");
		expect(ignoreWhitespace.read()).toBe(false);
	});
});
