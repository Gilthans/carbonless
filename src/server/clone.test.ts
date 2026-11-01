import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FAKE_GH_DIR,
	type Scenario,
	writeScenario,
} from "../../test/fake-gh/scenario";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
	testGitEnv,
} from "../../test/git-fixture";
import { settleGh } from "../../test/settle-gh";
import {
	clonePath,
	ensureClone,
	ensureRepoInit,
	fetchPr,
	withRepoLock,
} from "./clone";
import { GhError, type PrMeta } from "./gh";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: testGitEnv(),
	}).trim();

/** A config value; "" when unset. */
const configOf = (path: string, key: string) =>
	spawnSync("git", ["config", "--get", key], {
		cwd: path,
		encoding: "utf8",
		env: testGitEnv(),
	}).stdout.trim();

/** Every ref, HEAD and the working tree status: what fetching must not change. */
const repoState = (path: string) =>
	[
		git(path, "for-each-ref", "--format=%(refname) %(objectname)"),
		git(path, "symbolic-ref", "HEAD"),
		git(path, "rev-parse", "HEAD"),
		git(path, "status", "--porcelain"),
	].join("\n");

describe("private clone", () => {
	let tmp: string;
	let fixture: GitFixture;
	let scenarioPath: string;
	let shas: { branchPoint: string; head: string; base: string };
	const saved: Record<string, string | undefined> = {};
	const setEnv = (vars: Record<string, string>) => {
		for (const [k, v] of Object.entries(vars)) {
			if (!(k in saved)) saved[k] = process.env[k];
			process.env[k] = v;
		}
	};
	const ghLog = () => {
		const path = join(tmp, "gh.log");
		return existsSync(path) ? readFileSync(path, "utf8") : "";
	};
	const scenario = (over: Partial<Scenario> = {}) => {
		scenarioPath = writeScenario(tmp, {
			repoPath: fixture.path,
			user: { login: "octo" },
			prs: {},
			...over,
		});
		setEnv({ CRB_FAKE_GH: scenarioPath });
	};
	const meta = (over: Partial<PrMeta> = {}): PrMeta => ({
		owner: "Acme",
		repo: "Widget",
		number: 7,
		url: "https://github.com/acme/widget/pull/7",
		title: "t",
		baseBranch: "release/v1",
		headBranch: "deleted-branch",
		headRepo: "acme/widget",
		headOid: shas.head,
		state: "OPEN",
		...over,
	});

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "crb-clone-"));
		// c0 - c1 (branch point) - c2 (PR head, reachable only via refs/pull/7/head)
		fixture = createGitFixture([
			{ message: "c0", files: { "a.txt": "a\n" } },
			{ message: "c1", files: { "a.txt": "a\nb\n" } },
			{ message: "c2", files: { "a.txt": "a\nb\nhead\n" } },
		]);
		const [, branchPoint = "", head = ""] = fixture.shas;
		git(fixture.path, "update-ref", "refs/pull/7/head", head);
		git(fixture.path, "branch", "release/v1", branchPoint);
		// main moves on after the PR branched off c1.
		git(fixture.path, "reset", "--quiet", "--hard", branchPoint);
		writeFileSync(join(fixture.path, "b.txt"), "moved\n");
		git(fixture.path, "add", "b.txt");
		git(fixture.path, "commit", "--quiet", "-m", "c3");
		shas = { branchPoint, head, base: git(fixture.path, "rev-parse", "HEAD") };
		setEnv({
			PATH: `${FAKE_GH_DIR}:${process.env.PATH ?? ""}`,
			XDG_CACHE_HOME: join(tmp, "cache"),
			CRB_FAKE_GH_LOG: join(tmp, "gh.log"),
		});
		scenario();
	});

	afterEach(async () => {
		try {
			await settleGh(process.env.CRB_FAKE_GH);
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			for (const k of Object.keys(saved)) delete saved[k];
			fixture.cleanup();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("puts clones under XDG_CACHE_HOME, owner and repo lowercased", () => {
		expect(clonePath("Acme", "Wid.get")).toBe(
			join(tmp, "cache", "carbonless", "repos", "acme", "wid.get.git"),
		);
	});

	it("falls back to ~/.cache when XDG_CACHE_HOME is unset or relative", () => {
		setEnv({ HOME: join(tmp, "home"), XDG_CACHE_HOME: "relative/dir" });
		const expected = join(tmp, "home", ".cache", "carbonless", "repos");
		expect(clonePath("a", "b")).toBe(join(expected, "a", "b.git"));
		delete process.env.XDG_CACHE_HOME;
		expect(clonePath("a", "b")).toBe(join(expected, "a", "b.git"));
	});

	it.each([
		["a/b", "c"],
		["a", "b/c"],
		["a", "b\\c"],
		["..", "c"],
		["a", ".."],
		["a", "."],
		["", "c"],
	])("refuses owner %j repo %j as path segments", (owner, repo) => {
		expect(() => clonePath(owner, repo)).toThrow();
	});

	it("clones bare into the cache dir once", async () => {
		const path = await ensureClone("Acme", "Widget");
		expect(path).toBe(clonePath("acme", "widget"));
		expect(git(path, "rev-parse", "--is-bare-repository")).toBe("true");
		const inode = statSync(join(path, "HEAD")).ino;
		expect(await ensureClone("acme", "widget")).toBe(path);
		expect(statSync(join(path, "HEAD")).ino).toBe(inode);
		expect(ghLog().match(/^repo clone /gm)).toHaveLength(1);
		expect(ghLog()).toContain(
			`repo clone Acme/Widget ${path}.partial -- --bare --quiet`,
		);
		expect(existsSync(`${path}.partial`)).toBe(false);
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	it("ensureRepoInit makes an empty bare repo without asking GitHub", async () => {
		const path = await ensureRepoInit("Acme", "Widget");
		expect(path).toBe(clonePath("acme", "widget"));
		expect(git(path, "rev-parse", "--is-bare-repository")).toBe("true");
		expect(git(path, "for-each-ref")).toBe("");
		expect(git(path, "count-objects", "-v")).toMatch(/^count: 0$/m);
		expect(git(path, "config", "--get", "gc.auto")).toBe("0");
		expect(ghLog()).toBe("");
		// Again: nothing changes.
		const inode = statSync(join(path, "HEAD")).ino;
		expect(await ensureRepoInit("acme", "widget")).toBe(path);
		expect(statSync(join(path, "HEAD")).ino).toBe(inode);
	});

	it("ensureClone fills an init-only repo, keeping its crb refs", async () => {
		const path = await ensureRepoInit("acme", "widget");
		const empty = git(path, "hash-object", "-w", "-t", "tree", "/dev/null");
		const commit = execFileSync("git", ["commit-tree", empty, "-m", "crb: x"], {
			cwd: path,
			encoding: "utf8",
			env: testGitEnv({
				GIT_AUTHOR_NAME: "dan",
				GIT_AUTHOR_EMAIL: "dan@crb",
				GIT_COMMITTER_NAME: "crb",
				GIT_COMMITTER_EMAIL: "crb@crb",
			}),
		}).trim();
		git(path, "update-ref", "refs/crb/inbox/dan", commit);
		let cloned = false;
		expect(await ensureClone("acme", "widget", () => (cloned = true))).toBe(
			path,
		);
		expect(cloned).toBe(true);
		expect(git(path, "rev-parse", "refs/crb/inbox/dan")).toBe(commit);
		expect(git(path, "rev-parse", "main")).toBe(shas.base);
		expect(git(path, "symbolic-ref", "HEAD")).toBe(
			git(fixture.path, "symbolic-ref", "HEAD"),
		);
		expect(git(path, "config", "--get", "remote.origin.url")).toBe(
			fixture.path,
		);
		expect(configOf(path, "crb.initOnly")).toBe("");
		expect(existsSync(`${path}.partial`)).toBe(false);
		// A complete clone now: no second clone, and the PR fetches as usual.
		expect(await ensureClone("acme", "widget")).toBe(path);
		expect(ghLog().match(/^repo clone /gm)).toHaveLength(1);
		const fetched = await fetchPr(path, meta());
		expect(fetched.head).toBe(shas.head);
		expect(git(path, "rev-parse", "refs/crb/inbox/dan")).toBe(commit);
	});

	it("ensureRepoInit doesn't wait for the lock when the repo exists (a clone running)", async () => {
		const path = await ensureRepoInit("acme", "widget");
		let release = () => {};
		const held = withRepoLock(
			path,
			() => new Promise<void>((r) => (release = r)),
		);
		await new Promise((r) => setTimeout(r, 50));
		const started = Date.now();
		expect(await ensureRepoInit("acme", "widget")).toBe(path);
		expect(Date.now() - started).toBeLessThan(1000);
		release();
		await held;
	});

	it("ensureRepoInit leaves an existing clone alone", async () => {
		const path = await ensureClone("acme", "widget");
		const refs = () =>
			git(path, "for-each-ref", "--format=%(refname) %(objectname)");
		const before = refs();
		await ensureRepoInit("acme", "widget");
		expect(refs()).toBe(before);
		expect(configOf(path, "crb.initOnly")).toBe("");
	});

	it("serializes concurrent opens with the lock", async () => {
		const [a, b] = await Promise.all([
			ensureClone("acme", "widget"),
			ensureClone("acme", "widget"),
		]);
		expect(a).toBe(b);
		expect(ghLog().match(/^repo clone /gm)).toHaveLength(1);
	});

	it("leaves no clone behind when cloning fails, and recovers a half clone", async () => {
		scenario({ repoPath: join(tmp, "does-not-exist") });
		await expect(ensureClone("acme", "widget")).rejects.toThrow();
		const path = clonePath("acme", "widget");
		expect(existsSync(path)).toBe(false);
		expect(existsSync(`${path}.lock`)).toBe(false);

		// A crash mid-clone leaves the temporary dir; it never counts as a clone.
		mkdirSync(join(`${path}.partial`, "objects"), { recursive: true });
		scenario();
		await ensureClone("acme", "widget");
		expect(git(path, "rev-parse", "main")).toBe(shas.base);
		expect(existsSync(`${path}.partial`)).toBe(false);
	});

	it("reports a logged out gh", async () => {
		scenario({ loggedOut: true });
		await expect(ensureClone("acme", "widget")).rejects.toThrow(
			"gh is not logged in. Run: gh auth login",
		);
	});

	it("fetches the PR head and computes the merge base", async () => {
		const path = await ensureClone("acme", "widget");
		const r = await fetchPr(path, meta());
		expect(r).toEqual({
			baseTip: shas.branchPoint,
			head: shas.head,
			mergeBase: shas.branchPoint,
		});
		expect(git(path, "rev-parse", "refs/remotes/origin/release/v1")).toBe(
			shas.branchPoint,
		);
		// The head is used by OID only; refs/crb/ is carbonless's own namespace.
		const refs = git(path, "for-each-ref", "--format=%(refname)").split("\n");
		expect(refs.filter((r) => !/^refs\/(heads|remotes|crb)\//.test(r))).toEqual(
			[],
		);
		expect(git(path, "config", "--get", "gc.auto")).toBe("0");
	});

	it("turns off auto gc in clones made before it was", async () => {
		const path = await ensureClone("acme", "widget");
		git(path, "config", "--unset", "gc.auto");
		await ensureClone("acme", "widget");
		expect(git(path, "config", "--get", "gc.auto")).toBe("0");
	});

	it("reports git's fatal line when cloning fails", async () => {
		scenario({
			cloneError:
				"fatal: unable to access 'https://github.com/acme/widget/': Could not resolve host: github.com",
		});
		await expect(ensureClone("acme", "widget")).rejects.toThrow(
			new GhError(
				"fatal: unable to access 'https://github.com/acme/widget/': Could not resolve host: github.com",
			),
		);
	});

	it("works when the base branch moved after the PR branched", async () => {
		const path = await ensureClone("acme", "widget");
		const r = await fetchPr(path, meta({ baseBranch: "main" }));
		expect(r).toEqual({
			baseTip: shas.base,
			head: shas.head,
			mergeBase: shas.branchPoint,
		});
	});

	it("fetches again on every open, following force-pushes", async () => {
		const path = await ensureClone("acme", "widget");
		await fetchPr(path, meta({ baseBranch: "main" }));
		// main is rewritten to drop c3 and gain c4.
		git(fixture.path, "reset", "--quiet", "--hard", shas.branchPoint);
		git(fixture.path, "commit", "--quiet", "--allow-empty", "-m", "c4");
		const c4 = git(fixture.path, "rev-parse", "HEAD");
		const r = await fetchPr(path, meta({ baseBranch: "main" }));
		expect(r.baseTip).toBe(c4);
		expect(ghLog().match(/^repo clone /gm)).toHaveLength(1);
	});

	it("fails clearly when the PR head is not on GitHub", async () => {
		const path = await ensureClone("acme", "widget");
		await expect(
			fetchPr(path, meta({ headOid: "1".repeat(40) })),
		).rejects.toThrow(/PR head 1{40} is not on GitHub/);
		await expect(fetchPr(path, meta({ headOid: "HEAD" }))).rejects.toThrow(
			/unexpected PR head/,
		);
	});

	it("as of a cutoff: main's tip then, and a head the PR has force-pushed away, fetched by OID", async () => {
		const path = await ensureClone("acme", "widget");
		const cutoff = new Date(Date.now() + 1000).toISOString();
		// After the cutoff: main moves on, and the PR is force-pushed onto c1.
		execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "c4"], {
			cwd: fixture.path,
			env: testGitEnv({
				GIT_AUTHOR_DATE: "2099-01-01T00:00:00Z",
				GIT_COMMITTER_DATE: "2099-01-01T00:00:00Z",
			}),
		});
		const c4 = git(fixture.path, "rev-parse", "HEAD");
		const rewritten = git(
			fixture.path,
			"commit-tree",
			`${shas.branchPoint}^{tree}`,
			"-p",
			shas.branchPoint,
			"-m",
			"rewritten",
		);
		git(fixture.path, "update-ref", "refs/pull/7/head", rewritten);
		// GitHub keeps the old head (and serves it by OID).
		git(fixture.path, "update-ref", "refs/keep/old", shas.head);
		git(fixture.path, "config", "uploadpack.allowAnySHA1InWant", "true");
		const r = await fetchPr(
			path,
			meta({ baseBranch: "main", headOid: shas.head }),
			{ asOf: cutoff },
		);
		expect(git(path, "rev-parse", "refs/remotes/origin/main")).toBe(c4);
		expect(r).toEqual({
			baseTip: shas.base,
			head: shas.head,
			mergeBase: shas.branchPoint,
		});
	});

	it("as of a cutoff before the base branch existed: fails clearly", async () => {
		const path = await ensureClone("acme", "widget");
		await expect(
			fetchPr(path, meta({ baseBranch: "main" }), {
				asOf: "2000-01-01T00:00:00Z",
			}),
		).rejects.toThrow(/no commit at or before 2000-01-01T00:00:00Z/);
	});

	it("as of a cutoff: fails clearly when the head can't be fetched", async () => {
		const path = await ensureClone("acme", "widget");
		await expect(
			fetchPr(path, meta({ baseBranch: "main", headOid: "1".repeat(40) }), {
				asOf: new Date().toISOString(),
			}),
		).rejects.toThrow(/as of .* could not be fetched/);
	});

	it("rejects a base branch name that is not a valid ref", async () => {
		const path = await ensureClone("acme", "widget");
		await expect(
			fetchPr(path, meta({ baseBranch: "main:refs/heads/x" })),
		).rejects.toThrow(/base branch/);
	});

	it("never writes outside the cache dir", async () => {
		const before = repoState(fixture.path);
		const path = await ensureClone("acme", "widget");
		await fetchPr(path, meta());
		await fetchPr(path, meta({ baseBranch: "main" }));
		expect(repoState(fixture.path)).toBe(before);
		const outside = execFileSync(
			"find",
			[tmp, "-mindepth", "1", "-newer", scenarioPath],
			{
				encoding: "utf8",
			},
		)
			.split("\n")
			.filter(
				(p) =>
					p && !p.startsWith(join(tmp, "cache")) && p !== join(tmp, "gh.log"),
			);
		expect(outside).toEqual([]);
	});
});

describe("withRepoLock", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "crb-lock-"));
	});
	afterEach(() => rmSync(tmp, { recursive: true, force: true }));

	it("runs one holder at a time and releases on failure", async () => {
		const path = join(tmp, "nested", "repo.git");
		const order: string[] = [];
		const hold = (name: string, ms: number, fail = false) =>
			withRepoLock(path, async () => {
				order.push(`${name}+`);
				await new Promise((r) => setTimeout(r, ms));
				order.push(`${name}-`);
				if (fail) throw new Error(`${name} failed`);
				return name;
			});
		// b asks only once a holds the lock, so the order is deterministic.
		const a = hold("a", 150, true);
		await vi.waitFor(() => expect(order).toContain("a+"));
		const results = await Promise.allSettled([a, hold("b", 10)]);
		expect(order).toEqual(["a+", "a-", "b+", "b-"]);
		expect(results[0]).toMatchObject({ status: "rejected" });
		expect(results[1]).toEqual({ status: "fulfilled", value: "b" });
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	it("removes a lock older than 10 minutes as stale", async () => {
		const path = join(tmp, "repo.git");
		writeFileSync(`${path}.lock`, "12345\n");
		const old = new Date(Date.now() - 11 * 60 * 1000);
		utimesSync(`${path}.lock`, old, old);
		// No time to wait: only a lock judged stale at the first look is taken.
		expect(
			await withRepoLock(path, async () => "got it", { timeoutMs: 0 }),
		).toBe("got it");
	});

	it("takes a fresh lock at once when its process is gone", async () => {
		const path = join(tmp, "repo.git");
		const dead = spawnSync(process.execPath, ["-e", ""]).pid;
		writeFileSync(`${path}.lock`, `${hostname()} ${dead} token\n`);
		expect(
			await withRepoLock(path, async () => "got it", { timeoutMs: 0 }),
		).toBe("got it");
	});

	it("keeps a long-running holder's lock fresh", {
		timeout: 15_000,
	}, async () => {
		const path = join(tmp, "repo.git");
		const order: string[] = [];
		// The holder outlives staleMs several times over; a heartbeat every
		// 100 ms leaves plenty of slack for a loaded machine's timer delays.
		const opts = { staleMs: 2_500, heartbeatMs: 100 };
		const slow = withRepoLock(
			path,
			async () => {
				order.push("slow+");
				await new Promise((r) => setTimeout(r, 4_000));
				order.push("slow-");
			},
			opts,
		);
		await vi.waitFor(() => expect(order).toContain("slow+"));
		await withRepoLock(path, async () => order.push("next"), opts);
		await slow;
		expect(order).toEqual(["slow+", "slow-", "next"]);
	});

	it("does not release a lock that is no longer its own", async () => {
		const path = join(tmp, "repo.git");
		await withRepoLock(path, async () => {
			writeFileSync(`${path}.lock`, "otherhost 1 theirs\n");
		});
		expect(readFileSync(`${path}.lock`, "utf8")).toBe("otherhost 1 theirs\n");
	});

	it("waits for a fresh lock held by someone else", async () => {
		const path = join(tmp, "repo.git");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(`${path}.lock`, `${hostname()} ${process.pid} live\n`);
		setTimeout(() => rmSync(`${path}.lock`), 300);
		const started = Date.now();
		await withRepoLock(path, async () => {});
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
	});
});
