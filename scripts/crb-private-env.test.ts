import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	envrc,
	privateDirs,
	removeStaleState,
	waitForLiveServer,
	writePrivateConfig,
} from "./crb-private-env.mjs";

describe("a worktree's private crb state and config", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-private-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const config = () =>
		JSON.parse(
			readFileSync(join(dir, ".crb-dev/config/carbonless/config.json"), "utf8"),
		);

	it("lives in .crb-dev, whatever XDG the shell has; gh keeps the real login", () => {
		const env = { XDG_CONFIG_HOME: "/home/me/.cfg" };
		expect(privateDirs(dir, env)).toEqual({
			XDG_STATE_HOME: join(dir, ".crb-dev", "state"),
			XDG_CONFIG_HOME: join(dir, ".crb-dev", "config"),
			// gh follows XDG_CONFIG_HOME: pinned to where its login is.
			GH_CONFIG_DIR: "/home/me/.cfg/gh",
		});
		expect(envrc(dir, env)).toBe(
			`export XDG_STATE_HOME="${join(dir, ".crb-dev", "state")}"\nexport XDG_CONFIG_HOME="${join(dir, ".crb-dev", "config")}"\nexport GH_CONFIG_DIR="\${GH_CONFIG_DIR:-/home/me/.cfg/gh}"\n`,
		);
	});

	it("finds gh's real config dir before the override", () => {
		const gh = (env: Record<string, string | undefined>) =>
			privateDirs(dir, env).GH_CONFIG_DIR;
		// Already set: never overridden.
		expect(gh({ GH_CONFIG_DIR: "/gh", XDG_CONFIG_HOME: "/x" })).toBe("/gh");
		expect(gh({ XDG_CONFIG_HOME: "/x" })).toBe("/x/gh");
		// Unset, empty or relative XDG_CONFIG_HOME: ~/.config.
		for (const xdg of [undefined, "", "rel/dir"]) {
			expect(gh({ XDG_CONFIG_HOME: xdg })).toBe(
				join(homedir(), ".config", "gh"),
			);
		}
	});

	it("serves on its own port, never the default 4747", () => {
		writePrivateConfig(dir, 0);
		expect(config()).toEqual({ serve: { port: 0 } });
		// pnpm dev's port, keeping what else the file has.
		const file = join(dir, ".crb-dev/config/carbonless/config.json");
		writeFileSync(
			file,
			JSON.stringify({ serve: { host: "127.0.0.1", port: 4747 }, views: [1] }),
		);
		writePrivateConfig(dir, 4911);
		expect(config()).toEqual({
			serve: { host: "127.0.0.1", port: 4911 },
			views: [1],
		});
		// A file that isn't JSON is replaced.
		writeFileSync(file, "nope");
		writePrivateConfig(dir, 0);
		expect(config()).toEqual({ serve: { port: 0 } });
	});

	it("removes a stale server.json", () => {
		const state = join(dir, ".crb-dev", "state", "carbonless");
		mkdirSync(state, { recursive: true });
		writeFileSync(join(state, "server.json"), "{}");
		removeStaleState(dir);
		expect(() => readFileSync(join(state, "server.json"))).toThrow();
		removeStaleState(dir);
	});

	describe("waitForLiveServer", () => {
		let server: Server | undefined;
		afterEach(() => server?.close());

		it("waits until crb answers on that port, not for a file", async () => {
			const port = await new Promise<number>((done) => {
				const probe = createServer().listen(0, "127.0.0.1", () => {
					const a = probe.address();
					probe.close(() => done(typeof a === "object" && a ? a.port : 0));
				});
			});
			const waited = waitForLiveServer(port, 5000);
			let settled = false;
			void waited.then(() => {
				settled = true;
			});
			await new Promise((r) => setTimeout(r, 400));
			expect(settled).toBe(false);
			server = createServer((_req, res) => {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ version: "0.0.0", commit: "x" }));
			}).listen(port, "127.0.0.1");
			await expect(waited).resolves.toBe(true);
		});

		it("gives up after its time", async () => {
			await expect(waitForLiveServer(9, 300)).resolves.toBe(false);
		});
	});
});
