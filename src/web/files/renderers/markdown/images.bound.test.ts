// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { bindReview, blobUrl } from "../../../api";
import { failedImageWhy } from "./images";

// A file of its own: binding a review is once per page (module state).
describe("failedImageWhy on a page bound to a review (CAR-318)", () => {
	it("an old-side blob in the since view says it isn't at the patch set; the new side's, that it isn't loaded", () => {
		expect(bindReview("rev/1")).toBe(true);
		const old = blobUrl("r1", 2, "old", 1);
		expect(old).toMatch(/^\/api\/r\/[^/]+\/files\/2\/blob\?/);
		expect(failedImageWhy(old, 1)).toBe("Not at this patch set");
		expect(failedImageWhy(blobUrl("r1", 2, "new", 1), 1)).toBe("Not loaded");
		expect(failedImageWhy(old, undefined)).toBe("Not loaded");
		// Not our route, whatever its query says.
		expect(failedImageWhy("https://example.com/x.png?side=old", 1)).toBe(
			"Not loaded",
		);
	});
});
