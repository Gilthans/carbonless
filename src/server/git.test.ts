import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { killDetachedGits, runGit } from "./git";

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

	/** A timed git whose alias leaves a grandchild, its pid in `pidFile`. */
	const hanging = (pidFile: string) => [
		"-c",
		`alias.hang=!sleep 30 & echo $! > '${pidFile}'; wait`,
		"hang",
	];
	const pidOf = async (pidFile: string) => {
		await expect
			.poll(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim(), {
				timeout: 5000,
				interval: 20,
			})
			.toBeTruthy();
		return Number(readFileSync(pidFile, "utf8").trim());
	};

	it("kills timed gits still running when crb shuts down (Ctrl-C misses their group)", async () => {
		const pidFile = join(dir, "shutdown.pid");
		const run = runGit(".", hanging(pidFile), { timeoutMs: 30_000 });
		const pid = await pidOf(pidFile);
		expect(alive(pid)).toBe(true);
		killDetachedGits();
		await expect(run).rejects.toThrow();
		await expect
			.poll(() => alive(pid), { timeout: 2000, interval: 50 })
			.toBe(false);
	});

	it("kills them when the process exits, however it exits", async () => {
		const pidFile = join(dir, "exit.pid");
		const script = join(dir, "exit.mts");
		writeFileSync(
			script,
			`import { readFileSync } from "node:fs";
import { runGit } from ${JSON.stringify(join(process.cwd(), "src/server/git.ts"))};
runGit(".", ${JSON.stringify(hanging(pidFile))}, { timeoutMs: 30_000 }).catch(() => {});
const wait = setInterval(() => {
	try {
		if (readFileSync(${JSON.stringify(pidFile)}, "utf8").trim()) {
			clearInterval(wait);
			process.exit(0);
		}
	} catch {}
}, 20);
`,
		);
		execFileSync(join(process.cwd(), "node_modules/.bin/tsx"), [script], {
			timeout: 20_000,
		});
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		await expect
			.poll(() => alive(pid), { timeout: 2000, interval: 50 })
			.toBe(false);
	});

	it("stops git when aborted, and never starts it once aborted", async () => {
		const stop = new AbortController();
		const started = Date.now();
		const run = runGit(".", slow, { signal: stop.signal });
		setTimeout(() => stop.abort(), 100);
		await expect(run).rejects.toThrow(/stopped/);
		expect(Date.now() - started).toBeLessThan(3000);
		await expect(
			runGit(".", ["rev-parse", "HEAD"], { signal: stop.signal }),
		).rejects.toThrow(/stopped/);
		expect(
			await runGit(".", ["rev-parse", "HEAD"], {
				signal: stop.signal,
				allowFailure: true,
			}),
		).toBe("");
	});
});
