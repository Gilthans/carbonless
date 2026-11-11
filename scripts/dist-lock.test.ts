// CAR-117: a build for one test run must never change the dist another run
// in the same tree is serving. Runs the package scripts for real (queue.mjs,
// e2e.mjs, dist-lock.mjs, flock) in a throwaway tree, with fake pnpm, tsc,
// vite and playwright: no real build, no real Playwright.
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
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = import.meta.dirname;
// Each run spawns a handful of node processes; a loaded machine slows them.
const TIMEOUT = 60_000;

let tmp: string;
let tree: string;
let bin: string;
let out: string;
let home: string;
const started: ChildProcess[] = [];

const exe = (path: string, text: string) => {
	writeFileSync(path, text);
	chmodSync(path, 0o755);
};

beforeEach(() => {
	// A space in the path: the scripts must find each other by file path.
	tmp = mkdtempSync(join(tmpdir(), "crb dist-lock-"));
	tree = join(tmp, "tree");
	bin = join(tmp, "bin");
	out = join(tmp, "out");
	home = join(tmp, "home");
	for (const d of [join(tree, "scripts"), bin, out, home]) {
		mkdirSync(d, { recursive: true });
	}
	copyFileSync(join(here, "../package.json"), join(tree, "package.json"));
	for (const f of [
		"e2e.mjs",
		"dist-lock.mjs",
		"queue.mjs",
		"queue-config.mjs",
		"run-child.mjs",
	]) {
		copyFileSync(join(here, f), join(tree, "scripts", f));
	}
	// The build's steps: each run's build writes its own $STAMP into dist.
	exe(
		join(tree, "scripts", "build-info.mjs"),
		`import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/build-info.json", process.env.STAMP);
`,
	);
	exe(join(bin, "tsc"), "#!/bin/sh\nexit 0\n");
	exe(
		join(bin, "vite"),
		'#!/bin/sh\nmkdir -p dist/web && printf %s "$STAMP" > dist/web/index.html\n',
	);
	// pnpm: `exec <cmd>` runs it; `<script> [args]` runs package.json's
	// script in the tree with the args appended, as pnpm does.
	exe(
		join(bin, "pnpm"),
		`#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const [first, ...rest] = process.argv.slice(2);
const tree = ${JSON.stringify(tree)};
const quote = (a) => "'" + a.replaceAll("'", "'\\\\''") + "'";
const r = first === "exec"
	? spawnSync(rest[0], rest.slice(1), { stdio: "inherit" })
	: spawnSync("sh", ["-c", [JSON.parse(readFileSync(tree + "/package.json", "utf8")).scripts[first], ...rest.map(quote)].join(" ")], { stdio: "inherit", cwd: tree });
process.exit(r.status ?? 1);
`,
	);
	// playwright test: reads the dist it serves, says so, waits for
	// $OUT/$RUN.release when $HOLD is set, reads it again.
	exe(
		join(bin, "playwright"),
		`#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { OUT, RUN, HOLD } = process.env;
writeFileSync(OUT + "/" + RUN + ".pid", String(process.pid));
const dist = () => {
	try {
		return readFileSync("dist/build-info.json", "utf8") + "/" + readFileSync("dist/web/index.html", "utf8");
	} catch {
		return "missing";
	}
};
const before = dist();
writeFileSync(OUT + "/" + RUN + ".serving", before);
const end = () => {
	writeFileSync(OUT + "/" + RUN + ".result", JSON.stringify({ before, after: dist() }));
	process.exit(0);
};
if (!HOLD) end();
// The test gone (its tmp dir removed) or a minute passed: stop holding.
const deadline = Date.now() + 60000;
const t = setInterval(() => {
	if (!existsSync(OUT) || Date.now() > deadline) process.exit(1);
	if (existsSync(OUT + "/" + RUN + ".release")) {
		clearInterval(t);
		end();
	}
}, 20);
`,
	);
});

afterEach(() => {
	for (const c of started.splice(0)) {
		try {
			if (c.pid) process.kill(-c.pid, "SIGKILL");
		} catch {}
	}
	// queue.mjs starts the command in a process group of its own: the fake
	// Playwright isn't in the group above.
	for (const f of readdirSync(out).filter((f) => f.endsWith(".pid"))) {
		try {
			process.kill(Number(readFileSync(join(out, f), "utf8")), "SIGKILL");
		} catch {}
	}
	rmSync(tmp, { recursive: true, force: true });
});

