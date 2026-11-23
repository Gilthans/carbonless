import { describe, expect, it } from "vitest";
import { toggleKind } from "./OverviewPage";

const base = { clipped: false, replies: 0, canReply: true, canResolve: true };

describe("toggleKind", () => {
	it("says Show more when there's something to read", () => {
		expect(toggleKind({ ...base, clipped: true })).toBe("more");
		// Replies, the viewer's pending and sending ones among them.
		expect(toggleKind({ ...base, replies: 1 })).toBe("more");
	});

	it("says Reply when it opens only to the box and Resolve", () => {
		expect(toggleKind(base)).toBe("reply");
		expect(toggleKind({ ...base, canResolve: false })).toBe("reply");
	});

	it("says Resolve (no toggle on a closed card) where the viewer may resolve but not reply", () => {
		expect(toggleKind({ ...base, canReply: false })).toBe("resolve");
	});

	it("says Show more for the opener's own Edit and Delete with no reply box", () => {
		expect(toggleKind({ ...base, canReply: false, editable: true })).toBe(
			"more",
		);
		expect(toggleKind({ ...base, editable: true })).toBe("reply");
	});

	it("falls back to Show more with nothing to do", () => {
		expect(toggleKind({ ...base, canReply: false, canResolve: false })).toBe(
			"more",
		);
	});
});
