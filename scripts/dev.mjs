#!/usr/bin/env node
// `pnpm dev`: crb serve (tsx watch, API only) on $CRB_API_PORT (default
// 4858, never the owner's 4747) and Vite in front of it. State and config
// live in .crb-dev/ in this worktree, so a branch's server never finds (or
// is found by) the installed one. With $CRB_PR, opens that PR through the
// client once the server is up and prints the review's link.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = new URL("../", import.meta.url).pathname;
const port = process.env.CRB_API_PORT ?? "4858";
const dev = join(root, ".crb-dev");
const env = {
	...process.env,
	XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? join(dev, "state"),
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? join(dev, "config"),
	CRB_API_PORT: port,
};
mkdirSync(env.XDG_STATE_HOME, { recursive: true });
const bin = (name) => join(root, "node_modules", ".bin", name);

const children = [
	spawn(
		bin("tsx"),
		["watch", "src/cli.ts", "serve", "--port", port, "--api-only"],
		{
			cwd: root,
			env,
			stdio: "inherit",
		},
	),
	spawn(bin("vite"), [], { cwd: root, env, stdio: "inherit" }),
];
const stop = () => {
	for (const c of children) c.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", stop);

if (process.env.CRB_PR) {
	const state = join(env.XDG_STATE_HOME, "carbonless", "server.json");
	while (!existsSync(state)) await sleep(200);
	spawn(bin("tsx"), ["src/cli.ts", process.env.CRB_PR], {
		cwd: root,
		env,
		stdio: "inherit",
	});
}
