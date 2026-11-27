import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Coverage } from "../../shared/home.js";
import type { Snapshot } from "../../shared/types.js";
import { writeFileAtomic } from "../atomicFile.js";
import { buildSnapshot } from "../diff/snapshot.js";
import { cacheDir } from "../paths.js";
import { buildReviewView } from "../review/coverage.js";
import type { CrbEvent } from "../review/events.js";
import { foldProgress } from "../review/fold.js";
import { RefStore } from "../review/refStore.js";
import { reviewCreated } from "../review/reviews.js";
import { withSplitCarries } from "../review/splitCarry.js";
import { BUILD, type BuildInfo } from "../version.js";
import type { StartedReview } from "./facts.js";

/**
 * The reviews the viewer has started (a patch set in their progress ref),
 * across every cache clone, with coverage read as the Files page reads it.
 * Home never writes review state. "Opening a PR doesn't count" (owner): a
 * patch set exists only after the reviewer's first action.
 */

/**
 * Snapshots kept (by repo, merge base and head), only so a review marked
 * further recounts without a new build: the memos keep counts, never
 * snapshots (CAR-324), and a snapshot of a big PR is several MB.
 */
const MAX_SNAPSHOTS = 4;

/** Snapshot builds at once: a cold count of many reviews queues the rest. */
const MAX_BUILDS = 4;

/**
 * A knob within one build: bumped to drop what this very build counted.
 * The coverage file is keyed by the build itself (version and commit), so
 * any change to the code that counts (the diff, clusters, the fold, split
 * carries, `coverageOf`) is never read with counts made by other code.
 */
export const COVERAGE_VERSION = 1;

/** Coverage files not written for this long are deleted (other builds', removed clones', crashed temp files). */
const PRUNE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The key a build's coverage files carry, or null when the build's code
 * isn't named by its commit (a dev tree with changes, no git): then
 * nothing is read from disk or kept there.
 */
export function buildKey(build: BuildInfo): string | null {
	if (build.commit === "unknown" || build.commit.endsWith("-dirty")) {
		return null;
	}
	return `${COVERAGE_VERSION}:${build.version}:${build.commit}`;
}

/** `<cache>/carbonless/repos`, where every clone lives. */
const reposDir = () => join(cacheDir(), "repos");

/** `<cache>/carbonless/coverage`: counted coverage, kept across restarts. */
const coverageDir = () => join(cacheDir(), "coverage");

/** The key `withCoverage` names a PR by: `owner/repo#number`, lowercased. */
export const prKey = (owner: string, repo: string, number: number): string =>
	`${owner}/${repo}#${number}`.toLowerCase();

/** One review's counted coverage on disk, valid only at these tips. */
interface DiskEntry {
	metaTip: string;
	progressTip: string;
	coverage: Coverage;
}

const UNITS = new Set<Coverage["unit"]>(["lines", "clusters", "files"]);
const count = (n: unknown): n is number =>
	typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * A disk entry as read, or null when anything about it is off: a cache
 * that can't be trusted is a miss (recounted), never coverage (principle 2).
 */
function diskEntry(value: unknown): DiskEntry | null {
	if (typeof value !== "object" || value === null) return null;
	const { metaTip, progressTip, coverage } = value as Record<string, unknown>;
	// Tips are only ever compared for equality with tips git listed: any
	// string that isn't one of them is a miss.
	if (typeof metaTip !== "string" || typeof progressTip !== "string") {
		return null;
	}
	if (typeof coverage !== "object" || coverage === null) return null;
	const { done, total, unit } = coverage as Record<string, unknown>;
	if (!count(done) || !count(total) || done > total) return null;
	if (typeof unit !== "string" || !UNITS.has(unit as Coverage["unit"])) {
		return null;
	}
	return {
		metaTip,
		progressTip,
		coverage: { done, total, unit: unit as Coverage["unit"] },
	};
}

/**
 * The share a row shows: reviewed out of what isn't crossed off, in lines.
 * When the lines look finished but clusters without changed lines (renames,
 * mode changes) are left, clusters stand in, so nothing unreviewed looks
 * done (principle 2).
 */
function coverageOf(
	snapshot: Snapshot,
	progress: ReturnType<typeof foldProgress>,
): Coverage {
	const { lines, clusters } = buildReviewView(snapshot, progress).progress;
	const left = clusters.total - clusters.reviewed - clusters.crossedOff;
	const lineTotal = lines.total - lines.crossedOff;
	if (left > 0 && lines.reviewed >= lineTotal) {
		return {
			done: clusters.reviewed,
			total: clusters.total - clusters.crossedOff,
			unit: "clusters",
		};
	}
	return { done: lines.reviewed, total: lineTotal, unit: "lines" };
}

