import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
	testGitEnv,
} from "../../test/git-fixture";
import { ensureCommit } from "./clone";

// Every git call ensureCommit makes, and a gate a fetch waits at.
const calls = vi.hoisted(() => ({
	log: [] as string[][],
	/** What each git call got on stdin. */
	inputs: [] as string[],
	gate: null as Promise<void> | null,
	gated: null as (() => void) | null,
	/** The next fetch fails like this without running. */
	failNext: null as string | null,
}));
vi.mock("./git", async (original) => {
	const real = await original<typeof import("./git")>();
	const wrap =
		<F extends (repo: string, args: string[], ...rest: never[]) => unknown>(
			f: F,
		) =>
		async (repo: string, args: string[], ...rest: never[]) => {
			calls.log.push(args);
			const opts = rest[0] as { input?: string } | undefined;
			if (opts?.input) calls.inputs.push(opts.input);
			if (args.includes("fetch") && calls.gate) {
				calls.gated?.();
				await calls.gate;
			}
			if (args.includes("fetch") && calls.failNext !== null) {
				const stderr = calls.failNext;
				calls.failNext = null;
				return { code: 128, stdout: Buffer.alloc(0), stderr };
			}
			return f(repo, args, ...rest);
		};
	return {
		...real,
		runGit: wrap(real.runGit),
		runGitFull: wrap(real.runGitFull),
	};
});

// Real git: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: testGitEnv(),
	}).trim();

const fetches = () => calls.log.filter((args) => args.includes("fetch"));

/** Holds every fetch until the returned release; `reached` once one waits. */
const holdFetches = () => {
	let release = () => {};
	let reached = () => {};
	const waiting = new Promise<void>((r) => {
		reached = r;
	});
	calls.gate = new Promise<void>((r) => {
		release = r;
	});
	calls.gated = reached;
	return {
		waiting,
		release: () => {
			calls.gate = null;
			release();
		},
	};
};

