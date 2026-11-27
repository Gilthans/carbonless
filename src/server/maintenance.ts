import { readdir } from "node:fs/promises";
import { join } from "node:path";
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
	versionOnce ??= runGit(path, ["version"]).then((text) => {
		const match = text.match(/(\d+)\.(\d+)/);
		return match ? [Number(match[1]), Number(match[2])] : [0, 0];
	});
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
	| { ran: false; reason: "recent" | "busy" | "failed"; error?: string };

export interface MaintainOptions {
	/** The time now (epoch ms); tests move it. */
	now?: number;
	/** Runs even if the last run was recent (the idle check still applies). */
	force?: boolean;
	/** Awaited once the lock is held, before any git (tests). */
	gate?: Promise<void>;
	/** Plans for this git version instead of the installed one's (tests). */
	gitVersion?: [number, number];
}

const lastRun = async (path: string): Promise<number> => {
	const text = await runGit(path, ["config", "--get", MAINTAINED_AT], {
		allowFailure: true,
	});
	const at = Number(text.trim());
	return Number.isFinite(at) ? at : 0;
};

/**
 * One maintenance of the clone at `path`, unless it ran within the day or
 * the clone is busy: this process used its lock within IDLE_MS, or anyone
 * holds it now (an open or a fetch, of this crb or another). It holds the
 * repo lock throughout, so no open or fetch runs beside it. A failed run is
 * recorded too, so it is tried again only a day later.
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
	if (!options.force && now - (await lastRun(path)) < MAINTENANCE_EVERY_MS) {
		return { ran: false, reason: "recent" };
	}
	let locked = false;
	try {
		return await withRepoLock(
			path,
			async () => {
				locked = true;
				await options.gate;
				return run(path, options.gitVersion);
			},
			// Never waits: a holder means the clone is in use.
			{ timeoutMs: 0 },
		);
	} catch (error) {
		if (!locked && error instanceof GitError) {
			return { ran: false, reason: "busy" };
		}
		throw error;
	}
}

async function run(
	path: string,
	version?: [number, number],
): Promise<MaintenanceResult> {
	const traced = tracer();
	const span = traced.start(
		"crb: maintenance",
		{ repo: path.split(/[\\/]/).slice(-2).join("/") },
		{ parent: null },
	);
	return traced.run(span, async () => {
		const started = Date.now();
		try {
			const before = await countObjects(path);
			span.set(prefixed("before", before));
			for (const args of maintenanceCommands(
				version ?? (await gitVersion(path)),
			)) {
				await runGit(path, args, { lowPriority: true });
			}
			const after = await countObjects(path);
			const ms = Date.now() - started;
			span.end(prefixed("after", after));
			return { ran: true, before, after, ms } as const;
		} catch (error) {
			const message = (error as Error).message;
			span.end(undefined, message);
			return { ran: false, reason: "failed", error: message } as const;
		} finally {
			await runGit(path, ["config", MAINTAINED_AT, String(Date.now())], {
				allowFailure: true,
			});
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
		/** Stops before the next clone. */
		stopped?: () => boolean;
	} = {},
): Promise<Map<string, MaintenanceResult>> {
	const results = new Map<string, MaintenanceResult>();
	for (const path of await listClones(options.root)) {
		if (options.stopped?.()) break;
		const result = await maintainClone(path).catch(
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
		} else if (result.reason === "failed") {
			options.log?.(`maintenance ${shortName(path)} failed: ${result.error}`);
		}
	}
	return results;
}

/** First pass this long after start (a start is busy enough). */
const FIRST_PASS_MS = 10 * 60_000;
/** Later passes: each clone is due once a day, so an hourly look is enough. */
const PASS_EVERY_MS = 60 * 60_000;

/**
 * crb serve's background maintenance: a pass FIRST_PASS_MS after start and
 * every PASS_EVERY_MS, never two at once, off every request's path. The
 * timers don't keep the process alive; `stop` waits for a pass under way.
 */
export function startMaintenance(
	options: { log?: (message: string) => void; root?: string } = {},
): { stop(): Promise<void> } {
	let stopped = false;
	let pass: Promise<unknown> | null = null;
	const tick = () => {
		if (stopped || pass !== null) return;
		pass = maintainClones({ ...options, stopped: () => stopped })
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
			stopped = true;
			clearTimeout(first);
			clearInterval(every);
			await pass;
		},
	};
}
