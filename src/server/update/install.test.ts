import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	detectInstall,
	installCommand,
	isFromNpm,
	manualCommand,
	restartArgs,
	showCommand,
} from "./install";

const SHA = "a3bc706b8c8b834aeefb8411ee8973ab2bb57973";
const BUILD = { version: "0.2.0", commit: SHA };
const NPM_ROOT = "/usr/lib/node_modules/carbonless-review";

const reader =
	(pkg: object | string) =>
	(file: string): string => {
		expect(file).toBe(join(NPM_ROOT, "package.json"));
		return typeof pkg === "string" ? pkg : JSON.stringify(pkg);
	};

describe("isFromNpm", () => {
	const published = {
		name: "carbonless-review",
		version: "0.2.0",
		gitHead: SHA,
	};

	it("a build npm served: CI's gitHead is its commit, at its version", () => {
		expect(isFromNpm(NPM_ROOT, BUILD, reader(published))).toBe(true);
	});

	it("a local build (pnpm build, pnpm release local, a devbox following master) has no gitHead", () => {
		const { gitHead: _, ...local } = published;
		expect(isFromNpm(NPM_ROOT, BUILD, reader(local))).toBe(false);
	});

	it("a gitHead of another commit or version, another package, a dirty build: no", () => {
		expect(
			isFromNpm(
				NPM_ROOT,
				BUILD,
				reader({ ...published, gitHead: "b".repeat(40) }),
			),
		).toBe(false);
		expect(
			isFromNpm(NPM_ROOT, BUILD, reader({ ...published, version: "0.1.0" })),
		).toBe(false);
		expect(
			isFromNpm(NPM_ROOT, BUILD, reader({ ...published, name: "other" })),
		).toBe(false);
		expect(
			isFromNpm(
				NPM_ROOT,
				{ ...BUILD, commit: `${SHA}-dirty` },
				reader({ ...published, gitHead: `${SHA}-dirty` }),
			),
		).toBe(false);
		expect(isFromNpm(NPM_ROOT, BUILD, reader("not json"))).toBe(false);
	});

	it("a checkout (no node_modules in its path) never is", () => {
		expect(
			isFromNpm("/home/me/carbonless", BUILD, () => JSON.stringify(published)),
		).toBe(false);
	});
});

describe("detectInstall", () => {
	const all = () => true;
	const none = () => false;

	it("npm global: <prefix>/lib/node_modules with its crb shim; the new version lands in place", () => {
		const root =
			"/home/me/.nvm/versions/node/v24.1.0/lib/node_modules/carbonless-review";
		expect(
			detectInstall(root, {
				platform: "linux",
				exists: (f) => f === "/home/me/.nvm/versions/node/v24.1.0/bin/crb",
				writable: (d) =>
					d === "/home/me/.nvm/versions/node/v24.1.0/lib/node_modules",
			}),
		).toEqual({
			pm: "npm",
			root,
			home: "/home/me/.nvm/versions/node/v24.1.0",
			writable: true,
			packages: [root],
			scan: [],
		});
	});

	it("npm global on Windows: <prefix>\\node_modules with crb.cmd", () => {
		const root =
			"C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\carbonless-review";
		expect(
			detectInstall(root, {
				platform: "win32",
				exists: (f) =>
					f === "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\crb.cmd",
				writable: all,
			}),
		).toMatchObject({
			pm: "npm",
			home: "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm",
			writable: true,
		});
	});

	it("a prefix the reviewer can't write (a system node): no one-click", () => {
		expect(
			detectInstall("/usr/lib/node_modules/carbonless-review", {
				platform: "linux",
				exists: all,
				writable: none,
			})?.writable,
		).toBe(false);
	});

	it("pnpm global: found again after the install in its global dir (a new dir per install)", () => {
		const root =
			"/home/me/.local/share/pnpm/global/v11/88719-18e7/node_modules/.pnpm/carbonless-review@0.2.0/node_modules/carbonless-review";
		expect(
			detectInstall(root, {
				platform: "linux",
				exists: none,
				writable: (d) => d === "/home/me/.local/share/pnpm/global/v11",
			}),
		).toEqual({
			pm: "pnpm",
			root,
			home: "/home/me/.local/share/pnpm",
			writable: true,
			packages: [
				"/home/me/.local/share/pnpm/global/v11/node_modules/carbonless-review",
			],
			scan: ["/home/me/.local/share/pnpm/global/v11"],
		});
	});

	it("pnpm global on Windows, in a profile with a space", () => {
		const root =
			"C:\\Users\\Jane Doe\\AppData\\Local\\pnpm\\global\\5\\node_modules\\.pnpm\\carbonless-review@0.2.0\\node_modules\\carbonless-review";
		expect(
			detectInstall(root, { platform: "win32", exists: none, writable: all }),
		).toMatchObject({
			pm: "pnpm",
			home: "C:\\Users\\Jane Doe\\AppData\\Local\\pnpm",
			scan: ["C:\\Users\\Jane Doe\\AppData\\Local\\pnpm\\global\\5"],
		});
	});

	it("anything else is unknown: a project's dependency (even under a lib dir), a project's pnpm store, a checkout, yarn's or volta's global", () => {
		const opts = { platform: "linux" as const, exists: none, writable: all };
		for (const root of [
			"/home/me/project/node_modules/carbonless-review",
			"/home/me/x/lib/node_modules/carbonless-review",
			"/home/me/project/node_modules/.pnpm/carbonless-review@0.2.0/node_modules/carbonless-review",
			"/home/me/global/project/node_modules/.pnpm/carbonless-review@0.2.0/node_modules/carbonless-review",
			"/home/me/carbonless",
			"/home/me/.config/yarn/global/node_modules/carbonless-review",
			"/home/me/.volta/tools/image/packages/carbonless-review/lib/node_modules/carbonless-review",
			"/usr/lib/node_modules/other/node_modules/carbonless-review",
		]) {
			expect(detectInstall(root, opts), root).toBeNull();
		}
	});
});

