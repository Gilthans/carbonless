#!/usr/bin/env node
// pnpm test:pack: packs carbonless-review as npm would publish it, installs
// the tarball globally into a temp PNPM_HOME (temp XDG dirs, a gh that
// refuses every call), and runs the installed crb: --version, --help, and
// crb serve on a free port answering /api/version and serving the web page.
// Proves the tarball holds the web assets and dependencies holds every
// runtime import. Cleans up after itself, also on failure.
import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
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

const root = fileURLToPath(new URL("../", import.meta.url));
const { name, version } = JSON.parse(
	readFileSync(join(root, "package.json"), "utf8"),
);
const started = Date.now();
const tmp = mkdtempSync(join(tmpdir(), "crb-pack-"));
let server;

function check(ok, message) {
	if (!ok) throw new Error(message);
	console.log(`ok: ${message}`);
}

try {
	const pnpmHome = join(tmp, "pnpm-home");
	const stubs = join(tmp, "stubs");
	mkdirSync(stubs);
	// Nothing here may reach the real GitHub.
	writeFileSync(
		join(stubs, "gh"),
		"#!/bin/sh\necho 'pack smoke: no gh' >&2\nexit 1\n",
	);
	chmodSync(join(stubs, "gh"), 0o755);
	const env = {
		...process.env,
		PNPM_HOME: pnpmHome,
		PATH: [
			stubs,
			join(pnpmHome, "bin"),
			dirname(process.execPath),
			process.env.PATH,
		].join(":"),
		XDG_CONFIG_HOME: join(tmp, "config"),
		XDG_STATE_HOME: join(tmp, "state"),
		XDG_CACHE_HOME: join(tmp, "cache"),
		XDG_DATA_HOME: join(tmp, "data"),
	};
	const sh = (cmd, args, cwd = tmp) =>
		execFileSync(cmd, args, {
			cwd,
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		});

	// prepack builds dist.
	sh("pnpm", ["pack", "--pack-destination", tmp], root);
	const tarball = join(tmp, `${name}-${version}.tgz`);
	check(
		readdirSync(tmp).includes(`${name}-${version}.tgz`),
		`pnpm pack made ${name}-${version}.tgz`,
	);
	// By its bare name, in tmp: GNU tar reads a drive's colon (E:\...) as a
	// remote host.
	const files = sh("tar", ["tzf", `${name}-${version}.tgz`])
		.trim()
		.split("\n");
	check(
		!files.some((f) => f.endsWith(".map") || /\.test\.|\.d\.ts$/.test(f)),
		`${files.length} files, no maps, tests or typings`,
	);

	sh("pnpm", ["add", "-g", tarball]);
	const crb = join(sh("pnpm", ["bin", "-g"]).trim(), "crb");
	const built = JSON.parse(
		readFileSync(join(root, "dist/build-info.json"), "utf8"),
	);
	check(built.version === version, `built version ${built.version}`);

	const short = built.commit.replace(/-dirty$/, "").slice(0, 7);
	const dirty = built.commit.endsWith("-dirty") ? "-dirty" : "";
	const printed = sh(crb, ["--version"]).trim();
	check(
		printed === `${version} (${short}${dirty})`,
		`crb --version: ${printed}`,
	);
	check(sh(crb, ["--help"]).includes("Usage: crb <pr>"), "crb --help");

	server = spawn(crb, ["serve", "--port", "0"], {
		cwd: tmp,
		env,
		stdio: ["ignore", "ignore", "pipe"],
	});
	const url = await new Promise((resolve, reject) => {
		let err = "";
		const timer = setTimeout(
			() => reject(new Error(`crb serve did not start:\n${err}`)),
			30_000,
		);
		server.stderr.on("data", (d) => {
			err += d;
			const m = err.match(/carbonless listening on (http:\/\/\S+?)\/\s/);
			if (m) {
				clearTimeout(timer);
				resolve(m[1]);
			}
		});
		server.on("exit", (code) =>
			reject(new Error(`crb serve exited (${code}):\n${err}`)),
		);
	});
	const served = await (await fetch(`${url}/api/version`)).json();
	check(
		served.version === built.version && served.commit === built.commit,
		`GET /api/version: ${JSON.stringify(served)}`,
	);
	const page = await (await fetch(`${url}/`)).text();
	check(page.includes('<div id="root">'), "GET / serves the web page");
	const script = page.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
	const asset = script && (await fetch(`${url}${script}`));
	check(asset?.ok, `GET ${script}`);
	console.log(
		`pack smoke passed in ${((Date.now() - started) / 1000).toFixed(1)} s`,
	);
} finally {
	if (server && server.exitCode === null) {
		const exited = new Promise((resolve) => server.on("exit", resolve));
		server.kill("SIGTERM");
		await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
		if (server.exitCode === null) server.kill("SIGKILL");
	}
	rmSync(tmp, { recursive: true, force: true });
}
