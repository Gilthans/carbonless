import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createBareRepo,
	GIT_TEST_TIMEOUTS,
	testGitEnv,
} from "../../../test/git-fixture";
import { configDir, stateDir } from "../paths";
import { defaultDevice, telemetryCli } from "./cli";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

describe("crb telemetry", () => {
	let remote: { path: string; cleanup: () => void };
	let out: string[];
	const run = (...args: string[]) => {
		out = [];
		return telemetryCli(args, (l) => out.push(l));
	};
	const remoteRefs = () =>
		execFileSync(
			"git",
			["--git-dir", remote.path, "for-each-ref", "--format=%(refname)"],
			{ encoding: "utf8", env: testGitEnv() },
		).trim();
	const config = () =>
		JSON.parse(readFileSync(join(configDir(), "config.json"), "utf8"));

	beforeEach(() => {
		remote = createBareRepo();
		mkdirSync(stateDir(), { recursive: true });
		writeFileSync(join(stateDir(), "serve.log"), "crb: started\n");
	});
	afterEach(() => {
		remote.cleanup();
		rmSync(stateDir(), { recursive: true, force: true });
		rmSync(configDir(), { recursive: true, force: true });
	});

	it("on pushes at once; status says so; send pushes again; off turns it off", async () => {
		expect(await run("status")).toBe(0);
		expect(out).toEqual(["off"]);

		expect(await run("on", remote.path, "--device", "test-box")).toBe(0);
		expect(config().telemetry).toEqual({
			mailbox: remote.path,
			device: "test-box",
			every: 15,
		});
		expect(out[0]).toContain("branch device/test-box, every 15 min");
		expect(out.join("\n")).toMatch(/last push: .*, ok, by crb telemetry send/);
		expect(remoteRefs()).toBe("refs/heads/device/test-box");

		expect(await run("status")).toBe(0);
		expect(out[0]).toBe(
			`on: ${remote.path}, branch device/test-box, every 15 min`,
		);
		expect(out.join("\n")).toMatch(/last push: .*ok/);
		expect(out.join("\n")).toMatch(/snapshot: \d+ files, \d+\.\d KB, /);

		expect(await run("send")).toBe(0);

		expect(await run("off")).toBe(0);
		expect(config().telemetry).toBeUndefined();
		expect(out.join("\n")).toContain("--delete device/test-box");
		expect(await run("send")).toBe(1);
		expect(out[0]).toMatch(/Telemetry is off/);
	});

	it("a remote that fails: on keeps it on, send and status say why", async () => {
		const missing = join(stateDir(), "missing.git");
		expect(await run("on", missing, "--device", "pc")).toBe(1);
		expect(out.join("\n")).toMatch(/FAILED/);
		expect(config().telemetry.mailbox).toBe(missing);
		expect(await run("status")).toBe(0);
		expect(out.join("\n")).toMatch(/FAILED[\s\S]*last ok: never/);
	});

	it("status says when another crb wrote this device's branch", async () => {
		expect(await run("on", remote.path, "--device", "twin")).toBe(0);
		// The other twin pushes meanwhile.
		const env = testGitEnv({
			GIT_AUTHOR_NAME: "Other",
			GIT_AUTHOR_EMAIL: "other@example.com",
			GIT_COMMITTER_NAME: "Other",
			GIT_COMMITTER_EMAIL: "other@example.com",
		});
		const git = (...args: string[]) =>
			execFileSync("git", ["--git-dir", remote.path, ...args], {
				encoding: "utf8",
				input: "",
				env,
			}).trim();
		const empty = git("hash-object", "-t", "tree", "-w", "--stdin");
		git(
			"update-ref",
			"refs/heads/device/twin",
			git("commit-tree", empty, "-m", "x"),
		);
		expect(await run("send")).toBe(0);
		expect(out.join("\n")).toMatch(
			/device\/twin had been written by another crb since this device's last push/,
		);
		expect(await run("status")).toBe(0);
		expect(out.join("\n")).toMatch(/had been written by another crb/);
	});

	it("--no-send only turns it on; bad input is refused", async () => {
		expect(await run("on", remote.path, "--no-send", "--every", "5")).toBe(0);
		expect(config().telemetry.every).toBe(5);
		expect(remoteRefs()).toBe("");
		await expect(
			run("on", remote.path, "--device", "Not Valid"),
		).rejects.toThrow(/--device/);
		await expect(run("on")).rejects.toThrow(/git remote/);
		await expect(run("on", remote.path, "--every", "abc")).rejects.toThrow(
			/--every takes minutes/,
		);
		await expect(run("off", "extra")).rejects.toThrow(/too many/);
		await expect(run("bogus")).rejects.toThrow(/unknown command/);
		expect(await run("--help")).toBe(0);
		expect(out[0]).toMatch(/^Usage: crb telemetry on/);
	});

	it("the device defaults to the machine's name, slugged", () => {
		expect(defaultDevice("Daniel's MacBook.local")).toBe(
			"daniel-s-macbook-local",
		);
		expect(defaultDevice("DESKTOP-AB12")).toBe("desktop-ab12");
		expect(defaultDevice("---")).toBe("device");
	});

	it("is a crb command", () => {
		const root = fileURLToPath(new URL("../../..", import.meta.url));
		const r = spawnSync(
			process.execPath,
			["--import", "tsx", "src/cli.ts", "telemetry", "status"],
			{ cwd: root, encoding: "utf8", env: process.env },
		);
		expect(r.stderr).toBe("");
		expect(r.stdout.trim()).toBe("off");
		expect(r.status).toBe(0);
	});
});
