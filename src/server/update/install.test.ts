import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	canWrite,
	detectInstall,
	installCommand,
	isFromNpm,
	manualCommand,
	restartArgs,
	showCommand,
} from "./install";
import { findInstalled } from "./updateHelper";

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
				writable: (d) =>
					d === "/home/me/.local/share/pnpm/global/v11" ||
					d === "/home/me/.local/share/pnpm/bin",
				globalLinks: (d) =>
					d === "/home/me/.local/share/pnpm/global/v11" ? [root] : [],
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
			"C:\\Users\\Jane Doe\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\carbonless-review@0.2.0\\node_modules\\carbonless-review";
		expect(
			detectInstall(root, {
				platform: "win32",
				exists: none,
				writable: all,
				// Junctions resolve with another drive letter case.
				globalLinks: () => [root.toLowerCase()],
			}),
		).toMatchObject({
			pm: "pnpm",
			home: "C:\\Users\\Jane Doe\\AppData\\Local\\pnpm",
			scan: ["C:\\Users\\Jane Doe\\AppData\\Local\\pnpm\\global\\5"],
		});
	});

	it("pnpm 12's global virtual store on Windows: the real package in <PNPM_HOME>\\store, linked from the global dir", () => {
		const home = "C:\\Users\\Jane Doe\\AppData\\Local\\pnpm";
		const root = `${home}\\store\\v11\\links\\@\\carbonless-review\\0.3.0-rc.9\\5f1c0e9a2b\\node_modules\\carbonless-review`;
		const globalDir = `${home}\\global\\v11`;
		const linked: string[] = [];
		expect(
			detectInstall(root, {
				platform: "win32",
				exists: none,
				writable: (d) =>
					[globalDir, `${home}\\store\\v11`, `${home}\\bin`].includes(d),
				env: {},
				argv1: "",
				globalLinks: (d) => {
					linked.push(d);
					return [root];
				},
			}),
		).toEqual({
			pm: "pnpm",
			root,
			home,
			writable: true,
			packages: [`${globalDir}\\node_modules\\carbonless-review`],
			scan: [globalDir],
		});
		expect(linked).toEqual([globalDir]);
	});

	it("pnpm's global virtual store on Linux too", () => {
		const home = "/home/me/.local/share/pnpm";
		const root = `${home}/store/v11/links/@/carbonless-review/0.3.0-rc.9/5f1c0e9a2b/node_modules/carbonless-review`;
		expect(
			detectInstall(root, {
				platform: "linux",
				exists: none,
				writable: all,
				env: {},
				argv1: "",
				globalLinks: () => ["/elsewhere", root],
			}),
		).toMatchObject({
			pm: "pnpm",
			home,
			writable: true,
			scan: [`${home}/global/v11`],
		});
	});

	it("pnpm's global virtual store on disk: found through the global dir's link, and the new version found there after an install", () => {
		if (process.platform === "win32") return;
		const tmp = realpathSync(mkdtempSync(join(tmpdir(), "crb-pnpm-gvs-")));
		try {
			mkdirSync(join(tmp, "bin"));
			const put = (version: string, hash: string) => {
				const pkg = join(
					tmp,
					"store/v11/links/@/carbonless-review",
					version,
					hash,
					"node_modules/carbonless-review",
				);
				mkdirSync(join(pkg, "dist"), { recursive: true });
				writeFileSync(
					join(pkg, "dist/build-info.json"),
					JSON.stringify({ version }),
				);
				writeFileSync(join(pkg, "dist/cli.js"), "");
				const entry = join(tmp, "global/v11", hash, "node_modules");
				mkdirSync(entry, { recursive: true });
				symlinkSync(pkg, join(entry, "carbonless-review"), "dir");
				return pkg;
			};
			const root = put("0.3.0-rc.9", "aaa");
			const install = detectInstall(root, {
				platform: "linux",
				env: {},
				argv1: "",
			});
			expect(install).toMatchObject({ pm: "pnpm", home: tmp, writable: true });
			put("0.3.0-rc.10", "bbb");
			const cli = findInstalled(
				{ packages: install?.packages ?? [], scan: install?.scan ?? [] },
				"0.3.0-rc.10",
			);
			expect(cli && realpathSync(cli)).toBe(
				join(
					tmp,
					"store/v11/links/@/carbonless-review/0.3.0-rc.10/bbb/node_modules/carbonless-review/dist/cli.js",
				),
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("a store package no global install links to (a project's dependency through the global virtual store): unknown", () => {
		const root =
			"/home/me/.local/share/pnpm/store/v11/links/@/carbonless-review/0.3.0-rc.9/5f1c0e9a2b/node_modules/carbonless-review";
		const opts = {
			platform: "linux" as const,
			exists: none,
			writable: all,
			env: {},
			argv1: "",
		};
		expect(detectInstall(root, { ...opts, globalLinks: () => [] })).toBeNull();
		expect(
			detectInstall(root, {
				...opts,
				globalLinks: () => [root.replace("rc.9", "rc.8")],
			}),
		).toBeNull();
		// Not a store's links dir at all.
		expect(
			detectInstall(
				"/home/me/project/links/@/carbonless-review/1/h/node_modules/carbonless-review",
				{ ...opts, globalLinks: (d) => [d] },
			),
		).toBeNull();
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
			"/usr/lib/node_modules/other/node_modules/carbonless-review",
		]) {
			expect(detectInstall(root, opts), root).toBeNull();
		}
	});
});

