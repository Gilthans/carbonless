import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownerToken } from "./owner.mjs";
import { queueSlots } from "./queue-config.mjs";
import {
	queuedWorkers,
	requireQueue,
	WORKER_BYTES,
	workersFor,
} from "./queue-guard.mjs";
import {
	isFullRun,
	joinLine,
	line,
	tickets as lineTickets,
	markHeld,
	mayTry,
	startTime,
	ticketKind,
	ticketState,
} from "./queue-line.mjs";

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

	const GB = 2 ** 30;

	it("a queued run whose line can't say who runs gets the cores but one divided among the slots", () => {
		expect(queuedWorkers(8, 64 * GB)).toBeUndefined();
		process.env.CRB_QUEUE_HELD = "/tmp/holder";
		process.env.CRB_QUEUE_SLOTS = "1";
		expect(queuedWorkers(8, 64 * GB)).toBe(7);
		expect(queuedWorkers(1, 64 * GB)).toBe(1);
		process.env.CRB_QUEUE_SLOTS = "3";
		expect(queuedWorkers(8, 64 * GB)).toBe(2);
		process.env.CRB_QUEUE_SLOTS = "2";
		expect(queuedWorkers(4, 64 * GB)).toBe(1);
		process.env.CRB_QUEUE_SLOTS = "16";
		expect(queuedWorkers(8, 64 * GB)).toBe(1);
	});

	it("a queued run's workers: the cores but one shared among the runs holding a slot now, as the memory allows", {
		timeout: 30_000,
	}, () => {
		process.env.CRB_QUEUE_HELD = "/tmp/holder";
		process.env.CRB_QUEUE_SLOTS = "2";
		const dir = join(home, ".cache", "carbonless-queue");
		// This run holds a slot, alone: a full run keeps the machine's cores.
		const me = joinLine(dir);
		markHeld(me.path);
		expect(queuedWorkers(8, 64 * GB)).toBe(7);
		// Another run comes in: one starting now gets half.
		const other = spawn("sleep", ["30"]);
		try {
			const pid = other.pid as number;
			const ticket = join(dir, `${"1".padStart(20, "0")}-${pid}`);
			writeFileSync(ticket, `${pid} ${startTime(pid)} - short\n`);
			// Still waiting: not sharing the machine yet.
			expect(queuedWorkers(8, 64 * GB)).toBe(7);
			markHeld(ticket);
			expect(queuedWorkers(8, 64 * GB)).toBe(3);
			// Memory short: fewer, never none.
			expect(queuedWorkers(8, 2 * WORKER_BYTES)).toBe(2);
			expect(queuedWorkers(8, 0)).toBe(1);
		} finally {
			other.kill("SIGKILL");
			me.leave();
		}
	});

	it("workers: (cores - 1) / runs sharing, at most what the memory holds, at least one", () => {
		const w = (cores: number, sharing: number, gb: number) =>
			workersFor({ cores, sharing, freeBytes: gb * GB });
		expect(w(8, 1, 30)).toBe(7);
		expect(w(8, 2, 30)).toBe(3);
		expect(w(16, 2, 30)).toBe(7);
		expect(w(8, 1, 6)).toBe(Math.floor((6 * GB) / WORKER_BYTES));
		expect(w(1, 1, 30)).toBe(1);
		expect(w(8, 0, 30)).toBe(7);
		expect(w(8, 1, 0)).toBe(1);
	});
});

