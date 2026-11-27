import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildApp } from "../src/server/app";
import { clearSnapshotCaches } from "../src/server/diff/snapshot";
import { ghRunning } from "../src/server/gh";
import { gitChildren } from "../src/server/git";
import { HomeService } from "../src/server/home/homeService";
import { SessionRegistry } from "../src/server/registry";
import { onSpawn, type SpawnNote } from "../src/server/spawnWatch";
import type { ReviewView, SessionInfo } from "../src/shared/types";
import { prView, reviewThread, threadComment } from "./fake-gh/scenario";
import { testGitEnv } from "./git-fixture";
import { createPrFixture, type PrFixture } from "./pr-fixture";

/*
 * Counts the git and gh processes behind each request of a review's first
 * open and reads (CAR-320): on Windows each costs ~90 ms to start, so the
 * count is what a page's wait there grows with. `countSpawns` listens to
 * every spawn (src/server/spawnWatch.ts); `measureOpen` drives an in-process
 * server through the page's first requests on a synthetic PR of a given
 * size and returns each step's processes. `pnpm spawn-counts` prints the
 * table; src/server/spawnCounts.test.ts checks that the counts don't grow
 * with the PR.
 */

/** A spawn's shape: its tool and subcommand, plus what tells calls apart (`--batch`, `--stdin`). */
function shapeOf(note: SpawnNote): string {
	const { args } = note;
	if (note.tool === "gh") return note.name;
	const flags = args.filter((a) =>
		["--batch", "--batch-check", "--stdin", "--verify"].includes(a),
	);
	return [note.name, ...flags].join(" ");
}

/** Every spawn from now until `stop()`, as shapes. */
export function countSpawns(): {
	shapes: string[];
	calls: string[];
	stop: () => void;
} {
	const shapes: string[] = [];
	const calls: string[] = [];
	const stop = onSpawn((note) => {
		shapes.push(shapeOf(note));
		calls.push(`${note.tool} ${note.args.join(" ")}`.slice(0, 300));
	});
	return { shapes, calls, stop };
}

/** Shapes counted: `{ "git rev-parse": 3, ... }`. */
function tally(shapes: readonly string[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const s of shapes) out[s] = (out[s] ?? 0) + 1;
	return out;
}

/** Waits until no git or gh this process started is running (background work after a request). */
async function settleSpawns(quietMs = 60, maxMs = 20_000): Promise<void> {
	let quietSince = Date.now();
	const end = Date.now() + maxMs;
	while (Date.now() < end) {
		const busy = gitChildren().length > 0 || ghRunning().children.length > 0;
		if (busy) quietSince = Date.now();
		else if (Date.now() - quietSince >= quietMs) return;
		await new Promise((r) => setTimeout(r, 10));
	}
}

export interface ScaleSize {
	/** Files the PR changes (each in two places). */
	files: number;
	/** Review threads, a third on a commit force-pushed away. */
	threads: number;
}

