#!/usr/bin/env node
// A worktree's own crb state and config (.crb-dev/), so its crb never finds,
// nor starts a server on, the owner's (port 4747): pnpm dev
// (scripts/dev.mjs) and agent worktrees (scripts/agent-worktree.sh, which
// runs this as `node scripts/crb-private-env.mjs <dir> <port>` and sources
// nothing else) use it.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/**
 * gh's config dir (its login) as `env` has it, before XDG_CONFIG_HOME is
 * overridden: gh follows XDG_CONFIG_HOME, so a private one would log it
 * out. `$GH_CONFIG_DIR` when set, else `${XDG_CONFIG_HOME:-~/.config}/gh`.
 */
export function ghConfigDir(env = process.env) {
	if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
	const xdg = env.XDG_CONFIG_HOME;
	return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"), "gh");
}

/**
 * The environment of the worktree at `dir`: its private XDG dirs, and gh's
 * real config dir (computed from `env`, the environment before them).
 */
export function privateDirs(dir, env = process.env) {
	return {
		XDG_STATE_HOME: join(dir, ".crb-dev", "state"),
		XDG_CONFIG_HOME: join(dir, ".crb-dev", "config"),
		GH_CONFIG_DIR: ghConfigDir(env),
	};
}

/**
 * The worktree's .envrc, to source before running crb: the private dirs,
 * and GH_CONFIG_DIR unless the shell already sets one.
 */
export function envrc(dir, env = process.env) {
	const d = privateDirs(dir, env);
	return `export XDG_STATE_HOME="${d.XDG_STATE_HOME}"\nexport XDG_CONFIG_HOME="${d.XDG_CONFIG_HOME}"\nexport GH_CONFIG_DIR="\${GH_CONFIG_DIR:-${d.GH_CONFIG_DIR}}"\n`;
}

/**
 * Sets the private config's serve port (0: any free one), keeping the rest
 * of the file: without it, crb serve would fall back to 4747.
 */
export function writePrivateConfig(dir, port) {
	const configDir = join(privateDirs(dir).XDG_CONFIG_HOME, "carbonless");
	const file = join(configDir, "config.json");
	let config = {};
	try {
		const read = JSON.parse(readFileSync(file, "utf8"));
		if (read && typeof read === "object" && !Array.isArray(read)) config = read;
	} catch {
		// Missing or not JSON: a fresh one.
	}
	const serve =
		config.serve && typeof config.serve === "object" ? config.serve : {};
	config.serve = { ...serve, port };
	mkdirSync(configDir, { recursive: true });
	writeFileSync(file, `${JSON.stringify(config, null, "\t")}\n`);
}

/** Removes a server.json a killed dev server left behind. */
export function removeStaleState(dir) {
	rmSync(join(privateDirs(dir).XDG_STATE_HOME, "carbonless", "server.json"), {
		force: true,
	});
}

/** Whether crb answers /api/version on 127.0.0.1:`port` within `timeoutMs`. */
export async function waitForLiveServer(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/version`, {
				signal: AbortSignal.timeout(1000),
			});
			const body = await res.json();
			if (res.ok && typeof body?.version === "string") return true;
		} catch {
			// Not up yet.
		}
		await sleep(200);
	}
	return false;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [dir, port = "0"] = process.argv.slice(2);
	if (!dir || !existsSync(dir)) {
		console.error("usage: node scripts/crb-private-env.mjs <dir> [port]");
		process.exit(1);
	}
	writePrivateConfig(dir, Number(port));
	writeFileSync(join(dir, ".envrc"), envrc(dir));
	process.stdout.write(envrc(dir));
}
