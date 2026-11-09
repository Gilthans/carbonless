// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { contextRanges } from "./contextRanges";

afterEach(() => contextRanges.reset());

describe("contextRanges", () => {
	it("keeps ranges in the order added, a duplicate once", () => {
		contextRanges.add("r1", 0, 5, 9);
		contextRanges.add("r1", 0, 1, 2);
		contextRanges.add("r1", 0, 5, 9);
		expect(contextRanges.get("r1", 0)).toEqual([
			[5, 9],
			[1, 2],
		]);
	});

	it("keeps another revision or file apart", () => {
		contextRanges.add("r1", 0, 5, 9);
		expect(contextRanges.get("r2", 0)).toEqual([]);
		expect(contextRanges.get("r1", 1)).toEqual([]);
	});

	it("maps only the files with ranges, and updates when one is added", () => {
		const { result } = renderHook(() => contextRanges.useAll("r1"));
		expect(result.current.size).toBe(0);
		act(() => contextRanges.add("r1", 2, 3, 4));
		act(() => contextRanges.add("r2", 7, 3, 4));
		expect([...result.current.keys()]).toEqual([2]);
		expect(result.current.get(2)).toEqual([[3, 4]]);
		act(() => contextRanges.add("r1", 0, 8, 9));
		expect([...result.current.keys()].sort()).toEqual([0, 2]);
	});

	it("forgets everything on reset", () => {
		contextRanges.add("r1", 0, 5, 9);
		contextRanges.reset();
		expect(contextRanges.get("r1", 0)).toEqual([]);
		const { result } = renderHook(() => contextRanges.useAll("r1"));
		expect(result.current.size).toBe(0);
	});
});
