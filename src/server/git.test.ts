import { describe, expect, it } from "vitest";
import { runGit } from "./git";

describe("runGit timeoutMs", () => {
	// A shell alias stands in for a fetch that hangs.
	const slow = ["-c", "alias.slow=!sleep 5", "slow"];

	it("kills git after the timeout and fails", async () => {
		const start = Date.now();
		await expect(runGit(".", slow, { timeoutMs: 200 })).rejects.toThrow(
			/timed out/,
		);
		expect(Date.now() - start).toBeLessThan(3000);
	});

	it("resolves empty with allowFailure", async () => {
		expect(
			await runGit(".", slow, { timeoutMs: 200, allowFailure: true }),
		).toBe("");
	});
});