/**
 * What a review's two refs said at their tips: its summary (null: not
 * started, as-of, or its history unreadable), and its coverage once read. Kept per review while
 * both tips stay where they were.
 */
interface Memo {
	metaTip: string;
	progressTip: string;
	review: Omit<StartedReview, "coverage"> | null;
	/** The coverage for these tips, once a caller wanted it. */
	coverage?: Coverage;
	/**
	 * The progress events, kept only while coverage couldn't be read (its
	 * commits not fetched yet), so the next try needs no git log.
	 */
	events?: CrbEvent[];
}

const PROGRESS_REF =
	/^refs\/crb\/reviews\/([0-9a-z]{26})\/reviewers\/([^/]+)\/progress$/;
const META_REF = /^refs\/crb\/reviews\/([0-9a-z]{26})\/meta$/;

export class StartedReviews {
	readonly #build: typeof buildSnapshot;
	readonly #stores = new Map<string, RefStore>();
	readonly #snapshots = new Map<string, Promise<Snapshot>>();
	/**
	 * By clone, then review id. Holds only reviews whose refs the clone's
	 * last scan listed, so it is bounded by the started reviews that exist.
	 */
	readonly #memos = new Map<string, Map<string, Memo>>();
	/** By clone and slug: the coverage file as read, by review id. */
	readonly #disk = new Map<string, Promise<Map<string, DiskEntry>>>();
	/** The coverage files' key (buildKey); null: none read or written. */
	readonly #buildKey: string | null;
	/** Old coverage files deleted once per server, on its first write. */
	#pruned = false;
	/**
	 * Counts under way, by clone, review and progress tip: a scan running
	 * beside another (two tabs, Home and the MCP tool) waits for the same
	 * count instead of building again.
	 */
	readonly #counting = new Map<string, Promise<Coverage | undefined>>();
	#buildsRunning = 0;
	readonly #buildsWaiting: (() => void)[] = [];

	constructor(
		options: { build?: typeof buildSnapshot; buildInfo?: BuildInfo } = {},
	) {
		this.#build = options.build ?? buildSnapshot;
		this.#buildKey = buildKey(options.buildInfo ?? BUILD);
	}

	/** Forgets its ref stores, snapshots and summaries (the test hook's reset). */
	reset(): void {
		this.#stores.clear();
		this.#snapshots.clear();
		this.#memos.clear();
		this.#disk.clear();
	}

