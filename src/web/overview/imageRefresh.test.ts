import { describe, expect, it, vi } from "vitest";
import { createImageRefresher } from "./imageRefresh";

const MIN = 60_000;

describe("createImageRefresher", () => {
	const setup = () => {
		let t = 10 * MIN;
		const refetch = vi.fn();
		const refresh = createImageRefresher({ refetch, now: () => t });
		return {
			refresh,
			refetch,
			at: (ms: number) => {
				t = ms;
			},
		};
	};

	it("refetches when an image breaks in HTML at least a minute old", () => {
		const { refresh, refetch } = setup();
		expect(refresh(4 * MIN)).toBe(true);
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("ignores images that break right after a fetch: fresh URLs won't help", () => {
		const { refresh, refetch } = setup();
		expect(refresh(10 * MIN - 5_000)).toBe(false);
		expect(refetch).not.toHaveBeenCalled();
	});

	it("refetches at most once a minute, however many images break", () => {
		const { refresh, refetch, at } = setup();
		const fetchedAt = 0;
		expect(refresh(fetchedAt)).toBe(true);
		for (const ms of [10 * MIN + 1, 10 * MIN + 30_000, 11 * MIN - 1]) {
			at(ms);
			expect(refresh(fetchedAt)).toBe(false);
		}
		at(11 * MIN);
		expect(refresh(fetchedAt)).toBe(true);
		expect(refetch).toHaveBeenCalledTimes(2);
	});
});
