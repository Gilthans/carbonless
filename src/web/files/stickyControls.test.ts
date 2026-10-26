import { describe, expect, it } from "vitest";
import { placeControls, runEnd } from "./stickyControls";

// Stack bottom at 180; controls 20px tall whose 40px targets reach 10px out.
const base = { top: 180, above: 10, below: 10, height: 20 };

describe("placeControls", () => {
	it("leaves controls in place while their targets are below the stack", () => {
		expect(
			placeControls({ ...base, slotTop: 190, clusterBottom: 900 }),
		).toEqual({ mode: "static" });
		expect(
			placeControls({ ...base, slotTop: 400, clusterBottom: 900 }),
		).toEqual({ mode: "static" });
	});

	it("floats them right below the stack once their row slips under it", () => {
		expect(
			placeControls({ ...base, slotTop: 189, clusterBottom: 900 }),
		).toEqual({ mode: "fixed", top: 190 });
		// Deep inside a long cluster.
		expect(
			placeControls({ ...base, slotTop: -3000, clusterBottom: 900 }),
		).toEqual({ mode: "fixed", top: 190 });
	});

	it("rides up with the cluster's end, never past it", () => {
		// Fixed would end at 190 + 20 + 10 + 2 = 222: just fits.
		expect(
			placeControls({ ...base, slotTop: -500, clusterBottom: 222 }),
		).toEqual({ mode: "fixed", top: 190 });
		// The end is near: translated so the targets end above it.
		expect(
			placeControls({ ...base, slotTop: -500, clusterBottom: 200 }),
		).toEqual({ mode: "end", offset: 200 - 2 - 10 - 20 + 500 });
	});

	it("stays put in a cluster too short to float in", () => {
		expect(
			placeControls({ ...base, slotTop: 170, clusterBottom: 195 }),
		).toEqual({ mode: "static" });
	});
});

describe("runEnd", () => {
	it("stops at the first opened thread below the slot, else the cluster's end", () => {
		expect(runEnd(100, 900, [])).toBe(900);
		expect(runEnd(100, 900, [400, 600])).toBe(400);
		// A thread above the slot doesn't end the run below it.
		expect(runEnd(100, 900, [50, 700])).toBe(700);
		expect(runEnd(100, 300, [700])).toBe(300);
	});
});
