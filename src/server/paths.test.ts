import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheDir, configDir, stateDir } from "./paths";

const VARS = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;
const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

describe("paths", () => {
	afterEach(() => {
		for (const v of VARS) {
			if (saved[v] === undefined) delete process.env[v];
			else process.env[v] = saved[v];
		}
	});

	it("puts carbonless under each XDG base directory", () => {
		process.env.XDG_CONFIG_HOME = "/x/config";
		process.env.XDG_STATE_HOME = "/x/state";
		process.env.XDG_CACHE_HOME = "/x/cache";
		expect(configDir()).toBe("/x/config/carbonless");
		expect(stateDir()).toBe("/x/state/carbonless");
		expect(cacheDir()).toBe("/x/cache/carbonless");
	});

	it("falls back to the XDG defaults when unset, empty or relative", () => {
		for (const value of [undefined, "", "relative/dir"]) {
			for (const v of VARS) {
				if (value === undefined) delete process.env[v];
				else process.env[v] = value;
			}
			expect(configDir()).toBe(join(homedir(), ".config", "carbonless"));
			expect(stateDir()).toBe(join(homedir(), ".local", "state", "carbonless"));
			expect(cacheDir()).toBe(join(homedir(), ".cache", "carbonless"));
		}
	});
});