describe("ensureCommit: commits a force-push dropped, fetched together", () => {
	let tmp: string;
	let origin: GitFixture;
	let clone: string;
	/** Commits only origin has (kept by GitHub, served by OID). */
	let dropped: string[];
	let kept: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "crb-commit-fetch-"));
		origin = createGitFixture([{ message: "c0", files: { "a.txt": "a\n" } }]);
		kept = origin.shas[0] ?? "";
		clone = join(tmp, "clone.git");
		git(tmp, "clone", "--quiet", "--bare", origin.path, clone);
		// Five commits made after the clone, reachable only by OID.
		dropped = [];
		for (let i = 1; i <= 5; i++) {
			const oid = git(
				origin.path,
				"commit-tree",
				`${kept}^{tree}`,
				"-p",
				kept,
				"-m",
				`dropped ${i}`,
			);
			git(origin.path, "update-ref", `refs/keep/${i}`, oid);
			dropped.push(oid);
		}
		git(origin.path, "config", "uploadpack.allowAnySHA1InWant", "true");
		calls.log.length = 0;
		calls.inputs.length = 0;
		calls.gate = null;
		calls.gated = null;
		calls.failNext = null;
	});

	afterEach(() => {
		calls.gate = null;
		origin.cleanup();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("fetches every missing commit asked for together in one git fetch", async () => {
		const answers = await Promise.all(
			[kept, ...dropped].map((oid) => ensureCommit(clone, oid)),
		);
		expect(answers).toEqual([true, true, true, true, true, true]);
		expect(fetches()).toHaveLength(1);
		for (const oid of dropped) expect(fetches()[0]).toContain(oid);
		expect(fetches()[0]).not.toContain(kept);
	});

	it("costs no fetch when the commits are there", async () => {
		await Promise.all(dropped.map((oid) => ensureCommit(clone, oid)));
		calls.log.length = 0;
		const answers = await Promise.all(
			[kept, ...dropped].map((oid) => ensureCommit(clone, oid)),
		);
		expect(answers.every(Boolean)).toBe(true);
		expect(fetches()).toHaveLength(0);
		// One presence check for all of them.
		expect(calls.log).toHaveLength(1);
	});

	it("one commit GitHub doesn't have fails only itself", async () => {
		const unknown = "1".repeat(40);
		const [a = "", b = "", c = ""] = dropped;
		const answers = await Promise.all(
			[a, unknown, b, c].map((oid) => ensureCommit(clone, oid)),
		);
		expect(answers).toEqual([true, false, true, true]);
		// The batch, then the batch without the commit git named.
		expect(fetches()).toHaveLength(2);
		expect(fetches()[1]).not.toContain(unknown);
	});

	it("a batch failing without naming a commit falls back to one fetch each", async () => {
		const [a = "", b = "", c = ""] = dropped;
		calls.failNext = "fatal: unable to access: Could not resolve host";
		const answers = await Promise.all(
			[a, b, c].map((oid) => ensureCommit(clone, oid)),
		);
		expect(answers).toEqual([true, true, true]);
		const wanted = fetches().map((args) =>
			args.slice(args.indexOf("origin") + 1),
		);
		expect(wanted).toEqual([[a, b, c], [a], [b], [c]]);
	});

	it("a commit that isn't one (a blob) is false; the others still come", async () => {
		const blob = git(origin.path, "rev-parse", `${kept}:a.txt`);
		const [a = ""] = dropped;
		const answers = await Promise.all(
			[blob, a].map((oid) => ensureCommit(clone, oid)),
		);
		expect(answers).toEqual([false, true]);
	});

	it("asks made while a fetch runs join one next fetch, not one each", async () => {
		const [first = "", ...rest] = dropped;
		const held = holdFetches();
		const firstAnswer = ensureCommit(clone, first);
		await held.waiting;
		// Asked while the first fetch is under way.
		const restAnswers = Promise.all(
			rest.map((oid) => ensureCommit(clone, oid)),
		);
		const again = ensureCommit(clone, first);
		held.release();
		expect(await firstAnswer).toBe(true);
		expect(await again).toBe(true);
		expect(await restAnswers).toEqual([true, true, true, true]);
		expect(fetches()).toHaveLength(2);
		expect(fetches()[0]).toContain(first);
		for (const oid of rest) expect(fetches()[1]).toContain(oid);
		// The first commit wasn't fetched again.
		expect(fetches()[1]).not.toContain(first);
	});

	it("stops when its signal does: false, and nothing fetched", async () => {
		const [a = "", b = "", c = ""] = dropped;
		const held = holdFetches();
		const stop = new AbortController();
		const answers = Promise.all(
			[a, b].map((oid) => ensureCommit(clone, oid, stop.signal)),
		);
		await held.waiting;
		stop.abort();
		expect(await answers).toEqual([false, false]);
		held.release();
		// A later ask runs once the stopped batch is over: by then its
		// fetch, released after the stop, had its chance and never ran.
		expect(await ensureCommit(clone, c)).toBe(true);
		expect(() => git(clone, "cat-file", "-e", `${a}^{commit}`)).toThrow();
		expect(() => git(clone, "cat-file", "-e", `${b}^{commit}`)).toThrow();
	});

	it("one ask stopping doesn't stop another's fetch", async () => {
		const [a = "", b = ""] = dropped;
		const held = holdFetches();
		const stop = new AbortController();
		const stopped = ensureCommit(clone, a, stop.signal);
		const other = ensureCommit(clone, b);
		await held.waiting;
		stop.abort();
		expect(await stopped).toBe(false);
		held.release();
		expect(await other).toBe(true);
	});

	it("a session closing stops the fetch even when some of its commits were there", async () => {
		const [a = "", c = ""] = dropped;
		const held = holdFetches();
		const stop = new AbortController();
		const present = ensureCommit(clone, kept, stop.signal);
		const missing = ensureCommit(clone, a, stop.signal);
		await held.waiting;
		expect(await present).toBe(true);
		stop.abort();
		expect(await missing).toBe(false);
		held.release();
		// Runs once the stopped batch is over: its fetch never ran.
		expect(await ensureCommit(clone, c)).toBe(true);
		expect(() => git(clone, "cat-file", "-e", `${a}^{commit}`)).toThrow();
	});

	it("asks stopped before their batch ran don't fail the asks that come after", async () => {
		const [a = "", b = "", c = ""] = dropped;
		const held = holdFetches();
		const running = ensureCommit(clone, a);
		await held.waiting;
		// Queued behind the running fetch, then stopped (its session closed).
		const stop = new AbortController();
		const stopped = ensureCommit(clone, b, stop.signal);
		stop.abort();
		expect(await stopped).toBe(false);
		// Another session's ask, into the same next batch.
		const later = ensureCommit(clone, c);
		held.release();
		expect(await running).toBe(true);
		expect(await later).toBe(true);
	});

	it("refuses what isn't a full commit id before any git runs", async () => {
		const [a = ""] = dropped;
		const bad = [
			"--upload-pack=touch pwned",
			"HEAD",
			"refs/heads/main",
			a.slice(0, 12),
			`${a} `,
			a.toUpperCase(),
			`${a}\n${kept}`,
		];
		const answers = await Promise.all(
			bad.map((oid) => ensureCommit(clone, oid)),
		);
		expect(answers.every((ok) => ok === false)).toBe(true);
		expect(calls.log).toEqual([]);
		// Mixed into a batch with good ones: they still come, and no bad one
		// reaches git's argv or stdin.
		const mixed = await Promise.all(
			[a, ...bad].map((oid) => ensureCommit(clone, oid)),
		);
		expect(mixed).toEqual([true, ...bad.map(() => false)]);
		for (const args of calls.log) {
			for (const b of bad) expect(args).not.toContain(b);
		}
		expect(calls.inputs.length).toBeGreaterThan(0);
		for (const input of calls.inputs) expect(input).toBe(`${a}^{commit}\n`);
	});

	it("reads the commit git names in any wording, and fetches the rest again", async () => {
		const [a = "", b = ""] = dropped;
		const unknown = "2".repeat(40);
		// A localized message still carries the full id.
		calls.failNext = `fatal: Fehler am anderen Ende: upload-pack: nicht unsere Referenz ${unknown}\n`;
		const answers = await Promise.all(
			[a, unknown, b].map((oid) => ensureCommit(clone, oid)),
		);
		expect(answers).toEqual([true, false, true]);
		const wanted = fetches().map((args) =>
			args.slice(args.indexOf("origin") + 1),
		);
		expect(wanted).toEqual([
			[a, unknown, b],
			[a, b],
		]);
	});
});
