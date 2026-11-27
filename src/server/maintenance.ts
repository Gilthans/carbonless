import { readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { pauseCatFile } from "./catFile.js";
import { repoLockLastUsed, withRepoLock } from "./clone.js";
import { GitError, runGit } from "./git.js";
import { cacheDir } from "./paths.js";
import { tracer } from "./trace.js";

/*
 * Clone maintenance (CAR-325). crb's clones run with gc.auto=0, so nothing
 * else ever packs them: every fetch adds a pack, every crb write adds loose
 * objects, and every git in the clone slows with them. Once a day per clone,
 * while it is idle, crb packs the loose objects and rolls small packs
 * together (a geometric repack) and writes a commit-graph. Nothing here ever
 * prunes: PR heads are read by commit ID with no ref
 * (docs/review-data-storage.md, "Clone maintenance"), so an unreachable
 * object is kept, in a pack, as long as the clone lives.
 */

/** Git config key of the clone: when its last maintenance ran (epoch ms). */
export const MAINTAINED_AT = "crb.maintainedAt";

/** At most one run per clone in this long. */
export const MAINTENANCE_EVERY_MS = 24 * 60 * 60_000;

/** A clone whose lock this process used more recently than this is busy. */
export const IDLE_MS = 5 * 60_000;

/** What `git count-objects -v` says. */
export interface ObjectCounts {
	/** Loose objects. */
	loose: number;
	/** Their size on disk, KiB. */
	looseKiB: number;
	/** Pack files. */
	packs: number;
	/** Objects in packs. */
	inPack: number;
	/** Pack size on disk, KiB. */
	packKiB: number;
}

export async function countObjects(path: string): Promise<ObjectCounts> {
	const text = await runGit(path, ["count-objects", "-v"]);
	const field = (name: string) => {
		const match = text.match(new RegExp(`^${name}: (\\d+)$`, "m"));
		return match ? Number(match[1]) : 0;
	};
	return {
		loose: field("count"),
		looseKiB: field("size"),
		packs: field("packs"),
		inPack: field("in-pack"),
		packKiB: field("size-pack"),
	};
}

/** `git version`'s major and minor, read once per process. */
let versionOnce: Promise<[number, number]> | null = null;
const gitVersion = (path: string) => {
	versionOnce ??= runGit(path, ["version"]).then(
		(text) => {
			const match = text.match(/(\d+)\.(\d+)/);
			return match ? [Number(match[1]), Number(match[2])] : [0, 0];
		},
		(error) => {
			// Asked again next time (a git that failed to start under load).
			versionOnce = null;
			throw error;
		},
	);
	return versionOnce;
};

/**
 * The gits one maintenance runs, in order, for this git version. None of
 * them prunes an unreachable object:
 * - `repack --geometric=2 -d` (git 2.32+) packs every loose object, reachable
 *   or not, and rolls the small packs into one so pack sizes double at
 *   least; `-d` deletes only the packs and loose objects it has just copied.
 *   No `-a`/`-A`, so nothing is left out of the new pack.
 * - Older git: `maintenance run --task=loose-objects --task=incremental-repack`
 *   (2.30+), the same without the immediate roll-up (each step finishes on
 *   the next run).
 * - `commit-graph write --reachable --split`: speeds history walks
 *   (merge-base, log); it holds no objects.
 * pack.threads=1 and the low priority keep it gentle on a busy machine.
 */
export function maintenanceCommands([major, minor]: [
	number,
	number,
]): string[][] {
	const geometric = major > 2 || (major === 2 && minor >= 32);
	const pack = geometric
		? [
				"-c",
				"pack.threads=1",
				"repack",
				"--geometric=2",
				"-d",
				"--quiet",
				"--no-write-bitmap-index",
			]
		: [
				"-c",
				"pack.threads=1",
				"maintenance",
				"run",
				"--quiet",
				"--task=loose-objects",
				"--task=incremental-repack",
			];
	return [pack, ["commit-graph", "write", "--reachable", "--split"]];
}

export type MaintenanceResult =
	| {
			ran: true;
			before: ObjectCounts;
			after: ObjectCounts;
			ms: number;
	  }
	| {
			ran: false;
			/**
			 * recent: ran within the day. busy: the clone was in use.
			 * yielded: an open came, or crb stopped, mid-run (tried again on a
			 * later pass). disk: too little free space for the repack's copy.
			 */
			reason: "recent" | "busy" | "yielded" | "disk" | "failed";
			error?: string;
	  };

export interface MaintainOptions {
	/** The time now (epoch ms); tests move it. */
	now?: number;
	/** Runs even if the last run was recent (the idle check still applies). */
	force?: boolean;
	/** Awaited once the lock is held, before any git, with the run's stop signal (tests). */
	gate?: (signal: AbortSignal) => Promise<void>;
	/** These gits instead of maintenanceCommands' (tests: one that hangs). */
	steps?: string[][];
	/** Plans for this git version instead of the installed one's (tests). */
	gitVersion?: [number, number];
	/** Stops the run (crb stopping): its git is killed, nothing recorded. */
	signal?: AbortSignal;
	/** Free bytes on the clone's disk instead of statfs's answer (tests). */
	freeBytes?: (path: string) => Promise<number>;
}

/**
 * Longest a maintenance git may run: a backstop against a hung git holding
 * the clone's lock (a real first run measured under 2 s on a loaded box).
 */
const GIT_BACKSTOP_MS = 30 * 60_000;

const lastRun = async (path: string): Promise<number> => {
	const text = await runGit(path, ["config", "--get", MAINTAINED_AT], {
		allowFailure: true,
	});
	const at = Number(text.trim());
	return Number.isFinite(at) ? at : 0;
};

const record = (path: string) =>
	runGit(path, ["config", MAINTAINED_AT, String(Date.now())], {
		allowFailure: true,
	});

const statfsFree = async (path: string) => {
	const fs = await statfs(path);
	return fs.bavail * fs.bsize;
};

/**
 * One maintenance of the clone at `path`, unless it ran within the day or
 * the clone is busy: this process used its lock within IDLE_MS, or anyone
 * holds it now (an open or a fetch, of this crb or another). It holds the
 * repo lock throughout, so no open or fetch runs beside it, and gives way:
 * an open of this crb that starts waiting for the lock, or `signal`, kills
 * the git under way (safe at any point: git renames a new pack into place
 * before deleting anything) and hands the lock over at once. A run that
 * ends, failed or not, is recorded, so the next is a day later; one that
 * gave way isn't.
 */
export async function maintainClone(
	path: string,
	options: MaintainOptions = {},
): Promise<MaintenanceResult> {
	const now = options.now ?? Date.now();
	const used = repoLockLastUsed(path);
	if (used !== undefined && now - used < IDLE_MS) {
		return { ran: false, reason: "busy" };
	}
	const recent = async () =>
		!options.force && now - (await lastRun(path)) < MAINTENANCE_EVERY_MS;
	if (await recent()) return { ran: false, reason: "recent" };
	if (options.signal?.aborted) return { ran: false, reason: "yielded" };
	const stop = new AbortController();
	const onAbort = () => stop.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	let locked = false;
	try {
		return await withRepoLock(
			path,
			async () => {
				locked = true;
				// Another crb on the same cache may have run it meanwhile.
				if (await recent()) return { ran: false, reason: "recent" } as const;
				await options.gate?.(stop.signal);
				return run(path, options, stop.signal);
			},
			// Never waits: a holder means the clone is in use.
			{ timeoutMs: 0, onWaiter: onAbort },
		);
	} catch (error) {
		if (!locked && error instanceof GitError) {
			return { ran: false, reason: "busy" };
		}
		// Recorded too, so a clone that can't even be locked (EACCES) is
		// tried daily, not hourly.
		await record(path);
		throw error;
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
	}
}

async function run(
	path: string,
	options: MaintainOptions,
	signal: AbortSignal,
): Promise<MaintenanceResult> {
	const traced = tracer();
	const span = traced.start(
		"crb: maintenance",
		{ repo: shortName(path) },
		{ parent: null },
	);
	return traced.run(span, async () => {
		const started = Date.now();
		let yielded = false;
		try {
			const before = await countObjects(path);
			span.set(prefixed("before", before));
			// The repack writes its pack beside the ones it rolls up (a full
			// roll-up peaked at about the clone's size again, measured).
			const need = 2 * (before.packKiB + before.looseKiB) * 1024;
			const free = await (options.freeBytes ?? statfsFree)(path);
			if (free < need) {
				const error = `${Math.round(free / 2 ** 20)} MiB free, ${Math.round(need / 2 ** 20)} MiB needed`;
				span.end({ skipped: "disk" }, error);
				return { ran: false, reason: "disk", error } as const;
			}
			// No long-running reader holds a pack open while they go
			// (Windows can't delete one); reads meanwhile run their own.
			const resume = await pauseCatFile(path, signal);
			try {
				const steps =
					options.steps ??
					maintenanceCommands(options.gitVersion ?? (await gitVersion(path)));
				for (const args of steps) {
					if (signal.aborted) break;
					await runGit(path, args, {
						lowPriority: true,
						signal,
						// A timed git gets its own process group: a kill reaches
						// pack-objects too.
						timeoutMs: GIT_BACKSTOP_MS,
						// The lock goes to the open only once it has exited.
						waitForExit: true,
					});
				}
			} finally {
				resume();
			}
			if (signal.aborted) {
				yielded = true;
				span.end({ yielded: true });
				return { ran: false, reason: "yielded" } as const;
			}
			const after = await countObjects(path);
			const ms = Date.now() - started;
			span.end(prefixed("after", after));
			return { ran: true, before, after, ms } as const;
		} catch (error) {
			if (signal.aborted) {
				yielded = true;
				span.end({ yielded: true });
				return { ran: false, reason: "yielded" } as const;
			}
			const message = (error as Error).message;
			span.end(undefined, message);
			return { ran: false, reason: "failed", error: message } as const;
		} finally {
			if (!yielded) await record(path);
		}
	});
}

const prefixed = (prefix: string, counts: ObjectCounts) =>
	Object.fromEntries(
		Object.entries(counts).map(([k, v]) => [`${prefix}.${k}`, v]),
	);

/** Every clone under the cache (`repos/<owner>/<repo>.git`). */
async function listClones(root = join(cacheDir(), "repos")) {
	const dirs = async (dir: string) =>
		(await readdir(dir, { withFileTypes: true }).catch(() => []))
			.filter((d) => d.isDirectory())
			.map((d) => join(dir, d.name));
	return (await Promise.all((await dirs(root)).map(dirs)))
		.flat()
		.filter((d) => d.endsWith(".git"))
		.sort();
}

/** `owner/repo.git` of a clone path, for the log. */
const shortName = (path: string) => path.split(/[\\/]/).slice(-2).join("/");

/** One pass over every clone, one at a time; returns what each did. */
export async function maintainClones(
	options: {
		root?: string;
		log?: (message: string) => void;
		/** Stops the run under way and the pass. */
		signal?: AbortSignal;
	} = {},
): Promise<Map<string, MaintenanceResult>> {
	const results = new Map<string, MaintenanceResult>();
	for (const path of await listClones(options.root)) {
		if (options.signal?.aborted) break;
		const result = await maintainClone(path, {
			...(options.signal ? { signal: options.signal } : {}),
		}).catch(
			(error: Error): MaintenanceResult => ({
				ran: false,
				reason: "failed",
				error: error.message,
			}),
		);
		results.set(path, result);
		if (result.ran) {
			const { before: b, after: a } = result;
			options.log?.(
				`maintenance ${shortName(path)}: ${b.loose} loose, ${b.packs} packs → ${a.loose} loose, ${a.packs} packs (${result.ms} ms)`,
			);
		} else if (result.reason === "failed" || result.reason === "disk") {
			options.log?.(
				`maintenance ${shortName(path)} ${result.reason === "disk" ? "skipped, low disk" : "failed"}: ${result.error}`,
			);
		}
	}
	return results;
}

/** First pass this long after start (a start is busy enough). */
export const FIRST_PASS_MS = 10 * 60_000;
/** Later passes: each clone is due once a day, so an hourly look is enough. */
export const PASS_EVERY_MS = 60 * 60_000;

/**
 * Whether `crb serve` maintains its clones: always, except under the test
 * harness (`$CRB_TEST_HOOKS`), where its gits would be a test's leftovers.
 */
export const maintenanceOn = (testHooks: string | null): boolean => !testHooks;

/**
 * crb serve's background maintenance: a pass FIRST_PASS_MS after start and
 * every PASS_EVERY_MS, never two at once, off every request's path. The
 * timers don't keep the process alive; `stop` kills the git under way and
 * settles once the pass has ended.
 */
export function startMaintenance(
	options: {
		log?: (message: string) => void;
		root?: string;
		/** The pass to run (tests). */
		pass?: typeof maintainClones;
	} = {},
): { stop(): Promise<void> } {
	const stopping = new AbortController();
	const runPass = options.pass ?? maintainClones;
	let pass: Promise<unknown> | null = null;
	const tick = () => {
		if (stopping.signal.aborted || pass !== null) return;
		pass = runPass({
			...(options.log ? { log: options.log } : {}),
			...(options.root ? { root: options.root } : {}),
			signal: stopping.signal,
		})
			.catch(() => {})
			.finally(() => {
				pass = null;
			});
	};
	const first = setTimeout(tick, FIRST_PASS_MS);
	first.unref();
	const every = setInterval(tick, PASS_EVERY_MS);
	every.unref();
	return {
		async stop() {
			stopping.abort();
			clearTimeout(first);
			clearInterval(every);
			await pass;
		},
	};
}
