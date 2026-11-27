import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config";
import { pushMailbox } from "../src/server/telemetry/mailbox";
import { createBareRepo, GIT_TEST_TIMEOUTS } from "../test/git-fixture";
import { pull } from "./telemetry";
import { isServerDir } from "./test-profile/server";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

describe("pnpm telemetry pull", () => {
	let remote: { path: string; cleanup: () => void };
	let work: string;

	const pushAs = async (device: string, traceName: string) => {
		const traces = join(work, `traces-${device}`);
		mkdirSync(traces, { recursive: true });
		writeFileSync(join(traces, traceName), '{"resourceSpans":[]}\n');
		const telemetry = { mailbox: remote.path, device, every: 15 };
		// One state dir per device, as on two machines.
		process.env.XDG_STATE_HOME = join(work, `state-${device}`);
		const r = await pushMailbox({
			telemetry,
			config: { ...DEFAULT_CONFIG, telemetry },
			traceDir: traces,
			by: "cli",
		});
		expect(r.status?.ok).toBe(true);
	};

	let savedState: string | undefined;
	beforeEach(() => {
		savedState = process.env.XDG_STATE_HOME;
		remote = createBareRepo();
		work = mkdtempSync(join(tmpdir(), "crb-telemetry-pull-"));
	});
	afterEach(() => {
		process.env.XDG_STATE_HOME = savedState;
		remote.cleanup();
		rmSync(work, { recursive: true, force: true });
	});

	it("lays each device's snapshot out where test-profile reads it", async () => {
		await pushAs("laptop", "crb-1-aa.20261127.000000.jsonl");
		await pushAs("desktop", "crb-2-bb.20261127.000000.jsonl");
		// A branch that isn't a device's is never fetched.
		execFileSync("git", [
			"--git-dir",
			remote.path,
			"branch",
			"main",
			"device/laptop",
		]);

		const dir = join(work, "pulled");
		const pulled = pull({ remote: remote.path, dir });
		expect(pulled.map((p) => p.device).sort()).toEqual(["desktop", "laptop"]);
		const laptop = pulled.find((p) => p.device === "laptop");
		expect(laptop?.traces).toBe(join(dir, "devices", "laptop", "traces"));
		expect(laptop?.traceFiles).toBe(1);
		// pnpm test-profile reads it as a server's trace directory.
		expect(isServerDir(laptop?.traces ?? "")).toBe(true);
		expect(
			existsSync(join(laptop?.traces ?? "", "crb-1-aa.20261127.000000.jsonl")),
		).toBe(true);
		const state = JSON.parse(
			readFileSync(join(dir, "devices", "laptop", "state.json"), "utf8"),
		);
		expect(state.config.telemetry.device).toBe("laptop");
		expect(
			execFileSync(
				"git",
				[
					"--git-dir",
					join(dir, "mailbox.git"),
					"for-each-ref",
					"--format=%(refname)",
				],
				{ encoding: "utf8" },
			)
				.trim()
				.split("\n")
				.sort(),
		).toEqual(["refs/heads/device/desktop", "refs/heads/device/laptop"]);

		// --device: that one only; a new push replaces the old snapshot.
		await pushAs("laptop", "crb-1-aa.20261128.000001.jsonl");
		const again = pull({ remote: remote.path, dir, device: "laptop" });
		expect(again).toHaveLength(1);
		expect(again[0]?.traceFiles).toBe(2);
	});
});
