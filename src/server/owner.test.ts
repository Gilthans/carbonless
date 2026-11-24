import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ownerToken } from "../../scripts/owner.mjs";
import { ownerAlive, watchOwner } from "./owner";

describe("owner", () => {
	// A test that timed out on a fake clock leaks it to none after.
	afterEach(() => vi.useRealTimers());

	it("is alive only while its pid runs with the start time in the token", () => {
		expect(ownerAlive(ownerToken(process.pid))).toBe(true);
		// The pid now belongs to another process (pid reuse).
		expect(ownerAlive(`${process.pid} 1`)).toBe(false);
		const gone = spawnSync("true").pid as number;
		expect(ownerAlive(ownerToken(gone))).toBe(false);
		expect(ownerAlive("")).toBe(false);
	});

	it("calls back once the owner ends", async () => {
		// The poll on a fake clock (moving with real time until the owner is
		// gone), so the polls after are counted, not raced.
		vi.useFakeTimers({
			shouldAdvanceTime: true,
			toFake: ["setInterval", "clearInterval"],
		});
		try {
			const owner = spawn("sleep", ["60"]);
			const token = ownerToken(owner.pid as number);
			let calls = 0;
			const gone = new Promise<void>((done) =>
				watchOwner(
					() => {
						calls++;
						done();
					},
					token,
					20,
				),
			);
			expect(calls).toBe(0);
			owner.kill("SIGKILL");
			await gone;
			// Fifty polls more: no second call.
			vi.advanceTimersByTime(1000);
			expect(calls).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
