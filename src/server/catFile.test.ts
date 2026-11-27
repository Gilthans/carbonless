import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	testGitEnv,
} from "../../test/git-fixture";
import { countSpawns } from "../../test/spawn-count";
import {
	catFileCount,
	closeCatFiles,
	IDLE_MS,
	MAX_PROCESSES,
	pauseCatFile,
	readBlob,
	readObject,
} from "./catFile";
import { GitError } from "./git";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const big = Buffer.alloc(3 * 1024 * 1024 + 17, "x");
// A carriage return in a name (git's line input would drop it): not a
// name Windows allows.
const windows = process.platform === "win32";
const CR = windows ? "line-end.txt" : "line\rend.txt";
const fx = createGitFixture([
	{
		message: "base",
		files: {
			"a.txt": "one\ntwo\n",
			"dir/b.txt": "bee\n",
			"with space.txt": "spaced\n",
			[CR]: "carriage\n",
			"empty.txt": "",
		},
		binary: { "big.bin": big },
	},
]);
const tmp = mkdtempSync(join(tmpdir(), "crb-cat-file-"));
afterEach(() => closeCatFiles());
afterAll(async () => {
	// Windows keeps a running process's directory: gone first.
	await closeCatFiles();
	fx.cleanup();
	rmSync(tmp, { recursive: true, force: true });
});
const [commit = ""] = fx.shas;
const git = (...args: string[]) =>
	execFileSync("git", args, {
		cwd: fx.path,
		encoding: "utf8",
		env: testGitEnv(),
	}).trim();

