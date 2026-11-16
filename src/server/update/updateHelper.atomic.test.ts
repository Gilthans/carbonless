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
				real.writeFileSync(file, data.slice(0, data.length >> 1), args[2]);
				midway();
			}
			real.writeFileSync(...args);
		},
	};
});

const { runHelper } = await import("./updateHelper");

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
