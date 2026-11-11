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
	const none = () => false;

	it("npm global: <prefix>/lib/node_modules, relaunched by its own cli.js", () => {
		expect(
			detectInstall(
				"/home/me/.nvm/versions/node/v24.1.0/lib/node_modules/carbonless-review",
				{
					platform: "linux",
					execPath: "/home/me/.nvm/versions/node/v24.1.0/bin/node",
					exists: none,
				},
			),
		).toEqual({
			pm: "npm",
			launcher: {
				command: "/home/me/.nvm/versions/node/v24.1.0/bin/node",
				args: [
					"/home/me/.nvm/versions/node/v24.1.0/lib/node_modules/carbonless-review/dist/cli.js",
				],
			},
		});
	});

	it("npm global on Windows: %APPDATA%\\npm or node's own directory", () => {
		const node = "C:\\Program Files\\nodejs\\node.exe";
		expect(
			detectInstall(
				"C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\carbonless-review",
				{
					platform: "win32",
					execPath: node,
					exists: none,
				},
			),
		).toEqual({
			pm: "npm",
			launcher: {
				command: node,
				args: [
					"C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\carbonless-review\\dist\\cli.js",
				],
			},
		});
		expect(
			detectInstall(
				"C:\\Program Files\\nodejs\\node_modules\\carbonless-review",
				{
					platform: "win32",
					execPath: node,
					exists: none,
				},
			)?.pm,
		).toBe("npm");
	});

	it("pnpm global (v11's layout): relaunched through its crb shim, which moves to the new version", () => {
		const root =
			"/home/me/.local/share/pnpm/global/v11/88719-18e7/node_modules/.pnpm/carbonless-review@0.2.0/node_modules/carbonless-review";
		expect(
			detectInstall(root, {
				platform: "linux",
				execPath: "/usr/bin/node",
				exists: (f) => f === "/home/me/.local/share/pnpm/bin/crb",
			}),
		).toEqual({
			pm: "pnpm",
			launcher: { command: "/home/me/.local/share/pnpm/bin/crb", args: [] },
		});
		// Older pnpm: the shim in PNPM_HOME itself; none at all: its cli.js.
		expect(
			detectInstall(root, {
				platform: "linux",
				execPath: "/usr/bin/node",
				exists: (f) => f === "/home/me/.local/share/pnpm/crb",
			})?.launcher.command,
		).toBe("/home/me/.local/share/pnpm/crb");
		expect(
			detectInstall(root, {
				platform: "linux",
				execPath: "/usr/bin/node",
				exists: none,
			})?.launcher,
		).toEqual({ command: "/usr/bin/node", args: [`${root}/dist/cli.js`] });
	});

	it("pnpm global on Windows: its crb.cmd", () => {
		const root =
			"C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\node_modules\\.pnpm\\carbonless-review@0.2.0\\node_modules\\carbonless-review";
		expect(
			detectInstall(root, {
				platform: "win32",
				execPath: "C:\\node\\node.exe",
				exists: (f) => f === "C:\\Users\\me\\AppData\\Local\\pnpm\\crb.cmd",
			}),
		).toEqual({
			pm: "pnpm",
			launcher: {
				command: "C:\\Users\\me\\AppData\\Local\\pnpm\\crb.cmd",
				args: [],
			},
		});
	});

	it("anything else is unknown: a project's dependency, a project's pnpm store, a checkout, yarn's global", () => {
		const opts = {
			platform: "linux" as const,
			execPath: "/usr/bin/node",
			exists: none,
		};
		for (const root of [
			"/home/me/project/node_modules/carbonless-review",
			"/home/me/project/node_modules/.pnpm/carbonless-review@0.2.0/node_modules/carbonless-review",
			"/home/me/carbonless",
			"/home/me/.config/yarn/global/node_modules/carbonless-review",
			"/usr/lib/node_modules/other/node_modules/carbonless-review",
		]) {
			expect(detectInstall(root, opts), root).toBeNull();
		}
	});
});

describe("commands", () => {
	it("installs exactly the version, with pnpm's release-age delay lifted for it", () => {
		expect(installCommand("npm", "0.3.0", "linux")).toEqual({
			command: "npm",
			args: ["install", "-g", "carbonless-review@0.3.0"],
		});
		expect(installCommand("pnpm", "0.3.0-rc.2", "linux")).toEqual({
			command: "pnpm",
			args: [
				"add",
				"-g",
				"carbonless-review@0.3.0-rc.2",
				"--config.minimumReleaseAgeExclude=carbonless-review",
			],
		});
		expect(installCommand("npm", "0.3.0", "win32").command).toBe("npm.cmd");
		expect(showCommand(installCommand("npm", "0.3.0", "win32"))).toBe(
			"npm install -g carbonless-review@0.3.0",
		);
		expect(manualCommand("0.3.0")).toBe(
			"npm install -g carbonless-review@0.3.0",
		);
	});

	it("never puts anything but a version on a command line", () => {
		expect(() => installCommand("npm", "0.3.0 && rm -rf /", "linux")).toThrow();
		expect(() => installCommand("npm", "latest", "linux")).toThrow();
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
