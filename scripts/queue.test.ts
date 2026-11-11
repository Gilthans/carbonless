import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queueSlots } from "./queue-config.mjs";
import { queuedWorkers, requireQueue } from "./queue-guard.mjs";

let home: string;
const env = { ...process.env };
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "crb-queue-"));
});
afterEach(() => {
	process.env = { ...env };
	rmSync(home, { recursive: true, force: true });
});

/** Writes this test's queue config; `null` removes it. */
const configure = (text: string | null) => {
	const dir = join(home, ".config", "carbonless");
	if (text === null) return rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "queue.json"), text);
};

describe("queue config and guard", () => {
	beforeEach(() => {
		process.env.HOME = home;
		delete process.env.CRB_QUEUE_HELD;
		delete process.env.CRB_NO_QUEUE;
	});

	it("no file: no queue, any run goes", () => {
		expect(queueSlots()).toBe(0);
		expect(() => requireQueue("pnpm test")).not.toThrow();
	});

	it("slots come from the file: 1 when missing or not a positive integer", () => {
		configure('{"slots": 3}');
		expect(queueSlots()).toBe(3);
		configure("{}");
		expect(queueSlots()).toBe(1);
		configure('{"slots": 0}');
		expect(queueSlots()).toBe(1);
		configure("not json");
		expect(queueSlots()).toBe(1);
	});

	it("with a queue, refuses a run outside it", () => {
		configure("{}");
		expect(() => requireQueue("pnpm test")).toThrow(/pnpm test/);
	});

	it("with a queue, lets a queued run, or one told to skip it, go", () => {
		configure("{}");
		process.env.CRB_QUEUE_HELD = "/tmp/holder";
		expect(() => requireQueue("pnpm test")).not.toThrow();
		delete process.env.CRB_QUEUE_HELD;
		process.env.CRB_NO_QUEUE = "1";
		expect(() => requireQueue("pnpm test")).not.toThrow();
	});

	it("a queued run gets the cores divided among the slots", () => {
		expect(queuedWorkers(8)).toBeUndefined();
		process.env.CRB_QUEUE_HELD = "/tmp/holder";
		process.env.CRB_QUEUE_SLOTS = "1";
		expect(queuedWorkers(8)).toBe(8);
		process.env.CRB_QUEUE_SLOTS = "3";
		expect(queuedWorkers(8)).toBe(2);
		process.env.CRB_QUEUE_SLOTS = "16";
		expect(queuedWorkers(8)).toBe(1);
	});
});

const hasFlock = spawnSync("flock", ["--version"]).status === 0;
const QUEUE = join(import.meta.dirname, "queue.mjs");

describe.skipIf(!hasFlock)("queue", () => {
	const started: ChildProcess[] = [];
	beforeEach(() => configure("{}"));
	afterEach(() => {
		for (const c of started) if (c.exitCode === null) c.kill("SIGKILL");
	});

	/** queue.mjs running `script` in sh, with HOME (so config and locks) in `home`. */
	const queue = (script: string) => {
		const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
		delete childEnv.CRB_NO_QUEUE;
		delete childEnv.CRB_QUEUE_HELD;
		delete childEnv.CRB_QUEUE_SINCE;
		delete childEnv.CRB_QUEUE_SLOTS;
		const child = spawn(process.execPath, [QUEUE, "sh", "-c", script], {
			env: childEnv,
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
	const lock = (i = 0) =>
		join(home, ".cache", `carbonless-verify.lock${i ? `.${i}` : ""}`);
	const free = (i = 0) =>
		spawnSync("flock", ["-n", lock(i), "true"]).status === 0;
	/** A run that holds its slot until `release` is touched. */
	const holdUntil = (name: string) => {
		const held = join(home, `${name}.held`);
		const release = join(home, `${name}.go`);
		const run = queue(
			`touch ${held}; while [ ! -e ${release} ]; do sleep 0.05; done`,
		);
		return {
			...run,
			held: () => existsSync(held),
			release: () => spawnSync("touch", [release]),
		};
	};

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
		const holder = holdUntil("a");
		await until(holder.held);
		expect(free()).toBe(false);
		const next = queue("exit 3");
		await until(() => next.out().includes("queue: waiting for"));
		holder.release();
		expect(await exited(holder.child)).toBe(0);
		expect(await exited(next.child)).toBe(3);
		expect(free()).toBe(true);
	});

	it("slots runs go at once; raising slots lets a waiting run go, no restart", {
		timeout: 30_000,
	}, async () => {
		configure('{"slots": 2}');
		const a = holdUntil("a");
		const b = holdUntil("b");
		await until(() => a.held() && b.held());
		expect(free(0) || free(1)).toBe(false);
		const c = holdUntil("c");
		await until(() => c.out().includes("queue: waiting for"));
		expect(c.held()).toBe(false);

		configure('{"slots": 3}');
		await until(c.held);
		expect(free(2)).toBe(false);
		for (const r of [a, b, c]) r.release();
		for (const r of [a, b, c]) expect(await exited(r.child)).toBe(0);
	});

	it("removing the config lets a waiting run go unqueued", {
		timeout: 30_000,
	}, async () => {
		const holder = holdUntil("a");
		await until(holder.held);
		const next = queue('[ -z "$CRB_QUEUE_HELD" ] && echo unqueued');
		await until(() => next.out().includes("queue: waiting for"));
		configure(null);
		expect(await exited(next.child)).toBe(0);
		expect(next.out()).toContain("unqueued");
		holder.release();
		expect(await exited(holder.child)).toBe(0);
	});

	it("a held command's own exit 200 doesn't read as a taken slot", {
		timeout: 30_000,
	}, async () => {
		const ran = join(home, "count");
		const run = queue(`echo x >> ${ran}; exit 200`);
		expect(await exited(run.child)).toBe(1);
		expect(readFileSync(ran, "utf8")).toBe("x\n");
	});
});