/**
 * Every layout of npm 9-12 and pnpm 8-12 on Linux, macOS and Windows, and
 * what must never count (a research pass, 2026-11-15: Linux rows from real
 * installs, the rest from npm's, pnpm's and the managers' sources).
 */
describe("detectInstall: the layouts of supported npm and pnpm", () => {
	const P = "carbonless-review";
	const H64 =
		"74d1636bf1b3864c9cf492433004b6be542b65d4b77a496e2892f736132575da";
	const base = {
		exists: () => true,
		writable: () => true,
		env: {},
		argv1: "",
		globalLinks: () => [] as string[],
	};

	it("npm: <prefix>/lib/node_modules (POSIX) or <prefix>\\node_modules (Windows), any Node manager", () => {
		const cases: [NodeJS.Platform, string][] = [
			["linux", "/home/u/.nvm/versions/node/v24.11.0"],
			["linux", "/home/u/.npm-global"],
			["linux", "/home/u/.local/share/fnm/node-versions/v24.11.0/installation"],
			["linux", "/home/u/.local/share/mise/installs/node/24.11.0"],
			["linux", "/home/u/.asdf/installs/nodejs/24.11.0"],
			["linux", "/usr"],
			["darwin", "/opt/homebrew"],
			["darwin", "/usr/local"],
			[
				"darwin",
				"/Users/u/Library/Application Support/fnm/node-versions/v24.11.0/installation",
			],
			["win32", "C:\\Users\\u\\AppData\\Roaming\\npm"],
			["win32", "C:\\Users\\u\\AppData\\Local\\nvm\\v24.11.0"],
			[
				"win32",
				"C:\\Users\\u\\AppData\\Roaming\\fnm\\node-versions\\v24.11.0\\installation",
			],
		];
		for (const [platform, home] of cases) {
			const root =
				platform === "win32"
					? `${home}\\node_modules\\${P}`
					: `${home}/lib/node_modules/${P}`;
			expect(detectInstall(root, { ...base, platform }), root).toMatchObject({
				pm: "npm",
				home,
				packages: [root],
			});
		}
		// A system node's prefix, root's: found, but not writable.
		expect(
			detectInstall(`/usr/lib/node_modules/${P}`, {
				...base,
				platform: "linux",
				writable: (d) => d !== "/usr/lib/node_modules",
			})?.writable,
		).toBe(false);
	});

	it("pnpm 8-10 (global/5/.pnpm, 10's global virtual store too) and 11+ with its global virtual store off", () => {
		const cases: [NodeJS.Platform, string, string, string][] = [
			[
				"linux",
				`/home/u/.local/share/pnpm/global/5/.pnpm/${P}@0.3.0/node_modules/${P}`,
				"/home/u/.local/share/pnpm",
				"/home/u/.local/share/pnpm/global/5",
			],
			[
				"darwin",
				`/Users/u/Library/pnpm/global/5/.pnpm/${P}@0.3.0/node_modules/${P}`,
				"/Users/u/Library/pnpm",
				"/Users/u/Library/pnpm/global/5",
			],
			[
				"win32",
				`C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\${P}@0.3.0\\node_modules\\${P}`,
				"C:\\Users\\u\\AppData\\Local\\pnpm",
				"C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5",
			],
			[
				"linux",
				`/home/u/.local/share/pnpm/global/5/.pnpm/@/${P}/0.3.0/${H64}/node_modules/${P}`,
				"/home/u/.local/share/pnpm",
				"/home/u/.local/share/pnpm/global/5",
			],
			[
				"linux",
				`/home/u/.local/share/pnpm/global/v11/3e6469-1a1e03b9b3b-ef532c3365c3282b/node_modules/.pnpm/${P}@0.3.0/node_modules/${P}`,
				"/home/u/.local/share/pnpm",
				"/home/u/.local/share/pnpm/global/v11",
			],
		];
		for (const [platform, root, home, globalDir] of cases) {
			const sep = platform === "win32" ? "\\" : "/";
			const asked: string[] = [];
			const opts = {
				...base,
				platform,
				globalLinks: (d: string) => (d === globalDir ? [root] : []),
				writable: (d: string) => {
					asked.push(d);
					return true;
				},
			};
			expect(detectInstall(root, opts), root).toMatchObject({
				pm: "pnpm",
				home,
				writable: true,
				scan: [globalDir],
			});
			// The global dir, the shim's dir (8-10: PNPM_HOME; 11+: its
			// bin), and the store, when it's there.
			const shims = globalDir.endsWith("v11") ? `${home}${sep}bin` : home;
			expect(asked, root).toEqual([globalDir, shims, `${home}${sep}store`]);
			asked.length = 0;
			detectInstall(root, { ...opts, exists: () => false });
			expect(asked, root).toEqual([globalDir, shims]);
			// The global dir holds another crb, or none: not this install.
			expect(
				detectInstall(root, { ...opts, globalLinks: () => [] }),
				root,
			).toBeNull();
		}
	});

	it("a project in a dir shaped like pnpm's global one: by hand, whatever it holds", () => {
		const cases = [
			// A project "app" under ~/global/v1, under ~/global/2.
			`/home/u/global/v1/app/node_modules/.pnpm/${P}@1.0.0/node_modules/${P}`,
			`/home/u/global/2/app/node_modules/.pnpm/${P}@1.0.0/node_modules/${P}`,
			// A project whose root is ~/global/5.
			`/home/u/global/5/node_modules/.pnpm/${P}@1.0.0/node_modules/${P}`,
		];
		for (const root of cases) {
			// Even when the "global dir" seems to hold it (a real project's
			// `app/node_modules/carbonless-review` resolves to it): pnpm
			// names a global install's dir in hex, never "app".
			expect(
				detectInstall(root, {
					...base,
					platform: "linux",
					globalLinks: () => [root],
				}),
				root,
			).toBeNull();
		}
		// Shaped like pnpm 8-10's, but its global dir doesn't hold it.
		expect(
			detectInstall(`/home/u/global/5/.pnpm/${P}@1.0.0/node_modules/${P}`, {
				...base,
				platform: "linux",
				globalLinks: () => ["/elsewhere"],
			}),
		).toBeNull();
	});

	it("pnpm 11 and 12 by default (the global virtual store), on every OS: home from crb's start, $PNPM_HOME or the store's place, confirmed by the global dir's link", () => {
		const cases: [NodeJS.Platform, string, string, string][] = [
			[
				"linux",
				"/home/u/.local/share/pnpm",
				`/home/u/.local/share/pnpm/store/v11/links/@/${P}/0.3.0/${H64}/node_modules/${P}`,
				`/home/u/.local/share/pnpm/global/v11/e331f1ad685c659897a96e813abefc4926c58634f051ba558e70944019321860/node_modules/${P}/dist/cli.js`,
			],
			[
				"darwin",
				"/Users/u/Library/pnpm",
				`/Users/u/Library/pnpm/store/v11/links/@/${P}/0.3.0-rc.9/${H64}/node_modules/${P}`,
				`/Users/u/Library/pnpm/global/v11/abc-def/node_modules/${P}/dist/cli.js`,
			],
			[
				"win32",
				"C:\\Users\\u\\AppData\\Local\\pnpm",
				`C:\\Users\\u\\AppData\\Local\\pnpm\\store\\v11\\links\\@\\${P}\\0.3.0-rc.9\\${H64}\\node_modules\\${P}`,
				`C:\\Users\\u\\AppData\\Local\\pnpm\\global\\v11\\7c88-1f2e\\node_modules\\${P}\\dist\\cli.js`,
			],
		];
		for (const [platform, home, root, argv1] of cases) {
			const p = platform === "win32" ? "\\" : "/";
			const globalDir = `${home}${p}global${p}v11`;
			const storeDir = root.slice(0, root.indexOf(`${p}links${p}`));
			const asked: string[] = [];
			const opts = {
				...base,
				platform,
				globalLinks: (d: string) => (d === globalDir ? [root] : []),
				writable: (d: string) => {
					asked.push(d);
					return true;
				},
			};
			// From how crb was started, from $PNPM_HOME, or the store's place.
			for (const how of [{ argv1 }, { env: { PNPM_HOME: home } }, {}]) {
				asked.length = 0;
				expect(detectInstall(root, { ...opts, ...how }), root).toEqual({
					pm: "pnpm",
					root,
					home,
					writable: true,
					packages: [`${globalDir}${p}node_modules${p}${P}`],
					scan: [globalDir],
				});
				// A new dir per install, the store's files, the shim.
				expect(asked).toEqual([globalDir, storeDir, `${home}${p}bin`]);
			}
			// Any of the three not writable: the command.
			for (const dir of [globalDir, storeDir, `${home}${p}bin`]) {
				expect(
					detectInstall(root, {
						...opts,
						argv1,
						writable: (d: string) => d !== dir,
					})?.writable,
				).toBe(false);
			}
		}
	});

	it("pnpm's store moved (storeDir on another drive): found through $PNPM_HOME or crb's start, never guessed", () => {
		const home = "C:\\Users\\u\\AppData\\Local\\pnpm";
		const root = `D:\\pnpm-store\\v11\\links\\@\\${P}\\0.3.0\\${H64}\\node_modules\\${P}`;
		const opts = {
			...base,
			platform: "win32" as const,
			globalLinks: (d: string) => (d === `${home}\\global\\v11` ? [root] : []),
		};
		expect(
			detectInstall(root, { ...opts, env: { PNPM_HOME: home } }),
		).toMatchObject({ pm: "pnpm", home, scan: [`${home}\\global\\v11`] });
		expect(
			detectInstall(root, {
				...opts,
				argv1: `${home}\\global\\v11\\1a-2b\\node_modules\\${P}\\dist\\cli.js`,
			}),
		).toMatchObject({ pm: "pnpm", home });
		// Nothing says where PNPM_HOME is, or no global entry links to it.
		expect(detectInstall(root, opts)).toBeNull();
		expect(
			detectInstall(root, {
				...opts,
				env: { PNPM_HOME: home },
				globalLinks: () => [],
			}),
		).toBeNull();
	});

	it("never a global install: a project's dependency through the global virtual store, a project under global/2, Volta, npx, pnpm dlx, a project, yarn, bun", () => {
		// The same path as a global install, but no global entry links to it.
		expect(
			detectInstall(
				`/home/u/.local/share/pnpm/store/v11/links/@/${P}/0.3.0/${H64}/node_modules/${P}`,
				{
					...base,
					platform: "linux",
					argv1: `/home/u/src/app/node_modules/${P}/dist/cli.js`,
					env: { PNPM_HOME: "/home/u/.local/share/pnpm" },
					globalLinks: () => [
						`/home/u/.local/share/pnpm/store/v11/links/@/${P}/0.2.0/${H64}/node_modules/${P}`,
					],
				},
			),
		).toBeNull();
		const cases: [NodeJS.Platform, string][] = [
			[
				"linux",
				`/home/u/global/2/app/node_modules/.pnpm/${P}@0.3.0/node_modules/${P}`,
			],
			[
				"darwin",
				`/Users/u/.volta/tools/image/packages/${P}/lib/node_modules/${P}`,
			],
			[
				"win32",
				`C:\\Users\\u\\AppData\\Local\\Volta\\tools\\image\\packages\\${P}\\node_modules\\${P}`,
			],
			[
				"darwin",
				`/Users/u/.volta/tools/image/packages/${P}/5/.pnpm/${P}@0.3.0/node_modules/${P}`,
			],
			[
				"linux",
				`/home/u/.cache/pnpm/dlx/18a9bb3956611e262a82b7fa160fef98/mwi3s0bb-2fp46/node_modules/.pnpm/${P}@0.3.0/node_modules/${P}`,
			],
			["linux", `/home/u/.npm/_npx/efc2fc194987058d/node_modules/${P}`],
			[
				"win32",
				`C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\efc2fc194987058d\\node_modules\\${P}`,
			],
			["linux", `/home/u/src/app/node_modules/${P}`],
			[
				"linux",
				`/home/u/src/app/node_modules/.pnpm/${P}@0.3.0/node_modules/${P}`,
			],
			["linux", `/home/u/.config/yarn/global/node_modules/${P}`],
			["linux", `/home/u/.bun/install/global/node_modules/${P}`],
		];
		for (const [platform, root] of cases) {
			// Every shim "exists": only the path's shape decides.
			expect(detectInstall(root, { ...base, platform }), root).toBeNull();
		}
	});
});

