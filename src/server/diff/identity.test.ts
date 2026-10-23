import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Cluster } from "../../shared/types.js";
import { clusterKeys, contextAround } from "./identity.js";

type Unkeyed = Omit<Cluster, "key">;

const addition = (
	newStart: number,
	added: string[],
	oldStart = 0,
): Unkeyed => ({
	kind: "lines",
	oldStart,
	oldCount: 0,
	newStart,
	newCount: added.length,
	removed: [],
	added,
	lines: added.length,
});

const lines = Array.from({ length: 12 }, (_, i) => `l${i + 1}`);

describe("contextAround", () => {
	it("takes up to 3 lines either side of a changed range", () => {
		expect(contextAround(lines, { newStart: 5, newCount: 2 })).toEqual({
			before: ["l2", "l3", "l4"],
			after: ["l7", "l8", "l9"],
		});
	});

	it("pure deletion context uses the line before as the anchor", () =>
		expect(contextAround(lines, { newStart: 5, newCount: 0 })).toEqual({
			before: lines.slice(2, 5),
			after: lines.slice(5, 8),
		}));

	it("clamps at the start and end of the file", () => {
		expect(contextAround(lines, { newStart: 1, newCount: 1 })).toEqual({
			before: [],
			after: ["l2", "l3", "l4"],
		});
		expect(contextAround(lines, { newStart: 0, newCount: 0 })).toEqual({
			before: [],
			after: ["l1", "l2", "l3"],
		});
		expect(contextAround(lines, { newStart: 11, newCount: 2 })).toEqual({
			before: ["l8", "l9", "l10"],
			after: [],
		});
		expect(contextAround(lines, { newStart: 12, newCount: 0 })).toEqual({
			before: ["l10", "l11", "l12"],
			after: [],
		});
	});

	it("is empty for a deleted file", () => {
		expect(contextAround([], { newStart: 0, newCount: 0 })).toEqual({
			before: [],
			after: [],
		});
	});
});

describe("clusterKeys", () => {
	it("identical clusters in one file get distinct keys", () => {
		const newLines = ["a", "b", "c", "}", "a", "b", "c", "}", "a", "b", "c"];
		const keys = clusterKeys(
			"x.ts",
			[addition(4, ["}"], 3), addition(8, ["}"], 6)],
			newLines,
		);
		expect(new Set(keys).size).toBe(2);
		expect(keys[1]).toBe(`${keys[0]}:2`);
	});

	it("numbers the third occurrence :3", () => {
		const newLines = ["}", "}", "}"];
		const deletion = (newStart: number): Unkeyed => ({
			kind: "lines",
			oldStart: newStart + 1,
			oldCount: 1,
			newStart,
			newCount: 0,
			removed: ["x"],
			added: [],
			lines: 1,
		});
		// Same removed line and same (clamped) context every time.
		const keys = clusterKeys(
			"x.ts",
			[deletion(0), deletion(0), deletion(0)],
			newLines,
		);
		expect(keys.slice(1)).toEqual([`${keys[0]}:2`, `${keys[0]}:3`]);
	});

	it("same change with different context gets a different key", () => {
		const [a] = clusterKeys("x.ts", [addition(2, ["}"], 1)], ["a", "}", "b"]);
		const [b] = clusterKeys("x.ts", [addition(2, ["}"], 1)], ["a", "}", "c"]);
		expect(a).not.toBe(b);
	});

	it("same change in a different file gets a different key", () => {
		const [a] = clusterKeys("x.ts", [addition(1, ["}"])], ["}"]);
		const [b] = clusterKeys("y.ts", [addition(1, ["}"])], ["}"]);
		expect(a).not.toBe(b);
	});

	it("key is stable across calls", () => {
		const cluster = addition(2, ["}"], 1);
		const newLines = ["a", "}", "b"];
		const first = clusterKeys("x.ts", [cluster], newLines);
		expect(clusterKeys("x.ts", [cluster], newLines)).toEqual(first);
		const expected = createHash("sha256")
			.update(
				JSON.stringify([
					"x.ts",
					"lines",
					null,
					[],
					["}"],
					["a"],
					["b"],
					false,
					false,
					null,
				]),
			)
			.digest("hex");
		expect(first).toEqual([expected]);
	});

	it("file-level clusters hash their label and no context", () => {
		const file: Unkeyed = {
			kind: "file",
			label: "Renamed from a.ts",
			oldStart: 0,
			oldCount: 0,
			newStart: 0,
			newCount: 0,
			removed: [],
			added: [],
			lines: 0,
		};
		const [key] = clusterKeys("b.ts", [file], ["one", "two"]);
		const expected = createHash("sha256")
			.update(
				JSON.stringify([
					"b.ts",
					"file",
					"Renamed from a.ts",
					[],
					[],
					[],
					[],
					false,
					false,
					null,
				]),
			)
			.digest("hex");
		expect(key).toBe(expected);
		const [other] = clusterKeys(
			"b.ts",
			[{ ...file, label: "Renamed from c.ts" }],
			["one", "two"],
		);
		expect(other).not.toBe(key);
	});

	it("adding and removing the newline at end of file get different keys", () => {
		const change: Unkeyed = {
			kind: "lines",
			oldStart: 2,
			oldCount: 1,
			newStart: 2,
			newCount: 1,
			removed: ["b"],
			added: ["b"],
			lines: 2,
		};
		const newLines = ["a", "b"];
		const [adds] = clusterKeys(
			"x.ts",
			[{ ...change, noNewlineOld: true }],
			newLines,
		);
		const [removes] = clusterKeys(
			"x.ts",
			[{ ...change, noNewlineNew: true }],
			newLines,
		);
		expect(adds).not.toBe(removes);
	});

	it("hashes the bytes, whatever the display encoding", () => {
		const change = addition(1, ["café"]);
		const [utf8] = clusterKeys("x.ts", [change], ["café"]);
		const [latin1] = clusterKeys("x.ts", [change], ["café"], {
			encoding: "latin1",
		});
		// "é" is C3 A9 in UTF-8 but E9 in latin1: different bytes, different keys.
		expect(utf8).not.toBe(latin1);
		const [sameBytes] = clusterKeys(
			"x.ts",
			[addition(1, ["cafÃ©"])],
			["cafÃ©"],
			{
				encoding: "latin1",
			},
		);
		expect(sameBytes).toBe(utf8);
	});

	it("content OIDs separate file-level changes that share a label", () => {
		const binary: Unkeyed = {
			kind: "file",
			label: "Binary file changed",
			oldStart: 0,
			oldCount: 0,
			newStart: 0,
			newCount: 0,
			removed: [],
			added: [],
			lines: 0,
		};
		const key = (newOid: string) =>
			clusterKeys("img.bin", [binary], [], {
				contentOids: ["1".repeat(40), newOid],
			})[0];
		expect(key("2".repeat(40))).not.toBe(key("3".repeat(40)));
		expect(key("2".repeat(40))).toBe(key("2".repeat(40)));
	});
});
