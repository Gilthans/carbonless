import { describe, expect, it } from "vitest";
import { RefusalStore, refusalsKey, type StoredRefusal } from "./refusals";

function memoryStorage(): Storage {
	const data = new Map<string, string>();
	return {
		get length() {
			return data.size;
		},
		clear: () => data.clear(),
		getItem: (k) => data.get(k) ?? null,
		key: (i) => [...data.keys()][i] ?? null,
		removeItem: (k) => {
			data.delete(k);
		},
		setItem: (k, v) => {
			data.set(k, v);
		},
	};
}

const KEY = refusalsKey({ owner: "o", repo: "r", number: 1 });
const refusal = (more: Partial<StoredRefusal> = {}): StoredRefusal => ({
	threadId: "T1",
	key: "resolve",
	action: "Resolve",
	message: "no",
	resolved: true,
	at: "2026-01-01T00:00:00.000Z",
	...more,
});

describe("RefusalStore", () => {
	it("keeps refusals per PR across a reload; a repeat replaces, a settled one goes", () => {
		const storage = memoryStorage();
		const a = new RefusalStore(() => storage);
		a.bind(KEY);
		a.put(refusal());
		a.put(refusal({ message: "still no" }));
		a.put(refusal({ threadId: "T2", key: "delete:c2", action: "Delete" }));
		const b = new RefusalStore(() => storage);
		b.bind(KEY);
		expect(b.get().map((r) => [r.threadId, r.message])).toEqual([
			["T1", "still no"],
			["T2", "no"],
		]);
		b.remove("T1", "resolve");
		b.remove("T2", "delete:c2");
		expect(storage.getItem(KEY)).toBeNull();
		expect(b.durable()).toBe(true);
	});

	it("writes on top of what storage holds (another tab's stay)", () => {
		const storage = memoryStorage();
		const a = new RefusalStore(() => storage);
		const b = new RefusalStore(() => storage);
		a.bind(KEY);
		b.bind(KEY);
		a.put(refusal());
		b.put(refusal({ threadId: "T2" }));
		expect(
			new Set(
				JSON.parse(storage.getItem(KEY) ?? "[]").map(
					(r: StoredRefusal) => r.threadId,
				),
			),
		).toEqual(new Set(["T1", "T2"]));
	});

	it("skips what isn't a refusal, and falls back to memory where storage throws", () => {
		const storage = memoryStorage();
		storage.setItem(KEY, JSON.stringify([refusal(), { threadId: "T9" }, 3]));
		const a = new RefusalStore(() => storage);
		a.bind(KEY);
		expect(a.get()).toHaveLength(1);
		const broken = new RefusalStore(() => {
			throw new Error("blocked");
		});
		broken.bind(KEY);
		broken.put(refusal());
		expect(broken.get()).toHaveLength(1);
		expect(broken.durable()).toBe(false);
	});
});

describe("RefusalStore: a refused verdict", () => {
	it("keeps its event across a reload, and skips one without a known event", () => {
		const storage = memoryStorage();
		const a = new RefusalStore(() => storage);
		a.bind(KEY);
		a.put(
			refusal({
				threadId: "verdict",
				key: "verdict",
				action: "Verdict",
				event: "REQUEST_CHANGES",
				code: "pending-review",
				url: "https://github.com/o/r/pull/1/files",
				resolved: undefined,
			}),
		);
		const b = new RefusalStore(() => storage);
		b.bind(KEY);
		expect(b.get()).toEqual([
			expect.objectContaining({
				threadId: "verdict",
				action: "Verdict",
				event: "REQUEST_CHANGES",
				code: "pending-review",
			}),
		]);
		storage.setItem(
			KEY,
			JSON.stringify([
				refusal({ threadId: "verdict", key: "verdict", action: "Verdict" }),
				refusal({
					threadId: "verdict",
					key: "verdict",
					action: "Verdict",
					event: "MERGE" as never,
				}),
			]),
		);
		const c = new RefusalStore(() => storage);
		c.bind(KEY);
		expect(c.get()).toEqual([]);
	});
});
