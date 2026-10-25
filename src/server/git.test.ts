import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runGit } from "./git";

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("runGit timeoutMs", () => {
	// A shell alias stands in for a fetch that hangs.
	const slow = ["-c", "alias.slow=!sleep 5", "slow"];
	const dir = mkdtempSync(join(tmpdir(), "crb-git-test-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

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

	it("kills git's own children too (a helper that hangs)", async () => {
		const pidFile = join(dir, "sleep.pid");
		// git → sh (the alias) → sleep, a grandchild that writes its pid.
		const hang = [
			"-c",
			`alias.hang=!sleep 30 & echo $! > '${pidFile}'; wait`,
			"hang",
		];
		await expect(runGit(".", hang, { timeoutMs: 500 })).rejects.toThrow(
			/timed out/,
		);
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		expect(pid).toBeGreaterThan(0);
		await expect
			.poll(() => alive(pid), { timeout: 2000, interval: 50 })
			.toBe(false);
	});
});
