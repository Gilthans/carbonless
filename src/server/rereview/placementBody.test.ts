import { describe, expect, it } from "vitest";
import { parsePlacementBody } from "./placementBody";
import { InvalidPlacementError } from "./threads";

/*
 * The placement route's own checks (POST /threads/:id/placement), before
 * the session checks the anchor against the patch set's files: each case
 * fails when only its check is removed.
 */

const anchor = {
	path: "src/a.ts",
	startSide: "RIGHT",
	startLine: 2,
	side: "RIGHT",
	line: 4,
};

describe("parsePlacementBody", () => {
	it("takes a patch set number and a well-formed anchor, and keeps only its fields", () => {
		expect(
			parsePlacementBody({ patchset: 2, anchor: { ...anchor, extra: "<x>" } }),
		).toEqual({ patchset: 2, anchor });
	});

	it.each([
		["no body", null],
		["a body that is no object", "2"],
		["no patch set", { anchor }],
		["a patch set as a string", { patchset: "2", anchor }],
		["patch set 0", { patchset: 0, anchor }],
		["a fractional patch set", { patchset: 1.5, anchor }],
		["no anchor", { patchset: 2 }],
		["an empty path", { patchset: 2, anchor: { ...anchor, path: "" } }],
		[
			"a path that is no string",
			{ patchset: 2, anchor: { ...anchor, path: 7 } },
		],
		[
			"a path past 4096 characters",
			{ patchset: 2, anchor: { ...anchor, path: "a".repeat(4097) } },
		],
		["a side that is none", { patchset: 2, anchor: { ...anchor, side: "UP" } }],
		[
			"a start side that is none",
			{ patchset: 2, anchor: { ...anchor, startSide: 1 } },
		],
		["line 0", { patchset: 2, anchor: { ...anchor, line: 0 } }],
		[
			"a fractional start line",
			{ patchset: 2, anchor: { ...anchor, startLine: 1.5 } },
		],
		["a line as a string", { patchset: 2, anchor: { ...anchor, line: "4" } }],
		["a line past 2^31", { patchset: 2, anchor: { ...anchor, line: 2 ** 31 } }],
	])("refuses %s", (_, body) => {
		expect(() => parsePlacementBody(body)).toThrow(InvalidPlacementError);
	});
});
