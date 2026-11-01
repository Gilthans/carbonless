import { execFile, execFileSync } from "node:child_process";
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
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// scripts/devbox/install and update, run dry (no systemctl, no pnpm add)
// against temp dirs and a fake server standing in for crb serve.
const here = dirname(fileURLToPath(import.meta.url));
const BUILD = {
	version: "0.1.0",
	commit: "abcdef0123456789abcdef0123456789abcdef01",
};

interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

// Each script run spawns pnpm and node a few times: about a second apiece.
describe("scripts/devbox", { timeout: 60_000 }, () => {
	let dir: string;
	let server: Server | undefined;
	let env: NodeJS.ProcessEnv;
	const nodeBin = () => join(dir, "home/.nvm/versions/node/v24.0.0/bin");
	const pnpmHome = () => join(dir, "pnpm-home");
	const unitFile = () => join(dir, "units/crb.service");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-devbox-"));
		// A Node 24 where install looks for one: ~/.nvm/versions/node/v24*/bin.
		mkdirSync(nodeBin(), { recursive: true });
		symlinkSync(process.execPath, join(nodeBin(), "node"));
		// Stand-ins for gh, loginctl, and a systemctl/journalctl that fail the
		// test if anything calls them for real.
		const stubs = join(dir, "stubs");
		mkdirSync(stubs);
		const stub = (name: string, body: string) => {
			writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`);
			chmodSync(join(stubs, name), 0o755);
		};
		// Logged in only when asked as the service asks: no token, gh's own config dir.
		stub(
			"gh",
			'test "$1 $2" = "auth status" && test -z "$GH_LOGGED_OUT$GH_TOKEN$GH_CONFIG_DIR$XDG_CONFIG_HOME"',
		);
		stub("loginctl", 'if [ -n "$NO_LINGER" ]; then echo no; else echo yes; fi');
		stub("systemctl", "echo REAL systemctl >&2; exit 99");
		stub("journalctl", "echo REAL journalctl >&2; exit 99");
		// The installed package, as pnpm would leave it.
		mkdirSync(join(dir, "pkg/dist"), { recursive: true });
		writeFileSync(join(dir, "pkg/dist/build-info.json"), JSON.stringify(BUILD));
		mkdirSync(join(pnpmHome(), "bin"), { recursive: true });
		writeFileSync(join(pnpmHome(), "bin/crb"), "#!/bin/sh\n");
		chmodSync(join(pnpmHome(), "bin/crb"), 0o755);
		env = {
			HOME: join(dir, "home"),
			PATH: `${stubs}:${process.env.PATH}`,
			XDG_CONFIG_HOME: join(dir, "config"),
			XDG_STATE_HOME: join(dir, "state"),
			XDG_DATA_HOME: join(dir, "data"),
			SYSTEMD_USER_DIR: join(dir, "units"),
			PNPM_HOME: pnpmHome(),
			CRB_DEVBOX_PKG_DIR: join(dir, "pkg"),
			CRB_DEVBOX_DRY_RUN: "1",
			CRB_DEVBOX_TIMEOUT: "10",
			GH_TOKEN: "from-the-shell",
			GH_CONFIG_DIR: join(dir, "gh-private"),
		};
	});
	afterEach(async () => {
		await new Promise((resolve) =>
			server ? server.close(resolve) : resolve(null),
		);
		server = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	/** A fake crb serve answering /api/version with `build`; `key` required when given. */
	async function serve(host: string, build = BUILD, key?: string) {
		server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://x");
			if (key && url.searchParams.get("key") !== key) {
				res.writeHead(401).end();
			} else if (url.pathname === "/api/version") {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(build));
			} else res.writeHead(404).end();
		});
		await new Promise<void>((resolve) => server?.listen(0, host, resolve));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		mkdirSync(join(dir, "config/carbonless"), { recursive: true });
		writeFileSync(
			join(dir, "config/carbonless/config.json"),
			JSON.stringify({ serve: { host, port } }),
		);
		return port;
	}

	// Async, so the fake server in this process keeps answering meanwhile.
	const run = (script: string, args: string[] = [], extra = {}) =>
		new Promise<Result>((resolve) => {
			execFile(
				join(here, script),
				args,
				{ env: { ...env, ...extra } },
				(error, stdout, stderr) => {
					const code = error ? ((error as { code?: number }).code ?? 1) : 0;
					resolve({ code, stdout, stderr });
				},
			);
		});

	/** server.json as the crb serve with this pid writes it. */
	const serverJson = (pid: number) => {
		mkdirSync(join(dir, "state/carbonless"), { recursive: true });
		writeFileSync(
			join(dir, "state/carbonless/server.json"),
			JSON.stringify({ url: "x", host: "x", port: 1, pid }),
		);
	};

	/**
	 * Real mode against stand-ins: a systemctl that logs its calls and reports
	 * crb.service active with MainPID $FAKE_MAINPID, a journalctl, and a pnpm
	 * whose global dir holds pkg until `add -g` switches it to pkg2.
	 */
	function realStubs(after = { version: "0.2.0", commit: "1".repeat(40) }) {
		const stubs = join(dir, "real-stubs");
		mkdirSync(stubs);
		const stub = (name: string, body: string) => {
			writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`);
			chmodSync(join(stubs, name), 0o755);
		};
		const ls = (pkg: string) =>
			JSON.stringify([
				{
					path: join(pnpmHome(), "global/v11"),
					dependencies: {
						"carbonless-review": { version: "x", path: join(dir, pkg) },
					},
				},
			]);
		writeFileSync(join(dir, "ls.json"), ls("pkg"));
		writeFileSync(join(dir, "ls-after.json"), ls("pkg2"));
		mkdirSync(join(dir, "pkg2/dist"), { recursive: true });
		writeFileSync(
			join(dir, "pkg2/dist/build-info.json"),
			JSON.stringify(after),
		);
		const log = join(dir, "calls.log");
		stub(
			"systemctl",
			[
				`echo "systemctl $*" >>"${log}"`,
				'case "$*" in',
				"*is-active*) exit 0 ;;",
				'*show*) echo "$FAKE_MAINPID" ;;',
				"esac",
			].join("\n"),
		);
		stub("journalctl", 'echo "journal: crb failed to bind"');
		stub(
			"pnpm",
			[
				`echo "pnpm $*" >>"${log}"`,
				'case "$1 $2" in',
				'"bin -g") echo "$PNPM_HOME/bin" ;;',
				`"ls -g") cat "${join(dir, "ls.json")}" ;;`,
				`"add -g") cp "${join(dir, "ls-after.json")}" "${join(dir, "ls.json")}" ;;`,
				"esac",
			].join("\n"),
		);
		return {
			env: {
				PATH: `${stubs}:${env.PATH}`,
				CRB_DEVBOX_DRY_RUN: "",
				CRB_DEVBOX_PKG_DIR: "",
				FAKE_MAINPID: "4242",
			},
			calls: () => readFileSync(log, "utf8"),
		};
	}

	it("install writes a unit running the global crb serve on Node 24, without XDG_CONFIG_HOME", async () => {
		const port = await serve("127.0.0.1");
		const r = await run("install");
		expect(r.stderr).not.toContain("REAL");
		expect(r.code).toBe(0);
		const unit = readFileSync(unitFile(), "utf8");
		expect(unit).toContain(`Environment="PATH=${nodeBin()}:${pnpmHome()}/bin:`);
		expect(unit).toContain(`ExecStart="${pnpmHome()}/bin/crb" serve\n`);
		expect(unit).toMatch(/^Type=simple$/m);
		expect(unit).toMatch(/^Restart=on-failure$/m);
		expect(unit).toMatch(/^RestartSec=5$/m);
		expect(unit).toMatch(/^StartLimitIntervalSec=0$/m);
		expect(unit).not.toMatch(/^Environment=.*XDG_CONFIG_HOME/m);
		// git and gh are on the service's PATH.
		const path = unit.match(/^Environment="PATH=(.*)"$/m)?.[1]?.split(":");
		expect(path).toContain(join(dir, "stubs"));
		expect(r.stdout).toContain("dry-run: systemctl --user daemon-reload");
		expect(r.stdout).toContain("dry-run: systemctl --user enable crb");
		expect(r.stdout).toContain("dry-run: systemctl --user restart crb");
		expect(r.stdout).toContain(
			`crb 0.1.0 (abcdef0) is serving: http://127.0.0.1:${port}/\n`,
		);
		expect(r.stderr).not.toContain("linger");

		// Rerun: same unit, no restart of a service already serving the build.
		const again = await run("install");
		expect(again.code).toBe(0);
		expect(again.stdout).not.toContain("Wrote");
		expect(again.stdout).not.toContain("restart");
		expect(readFileSync(unitFile(), "utf8")).toBe(unit);
	});

	it("install writes and enables crb-follow's service and timer, unless --no-follow", async () => {
		await serve("127.0.0.1");
		const r = await run("install", [], { CRB_DEVBOX_REPO: join(dir, "repo") });
		expect(r.stderr).not.toContain("REAL");
		expect(r.code).toBe(0);
		const service = readFileSync(join(dir, "units/crb-follow.service"), "utf8");
		expect(service).toMatch(/^Type=oneshot$/m);
		expect(service).toContain(`ExecStart="${join(here, "follow")}"\n`);
		expect(service).toContain(`Environment="PNPM_HOME=${pnpmHome()}"`);
		expect(service).toContain(
			`Environment="CRB_DEVBOX_REPO=${join(dir, "repo")}"`,
		);
		expect(service).toContain(
			`Environment="PATH=${nodeBin()}:${pnpmHome()}/bin:`,
		);
		expect(service).not.toMatch(/^Environment=.*XDG_CONFIG_HOME/m);
		const timer = readFileSync(join(dir, "units/crb-follow.timer"), "utf8");
		expect(timer).toMatch(/^OnBootSec=2min$/m);
		expect(timer).toMatch(/^OnUnitActiveSec=5min$/m);
		expect(timer).toMatch(/^Persistent=true$/m);
		expect(r.stdout).toContain(
			`Wrote ${join(dir, "units/crb-follow.service")}`,
		);
		expect(r.stdout).toContain(
			"dry-run: systemctl --user enable --now crb-follow.timer",
		);
		expect(r.stdout.match(/daemon-reload/g)).toHaveLength(1);

		// Rerun: nothing rewritten.
		const again = await run("install", [], {
			CRB_DEVBOX_REPO: join(dir, "repo"),
		});
		expect(again.code).toBe(0);
		expect(again.stdout).not.toContain("Wrote");

		rmSync(join(dir, "units"), { recursive: true });
		const off = await run("install", ["--no-follow"]);
		expect(off.code).toBe(0);
		expect(existsSync(join(dir, "units/crb-follow.timer"))).toBe(false);
		expect(off.stdout).not.toContain("crb-follow");
		expect(existsSync(unitFile())).toBe(true);
	});

	it("install defaults crb-follow's repo to this checkout's main one", async () => {
		await serve("127.0.0.1");
		expect((await run("install", ["--no-follow", "--bogus"])).code).not.toBe(0);
		const r = await run("install");
		expect(r.code).toBe(0);
		const common = execFileSync(
			"git",
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			{ cwd: here, encoding: "utf8" },
		).trim();
		expect(
			readFileSync(join(dir, "units/crb-follow.service"), "utf8"),
		).toContain(`Environment="CRB_DEVBOX_REPO=${dirname(common)}"`);
	});

	it("install with a spec installs it; it warns about linger and needs gh's login", async () => {
		await serve("127.0.0.1");
		const r = await run("install", ["rc"], { NO_LINGER: "1" });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("dry-run: pnpm add -g carbonless-review@rc");
		expect(r.stderr).toContain("sudo loginctl enable-linger");

		const out = await run("install", [], { GH_LOGGED_OUT: "1" });
		expect(out.code).not.toBe(0);
		expect(out.stderr).toContain("gh auth login");
	});

	it("install without a spec needs crb installed", async () => {
		rmSync(join(pnpmHome(), "bin/crb"));
		const r = await run("install", [], { CRB_DEVBOX_DRY_RUN: "" });
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain("crb not found");
		expect(r.stderr).not.toContain("REAL");
		expect(existsSync(unitFile())).toBe(false);
	});

	it("install fails without Node 24", async () => {
		rmSync(join(dir, "home/.nvm"), { recursive: true });
		const fake = join(dir, "node22");
		mkdirSync(fake);
		writeFileSync(join(fake, "node"), "#!/bin/sh\necho v22.1.0\n");
		chmodSync(join(fake, "node"), 0o755);
		const r = await run("install", [], { CRB_NODE_BIN: fake });
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain("crb needs Node 24");
	});

	it("update installs a tarball, restarts and prints the link with the key", async () => {
		mkdirSync(join(dir, "state/carbonless"), { recursive: true });
		writeFileSync(join(dir, "state/carbonless/key"), "s3cret\n");
		// 127.0.0.2 is loopback to the kernel but not to crb: it needs the key.
		const port = await serve("127.0.0.2", BUILD, "s3cret");
		expect((await run("install")).code).toBe(0);
		const tarball = join(dir, "carbonless-review-0.1.0.tgz");
		writeFileSync(tarball, "");
		const r = await run("update", [tarball]);
		expect(r.stderr).not.toContain("REAL");
		expect(r.code).toBe(0);
		expect(r.stdout).toContain(`dry-run: pnpm add -g ${tarball}\n`);
		expect(r.stdout).toContain("dry-run: systemctl --user restart crb\n");
		expect(r.stdout).toContain("crb: 0.1.0 (abcdef0) -> 0.1.0 (abcdef0)\n");
		expect(r.stdout).toMatch(
			new RegExp(`\nhttp://127\\.0\\.0\\.2:${port}/\\?key=s3cret\n$`),
		);
	});

	it("update maps channels and versions to the package; refuses anything else", async () => {
		await serve("127.0.0.1");
		expect((await run("install")).code).toBe(0);
		for (const spec of ["latest", "0.2.0", "0.2.0-rc.1"]) {
			const r = await run("update", [spec]);
			expect(r.code).toBe(0);
			expect(r.stdout).toContain(
				`dry-run: pnpm add -g carbonless-review@${spec}\n`,
			);
		}
		const bad = await run("update", ["github:someone/else"]);
		expect(bad.code).not.toBe(0);
		expect(bad.stdout).not.toContain("pnpm add");
	});

	it("update needs the unit installed first", async () => {
		const r = await run("update", ["rc"]);
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain("run scripts/devbox/install first");
	});

	it("update times out with the service's log when it never serves the new build", async () => {
		await serve("127.0.0.1", { ...BUILD, commit: "0".repeat(40) });
		mkdirSync(dirname(unitFile()), { recursive: true });
		writeFileSync(unitFile(), "");
		const r = await run("update", ["rc"], { CRB_DEVBOX_TIMEOUT: "1" });
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain("does not serve 0.1.0 (abcdef0)");
		expect(r.stderr).toContain(
			"dry-run: journalctl --user -u crb -n 30 --no-pager",
		);
	});
	it("update reads the installed builds from pnpm ls -g and moves from one to the other", async () => {
		const after = { version: "0.2.0", commit: "1".repeat(40) };
		const real = realStubs(after);
		const port = await serve("127.0.0.1", after);
		serverJson(4242);
		expect(
			(
				await run("install", [], {
					CRB_DEVBOX_DRY_RUN: "1",
					CRB_DEVBOX_PKG_DIR: join(dir, "pkg2"),
				})
			).code,
		).toBe(0);
		const r = await run("update", ["0.2.0"], real.env);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("crb: 0.1.0 (abcdef0) -> 0.2.0 (1111111)\n");
		expect(r.stdout).toMatch(new RegExp(`http://127\\.0\\.0\\.1:${port}/\n$`));
		expect(real.calls()).toContain("pnpm add -g carbonless-review@0.2.0");
		expect(real.calls()).toContain("systemctl --user restart crb");
		// The unit didn't change: no reload.
		expect(real.calls()).not.toContain("daemon-reload");
		expect(real.calls()).toContain(
			"systemctl --user show -p MainPID --value crb",
		);
	});

	it("a crb serve that isn't crb.service doesn't pass for it", async () => {
		await serve("127.0.0.1");
		// server.json names the crb serve answering: pid 4242.
		serverJson(4242);
		const ok = await run("install", [], { CRB_DEVBOX_DRY_MAINPID: "4242" });
		expect(ok.code).toBe(0);

		// A hand-started crb holds the port while crb.service (MainPID 99, or
		// inactive: 0) can't bind it: install restarts and then fails, naming it.
		for (const main of ["99", "0"]) {
			const r = await run("install", [], {
				CRB_DEVBOX_DRY_MAINPID: main,
				CRB_DEVBOX_TIMEOUT: "1",
			});
			expect(r.code).not.toBe(0);
			expect(r.stdout).toContain("dry-run: systemctl --user restart crb");
			expect(r.stderr).toContain(
				`is served by pid 4242, not by crb.service (MainPID ${main})`,
			);
			expect(r.stderr).toContain("dry-run: journalctl --user -u crb");
		}

		// The same in real mode, through systemctl show.
		const real = realStubs(BUILD);
		const r = await run("update", ["rc"], {
			...real.env,
			FAKE_MAINPID: "99",
			CRB_DEVBOX_TIMEOUT: "1",
		});
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain(
			"is served by pid 4242, not by crb.service (MainPID 99)",
		);
		expect(r.stderr).toContain("journal: crb failed to bind");
	});

	it("a server whose server.json lives elsewhere is an unknown process", async () => {
		await serve("127.0.0.1");
		const r = await run("install", [], {
			CRB_DEVBOX_DRY_MAINPID: "99",
			CRB_DEVBOX_TIMEOUT: "1",
		});
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain(
			"is served by an unknown process, not by crb.service (MainPID 99)",
		);
	});

	it("install fails when it can't read the installed build", async () => {
		await serve("127.0.0.1");
		mkdirSync(join(dir, "empty"));
		const real = realStubs();
		const r = await run("install", [], {
			...real.env,
			CRB_DEVBOX_PKG_DIR: join(dir, "empty"),
		});
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain(
			"can't read the installed carbonless-review's build",
		);
	});

	it("update rewrites the unit when Node 24 moved, and reloads systemd", async () => {
		await serve("127.0.0.1");
		expect((await run("install")).code).toBe(0);
		const newer = join(dir, "home/.nvm/versions/node/v24.9.0/bin");
		mkdirSync(newer, { recursive: true });
		symlinkSync(process.execPath, join(newer, "node"));
		const r = await run("update", ["rc"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain(`Wrote ${unitFile()}`);
		expect(r.stdout).toContain("dry-run: systemctl --user daemon-reload");
		expect(readFileSync(unitFile(), "utf8")).toContain(
			`Environment="PATH=${newer}:`,
		);
		// Nothing moved: nothing rewritten.
		const again = await run("update", ["rc"]);
		expect(again.stdout).not.toContain("Wrote");
		expect(again.stdout).not.toContain("daemon-reload");
	});

	it("escapes & and % in the unit's paths", async () => {
		await serve("127.0.0.1");
		const odd = join(dir, "pn&p%m");
		mkdirSync(join(odd, "bin"), { recursive: true });
		writeFileSync(join(odd, "bin/crb"), "#!/bin/sh\n");
		chmodSync(join(odd, "bin/crb"), 0o755);
		const r = await run("install", [], { PNPM_HOME: odd });
		expect(r.code).toBe(0);
		const escaped = join(dir, "pn&p%%m");
		const unit = readFileSync(unitFile(), "utf8");
		expect(unit).toContain(`ExecStart="${escaped}/bin/crb" serve`);
		expect(unit).toContain(`:${escaped}/bin:`);
	});

	it("refuses serve.port 0: the service needs a fixed port", async () => {
		mkdirSync(join(dir, "config/carbonless"), { recursive: true });
		writeFileSync(
			join(dir, "config/carbonless/config.json"),
			JSON.stringify({ serve: { port: 0 } }),
		);
		const r = await run("install");
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain("serve.port is 0");
		expect(existsSync(unitFile())).toBe(false);
	});
});
