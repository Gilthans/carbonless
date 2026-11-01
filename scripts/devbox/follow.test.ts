import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// scripts/devbox/follow against temp dirs: a real git origin and repo, and
// stand-ins for npm, pnpm and update. systemctl and journalctl fail the test
// if anything calls them.
const here = dirname(fileURLToPath(import.meta.url));

interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

describe("scripts/devbox/follow", { timeout: 60_000 }, () => {
	let dir: string;
	let env: NodeJS.ProcessEnv;
	let holder: ChildProcess | undefined;
	let commits = 0;
	const repo = () => join(dir, "repo");
	const tree = () => join(repo(), ".worktrees/follow");
	const releases = () => join(dir, "data/carbonless/releases");
	const tarball = (version: string, sha: string) =>
		join(releases(), `carbonless-review-${version}-${sha.slice(0, 7)}.tgz`);
	const installed = () =>
		JSON.parse(readFileSync(join(dir, "pkg/dist/build-info.json"), "utf8"));
	const install = (version: string, commit: string) =>
		writeFileSync(
			join(dir, "pkg/dist/build-info.json"),
			JSON.stringify({ version, commit }),
		);
	const calls = () => {
		const log = join(dir, "calls.log");
		return existsSync(log) ? readFileSync(log, "utf8") : "";
	};

	const git = (cwd: string, ...args: string[]) =>
		new Promise<string>((resolve, reject) => {
			execFile("git", args, { cwd, env }, (error, stdout, stderr) =>
				error ? reject(new Error(stderr)) : resolve(stdout.trim()),
			);
		});

	/** Pushes a commit with this package.json version to origin's master; returns its sha. */
	async function push(version: string) {
		const work = join(dir, "work");
		writeFileSync(
			join(work, "package.json"),
			JSON.stringify({ name: "carbonless-review", version }),
		);
		writeFileSync(join(work, "file.txt"), `${++commits}\n`);
		await git(work, "add", ".");
		await git(work, "commit", "-qm", `commit ${commits}`);
		await git(work, "push", "-q", "origin", "HEAD:master");
		return git(work, "rev-parse", "HEAD");
	}

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "crb-follow-"));
		const nodeBin = join(dir, "home/.nvm/versions/node/v24.0.0/bin");
		mkdirSync(nodeBin, { recursive: true });
		symlinkSync(process.execPath, join(nodeBin, "node"));
		const stubs = join(dir, "stubs");
		mkdirSync(stubs);
		const log = join(dir, "calls.log");
		const stub = (name: string, body: string) => {
			writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`);
			chmodSync(join(stubs, name), 0o755);
		};
		stub("systemctl", "echo REAL systemctl >&2; exit 99");
		stub("journalctl", "echo REAL journalctl >&2; exit 99");
		// npm view carbonless-review@rc: $NPM_RC, $NPM_ERROR, else not published.
		stub(
			"npm",
			[
				`echo "npm $*" >>"${log}"`,
				'if [ -n "$NPM_RC" ]; then echo "$NPM_RC"; exit 0; fi',
				'if [ -n "$NPM_ERROR" ]; then echo "npm error code $NPM_ERROR"; exit 1; fi',
				'echo "npm error code E404"; echo \'{"error":{"code":"E404"}}\'; exit 1',
			].join("\n"),
		);
		// pnpm install logs the tree's state; pnpm pack packs a build-info of
		// the checked-out commit, -dirty as scripts/build-info.mjs would.
		stub(
			"pnpm",
			[
				`echo "pnpm $* in $PWD status=[$(git status --porcelain | tr '\\n' ' ')]" >>"${log}"`,
				'case "$1" in',
				'install) [ -z "$PNPM_FAIL" ] || exit 1 ;;',
				"pack)",
				"  v=$(node -p 'require(\"./package.json\").version')",
				'  c=$(git rev-parse HEAD); [ -z "$(git status --porcelain)" ] || c="$c-dirty"',
				'  t=$(mktemp -d); mkdir -p "$t/package/dist"',
				'  printf \'{"version":"%s","commit":"%s"}\' "$v" "$c" >"$t/package/dist/build-info.json"',
				'  tar -czf "$3/carbonless-review-$v.tgz" -C "$t" package; rm -rf "$t" ;;',
				"esac",
			].join("\n"),
		);
		// update installs the tarball's build (or rc's, $NPM_BUILD), unless
		// its argument contains $UPDATE_FAIL.
		const update = join(dir, "update");
		writeFileSync(
			update,
			[
				"#!/bin/sh",
				`echo "update $*" >>"${log}"`,
				'if [ -n "$UPDATE_FAIL" ]; then case "$1" in *"$UPDATE_FAIL"*) echo "update: it never came up" >&2; exit 1 ;; esac; fi',
				`if [ -f "$1" ]; then tar -xzOf "$1" package/dist/build-info.json >"${join(dir, "pkg/dist/build-info.json")}"`,
				`else echo "$NPM_BUILD" >"${join(dir, "pkg/dist/build-info.json")}"; fi`,
				'echo "crb: a -> b"',
			].join("\n"),
		);
		chmodSync(update, 0o755);
		mkdirSync(join(dir, "pkg/dist"), { recursive: true });
		env = {
			HOME: join(dir, "home"),
			PATH: `${stubs}:${process.env.PATH}`,
			XDG_CONFIG_HOME: join(dir, "config"),
			XDG_STATE_HOME: join(dir, "state"),
			XDG_DATA_HOME: join(dir, "data"),
			SYSTEMD_USER_DIR: join(dir, "units"),
			PNPM_HOME: join(dir, "pnpm-home"),
			CRB_DEVBOX_PKG_DIR: join(dir, "pkg"),
			CRB_DEVBOX_REPO: repo(),
			CRB_DEVBOX_UPDATE: update,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		};
		await git(dir, "init", "-q", "--bare", "-b", "master", "origin.git");
		await git(dir, "clone", "-q", join(dir, "origin.git"), "work");
		writeFileSync(join(dir, "work/.gitignore"), ".worktrees/\n");
		const first = await push("0.1.0");
		await git(dir, "clone", "-q", join(dir, "origin.git"), "repo");
		install("0.1.0", first);
	});
	afterEach(() => {
		holder?.kill();
		holder = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	const run = (extra = {}) =>
		new Promise<Result>((resolve) => {
			execFile(
				join(here, "follow"),
				[],
				{ env: { ...env, ...extra } },
				(error, stdout, stderr) => {
					const code = error ? ((error as { code?: number }).code ?? 1) : 0;
					resolve({ code, stdout, stderr });
				},
			);
		});

	it("does nothing, in one line, when the installed build is origin/master", async () => {
		const r = await run();
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(
			/^crb-follow: up to date: 0\.1\.0 \([0-9a-f]{7}\) is origin\/master\n$/,
		);
		expect(calls()).not.toContain("pnpm");
		expect(calls()).not.toContain("update");
		expect(existsSync(tree())).toBe(false);
	});

	it("builds a new master commit in a clean worktree and updates to its tarball", async () => {
		const before = installed().commit;
		const sha = await push("0.1.0");
		const r = await run();
		expect(r.stderr).not.toContain("REAL");
		expect(r.code).toBe(0);
		expect(r.stdout).toContain(
			`crb-follow: building 0.1.0 (${sha.slice(0, 7)}) (origin/master)`,
		);
		expect(calls()).toContain(
			`pnpm install --frozen-lockfile in ${tree()} status=[]`,
		);
		expect(calls()).toMatch(/pnpm pack --pack-destination /);
		// Named by commit: the same version built again doesn't overwrite it.
		expect(calls()).toContain(`update ${tarball("0.1.0", sha)}\n`);
		expect(installed()).toEqual({ version: "0.1.0", commit: sha });
		expect(await git(tree(), "rev-parse", "HEAD")).toBe(sha);
		expect(r.stdout).toContain("crb: a -> b");
		// The build it left keeps a tarball to come back to.
		expect(existsSync(tarball("0.1.0", before))).toBe(true);

		const again = await run();
		expect(again.code).toBe(0);
		expect(again.stdout).toContain("up to date");
		expect(calls().match(/^update /gm)).toHaveLength(1);
	});

	it("follows npm's rc dist-tag once the package is published there", async () => {
		const rc = { version: "0.2.0-rc.1", commit: "2".repeat(40) };
		const extra = {
			NPM_RC: JSON.stringify({ version: rc.version, gitHead: rc.commit }),
			NPM_BUILD: JSON.stringify(rc),
			// npm alone decides: no git.
			CRB_DEVBOX_REPO: join(dir, "nowhere"),
		};
		const r = await run(extra);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		expect(calls()).toContain("npm view carbonless-review@rc version gitHead");
		expect(calls()).toContain("update rc\n");
		expect(calls()).not.toContain("pnpm");
		expect(installed()).toEqual(rc);

		const again = await run(extra);
		expect(again.stdout).toBe(
			"crb-follow: up to date: 0.2.0-rc.1 (2222222) is carbonless-review@rc\n",
		);
		expect(calls().match(/^update /gm)).toHaveLength(1);

		// The same version from another commit is a new build.
		const moved = await run({
			...extra,
			NPM_RC: JSON.stringify({ version: rc.version, gitHead: "3".repeat(40) }),
		});
		expect(moved.code).toBe(0);
		expect(calls().match(/^update rc/gm)).toHaveLength(2);
	});

	it("fails without falling back to git when npm can't be asked", async () => {
		const sha = await push("0.1.0");
		const r = await run({ NPM_ERROR: "ECONNRESET" });
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain("npm view carbonless-review@rc failed");
		expect(calls()).not.toContain("update");
		expect(installed().commit).not.toBe(sha);
	});

	it("rolls back when the new build doesn't come up, and skips it until a newer one", async () => {
		const good = installed().commit;
		const bad = await push("0.1.0");
		const r = await run({ UPDATE_FAIL: bad.slice(0, 7) });
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain(
			`0.1.0 (${bad.slice(0, 7)}) (origin/master) did not come up`,
		);
		expect(r.stderr).toContain(`rolled back to 0.1.0 (${good.slice(0, 7)})`);
		// The previous build, from a tarball of the installed package.
		expect(calls()).toContain(
			`update ${tarball("0.1.0", bad)}\nupdate ${tarball("0.1.0", good)}\n`,
		);
		expect(installed()).toEqual({ version: "0.1.0", commit: good });

		const next = await run({ UPDATE_FAIL: bad.slice(0, 7) });
		expect(next.code).toBe(0);
		expect(next.stdout).toBe(
			`crb-follow: skipping 0.1.0 (${bad.slice(0, 7)}) (origin/master): it failed to come up before; staying on 0.1.0 (${good.slice(0, 7)})\n`,
		);
		expect(calls().match(/^update /gm)).toHaveLength(2);
		expect(calls().match(/^pnpm install/gm)).toHaveLength(1);

		const newer = await push("0.1.0");
		const fixed = await run({ UPDATE_FAIL: bad.slice(0, 7) });
		expect(fixed.code).toBe(0);
		expect(installed()).toEqual({ version: "0.1.0", commit: newer });
		expect(existsSync(join(dir, "state/carbonless/follow-failed"))).toBe(false);
	});

	it("remembers a commit that fails to build", async () => {
		await push("0.1.0");
		const r = await run({ PNPM_FAIL: "1" });
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain("failed; skipping it");
		const next = await run({ PNPM_FAIL: "1" });
		expect(next.code).toBe(0);
		expect(next.stdout).toContain("skipping");
		expect(calls().match(/^pnpm install/gm)).toHaveLength(1);
		expect(calls()).not.toContain("update");
	});

	it("exits quietly while another run holds the lock", async () => {
		await push("0.1.0");
		const lock = join(dir, "state/carbonless/follow.lock");
		mkdirSync(dirname(lock), { recursive: true });
		holder = spawn("flock", [lock, "-c", "echo held; sleep 60"]);
		await new Promise((resolve) => holder?.stdout?.once("data", resolve));
		const r = await run();
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("crb-follow: another run is in progress\n");
		expect(calls()).toBe("");
	});

	it("cleans a dirty build tree, so the build is never -dirty", async () => {
		await push("0.1.0");
		expect((await run()).code).toBe(0);
		writeFileSync(join(tree(), "file.txt"), "edited\n");
		writeFileSync(join(tree(), "stray.txt"), "untracked\n");
		const sha = await push("0.1.1-rc.1");
		const r = await run();
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		expect(calls().trim().split("\n").at(-3)).toBe(
			`pnpm install --frozen-lockfile in ${tree()} status=[]`,
		);
		expect(installed()).toEqual({ version: "0.1.1-rc.1", commit: sha });
		expect(existsSync(join(tree(), "stray.txt"))).toBe(false);
	});
});
