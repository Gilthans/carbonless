import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "ulid";
import { type LineRanges, parseRanges, size } from "../../shared/lineRanges.js";
import { changeFor, fitRanges, sinceMarkKey } from "../../shared/pieces.js";
import type {
	Cluster,
	SinceMark,
	Snapshot,
	StateChange,
} from "../../shared/types.js";
import { runGit } from "../git.js";
import {
	type CarriedEvent,
	type ClusterStateEvent,
	type CrbEvent,
	type EventBase,
	isSlug,
	newEvent,
	parseEventLines,
	type ReviewCreatedEvent,
	type ShapeCode,
	type ThreadAnchorRef,
} from "./events.js";
import { foldProgress, type ProgressState } from "./fold.js";
import { RefConflictError, RefStore } from "./refStore.js";

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
 * The write targets a snapshot that is no patch set of the reviewer's and
 * no start was given (HTTP 409): a stale tab, or another tab started a
 * patch set on a different snapshot.
 */
export class StaleSnapshotError extends Error {}

/** The write targets an earlier patch set: those are read-only (HTTP 409). */
export class ReadOnlyPatchsetError extends StaleSnapshotError {}

/**
 * What starting patch set n+1 records: the patch set it follows and how
 * the snapshot relates to it (null when unknown, or for PS1), and the
 * engine's carries into it (`to` is filled in; one event per rule).
 */
export interface PatchsetStart {
	since: number | null;
	shape: ShapeCode | null;
	baseBranch: string | null;
	interdiff: "available" | "unavailable" | null;
	carried: Omit<CarriedEvent, keyof EventBase | "to">[];
}

/** PS1's start: nothing before it, nothing carried. */
const FIRST_START: PatchsetStart = {
	since: null,
	shape: null,
	baseBranch: null,
	interdiff: null,
	carried: [],
};

/** Lost races on the progress ref a start retries before giving up. */
const START_TRIES = 8;

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
const progressRef = (id: string, slug: string) =>
	`${reviewerRef(id, slug)}/progress`;
