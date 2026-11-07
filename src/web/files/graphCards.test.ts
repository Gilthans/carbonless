import { describe, expect, it } from "vitest";
import type { Shape } from "../../shared/types";
import { commitsLabel, connectorLine, connectorTone } from "./graphCards";

const shape = (over: Partial<Shape> = {}): Shape => ({
	code: "S1",
	commits: 3,
	identical: false,
	conflicts: [],
	virtualRebase: "ok",
	virtualHead: "t".repeat(40),
	...over,
});

const toRead = (files: number, clusters: number, gone = 0) => ({
	files,
	clusters,
	gone,
});

describe("connectorLine", () => {
	it("appended commits: the count, then what there is to read", () => {
		expect(connectorLine(shape(), toRead(2, 5))).toBe(
			"3 new commits · 2 files, 5 clusters to read",
		);
		expect(connectorLine(shape({ commits: 1 }), toRead(1, 1))).toBe(
			"1 new commit · 1 file, 1 cluster to read",
		);
		expect(connectorLine(shape(), toRead(0, 0))).toBe(
			"3 new commits · nothing new",
		);
	});
	it("the engine still computing: the count alone", () => {
		expect(connectorLine(shape(), null)).toBe("3 new commits");
		expect(connectorLine(shape({ code: "S4a" }), null)).toBe("Rebased");
	});
	it("a rebase: nothing new, conflicts, or what to read", () => {
		expect(connectorLine(shape({ code: "S4a" }), toRead(0, 0))).toBe(
			"Rebased, nothing new",
		);
		expect(
			connectorLine(
				shape({ code: "S4b", conflicts: ["a.ts", "b.ts"] }),
				toRead(2, 4),
			),
		).toBe("Rebased, 2 files had conflicts · 2 files, 4 clusters to read");
		expect(connectorLine(shape({ code: "S4c" }), toRead(1, 2))).toBe(
			"Rebased · 1 file, 2 clusters to read",
		);
	});
	it("a base merged in, a squash", () => {
		expect(connectorLine(shape({ code: "S3" }), toRead(0, 0))).toBe(
			"Base merged in, nothing new",
		);
		expect(
			connectorLine(shape({ code: "S3", conflicts: ["x"] }), toRead(1, 3)),
		).toBe("Base merged in, 1 file had conflicts · 1 file, 3 clusters to read");
		expect(connectorLine(shape({ code: "S5" }), toRead(0, 0))).toBe(
			"Squashed, nothing new",
		);
		expect(connectorLine(shape({ code: "S5" }), toRead(1, 1))).toBe(
			"Squashed · 1 file, 1 cluster to read",
		);
	});
	it("the head moved back: the reviewed clusters gone", () => {
		expect(connectorLine(shape({ code: "S6" }), toRead(0, 0, 4))).toBe(
			"Head moved back: 4 reviewed clusters gone",
		);
		expect(connectorLine(shape({ code: "S6" }), toRead(0, 0, 1))).toBe(
			"Head moved back: 1 reviewed cluster gone",
		);
		expect(connectorLine(shape({ code: "S6" }), toRead(0, 0, 0))).toBe(
			"Head moved back, nothing gone",
		);
		expect(connectorLine(shape({ code: "S6" }), null)).toBe("Head moved back");
	});
	it("retargeted, to the new base branch when known", () => {
		expect(connectorLine(shape({ code: "S7" }), toRead(1, 2), "main")).toBe(
			"Retargeted to main · 1 file, 2 clusters to read",
		);
		expect(connectorLine(shape({ code: "S7" }), null)).toBe("Retargeted");
	});
	it("an interdiff that couldn't be built: everything is new to read", () => {
		expect(
			connectorLine(
				shape({ code: "S4c", virtualRebase: "unrelated", virtualHead: null }),
				toRead(9, 41),
			),
		).toBe("Rebased, no interdiff · 9 files, 41 clusters to read");
	});
});

describe("connectorTone", () => {
	it("yellow for something to read, green for nothing new, red for conflicts or removals", () => {
		expect(connectorTone(shape(), toRead(1, 1))).toBe("warn");
		expect(connectorTone(shape({ code: "S4a" }), toRead(0, 0))).toBe("ok");
		expect(connectorTone(shape({ code: "S4b", conflicts: ["a"] }), null)).toBe(
			"bad",
		);
		expect(connectorTone(shape({ code: "S6" }), toRead(0, 0, 2))).toBe("bad");
		// Unknown until the engine answers: the pending tone.
		expect(connectorTone(shape(), null)).toBe("warn");
	});
});

describe("commitsLabel", () => {
	it("counts commits, bare on a phone", () => {
		expect(commitsLabel(3, false)).toBe("3 commits");
		expect(commitsLabel(1, false)).toBe("1 commit");
		expect(commitsLabel(3, true)).toBe("3");
	});
});