describe("canWrite", () => {
	it("makes and removes a probe file: a dir it can't write is no", () => {
		const dir = mkdtempSync(join(tmpdir(), "crb-canwrite-"));
		try {
			expect(canWrite(dir)).toBe(true);
			expect(readdirSync(dir)).toEqual([]);
			expect(canWrite(join(dir, "missing"))).toBe(false);
			if (process.platform !== "win32" && process.getuid?.() !== 0) {
				chmodSync(dir, 0o500);
				expect(canWrite(dir)).toBe(false);
				chmodSync(dir, 0o700);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
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
				env: { PATH: "/usr/bin" },
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
			// Its shim runs `env node`: this node first on PATH (a service's
			// PATH may have none).
			env: { PATH: "/home/me/.nvm/versions/node/v24.1.0/bin:/usr/bin" },
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
				execPath: "/opt/node/bin/node",
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
				PATH: "/home/me/.local/share/pnpm/bin:/opt/node/bin:/usr/bin",
			},
			// Not crb's cwd: corepack would read a project's packageManager there.
			cwd: "/home/me/.local/share/pnpm",
		});
		// Windows spells it Path; no pnpm in PNPM_HOME: PATH's pnpm.cmd.
		const win = installCommand({ pm: "pnpm", home: "C:\\pnpm" }, "0.3.0", {
			platform: "win32",
			execPath: "C:\\node\\node.exe",
			exists: () => false,
			env: { Path: "C:\\bin" },
		});
		expect(win.command).toBe("pnpm.cmd");
		expect(win.env).toEqual({
			PNPM_HOME: "C:\\pnpm",
			Path: "C:\\pnpm;C:\\node;C:\\bin",
		});
	});

	it("pnpm on Windows: the standalone installer's pnpm.exe in PNPM_HOME, not PATH's pnpm.cmd", () => {
		// @pnpm/exe puts pnpm.exe in PNPM_HOME with no pnpm.cmd beside it;
		// PATH's pnpm.cmd may be an old npm-installed pnpm 9 that installs
		// into global\5, where pnpm 12 (global\v11) never looks.
		const command = (files: string[]) =>
			installCommand({ pm: "pnpm", home: "C:\\pnpm" }, "0.4.0-rc.3", {
				platform: "win32",
				execPath: "C:\\node\\node.exe",
				exists: (f) => files.includes(f),
				env: { Path: "C:\\Users\\me\\AppData\\Roaming\\npm" },
			}).command;
		expect(command(["C:\\pnpm\\pnpm.exe"])).toBe("C:\\pnpm\\pnpm.exe");
		expect(command(["C:\\pnpm\\bin", "C:\\pnpm\\bin\\pnpm.exe"])).toBe(
			"C:\\pnpm\\bin\\pnpm.exe",
		);
		// A shim wins in the same dir; PNPM_HOME\bin's wins over PNPM_HOME's.
		expect(command(["C:\\pnpm\\pnpm.cmd", "C:\\pnpm\\pnpm.exe"])).toBe(
			"C:\\pnpm\\pnpm.cmd",
		);
		expect(command(["C:\\pnpm\\bin\\pnpm.cmd", "C:\\pnpm\\pnpm.exe"])).toBe(
			"C:\\pnpm\\bin\\pnpm.cmd",
		);
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
