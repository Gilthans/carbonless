import {
	type ChildProcess,
	execFile,
	execFileSync,
	spawn,
} from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// scripts/devbox/follow against temp dirs: a real git origin and repo, and
// stand-ins for npm, pnpm and update. systemctl and journalctl fail the test
// if anything calls them.
const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = [
	"follow",
	"update",
	"lib.sh",
	"crb.service.template",
	"crb-follow.service.template",
	"crb-follow.timer",
];

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
	let server: Server | undefined;
	const served = () => join(dir, "served.json");
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
	const copy = () => join(dir, "data/carbonless/devbox");
	/** The scripts' copy, or null when there is none. */
	const copied = (f = "follow") =>
		existsSync(join(copy(), f)) ? readFileSync(join(copy(), f), "utf8") : null;
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
	async function push(version: string, scripts: Record<string, string> = {}) {
		const work = join(dir, "work");
		writeFileSync(
			join(work, "package.json"),
			JSON.stringify({ name: "carbonless-review", version }),
		);
		writeFileSync(join(work, "file.txt"), `${++commits}\n`);
		// master's devbox scripts, which follow copies once it runs its build.
		mkdirSync(join(work, "scripts/devbox"), { recursive: true });
		for (const f of SCRIPTS) {
			writeFileSync(
				join(work, "scripts/devbox", f),
				scripts[f] ?? `# ${f} at ${commits}\n`,
			);
		}
		await git(work, "add", ".");
		await git(work, "commit", "-qm", `commit ${commits}`);
		await git(work, "push", "-q", "origin", "HEAD:master");
		return git(work, "rev-parse", "HEAD");
	}

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "crb-follow-"));
		commits = 0;
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
		stub("gh", "exit 0");
		// tar, except that with $TAR_FAIL a snapshot of the installed package
		// (--transform) leaves a partial file and fails, as a full disk would.
		stub(
			"tar",
			[
				'case "$*" in *--transform*) if [ -n "$TAR_FAIL" ]; then echo partial >"$2"; exit 1; fi ;; esac',
				`exec ${execFileSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).trim()} "$@"`,
			].join("\n"),
		);
		// ssh logs how it was called and fails (no host is real here).
		stub("ssh", `echo "ssh $*" >>"${log}"; exit 255`);
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
		// the checked-out commit, -dirty as scripts/build-info.mjs would. It
		// reads stdin as a prompt would: follow must give it none to wait on.
		stub(
			"pnpm",
			[
				"read -r answer || true",
				`echo "pnpm $* in $PWD status=[$(git status --porcelain | tr '\\n' ' ')] prompt=$GIT_TERMINAL_PROMPT" >>"${log}"`,
				'case "$1" in',
				'install) [ -z "$PNPM_FAIL" ] || exit 1 ;;',
				"pack)",
				"  v=$(node -p 'require(\"./package.json\").version')",
				'  c=$(git rev-parse HEAD); [ -z "$(git status --porcelain)$PACK_DIRTY" ] || c="$c-dirty"',
				'  t=$(mktemp -d); mkdir -p "$t/package/dist"',
				'  printf \'{"version":"%s","commit":"%s"}\' "$v" "$c" >"$t/package/dist/build-info.json"',
				'  tar -czf "$3/carbonless-review-$v.tgz" -C "$t" package; rm -rf "$t" ;;',
				"esac",
			].join("\n"),
		);
		// update installs the tarball's build (or rc's, $NPM_BUILD) and crb
		// serves it. When its argument contains a word of $UPDATE_BROKEN it
		// fails before installing; of $UPDATE_FAIL, it installs and crb is down.
		const update = join(dir, "update");
		const info = join(dir, "pkg/dist/build-info.json");
		writeFileSync(
			update,
			[
				"#!/bin/sh",
				`echo "update $*" >>"${log}"`,
				'for w in $UPDATE_BROKEN; do case "$1" in *"$w"*) echo "update: pnpm add failed" >&2; exit 1 ;; esac; done',
				`if [ -f "$1" ]; then tar -xzOf "$1" package/dist/build-info.json >"${info}"`,
				`else echo "$NPM_BUILD" >"${info}"; fi`,
				`for w in $UPDATE_FAIL; do case "$1" in *"$w"*) echo down >"${served()}"; echo "update: it never came up" >&2; exit 1 ;; esac; done`,
				`cp "${info}" "${served()}"`,
				'echo "crb: a -> b"',
			].join("\n"),
		);
		chmodSync(update, 0o755);
		mkdirSync(join(dir, "pkg/dist"), { recursive: true });
		// A fake crb serve answering /api/version with served.json.
		server = createServer((req, res) => {
			const body = existsSync(served())
				? readFileSync(served(), "utf8")
				: "down";
			if (req.url?.startsWith("/api/version") && !body.startsWith("down")) {
				res.setHeader("content-type", "application/json");
				res.end(body);
			} else res.writeHead(503).end();
		});
		await new Promise<void>((resolve) =>
			server?.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		mkdirSync(join(dir, "config/carbonless"), { recursive: true });
		writeFileSync(
			join(dir, "config/carbonless/config.json"),
			JSON.stringify({ serve: { host: "127.0.0.1", port } }),
		);
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
			// The service's MainPID isn't checked: the fake server stands for it.
			CRB_DEVBOX_DRY_RUN: "1",
			CRB_DEVBOX_HEALTH_WAIT: "0",
			CRB_DEVBOX_TIMEOUT: "5",
			CRB_DEVBOX_RETRY_DELAYS: "0 0 0",
			CRB_DEVBOX_LOCK_WAIT: "2",
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
		writeFileSync(
			served(),
			JSON.stringify({ version: "0.1.0", commit: first }),
		);
	});
	afterEach(async () => {
		holder?.kill();
		holder = undefined;
		await new Promise((resolve) => server?.close(resolve));
		rmSync(dir, { recursive: true, force: true });
	});

	const run = (extra = {}, script = join(here, "follow")) =>
		new Promise<Result>((resolve) => {
			execFile(
				script,
				[],
				{ env: { ...env, ...extra } },
				(error, stdout, stderr) => {
					const code = error ? ((error as { code?: number }).code ?? 1) : 0;
					resolve({ code, stdout, stderr });
				},
			);
		});
	const updates = () => calls().match(/^update /gm)?.length ?? 0;
	const short = (sha: string) => sha.slice(0, 7);

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
			`pnpm install --frozen-lockfile --config.confirmModulesPurge=false in ${tree()} status=[] prompt=0`,
		);
		expect(calls()).toMatch(/pnpm pack --pack-destination /);
		// Named by commit: the same version built again doesn't overwrite it.
		expect(calls()).toContain(`update ${tarball("0.1.0", sha)}\n`);
		expect(installed()).toEqual({ version: "0.1.0", commit: sha });
		expect(await git(tree(), "rev-parse", "HEAD")).toBe(sha);
		expect(r.stdout).toContain("crb: a -> b");
		// The service's copy of the scripts is now master's, atomically: a
		// symlink to a fresh dir.
		for (const f of SCRIPTS) expect(copied(f)).toBe(`# ${f} at 2\n`);
		expect(readlinkSync(copy())).toMatch(/^\.devbox\.\w+$/);
		expect(r.stdout).toContain(`Copied the devbox scripts to ${copy()}`);
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
		};
		const r = await run(extra);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		expect(calls()).toContain("npm view carbonless-review@rc version gitHead");
		expect(calls()).toContain("update rc\n");
		expect(calls()).not.toContain("pnpm");
		expect(installed()).toEqual(rc);
		// The npm package carries no devbox scripts: origin/master's are
		// copied, without building anything.
		expect(copied()).toBe("# follow at 1\n");
		expect(existsSync(tree())).toBe(false);

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

	it("from npm, a repo it can't fetch only keeps the scripts' copy as it was", async () => {
		const rc = { version: "0.2.0-rc.1", commit: "2".repeat(40) };
		const r = await run({
			NPM_RC: JSON.stringify({ version: rc.version }),
			NPM_BUILD: JSON.stringify(rc),
			CRB_DEVBOX_REPO: join(dir, "nowhere"),
		});
		expect(r.code).toBe(0);
		expect(installed()).toEqual(rc);
		expect(r.stderr).toContain(
			`kept ${copy()} as it was: could not fetch origin/master`,
		);
		expect(copied()).toBeNull();
	});

	it("fails without falling back to git when npm can't be asked", async () => {
		const sha = await push("0.1.0");
		const r = await run({ NPM_ERROR: "ECONNRESET" });
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain("npm view carbonless-review@rc failed");
		expect(calls()).not.toContain("update");
		expect(installed().commit).not.toBe(sha);
	});

	it("goes back to the good build when the new one doesn't come up; retries, then skips, failing all along", async () => {
		const good = installed().commit;
		const bad = await push("0.1.0");
		const failing = { UPDATE_FAIL: short(bad) };
		const r = await run(failing);
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain(
			`0.1.0 (${short(bad)}) (origin/master) did not come up`,
		);
		expect(r.stderr).toContain(`went back to 0.1.0 (${short(good)})`);
		// The good build: a tarball of the package crb.service was serving.
		expect(calls()).toContain(
			`update ${tarball("0.1.0", bad)}\nupdate ${tarball("0.1.0", good)}\n`,
		);
		expect(installed()).toEqual({ version: "0.1.0", commit: good });
		// A build that didn't come up doesn't hand follow its scripts.
		expect(copied()).toBeNull();

		// Retried (no delay here) three more times, then skipped: every run fails.
		for (const n of [2, 3, 4]) {
			const again = await run(failing);
			expect(again.code).not.toBe(0);
			expect(again.stdout).toContain(`trying 0.1.0 (${short(bad)})`);
			expect(updates()).toBe(2 * n);
		}
		const skipped = await run(failing);
		expect(skipped.code).not.toBe(0);
		expect(skipped.stderr).toContain(
			`0.1.0 (${short(bad)}) (origin/master) failed 4 time(s): skipping it until a newer build appears; staying on 0.1.0 (${short(good)})`,
		);
		expect(updates()).toBe(8);
		expect(calls().match(/^pnpm install/gm)).toHaveLength(1);

		const newer = await push("0.1.0");
		const fixed = await run(failing);
		expect(fixed.code).toBe(0);
		expect(installed()).toEqual({ version: "0.1.0", commit: newer });
		expect(existsSync(join(dir, "state/carbonless/follow-failed"))).toBe(false);
		expect(copied()).toBe("# follow at 3\n");
	});

	it("a build that failed once comes in on a later try", async () => {
		const sha = await push("0.1.0");
		expect((await run({ UPDATE_FAIL: short(sha) })).code).not.toBe(0);
		const r = await run();
		expect(r.code).toBe(0);
		expect(installed()).toEqual({ version: "0.1.0", commit: sha });
	});

	it("waits out the retry delay, failing meanwhile", async () => {
		const sha = await push("0.1.0");
		const extra = {
			UPDATE_FAIL: short(sha),
			CRB_DEVBOX_RETRY_DELAYS: "3600 7200 7200",
		};
		expect((await run(extra)).code).not.toBe(0);
		const r = await run(extra);
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain(
			`failed 1 time(s): trying again in 60 min; staying on 0.1.0`,
		);
		expect(updates()).toBe(2);
	});

	it("counts a commit that fails to build as a failure too", async () => {
		await push("0.1.0");
		const r = await run({ PNPM_FAIL: "1" });
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain("failed: trying again in 0 min");
		const later = await run({
			PNPM_FAIL: "1",
			CRB_DEVBOX_RETRY_DELAYS: "3600 3600 3600",
		});
		expect(later.code).not.toBe(0);
		expect(later.stderr).toContain("failed 1 time(s)");
		expect(calls().match(/^pnpm install/gm)).toHaveLength(1);
		expect(calls()).not.toContain("update");
	});

	it("never calls a build that isn't served up to date: it reinstalls the good one, and fails while it can't", async () => {
		const good = installed().commit;
		const bad = await push("0.1.0");
		// The new build installs but never comes up, and going back fails too.
		const broken = { UPDATE_FAIL: short(bad), UPDATE_BROKEN: short(good) };
		const r = await run(broken);
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain("going back to");
		expect(installed()).toEqual({ version: "0.1.0", commit: bad });

		// The installed build is origin/master's, but crb doesn't serve it.
		for (let i = 0; i < 2; i++) {
			const down = await run(broken);
			expect(down.code).not.toBe(0);
			expect(down.stdout).not.toContain("up to date");
			expect(down.stderr).toContain(
				`crb.service is not serving 0.1.0 (${short(bad)}); reinstalling 0.1.0 (${short(good)})`,
			);
			expect(down.stderr).toContain("failed: crb is down");
		}

		const healed = await run();
		expect(healed.code).toBe(0);
		expect(installed()).toEqual({ version: "0.1.0", commit: good });
		expect(calls()).toContain(`update ${tarball("0.1.0", good)}\n`);
	});

	it("reinstalls the good build when crb stops serving it, and fails without one", async () => {
		expect((await run()).code).toBe(0);
		writeFileSync(served(), "down");
		const r = await run();
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("crb.service is not serving");
		expect(r.stdout).toContain("up to date");
		expect(readFileSync(served(), "utf8")).toContain(installed().commit);

		rmSync(join(dir, "state/carbonless/follow-good"));
		writeFileSync(served(), "down");
		const none = await run();
		expect(none.code).not.toBe(0);
		expect(none.stderr).toContain("there is no good build to reinstall");
	});

	it("a fetch that fails is never up to date: it exits 1", async () => {
		await git(repo(), "remote", "set-url", "origin", join(dir, "missing.git"));
		const r = await run();
		expect(r.code).not.toBe(0);
		expect(r.stdout).not.toContain("up to date");
		expect(r.stderr).toContain("fetching origin/master into");
		expect(calls()).not.toContain("update");
	});

	it("from npm, a fetch that fails keeps the scripts' copy", async () => {
		await git(repo(), "remote", "set-url", "origin", join(dir, "missing.git"));
		const rc = { version: "0.2.0-rc.1", commit: "2".repeat(40) };
		const r = await run({
			NPM_RC: JSON.stringify({ version: rc.version }),
			NPM_BUILD: JSON.stringify(rc),
		});
		expect(r.code).toBe(0);
		expect(installed()).toEqual(rc);
		expect(r.stderr).toContain("could not fetch origin/master");
		expect(copied()).toBeNull();
	});

	it("never keeps a partial tarball of the installed build, nor makes it the good one", async () => {
		const first = installed().commit;
		const r = await run({ TAR_FAIL: "1" });
		expect(r.stderr).toContain("could not keep a tarball of");
		expect(existsSync(tarball("0.1.0", first))).toBe(false);
		expect(existsSync(`${tarball("0.1.0", first)}.tmp`)).toBe(false);
		expect(existsSync(join(dir, "state/carbonless/follow-good"))).toBe(false);
		// Once tar works, the snapshot is made whole.
		expect((await run()).code).toBe(0);
		expect(
			readFileSync(join(dir, "state/carbonless/follow-good"), "utf8"),
		).toBe(`${tarball("0.1.0", first)}\n`);
	});

	it("a build whose tarball says another build counts as a failure, not a rebuild every tick", async () => {
		await push("0.1.0");
		const extra = {
			PACK_DIRTY: "1",
			CRB_DEVBOX_RETRY_DELAYS: "3600 3600 3600",
		};
		const r = await run(extra);
		expect(r.code).not.toBe(0);
		expect(r.stderr).toMatch(
			/says it is 0\.1\.0 \(\w{7}-dirty\): trying again in 60 min/,
		);
		const again = await run(extra);
		expect(again.code).not.toBe(0);
		expect(calls().match(/^pnpm install/gm)).toHaveLength(1);
		expect(calls()).not.toContain("update");
	});

	it("a crb serve that isn't crb.service's doesn't make it restart main", async () => {
		expect((await run()).code).toBe(0);
		// A branch instance started without its .envrc wrote server.json.
		mkdirSync(join(dir, "state/carbonless"), { recursive: true });
		writeFileSync(
			join(dir, "state/carbonless/server.json"),
			JSON.stringify({ url: "x", host: "x", port: 1, pid: 4242 }),
		);
		const r = await run({ CRB_DEVBOX_DRY_MAINPID: "99" });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("up to date");
		expect(calls()).not.toContain("update");
		// crb.service inactive: that is a fault.
		const down = await run({ CRB_DEVBOX_DRY_MAINPID: "0" });
		expect(down.stderr).toContain("crb.service is not serving");
		expect(calls()).toContain("update");
	});

	it("a follow-failed it can't read, or from the future, doesn't hold a build back", async () => {
		const sha = await push("0.1.0");
		const failed = join(dir, "state/carbonless/follow-failed");
		mkdirSync(dirname(failed), { recursive: true });
		const extra = {
			CRB_DEVBOX_RETRY_DELAYS: "3600 3600 3600",
			UPDATE_FAIL: short(sha),
		};
		writeFileSync(failed, `git 0.1.0 ${sha}\nabc\nxyz\n`);
		const r = await run(extra);
		expect(r.stderr).not.toContain("unbound variable");
		expect(r.stdout).toContain(`trying 0.1.0 (${short(sha)})`);
		expect(updates()).toBe(2);

		const future = Math.floor(Date.now() / 1000) + 1_000_000;
		writeFileSync(failed, `git 0.1.0 ${sha}\n1\n${future}\n`);
		const back = await run({ CRB_DEVBOX_RETRY_DELAYS: "3600 3600 3600" });
		expect(back.code).toBe(0);
		expect(installed()).toEqual({ version: "0.1.0", commit: sha });
	});

	it("an exported CRB_DEVBOX_LOCKED doesn't let follow past the lock", async () => {
		await push("0.1.0");
		const lock = join(dir, "state/carbonless/devbox.lock");
		mkdirSync(dirname(lock), { recursive: true });
		holder = spawn("flock", [lock, "-c", "echo held; sleep 60"]);
		await new Promise((resolve) => holder?.stdout?.once("data", resolve));
		const r = await run({ CRB_DEVBOX_LOCKED: "1" });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("another run");
		expect(calls()).toBe("");
	});

	it("fetches over ssh in batch mode, unless the repo or the caller chose its ssh", async () => {
		await git(
			repo(),
			"remote",
			"set-url",
			"origin",
			"ssh://git@example.invalid/x.git",
		);
		expect((await run()).code).not.toBe(0);
		expect(calls()).toMatch(/^ssh -o BatchMode=yes .*example\.invalid/m);

		const own = join(dir, "own-ssh");
		writeFileSync(
			own,
			`#!/bin/sh\necho "own-ssh $*" >>"${join(dir, "calls.log")}"; exit 255\n`,
		);
		chmodSync(own, 0o755);
		await git(repo(), "config", "core.sshCommand", own);
		expect((await run()).code).not.toBe(0);
		expect(calls()).toMatch(/^own-ssh .*example\.invalid/m);
		expect(calls().match(/^ssh /gm)).toHaveLength(1);
	});

	it("refuses a build tree that is a worktree on a branch", async () => {
		await push("0.1.0");
		const agent = join(repo(), ".worktrees/agent");
		await git(repo(), "worktree", "add", "-qb", "agent", agent);
		writeFileSync(join(agent, "file.txt"), "agent's work\n");
		const r = await run({ CRB_DEVBOX_BUILD_TREE: agent });
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain("is on a branch");
		expect(readFileSync(join(agent, "file.txt"), "utf8")).toBe(
			"agent's work\n",
		);
	});

	it("exits quietly while another run or update holds the lock", async () => {
		await push("0.1.0");
		const lock = join(dir, "state/carbonless/devbox.lock");
		mkdirSync(dirname(lock), { recursive: true });
		holder = spawn("flock", [lock, "-c", "echo held; sleep 60"]);
		await new Promise((resolve) => holder?.stdout?.once("data", resolve));
		const r = await run();
		expect(r.code).toBe(0);
		expect(r.stdout).toBe(
			"crb-follow: another run (or scripts/devbox/update) is in progress\n",
		);
		expect(calls()).toBe("");
	});

	it("runs the real update under its own lock without waiting on itself", async () => {
		const sha = await push("0.1.0");
		mkdirSync(join(dir, "units"), { recursive: true });
		writeFileSync(join(dir, "units/crb.service"), "");
		// Dry run: pnpm add only prints, so the installed build (and what the
		// fake server answers) doesn't change.
		const r = await run({ CRB_DEVBOX_UPDATE: "" });
		expect(r.stderr).not.toContain("Waiting for another");
		expect(r.code).toBe(0);
		expect(r.stdout).toContain(`dry-run: pnpm add -g ${tarball("0.1.0", sha)}`);
	});

	it("never waits for input", async () => {
		await push("0.1.0");
		const r = await run();
		expect(r.code).toBe(0);
		expect(calls()).toMatch(/pnpm install .* prompt=0\n/);
	});

	it("refuses to wipe a build tree that is a main checkout or inside one", async () => {
		await push("0.1.0");
		writeFileSync(join(repo(), "mine.txt"), "keep me\n");
		for (const tree of [repo(), join(repo(), "scripts")]) {
			const r = await run({ CRB_DEVBOX_BUILD_TREE: tree });
			expect(r.code).not.toBe(0);
			expect(r.stderr).toMatch(
				/not a worktree of its own|exists but is not a git worktree/,
			);
		}
		expect(readFileSync(join(repo(), "mine.txt"), "utf8")).toBe("keep me\n");
		expect(calls()).not.toContain("pnpm install");
	});

	it("keeps the copy of the scripts when master's don't parse", async () => {
		await push("0.1.0");
		expect((await run()).code).toBe(0);
		const before = readlinkSync(copy());
		const sha = await push("0.1.0", { "lib.sh": "if then fi (\n" });
		const r = await run();
		expect(r.code).toBe(0);
		expect(installed().commit).toBe(sha);
		expect(r.stderr).toContain("lib.sh doesn't parse");
		expect(r.stderr).toContain(`kept ${copy()} as it was`);
		expect(readlinkSync(copy())).toBe(before);
		expect(copied()).toBe("# follow at 2\n");
		expect(
			readdirSync(dirname(copy())).filter((f) => f.startsWith(".devbox.")),
		).toEqual([before]);
	});

	it("keeps releases/ to the installed, the good and the 5 newest builds; drops leftovers", async () => {
		mkdirSync(releases(), { recursive: true });
		const old = (name: string, age: number) => {
			const f = join(releases(), name);
			writeFileSync(f, "");
			const t = Date.now() / 1000 - age;
			utimesSync(f, t, t);
		};
		for (let i = 0; i < 8; i++)
			old(`carbonless-review-0.0.${i}-aaaaaaa.tgz`, 1000 + i);
		old("carbonless-review-0.0.9-bbbbbbb.tgz.tmp", 10);
		const good = installed().commit;
		const sha = await push("0.1.0");
		expect((await run()).code).toBe(0);
		const left = readdirSync(releases()).sort();
		expect(left).toContain(basename(tarball("0.1.0", sha)));
		expect(left).toContain(basename(tarball("0.1.0", good)));
		expect(left).toHaveLength(5);
		expect(left.filter((f) => f.endsWith(".tmp"))).toEqual([]);
		// The newest of the old ones stay.
		expect(left).toContain("carbonless-review-0.0.0-aaaaaaa.tgz");
		expect(left).not.toContain("carbonless-review-0.0.7-aaaaaaa.tgz");
	});

	it("follows the main checkout of a repo with a separate git dir", async () => {
		await git(
			dir,
			"clone",
			"-q",
			`--separate-git-dir=${join(dir, "sep.git")}`,
			join(dir, "origin.git"),
			"sep",
		);
		const scripts = join(dir, "sep/scripts/devbox");
		for (const f of SCRIPTS) {
			writeFileSync(join(scripts, f), readFileSync(join(here, f)));
		}
		chmodSync(join(scripts, "follow"), 0o755);
		await push("0.1.0");
		const r = await run({ CRB_DEVBOX_REPO: "" }, join(scripts, "follow"));
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		expect(calls()).toContain(
			`pnpm install --frozen-lockfile --config.confirmModulesPurge=false in ${join(dir, "sep/.worktrees/follow")} `,
		);
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
			`pnpm install --frozen-lockfile --config.confirmModulesPurge=false in ${tree()} status=[] prompt=0`,
		);
		expect(installed()).toEqual({ version: "0.1.1-rc.1", commit: sha });
		expect(existsSync(join(tree(), "stray.txt"))).toBe(false);
		// Copied from the clean tree, so not the edit made in it; the copy
		// it replaced is gone.
		expect(copied()).toBe("# follow at 3\n");
		expect(
			readdirSync(dirname(copy())).filter((f) => f.startsWith(".devbox.")),
		).toEqual([readlinkSync(copy())]);
	});

	it("fetching writes only refs/remotes/origin/master in the repo, and touches nothing checked out", async () => {
		// Someone works in the repo: a branch, uncommitted edits, no FETCH_HEAD.
		await git(repo(), "switch", "-qc", "feature");
		writeFileSync(join(repo(), "file.txt"), "work in progress\n");
		writeFileSync(join(repo(), "notes.txt"), "untracked\n");
		// origin has a tag and another branch follow mustn't bring in.
		await git(join(dir, "work"), "tag", "v9");
		await git(join(dir, "work"), "push", "-q", "origin", "v9", "HEAD:other");
		await git(repo(), "config", "fetch.prune", "true");
		await git(repo(), "update-ref", "refs/remotes/origin/gone", "HEAD");
		const sha = await push("0.1.0");
		const refs = async () =>
			(
				await git(
					repo(),
					"for-each-ref",
					// A symref (origin/HEAD) by its target.
					"--format=%(refname) %(if)%(symref)%(then)-> %(symref)%(else)%(objectname)%(end)",
				)
			)
				.split("\n")
				.filter((l) => !l.startsWith("refs/remotes/origin/master "));
		const before = await refs();
		const status = await git(repo(), "status", "--porcelain=v2", "--branch");

		const r = await run();
		expect(r.code).toBe(0);
		expect(await git(repo(), "rev-parse", "refs/remotes/origin/master")).toBe(
			sha,
		);
		expect(await refs()).toEqual(before);
		expect(await git(repo(), "status", "--porcelain=v2", "--branch")).toBe(
			status,
		);
		expect(readFileSync(join(repo(), "file.txt"), "utf8")).toBe(
			"work in progress\n",
		);
		expect(existsSync(join(repo(), ".git/FETCH_HEAD"))).toBe(false);
	});
});
