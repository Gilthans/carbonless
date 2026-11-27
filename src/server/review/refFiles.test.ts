import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	testGitEnv,
} from "../../../test/git-fixture";
import { countSpawns } from "../../../test/spawn-count";
import { tipFromFiles } from "./refFiles";
import { RefStore } from "./refStore";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const fx = createGitFixture([
	{ message: "one", files: { "a.txt": "1\n" } },
	{ message: "two", files: { "a.txt": "2\n" } },
]);
const [one = "", two = ""] = fx.shas;
const tmp = mkdtempSync(join(tmpdir(), "crb-ref-files-"));
const bare = join(tmp, "bare.git");
const run = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: testGitEnv(),
	}).trim();
run(tmp, "clone", "--quiet", "--bare", fx.path, bare);
afterAll(() => {
	fx.cleanup();
	rmSync(tmp, { recursive: true, force: true });
});

/** What git says the ref's tip is: its OID, or null. */
const revParse = (repo: string, ref: string) => {
	try {
		return run(
			repo,
			"rev-parse",
			"--verify",
			"--quiet",
			"--end-of-options",
			ref,
		);
	} catch {
		return null;
	}
};

describe("tipFromFiles", () => {
	for (const [kind, repo] of [
		["bare", bare],
		["work tree", fx.path],
	] as const) {
		it(`agrees with rev-parse through a ref's life (${kind})`, async () => {
			const ref = "refs/crb/reviews/r1/reviewers/me/progress";
			const other = "refs/crb/reviews/r1/meta";
			const check = async () => {
				for (const r of [ref, other, "refs/crb/reviews/r1"]) {
					expect(await tipFromFiles(repo, r), r).toBe(revParse(repo, r));
				}
			};
			await check();
			run(repo, "update-ref", ref, one);
			await check();
			run(repo, "update-ref", other, two);
			run(repo, "pack-refs", "--all");
			await check();
			// Loose again over the packed one.
			run(repo, "update-ref", ref, two);
			await check();
			expect(await tipFromFiles(repo, ref)).toBe(two);
			run(repo, "update-ref", "-d", ref);
			await check();
			run(repo, "pack-refs", "--all");
			run(repo, "update-ref", "-d", other);
			await check();
			expect(await tipFromFiles(repo, other)).toBeNull();
		});
	}

	it("leaves to git what it can't be sure of", async () => {
		const ref = "refs/crb/sym";
		run(bare, "symbolic-ref", ref, "refs/heads/main");
		expect(await tipFromFiles(bare, ref)).toBeUndefined();
		// Not a repository it knows the layout of.
		expect(await tipFromFiles(join(tmp, "nowhere"), ref)).toBeUndefined();
		// A reftable repository.
		const rt = join(tmp, "rt");
		mkdirSync(join(rt, "refs"), { recursive: true });
		mkdirSync(join(rt, "objects"));
		mkdirSync(join(rt, "reftable"));
		expect(await tipFromFiles(rt, ref)).toBeUndefined();
		// A loose file that isn't an OID.
		const odd = join(tmp, "odd");
		mkdirSync(join(odd, "refs", "crb"), { recursive: true });
		mkdirSync(join(odd, "objects"));
		writeFileSync(join(odd, "refs", "crb", "x"), "garbage\n");
		expect(await tipFromFiles(odd, "refs/crb/x")).toBeUndefined();
	});

	it("RefStore reads tips with no process", async () => {
		const ref = "refs/crb/reviews/r2/meta";
		run(bare, "update-ref", ref, one);
		const store = new RefStore(bare);
		const spawns = countSpawns();
		try {
			expect(await store.tip(ref)).toBe(one);
			expect(await store.tip("refs/crb/reviews/r2/none")).toBeNull();
		} finally {
			spawns.stop();
		}
		expect(spawns.shapes).toEqual([]);
	});
});