describe("catFile", () => {
	it("reads objects as cat-file does, all through one process", async () => {
		const spawns = countSpawns();
		try {
			const [a, b, spaced, cr, empty, bin, tree] = await Promise.all([
				readBlob(fx.path, `${commit}:a.txt`),
				readBlob(fx.path, `${commit}:dir/b.txt`),
				readBlob(fx.path, `${commit}:with space.txt`),
				readBlob(fx.path, `${commit}:${CR}`),
				readBlob(fx.path, `${commit}:empty.txt`),
				readBlob(fx.path, `${commit}:big.bin`),
				readObject(fx.path, `${commit}:dir`),
			]);
			expect(a.toString()).toBe("one\ntwo\n");
			expect(b.toString()).toBe("bee\n");
			expect(spaced.toString()).toBe("spaced\n");
			expect(cr.toString()).toBe("carriage\n");
			expect(empty.length).toBe(0);
			expect(bin.equals(big)).toBe(true);
			expect(tree?.type).toBe("tree");
			expect(tree?.oid).toBe(git("rev-parse", `${commit}:dir`));
			// Later reads, one at a time: the same process.
			for (let i = 0; i < 5; i++) {
				expect((await readBlob(fx.path, `${commit}:a.txt`)).toString()).toBe(
					"one\ntwo\n",
				);
			}
		} finally {
			spawns.stop();
		}
		expect(spawns.shapes).toEqual(["git cat-file --batch"]);
	});

	it("answers null for what isn't there, and a GitError from readBlob", async () => {
		expect(await readObject(fx.path, `${commit}:nope.txt`)).toBeNull();
		expect(await readObject(fx.path, "0".repeat(40))).toBeNull();
		await expect(readBlob(fx.path, `${commit}:nope.txt`)).rejects.toThrow(
			GitError,
		);
		// A tree is no blob.
		await expect(readBlob(fx.path, `${commit}:dir`)).rejects.toThrow(GitError);
		// Reads after a miss still line up.
		expect((await readBlob(fx.path, `${commit}:a.txt`)).toString()).toBe(
			"one\ntwo\n",
		);
	});

	it("reads a name that isn't led by an OID, or has a newline, on its own", async () => {
		const spawns = countSpawns();
		try {
			expect((await readBlob(fx.path, "HEAD:a.txt")).toString()).toBe(
				"one\ntwo\n",
			);
			expect(await readObject(fx.path, `${commit}:x\ny`)).toBeNull();
		} finally {
			spawns.stop();
		}
		expect(catFileCount()).toBe(0);
		expect(spawns.shapes).toEqual([
			"git cat-file --batch",
			"git cat-file --batch",
		]);
	});

	it("reads a relative path on its own: the reads queued beside it still answer", async () => {
		// In a bare clone git exits on `<oid>:./x` ("relative path syntax
		// can't be used outside working tree").
		const bare = join(tmp, "bare.git");
		git("clone", "--quiet", "--bare", fx.path, bare);
		const [before, bad, worse, after] = await Promise.allSettled([
			readBlob(bare, `${commit}:a.txt`),
			readObject(bare, `${commit}:./a.txt`),
			readObject(bare, `${commit}:../a.txt`),
			readBlob(bare, `${commit}:dir/b.txt`),
		]);
		expect(before.status === "fulfilled" && before.value.toString()).toBe(
			"one\ntwo\n",
		);
		expect(after.status === "fulfilled" && after.value.toString()).toBe(
			"bee\n",
		);
		expect(bad.status).toBe("rejected");
		expect(worse.status).toBe("rejected");
	});

	it(`keeps at most ${MAX_PROCESSES} processes, closing the least recently used idle one`, async () => {
		const clones = Array.from({ length: MAX_PROCESSES + 2 }, (_, i) => {
			const path = join(tmp, `clone${i}.git`);
			git("clone", "--quiet", "--bare", fx.path, path);
			return path;
		});
		for (const path of clones) {
			expect((await readBlob(path, `${commit}:a.txt`)).toString()).toBe(
				"one\ntwo\n",
			);
			expect(catFileCount()).toBeLessThanOrEqual(MAX_PROCESSES);
		}
		expect(catFileCount()).toBe(MAX_PROCESSES);
	});

	it("fails the reads out when its process dies, and starts another for the next", async () => {
		await readBlob(fx.path, `${commit}:a.txt`);
		const pending = readBlob(fx.path, `${commit}:big.bin`);
		// Its failure watched before the close that causes it.
		const failed = expect(pending).rejects.toThrow(GitError);
		await closeCatFiles();
		await failed;
		expect(catFileCount()).toBe(0);
		expect((await readBlob(fx.path, `${commit}:a.txt`)).toString()).toBe(
			"one\ntwo\n",
		);
		expect(catFileCount()).toBe(1);
	});

	it("fails every read of a clone git can't read, never an empty answer", async () => {
		await expect(
			readBlob("/nonexistent/crb-cat-file", `${commit}:a.txt`),
		).rejects.toThrow(GitError);
	});

	it("an aborted read fails at once; the reads after it line up", async () => {
		const stop = new AbortController();
		const aborted = readBlob(fx.path, `${commit}:big.bin`, stop.signal);
		stop.abort();
		await expect(aborted).rejects.toThrow("stopped");
		expect((await readBlob(fx.path, `${commit}:dir/b.txt`)).toString()).toBe(
			"bee\n",
		);
	});

	it("a pause closes the clone's process once its reads out are answered; reads meanwhile run their own", async () => {
		await readBlob(fx.path, `${commit}:a.txt`);
		expect(catFileCount()).toBe(1);
		// A read out when the pause comes is answered, not failed.
		const out = readBlob(fx.path, `${commit}:big.bin`);
		const resume = await pauseCatFile(fx.path);
		const spawns = countSpawns();
		try {
			expect((await out).equals(big)).toBe(true);
			expect(catFileCount()).toBe(0);
			expect((await readBlob(fx.path, `${commit}:dir/b.txt`)).toString()).toBe(
				"bee\n",
			);
			// Its own cat-file, which has exited: no process kept up.
			expect(spawns.shapes).toEqual(["git cat-file --batch"]);
			expect(catFileCount()).toBe(0);
		} finally {
			spawns.stop();
			resume();
		}
		await readBlob(fx.path, `${commit}:a.txt`);
		expect(catFileCount()).toBe(1);
	});

	it("a pause never fails the reads queued on the clone's process, however many or slow", async () => {
		await readBlob(fx.path, `${commit}:a.txt`);
		// A burst of big reads queued just before the pause.
		const out = Array.from({ length: 40 }, () =>
			readBlob(fx.path, `${commit}:big.bin`),
		);
		// On the clone's process, not reads of their own.
		expect(catFileCount()).toBe(1);
		const resume = await pauseCatFile(fx.path);
		try {
			for (const blob of await Promise.all(out)) {
				expect(blob.equals(big)).toBe(true);
			}
			expect(catFileCount()).toBe(0);
		} finally {
			resume();
		}
	});

	it("closes its process once idle", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			await readBlob(fx.path, `${commit}:a.txt`);
			expect(catFileCount()).toBe(1);
			vi.advanceTimersByTime(IDLE_MS - 1);
			expect(catFileCount()).toBe(1);
			vi.advanceTimersByTime(1);
			expect(catFileCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