	#store(repo: string): RefStore {
		let store = this.#stores.get(repo);
		if (!store) {
			store = new RefStore(repo);
			this.#stores.set(repo, store);
		}
		return store;
	}

	/** Runs `build` once fewer than MAX_BUILDS others run. */
	async #limited<T>(build: () => Promise<T>): Promise<T> {
		if (this.#buildsRunning >= MAX_BUILDS) {
			await new Promise<void>((go) => this.#buildsWaiting.push(go));
		}
		this.#buildsRunning++;
		try {
			return await build();
		} finally {
			this.#buildsRunning--;
			this.#buildsWaiting.shift()?.();
		}
	}

	#snapshot(repo: string, base: string, head: string): Promise<Snapshot> {
		const key = `${repo}\0${base}\0${head}`;
		let snap = this.#snapshots.get(key);
		if (!snap) {
			if (this.#snapshots.size >= MAX_SNAPSHOTS) {
				const oldest = this.#snapshots.keys().next().value;
				if (oldest !== undefined) this.#snapshots.delete(oldest);
			}
			snap = this.#limited(() => this.#build(repo, base, head));
			// A failure is asked again next time.
			snap.catch(() => this.#snapshots.delete(key));
			this.#snapshots.set(key, snap);
		}
		return snap;
	}

	/**
	 * Every review `slug` has started, in any clone, as-of reviews left out.
	 * Coverage only for the PRs `withCoverage` names (prKey; all when not
	 * given): Home asks for its rows' PRs alone, so a review of a PR merged
	 * months ago costs nothing. `only` (`owner/repo`): that repo's clone
	 * alone, no other is scanned.
	 *
	 * Git processes per clone, however many reviews it holds (CAR-307): one
	 * for-each-ref of the meta and progress refs' tips, plus, only when a tip
	 * moved since the last scan (or coverage is newly wanted and not on
	 * disk), one git log of the moved tips. A review written by another tab,
	 * the crb CLI or a fetch moves its tip, so the next scan sees it with no
	 * invalidation. Coverage counted once is kept on disk by the refs' tips
	 * (CAR-324), so a restart builds no snapshot for a review that didn't
	 * move.
	 */
	async list(
		slug: string,
		withCoverage?: ReadonlySet<string>,
		only?: string,
	): Promise<StartedReview[]> {
		const root = reposDir();
		const repos = only
			? [join(root, `${only.toLowerCase()}.git`)].filter((r) => existsSync(r))
			: (
					await Promise.all(
						(
							await readdir(root).catch(() => [] as string[])
						).map(async (o) =>
							(
								await readdir(join(root, o)).catch(() => [] as string[])
							)
								.filter((r) => r.endsWith(".git"))
								.map((r) => join(root, o, r)),
						),
					)
				).flat();
		const found = await Promise.all(
			repos.map((r) =>
				this.#inRepo(r, slug, withCoverage).catch((error) => {
					// A broken clone costs its own reviews, never the scan.
					console.error(
						`crb: skipped started reviews in ${r}: ${String(error)}`,
					);
					return [];
				}),
			),
		);
		return found.flat();
	}

	/**
	 * The coverage of `reviews` (as the last list() of `slug` gave them),
	 * by review id, with no new scan: for a caller that picks which reviews
	 * it shows only after listing them all (the MCP `reviews` tool). Null:
	 * not counted (a review the last scan didn't hold, or its commits not
	 * readable).
	 */
	async coverage(
		slug: string,
		reviews: readonly StartedReview[],
	): Promise<Map<string, Coverage | null>> {
		const ids = new Set(reviews.map((r) => r.id));
		const byRepo = new Map<string, Memo[]>();
		for (const [key, memos] of this.#memos) {
			const [repo = "", memoSlug] = key.split("\0");
			if (memoSlug !== slug) continue;
			for (const [id, memo] of memos) {
				if (!ids.has(id) || !memo.review) continue;
				byRepo.set(repo, [...(byRepo.get(repo) ?? []), memo]);
			}
		}
		await Promise.all(
			[...byRepo].map(([repo, memos]) =>
				this.#cover(repo, slug, memos).catch((error) => {
					console.error(`crb: no coverage in ${repo}: ${String(error)}`);
				}),
			),
		);
		const out = new Map<string, Coverage | null>();
		for (const memos of byRepo.values()) {
			for (const memo of memos) {
				if (memo.review) out.set(memo.review.id, memo.coverage ?? null);
			}
		}
		return out;
	}

	async #inRepo(
		repo: string,
		slug: string,
		withCoverage: ReadonlySet<string> | undefined,
	): Promise<StartedReview[]> {
		const store = this.#store(repo);
		// The viewer's progress refs and every meta ref, tips only: one git.
		const tips = await store.tips([
			`refs/crb/reviews/*/reviewers/${slug}/progress`,
			"refs/crb/reviews/*/meta",
		]);
		const metas = new Map<string, string>();
		const progresses = new Map<string, string>();
		for (const [ref, tip] of tips) {
			const meta = META_REF.exec(ref)?.[1];
			if (meta) metas.set(meta, tip);
			const progress = PROGRESS_REF.exec(ref);
			if (progress?.[1] && progress[2] === slug) {
				progresses.set(progress[1], tip);
			}
		}
		const memoKey = `${repo}\0${slug}`;
		const before = this.#memos.get(memoKey) ?? new Map<string, Memo>();
		const memos = new Map<string, Memo>();
		// Each review whose tips moved, and what it needs read.
		const stale: { id: string; metaTip: string; progressTip: string }[] = [];
		const toCover: Memo[] = [];
		for (const [id, progressTip] of progresses) {
			const metaTip = metas.get(id);
			// No meta (yet): not a review to show.
			if (!metaTip) continue;
			const memo = before.get(id);
			if (memo?.metaTip === metaTip && memo.progressTip === progressTip) {
				memos.set(id, memo);
				if (
					memo.review &&
					memo.coverage === undefined &&
					this.#wants(memo.review, withCoverage)
				) {
					toCover.push(memo);
				}
			} else stale.push({ id, metaTip, progressTip });
		}
		const read =
			stale.length > 0
				? await store.eventsOfTips(
						stale.flatMap((s) => [s.metaTip, s.progressTip]),
					)
				: new Map<string, CrbEvent[] | Error>();
		for (const { id, metaTip, progressTip } of stale) {
			try {
				const meta = eventsOf(read, metaTip);
				const events = eventsOf(read, progressTip);
				const memo: Memo = {
					metaTip,
					progressTip,
					review: summary(id, meta, events),
				};
				memos.set(id, memo);
				if (memo.review && this.#wants(memo.review, withCoverage)) {
					memo.events = events;
					toCover.push(memo);
				}
			} catch (error) {
				// Kept as not started until a tip moves: a broken history is
				// neither read nor logged again on every load.
				memos.set(id, { metaTip, progressTip, review: null });
				console.error(`crb: skipped review ${id} in ${repo}: ${String(error)}`);
			}
		}
		// Reviews gone from the clone leave the memo with it.
		this.#memos.set(memoKey, memos);
		await this.#cover(repo, slug, toCover);
		const out: StartedReview[] = [];
		for (const memo of memos.values()) {
			if (!memo.review) continue;
			const wanted = this.#wants(memo.review, withCoverage);
			out.push({
				...memo.review,
				coverage: wanted
					? (memo.coverage ?? { done: 0, total: 0, unit: "clusters" })
					: null,
			});
		}
		return out;
	}

	#wants(
		review: { owner: string; repo: string; number: number },
		withCoverage: ReadonlySet<string> | undefined,
	): boolean {
		return (
			!withCoverage ||
			withCoverage.has(prKey(review.owner, review.repo, review.number))
		);
	}

	/**
	 * Fills each memo's coverage (those without one): from the disk cache
	 * when it was counted at the same tips, else counted from a snapshot
	 * (its events read in one git log when not kept), then kept on disk.
	 */
	async #cover(repo: string, slug: string, memos: Memo[]): Promise<void> {
		const wanted = memos.filter((m) => m.review && m.coverage === undefined);
		if (wanted.length === 0) return;
		const disk = await this.#readDisk(repo, slug);
		const misses: Memo[] = [];
		for (const memo of wanted) {
			const hit = disk.get(memo.review?.id ?? "");
			if (
				hit &&
				hit.metaTip === memo.metaTip &&
				hit.progressTip === memo.progressTip
			) {
				memo.coverage = hit.coverage;
				memo.events = undefined;
			} else misses.push(memo);
		}
		if (misses.length === 0) return;
		const keyOf = (m: Memo) => `${repo}\0${m.review?.id}\0${m.progressTip}`;
		// Counted already by a scan beside this one: wait for it.
		const own = misses.filter((m) => !this.#counting.has(keyOf(m)));
		const unread = own.filter((m) => !m.events).map((m) => m.progressTip);
		const read =
			unread.length > 0
				? await this.#store(repo).eventsOfTips(unread)
				: new Map<string, CrbEvent[] | Error>();
		let counted = false;
		await Promise.all(
			misses.map(async (memo) => {
				const key = keyOf(memo);
				let counting = this.#counting.get(key);
				if (!counting) {
					try {
						memo.events ??= eventsOf(read, memo.progressTip);
					} catch (error) {
						console.error(
							`crb: no coverage for ${memo.review?.id} in ${repo}: ${String(error)}`,
						);
						return;
					}
					const events = memo.events;
					counting = this.#count(repo, slug, events).finally(() =>
						this.#counting.delete(key),
					);
					this.#counting.set(key, counting);
				}
				const coverage = await counting;
				if (coverage) {
					memo.coverage = coverage;
					memo.events = undefined;
					counted = true;
				}
			}),
		);
		if (counted) await this.#writeDisk(repo, slug);
	}

	/**
	 * The coverage of a progress ref's `events`; undefined when the patch
	 * set's commits aren't readable: no coverage to claim (shown as none),
	 * tried again next time from the memo's kept events.
	 */
	async #count(
		repo: string,
		slug: string,
		events: CrbEvent[],
	): Promise<Coverage | undefined> {
		const patchset = foldProgress(events).patchset;
		if (!patchset) return undefined;
		try {
			const snapshot = await this.#snapshot(
				repo,
				patchset.mergeBase,
				patchset.head,
			);
			// Home never writes: marks on hunks now cut at whitespace-only
			// runs count on their pieces as the review's first open writes
			// them (CAR-156).
			return coverageOf(snapshot, withSplitCarries(events, snapshot, slug));
		} catch {
			return undefined;
		}
	}

	/**
	 * The coverage file of `repo`, `slug` and this build (hashed: no path or
	 * slug in its name); two builds running at once (main and a branch
	 * instance on the same cache) keep files of their own.
	 */
	#diskPath(repo: string, slug: string): string {
		const name = createHash("sha256")
			.update(`${repo}\0${slug}\0${this.#buildKey}`)
			.digest("hex");
		return join(coverageDir(), `${name}.json`);
	}

	/**
	 * The clone's coverage file for `slug`, read once per server. A file
	 * that can't be read or parsed, of another version, or of another clone
	 * or slug is empty; an entry that doesn't check out is dropped alone.
	 */
	#readDisk(repo: string, slug: string): Promise<Map<string, DiskEntry>> {
		const key = `${repo}\0${slug}`;
		let disk = this.#disk.get(key);
		if (!disk) {
			disk = (async () => {
				const entries = new Map<string, DiskEntry>();
				if (this.#buildKey === null) return entries;
				let parsed: unknown;
				try {
					parsed = JSON.parse(
						await readFile(this.#diskPath(repo, slug), "utf8"),
					);
				} catch {
					return entries;
				}
				if (typeof parsed !== "object" || parsed === null) return entries;
				const file = parsed as Record<string, unknown>;
				if (
					file.version !== this.#buildKey ||
					file.repo !== repo ||
					file.slug !== slug ||
					typeof file.reviews !== "object" ||
					file.reviews === null
				) {
					return entries;
				}
				for (const [id, value] of Object.entries(file.reviews)) {
					const entry = diskEntry(value);
					if (entry) entries.set(id, entry);
				}
				return entries;
			})();
			this.#disk.set(key, disk);
		}
		return disk;
	}

	/**
	 * Keeps the counted coverage of the clone's reviews (as the last scan
	 * holds them) on disk: one small file per clone and slug, bounded by the
	 * started reviews that exist. A failed write keeps the memory copy.
	 */
	async #writeDisk(repo: string, slug: string): Promise<void> {
		if (this.#buildKey === null) return;
		if (!this.#pruned) {
			this.#pruned = true;
			await pruneCoverage();
		}
		const key = `${repo}\0${slug}`;
		const disk = await this.#readDisk(repo, slug);
		const memos = this.#memos.get(key);
		const next = new Map<string, DiskEntry>();
		for (const [id, memo] of memos ?? []) {
			if (memo.review && memo.coverage) {
				next.set(id, {
					metaTip: memo.metaTip,
					progressTip: memo.progressTip,
					coverage: memo.coverage,
				});
			} else {
				// Not counted this time: what disk had at the same tips stays.
				const kept = disk.get(id);
				if (
					kept &&
					kept.metaTip === memo.metaTip &&
					kept.progressTip === memo.progressTip
				) {
					next.set(id, kept);
				}
			}
		}
		this.#disk.set(key, Promise.resolve(next));
		try {
			await writeFileAtomic(
				this.#diskPath(repo, slug),
				JSON.stringify({
					version: this.#buildKey,
					repo,
					slug,
					reviews: Object.fromEntries(next),
				}),
			);
		} catch (error) {
			console.error(`crb: coverage not kept for ${repo}: ${String(error)}`);
		}
	}
}

