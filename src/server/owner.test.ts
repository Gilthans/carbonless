import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ownerToken } from "../../scripts/owner.mjs";
import { quietFor } from "../../test/sleep";
import { ownerAlive, watchOwner } from "./owner";

describe("owner", () => {
	it("is alive only while its pid runs with the start time in the token", () => {
		expect(ownerAlive(ownerToken(process.pid))).toBe(true);
		// The pid now belongs to another process (pid reuse).
		expect(ownerAlive(`${process.pid} 1`)).toBe(false);
		const gone = spawnSync("true").pid as number;
		expect(ownerAlive(ownerToken(gone))).toBe(false);
		expect(ownerAlive("")).toBe(false);
	});

	it("calls back once the owner ends", async () => {
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
		await quietFor(100, "a second call of the gone-owner callback");
		expect(calls).toBe(1);
	});
});
