import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFlakeArgs } from "./flake-check-args.mjs";

describe("parseFlakeArgs", () => {
	const parse = (...a: string[]) => parseFlakeArgs(a);

	it("defaults: five runs, no busy loops", () => {
		expect(parse("src/a.test.ts")).toMatchObject({
			runs: 5,
			load: 0,
			units: ["src/a.test.ts"],
			specs: [],
		});
	});

	it("takes each option as --x=v or --x v", () => {
		const both = {
			runs: 3,
			load: 2,
			grep: "a title",
			projects: ["chromium"],
			units: ["src/a.test.tsx"],
			specs: ["e2e/b.spec.ts"],
		};
		expect(
			parse(
				"src/a.test.tsx",
				"--runs=3",
				"--load=2",
				"-g",
				"a title",
				"--project=chromium",
				"e2e/b.spec.ts",
			),
		).toEqual(both);
		expect(
			parse(
				"--runs",
				"3",
				"--load",
				"2",
				"--grep=a title",
				"--project",
				"chromium",
				"src/a.test.tsx",
				"e2e/b.spec.ts",
			),
		).toEqual(both);
	});

	it("refuses what it can't use rather than check nothing", () => {
		for (const bad of [
			["src/a.test.ts", "--runs=abc"],
			["src/a.test.ts", "--runs=0"],
			["src/a.test.ts", "--runs"],
			["src/a.test.ts", "--load=x"],
			["src/a.test.ts", "--load", "-1"],
			["src/a.test.ts", "--repeat=3"],
			["src/a.test.ts", "-g"],
			["src/a.ts"],
			["--runs=3"],
			[],
		]) {
			expect(parseFlakeArgs(bad), bad.join(" ")).toHaveProperty("error");
		}
	});
});

const hasPgrep = spawnSync("pgrep", ["--version"]).status === 0;

describe.skipIf(!hasPgrep)("flake-check", () => {
	const root = join(import.meta.dirname, "..");
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};

	it("a bad count exits 2 with the reason, running nothing", () => {
		const r = spawnSync(
			process.execPath,
			["scripts/flake-check.mjs", "src/a.test.ts", "--runs=abc"],
			{
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, CRB_NO_QUEUE: "1" },
			},
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--runs needs a whole number");
	});

	it("SIGTERM stops the run under way and the busy loops at once", {
		timeout: 60_000,
	}, async () => {
		// A file that takes far longer than the check below.
		const check = spawn(
			process.execPath,
			[
				"scripts/flake-check.mjs",
				"src/server/methodology-none.test.ts",
				"--runs=1",
				"--load=2",
			],
			{ cwd: root, env: { ...process.env, CRB_NO_QUEUE: "1" } },
		);
		let out = "";
		check.stdout?.on("data", (d) => {
			out += d;
		});
		const children = () =>
			(
				spawnSync("pgrep", ["-P", String(check.pid)], { encoding: "utf8" })
					.stdout ?? ""
			)
				.split("\n")
				.filter(Boolean)
				.map(Number);
		// Two loops and the run.
		while (children().length < 3 || !out.includes("RUN")) {
			await new Promise((r) => setTimeout(r, 50));
		}
		const started = children();
		const run = started.find(
			(pid) =>
				!/for\(;;\)/.test(
					spawnSync("ps", ["-o", "args=", "-p", String(pid)], {
						encoding: "utf8",
					}).stdout,
				),
		);
		const code = await new Promise<number | null>((done) => {
			check.once("exit", (c) => done(c));
			check.kill("SIGTERM");
		});
		expect(code).toBe(143);
		// The run never got to its summary, and nothing of it is left.
		expect(out).not.toContain("Test Files");
		for (const pid of started) {
			while (alive(pid)) await new Promise((r) => setTimeout(r, 50));
		}
		expect(run).toBeDefined();
		// The run's process group (Vitest and its workers) ends too.
		const inGroup = () =>
			(
				spawnSync("pgrep", ["-g", String(run)], { encoding: "utf8" }).stdout ??
				""
			).trim();
		while (inGroup()) await new Promise((r) => setTimeout(r, 50));
	});
});
