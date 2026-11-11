import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cmdQuote,
	HELPER_DIR_PREFIX,
	type HelperConfig,
	runCommand,
	tailOf,
	type UpdateResult,
} from "./updateHelper";
import { startHelper } from "./updater";

// Real processes, on Windows too (CI's windows-agent job runs this file):
// the helper started as crb starts it (copied to a temp dir of its own, run
// from the temp dir above it), a stand-in crb to wait for, a stand-in
// install that puts a new version where pnpm would, and its cli.js.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SOURCE = fileURLToPath(new URL("./updateHelper.ts", import.meta.url));

let dir: string;
let tmp: string;
beforeEach(() => {
	// A space in every path: a Windows profile like C:\Users\Jane Doe.
	dir = join(mkdtempSync(join(tmpdir(), "crb-helper-test-")), "with space");
	mkdirSync(dir);
	tmp = join(dir, "tmp");
	mkdirSync(tmp);
});
afterEach(() => {
	rmSync(join(dir, ".."), { recursive: true, force: true });
});

function script(name: string, body: string): string {
	const file = join(dir, name);
	writeFileSync(file, body);
	return file;
}

/** A stand-in crb: runs until told to exit (a line on stdin). */
function standInCrb(): ChildProcess {
	return spawn(
		process.execPath,
		["-e", "process.stdin.once('data', () => process.exit(0))"],
		{ stdio: ["pipe", "ignore", "ignore"] },
	);
}