/** The refs pinning patch set `n`'s head and merge base (storage doc, "Ref layout"). */
export const patchsetRefs = (reviewer: string, n: number) => ({
	head: `${reviewer}/patchsets/${n}`,
	base: `${reviewer}/patchsets/${n}-base`,
});

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
			await this.store.readEvents(progressRef(reviewId, slug)),
		);
	}

	/**
	 * The OIDs patch set `n`'s pin refs hold (null for a missing ref: a
	 * patch set started before the -base ref existed has none).
	 */
	async patchsetPins(
		reviewId: string,
		slug: string,
		n: number,
	): Promise<{ head: string | null; base: string | null }> {
		checkReviewId(reviewId);
		checkSlug(slug);
		checkPatchsetNumber(n);
		const refs = patchsetRefs(reviewerRef(reviewId, slug), n);
		const [head, base] = await Promise.all([
			this.store.tip(refs.head),
			this.store.tip(refs.base),
		]);
		return { head, base };
	}

	/**
	 * Makes `snapshot` the reviewer's latest patch set, unless it already is
	 * one of theirs (then nothing is written, whatever `start` says): one
	 * commit holding `patchset-started` (n+1, since, shape) and the carried
	 * events, and one transaction moving the progress ref and creating the
	 * two pin refs (so a second start of the same number fails and reads
	 * again). A lost race on the progress ref is retried. `start.since` must
	 * be the latest patch set's number (null with none): a start computed
	 * against an older one is refused as stale, whenever it arrives.
	 */
	async ensurePatchset(
		reviewId: string,
		slug: string,
		snapshot: Snapshot,
		start: PatchsetStart,
	): Promise<ProgressState> {
		checkReviewId(reviewId);
		checkSlug(slug);
		const ref = progressRef(reviewId, slug);
		for (let attempt = 1; ; attempt++) {
			// The tip first, then the events: a fold newer than the parent only
			// makes the compare-and-swap fail and retry, never the reverse.
			const tip = await this.store.tip(ref);
			const existing = await this.store.readEvents(ref);
			const progress = foldProgress(existing);
			if (progress.patchsets.some((p) => p.revision === snapshot.revision)) {
				return progress;
			}
			// `since` and the carries were computed against the latest patch
			// set as the caller saw it. If that is not the latest now (another
			// tab or process started one, or the caller believes in a PS1 that
			// isn't there), landing them would skip that patch set's human
			// states (principle 2): the caller computes the start again.
			const latest = progress.patchset?.number ?? null;
			if (start.since !== latest) {
				throw new StaleSnapshotError(
					latest === null
						? "No patch set yet; reload the review"
						: `Patch set ${latest} is the latest; reload the review`,
				);
			}
			try {
				await this.#startPatchset(
					reviewId,
					slug,
					snapshot,
					start,
					tip,
					latest ?? 0,
					stamper(existing),
				);
				return this.getProgress(reviewId, slug);
			} catch (error) {
				if (!(error instanceof RefConflictError) || attempt >= START_TRIES) {
					throw error;
				}
			}
		}
	}

	/**
	 * Records the reviewer's cluster state changes against `snapshot`. The
	 * first change ever starts patch set 1 on the snapshot; a change against
	 * a snapshot that is no patch set yet starts the next one when `start`
	 * says how (ensurePatchset), else is stale. An earlier patch set is
	 * read-only. Every change is validated before anything is written.
	 */
	async recordStates(
		reviewId: string,
		slug: string,
		snapshot: Snapshot,
		changes: StateChange[],
		start?: PatchsetStart,
	): Promise<ProgressState> {
		checkReviewId(reviewId);
		checkSlug(slug);
		const pathOf = new Map<string, string>();
		const clusterOf = new Map<string, Cluster>();
		for (const file of snapshot.files) {
			for (const c of file.clusters) {
				pathOf.set(c.key, file.path);
				clusterOf.set(c.key, c);
			}
		}
		// A mark on since-only pieces goes by its own key (sinceMarkKey).
		const marks = changes.filter((c) => c.sinceMark !== undefined);
		const clusterChanges = changes.filter((c) => c.sinceMark === undefined);
		// Every refused change is named, not just the first.
		const unknown = clusterChanges.filter((c) => !pathOf.has(c.key));
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
		// Part of a cluster: only with unreviewed, and only lines it has
		// (principle 2: a mark never reaches past what the reviewer marked).
		const badLines = clusterChanges.filter((c) => {
			if (c.reviewedLines === undefined && c.crossedLines === undefined) {
				return false;
			}
			const cluster = clusterOf.get(c.key) as Cluster;
			return (
				c.state !== "unreviewed" ||
				c.reason !== undefined ||
				fitRanges(cluster, c.reviewedLines ?? []) === null ||
				fitRanges(cluster, c.crossedLines ?? []) === null
			);
		});
		const badMarks = marks.filter((c) => !sinceMarkOk(c));
		const refused = [...badLines, ...badMarks];
		const [firstBad] = refused;
		if (firstBad) {
			throw new InvalidChangeError(
				refusedMessage(
					`Lines past cluster ${firstBad.key}, or not a valid mark of part of it`,
					refused.length,
				),
				refused.map((c) => c.key),
			);
		}
		const payloads = clusterChanges.map((change) => {
			const { key, state, reason } = change;
			const path = pathOf.get(key) ?? "";
			// The reason is optional; a blank one isn't stored.
			const trimmed = state === "crossed-off" ? reason?.trim() : undefined;
			const cluster = clusterOf.get(key) as Cluster;
			const parted =
				change.reviewedLines !== undefined || change.crossedLines !== undefined;
			// A whole mark when one covers every line, or none is marked.
			const normal = parted
				? changeFor(
						cluster,
						change.reviewedLines ?? [],
						change.crossedLines ?? [],
					)
				: change;
			const lines =
				normal.reviewedLines || normal.crossedLines
					? {
							reviewed: normal.reviewedLines ?? [],
							crossed: normal.crossedLines ?? [],
						}
					: null;
			return {
				cluster,
				lines,
				payload: {
					patchset: snapshot.revision,
					cluster: key,
					path,
					state: normal.state,
					...(trimmed && !parted ? { reason: trimmed } : {}),
				},
			};
		});

		const ref = progressRef(reviewId, slug);
		let existing = await this.store.readEvents(ref);
		let progress = foldProgress(existing);
		const known = progress.patchsets.some(
			(p) => p.revision === snapshot.revision,
		);
		// A since mark names an earlier patch set of the reviewer's.
		const earlier = new Set(
			progress.patchsets
				.filter((p) => p.revision !== snapshot.revision)
				.map((p) => p.number),
		);
		const stale = marks.filter(
			(c) => !earlier.has((c.sinceMark as SinceMark).since),
		);
		const [firstStale] = stale;
		if (firstStale) {
			throw new InvalidChangeError(
				refusedMessage(
					`No earlier patch set ${firstStale.sinceMark?.since}`,
					stale.length,
				),
				stale.map((c) => c.key),
			);
		}
		if (known) checkWritable(progress, snapshot);
		else if (changes.length > 0) {
			// PS1 needs no start; a later one does (else the tab is stale).
			const how = start ?? (progress.patchset ? null : FIRST_START);
			if (!how) checkWritable(progress, snapshot);
			else {
				await this.ensurePatchset(reviewId, slug, snapshot, how);
				existing = await this.store.readEvents(ref);
				progress = foldProgress(existing);
				checkWritable(progress, snapshot);
			}
		}
		const stamp = stamper(existing);

		for (const { cluster, lines, payload } of payloads) {
			if (lines === null) {
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
				continue;
			}
			// Part of it: the whole cluster unreviewed, then its marked lines,
			// in one commit (a reader that predates lines-state sees it
			// unreviewed, never more reviewed than the reviewer marked).
			const { patchset, path } = payload;
			const events: CrbEvent[] = [
				newEvent(
					"cluster-state",
					slug,
					{ patchset, cluster: cluster.key, path, state: "unreviewed" },
					"human",
					stamp(),
				),
			];
			for (const [state, ranges] of [
				["reviewed", lines.reviewed],
				["crossed-off", lines.crossed],
			] as const) {
				if (ranges.length === 0) continue;
				events.push(
					newEvent(
						"lines-state",
						slug,
						{ patchset, cluster: cluster.key, path, state, lines: ranges },
						"human",
						stamp(),
					),
				);
			}
			await this.store.appendEvents(
				ref,
				`crb: marked ${size(lines.reviewed) + size(lines.crossed)} of ${cluster.lines} lines of 1 cluster in ${path}`,
				events,
				slug,
			);
		}
		for (const change of marks) {
			const mark = change.sinceMark as SinceMark;
			const event = newEvent(
				"since-lines-state",
				slug,
				{
					patchset: snapshot.revision,
					since: mark.since,
					path: mark.path,
					reviewed: sides(mark.reviewed),
					crossed: sides(mark.crossed),
				},
				"human",
				stamp(),
			);
			await this.store.appendEvent(
				ref,
				`crb: marked pieces since PS${mark.since} in ${mark.path}`,
				event,
				slug,
			);
		}
		return this.getProgress(reviewId, slug);
	}

	/**
	 * Appends the reviewer's placement of a thread in patch set `patchset`
	 * (a thread-placed event by them; the anchor was checked against the
	 * patch set's snapshot by the caller).
	 */
	async recordPlacement(
		reviewId: string,
		slug: string,
		patchset: number,
		thread: string,
		anchor: ThreadAnchorRef,
		engine: number,
	): Promise<ProgressState> {
		checkReviewId(reviewId);
		checkSlug(slug);
		checkPatchsetNumber(patchset);
		const ref = progressRef(reviewId, slug);
		const existing = await this.store.readEvents(ref);
		const progress = foldProgress(existing);
		if (!progress.patchsets.some((p) => p.number === patchset)) {
			throw new StaleSnapshotError(
				`No patch set ${patchset}; reload the review`,
			);
		}
		const event = newEvent(
			"thread-placed",
			slug,
			{ thread, patchset, anchor, engine },
			"human",
			stamper(existing)(),
		);
		await this.store.appendEvent(
			ref,
			`crb: placed thread in ${anchor.path} on PS${patchset}`,
			event,
			slug,
		);
		return this.getProgress(reviewId, slug);
	}

	/**
	 * Writes patch set n+1 on the snapshot: the start and the carries in one
	 * commit on the progress ref's tip, and the ref moves with the two pin
	 * refs created in one transaction. A RefConflictError when the progress
	 * ref moved or a pin ref of that number already exists (another tab).
	 */
	async #startPatchset(
		reviewId: string,
		slug: string,
		snapshot: Snapshot,
		start: PatchsetStart,
		/** The progress ref's tip the start builds on (null: no ref yet). */
		tip: string | null,
		/** The latest patch set's number (0: none). */
		latest: number,
		stamp: () => number,
	): Promise<void> {
		const ref = progressRef(reviewId, slug);
		const number = latest + 1;
		const { since, shape, baseBranch, interdiff } = start;
		const started = newEvent(
			"patchset-started",
			slug,
			{
				patchset: number,
				revision: snapshot.revision,
				mergeBase: snapshot.base,
				head: snapshot.head,
				...(since !== null ? { since } : {}),
				...(shape !== null ? { shape } : {}),
				...(baseBranch !== null ? { baseBranch } : {}),
				...(interdiff !== null ? { interdiff } : {}),
			},
			"human",
			stamp(),
		);
		const carried = start.carried.map(({ from, rule, states }) =>
			newEvent(
				"carried",
				slug,
				{
					from,
					to: number,
					rule,
					// An entry carried from the same key says so by omission:
					// half the bytes of the common case (see the storage doc).
					states: states.map(({ key, fromKey, state }) =>
						fromKey === undefined || fromKey === key
							? { key, state }
							: { key, fromKey, state },
					),
				},
				"auto",
				stamp(),
			),
		);
		const total = carried.reduce((n, e) => n + e.states.length, 0);
		const summary =
			total > 0
				? `crb: started PS${number}, carried ${total} cluster${total === 1 ? "" : "s"} from PS${since ?? "?"}`
				: `crb: started PS${number}`;
		const commit = await this.store.commit(
			tip,
			summary,
			[started, ...carried],
			slug,
		);
		const refs = patchsetRefs(reviewerRef(reviewId, slug), number);
		await this.store.transaction([
			{ ref, newOid: commit, oldOid: tip },
			{ ref: refs.head, newOid: snapshot.head, oldOid: null },
			{ ref: refs.base, newOid: snapshot.base, oldOid: null },
		]);
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

/**
 * The fold orders by (ts, id): a stamper gives every new event a time after
 * everything already stored, so a backward clock step can't put a reset
 * before the state it undoes.
 */
/** Normalized `{ old, new }` ranges (checked by sinceMarkOk). */
const sides = (s: { old: LineRanges; new: LineRanges }) => ({
	old: parseRanges(s.old) ?? [],
	new: parseRanges(s.new) ?? [],
});

/** Longest path a since mark may name. */
const MAX_PATH = 4096;

/**
 * A since mark as the store can take it: its key its own, a positive
 * patch set number, a path of printable characters, and ranges.
 */
function sinceMarkOk(change: StateChange): boolean {
	const mark = change.sinceMark;
	if (!mark || change.reviewedLines || change.crossedLines) return false;
	const { since, path } = mark;
	return (
		Number.isSafeInteger(since) &&
		since > 0 &&
		typeof path === "string" &&
		path.length > 0 &&
		path.length <= MAX_PATH &&
		// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them.
		!/[\u0000-\u001f\u007f]/.test(path) &&
		change.key === sinceMarkKey(since, path) &&
		[
			mark.reviewed?.old,
			mark.reviewed?.new,
			mark.crossed?.old,
			mark.crossed?.new,
		].every((r) => parseRanges(r) !== null)
	);
}

function stamper(existing: CrbEvent[]): () => number {
	// A loop, not Math.max(...): spreading ~100k events overflows the stack.
	let lastTs = -1;
	for (const e of existing) if (e.ts > lastTs) lastTs = e.ts;
	return () => {
		lastTs = Math.max(Date.now(), lastTs + 1);
		return lastTs;
	};
}

/**
 * Whether the snapshot takes writes: it must be the reviewer's latest
 * patch set. An earlier one is read-only; a snapshot that is none of
 * theirs is stale (another tab moved on, or no start was given).
 */
function checkWritable(progress: ProgressState, snapshot: Snapshot): void {
	const { patchset } = progress;
	if (!patchset || patchset.revision === snapshot.revision) return;
	const old = progress.patchsets.find((p) => p.revision === snapshot.revision);
	if (old) {
		throw new ReadOnlyPatchsetError(
			`Patch set ${old.number} is read-only; patch set ${patchset.number} is the latest`,
		);
	}
	throw new StaleSnapshotError(
		`Patch set ${patchset.number} is on another snapshot; reload the review`,
	);
}

function checkPatchsetNumber(n: number): void {
	if (!Number.isSafeInteger(n) || n < 1) {
		throw new Error(`Invalid patch set number: ${n}`);
	}
}

function checkSlug(slug: string): void {
	if (!isSlug(slug)) throw new Error(`Invalid reviewer slug: ${slug}`);
}

export function checkReviewId(id: string): void {
	if (!REVIEW_ID.test(id)) throw new Error(`Invalid review id: ${id}`);
}

/** A review as its meta ref records it: which PR, and which view of it. */
export interface StoredReview {
	id: string;
	/** The source key (prKey). */
	key: string;
	pr: ReviewPr;
	/** As of this cutoff (dev mode). */
	asOf?: string;
	/** Pinned on this head (crb --head). */
	head?: string;
}

const META = /^refs\/crb\/reviews\/([0-9a-hjkmnp-tv-z]{26})\/meta$/;

function storedReview(id: string, events: CrbEvent[]): StoredReview | null {
	const created = events.find(
		(e): e is ReviewCreatedEvent => e.type === "review-created",
	);
	if (!created) return null;
	const { asOf, head } = created.details ?? {};
	return {
		id,
		key: created.key,
		pr: created.pr,
		...(typeof asOf === "string" ? { asOf } : {}),
		...(typeof head === "string" ? { head } : {}),
	};
}

/**
 * The repo's reviews whose meta refs match `pattern`, read in one git call
 * from the tips' messages (the meta ref's tip is its review-created commit);
 * a tip that isn't falls back to reading the whole ref.
 */
async function readMetas(
	repoDir: string,
	pattern: string,
): Promise<StoredReview[]> {
	const out = await runGit(repoDir, [
		"-c",
		"i18n.logOutputEncoding=UTF-8",
		"for-each-ref",
		"--format=%(refname)%00%(contents)%00",
		pattern,
	]);
	const parts = out.split("\0");
	const found: (StoredReview | null | Promise<StoredReview | null>)[] = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const ref = (parts[i] ?? "").trim();
		const id = META.exec(ref)?.[1];
		if (!id) continue;
		const tip = storedReview(id, parseEventLines(parts[i + 1] ?? ""));
		found.push(
			tip ??
				new RefStore(repoDir).readEvents(ref).then((e) => storedReview(id, e)),
		);
	}
	return (await Promise.all(found)).filter(
		(r): r is StoredReview => r !== null,
	);
}

