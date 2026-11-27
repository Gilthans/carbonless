import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Coverage } from "../../shared/home.js";
import type { Snapshot } from "../../shared/types.js";
import { buildSnapshot } from "../diff/snapshot.js";
import { cacheDir } from "../paths.js";
import { buildReviewView } from "../review/coverage.js";
import { type CrbEvent, isActivity } from "../review/events.js";
import { foldProgress } from "../review/fold.js";
import { RefStore } from "../review/refStore.js";
import { reviewCreated } from "../review/reviews.js";
import { withSplitCarries } from "../review/splitCarry.js";
import type { StartedReview } from "./facts.js";

/**
 * The reviews the viewer has started (a patch set in their progress ref),
 * across every cache clone, with coverage read as the Files page reads it.
 * Home never writes review state. "Opening a PR doesn't count" (owner): a
 * patch set exists only after the reviewer's first action.
 */

/** Snapshots kept (by repo, merge base and head). */
const MAX_SNAPSHOTS = 64;

/** `<cache>/carbonless/repos`, where every clone lives. */
const reposDir = () => join(cacheDir(), "repos");

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

	constructor(options: { build?: typeof buildSnapshot } = {}) {
		this.#build = options.build ?? buildSnapshot;
	}

	/** Forgets its ref stores, snapshots and summaries (the test hook's reset). */
	reset(): void {
		this.#stores.clear();
		this.#snapshots.clear();
		this.#memos.clear();
	}

	#store(repo: string): RefStore {
		let store = this.#stores.get(repo);
		if (!store) {
			store = new RefStore(repo);
			this.#stores.set(repo, store);
		}
		return store;
	}

	#snapshot(repo: string, base: string, head: string): Promise<Snapshot> {
		const key = `${repo}\0${base}\0${head}`;
		let snap = this.#snapshots.get(key);
		if (!snap) {
			if (this.#snapshots.size >= MAX_SNAPSHOTS) {
				const oldest = this.#snapshots.keys().next().value;
				if (oldest !== undefined) this.#snapshots.delete(oldest);
			}
			snap = this.#build(repo, base, head);
			// A failure is asked again next time.
			snap.catch(() => this.#snapshots.delete(key));
			this.#snapshots.set(key, snap);
		}
		return snap;
	}

	/**
	 * Every review `slug` has started, in any clone, as-of reviews left out.
	 * Coverage only for repos `withCoverage` names (`owner/repo`, lowercased;
	 * all when not given): Home shows no other. `only` (`owner/repo`): that
	 * repo's clone alone, no other is scanned.
	 *
	 * Git processes per clone, however many reviews it holds (CAR-307): one
	 * for-each-ref of the meta and progress refs' tips, plus, only when a tip
	 * moved since the last scan (or coverage is newly wanted), one git log of
	 * the moved tips. A review written by another tab, the crb CLI or a fetch
	 * moves its tip, so the next scan sees it with no invalidation.
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
		const toCover = new Map<string, Memo>();
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
					toCover.set(id, memo);
				}
			} else stale.push({ id, metaTip, progressTip });
		}
		const needed = [
			...stale.flatMap((s) => [s.metaTip, s.progressTip]),
			...[...toCover.values()]
				.filter((m) => !m.events)
				.map((m) => m.progressTip),
		];
		const read =
			needed.length > 0
				? await store.eventsOfTips(needed)
				: new Map<string, CrbEvent[] | Error>();
		const eventsOf = (tip: string) => {
			const events = read.get(tip);
			if (events === undefined) throw new Error(`not read: ${tip}`);
			if (events instanceof Error) throw events;
			return events;
		};
		for (const { id, metaTip, progressTip } of stale) {
			try {
				const meta = eventsOf(metaTip);
				const events = eventsOf(progressTip);
				const memo: Memo = {
					metaTip,
					progressTip,
					review: summary(id, meta, events),
				};
				memos.set(id, memo);
				if (memo.review && this.#wants(memo.review, withCoverage)) {
					memo.events = events;
					toCover.set(id, memo);
				}
			} catch (error) {
				// Kept as not started until a tip moves: a broken history is
				// neither read nor logged again on every load.
				memos.set(id, { metaTip, progressTip, review: null });
				console.error(`crb: skipped review ${id} in ${repo}: ${String(error)}`);
			}
		}
		await Promise.all(
			[...toCover.values()].map(async (memo) => {
				try {
					memo.events ??= eventsOf(memo.progressTip);
				} catch (error) {
					console.error(
						`crb: no coverage for ${memo.review?.id} in ${repo}: ${String(error)}`,
					);
					return;
				}
				await this.#coverage(repo, slug, memo);
			}),
		);
		// Reviews gone from the clone leave the memo with it.
		this.#memos.set(memoKey, memos);
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
		review: { owner: string; repo: string },
		withCoverage: ReadonlySet<string> | undefined,
	): boolean {
		return (
			!withCoverage ||
			withCoverage.has(`${review.owner}/${review.repo}`.toLowerCase())
		);
	}

	/** Fills `memo.coverage` from its events, which it then lets go. */
	async #coverage(repo: string, slug: string, memo: Memo): Promise<void> {
		const events = memo.events ?? [];
		const patchset = foldProgress(events).patchset;
		if (!patchset) return;
		try {
			const snapshot = await this.#snapshot(
				repo,
				patchset.mergeBase,
				patchset.head,
			);
			// Home never writes: marks on hunks now cut at whitespace-only
			// runs count on their pieces as the review's first open writes
			// them (CAR-156).
			memo.coverage = coverageOf(
				snapshot,
				withSplitCarries(events, snapshot, slug),
			);
			memo.events = undefined;
		} catch {
			// The patch set's commits aren't readable: no coverage to claim
			// (shown as none), tried again next time from the kept events.
		}
	}
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
	// Only what the reviewer did: never compaction's marker (CAR-13).
	for (const e of events) if (isActivity(e) && e.ts > last) last = e.ts;
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
