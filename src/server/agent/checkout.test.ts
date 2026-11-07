import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createBareRepo,
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
	testGitEnv,
} from "../../../test/git-fixture.js";
import { agentsDir, createCheckout, sweepStaleCheckouts } from "./checkout.js";

vi.setConfig(GIT_TEST_TIMEOUTS);

const REVIEW = "01k9e6m2q8x4v7c3n5b0h1j2t6";
const OTHER = "01k9e6m2q8x4v7c3n5b0h1j2t7";
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: testGitEnv(),
	}).trim();

let origin: GitFixture;
let cache: { path: string; cleanup: () => void };
let base: string;
let head: string;

beforeEach(() => {
	origin = createGitFixture([
		{ message: "base", files: { "a.txt": "old\n" } },
		{ message: "pr", files: { "a.txt": "new\n" } },
	]);
	[base = "", head = ""] = origin.shas;
	cache = createBareRepo();
	// Like the cache clone: origin is GitHub's URL, review refs beside the PR's.
	git(
		cache.path,
		"remote",
		"add",
		"origin",
		"https://github.com/acme/widget.git",
	);
	git(cache.path, "fetch", "--quiet", origin.path, `${head}:refs/pull/12/head`);
	git(cache.path, "update-ref", "refs/heads/main", base);
	git(cache.path, "tag", "v1", base);
	git(cache.path, "update-ref", "refs/crb/reviews/x/meta", base);
});
afterEach(() => {
	origin.cleanup();
	cache.cleanup();
	rmSync(agentsDir(), { recursive: true, force: true });
});

describe("createCheckout", () => {
	it("is a shared clone detached at head, without refs/crb", async () => {
		const c = await createCheckout(cache.path, REVIEW, head);
		expect(c.dir).toBe(join(agentsDir(), REVIEW));
		expect(c.tree).toBe(join(c.dir, "tree"));
		expect(git(c.tree, "rev-parse", "HEAD")).toBe(head);
		expect(
			spawnSync("git", ["-C", c.tree, "symbolic-ref", "-q", "HEAD"]).status,
		).toBe(1);
		expect(git(c.tree, "show", `${base}:a.txt`)).toBe("old");
		expect(git(c.tree, "for-each-ref", "refs/crb")).toBe("");
		expect(git(c.tree, "remote", "get-url", "origin")).toBe(
			"https://github.com/acme/widget.git",
		);
		expect(git(c.tree, "config", "user.name")).toBe("carbonless agent");
		// The agent can commit there.
		writeFileSync(join(c.tree, "b.txt"), "b\n");
		git(c.tree, "add", "b.txt");
		git(c.tree, "commit", "--quiet", "-m", "agent's");
		await c.remove();
		expect(existsSync(c.tree)).toBe(false);
		expect(existsSync(c.dir)).toBe(true);
	});

	it("drops origin when the cache clone has none (never the cache clone itself)", async () => {
		git(cache.path, "remote", "remove", "origin");
		const c = await createCheckout(cache.path, REVIEW, head);
		expect(git(c.tree, "remote")).toBe("");
	});

	it("refuses a review id that isn't a ULID and a head that isn't an OID", async () => {
		await expect(createCheckout(cache.path, "../x", head)).rejects.toThrow();
		await expect(
			createCheckout(cache.path, REVIEW, "--upload-pack=x"),
		).rejects.toThrow();
	});
});

describe("sweepStaleCheckouts", () => {
	const dead = () => spawnSync(process.execPath, ["-e", ""]).pid as number;
	const claimed = (id: string, pid: number) => {
		mkdirSync(join(agentsDir(), id, "tree"), { recursive: true });
		writeFileSync(
			join(agentsDir(), id, "claim.json"),
			JSON.stringify({ pid, port: 4800, token: "t" }),
		);
	};

	it("removes a dir whose claim names a dead pid and keeps a live one", async () => {
		claimed(REVIEW, dead());
		claimed(OTHER, process.pid);
		mkdirSync(join(agentsDir(), "not-a-review"));
		await sweepStaleCheckouts(new Set());
		expect(existsSync(join(agentsDir(), REVIEW))).toBe(false);
		expect(existsSync(join(agentsDir(), OTHER))).toBe(true);
		expect(existsSync(join(agentsDir(), "not-a-review"))).toBe(true);
	});

	it("keeps live reviews and removes unclaimed dirs", async () => {
		mkdirSync(join(agentsDir(), REVIEW, "tree"), { recursive: true });
		mkdirSync(join(agentsDir(), OTHER, "tree"), { recursive: true });
		await sweepStaleCheckouts(new Set([OTHER]));
		expect(existsSync(join(agentsDir(), REVIEW))).toBe(false);
		expect(existsSync(join(agentsDir(), OTHER))).toBe(true);
	});

	it("is fine without an agents dir", async () => {
		await expect(sweepStaleCheckouts(new Set())).resolves.toBeUndefined();
	});
});
