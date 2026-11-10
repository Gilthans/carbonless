// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
	ignoreWhitespace,
	matchCase,
	numberSetting,
	showInvisibles,
	sideBySide,
	viewSetting,
} from "./viewSettings";

describe("viewSetting", () => {
	afterEach(() => {
		localStorage.clear();
		showInvisibles.reset();
		ignoreWhitespace.reset();
		sideBySide.reset();
		matchCase.reset();
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

	it("tells subscribers inside set, before React re-renders, until unsubscribed", () => {
		const s = viewSetting("crb.test.sub", false);
		const { result } = renderHook(() => s.use());
		const seen: Array<{ stored: boolean; rendered: boolean }> = [];
		const off = s.subscribe(() => {
			seen.push({ stored: s.read(), rendered: result.current });
		});
		act(() => s.set(true));
		// Told synchronously: the choice is stored, the hook still shows the old value.
		expect(seen).toEqual([{ stored: true, rendered: false }]);
		expect(result.current).toBe(true);
		// The same value again is no change.
		act(() => s.set(true));
		expect(seen).toHaveLength(1);
		off();
		act(() => s.set(false));
		expect(seen).toHaveLength(1);
		expect(result.current).toBe(false);
	});

	it("toggles from the value in hand, even when storage is unavailable", () => {
		const s = viewSetting("crb.test.toggle", false);
		const { result } = renderHook(() => s.use());
		act(() => s.toggle());
		expect(result.current).toBe(true);
		expect(localStorage.getItem("crb.test.toggle")).toBe("on");
		act(() => s.toggle());
		expect(result.current).toBe(false);
		const getItem = Storage.prototype.getItem;
		const setItem = Storage.prototype.setItem;
		Storage.prototype.getItem = () => {
			throw new Error("blocked");
		};
		Storage.prototype.setItem = () => {
			throw new Error("blocked");
		};
		try {
			act(() => s.toggle());
			expect(result.current).toBe(true);
			act(() => s.toggle());
			expect(result.current).toBe(false);
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

	it("has side by side off by default, remembered once turned on", () => {
		expect(sideBySide.key).toBe("crb.diff.sideBySide");
		expect(sideBySide.read()).toBe(false);
		const { result } = renderHook(() => sideBySide.use());
		expect(result.current).toBe(false);
		act(() => sideBySide.set(true));
		expect(result.current).toBe(true);
		expect(localStorage.getItem("crb.diff.sideBySide")).toBe("on");
		expect(viewSetting("crb.diff.sideBySide", false).read()).toBe(true);
		act(() => sideBySide.set(false));
		expect(result.current).toBe(false);
		expect(localStorage.getItem("crb.diff.sideBySide")).toBe("off");
	});

	it("has match case off by default, remembered once turned on", () => {
		expect(matchCase.key).toBe("crb.find.matchCase");
		expect(matchCase.read()).toBe(false);
		const { result } = renderHook(() => matchCase.use());
		expect(result.current).toBe(false);
		act(() => matchCase.set(true));
		expect(result.current).toBe(true);
		expect(localStorage.getItem("crb.find.matchCase")).toBe("on");
		expect(viewSetting("crb.find.matchCase", false).read()).toBe(true);
		act(() => matchCase.set(false));
		expect(result.current).toBe(false);
		expect(localStorage.getItem("crb.find.matchCase")).toBe("off");
	});
});

describe("numberSetting", () => {
	afterEach(() => localStorage.clear());

	it("reads the default until set, then remembers the number", () => {
		const s = numberSetting("crb.test.n", 288);
		expect(s.key).toBe("crb.test.n");
		expect(s.read()).toBe(288);
		const { result } = renderHook(() => s.use());
		expect(result.current).toBe(288);
		act(() => s.set(320));
		expect(result.current).toBe(320);
		expect(localStorage.getItem("crb.test.n")).toBe("320");
		// A fresh store (a reload) reads what was stored.
		expect(numberSetting("crb.test.n", 288).read()).toBe(320);
	});

	it("reads junk as the default", () => {
		for (const junk of ["", " ", "abc", "Infinity", "NaN", "12px", "null"]) {
			localStorage.setItem("crb.test.junk", junk);
			expect(numberSetting("crb.test.junk", 288).read(), junk).toBe(288);
		}
		localStorage.setItem("crb.test.junk", " 300 ");
		expect(numberSetting("crb.test.junk", 288).read()).toBe(300);
	});

	it("clamps what it reads and what it stores", () => {
		const clamp = (n: number) => Math.max(160, Math.round(n));
		localStorage.setItem("crb.test.clamped", "12");
		const s = numberSetting("crb.test.clamped", 288, clamp);
		expect(s.read()).toBe(160);
		const { result } = renderHook(() => s.use());
		expect(result.current).toBe(160);
		act(() => s.set(200.4));
		expect(result.current).toBe(200);
		expect(localStorage.getItem("crb.test.clamped")).toBe("200");
		act(() => s.set(10));
		expect(result.current).toBe(160);
		expect(localStorage.getItem("crb.test.clamped")).toBe("160");
	});

	it("falls back to the default when storage is unavailable", () => {
		const getItem = Storage.prototype.getItem;
		const setItem = Storage.prototype.setItem;
		Storage.prototype.getItem = () => {
			throw new Error("blocked");
		};
		Storage.prototype.setItem = () => {
			throw new Error("blocked");
		};
		try {
			const s = numberSetting("crb.test.blocked", 288);
			expect(s.read()).toBe(288);
			const { result } = renderHook(() => s.use());
			expect(() => act(() => s.set(300))).not.toThrow();
			// The choice holds in memory for this page.
			expect(result.current).toBe(300);
		} finally {
			Storage.prototype.getItem = getItem;
			Storage.prototype.setItem = setItem;
		}
	});

	it("tells subscribers inside set when the value changes", () => {
		const s = numberSetting("crb.test.nsub", 288);
		const seen: number[] = [];
		const off = s.subscribe(() => seen.push(s.read()));
		s.set(300);
		s.set(300);
		expect(seen).toEqual([300]);
		off();
		s.set(310);
		expect(seen).toEqual([300]);
		s.reset();
		expect(s.read()).toBe(310);
	});
});
