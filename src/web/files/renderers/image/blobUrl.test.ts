import { describe, expect, it } from "vitest";
import { blobUrl } from "../../../api";

describe("blobUrl", () => {
	it("names the revision, file index and side, nothing else", () => {
		expect(blobUrl("r1", 3, "old")).toBe(
			"/api/files/3/blob?revision=r1&side=old",
		);
	});

	it("adds the since view's patch set and the sniff flag", () => {
		expect(blobUrl("r1", 0, "new", 2, true)).toBe(
			"/api/files/0/blob?revision=r1&side=new&from=2&sniff=1",
		);
	});

	it("encodes a revision as a query value", () => {
		expect(blobUrl("a&b=c", 1, "new")).toBe(
			"/api/files/1/blob?revision=a%26b%3Dc&side=new",
		);
	});
});