/**
 * Deletes coverage files (and temp files a crash left) not written for
 * PRUNE_AFTER_MS: other builds' files, removed clones'. One still in use is
 * at worst counted again.
 */
async function pruneCoverage(): Promise<void> {
	const dir = coverageDir();
	const names = await readdir(dir).catch(() => [] as string[]);
	const before = Date.now() - PRUNE_AFTER_MS;
	await Promise.all(
		names.map(async (name) => {
			const path = join(dir, name);
			try {
				if ((await stat(path)).mtimeMs < before)
					await rm(path, { force: true });
			} catch {
				// Gone already, or another crb's: nothing to do.
			}
		}),
	);
}

/** A tip's events as `read` has them; throws when it hasn't, or failed. */
function eventsOf(
	read: Map<string, CrbEvent[] | Error>,
	tip: string,
): CrbEvent[] {
	const events = read.get(tip);
	if (events === undefined) throw new Error(`not read: ${tip}`);
	if (events instanceof Error) throw events;
	return events;
}

/** A review's summary from its meta and progress events; null: not started. */
function summary(
	id: string,
	meta: CrbEvent[],
	events: CrbEvent[],
): Omit<StartedReview, "coverage"> | null {
	const created = reviewCreated(meta);
	if (!created) return null;
	const details = created.details ?? {};
	const asOf = typeof details.asOf === "string" ? details.asOf : null;
	// Dev mode views of the past never count as started.
	if (asOf !== null) return null;
	const progress = foldProgress(events);
	if (!progress.patchset) return null;
	let last = 0;
	for (const e of events) if (e.ts > last) last = e.ts;
	const { owner, repo: name, number } = created.pr;
	return {
		owner,
		repo: name,
		number,
		id,
		pinnedHead: typeof details.head === "string" ? details.head : null,
		head: progress.patchset.head,
		asOf,
		lastActedAt: new Date(last).toISOString(),
	};
}
