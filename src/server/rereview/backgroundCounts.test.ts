import { describe, expect, it } from "vitest";
import { BackgroundCounts, COUNT_TRIES } from "./backgroundCounts";

/** A count whose answers the test settles by hand. */
function manual() {
	const calls: { resolve: (n: number) => void; reject: (e: Error) => void }[] =
		[];
	const count = (_key: string) =>
		new Promise<number>((resolve, reject) => {
			calls.push({ resolve, reject });
		});
	return { calls, count };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("BackgroundCounts", () => {
	it("starts one count per key however many reads ask while it runs, and answers it once in", async () => {
		const { calls, count } = manual();
		const counts = new BackgroundCounts(count, () => 0);
		expect(counts.get("k")).toBeNull();
		expect(counts.get("k")).toBeNull();
		expect(counts.get("k")).toBeNull();
		expect(calls).toHaveLength(1);
		calls[0]?.resolve(4);
		await tick();
		expect(counts.get("k")).toBe(4);
		expect(calls).toHaveLength(1);
	});

	it("after a failure waits, then tries again; a retry that works answers", async () => {
		const { calls, count } = manual();
		let now = 0;
		const counts = new BackgroundCounts(count, () => now);
		counts.get("k");
		calls[0]?.reject(new Error("busy"));
		await tick();
		// Still pending, and no new spawn before the backoff is over.
		expect(counts.get("k")).toBeNull();
		expect(calls).toHaveLength(1);
		now += 60_000;
		expect(counts.get("k")).toBeNull();
		expect(calls).toHaveLength(2);
		calls[1]?.resolve(2);
		await tick();
		expect(counts.get("k")).toBe(2);
	});

	it(`gives up after ${COUNT_TRIES} failures: the answer says why, and nothing runs again`, async () => {
		const { calls, count } = manual();
		let now = 0;
		const counts = new BackgroundCounts(count, () => now);
		for (let i = 0; i < COUNT_TRIES; i++) {
			counts.get("k");
			calls[i]?.reject(new Error("Not an object id: x"));
			await tick();
			now += 600_000;
		}
		expect(counts.get("k")).toEqual({ error: "Not an object id: x" });
		now += 600_000;
		expect(counts.get("k")).toEqual({ error: "Not an object id: x" });
		expect(calls).toHaveLength(COUNT_TRIES);
	});
});
