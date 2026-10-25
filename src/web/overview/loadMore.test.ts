import { describe, expect, it } from "vitest";
import { loadMoreText } from "./OverviewPage";

describe("loadMoreText", () => {
	it("counts the next page out of the threads not listed yet, pluralised", () => {
		expect(loadMoreText(1)).toBe("Load 1 more comment out of 1");
		expect(loadMoreText(2)).toBe("Load 2 more comments out of 2");
		expect(loadMoreText(5)).toBe("Load 5 more comments out of 5");
		expect(loadMoreText(12)).toBe("Load 5 more comments out of 12");
	});
});
