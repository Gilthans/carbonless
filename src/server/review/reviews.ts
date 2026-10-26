import { createHash } from "node:crypto";
import { ulid } from "ulid";
import type { Snapshot, StateChange } from "../../shared/types.js";
import { runGit } from "../git.js";
import { type ClusterStateEvent, isSlug, newEvent } from "./events.js";
import { foldProgress, type ProgressState } from "./fold.js";
import { RefConflictError, type RefStore } from "./refStore.js";

/** The pull request fields a review records (Task 5's PrMeta fits this). */
export interface ReviewPr {
	owner: string;
	repo: string;
	number: number;
	url: string;
	baseBranch: string;
	headBranch: string;
	headRepo: string;
}

/**
 * State changes refused for what they say (HTTP 400, naming `keys`, the
 * refused changes' cluster keys, so a client can resend the rest).
 */
export class RefusedChangeError extends Error {
	constructor(
		message: string,
		readonly keys: string[],
	) {
		super(message);
	}
}

/** A state change names a cluster the snapshot doesn't have (HTTP 400). */
export class UnknownClusterError extends RefusedChangeError {}

/** A state change is malformed, e.g. an unknown state (HTTP 400). */
export class InvalidChangeError extends RefusedChangeError {}

/**
 * The message for `refused` changes: the first one's, and how many more.
 */
export function refusedMessage(first: string, refused: number): string {
	return refused > 1 ? `${first} (and ${refused - 1} more)` : first;
}

/**
 * The write targets a snapshot other than the reviewer's patch set (HTTP 409):
 * a stale tab, or another tab started a patch set on a different revision.
 */
export class StaleSnapshotError extends Error {}

const REVIEW_ID = /^[0-9a-hjkmnp-tv-z]{26}$/;
const STATES = new Set(["unreviewed", "reviewed", "crossed-off"]);
const VERBS = {
	unreviewed: "reset",
	reviewed: "reviewed",
	"crossed-off": "crossed off",
} as const;

/** Which view of a PR a review is of (dev and pinned modes; see prKey). */
export interface PrView {
	/** As of this cutoff (canonical ISO). */
	asOf?: string;
	/** Pinned on this head commit (full OID, crb --head). */
	head?: string;
}

/**
 * The source key: `<owner>/<repo>#<number>`, lowercased. As of a cutoff
 * (dev mode), `@<cutoff>` follows; pinned on a head (crb --head),
 * `^<head>`. Each such view gets a review of its own and never touches the
 * PR's real one. (`^` never occurs in an ISO time, `@` never in an OID.)
 */
export const prKey = (pr: ReviewPr, view: PrView = {}) =>
	`${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}#${pr.number}${view.asOf ? `@${view.asOf}` : ""}${view.head ? `^${view.head}` : ""}`;
const lookupRef = (key: string) =>
	`refs/crb/lookup/github-pr/${createHash("sha256").update(key).digest("hex")}`;
const reviewRef = (id: string) => `refs/crb/reviews/${id}`;
const reviewerRef = (id: string, slug: string) =>
	`${reviewRef(id)}/reviewers/${slug}`;

/**
 * Reviews of GitHub pull requests and each reviewer's patch sets and cluster
 * states, stored in crb refs. See docs/review-data-storage.md.
 */
export class ReviewService {
	constructor(private readonly store: RefStore) {}

	/** The review of this PR (or of `view` of it), or null if nobody started one. */
	findReview(pr: ReviewPr, view: PrView = {}): Promise<string | null> {
		return this.#readLookup(lookupRef(prKey(pr, view)));
	}

	/**
	 * The review of this PR, created (meta and lookup refs) on first use.
	 * `view`: the separate review of the PR as of a cutoff, or pinned on a
	 * head; its `review-created` event records which in `details`.
	 */
	async findOrCreateReview(
		pr: ReviewPr,
		actor: string,
		view: PrView = {},
	): Promise<string> {
		checkSlug(actor);
		const key = prKey(pr, view);
		const lookup = lookupRef(key);
		const found = await this.#readLookup(lookup);
		if (found) return found;

		const id = ulid().toLowerCase();
		const { owner, repo, number, url, baseBranch, headBranch, headRepo } = pr;
		const event = newEvent("review-created", actor, {
			source: "github-pr",
			key,
			pr: { owner, repo, number, url, baseBranch, headBranch, headRepo },
			...(view.asOf || view.head
				? {
						details: {
							...(view.asOf ? { asOf: view.asOf } : {}),
							...(view.head ? { head: view.head } : {}),
						},
					}
				: {}),
		});
		const commit = await this.store.commit(
			null,
			`crb: created review of ${key}`,
			[event],
			actor,
		);
		const blob = await this.store.writeBlob(`${id}\n`);
		try {
			await this.store.transaction([
				{ ref: `${reviewRef(id)}/meta`, newOid: commit, oldOid: null },
				{ ref: lookup, newOid: blob, oldOid: null },
			]);
			return id;
		} catch (error) {
			if (!(error instanceof RefConflictError)) throw error;
			// Someone else created the review first: use theirs.
			const winner = await this.#readLookup(lookup);
			if (winner) return winner;
			throw error;
		}
	}