const lines = (n: number, tag: string) =>
	Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}`);

/** File `i`'s text with lines (1-based) replaced by `<line> <tag>`. */
const fileText = (i: number, changes: Record<number, string>) =>
	`${lines(40, `f${i}`)
		.map((l, j) => (changes[j + 1] ? `${l} ${changes[j + 1]}` : l))
		.join("\n")}\n`;

const fileName = (i: number) => `src/mod${i}/file${i}.ts`;

interface ScalePr {
	pr: PrFixture;
	/** Heads of patch sets 1, 2 and 3 (1 force-pushed away). */
	heads: [string, string, string];
	pointAt: (head: string, withThreads?: boolean) => void;
	cleanup: () => Promise<void>;
}

/**
 * A PR of `size.files` files, pushed three times: PS1, a force-push that
 * reworks it (PS1's commit dropped), then a commit on top. `threads` review
 * threads spread over the files: a third written on the dropped commit, a
 * third on PS2's, a third on the head.
 */
function createScalePr(size: ScaleSize): ScalePr {
	const base: Record<string, string> = {};
	const ps1: Record<string, string> = {};
	for (let i = 0; i < size.files; i++) {
		base[fileName(i)] = fileText(i, {});
		ps1[fileName(i)] = fileText(i, { 5: "one", 30: "one" });
	}
	const pr = createPrFixture({ base: { files: base }, pr: { files: ps1 } });
	const h1 = pr.head();
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: pr.repo.path,
			encoding: "utf8",
			env: testGitEnv(),
		}).trim();
	// PS2: a force-push (h1's commit is dropped), reworking every file.
	const work = mkdtempSync(join(tmpdir(), "crb-scale-"));
	const commitOn = (
		parent: string,
		files: Record<string, string>,
		message: string,
	) => {
		git("worktree", "add", "--quiet", "--detach", join(work, "w"), parent);
		const w = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: join(work, "w"),
				encoding: "utf8",
				env: testGitEnv(),
			}).trim();
		for (const [name, text] of Object.entries(files)) {
			const path = join(work, "w", name);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text);
		}
		w("add", "--all");
		w("commit", "--quiet", "-m", message);
		const sha = w("rev-parse", "HEAD");
		git("worktree", "remove", "--force", join(work, "w"));
		return sha;
	};
	const ps2: Record<string, string> = {};
	for (let i = 0; i < size.files; i++) {
		ps2[fileName(i)] = fileText(i, { 5: "two", 30: "one", 20: "two" });
	}
	const h2 = commitOn(pr.mergeBase, { "a.txt": "reworked\n", ...ps2 }, "PS2");
	const ps3: Record<string, string> = {};
	for (let i = 0; i < size.files; i += 4) {
		ps3[fileName(i)] = fileText(i, { 5: "two", 30: "three", 20: "two" });
	}
	const h3 = commitOn(h2, ps3, "PS3");
	rmSync(work, { recursive: true, force: true });
	const heads: [string, string, string] = [h1, h2, h3];

	// Written after the commits they sit on, as on GitHub.
	const at = new Date(Date.now() + 1000).toISOString();
	const threads = Array.from({ length: size.threads }, (_, t) => {
		const commit = heads[t % 3] as string;
		return reviewThread(
			{
				path: fileName(t % size.files),
				line: 30,
				originalLine: 30,
				isOutdated: t % 3 === 0,
				diffSide: "RIGHT",
			},
			[
				threadComment({
					login: "rev1",
					text: `Thread ${t}?`,
					commit,
					createdAt: at,
				}),
				threadComment({
					login: "octo-author",
					text: `Answer ${t}`,
					commit,
					createdAt: at,
				}),
			],
		);
	});
	/** Points the PR at `head` (as GitHub would after a push), with `withThreads` its threads. */
	const pointAt = (head: string, withThreads = false) => {
		git("update-ref", "refs/pull/12/head", head);
		pr.scenario({
			prs: {
				12: {
					view: prView({ headRefOid: head, baseRefName: "main" }),
					graphql: {
						reviewThreads: withThreads ? threads : [],
						reviews: [],
					},
				},
			},
		});
	};
	return { pr, heads, pointAt, cleanup: () => pr.cleanup() };
}

/** One step of the page's first reads, and the processes behind it (with the work it started). */
export interface StepCount {
	step: string;
	shapes: string[];
	/** Each process's whole command line (cut at 300 characters). */
	calls: string[];
}

/** A server (registry, app and Home) on the current XDG dirs. */
async function startServer() {
	const registry = new SessionRegistry();
	const config = { views: [], refresh: { minutes: 5 } };
	const home = new HomeService({
		config: {
			read: async () => ({ config, problems: [] }),
			update: async () => config,
		},
	});
	const app = await buildApp(registry, { accessKey: null, home });
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	const host = `127.0.0.1:${address.port}`;
	const call = async (
		method: "GET" | "POST",
		url: string,
		payload?: object,
	): Promise<unknown> => {
		const res = await app.inject({ method, url, headers: { host }, payload });
		if (res.statusCode !== 200) {
			throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
		}
		return res.json();
	};
	const stop = async () => {
		await app.close();
		await registry.closeAll();
	};
	return { app, call, stop };
}

type Server = Awaited<ReturnType<typeof startServer>>;

/** Marks the first cluster of every other file reviewed in `view` (a patch set at its head). */
async function markSome(server: Server, id: string, view: ReviewView) {
	const changes = view.files
		.filter((_, i) => i % 2 === 0)
		.flatMap((f) => f.clusters.slice(0, 1))
		.map((c) => ({ key: c.key, state: "reviewed" as const }));
	await server.call("POST", `/api/r/${id}/review/states`, {
		revision: view.revision,
		changes,
	});
}

/**
 * Drives the page's first requests (in its order) and counts the processes
 * behind each, settling the work each one starts before the next.
 */
async function pageReads(
	server: Server,
	fx: ScalePr,
	prArg: string,
): Promise<StepCount[]> {
	const steps: StepCount[] = [];
	const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
		const counter = countSpawns();
		try {
			const out = await run();
			await settleSpawns();
			return out;
		} finally {
			await counter.stop();
			steps.push({ step: name, shapes: counter.shapes, calls: counter.calls });
		}
	};
	const { id } = (await step("open (POST /api/reviews)", () =>
		server.call("POST", "/api/reviews", { pr: prArg }),
	)) as { id: string };
	const r = (path: string) => `/api/r/${id}${path}`;
	const info = (await step("session", () =>
		server.call("GET", r("/session")),
	)) as SessionInfo;
	const overview = (await step("overview", () =>
		server.call("GET", r("/overview")),
	)) as { readId: string };
	const read = overview.readId;
	const view = (await step("review (file list)", () =>
		server.call("GET", r("/review")),
	)) as ReviewView;
	for (const stage of ["summary", "first", "firstCode", "full"]) {
		await step(`threads ${stage}`, () =>
			server.call("GET", r(`/threads?read=${read}&stage=${stage}`)),
		);
	}
	await step("head", () => server.call("GET", r("/head")));
	await step("first file's hunks", () =>
		server.call("GET", r(`/files/0/hunks?revision=${view.revision}`)),
	);
	const next = view.files
		.slice(1, 11)
		.map((_, i) => i + 1)
		.join(",");
	await step("next 10 files' hunks", () =>
		server.call(
			"GET",
			r(`/files/hunks?revision=${view.revision}&indexes=${next}`),
		),
	);
	await step("verdict", () => server.call("GET", r("/verdict")));
	await step("timeline", () => server.call("GET", r(`/timeline?read=${read}`)));
	const head = fx.heads[2];
	await step("placements", async () => {
		for (;;) {
			const a = (await server.call(
				"GET",
				r(`/placements?read=${read}&head=${head}`),
			)) as { pending?: boolean };
			if (!a.pending) return a;
			await new Promise((r) => setTimeout(r, 20));
		}
	});
	const last = info.patchsets.at(-1)?.number;
	if (last !== undefined && last > 1) {
		const from = last - 1;
		await step("since view (rereview)", async () => {
			for (;;) {
				const a = (await server.call(
					"GET",
					r(`/rereview?from=${from}&to=${last}`),
				)) as { pending?: boolean };
				if (!a.pending) return a;
				await new Promise((r) => setTimeout(r, 20));
			}
		});
		await step("since view's first file", () =>
			server.call(
				"GET",
				r(`/files/0/hunks?revision=${view.revision}&from=${from}`),
			),
		);
	}
	await step("home", () => server.call("GET", "/api/home"));
	return steps;
}

export interface OpenCounts {
	/** A machine's first open of the PR: a new clone, no review data. */
	first: StepCount[];
	/** crb restarted: the clone and a started review (3 patch sets), nothing in memory. */
	restart: StepCount[];
	/** The page reloaded right after. */
	reload: StepCount[];
}

/**
 * The processes behind the page's first reads of a PR of `size`: on a
 * machine's first open, after a restart (with a started review of three
 * patch sets), and on a reload.
 */
export async function measureOpen(
	size: ScaleSize,
	/**
	 * Run before the restart, on the clone and the review's reviewer: e.g.
	 * other started reviews written into the same clone (CAR-324).
	 */
	seed?: (clone: string, slug: string) => void | Promise<void>,
): Promise<OpenCounts> {
	const fx = createScalePr(size);
	const [h1, h2, h3] = fx.heads;
	const cacheA = process.env.XDG_CACHE_HOME as string;
	const stateA = process.env.XDG_STATE_HOME as string;
	const fresh = mkdtempSync(join(tmpdir(), "crb-scale-first-"));
	try {
		// A started review: marks on each of the three patch sets.
		fx.pointAt(h1);
		let server = await startServer();
		const { id } = (await server.call("POST", "/api/reviews", {
			pr: fx.pr.arg,
		})) as { id: string };
		const r = (path: string) => `/api/r/${id}${path}`;
		await markSome(
			server,
			id,
			(await server.call("GET", r("/review"))) as ReviewView,
		);
		for (const head of [h2, h3]) {
			fx.pointAt(head);
			await server.call("GET", r("/head"));
			await server.call("GET", r("/head"));
			await markSome(
				server,
				id,
				(await server.call("GET", r(`/review?head=${head}`))) as ReviewView,
			);
		}
		const made = (await server.call("GET", r("/session"))) as SessionInfo;
		if (made.patchsets.length !== 3) {
			throw new Error(
				`expected 3 patch sets, got ${JSON.stringify(made.patchsets.map((p) => p.head))} (${[h1, h2, h3]})`,
			);
		}
		await settleSpawns();
		await server.stop();
		fx.pointAt(h3, true);
		if (seed) {
			const repos = join(cacheA, "carbonless", "repos");
			const [owner] = readdirSync(repos);
			const repo = readdirSync(join(repos, owner as string)).find((n) =>
				n.endsWith(".git"),
			);
			const clone = join(repos, owner as string, repo as string);
			const progress = execFileSync(
				"git",
				["for-each-ref", "--format=%(refname)", "refs/crb/reviews/"],
				{ cwd: clone, encoding: "utf8", env: testGitEnv() },
			)
				.split("\n")
				.find((l) => l.endsWith("/progress"));
			// refs/crb/reviews/<id>/reviewers/<slug>/progress
			await seed(clone, progress?.split("/")[5] as string);
		}

		// The first open on another machine: a new clone, no review.
		clearSnapshotCaches();
		process.env.XDG_CACHE_HOME = join(fresh, "cache");
		process.env.XDG_STATE_HOME = join(fresh, "state");
		server = await startServer();
		const first = await pageReads(server, fx, fx.pr.arg);
		await server.stop();
		process.env.XDG_CACHE_HOME = cacheA;
		process.env.XDG_STATE_HOME = stateA;

		clearSnapshotCaches();
		server = await startServer();
		const restart = await pageReads(server, fx, fx.pr.arg);
		const reload = await pageReads(server, fx, fx.pr.arg);
		await server.stop();
		return { first, restart, reload };
	} finally {
		process.env.XDG_CACHE_HOME = cacheA;
		process.env.XDG_STATE_HOME = stateA;
		await fx.cleanup();
		rmSync(fresh, { recursive: true, force: true });
	}
}

/** A markdown table of the counts: per step, each column's processes and their shapes. */
export function countTable(
	columns: Record<string, StepCount[]>,
	/** Also each step's command lines, per column. */
	calls = false,
): string {
	const names = Object.keys(columns);
	const rows = [
		...new Set(Object.values(columns).flatMap((c) => c.map((s) => s.step))),
	];
	const out = [
		`| step | ${names.join(" | ")} | shapes (${names.join(" / ")}) |`,
		`|---|${names.map(() => "---:").join("|")}|---|`,
	];
	const totals = names.map(() => 0);
	for (const step of rows) {
		const cells = names.map((n) => columns[n]?.find((s) => s.step === step));
		cells.forEach((c, i) => {
			totals[i] = (totals[i] as number) + (c?.shapes.length ?? 0);
		});
		const shapes = cells
			.map((c) =>
				Object.entries(tally(c?.shapes ?? []))
					.sort((a, b) => b[1] - a[1])
					.map(([k, v]) => `${k} ×${v}`)
					.join(", "),
			)
			.join(" / ");
		out.push(
			`| ${step} | ${cells.map((c) => c?.shapes.length ?? "-").join(" | ")} | ${shapes} |`,
		);
	}
	out.push(`| **total** | ${totals.join(" | ")} | |`);
	if (calls) {
		for (const name of names) {
			out.push("", `### ${name}`);
			for (const step of columns[name] ?? []) {
				out.push("", `${step.step}:`, ...step.calls.map((c) => `    ${c}`));
			}
		}
	}
	return out.join("\n");
}