function env(extra: Record<string, string>) {
	const e: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		PATH: [bin, dirname(process.execPath), process.env.PATH].join(":"),
		OUT: out,
		...extra,
	};
	// This test runs inside the real queue and maybe a dist hold: the runs
	// it starts belong to the throwaway tree and HOME only.
	for (const k of Object.keys(e)) {
		if (/^CRB_(QUEUE|DIST|NO_QUEUE)/.test(k)) delete e[k];
	}
	return e;
}

/** `pnpm test:e2e` in the tree, as run `run`; resolves to its exit and output. */
function testE2e(run: string, hold: boolean) {
	const child = spawn(join(bin, "pnpm"), ["test:e2e", "e2e/x.spec.ts"], {
		cwd: tree,
		env: env({ RUN: run, STAMP: run, ...(hold ? { HOLD: "1" } : {}) }),
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	started.push(child);
	let output = "";
	child.stdout?.on("data", (d) => {
		output += d;
	});
	child.stderr?.on("data", (d) => {
		output += d;
	});
	const exit = new Promise<number>((done) =>
		child.on("exit", (s) => done(s ?? 1)),
	);
	return { exit, output: () => output };
}

const until = async (cond: () => boolean) => {
	while (!cond()) await new Promise((r) => setTimeout(r, 20));
};

const served = () => {
	try {
		return `${readFileSync(join(tree, "dist/build-info.json"), "utf8")}/${readFileSync(join(tree, "dist/web/index.html"), "utf8")}`;
	} catch {
		return "missing";
	}
};

const result = (run: string) =>
	JSON.parse(readFileSync(join(out, `${run}.result`), "utf8"));

const hasFlock = spawnSync("flock", ["--version"]).status === 0;

describe.skipIf(!hasFlock)("a second e2e run in the same tree", () => {
	for (const slots of [1, 2]) {
		it(
			`doesn't change the dist the first serves (${slots} queue slot${slots > 1 ? "s" : ""})`,
			async () => {
				mkdirSync(join(home, ".config", "carbonless"), { recursive: true });
				writeFileSync(
					join(home, ".config", "carbonless", "queue.json"),
					JSON.stringify({ slots }),
				);
				const a = testE2e("A", true);
				await until(() => existsSync(join(out, "A.serving")));
				expect(readFileSync(join(out, "A.serving"), "utf8")).toBe("A/A");

				const b = testE2e("B", false);
				// B either waits for A's dist (fixed) or has already changed it.
				await until(
					() => b.output().includes("dist-lock: waiting") || served() !== "A/A",
				);
				expect(served()).toBe("A/A");

				writeFileSync(join(out, "A.release"), "");
				expect(await a.exit).toBe(0);
				expect(result("A")).toEqual({ before: "A/A", after: "A/A" });
				expect(await b.exit).toBe(0);
				// B then built and served its own dist.
				expect(result("B")).toEqual({ before: "B/B", after: "B/B" });
			},
			TIMEOUT,
		);
	}
});

describe.skipIf(!hasFlock)("dist-lock nesting", () => {
	const lock = (...args: string[]) =>
		spawnSync(
			process.execPath,
			[join(tree, "scripts/dist-lock.mjs"), ...args],
			{
				cwd: tree,
				env: env({}),
				encoding: "utf8",
				timeout: TIMEOUT,
			},
		);

	it(
		"a build inside a build's hold runs at once (test:pack's prepack)",
		() => {
			const r = lock(
				process.execPath,
				join(tree, "scripts/dist-lock.mjs"),
				"true",
			);
			expect(r.status).toBe(0);
		},
		TIMEOUT,
	);

	it(
		"a build inside a run that serves dist fails instead of changing it",
		() => {
			const r = lock(
				"--shared",
				process.execPath,
				join(tree, "scripts/dist-lock.mjs"),
				"true",
			);
			expect(r.status).toBe(1);
			expect(r.stderr).toMatch(/would change that dist/);
		},
		TIMEOUT,
	);

	it(
		"passes the command's exit status on",
		() => {
			expect(lock("sh", "-c", "exit 7").status).toBe(7);
			expect(lock("sh", "-c", "exit 200").status).toBe(1);
		},
		TIMEOUT,
	);

	it(
		"a command that can't start ends with 127 and says why",
		() => {
			const r = lock("crb-no-such-command");
			expect(r.status).toBe(127);
			expect(r.stderr).toMatch(/can't run crb-no-such-command: not found/);
		},
		TIMEOUT,
	);
});