/** Waits for a condition (the helper runs detached: no exit to wait for). */
async function until(check: () => boolean, what: string): Promise<void> {
	const end = Date.now() + 20_000;
	while (!check()) {
		if (Date.now() > end) throw new Error(`never: ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

const helperDirs = () =>
	readdirSync(tmp).filter((e) => e.startsWith(HELPER_DIR_PREFIX));

/** A cli.js that records how it was started, and prints crb's key line. */
const CLI = (
	record: string,
) => `import { realpathSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ cli: realpathSync(process.argv[1]), args: process.argv.slice(2), cwd: realpathSync(process.cwd()), mark: process.env.CRB_HELPER_MARK }));
console.error("carbonless listening on http://127.0.0.1:4747/?key=SECRET");
`;

function config(
	crb: number,
	opts: { installExit?: number; waitMs?: number } = {},
): HelperConfig {
	const scan = join(dir, "global v11");
	mkdirSync(scan);
	// The running version, where pnpm put it.
	const old = join(dir, "old pkg");
	mkdirSync(join(old, "dist"), { recursive: true });
	writeFileSync(join(old, "dist", "cli.js"), CLI(join(dir, "relaunched.json")));
	const fresh = join(
		scan,
		"new-1",
		"node_modules",
		"carbonless-review",
		"dist",
	);
	const install = script(
		"install.mjs",
		`import { mkdirSync, writeFileSync } from "node:fs";
let alive = true;
try { process.kill(${crb}, 0); } catch { alive = false; }
writeFileSync(${JSON.stringify(join(dir, "installed.json"))}, JSON.stringify({ args: process.argv.slice(2), crbAlive: alive, home: process.env.PNPM_HOME }));
console.log("added 1 package");
${
	opts.installExit
		? `console.error("npm error 404 Not Found");\nprocess.exit(${opts.installExit});`
		: `mkdirSync(${JSON.stringify(fresh)}, { recursive: true });
writeFileSync(${JSON.stringify(join(fresh, "build-info.json"))}, JSON.stringify({ version: "0.3.0", commit: "x" }));
writeFileSync(${JSON.stringify(join(fresh, "cli.js"))}, ${JSON.stringify(CLI(join(dir, "relaunched.json")))});`
}
`,
	);
	return {
		pid: crb,
		waitMs: opts.waitMs ?? 20_000,
		version: "0.3.0",
		install: {
			command: process.execPath,
			args: [install, "add", "-g", "carbonless-review@0.3.0"],
			env: { PNPM_HOME: join(dir, "pnpm home") },
		},
		display: "pnpm add -g carbonless-review@0.3.0",
		relaunch: {
			execPath: process.execPath,
			execArgv: [],
			args: ["serve", "--port", "4747"],
			cli: join(old, "dist", "cli.js"),
			packages: [join(scan, "node_modules", "carbonless-review")],
			scan: [scan],
			cwd: dir,
			env: { ...process.env, CRB_HELPER_MARK: "same env" },
			log: join(dir, "serve.log"),
		},
		log: join(dir, "update.log"),
		result: join(dir, "update-result.json"),
	};
}

const read = <T>(file: string): T =>
	JSON.parse(readFileSync(join(dir, file), "utf8")) as T;

describe("update helper", () => {
	it("waits for crb to exit, installs, leaves the result and starts the new version as crb was started", async () => {
		const crb = standInCrb();
		// biome-ignore lint/style/noNonNullAssertion: spawned.
		const c = config(crb.pid!);
		await startHelper(c, { source: SOURCE, tmp });
		// It read its config (and removed it: it holds crb's environment)
		// while crb still runs: nothing installed yet.
		await until(
			() => helperDirs().every((d) => !existsSync(join(tmp, d, "config.json"))),
			"config read",
		);
		expect(existsSync(join(dir, "installed.json"))).toBe(false);
		crb.stdin?.write("exit\n");
		await until(() => existsSync(join(dir, "relaunched.json")), "relaunch");
		expect(read("installed.json")).toEqual({
			args: ["add", "-g", "carbonless-review@0.3.0"],
			crbAlive: false,
			home: join(dir, "pnpm home"),
		});
		expect(read<UpdateResult>("update-result.json")).toMatchObject({
			version: "0.3.0",
			ok: true,
			tail: "added 1 package",
			command: "pnpm add -g carbonless-review@0.3.0",
		});
		// Node on the new version's cli.js, found where the install put it;
		// no shell, the space in its path no matter.
		expect(read("relaunched.json")).toEqual({
			cli: realpathSync(
				join(
					dir,
					"global v11",
					"new-1",
					"node_modules",
					"carbonless-review",
					"dist",
					"cli.js",
				),
			),
			args: ["serve", "--port", "4747"],
			cwd: realpathSync(dir),
			mark: "same env",
		});
		await until(
			() => readFileSync(join(dir, "serve.log"), "utf8").includes("listening"),
			"crb's output",
		);
		// crb's key line goes to serve.log, never update.log.
		const log = readFileSync(c.log, "utf8");
		expect(log).toContain("running pnpm add -g carbonless-review@0.3.0");
		expect(log).toContain("added 1 package");
		expect(log).not.toContain("SECRET");
		if (process.platform !== "win32") {
			expect(statSync(c.log).mode & 0o777).toBe(0o600);
			expect(statSync(join(dir, "serve.log")).mode & 0o777).toBe(0o600);
		}
		// Its own temp dir is gone.
		await until(() => helperDirs().length === 0, "helper dir removed");
	});

	it("a failed install: the result says so with the output, and the old crb starts again", async () => {
		const crb = standInCrb();
		// biome-ignore lint/style/noNonNullAssertion: spawned.
		await startHelper(config(crb.pid!, { installExit: 1 }), {
			source: SOURCE,
			tmp,
		});
		crb.stdin?.write("exit\n");
		await until(() => existsSync(join(dir, "relaunched.json")), "relaunch");
		const result = read<UpdateResult>("update-result.json");
		expect(result.ok).toBe(false);
		expect(result.tail).toContain("npm error 404 Not Found");
		expect(read<{ cli: string }>("relaunched.json").cli).toBe(
			realpathSync(join(dir, "old pkg", "dist", "cli.js")),
		);
		await until(() => helperDirs().length === 0, "helper dir removed");
	});

	it("a crb that doesn't exit: nothing installed, nothing started", async () => {
		const crb = standInCrb();
		try {
			// biome-ignore lint/style/noNonNullAssertion: spawned.
			await startHelper(config(crb.pid!, { waitMs: 0 }), {
				source: SOURCE,
				tmp,
			});
			await until(() => existsSync(join(dir, "update-result.json")), "result");
			expect(read<UpdateResult>("update-result.json")).toMatchObject({
				ok: false,
				tail: expect.stringContaining("did not exit"),
			});
			await until(() => helperDirs().length === 0, "helper dir removed");
			expect(existsSync(join(dir, "installed.json"))).toBe(false);
			expect(existsSync(join(dir, "relaunched.json"))).toBe(false);
		} finally {
			crb.kill();
		}
	});

	it("a helper that can't start leaves nothing behind (its config holds crb's environment)", async () => {
		await expect(
			startHelper(config(process.pid), {
				source: join(dir, "missing.ts"),
				tmp,
			}),
		).rejects.toThrow();
		expect(helperDirs()).toEqual([]);
	});

	it.runIf(process.platform === "win32")(
		"Windows: a .cmd in a path with a space runs through cmd.exe, its arguments quoted",
		async () => {
			const bin = join(dir, "pnpm home");
			mkdirSync(bin);
			const cmd = join(bin, "pnpm.cmd");
			writeFileSync(cmd, `@echo off\r\necho args: %*\r\n`);
			const { code, output } = await runCommand(
				{
					command: cmd,
					args: [
						"add",
						"-g",
						"--prefix",
						join(dir, "a b"),
						"carbonless-review@0.3.0",
					],
				},
				() => {},
			);
			expect(code).toBe(0);
			expect(output).toContain(
				`args: add -g --prefix "${join(dir, "a b")}" carbonless-review@0.3.0`,
			);
		},
	);

	it("cmd.exe quoting: plain as is, spaces quoted, what cmd.exe reads refused", () => {
		expect(cmdQuote("carbonless-review@0.3.0")).toBe("carbonless-review@0.3.0");
		expect(cmdQuote("C:\\Users\\Jane Doe\\pnpm.cmd")).toBe(
			'"C:\\Users\\Jane Doe\\pnpm.cmd"',
		);
		for (const bad of ['a"b', "a%PATH%", "a&b", "a|b", "a^b", "a!b", ""]) {
			expect(() => cmdQuote(bad), bad).toThrow();
		}
	});

	it("a service's install that hangs is killed after its timeout", async () => {
		const { code, output } = await runCommand(
			{
				command: process.execPath,
				args: ["-e", "setInterval(() => {}, 1000)"],
			},
			() => {},
			{ timeoutMs: 200 },
		);
		expect(code).not.toBe(0);
		expect(output).toContain("Timed out");
	});

	it("keeps the output's last lines", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join(
			"\r\n",
		);
		expect(tailOf(`${lines}\n`, 3)).toBe("line 47\nline 48\nline 49");
	});
});
