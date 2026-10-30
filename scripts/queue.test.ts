import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filteredRun } from "./queue-args.mjs";

describe("filteredRun", () => {
	const pw = (...a: string[]) =>
		filteredRun(["exec", "playwright", "test", ...a]);

	it("the whole suite, whatever its flags, queues", () => {
		expect(pw()).toBe(false);
		expect(pw("--project=chromium")).toBe(false);
		expect(pw("--project", "chromium")).toBe(false);
		expect(pw("--workers", "4", "-x", "--headed")).toBe(false);
		expect(pw("--repeat-each=3")).toBe(false);
	});

	it("specs, patterns and picked failures don't, after any flag", () => {
		expect(pw("e2e/files.spec.ts")).toBe(true);
		expect(pw("files")).toBe(true);
		expect(pw("-x", "e2e/files.spec.ts")).toBe(true);
		expect(pw("--headed", "e2e/files.spec.ts:12")).toBe(true);
		expect(pw("--debug", "files")).toBe(true);
		expect(pw("--project", "phone", "files")).toBe(true);
		expect(pw("-g", "title")).toBe(true);
		expect(pw("--grep=title")).toBe(true);
		expect(pw("--last-failed")).toBe(true);
		expect(pw("--only-changed=main")).toBe(true);
	});
});

const hasFlock = spawnSync("flock", ["--version"]).status === 0;
const QUEUE = join(import.meta.dirname, "queue.mjs");

describe.skipIf(!hasFlock)("queue", () => {
	let home: string;
	const started: ChildProcess[] = [];
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "crb-queue-"));
	});
	afterEach(() => {
		for (const c of started) if (c.exitCode === null) c.kill("SIGKILL");
		rmSync(home, { recursive: true, force: true });
	});

	/** queue.mjs running `script` in sh, with HOME (so the lock) in `home`. */
	const queue = (script: string) => {
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
		delete env.CRB_NO_QUEUE;
		delete env.CRB_QUEUE_HELD;
		delete env.CRB_QUEUE_SINCE;
		const child = spawn(process.execPath, [QUEUE, "sh", "-c", script], {
			env,
			cwd: home,
		});
		let out = "";
		child.stdout?.on("data", (d) => {
			out += d;
		});
		started.push(child);
		return { child, out: () => out };
	};
	const exited = (c: ChildProcess) =>
		new Promise<number | null>((done) => {
			if (c.exitCode !== null) done(c.exitCode);
			else c.once("exit", (code) => done(code));
		});
	const until = async (check: () => boolean) => {
		while (!check()) await new Promise((r) => setTimeout(r, 20));
	};
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const lock = () => join(home, ".cache", "carbonless-verify.lock");
	const free = () => spawnSync("flock", ["-n", lock(), "true"]).status === 0;

	it("a signal ends a wait, and stops a held run's whole group; the lock is free", {
		timeout: 30_000,
	}, async () => {
		const pidFile = join(home, "sleep.pid");
		const holder = queue(`sleep 60 & echo $! > ${pidFile}; wait`);
		await until(
			() => existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n"),
		);
		const sleeper = Number(readFileSync(pidFile, "utf8"));
		const ran = join(home, "ran");
		const waiter = queue(`touch ${ran}`);
		await until(() => waiter.out().includes("queue: waiting for"));
		expect(waiter.out()).toContain(`${home} (sh -c sleep 60`);

		// The waiter gives up: nothing of it waits on, or runs later.
		waiter.child.kill("SIGTERM");
		expect(await exited(waiter.child)).toBe(143);
		// The holder stops its shell and the shell's own child.
		holder.child.kill("SIGTERM");
		expect(await exited(holder.child)).toBe(143);
		await until(() => !alive(sleeper));
		expect(free()).toBe(true);
		expect(existsSync(ran)).toBe(false);
	});

	it("the next run goes once the holder is done, and its status comes back", {
		timeout: 30_000,
	}, async () => {
		const marker = join(home, "go");
		const held = join(home, "held");
		const holder = queue(
			`touch ${held}; while [ ! -e ${marker} ]; do sleep 0.05; done`,
		);
		await until(() => existsSync(held));
		expect(free()).toBe(false);
		const next = queue("exit 3");
		await until(() => next.out().includes("queue: waiting for"));
		spawnSync("touch", [marker]);
		expect(await exited(holder.child)).toBe(0);
		expect(await exited(next.child)).toBe(3);
		expect(free()).toBe(true);
	});
});
