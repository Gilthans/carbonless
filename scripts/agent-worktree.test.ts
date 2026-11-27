// CAR-330: scripts/agent-worktree.sh fetches origin and branches from the
// newest origin/master by default, never from a stale local ref or the
// calling checkout's HEAD. Runs the real script against a clone of a bare
// origin, with a fake pnpm and a stub crb-private-env.mjs.
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GIT_TEST_TIMEOUTS, testGitEnv } from "../test/git-fixture";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const script = join(import.meta.dirname, "agent-worktree.sh");

let tmp: string;
let origin: string;
let clone: string;
let other: string;
let bin: string;
let env: NodeJS.ProcessEnv;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

const commit = (cwd: string, file: string, message: string) => {
	writeFileSync(join(cwd, file), message);
	git(cwd, "add", file);
	git(cwd, "commit", "-qm", message);
	return git(cwd, "rev-parse", "HEAD");
};

// A sync child blocks the event loop, so Vitest's own timeout can't end a
// hang: the spawn carries one.
const run = (...args: string[]) =>
	spawnSync("bash", [script, ...args], {
		cwd: clone,
		env,
		encoding: "utf8",
		timeout: GIT_TEST_TIMEOUTS.testTimeout,
	});

const wtHead = (name: string) =>
	git(join(clone, ".worktrees", name), "rev-parse", "HEAD");

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "crb agent-worktree-"));
	origin = join(tmp, "origin.git");
	clone = join(tmp, "clone");
	other = join(tmp, "other");
	bin = join(tmp, "bin");
	mkdirSync(bin);
	// pnpm install and playwright install: nothing to do here.
	writeFileSync(join(bin, "pnpm"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(bin, "pnpm"), 0o755);
	env = testGitEnv({
		PATH: `${bin}:${process.env.PATH}`,
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@example.com",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@example.com",
		GIT_TERMINAL_PROMPT: "0",
	});
	git(tmp, "init", "-q", "--bare", "-b", "master", origin);
	mkdirSync(join(clone, "scripts"), { recursive: true });
	git(clone, "init", "-q", "-b", "master");
	git(clone, "remote", "add", "origin", origin);
	writeFileSync(
		join(clone, "scripts", "crb-private-env.mjs"),
		'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2] + "/.envrc", "export X=1\\n");\n',
	);
	writeFileSync(join(clone, ".gitignore"), ".worktrees/\n.envrc\n");
	git(clone, "add", ".");
	git(clone, "commit", "-qm", "init");
	git(clone, "push", "-q", "-u", "origin", "master");
	git(tmp, "clone", "-q", origin, other);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("agent-worktree.sh", () => {
	it("fetches and branches from the newest origin/master, not HEAD", () => {
		// The caller is on another branch, and its origin/master is stale.
		git(clone, "switch", "-qc", "feature");
		const feature = commit(clone, "f.txt", "feature");
		const newest = commit(other, "m.txt", "newer master");
		git(other, "push", "-q", "origin", "master");

		const r = run("car-1-x");
		expect(r.status, r.stderr).toBe(0);
		expect(wtHead("car-1-x")).toBe(newest);
		expect(wtHead("car-1-x")).not.toBe(feature);
		const short = git(clone, "rev-parse", "--short", newest);
		expect(r.stdout).toMatch(
			new RegExp(`Base: origin/master \\(${short}, \\d{4}-\\d\\d-\\d\\d `),
		);
		expect(r.stderr).not.toMatch(/WARNING/);
		// No upstream: a bare push can't aim the branch at master.
		const upstream = spawnSync(
			"git",
			["rev-parse", "--abbrev-ref", "car-1-x@{upstream}"],
			{ cwd: clone, env },
		);
		expect(upstream.status).not.toBe(0);
	});

	it("ignores a local branch named origin/master", () => {
		const stale = git(clone, "rev-parse", "master");
		git(clone, "branch", "origin/master", stale);
		const newest = commit(other, "m.txt", "newer master");
		git(other, "push", "-q", "origin", "master");

		const r = run("car-5-x");
		expect(r.status, r.stderr).toBe(0);
		expect(wtHead("car-5-x")).toBe(newest);
		expect(r.stdout).toContain("Base: origin/master (");
	});

	it("takes an explicit base: a branch or a SHA", () => {
		git(clone, "switch", "-qc", "feature");
		const feature = commit(clone, "f.txt", "feature");
		const first = git(clone, "rev-parse", "master");

		expect(run("car-2-a", "feature").status).toBe(0);
		expect(wtHead("car-2-a")).toBe(feature);
		const r = run("car-2-b", first);
		expect(r.status, r.stderr).toBe(0);
		expect(wtHead("car-2-b")).toBe(first);
		expect(r.stdout).toContain(`Base: ${first} (`);
	});

	it("warns and goes on from the local origin/master when the fetch fails", () => {
		const local = git(clone, "rev-parse", "origin/master");
		git(clone, "remote", "set-url", "origin", join(tmp, "gone.git"));

		const r = run("car-3-x");
		expect(r.status, r.stderr).toBe(0);
		expect(r.stderr).toMatch(/WARNING: git fetch origin failed/);
		expect(wtHead("car-3-x")).toBe(local);
	});

	it("refuses a base that names no commit", () => {
		const r = run("car-4-x", "no-such-ref");
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("no such commit: no-such-ref");
		expect(
			spawnSync("git", ["rev-parse", "--verify", "car-4-x"], {
				cwd: clone,
				env,
			}).status,
		).not.toBe(0);
	});
});
