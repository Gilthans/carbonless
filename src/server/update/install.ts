import { accessSync, constants, existsSync, readFileSync } from "node:fs";
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

/** How crb was installed globally, read from where its package lies. */
export interface Install {
	pm: PackageManager;
	/** The package dir crb runs from (real path). */
	root: string;
	/** npm: the global prefix; pnpm: PNPM_HOME. */
	home: string;
	/** The install can write there (one-click needs it; else the command). */
	writable: boolean;
	/** Package dirs the new version may be in (npm: in place). */
	packages: string[];
	/** Dirs whose entries may each hold the package (pnpm's global dir). */
	scan: string[];
}

export interface DetectOptions {
	platform?: NodeJS.Platform;
	execPath?: string;
	exists?: (file: string) => boolean;
	writable?: (dir: string) => boolean;
}

const canWrite = (dir: string): boolean => {
	try {
		accessSync(dir, constants.W_OK);
		return true;
	} catch {
		return false;
	}
};

/**
 * The package manager that installed the package at `root` (a real path:
 * symlinks resolved) globally, read from where it lies; null when it is
 * neither a global npm nor a global pnpm install (yarn, bun, volta, a
 * project's node_modules, npx's cache...): the toast then shows the command.
 * - npm: `<prefix>/lib/node_modules/carbonless-review` with the `crb` shim
 *   in `<prefix>/bin` (Windows: `<prefix>\node_modules\carbonless-review`
 *   and `<prefix>\crb.cmd`).
 * - pnpm: `<PNPM_HOME>/global/<v>/.../node_modules/.pnpm/.../carbonless-review`.
 */
export function detectInstall(
	root: string,
	opts: DetectOptions = {},
): Install | null {
	const platform = opts.platform ?? process.platform;
	const p = platform === "win32" ? path.win32 : path.posix;
	const exists = opts.exists ?? existsSync;
	const writable = opts.writable ?? canWrite;
	const parts = root.split(/[\\/]+/);
	if (parts.at(-1) !== PACKAGE || parts.at(-2) !== "node_modules") return null;
	const join = (segments: string[]) => segments.join(p.sep) || p.sep;
	const pnpmAt = parts.lastIndexOf(".pnpm");
	if (pnpmAt >= 0) {
		const globalAt = parts.lastIndexOf("global", pnpmAt);
		const store = parts[globalAt + 1];
		if (globalAt < 0 || !store || !/^v?\d+$/.test(store)) return null;
		const home = join(parts.slice(0, globalAt));
		const globalDir = p.join(home, "global", store);
		return {
			pm: "pnpm",
			root,
			home,
			writable: writable(globalDir),
			// pnpm 10-: one node_modules; 11+: a dir per install.
			packages: [p.join(globalDir, "node_modules", PACKAGE)],
			scan: [globalDir],
		};
	}
	// One node_modules only: a dependency of a project isn't a global install.
	if (parts.indexOf("node_modules") !== parts.length - 2) return null;
	const prefixParts = parts.slice(0, platform === "win32" ? -2 : -3);
	if (platform !== "win32" && parts.at(-3) !== "lib") return null;
	const prefix = join(prefixParts);
	const shim =
		platform === "win32"
			? p.join(prefix, "crb.cmd")
			: p.join(prefix, "bin", "crb");
	if (!exists(shim)) return null;
	return {
		pm: "npm",
		root,
		home: prefix,
		writable: writable(join(parts.slice(0, -1))),
		packages: [root],
		scan: [],
	};
}

/** The exact package and version an update installs. */
export const spec = (version: string) => `${PACKAGE}@${version}`;

/** A command; `env` is added to crb's environment. */
export interface Command {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

/** `env`'s PATH key as it is spelled (Windows: often `Path`). */
const pathKey = (env: NodeJS.ProcessEnv) =>
	Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";

/**
 * The install command for `version` (checked: only a version reaches a
 * command line), run by the package manager of the install crb runs from:
 * - npm from the detected prefix, else beside the running node, else
 *   PATH's, always into that prefix (`--prefix`);
 * - pnpm from PNPM_HOME (else the one on PATH), with PNPM_HOME and its
 *   bin dir set, and our package exempt from pnpm's release-age delay
 *   (docs/releasing.md).
 */
export function installCommand(
	install: Pick<Install, "pm" | "home">,
	version: string,
	opts: {
		platform?: NodeJS.Platform;
		execPath?: string;
		exists?: (file: string) => boolean;
		env?: NodeJS.ProcessEnv;
	} = {},
): Command {
	if (!parseVersion(version) || version.length > MAX_VERSION) {
		throw new Error(`Not a version: ${version}`);
	}
	const platform = opts.platform ?? process.platform;
	const p = platform === "win32" ? path.win32 : path.posix;
	const exists = opts.exists ?? existsSync;
	const ext = platform === "win32" ? ".cmd" : "";
	const first = (candidates: string[], fallback: string) =>
		candidates.find(exists) ?? fallback;
	if (install.pm === "npm") {
		const node = opts.execPath ?? process.execPath;
		const own =
			platform === "win32"
				? p.join(install.home, "npm.cmd")
				: p.join(install.home, "bin", "npm");
		return {
			command: first([own, p.join(p.dirname(node), `npm${ext}`)], `npm${ext}`),
			args: ["install", "-g", "--prefix", install.home, spec(version)],
		};
	}
	const bin = exists(p.join(install.home, "bin"))
		? p.join(install.home, "bin")
		: install.home;
	const env = opts.env ?? process.env;
	const key = pathKey(env);
	return {
		command: first(
			[
				p.join(install.home, "bin", `pnpm${ext}`),
				p.join(install.home, `pnpm${ext}`),
			],
			`pnpm${ext}`,
		),
		args: [
			"add",
			"-g",
			spec(version),
			`--config.minimumReleaseAgeExclude=${PACKAGE}`,
		],
		env: {
			PNPM_HOME: install.home,
			[key]: [bin, env[key]].filter(Boolean).join(p.delimiter),
		},
	};
}

/** The longest version an update takes (a registry's answer is checked). */
export const MAX_VERSION = 64;

/** The command as the reviewer would type it. */
export function showCommand(pm: PackageManager, version: string): string {
	return pm === "npm"
		? `npm install -g ${spec(version)}`
		: `pnpm add -g ${spec(version)} --config.minimumReleaseAgeExclude=${PACKAGE}`;
}

/** The command to show when crb can't tell how it was installed. */
export const manualCommand = (version: string): string =>
	showCommand("npm", version);

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
