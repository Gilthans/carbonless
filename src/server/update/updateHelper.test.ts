import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
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
/** The helpers this test started (startHelper's processes). */
let helpers: ChildProcess[] = [];
/** The stand-in crbs this test started. */
let crbs: ChildProcess[] = [];
beforeEach(() => {
	// A space in every path: a Windows profile like C:\Users\Jane Doe.
	dir = join(mkdtempSync(join(tmpdir(), "crb-helper-test-")), "with space");
	mkdirSync(dir);
	tmp = join(dir, "tmp");
	mkdirSync(tmp);
});
afterEach(async () => {
	// Windows refuses to remove a dir that a live process runs in or has a
	// file open in (EPERM): the helper runs from tmp, and the crb it starts
	// again from dir, writing serve.log. Both outlive what a test waits for
	// (the helper removes its own dir before it exits; crb's last line comes
	// before its exit): wait for each to exit, then remove.
	// A test that failed before telling its stand-in crb to exit: end it
	// now, or the helper waits it out (waitMs) and so does this hook.
	for (const crb of crbs) crb.kill();
	crbs = [];
	const known = helpers.flatMap((h) => (h.pid ? [h.pid] : []));
	for (const helper of helpers) await exited(helper);
	helpers = [];
	// Final once the helper has exited (it writes it just before).
	const pidFile = join(dir, "update-relaunched.pid");
	const relaunched = existsSync(pidFile)
		? Number(readFileSync(pidFile, "utf8"))
		: null;
	if (relaunched) {
		known.push(relaunched);
		await until(
			() => !running(relaunched),
			`the started crb (pid ${relaunched}) exits`,
		);
	}
	const top = join(dir, "..");
	expect(holders(top, known), "processes still in the test's dirs").toEqual([]);
	rmSync(top, { recursive: true, force: true });
});

/** Resolves once `child` has exited (its exit event, or already gone). */
async function exited(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await once(child, "exit");
}

/** Whether `pid` still runs (not ours to wait on: the helper started it). */
function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * The processes (Linux: /proc) whose current directory or an open file is
 * under `top`: what makes Windows refuse to remove it (EPERM). Empty
 * elsewhere.
 */
function holders(top: string, known: number[]): string[] {
	if (process.platform !== "linux") return [];
	const real = realpathSync(top);
	const under = (link: string) => link === real || link.startsWith(`${real}/`);
	const link = (path: string) => {
		try {
			return readlinkSync(path);
		} catch {
			return ""; // Gone meanwhile, or another user's.
		}
	};
	// The processes the test knows of first (a scan of every process takes
	// long enough for them to exit meanwhile), then every cwd, then the
	// open files (many).
	const pids = [
		...new Set([
			...known.map(String),
			...readdirSync("/proc").filter((e) => /^\d+$/.test(e)),
		]),
	];
	const found = pids
		.map((pid) => ({ pid, cwd: link(`/proc/${pid}/cwd`) }))
		.filter((p) => under(p.cwd))
		.map((p) => `${p.pid}: cwd ${p.cwd}`);
	for (const pid of pids) {
		let fds: string[] = [];
		try {
			fds = readdirSync(`/proc/${pid}/fd`);
		} catch {
			continue;
		}
		for (const fd of fds) {
			const target = link(`/proc/${pid}/fd/${fd}`);
			if (under(target)) found.push(`${pid}: fd ${target}`);
		}
	}
	return found;
}

/** Starts the helper as crb does, and keeps its process for afterEach. */
async function start(c: HelperConfig): Promise<void> {
	helpers.push(await startHelper(c, { source: SOURCE, tmp }));
}

function script(name: string, body: string): string {
	const file = join(dir, name);
	writeFileSync(file, body);
	return file;
}

/** A stand-in crb: runs until told to exit (a line on stdin). */
function standInCrb(): ChildProcess {
	const crb = spawn(
		process.execPath,
		["-e", "process.stdin.once('data', () => process.exit(0))"],
		{ stdio: ["pipe", "ignore", "ignore"] },
	);
	crbs.push(crb);
	return crb;
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
		await start(c);
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
		// Its pid, for whoever must stop it before it writes server.json.
		expect(
			Number(readFileSync(join(dir, "update-relaunched.pid"), "utf8")),
		).toBeGreaterThan(0);
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
		await start(config(crb.pid!, { installExit: 1 }));
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
			await start(config(crb.pid!, { waitMs: 0 }));
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
