import { execFile, execFileSync } from "node:child_process";
import {
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
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type LocalIo,
	NO_DELAY,
	parseBuild,
	prettyBuild,
	type RunResult,
	releaseLocal,
	tarballName,
} from "./release-local.js";

const here = dirname(fileURLToPath(import.meta.url));
const SHA = "abcdef0123456789abcdef0123456789abcdef01";

describe("tarball names", () => {
	it("names a tarball by version and short commit, -dirty kept", () => {
		expect(tarballName({ version: "0.1.0", commit: SHA })).toBe(
			"carbonless-review-0.1.0-abcdef0.tgz",
		);
		expect(tarballName({ version: "0.2.0-rc.3", commit: `${SHA}-dirty` })).toBe(
			"carbonless-review-0.2.0-rc.3-abcdef0-dirty.tgz",
		);
		expect(prettyBuild({ version: "0.1.0", commit: `${SHA}-dirty` })).toBe(
			"0.1.0 (abcdef0-dirty)",
		);
	});

	it("only takes a build-info with a version and a commit sha", () => {
		expect(
			parseBuild(JSON.stringify({ version: "0.1.0", commit: SHA })),
		).toEqual({ version: "0.1.0", commit: SHA });
		for (const bad of [
			{ version: "0.1.0" },
			{ version: "../../x", commit: SHA },
			{ version: "0.1.0", commit: "../evil" },
			{ version: "0.1.0", commit: `${SHA} ; rm` },
		]) {
			expect(() => parseBuild(JSON.stringify(bad))).toThrow("not a build");
		}
	});
});

