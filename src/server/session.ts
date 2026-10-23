import type {
	DiffLine,
	FileHunks,
	PrOverview,
	ReviewView,
	SessionInfo,
	Snapshot,
	StateChange,
} from "../shared/types.js";
import { ensureClone, fetchPr } from "./clone.js";
import { buildSnapshot, loadContext, loadFileHunks } from "./diff/snapshot.js";
import {
	fetchOverview,
	fetchPrMeta,
	type PrMeta,
	type PrRef,
	resolvePrRef,
	runGh,
	viewerSlug,
} from "./gh.js";
import { buildReviewView } from "./review/coverage.js";
import type { ProgressState } from "./review/fold.js";
import { RefStore } from "./review/refStore.js";
import { ReviewService, StaleSnapshotError } from "./review/reviews.js";

/** Comparison endpoints: merge-base(origin/<base>, head) → head. */
interface Endpoints {
	mergeBase: string;
	head: string;
}

/**
 * One reviewer's review of one PR, as served by `crb`. The snapshot is the
 * reviewer's patch set once they started one, else the PR's head; it only
 * moves on an explicit refresh, and never off a started patch set.
 */
export class Session {
	#meta: PrMeta;
	#snapshot: Snapshot;
	#patchset: number | null;
	/** Serializes everything that writes or swaps the snapshot. */
	#queue: Promise<unknown> = Promise.resolve();

	private constructor(
		private readonly repo: string,
		private readonly viewer: string,
		private readonly reviewId: string,
		private readonly reviews: ReviewService,
		meta: PrMeta,
		snapshot: Snapshot,
		patchset: number | null,
	) {
		this.#meta = meta;
		this.#snapshot = snapshot;
		this.#patchset = patchset;
	}

	static async open(arg: string, cwd: string): Promise<Session> {
		await runGh(["auth", "status"]);
		const ref = await resolvePrRef(arg, cwd);
		const viewer = await viewerSlug();
		const meta = await fetchPrMeta(ref);
		const repo = await ensureClone(meta.owner, meta.repo);
		const fetched = await fetchPr(repo, meta);
		if (fetched.mergeBase === fetched.head) {
			throw new Error(
				`PR ${meta.owner}/${meta.repo}#${meta.number} is already merged into ${meta.baseBranch}; nothing to review`,
			);
		}
		const reviews = new ReviewService(new RefStore(repo));
		const reviewId = await reviews.findOrCreateReview(meta, viewer);
		const progress = await reviews.getProgress(reviewId, viewer);
		const { mergeBase, head } = progress.patchset ?? fetched;
		const snapshot = await buildSnapshot(repo, mergeBase, head);
		return new Session(
			repo,
			viewer,
			reviewId,
			reviews,
			meta,
			snapshot,
			progress.patchset?.number ?? null,
		);
	}

	info(): SessionInfo {
		const { owner, repo, number, title, url, headOid } = this.#meta;
		return {
			pr: { owner, repo, number, title, url },
			viewer: this.viewer,
			snapshotHead: this.#snapshot.head,
			currentHead: headOid,
			headMoved: headOid !== this.#snapshot.head,
			patchset: this.#patchset,
		};
	}

	snapshot(): Snapshot {
		return this.#snapshot;
	}

	overview(): Promise<PrOverview> {
		return fetchOverview(this.#ref(), this.viewer);
	}

	async review(): Promise<ReviewView> {
		const snapshot = this.#snapshot;
		const view = buildReviewView(snapshot, await this.#progress());
		if (snapshot === this.#snapshot) this.#patchset = view.patchset;
		return view;
	}

	fileHunks(index: number): Promise<FileHunks> {
		return loadFileHunks(this.repo, this.#snapshot, index);
	}

	context(index: number, newFrom: number, newTo: number): Promise<DiffLine[]> {
		return loadContext(this.repo, this.#snapshot, index, newFrom, newTo);
	}

	/**
	 * Records state changes made against the snapshot whose head is
	 * `snapshotHead`. A tab still showing a snapshot the session has moved off
	 * gets a StaleSnapshotError, so no state lands on the wrong snapshot.
	 */
	setStates(snapshotHead: string, changes: StateChange[]): Promise<ReviewView> {
		return this.#exclusive(async () => {
			const snapshot = this.#snapshot;
			if (snapshotHead !== snapshot.head) {
				throw new StaleSnapshotError("The review moved to another snapshot");
			}
			try {
				const progress = await this.reviews.recordStates(
					this.reviewId,
					this.viewer,
					snapshot,
					changes,
				);
				const view = buildReviewView(snapshot, progress);
				this.#patchset = view.patchset;
				return view;
			} catch (error) {
				// Another crb started a patch set on another revision: move onto it
				// so the reloaded review shows it.
				if (error instanceof StaleSnapshotError) {
					await this.#moveTo(await this.#progress(), {
						mergeBase: snapshot.base,
						head: snapshot.head,
					});
				}
				throw error;
			}
		});
	}

	/**
	 * Fetches the PR again. A review without a patch set moves to the new
	 * head; a started one stays on its patch set.
	 */
	refresh(): Promise<SessionInfo> {
		return this.#exclusive(async () => {
			const meta = await fetchPrMeta(this.#ref());
			const fetched = await fetchPr(this.repo, meta);
			this.#meta = meta;
			await this.#moveTo(await this.#progress(), fetched);
			return this.info();
		});
	}

	/** Asks GitHub for the PR's head without fetching anything. */
	async checkHead(): Promise<SessionInfo> {
		this.#meta = await fetchPrMeta(this.#ref());
		return this.info();
	}

	#ref(): PrRef {
		const { owner, repo, number } = this.#meta;
		return { owner, repo, number };
	}

	#progress(): Promise<ProgressState> {
		return this.reviews.getProgress(this.reviewId, this.viewer);
	}

	/** Puts the session on the patch set if there is one, else on `fallback`. */
	async #moveTo(progress: ProgressState, fallback: Endpoints): Promise<void> {
		const { mergeBase, head } = progress.patchset ?? fallback;
		const current = this.#snapshot;
		if (current.base !== mergeBase || current.head !== head) {
			this.#snapshot = await buildSnapshot(this.repo, mergeBase, head);
		}
		this.#patchset = progress.patchset?.number ?? null;
	}

	#exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(fn, fn);
		this.#queue = run.catch(() => {});
		return run;
	}
}