describe("commands", () => {
	const NPM = {
		pm: "npm" as const,
		home: "/home/me/.nvm/versions/node/v24.1.0",
	};
	const PNPM = { pm: "pnpm" as const, home: "/home/me/.local/share/pnpm" };

	it("npm: the prefix's own, else the one beside the running node, into the detected prefix", () => {
		expect(
			installCommand(NPM, "0.3.0", {
				platform: "linux",
				execPath: "/usr/bin/node",
				exists: () => true,
			}).command,
		).toBe("/home/me/.nvm/versions/node/v24.1.0/bin/npm");
		expect(
			installCommand(NPM, "0.3.0", {
				platform: "linux",
				execPath: "/home/me/.nvm/versions/node/v24.1.0/bin/node",
				exists: (f) => f === "/home/me/.nvm/versions/node/v24.1.0/bin/npm",
			}),
		).toEqual({
			command: "/home/me/.nvm/versions/node/v24.1.0/bin/npm",
			args: [
				"install",
				"-g",
				"--prefix",
				"/home/me/.nvm/versions/node/v24.1.0",
				"carbonless-review@0.3.0",
			],
		});
		// None beside node: PATH's, still into the prefix; Windows: npm.cmd.
		expect(
			installCommand(NPM, "0.3.0", {
				platform: "win32",
				execPath: "C:\\node\\node.exe",
				exists: () => false,
			}).command,
		).toBe("npm.cmd");
	});

	it("pnpm: its own from PNPM_HOME, with PNPM_HOME and its bin dir set, release-age delay lifted for us", () => {
		expect(
			installCommand(PNPM, "0.3.0-rc.2", {
				platform: "linux",
				exists: (f) =>
					f === "/home/me/.local/share/pnpm/bin" ||
					f === "/home/me/.local/share/pnpm/bin/pnpm",
				env: { PATH: "/usr/bin" },
			}),
		).toEqual({
			command: "/home/me/.local/share/pnpm/bin/pnpm",
			args: [
				"add",
				"-g",
				"carbonless-review@0.3.0-rc.2",
				"--config.minimumReleaseAgeExclude=carbonless-review",
			],
			env: {
				PNPM_HOME: "/home/me/.local/share/pnpm",
				PATH: "/home/me/.local/share/pnpm/bin:/usr/bin",
			},
		});
		// Windows spells it Path; no pnpm in PNPM_HOME: PATH's pnpm.cmd.
		const win = installCommand({ pm: "pnpm", home: "C:\\pnpm" }, "0.3.0", {
			platform: "win32",
			exists: () => false,
			env: { Path: "C:\\bin" },
		});
		expect(win.command).toBe("pnpm.cmd");
		expect(win.env).toEqual({
			PNPM_HOME: "C:\\pnpm",
			Path: "C:\\pnpm;C:\\bin",
		});
	});

	it("shown as the reviewer would type it", () => {
		expect(showCommand("npm", "0.3.0")).toBe(
			"npm install -g carbonless-review@0.3.0",
		);
		expect(showCommand("pnpm", "0.3.0")).toBe(
			"pnpm add -g carbonless-review@0.3.0 --config.minimumReleaseAgeExclude=carbonless-review",
		);
		expect(manualCommand("0.3.0")).toBe(
			"npm install -g carbonless-review@0.3.0",
		);
	});

	it("never puts anything but a version on a command line", () => {
		expect(() => installCommand(NPM, "0.3.0 && rm -rf /")).toThrow();
		expect(() => installCommand(NPM, "latest")).toThrow();
		expect(() => installCommand(NPM, `1.0.0-${"a".repeat(80)}`)).toThrow();
	});

	it("restarts on the port it listens on, without rotating the key", () => {
		expect(restartArgs(["serve"], 4747)).toEqual(["serve", "--port", "4747"]);
		expect(
			restartArgs(
				["serve", "--port", "0", "--host", "100.1.2.3", "--new-key"],
				5123,
			),
		).toEqual(["serve", "--host", "100.1.2.3", "--port", "5123"]);
		expect(restartArgs(["serve", "--port=0", "--api-only"], 5123)).toEqual([
			"serve",
			"--api-only",
			"--port",
			"5123",
		]);
	});
});
