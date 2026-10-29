import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Coverage } from "../../shared/home.js";
import type { Snapshot } from "../../shared/types.js";
import { clonePath } from "../clone.js";
import { buildSnapshot } from "../diff/snapshot.js";
import { runGit } from "../git.js";
import { buildReviewView } from "../review/coverage.js";
import { foldProgress } from "../review/fold.js";
import { RefStore } from "../review/refStore.js";
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
const reposDir = () => dirname(dirname(clonePath("x", "x")));

/**
 * The share a row shows: reviewed out of what isn't crossed off, in lines.
 * When the lines look finished but clusters without changed lines (renames,
 * mode changes) are left, clusters stand in, so nothing unreviewed looks
 * done (principle 2).
 */
export function coverageOf(
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

export class StartedReviews {
	readonly #build: typeof buildSnapshot;
	readonly #stores = new Map<string, RefStore>();
	readonly #snapshots = new Map<string, Promise<Snapshot>>();

	constructor(options: { build?: typeof buildSnapshot } = {}) {
		this.#build = options.build ?? buildSnapshot;
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

	/** Every review `slug` has started, in any clone, as-of reviews left out. */
	async list(slug: string): Promise<StartedReview[]> {
		const root = reposDir();
		const owners = await readdir(root).catch(() => [] as string[]);
		const repos = (
			await Promise.all(
				owners.map(async (o) =>
					(
						await readdir(join(root, o)).catch(() => [] as string[])
					)
						.filter((r) => r.endsWith(".git"))
						.map((r) => join(root, o, r)),
				),
			)
		).flat();
		const found = await Promise.all(repos.map((r) => this.#inRepo(r, slug)));
		return found.flat();
	}

	async #inRepo(repo: string, slug: string): Promise<StartedReview[]> {
		// Only the viewer's progress refs: one listing, no review's meta read
		// unless the viewer acted in it.
		const out = await runGit(
			repo,
			[
				"for-each-ref",
				"--format=%(refname)",
				`refs/crb/reviews/*/reviewers/${slug}/progress`,
			],
			{ allowFailure: true },
		);
		const ids = out
			.split("\n")
			.map(
				(line) =>
					/^refs\/crb\/reviews\/([0-9a-z]{26})\/reviewers\//.exec(line)?.[1],
			)
			.filter((id): id is string => id !== undefined);
		const reviews = await Promise.all(
			ids.map((id) => this.#review(repo, id, slug)),
		);
		return reviews.filter((r): r is StartedReview => r !== null);
	}

	async #review(
		repo: string,
		id: string,
		slug: string,
	): Promise<StartedReview | null> {
		const store = this.#store(repo);
		const [meta, events] = await Promise.all([
			store.readEvents(`refs/crb/reviews/${id}/meta`),
			store.readEvents(`refs/crb/reviews/${id}/reviewers/${slug}/progress`),
		]);
		const created = meta.find((e) => e.type === "review-created");
		if (created?.type !== "review-created") return null;
		const details = created.details ?? {};
		const asOf = typeof details.asOf === "string" ? details.asOf : null;
		// Dev mode views of the past never count as started.
		if (asOf !== null) return null;
		const progress = foldProgress(events);
		if (!progress.patchset) return null;
		let last = 0;
		for (const e of events) if (e.ts > last) last = e.ts;
		let coverage: Coverage;
		try {
			const { mergeBase, head } = progress.patchset;
			coverage = coverageOf(
				await this.#snapshot(repo, mergeBase, head),
				progress,
			);
		} catch {
			// The patch set's commits aren't readable: no coverage to claim.
			coverage = { done: 0, total: 0, unit: "clusters" };
		}
		const { owner, repo: name, number } = created.pr;
		return {
			owner,
			repo: name,
			number,
			id,
			pinnedHead: typeof details.head === "string" ? details.head : null,
			asOf,
			coverage,
			lastActedAt: new Date(last).toISOString(),
		};
	}
}