	async getProgress(reviewId: string, slug: string): Promise<ProgressState> {
		checkReviewId(reviewId);
		checkSlug(slug);
		return foldProgress(
			await this.store.readEvents(`${reviewerRef(reviewId, slug)}/progress`),
		);
	}

	/**
	 * Records the reviewer's cluster state changes against `snapshot`. The
	 * first change starts patch set 1 on the snapshot's revision and pins its
	 * head; after that, only that revision's snapshot is accepted. Every
	 * change is validated before anything is written.
	 */
	async recordStates(
		reviewId: string,
		slug: string,
		snapshot: Snapshot,
		changes: StateChange[],
	): Promise<ProgressState> {
		checkReviewId(reviewId);
		checkSlug(slug);
		const pathOf = new Map<string, string>();
		for (const file of snapshot.files) {
			for (const c of file.clusters) pathOf.set(c.key, file.path);
		}
		// Every refused change is named, not just the first.
		const unknown = changes.filter((c) => !pathOf.has(c.key));
		const [firstUnknown] = unknown;
		if (firstUnknown) {
			throw new UnknownClusterError(
				refusedMessage(
					`No cluster ${firstUnknown.key} in this snapshot`,
					unknown.length,
				),
				unknown.map((c) => c.key),
			);
		}
		const invalid = changes.filter((c) => !STATES.has(c.state));
		const [firstInvalid] = invalid;
		if (firstInvalid) {
			throw new InvalidChangeError(
				refusedMessage(
					`Unknown cluster state: ${firstInvalid.state}`,
					invalid.length,
				),
				invalid.map((c) => c.key),
			);
		}
		const payloads = changes.map(({ key, state, reason }) => {
			const path = pathOf.get(key) ?? "";
			// The reason is optional; a blank one isn't stored.
			const trimmed = state === "crossed-off" ? reason?.trim() : undefined;
			return {
				patchset: snapshot.revision,
				cluster: key,
				path,
				state,
				...(trimmed ? { reason: trimmed } : {}),
			};
		});

		const ref = `${reviewerRef(reviewId, slug)}/progress`;
		const existing = await this.store.readEvents(ref);
		const progress = foldProgress(existing);
		// The fold orders by (ts, id): stamp every new event after everything
		// already stored, so a backward clock step can't put a reset before the
		// state it undoes.
		// A loop, not Math.max(...): spreading ~100k events overflows the stack.
		let lastTs = -1;
		for (const e of existing) if (e.ts > lastTs) lastTs = e.ts;
		const stamp = () => {
			lastTs = Math.max(Date.now(), lastTs + 1);
			return lastTs;
		};
		if (progress.patchset) checkRevision(progress, snapshot);
		else if (payloads.length > 0) {
			await this.#startPatchset(ref, slug, snapshot, stamp());
		}

		for (const payload of payloads) {
			const event: ClusterStateEvent = newEvent(
				"cluster-state",
				slug,
				payload,
				"human",
				stamp(),
			);
			await this.store.appendEvent(
				ref,
				`crb: ${VERBS[event.state]} 1 cluster in ${event.path}`,
				event,
				slug,
			);
		}
		return this.getProgress(reviewId, slug);
	}

	/** Starts patch set 1 on the snapshot, unless another tab just did. */
	async #startPatchset(
		ref: string,
		slug: string,
		snapshot: Snapshot,
		ts: number,
	): Promise<void> {
		const tip = await this.store.tip(ref);
		const event = newEvent(
			"patchset-started",
			slug,
			{
				patchset: 1,
				revision: snapshot.revision,
				mergeBase: snapshot.base,
				head: snapshot.head,
			},
			"human",
			ts,
		);
		const commit = await this.store.commit(
			tip,
			"crb: started PS1",
			[event],
			slug,
		);
		try {
			await this.store.transaction([
				{ ref, newOid: commit, oldOid: tip },
				{
					ref: ref.replace(/\/progress$/, "/patchsets/1"),
					newOid: snapshot.head,
					oldOid: null,
				},
			]);
		} catch (error) {
			if (!(error instanceof RefConflictError)) throw error;
			const progress = foldProgress(await this.store.readEvents(ref));
			if (!progress.patchset) throw error;
			checkRevision(progress, snapshot);
		}
	}

	async #readLookup(ref: string): Promise<string | null> {
		const oid = await this.store.tip(ref);
		if (!oid) return null;
		const id = (
			await runGit(this.store.repo, ["cat-file", "blob", oid])
		).trim();
		if (!REVIEW_ID.test(id)) {
			throw new Error(`Lookup ref ${ref} doesn't hold a review id`);
		}
		return id;
	}
}

function checkRevision(progress: ProgressState, snapshot: Snapshot): void {
	const { patchset } = progress;
	if (patchset && patchset.revision !== snapshot.revision) {
		throw new StaleSnapshotError(
			`Patch set ${patchset.number} is on another revision; reload the review`,
		);
	}
}

function checkSlug(slug: string): void {
	if (!isSlug(slug)) throw new Error(`Invalid reviewer slug: ${slug}`);
}

function checkReviewId(id: string): void {
	if (!REVIEW_ID.test(id)) throw new Error(`Invalid review id: ${id}`);
}
