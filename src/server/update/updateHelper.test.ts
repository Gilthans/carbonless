import { type ChildProcess, spawn } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HELPER_DIR_PREFIX,
	type HelperConfig,
	tailOf,
	type UpdateResult,
} from "./updateHelper";

// Real processes, on Windows too (CI's windows-agent job runs this file):
// the helper copied out like crb copies it, a stand-in crb to wait for, a
// stand-in install and a stand-in relaunch, each a node script.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SOURCE = fileURLToPath(new URL("./updateHelper.ts", import.meta.url));

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "crb-helper-test-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A node script in `dir`. */
function script(name: string, body: string): string {
	const file = join(dir, name);
	writeFileSync(file, body);
	return file;
}

/** A stand-in crb: runs until told to exit (a line on stdin). */
function standInCrb(): ChildProcess {
	const child = spawn(
		process.execPath,
		["-e", "process.stdin.once('data', () => process.exit(0))"],
		{ stdio: ["pipe", "ignore", "ignore"] },
	);
	return child;
}

/** The helper copied to a crb-update-* dir of its own, run on `config`. */
function runHelper(config: HelperConfig): {
	exited: Promise<number | null>;
	helperDir: string;
	configFile: string;
} {
	const helperDir = mkdtempSync(join(dir, HELPER_DIR_PREFIX));
	const helper = join(helperDir, "update-helper.mts");
	copyFileSync(SOURCE, helper);
	const configFile = join(helperDir, "config.json");
	writeFileSync(configFile, JSON.stringify(config));
	const child = spawn(process.execPath, [helper, configFile], {
		stdio: "ignore",
		cwd: helperDir,
	});
	const exited = new Promise<number | null>((done) =>
		child.once("exit", (code) => done(code)),
	);
	return { exited, helperDir, configFile };
}

async function until(check: () => boolean, what: string): Promise<void> {
	const until = Date.now() + 20_000;
	while (!check()) {
		if (Date.now() > until) throw new Error(`never: ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

function config(
	crb: number,
	opts: { installExit?: number; waitMs?: number } = {},
): HelperConfig {
	const install = script(
		"install.mjs",
		`import { writeFileSync } from "node:fs";
let alive = true;
try { process.kill(${crb}, 0); } catch { alive = false; }
writeFileSync(${JSON.stringify(join(dir, "installed.json"))}, JSON.stringify({ args: process.argv.slice(2), crbAlive: alive }));
console.log("added 1 package");
${opts.installExit ? `console.error("npm error 404 Not Found");\nprocess.exit(${opts.installExit});` : ""}
`,
	);
	const relaunch = script(
		"crb.mjs",
		`import { writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "relaunched.json"))}, JSON.stringify({ args: process.argv.slice(2), cwd: realpathSync(process.cwd()), mark: process.env.CRB_HELPER_MARK }));
`,
	);
	return {
		pid: crb,
		waitMs: opts.waitMs ?? 20_000,
		version: "0.3.0",
		install: {
			command: process.execPath,
			args: [install, "install", "-g", "carbonless-review@0.3.0"],
		},
		display: "npm install -g carbonless-review@0.3.0",
		relaunch: {
			command: process.execPath,
			args: [relaunch, "serve", "--port", "4747"],
			cwd: dir,
			env: { ...process.env, CRB_HELPER_MARK: "same env" },
		},
		log: join(dir, "update.log"),
		result: join(dir, "update-result.json"),
	};
}

const read = <T>(file: string): T =>
	JSON.parse(readFileSync(join(dir, file), "utf8")) as T;

describe("update helper", () => {
	it("waits for crb to exit, installs, leaves the result and starts crb again as it was", async () => {
		const crb = standInCrb();
		// biome-ignore lint/style/noNonNullAssertion: spawned.
		const c = config(crb.pid!);
		const helper = runHelper(c);
		// The helper has read its config (and removed it: it holds crb's
		// environment) while crb still runs: nothing installed yet.
		await until(() => !existsSync(helper.configFile), "config read");
		expect(existsSync(join(dir, "installed.json"))).toBe(false);
		crb.stdin?.write("exit\n");
		expect(await helper.exited).toBe(0);
		expect(read("installed.json")).toEqual({
			args: ["install", "-g", "carbonless-review@0.3.0"],
			crbAlive: false,
		});
		expect(read<UpdateResult>("update-result.json")).toMatchObject({
			version: "0.3.0",
			ok: true,
			tail: "added 1 package",
			command: "npm install -g carbonless-review@0.3.0",
		});
		await until(() => existsSync(join(dir, "relaunched.json")), "relaunch");
		expect(read("relaunched.json")).toEqual({
			args: ["serve", "--port", "4747"],
			cwd: realpathSync(dir),
			mark: "same env",
		});
		const log = readFileSync(c.log, "utf8");
		expect(log).toContain("running npm install -g carbonless-review@0.3.0");
		expect(log).toContain("added 1 package");
		// Its own temp dir is gone.
		expect(existsSync(helper.helperDir)).toBe(false);
	});

	it("a failed install: the result says so with the output, and the old crb starts again", async () => {
		const crb = standInCrb();
		// biome-ignore lint/style/noNonNullAssertion: spawned.
		const helper = runHelper(config(crb.pid!, { installExit: 1 }));
		crb.stdin?.write("exit\n");
		expect(await helper.exited).toBe(0);
		const result = read<UpdateResult>("update-result.json");
		expect(result.ok).toBe(false);
		expect(result.tail).toContain("npm error 404 Not Found");
		await until(() => existsSync(join(dir, "relaunched.json")), "relaunch");
	});

	it("a crb that doesn't exit: nothing installed, nothing started", async () => {
		const crb = standInCrb();
		try {
			// biome-ignore lint/style/noNonNullAssertion: spawned.
			const helper = runHelper(config(crb.pid!, { waitMs: 0 }));
			expect(await helper.exited).toBe(0);
			expect(read<UpdateResult>("update-result.json")).toMatchObject({
				ok: false,
				tail: expect.stringContaining("did not exit"),
			});
			expect(existsSync(join(dir, "installed.json"))).toBe(false);
			expect(existsSync(join(dir, "relaunched.json"))).toBe(false);
		} finally {
			crb.kill();
		}
	});

	it("keeps the output's last lines", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join(
			"\r\n",
		);
		expect(tailOf(`${lines}\n`, 3)).toBe("line 47\nline 48\nline 49");
	});
});