describe("full runs", () => {
	const node = "/usr/bin/node";
	const e2e = [node, "/t/scripts/dist-lock.mjs", "--shared", "pnpm", "exec"];
	it.each([
		// pnpm test, pnpm test:changed, pnpm test <file>
		[["vitest", "run"], true],
		[["vitest", "run", "--changed"], false],
		[["vitest", "run", "src/x.test.ts"], false],
		[["vitest", "run", "queue"], false],
		[["vitest", "run", "-t", "a title"], true],
		[["vitest", "run", "--reporter", "dot"], true],
		// verify:fast's unit steps
		[
			[
				"pnpm",
				"exec",
				"vitest",
				"run",
				"--changed",
				"master",
				"--passWithNoTests",
			],
			false,
		],
		[["pnpm", "exec", "vitest", "run", "src/cli.test.ts"], false],
		// test-outcomes' rerun
		[[node, "node_modules/vitest/vitest.mjs", "run", "src/a.test.ts"], false],
		// test:e2e, with and without specs (verify:fast's all specs too)
		[[...e2e, "playwright", "test"], true],
		[[...e2e, "playwright", "test", "--project=chromium"], true],
		[
			[
				...e2e,
				"playwright",
				"test",
				"--project",
				"chromium",
				"--repeat-each",
				"3",
			],
			true,
		],
		[[...e2e, "playwright", "test", "e2e/files.spec.ts"], false],
		[
			[
				...e2e,
				"playwright",
				"test",
				...Array.from({ length: 10 }, (_, i) => `e2e/${i}.spec.ts`),
			],
			false,
		],
		[
			[
				...e2e,
				"playwright",
				"test",
				...Array.from({ length: 11 }, (_, i) => `e2e/${i}.spec.ts`),
			],
			true,
		],
		[[...e2e, "playwright", "test", "-g", "a title"], false],
		[[...e2e, "playwright", "test", "--grep=a title"], false],
		[
			[
				node,
				"node_modules/@playwright/test/cli.js",
				"test",
				"e2e/a.spec.ts:12",
			],
			false,
		],
		// flake-check names its tests
		[
			[node, "/t/scripts/flake-check.mjs", "e2e/a.spec.ts", "--runs", "5"],
			false,
		],
		// pnpm verify, and anything unknown: full, so a mistake only waits
		[["sh", "-c", "pnpm test && pnpm test:e2e && pnpm test:pack"], true],
		[["sh", "-c", "vitest run a.test.ts"], true],
		[["make", "check"], true],
	])("%j is full: %s", (argv, full) => {
		const [cmd, ...args] = argv as string[];
		expect(isFullRun(cmd as string, args)).toBe(full);
	});

	const t = (name: string, full: boolean, held = false) => ({
		name,
		full,
		held,
	});
	const go = (l: ReturnType<typeof t>[], slots: number) => [
		...mayTry(l, slots),
	];

	it("one slot: the oldest waiter goes once nothing holds it", () => {
		expect(go([t("a", true), t("b", false)], 1)).toEqual(["a"]);
		expect(go([t("a", false, true), t("b", false)], 1)).toEqual([]);
		expect(go([], 1)).toEqual([]);
	});

	it("two slots: never two full runs; a short one passes a full one that waits for the full run", () => {
		// Two full runs arrive: the second waits even with a slot free.
		expect(go([t("a", true), t("b", true)], 2)).toEqual(["a"]);
		expect(go([t("a", true, true), t("b", true)], 2)).toEqual([]);
		// ...and a short one behind it takes the free slot.
		expect(go([t("a", true, true), t("b", true), t("c", false)], 2)).toEqual([
			"c",
		]);
		expect(go([t("a", true), t("b", true), t("c", false)], 2)).toEqual([
			"a",
			"c",
		]);
		// The full run done: the full one that waited goes first.
		expect(go([t("b", true), t("c", false, true), t("d", false)], 2)).toEqual([
			"b",
		]);
		// Short runs share the slots; a full one goes beside a short one.
		expect(go([t("a", false), t("b", false), t("c", false)], 2)).toEqual([
			"a",
			"b",
		]);
		expect(go([t("a", false, true), t("b", true)], 2)).toEqual(["b"]);
	});

	it("held runs beyond the slots (slots lowered meanwhile) let none in", () => {
		expect(
			go([t("a", false, true), t("b", false, true), t("c", false)], 1),
		).toEqual([]);
	});

	it("a ticket says its kind and, once marked, that it holds a slot; an older one counts as full and waiting", () => {
		const dir = mkdtempSync(join(tmpdir(), "crb-line-"));
		try {
			const me = joinLine(dir, { full: false });
			expect(lineTickets(dir)).toEqual([
				{ name: me.name, full: false, held: false },
			]);
			markHeld(me.path);
			markHeld(me.path);
			expect(lineTickets(dir)).toEqual([
				{ name: me.name, full: false, held: true },
			]);
			expect(ticketState(readFileSync(me.path, "utf8"))).toBe("live");
			me.leave();

			const old = `${process.pid} ${startTime(process.pid)} pid:[1]`;
			expect(ticketKind(old)).toEqual({ full: true, held: false });
			expect(joinLine(dir).turn(2)).toEqual({ go: true, ahead: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("queue line tickets", () => {
	const started: ChildProcess[] = [];
	afterEach(() => {
		for (const c of started) if (c.exitCode === null) c.kill("SIGKILL");
	});
	const state = (pid: number) => {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			return stat.slice(stat.lastIndexOf(")") + 2)[0];
		} catch {
			return "";
		}
	};
	const until = async (check: () => boolean) => {
		while (!check()) await new Promise((r) => setTimeout(r, 20));
	};
	const ticketOf = (pid: number) => `${pid} ${startTime(pid)}`;

	it("a ticket is live only while its pid runs with the start time it wrote", () => {
		expect(ticketState(ticketOf(process.pid))).toBe("live");
		// The pid now belongs to another process (pid reuse).
		expect(ticketState(`${process.pid} 1`)).toBe("dead");
		expect(ticketState("")).toBe("dead");
		const gone = spawnSync("true").pid as number;
		expect(ticketState(ticketOf(gone))).toBe("dead");
	});

	it.skipIf(!existsSync("/proc/self/stat"))(
		"a zombie's ticket is dead, a stopped run's is stopped",
		{ timeout: 30_000 },
		async () => {
			// A child killed while its parent is stopped stays unreaped.
			const parent = spawn("sh", ["-c", "sleep 30 & echo $!; wait"]);
			started.push(parent);
			let out = "";
			parent.stdout?.on("data", (d) => {
				out += d;
			});
			await until(() => out.endsWith("\n"));
			const zombie = Number(out);
			parent.kill("SIGSTOP");
			await until(() => state(parent.pid as number) === "T");
			process.kill(zombie, "SIGKILL");
			await until(() => state(zombie) === "Z");
			expect(ticketState(ticketOf(zombie))).toBe("dead");

			const stopped = spawn("sleep", ["30"]);
			started.push(stopped);
			const pid = stopped.pid as number;
			const ticket = ticketOf(pid);
			stopped.kill("SIGSTOP");
			await until(() => state(pid) === "T");
			expect(ticketState(ticket)).toBe("stopped");
			stopped.kill("SIGCONT");
			await until(() => state(pid) === "S" || state(pid) === "R");
			expect(ticketState(ticket)).toBe("live");
		},
	);

	it("a ticket from another pid namespace isn't counted, and is removed only a day old", () => {
		const dir = mkdtempSync(join(tmpdir(), "crb-line-"));
		try {
			const gone = spawnSync("true").pid as number;
			const foreign = `${"1".padStart(20, "0")}-${gone}`;
			writeFileSync(join(dir, foreign), `${gone} 5 pid:[1]\n`);
			expect(ticketState(`${gone} 5 pid:[1]`)).toBe("foreign");
			expect(line(dir)).toEqual([]);
			expect(existsSync(join(dir, foreign))).toBe(true);
			// A day old: left over, removed.
			const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
			utimesSync(join(dir, foreign), twoDaysAgo, twoDaysAgo);
			expect(line(dir)).toEqual([]);
			expect(existsSync(join(dir, foreign))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a run whose ticket vanished rejoins whole, is never first without one, and falls back to no line when it can't rejoin", () => {
		const dir = mkdtempSync(join(tmpdir(), "crb-line-"));
		const me = joinLine(dir);
		try {
			expect(me.place()).toBe(0);
			rmSync(join(dir, me.name));
			expect(me.place()).toBe(0);
			expect(ticketState(readFileSync(join(dir, me.name), "utf8"))).toBe(
				"live",
			);
			// Gone and can't be written back: not in line, so not first...
			rmSync(join(dir, me.name));
			chmodSync(dir, 0o555);
			const warn = vi.spyOn(console, "error").mockImplementation(() => {});
			expect(me.place()).toBe(Number.POSITIVE_INFINITY);
			expect(me.place()).toBe(Number.POSITIVE_INFINITY);
			expect(warn).not.toHaveBeenCalled();
			// ...until a few rewrites in a row failed: then it tries the slots
			// without the line, and says so once.
			expect(me.place()).toBe(0);
			expect(me.place()).toBe(0);
			expect(warn).toHaveBeenCalledOnce();
			expect(String(warn.mock.calls[0]?.[0])).toContain("without the line");
			warn.mockRestore();
		} finally {
			chmodSync(dir, 0o755);
			me.leave();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

const hasFlock = spawnSync("flock", ["--version"]).status === 0;
const realFlock = hasFlock
	? spawnSync("sh", ["-c", "command -v flock"], {
			encoding: "utf8",
		}).stdout.trim()
	: "";
const QUEUE = join(import.meta.dirname, "queue.mjs");

describe.skipIf(!hasFlock)("queue", () => {
	const started: ChildProcess[] = [];
	beforeEach(() => configure("{}"));
	afterEach(() => {
		for (const c of started) if (c.exitCode === null) c.kill("SIGKILL");
	});

	/**
	 * A `flock` that logs each attempt at a slot by the run `CRB_TEST_NAME`
	 * names to `attempts()`, then is the real one.
	 */
	const fakeFlock = () => {
		const bin = join(home, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "flock"),
			`#!/bin/sh\n[ "$1" = -n ] && echo "$CRB_TEST_NAME" >> ${join(home, "flock.log")}\nexec ${realFlock} "$@"\n`,
			{ mode: 0o755 },
		);
		return bin;
	};
	const attempts = () => {
		try {
			return readFileSync(join(home, "flock.log"), "utf8")
				.split("\n")
				.filter(Boolean);
		} catch {
			return [];
		}
	};
	const tickets = () => {
		try {
			return readdirSync(join(home, ".cache", "carbonless-queue"));
		} catch {
			return [];
		}
	};

	/**
	 * queue.mjs running `script` in sh, with HOME (so config and locks) in
	 * `home`. `as`: the name its flock attempts log under, and how often it
	 * polls. `env`: on top of the rest.
	 */
	/**
	 * A `vitest` that runs $CRB_TEST_SCRIPT in sh: `vitest run only.test.ts`
	 * is a short run to the queue, where `sh -c` is a full one.
	 */
	const fakeVitest = () => {
		const bin = join(home, "vitest-bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "vitest"),
			'#!/bin/sh\nexec sh -c "$CRB_TEST_SCRIPT"\n',
			{ mode: 0o755 },
		);
		return join(bin, "vitest");
	};
	const queue = (
		script: string,
		as?: { name: string; pollMs: number },
		env: NodeJS.ProcessEnv = {},
		short = false,
	) => {
		const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
		if (as) {
			childEnv.PATH = `${fakeFlock()}:${process.env.PATH}`;
			childEnv.CRB_TEST_NAME = as.name;
			childEnv.CRB_QUEUE_POLL_MS = String(as.pollMs);
		}
		delete childEnv.CRB_NO_QUEUE;
		delete childEnv.CRB_QUEUE_HELD;
		delete childEnv.CRB_QUEUE_SINCE;
		delete childEnv.CRB_QUEUE_SLOTS;
		Object.assign(childEnv, env);
		if (short) childEnv.CRB_TEST_SCRIPT = script;
		const command = short
			? [fakeVitest(), "run", "only.test.ts"]
			: ["sh", "-c", script];
		const child = spawn(process.execPath, [QUEUE, ...command], {
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
	/**
	 * A run that holds its slot until `release` is touched; a full run
	 * unless `short`.
	 */
	const holdUntil = (name: string, pollMs?: number, short = false) => {
		const held = join(home, `${name}.held`);
		const release = join(home, `${name}.go`);
		const run = queue(
			`touch ${held}; while [ ! -e ${release} ]; do sleep 0.05; done`,
			pollMs ? { name, pollMs } : undefined,
			{},
			short,
		);
		return {
			...run,
			held: () => existsSync(held),
			release: () => spawnSync("touch", [release]),
		};
	};

	it("a run nested in a held slot, or with no queue, needs no line and waits for none", {
		timeout: 30_000,
	}, async () => {
		// queue.mjs without queue-line.mjs (as another tree's copy may be).
		const alone = join(home, "alone");
		mkdirSync(alone);
		for (const f of ["queue.mjs", "queue-config.mjs", "owner.mjs"])
			copyFileSync(join(import.meta.dirname, f), join(alone, f));
		const run = (env: NodeJS.ProcessEnv) =>
			spawnSync(process.execPath, [join(alone, "queue.mjs"), "true"], {
				env: {
					...process.env,
					HOME: home,
					CRB_NO_QUEUE: "",
					CRB_QUEUE_SINCE: "",
					...env,
				},
				timeout: 20_000,
			}).status;
		// A holder in line and in the slot: a nested run still goes at once.
		const a = holdUntil("a");
		await until(a.held);
		expect(tickets().length).toBe(1);
		expect(run({ CRB_QUEUE_HELD: join(home, "nested.holder") })).toBe(0);
		configure(null);
		expect(run({ CRB_QUEUE_HELD: "" })).toBe(0);
		a.release();
		expect(await exited(a.child)).toBe(0);
	});

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
		// Neither left a ticket in the line.
		expect(tickets()).toEqual([]);
	});

	it("waiters go in arrival order, even when a later one polls faster", {
		timeout: 30_000,
	}, async () => {
		// The slot is held outside the line (a run from an older queue.mjs),
		// so b, first in line, keeps trying it.
		mkdirSync(join(home, ".cache"), { recursive: true });
		const aHeld = join(home, "a.held");
		const aGo = join(home, "a.go");
		const a = spawn(realFlock, [
			lock(0),
			"sh",
			"-c",
			`touch ${aHeld}; while [ ! -e ${aGo} ]; do sleep 0.05; done`,
		]);
		started.push(a);
		await until(() => existsSync(aHeld));
		const b = holdUntil("b", 1000);
		await until(() => b.out().includes("queue: waiting for"));
		const c = holdUntil("c", 20);
		await until(() => c.out().includes("queue: waiting for"));
		// Free the slot just after b tried it: c, polling every 20 ms, gets
		// there first if the fastest poll wins.
		const tried = attempts().filter((n) => n === "b").length;
		await until(() => attempts().filter((n) => n === "b").length > tried);
		spawnSync("touch", [aGo]);
		await until(() => b.held() || c.held());
		expect(b.held()).toBe(true);
		expect(c.held()).toBe(false);
		// c, second in line, never even tried the lock, and said so.
		expect(attempts()).not.toContain("c");
		expect(c.out()).toContain("(1 ahead)");

		b.release();
		await until(c.held);
		c.release();
		for (const r of [a, b.child, c.child]) expect(await exited(r)).toBe(0);
		expect(tickets()).toEqual([]);
	});

	it("a stopped waiter lets the ones behind it go, and keeps its place", {
		timeout: 30_000,
	}, async () => {
		const a = holdUntil("a");
		await until(a.held);
		const b = holdUntil("b", 20);
		await until(() => b.out().includes("queue: waiting for"));
		b.child.kill("SIGSTOP");
		const c = holdUntil("c", 20);
		await until(() => c.out().includes("queue: waiting for"));
		a.release();
		await until(c.held);
		expect(b.held()).toBe(false);
		expect(tickets().some((t) => t.endsWith(`-${b.child.pid}`))).toBe(true);

		b.child.kill("SIGCONT");
		c.release();
		await until(b.held);
		b.release();
		for (const r of [a, b, c]) expect(await exited(r.child)).toBe(0);
		expect(tickets()).toEqual([]);
	});

	it("a waiter killed with SIGKILL, or a ticket whose pid was reused, doesn't block the line", {
		timeout: 30_000,
	}, async () => {
		const a = holdUntil("a");
		await until(a.held);
		const b = holdUntil("b", 20);
		await until(() => b.out().includes("queue: waiting for"));
		b.child.kill("SIGKILL");
		await exited(b.child);
		const bTicket = `-${b.child.pid}`;
		expect(tickets().some((t) => t.endsWith(bTicket))).toBe(true);
		// Oldest of all, of a live pid, but a process that started later.
		const reused = `${"1".padStart(20, "0")}-${process.pid}`;
		writeFileSync(
			join(home, ".cache", "carbonless-queue", reused),
			`${process.pid} 1\n`,
		);

		const c = holdUntil("c", 20);
		await until(() => c.out().includes("queue: waiting for"));
		a.release();
		await until(c.held);
		expect(tickets().some((t) => t.endsWith(bTicket))).toBe(false);
		expect(tickets()).not.toContain(reused);
		c.release();
		for (const r of [a, c]) expect(await exited(r.child)).toBe(0);
		expect(tickets()).toEqual([]);
	});

	it("with 2 slots, the two oldest waiters go in", {
		timeout: 30_000,
	}, async () => {
		configure('{"slots": 2}');
		const h1 = holdUntil("h1", undefined, true);
		const h2 = holdUntil("h2", undefined, true);
		await until(() => h1.held() && h2.held());
		const w1 = holdUntil("w1", 1000, true);
		await until(() => w1.out().includes("queue: waiting for"));
		const w2 = holdUntil("w2", 1000, true);
		await until(() => w2.out().includes("queue: waiting for"));
		const w3 = holdUntil("w3", 20, true);
		await until(() => w3.out().includes("queue: waiting for"));

		h1.release();
		h2.release();
		const waiters = [w1, w2, w3];
		await until(() => waiters.filter((w) => w.held()).length >= 2);
		expect(waiters.map((w) => w.held())).toEqual([true, true, false]);
		expect(attempts()).not.toContain("w3");

		w1.release();
		await until(w3.held);
		w2.release();
		w3.release();
		for (const r of [h1, h2, ...waiters]) expect(await exited(r.child)).toBe(0);
		expect(tickets()).toEqual([]);
	});

	it("with 2 slots, a second full run waits while a short one behind it takes the free slot", {
		timeout: 30_000,
	}, async () => {
		configure('{"slots": 2}');
		const f1 = holdUntil("f1");
		await until(f1.held);
		const f2 = holdUntil("f2", 20);
		await until(() => f2.out().includes("queue: waiting for"));
		expect(f2.out()).toContain("full runs go one at a time");
		const s = holdUntil("s", 20, true);
		await until(s.held);
		// The ticket of each run holding a slot says so; f2's doesn't.
		const now = lineTickets(join(home, ".cache", "carbonless-queue"));
		expect(now.map((t) => [t.full, t.held])).toEqual([
			[true, true],
			[true, false],
			[false, true],
		]);
		expect(f2.held()).toBe(false);

		f1.release();
		await until(f2.held);
		f2.release();
		s.release();
		for (const r of [f1, f2, s]) expect(await exited(r.child)).toBe(0);
		expect(tickets()).toEqual([]);
	});

	it("a full run holds the full lock while it runs; a short one doesn't", {
		timeout: 30_000,
	}, async () => {
		configure('{"slots": 2}');
		const fullFree = () =>
			spawnSync("flock", [
				"-n",
				join(home, ".cache", "carbonless-verify.lock.full"),
				"true",
			]).status === 0;
		const s = holdUntil("s", undefined, true);
		await until(s.held);
		expect(fullFree()).toBe(true);
		const f = holdUntil("f");
		await until(f.held);
		expect(fullFree()).toBe(false);
		f.release();
		expect(await exited(f.child)).toBe(0);
		expect(fullFree()).toBe(true);
		s.release();
		expect(await exited(s.child)).toBe(0);
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
		const a = holdUntil("a", undefined, true);
		const b = holdUntil("b", undefined, true);
		await until(() => a.held() && b.held());
		expect(free(0) || free(1)).toBe(false);
		const c = holdUntil("c", undefined, true);
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

	/** A run holding its slot in sh, which writes its pid to `<name>.pid`. */
	const holdWithPid = (name: string, env: NodeJS.ProcessEnv = {}) => {
		const pidFile = join(home, `${name}.pid`);
		const run = queue(
			`echo $$ > ${pidFile}; while :; do sleep 0.05; done`,
			undefined,
			env,
		);
		return {
			...run,
			pid: async () => {
				await until(
					() =>
						existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n"),
				);
				return Number(readFileSync(pidFile, "utf8"));
			},
		};
	};

	it("a held run whose waiter is killed with SIGKILL stops its command and frees the slot", {
		timeout: 30_000,
	}, async () => {
		const a = holdWithPid("a");
		const sh = await a.pid();
		a.child.kill("SIGKILL");
		await exited(a.child);
		await until(() => !alive(sh));
		await until(() => free());
	});

	it("runs whose $CRB_OWNER is gone stop, the one holding and the one waiting", {
		timeout: 30_000,
	}, async () => {
		const owner = spawn("sleep", ["60"]);
		started.push(owner);
		const env = { CRB_OWNER: ownerToken(owner.pid as number) };
		const holder = holdWithPid("a", env);
		const sh = await holder.pid();
		// Polls slower than its owner watch (1 s): never takes the freed slot first.
		const waiter = queue("true", undefined, {
			...env,
			CRB_QUEUE_POLL_MS: "5000",
		});
		await until(() => waiter.out().includes("queue: waiting for"));

		owner.kill("SIGKILL");
		expect(await exited(waiter.child)).toBe(143);
		expect(await exited(holder.child)).toBe(143);
		expect(alive(sh)).toBe(false);
		expect(free()).toBe(true);
		expect(tickets()).toEqual([]);
	});

	it("once $CRB_OWNER is gone, a member of the command's group that ignores SIGTERM gets SIGKILL", {
		timeout: 30_000,
	}, async () => {
		const owner = spawn("sleep", ["60"]);
		started.push(owner);
		const pidFile = join(home, "stubborn.pid");
		const run = queue(
			`sh -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 0.05; done' & wait`,
			undefined,
			{ CRB_OWNER: ownerToken(owner.pid as number) },
		);
		await until(
			() => existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n"),
		);
		const stubborn = Number(readFileSync(pidFile, "utf8"));

		owner.kill("SIGKILL");
		expect(await exited(run.child)).toBe(143);
		await until(() => !alive(stubborn));
		expect(free()).toBe(true);
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