describe("releaseLocal, over a fake runner", () => {
	let dir: string;
	let calls: string[];
	let packed: { version: string; commit: string } | null;
	let failing: string | null;
	let io: LocalIo;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-release-local-"));
		mkdirSync(join(dir, "root"));
		mkdirSync(join(dir, "scratch"));
		writeFileSync(
			join(dir, "root/package.json"),
			JSON.stringify({ name: "carbonless-review", version: "0.1.0" }),
		);
		calls = [];
		packed = { version: "0.1.0", commit: SHA };
		failing = null;
		const run = async (
			cmd: string,
			args: readonly string[],
		): Promise<RunResult> => {
			const line = `${cmd} ${args.join(" ")}`;
			calls.push(line);
			if (failing && line.startsWith(failing)) {
				return { code: 1, stdout: "", stderr: "boom" };
			}
			if (cmd === "pnpm" && args[0] === "pack") {
				writeFileSync(
					join(args[2] ?? "", "carbonless-review-0.1.0.tgz"),
					"tgz",
				);
			}
			if (cmd === "tar") {
				return { code: 0, stdout: JSON.stringify(packed), stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};
		io = { run, log: () => {} };
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const opts = (install = true) => ({
		root: join(dir, "root"),
		out: join(dir, "out"),
		install,
		scratch: join(dir, "scratch"),
	});

	it("packs, keeps the tarball under its build's name, and installs it globally", async () => {
		const tarball = await releaseLocal(io, opts());
		expect(tarball).toBe(join(dir, "out/carbonless-review-0.1.0-abcdef0.tgz"));
		expect(readFileSync(tarball, "utf8")).toBe("tgz");
		expect(calls).toEqual([
			`pnpm pack --pack-destination ${join(dir, "scratch")}`,
			`tar -xzOf ${join(dir, "scratch/carbonless-review-0.1.0.tgz")} package/dist/build-info.json`,
			`pnpm add -g ${tarball} ${NO_DELAY}`,
		]);
		expect(readdirSync(join(dir, "scratch"))).toEqual([]);
	});

	it("--no-install only packs; a dirty build says so in its name", async () => {
		packed = { version: "0.1.0", commit: `${SHA}-dirty` };
		const tarball = await releaseLocal(io, opts(false));
		expect(tarball.endsWith("carbonless-review-0.1.0-abcdef0-dirty.tgz")).toBe(
			true,
		);
		expect(calls.some((c) => c.startsWith("pnpm add"))).toBe(false);
	});

	it("fails, keeping nothing, when the pack fails or the build-info is bad", async () => {
		failing = "pnpm pack";
		await expect(releaseLocal(io, opts())).rejects.toThrow(
			"pnpm pack --pack-destination",
		);
		failing = null;
		packed = null;
		await expect(releaseLocal(io, opts())).rejects.toThrow("not a build");
		expect(existsSync(join(dir, "out"))).toBe(false);
		expect(calls.some((c) => c.startsWith("pnpm add"))).toBe(false);
	});

	it("refuses a checkout that isn't carbonless-review", async () => {
		writeFileSync(
			join(dir, "root/package.json"),
			JSON.stringify({ name: "other", version: "1.0.0" }),
		);
		await expect(releaseLocal(io, opts())).rejects.toThrow(
			"is not a carbonless-review checkout",
		);
		expect(calls).toEqual([]);
	});
});

// The real command, with the real pnpm and tar, on a tiny stand-in package
// (no dependencies, so no registry) in a temp git repo, installed into a
// temp PNPM_HOME.
describe("pnpm release local", { timeout: 120_000 }, () => {
	let dir: string;
	let env: NodeJS.ProcessEnv;
	const pkg = () => join(dir, "pkg");
	const pnpmHome = () => join(dir, "pnpm-home");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-release-cmd-"));
		mkdirSync(pkg());
		// Its prepack writes dist/build-info.json as scripts/build-info.mjs does.
		writeFileSync(
			join(pkg(), "package.json"),
			`${JSON.stringify(
				{
					name: "carbonless-review",
					version: "9.9.9-rc.1",
					bin: { crb: "dist/cli.js" },
					files: ["dist"],
					scripts: { prepack: "node build.mjs" },
				},
				null,
				"\t",
			)}\n`,
		);
		writeFileSync(
			join(pkg(), "build.mjs"),
			[
				'import { execFileSync } from "node:child_process";',
				'import { mkdirSync, writeFileSync } from "node:fs";',
				'const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();',
				'const commit = git("rev-parse", "HEAD") + (git("status", "--porcelain") ? "-dirty" : "");',
				'mkdirSync("dist", { recursive: true });',
				'writeFileSync("dist/build-info.json", JSON.stringify({ version: "9.9.9-rc.1", commit }));',
				'writeFileSync("dist/cli.js", "#!/usr/bin/env node\\nconsole.log(\\"stand-in " + commit + "\\");\\n");',
			].join("\n"),
		);
		writeFileSync(join(pkg(), ".gitignore"), "dist/\n");
		env = {
			...process.env,
			// Prepended, never replaced (the real-gh trap stays behind it).
			PATH: `${join(pnpmHome(), "bin")}:${dirname(process.execPath)}:${process.env.PATH}`,
			PNPM_HOME: pnpmHome(),
			XDG_DATA_HOME: join(dir, "data"),
			XDG_CACHE_HOME: join(dir, "cache"),
			XDG_CONFIG_HOME: join(dir, "config"),
			XDG_STATE_HOME: join(dir, "state"),
			npm_config_store_dir: join(dir, "store"),
			// Nothing may reach a registry.
			npm_config_registry: "http://127.0.0.1:9/",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		};
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: pkg(), env, encoding: "utf8" });
		git("init", "-q", "-b", "master");
		git("add", ".");
		git("commit", "-qm", "stand-in");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const release = (...args: string[]) =>
		new Promise<RunResult>((resolve) => {
			execFile(
				join(here, "../node_modules/.bin/tsx"),
				[join(here, "release.ts"), "local", ...args],
				{ cwd: pkg(), env },
				(error, stdout, stderr) =>
					resolve({
						code: error ? ((error as { code?: number }).code ?? 1) : 0,
						stdout,
						stderr,
					}),
			);
		});

	it("packs into ~/.local/share/carbonless/releases and installs the global crb; the last line is the tarball", async () => {
		const sha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: pkg(),
			encoding: "utf8",
		}).trim();
		const r = await release();
		expect(r.stderr).not.toMatch(/^error:/m);
		expect(r.code).toBe(0);
		const tarball = join(
			dir,
			`data/carbonless/releases/carbonless-review-9.9.9-rc.1-${sha.slice(0, 7)}.tgz`,
		);
		expect(r.stdout).toBe(`${tarball}\n`);
		expect(existsSync(tarball)).toBe(true);
		const crb = join(
			execFileSync("pnpm", ["bin", "-g"], { env, encoding: "utf8" }).trim(),
			"crb",
		);
		expect(execFileSync(crb, [], { env, encoding: "utf8" })).toBe(
			`stand-in ${sha}\n`,
		);
	});

	it("--out and --no-install pack only; uncommitted edits make a -dirty build", async () => {
		writeFileSync(join(pkg(), "edit.txt"), "work in progress\n");
		const out = join(dir, "elsewhere");
		const r = await release("--out", out, "--no-install");
		expect(r.code).toBe(0);
		const [name] = readdirSync(out);
		expect(name).toMatch(
			/^carbonless-review-9\.9\.9-rc\.1-[0-9a-f]{7}-dirty\.tgz$/,
		);
		expect(r.stdout).toBe(`${join(out, name ?? "")}\n`);
		expect(existsSync(join(pnpmHome(), "bin/crb"))).toBe(false);
	});

	it("refuses unknown arguments", async () => {
		const r = await release("--bogus");
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("usage: pnpm release local");
	});
});
