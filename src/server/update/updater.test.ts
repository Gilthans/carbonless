import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Install } from "./install";
import { RegistryError } from "./registry";
import type { HelperConfig } from "./updateHelper";
import {
	CHECK_EVERY_MS,
	serveChecksOff,
	UpdateRefusedError,
	Updater,
	type UpdaterOptions,
	updaterFor,
} from "./updater";

const BUILD = { version: "0.2.0", commit: "a".repeat(40) };
const NPM: Install = {
	pm: "npm",
	root: "/home/me/.npm-global/lib/node_modules/carbonless-review",
	home: "/home/me/.npm-global",
	writable: true,
	packages: ["/home/me/.npm-global/lib/node_modules/carbonless-review"],
	scan: [],
};

let dir: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "crb-updater-"));
	saved = {
		state: process.env.XDG_STATE_HOME,
		cache: process.env.XDG_CACHE_HOME,
	};
	process.env.XDG_STATE_HOME = join(dir, "state");
	process.env.XDG_CACHE_HOME = join(dir, "cache");
});
afterEach(() => {
	for (const [k, v] of [
		["XDG_STATE_HOME", saved.state],
		["XDG_CACHE_HOME", saved.cache],
	] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dir, { recursive: true, force: true });
});

function updater(over: Partial<UpdaterOptions> = {}) {
	const exits: number[] = [];
	const helpers: HelperConfig[] = [];
	const checks: string[] = [];
	const channels: string[] = [];
	const u = new Updater({
		build: BUILD,
		enabled: true,
		install: NPM,
		check: async (current, channel) => {
			checks.push(current);
			channels.push(channel);
			return "0.3.0";
		},
		service: async () => null,
		exit: (code) => exits.push(code),
		port: () => 5123,
		argv: ["serve", "--port", "0", "--new-key"],
		cwd: "/somewhere",
		env: { PATH: "/bin", GH_TOKEN: "t" },
		startHelper: async (c) => {
			helpers.push(c);
		},
		resultFile: join(dir, "result.json"),
		channelFile: join(dir, "channel"),
		logFile: join(dir, "update.log"),
		platform: "linux",
		execPath: "/usr/bin/node",
		execArgv: ["--max-old-space-size=4096"],
		exists: () => false,
		serveLog: join(dir, "serve.log"),
		graceMs: 10,
		...over,
	});
	return { u, exits, helpers, checks, channels };
}

/** Waits for the check under way (start()'s), without starting another. */
const settle = async (u: Updater) => {
	await u.settled();
};

