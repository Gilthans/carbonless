import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BuildInfo } from "../version.js";
import { PACKAGE } from "./registry.js";
import { parseVersion } from "./semver.js";

/**
 * How this crb was installed, so it can update itself: from npm, by which
 * package manager, and how to start it again afterwards.
 */

/**
 * Whether `root` (the package directory crb runs from) is a build npm
 * served: its package.json is carbonless-review's, with the `gitHead` CI
 * writes into every RC and release (docs/releasing.md, "The version in a
 * build"), equal to the build's own clean commit and at the build's
 * version. A checkout, `pnpm build`, the dev server and `pnpm release
 * local` (what a machine that follows master installs) have no `gitHead`:
 * they never offer an update over npm.
 */
export function isFromNpm(
	root: string,
	build: BuildInfo,
	read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): boolean {
	if (!/^[0-9a-f]{40}$/.test(build.commit)) return false;
	if (!root.split(/[\\/]/).includes("node_modules")) return false;
	try {
		const pkg = JSON.parse(read(path.join(root, "package.json"))) as {
			name?: unknown;
			version?: unknown;
			gitHead?: unknown;
		};
		return (
			pkg.name === PACKAGE &&
			pkg.version === build.version &&
			pkg.gitHead === build.commit
		);
	} catch {
		return false;
	}
}

export type PackageManager = "npm" | "pnpm";

export interface Install {
	pm: PackageManager;
	/**
	 * What starts crb again after the install, ahead of its own arguments
	 * (`serve ...`): a path that leads to the new version. npm replaces the
	 * package in place, so its cli.js; pnpm installs a global package
	 * into a new directory, so its `crb` shim.
	 */
	launcher: Launcher;
}

/** A command, run through a shell only for a Windows `.cmd` shim. */
export interface Launcher {
	command: string;
	args: string[];
}

/**
 * The package manager that installed the package at `root` (a real path:
 * symlinks resolved) globally, read from where it lies; null when it is
 * neither a global npm nor a global pnpm install (yarn, bun, a project's
 * node_modules, npx's cache...): the toast then shows the command.
 * - npm: `<prefix>/lib/node_modules/carbonless-review` (Windows:
 *   `<prefix>\node_modules\carbonless-review`, prefix `%APPDATA%\npm` or
 *   node's own directory).
 * - pnpm: `<PNPM_HOME>/global/<v>/.../node_modules/.pnpm/.../node_modules/carbonless-review`.
 */
export function detectInstall(
	root: string,
	opts: {
		platform?: NodeJS.Platform;
		execPath?: string;
		exists?: (file: string) => boolean;
	} = {},
): Install | null {
	const platform = opts.platform ?? process.platform;
	const p = platform === "win32" ? path.win32 : path.posix;
	const exists = opts.exists ?? existsSync;
	const execPath = opts.execPath ?? process.execPath;
	const parts = root.split(/[\\/]+/);
	if (parts.at(-1) !== PACKAGE || parts.at(-2) !== "node_modules") return null;
	const cli = p.join(root, "dist", "cli.js");
	const pnpmAt = parts.lastIndexOf(".pnpm");
	const globalAt = parts.lastIndexOf("global");
	if (pnpmAt >= 0) {
		if (globalAt < 0 || globalAt > pnpmAt) return null;
		const home = parts.slice(0, globalAt).join(p.sep) || p.sep;
		const shims =
			platform === "win32"
				? [p.join(home, "bin", "crb.cmd"), p.join(home, "crb.cmd")]
				: [p.join(home, "bin", "crb"), p.join(home, "crb")];
		const shim = shims.find(exists);
		return {
			pm: "pnpm",
			launcher: shim
				? { command: shim, args: [] }
				: { command: execPath, args: [cli] },
		};
	}
	// One node_modules only: a dependency of a project isn't a global install.
	if (parts.indexOf("node_modules") !== parts.length - 2) return null;
	const prefix = parts.slice(0, -2);
	const global =
		platform === "win32"
			? prefix.at(-1)?.toLowerCase() === "npm" ||
				p.normalize(prefix.join(p.sep)).toLowerCase() ===
					p.dirname(execPath).toLowerCase()
			: prefix.at(-1) === "lib";
	if (!global) return null;
	return { pm: "npm", launcher: { command: execPath, args: [cli] } };
}

/** The exact package and version an update installs. */
export const spec = (version: string) => `${PACKAGE}@${version}`;

/**
 * The install command for `version` (checked: only a version reaches a
 * command line): `npm install -g`, or `pnpm add -g` exempting our package
 * from pnpm's release-age delay (docs/releasing.md).
 */
export function installCommand(
	pm: PackageManager,
	version: string,
	platform: NodeJS.Platform = process.platform,
): Launcher {
	if (!parseVersion(version)) throw new Error(`Not a version: ${version}`);
	const cmd = platform === "win32" ? `${pm}.cmd` : pm;
	return pm === "npm"
		? { command: cmd, args: ["install", "-g", spec(version)] }
		: {
				command: cmd,
				args: [
					"add",
					"-g",
					spec(version),
					`--config.minimumReleaseAgeExclude=${PACKAGE}`,
				],
			};
}

/** A command as the reviewer would type it. */
export const showCommand = (l: Launcher): string =>
	[l.command.replace(/\.cmd$/, ""), ...l.args].join(" ");

/** The command to show when crb can't tell how it was installed. */
export const manualCommand = (version: string): string =>
	showCommand(installCommand("npm", version, "linux"));

/**
 * crb's arguments for the restart: the same, but on the port it actually
 * listens on (a `--port 0` or a config default must come back where the
 * pages are) and without `--new-key` (the pages' key must keep working).
 */
export function restartArgs(argv: readonly string[], port: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		if (a === "--new-key") continue;
		if (a === "--port") {
			i++;
			continue;
		}
		if (a.startsWith("--port=")) continue;
		out.push(a);
	}
	out.push("--port", String(port));
	return out;
}
