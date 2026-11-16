import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Every write the helper makes is seen halfway: written cut short first,
// then `midway` looks at the files a reader would read, then the rest.
let midway: (() => void) | null = null;
vi.mock("node:fs", async (original) => {
	const real = await original<typeof import("node:fs")>();
	return {
		...real,
		writeFileSync: (...args: Parameters<typeof real.writeFileSync>) => {
			const [file, data] = args;
			if (midway && typeof file === "string" && typeof data === "string") {
				const opts = args[2];
				real.writeFileSync(file, data.slice(0, data.length >> 1), opts);
				midway();
				// The rest over the half (a "wx" create already happened).
				const rest = typeof opts === "object" && opts ? opts : {};
				real.writeFileSync(file, data, { ...rest, flag: "w" });
				return;
			}
			real.writeFileSync(...args);
		},
	};
});

const { RENAME_BACKOFF, runHelper, writeAtomic } = await import(
	"./updateHelper"
);

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "crb-helper-atomic-"));
});
afterEach(() => {
	midway = null;
	rmSync(dir, { recursive: true, force: true });
});

it("a reader never finds the result half-written (it appears whole or not at all)", async () => {
	const result = join(dir, "update-result.json");
	const seen: string[] = [];
	midway = () => {
		if (fs.existsSync(result)) seen.push(readFileSync(result, "utf8"));
	};
	// A crb that never exits (this process): the helper gives up at once
	// and writes its result, nothing else to run.
	await runHelper({
		pid: process.pid,
		waitMs: 0,
		version: "0.3.0",
		install: { command: process.execPath, args: ["-e", ""] },
		display: "pnpm add -g carbonless-review@0.3.0",
		relaunch: null,
		log: join(dir, "update.log"),
		result,
	});
	for (const text of seen) expect(() => JSON.parse(text), text).not.toThrow();
	expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({
		ok: false,
		version: "0.3.0",
	});
	// Nothing left beside it.
	expect(fs.readdirSync(dir).sort()).toEqual([
		"update-result.json",
		"update.log",
	]);
});

const busy = (code: string) =>
	Object.assign(new Error(`${code}: held`), { code });

it("Windows: a busy rename is tried again, the file lands whole, no temp file left", () => {
	const file = join(dir, "update-result.json");
	const waits: number[] = [];
	let tries = 0;
	writeAtomic(file, '{"ok":true}\n', {
		windows: true,
		sleep: (ms) => waits.push(ms),
		rename: (from, to) => {
			if (++tries <= 2) throw busy(tries === 1 ? "EPERM" : "EBUSY");
			fs.renameSync(from, to);
		},
	});
	expect(waits).toEqual(RENAME_BACKOFF.slice(0, 2));
	expect(readFileSync(file, "utf8")).toBe('{"ok":true}\n');
	expect(fs.readdirSync(dir)).toEqual(["update-result.json"]);
});

it("a rename that keeps failing: the file is written in place rather than lost, no temp file left", () => {
	for (const windows of [true, false]) {
		const file = join(dir, `result-${windows}.json`);
		const waits: number[] = [];
		writeAtomic(file, '{"ok":false}\n', {
			windows,
			sleep: (ms) => waits.push(ms),
			rename: () => {
				throw busy("EACCES");
			},
		});
		// Windows waits out the whole backoff; elsewhere it's a real error.
		expect(waits).toEqual(windows ? [...RENAME_BACKOFF] : []);
		expect(readFileSync(file, "utf8")).toBe('{"ok":false}\n');
	}
	expect(fs.readdirSync(dir).sort()).toEqual([
		"result-false.json",
		"result-true.json",
	]);
});

it("an earlier update's pid file is gone before this one starts crb", async () => {
	const result = join(dir, "update-result.json");
	const pidFile = join(dir, "update-relaunched.pid");
	fs.writeFileSync(pidFile, "12345\n");
	await runHelper({
		pid: process.pid,
		waitMs: 0,
		version: "0.3.0",
		install: { command: process.execPath, args: ["-e", ""] },
		display: "pnpm add -g carbonless-review@0.3.0",
		relaunch: null,
		log: join(dir, "update.log"),
		result,
	});
	expect(fs.existsSync(pidFile)).toBe(false);
});
