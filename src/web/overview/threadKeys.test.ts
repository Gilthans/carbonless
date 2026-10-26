import { describe, expect, it } from "vitest";
import { threadKeys } from "./threadKeys";

const t = (path: string, createdAt: string, author: string) => ({
	path,
	createdAt,
	author,
});

describe("threadKeys", () => {
	it("keys by path, opening time and author, stable across order", () => {
		const a = t("a.ts", "2026-01-01T00:00:00Z", "rev1");
		const b = t("a.ts", "2026-01-01T00:00:00Z", "rev2");
		const c = t("a.ts", "2026-01-02T00:00:00Z", "rev1");
		const keys = new Map(threadKeys([a, b, c]).map(([k, x]) => [x, k]));
		expect(new Set(keys.values()).size).toBe(3);
		const reordered = new Map(threadKeys([c, a, b]).map(([k, x]) => [x, k]));
		expect(reordered).toEqual(keys);
	});

	it("numbers threads that share all three apart", () => {
		const a = t("a.ts", "2026-01-01T00:00:00Z", "rev1");
		const keys = threadKeys([a, { ...a }, { ...a }]).map(([k]) => k);
		expect(new Set(keys).size).toBe(3);
		expect(keys[0]).not.toContain(`${String.fromCharCode(0)}1`);
	});
});

describe("threadKeys with ids", () => {
	it("keys by id, so threads of one submission keep theirs when reordered", () => {
		const a = { ...t("a.ts", "2026-01-01T00:00:00Z", "rev1"), id: "T1" };
		const b = { ...t("a.ts", "2026-01-01T00:00:00Z", "rev1"), id: "T2" };
		const keys = new Map(threadKeys([a, b]).map(([k, x]) => [x, k]));
		const reordered = new Map(threadKeys([b, a]).map(([k, x]) => [x, k]));
		expect(reordered).toEqual(keys);
		expect(new Set(keys.values()).size).toBe(2);
	});
});
