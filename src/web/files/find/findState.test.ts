// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findFloat, findState, useFindFloatShown } from "./findState";

describe("findState", () => {
	afterEach(() => findState.reset());

	it("starts closed with no term", () => {
		expect(findState.get()).toEqual({ open: false, term: "", focusSeq: 0 });
	});

	it("opens, and asks the box for focus again on every open request", () => {
		findState.open();
		expect(findState.get().open).toBe(true);
		expect(findState.get().focusSeq).toBe(1);
		findState.open();
		expect(findState.get().open).toBe(true);
		expect(findState.get().focusSeq).toBe(2);
	});

	it("closes and clears the term: reopening starts empty", () => {
		findState.open();
		findState.setTerm("foo");
		findState.close();
		expect(findState.get()).toMatchObject({ open: false, term: "" });
		findState.open();
		expect(findState.get()).toMatchObject({ open: true, term: "" });
	});

	it("a toggle that closes clears the term too", () => {
		findState.toggle();
		findState.setTerm("foo");
		findState.toggle();
		expect(findState.get()).toMatchObject({ open: false, term: "" });
	});

	it("toggles", () => {
		findState.toggle();
		expect(findState.get().open).toBe(true);
		expect(findState.get().focusSeq).toBe(1);
		findState.toggle();
		expect(findState.get().open).toBe(false);
	});

	it("sets the term", () => {
		findState.setTerm("bar");
		expect(findState.get().term).toBe("bar");
	});

	it("re-renders a component using it, and tells subscribers", () => {
		const { result } = renderHook(() => findState.use());
		const seen = vi.fn();
		const off = findState.subscribe(seen);
		act(() => findState.open());
		expect(result.current.open).toBe(true);
		expect(seen).toHaveBeenCalledTimes(1);
		off();
		act(() => findState.setTerm("x"));
		expect(result.current.term).toBe("x");
		expect(seen).toHaveBeenCalledTimes(1);
	});

	it("resets to closed, empty", () => {
		findState.open();
		findState.setTerm("foo");
		findState.reset();
		expect(findState.get()).toEqual({ open: false, term: "", focusSeq: 0 });
	});
});

describe("findFloat", () => {
	it("is shown while a component marking it is mounted, and tells its listeners", () => {
		const seen = vi.fn();
		const stop = findFloat.subscribe(seen);
		expect(findFloat.get()).toBe(false);
		const { unmount } = renderHook(() => useFindFloatShown());
		expect(findFloat.get()).toBe(true);
		unmount();
		expect(findFloat.get()).toBe(false);
		expect(seen).toHaveBeenCalledTimes(2);
		stop();
	});
});