describe("Updater", () => {
	it("off (not from npm, or switched off): never asks, never offers", async () => {
		const { u, checks } = updater({ enabled: false });
		await u.start();
		expect(checks).toEqual([]);
		expect(u.info()).toMatchObject({
			available: null,
			oneClick: false,
			state: "idle",
		});
		await expect(u.update("0.3.0")).rejects.toBeInstanceOf(UpdateRefusedError);
		u.stop();
	});

	it("offers the newer version with its release page and command", async () => {
		const { u, checks } = updater();
		await u.start();
		await settle(u);
		expect(checks[0]).toBe("0.2.0");
		expect(u.info()).toEqual({
			current: "0.2.0",
			available: "0.3.0",
			releaseUrl: "https://github.com/Gilthans/carbonless/releases/tag/v0.3.0",
			oneClick: true,
			command: "npm install -g carbonless-review@0.3.0",
			state: "idle",
			failed: null,
			commit: BUILD.commit,
			channel: "latest",
			install: "npm",
			byHand: false,
			lastChecked: expect.any(String),
			checkError: null,
			checksOff: null,
		});
		u.stop();
	});

	it("the channel: rc once a prerelease ran here, kept after rc moves onto a release", async () => {
		const release = updater();
		await release.u.start();
		await settle(release.u);
		expect(release.channels[0]).toBe("latest");
		release.u.stop();
		const rc = updater({
			build: { version: "0.3.0-rc.2", commit: "a".repeat(40) },
		});
		await rc.u.start();
		await settle(rc.u);
		expect(rc.channels[0]).toBe("rc");
		expect(readFileSync(join(dir, "channel"), "utf8").trim()).toBe("rc");
		rc.u.stop();
		// Updated to the release rc moved onto: still rc.
		const after = updater({
			build: { version: "0.3.0", commit: "a".repeat(40) },
		});
		await after.u.start();
		await settle(after.u);
		expect(after.channels[0]).toBe("rc");
		after.u.stop();
	});

	it("config's updates.channel wins: rc for an @rc install first run on a release; latest over a remembered rc", async () => {
		const first = updater({ channel: "rc" });
		await first.u.start();
		await settle(first.u);
		expect(first.channels[0]).toBe("rc");
		first.u.stop();
		writeFileSync(join(dir, "channel"), "rc\n");
		const back = updater({ channel: "latest" });
		await back.u.start();
		await settle(back.u);
		expect(back.channels[0]).toBe("latest");
		back.u.stop();
	});

	it("checks again on the timer; a failed check keeps what was found", async () => {
		vi.useFakeTimers();
		try {
			let answer: string | null = "0.3.0";
			const { u, checks } = updater({
				check: async (c) => {
					checks.push(c);
					return answer;
				},
				checkEveryMs: 1000,
			});
			await u.start();
			await settle(u);
			answer = null;
			await vi.advanceTimersByTimeAsync(1000);
			expect(checks).toHaveLength(2);
			expect(u.info().available).toBe("0.3.0");
			answer = "0.4.0";
			await vi.advanceTimersByTimeAsync(1000);
			expect(u.info().available).toBe("0.4.0");
			u.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("checks every hour", () => {
		expect(CHECK_EVERY_MS).toBe(60 * 60_000);
	});

	it("checkNow: records when it checked and why it failed; a success clears the failure", async () => {
		let fail = true;
		let t = Date.parse("2026-11-12T10:00:00Z");
		const { u } = updater({
			check: async () => {
				if (fail) throw new RegistryError("Registry answered 503");
				return "0.3.0";
			},
			now: () => new Date(t),
		});
		expect(u.info()).toMatchObject({ lastChecked: null, checkError: null });
		await u.checkNow();
		expect(u.info()).toMatchObject({
			available: null,
			lastChecked: "2026-11-12T10:00:00.000Z",
			checkError: "Registry answered 503",
		});
		fail = false;
		t += 60_000;
		await u.checkNow();
		expect(u.info()).toMatchObject({
			available: "0.3.0",
			lastChecked: "2026-11-12T10:01:00.000Z",
			checkError: null,
		});
		// Not a RegistryError: a generic reason, never the error's own text.
		fail = true;
		const odd = updater({
			check: async () => {
				throw new Error("secret /home/me/path");
			},
		});
		await odd.u.checkNow();
		expect(odd.u.info().checkError).toBe("Registry check failed");
	});

	it("checkNow: concurrent calls share one check", async () => {
		let release: (v: string | null) => void = () => {};
		let asked = 0;
		const { u } = updater({
			check: () => {
				asked++;
				return new Promise((r) => {
					release = r;
				});
			},
		});
		const a = u.checkNow();
		const b = u.checkNow();
		expect(asked).toBe(1);
		release("0.3.0");
		await Promise.all([a, b]);
		expect(u.info().available).toBe("0.3.0");
		// Once done, the next asks again.
		const c = u.checkNow();
		expect(asked).toBe(2);
		release(null);
		await c;
	});

	it("checkNow leaves the hourly timer alone", async () => {
		vi.useFakeTimers();
		try {
			const { u, checks } = updater({ checkEveryMs: 1000 });
			await u.start();
			await settle(u);
			expect(checks).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(600);
			await u.checkNow();
			expect(checks).toHaveLength(2);
			// The timer's next tick is still at 1000, not 600 + 1000.
			await vi.advanceTimersByTimeAsync(400);
			expect(checks).toHaveLength(3);
			await vi.advanceTimersByTimeAsync(1000);
			expect(checks).toHaveLength(4);
			u.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("only a strictly newer semver is offered, whatever the check returns", async () => {
		for (const bad of ["0.2.0", "0.1.0", "latest", "1.0.0 && rm -rf /"]) {
			const { u } = updater({ check: async () => bad });
			await u.checkNow();
			expect(u.info().available).toBe(null);
		}
	});

	it("info tells the channel, the install and the commit", async () => {
		const { u } = updater();
		await u.start();
		await settle(u);
		expect(u.info()).toMatchObject({
			commit: BUILD.commit,
			channel: "latest",
			install: "npm",
			byHand: false,
			checksOff: null,
		});
		u.stop();
		const rc = updater({
			build: { version: "0.3.0-rc.1", commit: BUILD.commit },
			install: null,
		});
		expect(rc.u.info()).toMatchObject({
			channel: "rc",
			install: null,
			byHand: true,
		});
	});

	it("off: says why, never checks, and info has no install", async () => {
		for (const off of ["local-build", "env", "config"] as const) {
			const { u, checks } = updater({ enabled: false, off });
			await u.start();
			await u.checkNow();
			expect(checks).toEqual([]);
			expect(u.info()).toMatchObject({
				checksOff: off,
				install: null,
				byHand: false,
				lastChecked: null,
			});
		}
		expect(updater({ enabled: false }).u.info().checksOff).toBe("local-build");
	});

	it("unknown install: the command, no one-click", async () => {
		const { u } = updater({ install: null });
		await u.start();
		await settle(u);
		expect(u.info()).toMatchObject({
			oneClick: false,
			command: "npm install -g carbonless-review@0.3.0",
		});
		await expect(u.update("0.3.0")).rejects.toThrow(/by hand/);
		u.stop();
	});

	it("installs only the version on offer", async () => {
		const { u, helpers } = updater();
		await u.start();
		await settle(u);
		await expect(u.update("0.4.0")).rejects.toBeInstanceOf(UpdateRefusedError);
		await expect(u.update("0.1.0")).rejects.toBeInstanceOf(UpdateRefusedError);
		expect(helpers).toEqual([]);
		u.stop();
	});

	it("Update: a helper installs and starts crb again as it was, on its port; then crb exits", async () => {
		const { u, helpers, exits } = updater();
		await u.start();
		await settle(u);
		const info = await u.update("0.3.0");
		expect(info.state).toBe("restarting");
		expect(helpers).toEqual([
			{
				pid: process.pid,
				waitMs: 60_000,
				version: "0.3.0",
				install: {
					command: "npm",
					args: [
						"install",
						"-g",
						"--prefix",
						"/home/me/.npm-global",
						"carbonless-review@0.3.0",
					],
					env: { PATH: "/usr/bin:/bin" },
				},
				display: "npm install -g carbonless-review@0.3.0",
				relaunch: {
					execPath: "/usr/bin/node",
					execArgv: ["--max-old-space-size=4096"],
					args: ["serve", "--port", "5123"],
					cli: "/home/me/.npm-global/lib/node_modules/carbonless-review/dist/cli.js",
					packages: ["/home/me/.npm-global/lib/node_modules/carbonless-review"],
					scan: [],
					cwd: "/somewhere",
					env: { PATH: "/bin", GH_TOKEN: "t" },
					log: join(dir, "serve.log"),
				},
				log: join(dir, "update.log"),
				result: join(dir, "result.json"),
			},
		]);
		// A second tab's click: the same update, nothing new started.
		expect((await u.update("0.3.0")).state).toBe("restarting");
		expect(helpers).toHaveLength(1);
		await vi.waitFor(() => expect(exits).toEqual([0]));
		u.stop();
	});

	it("pnpm on Windows: its pnpm.cmd; the relaunch is node on the new cli.js, found in pnpm's global dir", async () => {
		const home = "C:\\Users\\Jane Doe\\AppData\\Local\\pnpm";
		const { u, helpers } = updater({
			platform: "win32",
			execPath: "C:\\node\\node.exe",
			exists: (f) => f === `${home}\\pnpm.cmd`,
			env: { Path: "C:\\bin" },
			install: {
				pm: "pnpm",
				root: `${home}\\global\\5\\node_modules\\.pnpm\\x\\node_modules\\carbonless-review`,
				home,
				writable: true,
				packages: [`${home}\\global\\5\\node_modules\\carbonless-review`],
				scan: [`${home}\\global\\5`],
			},
		});
		await u.start();
		await settle(u);
		await u.update("0.3.0");
		expect(helpers[0]?.install).toEqual({
			command: `${home}\\pnpm.cmd`,
			args: [
				"add",
				"-g",
				"carbonless-review@0.3.0",
				"--config.minimumReleaseAgeExclude=carbonless-review",
			],
			env: { PNPM_HOME: home, Path: `${home};C:\\node;C:\\bin` },
		});
		expect(helpers[0]?.relaunch).toMatchObject({
			execPath: "C:\\node\\node.exe",
			scan: [`${home}\\global\\5`],
		});
		expect(helpers[0]?.display).toBe(
			"pnpm add -g carbonless-review@0.3.0 --config.minimumReleaseAgeExclude=carbonless-review",
		);
		u.stop();
	});

	it("an install crb can't write (a system prefix): the command, no one-click", async () => {
		const { u } = updater({ install: { ...NPM, writable: false } });
		await u.start();
		await settle(u);
		expect(u.info()).toMatchObject({
			oneClick: false,
			command: "npm install -g carbonless-review@0.3.0",
		});
		await expect(u.update("0.3.0")).rejects.toBeInstanceOf(UpdateRefusedError);
		u.stop();
	});

	it("after a failed update, Update again is allowed", async () => {
		const { u, helpers } = updater({
			service: async () => ({ manager: "pm2", exitCode: 75 }),
			run: async () => ({ code: 1, output: "E404" }),
		});
		await u.start();
		await settle(u);
		await u.update("0.3.0");
		await vi.waitFor(() => expect(u.info().failed).not.toBeNull());
		expect((await u.update("0.3.0")).state).toBe("installing");
		expect(helpers).toEqual([]);
		u.stop();
	});

	it("a helper that can't start: idle again, the error to the page", async () => {
		const { u, exits } = updater({
			startHelper: async () => {
				throw new Error("EACCES");
			},
		});
		await u.start();
		await settle(u);
		await expect(u.update("0.3.0")).rejects.toThrow("EACCES");
		expect(u.info().state).toBe("idle");
		expect(exits).toEqual([]);
		u.stop();
	});

	it("under a service manager: installs while serving, then exits for the manager to restart it", async () => {
		let finish: (r: { code: number; output: string }) => void = () => {};
		const ran: string[][] = [];
		const timeouts: (number | undefined)[] = [];
		const { u, exits, helpers } = updater({
			service: async () => ({ manager: "systemd (crb.service)", exitCode: 75 }),
			run: (c, _log, opts) => {
				ran.push([c.command, ...c.args]);
				timeouts.push(opts?.timeoutMs);
				return new Promise((r) => {
					finish = r;
				});
			},
		});
		await u.start();
		await settle(u);
		expect((await u.update("0.3.0")).state).toBe("installing");
		expect(ran).toEqual([
			[
				"npm",
				"install",
				"-g",
				"--prefix",
				"/home/me/.npm-global",
				"carbonless-review@0.3.0",
			],
		]);
		expect(u.info().state).toBe("installing");
		// A hung install doesn't keep it installing for ever.
		expect(timeouts).toEqual([600_000]);
		finish({ code: 0, output: "added 1 package" });
		await vi.waitFor(() => expect(exits).toEqual([75]));
		expect(u.info().state).toBe("restarting");
		expect(helpers).toEqual([]);
		u.stop();
	});

	it("under a service manager, a failed install: still serving, the failure with the output's tail", async () => {
		const { u, exits } = updater({
			service: async () => ({ manager: "pm2", exitCode: 75 }),
			run: async () => ({ code: 1, output: "x\nnpm error code E404\n" }),
		});
		await u.start();
		await settle(u);
		await u.update("0.3.0");
		await vi.waitFor(() => expect(u.info().state).toBe("idle"));
		expect(u.info().failed).toEqual({
			version: "0.3.0",
			tail: "x\nnpm error code E404",
			command: "npm install -g carbonless-review@0.3.0",
		});
		expect(exits).toEqual([]);
		u.stop();
	});

	it("a service that won't start crb again (Restart=no): the command, no one-click", async () => {
		const { u } = updater({
			service: async () => ({
				manager: "systemd (crb.service)",
				exitCode: null,
			}),
		});
		await u.start();
		await settle(u);
		expect(u.info().oneClick).toBe(false);
		u.stop();
	});

	it("at start, a helper's failed install is shown once (the file is consumed)", async () => {
		const file = join(dir, "result.json");
		writeFileSync(
			file,
			JSON.stringify({
				version: "0.3.0",
				ok: false,
				tail: "npm error 404",
				command: "npm install -g carbonless-review@0.3.0",
				at: "2026-11-11T00:00:00Z",
			}),
		);
		const { u } = updater();
		await u.start();
		expect(u.info().failed).toEqual({
			version: "0.3.0",
			tail: "npm error 404",
			command: "npm install -g carbonless-review@0.3.0",
		});
		expect(existsSync(file)).toBe(false);
		u.stop();
	});

	it("at start, the version the helper installed running: nothing to show", async () => {
		const file = join(dir, "result.json");
		writeFileSync(
			file,
			JSON.stringify({ version: "0.2.0", ok: true, tail: "", command: "c" }),
		);
		const { u } = updater();
		await u.start();
		expect(u.info().failed).toBeNull();
		expect(existsSync(file)).toBe(false);
		u.stop();
	});

	it("at start, an install that said ok but the old version came back: a failure", async () => {
		writeFileSync(
			join(dir, "result.json"),
			JSON.stringify({ version: "0.3.0", ok: true, tail: "", command: "c" }),
		);
		const { u } = updater();
		await u.start();
		expect(u.info().failed?.tail).toBe(
			"Installed 0.3.0, but crb 0.2.0 started again",
		);
		u.stop();
	});

	it("logs a service's install to the cache dir", async () => {
		const { u } = updater({
			service: async () => ({ manager: "pm2", exitCode: 75 }),
			run: async (_c, log) => {
				log("installing...\n");
				return { code: 1, output: "" };
			},
		});
		await u.start();
		await settle(u);
		await u.update("0.3.0");
		await vi.waitFor(() =>
			expect(readFileSync(join(dir, "update.log"), "utf8")).toContain(
				"installing...",
			),
		);
		u.stop();
	});
});

describe("why checks are off", () => {
	const make = (off: Parameters<typeof updaterFor>[0]["off"], env = {}) =>
		updaterFor({
			build: BUILD,
			off,
			exit: () => {},
			port: () => 0,
			env,
		}).info().checksOff;

	it("updaterFor: the given reason first, then the env, then a build npm didn't serve", () => {
		// This checkout is no npm install: a local build.
		expect(make(null)).toBe("local-build");
		expect(make(null, { CRB_NO_UPDATE_CHECK: "1" })).toBe("env");
		expect(make(null, { CRB_NO_UPDATE_CHECK: "0" })).toBe("local-build");
		expect(make("config", { CRB_NO_UPDATE_CHECK: "1" })).toBe("config");
		expect(make("unavailable")).toBe("unavailable");
	});

	it("crb serve: no restart hook is unavailable, updates.check false is config", () => {
		expect(serveChecksOff({ canRestart: false, configCheck: true })).toBe(
			"unavailable",
		);
		expect(serveChecksOff({ canRestart: false, configCheck: false })).toBe(
			"unavailable",
		);
		expect(serveChecksOff({ canRestart: true, configCheck: false })).toBe(
			"config",
		);
		expect(serveChecksOff({ canRestart: true, configCheck: true })).toBe(null);
	});
});
