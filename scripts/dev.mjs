#!/usr/bin/env node
// `pnpm dev`: crb serve (tsx watch, API only) on $CRB_API_PORT (default
// 4858, never the owner's 4747) and Vite in front of it. State and config
// are always this worktree's .crb-dev/ (scripts/crb-private-env.mjs), so a
// branch's server never finds, nor is found by, the installed one. With
// $CRB_PR, opens that PR through the client once this server answers and
// prints the review's link.
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
	privateDirs,
	removeStaleState,
	waitForLiveServer,
	writePrivateConfig,
} from "./crb-private-env.mjs";

const root = new URL("../", import.meta.url).pathname;
const port = process.env.CRB_API_PORT ?? "4858";
// A client started here, or by hand with these dirs, serves on this port too.
writePrivateConfig(root, Number(port));
// A killed dev server leaves its server.json: the client must not trust it.
removeStaleState(root);
// privateDirs reads gh's real config dir from this environment, before
// XDG_CONFIG_HOME moves (gh follows it and would lose its login).
const env = { ...process.env, ...privateDirs(root), CRB_API_PORT: port };
const bin = (name) => join(root, "node_modules", ".bin", name);

const children = [
	spawn(
		bin("tsx"),
		["watch", "src/cli.ts", "serve", "--port", port, "--api-only"],
		{ cwd: root, env, stdio: "inherit" },
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
	if (await waitForLiveServer(Number(port), 60_000)) {
		spawn(bin("tsx"), ["src/cli.ts", process.env.CRB_PR], {
			cwd: root,
			env,
			stdio: "inherit",
		});
	} else {
		console.error(`crb serve did not answer on port ${port}; no CRB_PR link`);
	}
}
