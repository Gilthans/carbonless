import { describe, expect, it } from "vitest";
import { openedOn } from "./openedOn.js";

const ps = [
	{ number: 1, startedAt: Date.parse("2026-11-01T10:00:00Z") },
	{ number: 2, startedAt: Date.parse("2026-11-03T10:00:00Z") },
	{ number: 3, startedAt: Date.parse("2026-11-05T10:00:00Z") },
];

describe("openedOn", () => {
	it("is the patch set whose window [start, next start) holds the time", () => {
		expect(openedOn("2026-11-01T10:00:00Z", ps)).toBe(1);
		expect(openedOn("2026-11-02T00:00:00Z", ps)).toBe(1);
		expect(openedOn("2026-11-03T10:00:00Z", ps)).toBe(2);
		expect(openedOn("2026-11-04T23:59:59Z", ps)).toBe(2);
		expect(openedOn("2026-12-01T00:00:00Z", ps)).toBe(3);
	});
	it("counts a thread older than PS1 as PS1", () => {
		expect(openedOn("2026-10-01T00:00:00Z", ps)).toBe(1);
	});
	it("is null with no patch set, or no time", () => {
		expect(openedOn("2026-11-02T00:00:00Z", [])).toBeNull();
		expect(openedOn("", ps)).toBeNull();
	});
	it("doesn't depend on the order the patch sets come in", () => {
		expect(openedOn("2026-11-04T00:00:00Z", [...ps].reverse())).toBe(2);
	});
});
