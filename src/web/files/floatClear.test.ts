import { describe, expect, it } from "vitest";
import { rootMarginFor } from "./floatClear";

describe("rootMarginFor", () => {
	it("shrinks the viewport to the button's footprint, a little grown", () => {
		// The phone's Files button: 16px from the right and bottom, 96x48,
		// on a 360x800 viewport: left 248..344, top 736..784, grown by 4px.
		expect(
			rootMarginFor({ right: 16, bottom: 16, width: 96, height: 48 }, 360, 800),
		).toBe("-732px -12px -12px -244px");
	});

	it("never grows the root past the viewport", () => {
		expect(
			rootMarginFor({ right: 0, bottom: 0, width: 400, height: 900 }, 360, 800),
		).toBe("0px 0px 0px 0px");
	});
});
