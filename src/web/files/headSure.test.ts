import { describe, expect, it } from "vitest";
import { headSure } from "./headSure";

describe("headSure", () => {
	it("is false from a head move until the diff's revision follows it", () => {
		const seen = {};
		expect(headSure(seen, "h1", "r1")).toBe(true);
		// A Refresh: the session's head first, the old revision still shown.
		expect(headSure(seen, "h2", "r1")).toBe(false);
		expect(headSure(seen, "h2", "r1")).toBe(false);
		expect(headSure(seen, "h2", "r2")).toBe(true);
	});

	it("is true when both arrive together, false before either", () => {
		expect(headSure({}, undefined, undefined)).toBe(false);
		const seen = {};
		expect(headSure(seen, "h1", "r1")).toBe(true);
		expect(headSure(seen, "h2", "r2")).toBe(true);
	});
});