/** Every review in a clone, from its meta refs (Home's started scan). */
export function listReviews(repoDir: string): Promise<StoredReview[]> {
	return readMetas(repoDir, "refs/crb/reviews/*/meta");
}

/**
 * The review `id` and the clone that holds it, searched among the cache's
 * clones (`<cacheRoot>/repos/<owner>/<repo>.git`): how a server that never
 * opened it (a restart, a bookmark) finds it. Null when none has it.
 */
export async function findReviewById(
	cacheRoot: string,
	id: string,
): Promise<{ repoDir: string; review: StoredReview } | null> {
	if (!REVIEW_ID.test(id)) return null;
	const repos = join(cacheRoot, "repos");
	const dirs = async (dir: string) =>
		(await readdir(dir, { withFileTypes: true }).catch(() => []))
			.filter((d) => d.isDirectory())
			.map((d) => join(dir, d.name));
	const clones = (await Promise.all((await dirs(repos)).map(dirs)))
		.flat()
		.filter((d) => d.endsWith(".git"));
	const hits = await Promise.all(
		clones.map(async (repoDir) => {
			const [review] = await readMetas(
				repoDir,
				`refs/crb/reviews/${id}/meta`,
			).catch(() => []);
			return review ? { repoDir, review } : null;
		}),
	);
	return hits.find((h) => h !== null) ?? null;
}
