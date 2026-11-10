import { overlayCarries } from "../shared/rereview/overlay.js";
import type {
	CommentsView,
	DeleteAnswer,
	DiffLine,
	EditRequest,
	FileHunks,
	HunksBatch,
	NewThreadAnswer,
	NewThreadRequest,
	PrOverview,
	ReplyRequest,
	RereviewAnswer,
	ReviewView,
	SessionInfo,
	Snapshot,
	StateChange,
	ThreadsStage,
	ThreadsView,
	ThreadUpdate,
	TimelineView,
	VerdictAnswer,
	VerdictFacts,
	VerdictRequest,
} from "../shared/types.js";
import { type AgentHost, reviewAgentHost } from "./agent/host.js";
import { ensureClone, ensureCommit, fetchPr } from "./clone.js";
import {
	buildSnapshot,
	loadContext,
	loadFileHunks,
	loadHunksBatch,
	snapshotId,
} from "./diff/snapshot.js";
import { WriteRefusedError } from "./errors.js";
import {
	fetchHeadAsOf,
	fetchMergeBase,
	fetchPinnedHead,
	fetchPrMeta,
	fetchRuleReads,
	fetchVerdict,
	fetchVerdictAsOf,
	type PrMeta,
	type PrRef,
	resolvePrRef,
	runGh,
	viewerSlug,
} from "./gh.js";
import { runGit } from "./git.js";
import {
	type NewThreadTarget,
	type StartedRecord,
	startThread,
} from "./newThreads.js";
import { OverviewRead } from "./overviewRead.js";
import type { HeadSpec } from "./pinnedHead.js";
import { RereviewCache } from "./rereview/cache.js";
import {
	answerRereview,
	type EarlierPatchset,
	interdiffFileHunks,
	rereviewKey,
	type SincePatchset,
	type TargetSnapshot,
	type Traced,
	traceRereview,
} from "./rereview/engine.js";
import { checkOid, commitsSince } from "./rereview/shape.js";
import { buildReviewView } from "./review/coverage.js";
import type { PatchsetRecord, ProgressState } from "./review/fold.js";
import { RefStore } from "./review/refStore.js";
import {
	type PatchsetStart,
	ReadOnlyPatchsetError,
	ReviewService,
	StaleSnapshotError,
} from "./review/reviews.js";
import { readSeen, type Seen, writeSeen } from "./seen.js";
import { slugify } from "./slug.js";
import { ThreadCodeSource } from "./threadCode.js";
import {
	deleteThreadComment,
	editComment,
	type PostedRecord,
	replyToThread,
	setResolved,
	type ThreadWriteTarget,
} from "./threadWrites.js";
import { type Tracer, tracer } from "./trace.js";
import {
	mapVerdict,
	ruleOf,
	submitVerdict,
	type VerdictRecord,
	type VerdictTarget,
} from "./verdict.js";

/** Reads kept for pages still showing them (see Session.threads). */
const KEPT_READS = 3;

/** commentLeft for one snapshot: asked of GitHub, then known. */
interface CommentLeft {
	/** The snapshot's base and head. */
	key: string;
	left: Promise<boolean>;
	known?: boolean;
	/** When the compare failed (ms): asked again after COMMENT_LEFT_RETRY_MS. */
	failedAt?: number;
}

/** How long a failed compare stands before commentLeft asks again. */
const COMMENT_LEFT_RETRY_MS = 30_000;

/** The write queue new threads share (one PR's: one at a time). */
const NEW_THREADS = "new-threads";
/** The write queue verdicts share (one PR's: one at a time). */
const VERDICTS = "verdicts";

/** A read of what blocks the merge (Session.verdict). */
interface VerdictReadState {
	facts: Promise<VerdictFacts>;
	/** When it started, and came in (ms); null while under way. */
	started: number;
	ended: number | null;
}

/** A read of the overview that is no longer kept (HTTP 410). */
export class UnknownReadError extends Error {}

/** The session has closed (crb shutting down): HTTP 503. */
export class SessionClosedError extends Error {}

/** crb --head and the hidden dev options (--as-of, --viewer). */
export interface SessionOptions {
	/**
	 * Show the PR as of this cutoff (canonical ISO, see parseAsOf): head and
	 * base as they were, overview filtered to it, its own review.
	 */
	asOf?: string;
	/** The GitHub login treated as "you" on the overview, in place of the gh login. */
	viewer?: string;
	/**
	 * Pin the snapshot's head on this commit (resolved once, at open): the
	 * three-dot diff of the current base branch and it, in a review of its
	 * own. Everything else stays live. Not with `asOf`.
	 */
	head?: HeadSpec;
}

/** Comparison endpoints: merge-base(origin/<base>, head) → head. */
interface Endpoints {
	mergeBase: string;
	head: string;
}

/**
 * The engine's work for one comparison (`Session.rereview`), started on
 * the first ask and never waited for: the answer says `pending` until
 * `done`, and a failure is reported once and the job forgotten.
 */
interface RereviewJob {
	done: { target: Snapshot; traced: Traced } | null;
	error: Error | null;
	settled: Promise<void>;
}

/**
 * Why a PR has no review to open: merged, closed (reopening it on GitHub is
 * the way back), or, for an open PR, that its review couldn't be read.
 */
export function refusal(
	meta: Pick<PrMeta, "owner" | "repo" | "number" | "state">,
): string {
	const pr = `PR ${meta.owner}/${meta.repo}#${meta.number}`;
	switch (meta.state) {
		case "MERGED":
			return `${pr} is already merged; nothing to review`;
		case "CLOSED":
			return `${pr} is closed; reopen it on GitHub to review`;
		default:
			return `Could not open the review of ${pr}`;
	}
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
	/** The reviewer's patch sets as last folded (info().patchsets). */
	#patchsets: PatchsetRecord[];
	/** The PR's head on the previous open of this review here; null on the first. */
	readonly #lastSeen: Seen | null;
	/**
	 * Earlier patch sets' snapshots, rebuilt from their pins on request
	 * (reviewAt), by snapshot id: their hunks and context serve like the
	 * current one's. Few per reviewer, so never evicted.
	 */
	readonly #snapshots = new Map<string, Snapshot>();
	/** Order of PR metadata requests, by start; see #setMeta. */
	#metaSeq = 0;
	#metaSeqApplied = 0;
	/** Thread code from the clone; a Refresh retries what failed. */
	readonly #threadCode: ThreadCodeSource;
	/** Reads of GitHub, oldest first; see overview(). */
	#reads: OverviewRead[] = [];
	/** Every read not settled yet, kept or not: close() stops them all. */
	readonly #live = new Set<OverviewRead>();
	/** Reads a Refresh replaced: their threads still serve, their overview not. */
	readonly #superseded = new WeakSet<OverviewRead>();
	/** Serializes everything that writes or swaps the snapshot. */
	#queue: Promise<unknown> = Promise.resolve();
	/** Orders thread writes' re-reads (OverviewRead.applyWrite). */
	#writeSeq = 0;
	/** Each thread's writes, one at a time (#threadExclusive). */
	readonly #threadWrites = new Map<string, Promise<void>>();
	/**
	 * Replies this session posted, by the client's id for each: a resend
	 * (while the first attempt runs, or after a reload) finds it here.
	 */
	readonly #posted = new Map<string, PostedRecord>();
	/** Client ids whose last attempt failed with its outcome unknown. */
	readonly #inDoubt = new Set<string>();
	/** Comments this session deleted (GraphQL may list them a while yet). */
	readonly #deletedComments = new Set<string>();
	/** Threads this session started, by the client's id for each. */
	readonly #started = new Map<string, StartedRecord>();
	/** commentLeft for one snapshot (its base and head): asked, then known. */
	#commentLeft: CommentLeft | null = null;
	/** The last read of what blocks the merge (verdict()); a Refresh drops it. */
	#verdictRead: VerdictReadState | null = null;
	/** Verdicts this session sent, by the client's id for each. */
	readonly #verdicts = new Map<string, VerdictRecord>();
	/** When this server first tried to post each verdict, by client id (ms). */
	readonly #verdictAttempts = new Map<string, number>();
	/** The PR's head on GitHub as last checked (info().head). */
	#head: SessionInfo["head"];
	/** The base branch name the snapshot was compared against (the triple's third). */
	#snapshotBase: string;
	/** Merge bases by (head, base oid, base branch): one fetch per triple (#noteHead). */
	readonly #fetchedHeads = new Map<string, Promise<{ mergeBase: string }>>();
	/** The engine's state-free results, in memory and on disk. */
	readonly #cache = new RereviewCache<Traced>();
	/** Comparisons being traced, by cache key (one computation per key). */
	readonly #tracing = new Map<string, Promise<Traced>>();
	/** Background engine jobs, by `${from}:${toHead}` (rereview). */
	readonly #jobs = new Map<string, RereviewJob>();
	/** Snapshots of viewed heads being built, by snapshot id. */
	readonly #building = new Map<string, Promise<Snapshot>>();

	private constructor(
		private readonly repo: string,
		private readonly viewer: string,
		private readonly reviewId: string,
		private readonly reviews: ReviewService,
		meta: PrMeta,
		snapshot: Snapshot,
		progress: ProgressState,
		lastSeen: Seen | null,
		private readonly options: SessionOptions,
		/** The commit `options.head` named; null without one. */
		private readonly pinned: string | null,
		head: SessionInfo["head"],
	) {
		this.#meta = meta;
		this.#snapshot = snapshot;
		this.#patchset = progress.patchset?.number ?? null;
		this.#patchsets = progress.patchsets;
		this.#lastSeen = lastSeen;
		this.#head = head;
		this.#snapshotBase = progress.patchset?.baseBranch ?? meta.baseBranch;
		if (head) this.#fetched(meta, head.mergeBase);
		this.#threadCode = new ThreadCodeSource(repo);
		this.#agent = this.writes() === "on" ? this.#makeAgent() : null;
		Session.#open.add(this);
	}

	/** The reviewer's agent; none as of a cutoff or as --viewer someone else. */
	readonly #agent: AgentHost | null;

	get agent(): AgentHost | null {
		return this.#agent;
	}

	#makeAgent(): AgentHost {
		return reviewAgentHost({
			repo: this.repo,
			reviewId: this.reviewId,
			viewer: this.viewer,
			meta: () => this.#meta,
			snapshot: () => this.#snapshot,
			prFacts: async () => {
				const o = await this.overview();
				return { title: o.title, body: o.body };
			},
			code: (anchor) =>
				this.#threadCode.code(
					anchor,
					{
						snapshot: this.#snapshot.base,
						ref: `refs/remotes/origin/${this.#meta.baseBranch}`,
					},
					async () => "",
				),
		});
	}

	/** Sessions not closed yet (closeAll). */
	static readonly #open = new Set<Session>();
	#closed: Promise<void> | null = null;
	/** Stops the session's own reads (Refresh, head check) on close. */
	readonly #stop = new AbortController();

	/**
	 * Stops its background reads of GitHub and the clone and waits until
	 * nothing of them runs: after this no gh or git starts for it.
	 */
	close(): Promise<void> {
		this.#closed ??= (async () => {
			Session.#open.delete(this);
			for (const read of this.#live) read.abort();
			// A Refresh or head check under way: its gh and fetch too.
			this.#stop.abort();
			this.#threadCode.close();
			await Promise.all([
				...[...this.#live].map((r) => r.settled),
				...[...this.#jobs.values()].map((j) => j.settled),
				this.#queue,
				// Its process, checkout and claim.
				this.#agent?.close(),
			]);
		})();
		return this.#closed;
	}

	/** Closes every open session (crb's shutdown; test fixtures' cleanup). */
	static async closeAll(): Promise<void> {
		await Promise.all([...Session.#open].map((s) => s.close()));
	}

	/**
	 * Opens the PR's review. `progress` gets one line per slow startup step
	 * (crb prints them to stderr).
	 */
	static async open(
		arg: string,
		cwd: string,
		progress: (message: string) => void = () => {},
		options: SessionOptions = {},
	): Promise<Session> {
		if (options.asOf && options.head) {
			throw new Error("--head can't be combined with --as-of");
		}
		// Opt-in ($CRB_TRACE_DIR): the open, with its slow steps under it.
		const traced = tracer();
		if (!traced.enabled) {
			return Session.#openReview(arg, cwd, progress, options, traced);
		}
		const span = traced.start("crb: open review");
		try {
			return await traced.run(span, () =>
				Session.#openReview(arg, cwd, progress, options, traced),
			);
		} catch (error) {
			span.end(undefined, (error as Error).message);
			throw error;
		} finally {
			span.end();
		}
	}

	static async #openReview(
		arg: string,
		cwd: string,
		progress: (message: string) => void,
		options: SessionOptions,
		traced: Tracer,
	): Promise<Session> {
		const step = <T>(name: string, run: () => Promise<T>): Promise<T> => {
			if (!traced.enabled) return run();
			const span = traced.start(name);
			return traced.run(span, run).finally(() => span.end());
		};
		await runGh(["auth", "status"]);
		const ref = await resolvePrRef(arg, cwd);
		// Independent reads: at once (each gh call is a few hundred ms).
		const [viewer, prMeta] = await Promise.all([
			viewerSlug(),
			fetchPrMeta(ref),
		]);
		const { asOf } = options;
		let meta = prMeta;
		if (asOf) {
			// The PR as it was: open, at its head of then.
			const headOid = await fetchHeadAsOf(meta, asOf);
			meta = { ...meta, headOid, state: "OPEN" };
		}
		const [repo, pinned] = await Promise.all([
			step("crb: clone", () =>
				ensureClone(meta.owner, meta.repo, () =>
					progress(`cloning ${meta.owner}/${meta.repo}…`),
				),
			),
			// The head is resolved once: the session keeps it for its life.
			options.head
				? fetchPinnedHead(
						meta,
						options.head,
						options.viewer ? slugify(options.viewer) : viewer,
					)
				: null,
		]);
		progress(`fetching PR #${meta.number}…`);
		const fetched = await step("crb: fetch pr", () =>
			fetchPr(repo, meta, {
				asOf,
				pinned: pinned ?? undefined,
			}),
		);
		// Whether the PR is over comes from GitHub's PR state, never from
		// history shape: squash and rebase merges leave the head outside the
		// base (docs/git-methodology.md). As of a cutoff, meta says OPEN.
		const over = meta.state !== "OPEN";
		const reviews = new ReviewService(new RefStore(repo));
		// A started review stays open once the PR is merged or closed; an
		// unstarted one has nothing left to show, so don't create it. A
		// pinned head has a review of its own: progress on the PR's review is
		// pinned on its own patch set's head.
		const view = { asOf, head: pinned ?? undefined };
		const reviewId = over
			? await reviews.findReview(meta, view)
			: await reviews.findOrCreateReview(meta, viewer, view);
		const state =
			reviewId === null ? null : await reviews.getProgress(reviewId, viewer);
		if (reviewId === null || state === null || (over && !state.patchset)) {
			throw new Error(refusal(meta));
		}
		// What the reviewer saw last time, then this time's head in its place.
		// Losing the note (an unwritable state dir) costs the toast its
		// "since you last looked", never the review.
		const lastSeen = await readSeen(reviewId);
		await writeSeen(reviewId, meta.headOid).catch(() => {});
		const { mergeBase, head } = state.patchset ?? fetched;
		const snapshot = await step("crb: snapshot", () =>
			buildSnapshot(repo, mergeBase, head),
		);
		// The PR's head as fetched: the graph's head dot, with its commits
		// over the patch set (none for a view that never moves on).
		const headInfo =
			over || asOf || pinned
				? null
				: {
						oid: fetched.head,
						mergeBase: fetched.mergeBase,
						baseBranch: meta.baseBranch,
						commits: await commitsSince(
							repo,
							head,
							fetched.head,
							fetched.mergeBase,
						),
					};
		return new Session(
			repo,
			viewer,
			reviewId,
			reviews,
			meta,
			snapshot,
			state,
			lastSeen,
			options,
			pinned,
			headInfo,
		);
	}

	/** The review's id (its `/r/<id>` URL). */
	get id(): string {
		return this.reviewId;
	}

	/** Whether close() has been called. */
	get closed(): boolean {
		return this.#closed !== null;
	}

	info(): SessionInfo {
		const { owner, repo, number, title, url, headOid } = this.#meta;
		return {
			pr: { owner, repo, number, title, url },
			viewer: this.viewer,
			snapshotHead: this.#snapshot.head,
			currentHead: headOid,
			// As of a cutoff the PR has obviously moved on since: never say so.
			headMoved: !this.options.asOf && headOid !== this.#snapshot.head,
			patchset: this.#patchset,
			asOf: this.options.asOf ?? null,
			pinnedHead: this.pinned,
			patchsets: this.#patchsets.map(
				({ number, head, mergeBase, startedAt, since, shape }) => ({
					number,
					head,
					mergeBase,
					startedAt,
					since,
					shape,
				}),
			),
			lastSeen: this.#lastSeen,
			head: this.#head,
		};
	}

	snapshot(): Snapshot {
		return this.#snapshot;
	}

	/**
	 * The engine's answer for patch set `from` to a target: another patch
	 * set (its pinned snapshot) or a head (its snapshot against the base
	 * branch's tip, as `GET /head` last found it). `pending` at once while
	 * it is computed in the background (started on the first ask, once per
	 * target snapshot; nothing of git is waited for here), then the answer
	 * under the marks as they stand. Jobs are keyed by the target's
	 * snapshot id, so a head whose merge base moved (a retarget, a base
	 * move) gets a fresh answer. A RangeError for a patch set that is none
	 * of the reviewer's; a failed computation is thrown once and tried
	 * again on the next ask.
	 */
	async rereview(
		from: number,
		to: { patchset: number } | { head: string },
	): Promise<RereviewAnswer | { pending: true }> {
		if (this.#closed) throw new SessionClosedError("The session is closed");
		const since = this.#patchsets.find((p) => p.number === from);
		if (!since) throw new RangeError(`No patch set ${from}`);
		let key: string;
		let snapshot: () => Promise<Snapshot>;
		if ("patchset" in to) {
			const record = this.#patchsets.find((p) => p.number === to.patchset);
			if (!record) throw new RangeError(`No patch set ${to.patchset}`);
			key = `${since.revision}:${record.revision}`;
			snapshot = () => this.#snapshotOf(record);
		} else {
			const head = checkOid(to.head);
			// The snapshot id when the head's merge base is known (the PR's
			// head as last checked); the head alone until then, and the job
			// is filed under its snapshot id once built.
			key =
				this.#head?.oid === head
					? `${since.revision}:${snapshotId(this.#head.mergeBase, head)}`
					: `${since.revision}:head:${head}`;
			snapshot = () => this.#headSnapshot(head);
		}
		let job = this.#jobs.get(key);
		if (!job) {
			const started: RereviewJob = {
				done: null,
				error: null,
				settled: Promise.resolve(),
			};
			started.settled = (async () => {
				try {
					const target = await snapshot();
					this.#jobs.set(`${since.revision}:${target.revision}`, started);
					const traced = await this.#traced(since, target);
					started.done = { target, traced };
				} catch (error) {
					started.error = error as Error;
				}
			})();
			this.#jobs.set(key, started);
			job = started;
		}
		if (job.error) {
			for (const [k, j] of this.#jobs) if (j === job) this.#jobs.delete(k);
			throw job.error;
		}
		if (!job.done) return { pending: true };
		const { target, traced } = job.done;
		return (await this.#answerFor(since, target, traced)).answer;
	}

	/**
	 * The review of the snapshot of `oid` against the base branch as it
	 * stands: a patch set of the reviewer's when its snapshot is one (a
	 * force-push back to an earlier head shows that patch set), else an
	 * unreviewed view with the engine's provisional carries laid over it
	 * when its answer is in (never waited for). The snapshot is kept, so
	 * its hunks and context load by its revision and a first mark, thread
	 * or verdict on it starts the patch set.
	 */
	async viewHead(oid: string): Promise<ReviewView> {
		const snapshot = await this.#headSnapshot(oid);
		const progress = await this.#progress();
		const view = buildReviewView(snapshot, progress);
		const since = progress.patchset;
		if (view.patchset !== null || !since) return view;
		const job = this.#jobs.get(`${since.revision}:${snapshot.revision}`);
		if (!job?.done || job.done.target.revision !== snapshot.revision) {
			return view;
		}
		const { answer } = await this.#answerFor(since, snapshot, job.done.traced);
		return overlayCarries(view, answer);
	}

	/**
	 * The since view's hunks of file `index` of the snapshot with this
	 * `revision`: the interdiff from patch set `from` (engine.ts,
	 * interdiffFileHunks). Waits for the engine (cached if the page asked
	 * for the answer already).
	 */
	async interdiffHunks(
		from: number,
		revision: string,
		index: number,
	): Promise<FileHunks> {
		const snapshot = this.#current(revision);
		const since = (await this.#progress()).patchsets.find(
			(p) => p.number === from,
		);
		if (!since) throw new RangeError(`No patch set ${from}`);
		const traced = await this.#traced(since, snapshot);
		const { answer } = await this.#answerFor(since, snapshot, traced);
		return interdiffFileHunks(traced, snapshot, answer, index);
	}

	/**
	 * The snapshot of `oid` against the base branch's tip: the current
	 * one, a kept one, or built now and kept (by snapshot id, so two asks
	 * build once). A commit the clone lacks is fetched by OID.
	 */
	async #headSnapshot(oid: string): Promise<Snapshot> {
		checkOid(oid);
		const signal = this.#stop.signal;
		const baseRef = `refs/remotes/origin/${this.#meta.baseBranch}`;
		const mergeBase = async () =>
			(
				await runGit(this.repo, ["merge-base", baseRef, oid], { signal })
			).trim();
		let base: string;
		try {
			base = await mergeBase();
		} catch (error) {
			if (!(await ensureCommit(this.repo, oid, signal))) throw error;
			base = await mergeBase();
		}
		const revision = snapshotId(base, oid);
		if (this.#snapshot.revision === revision) return this.#snapshot;
		const kept = this.#snapshots.get(revision);
		if (kept) return kept;
		let building = this.#building.get(revision);
		if (!building) {
			building = buildSnapshot(this.repo, base, oid)
				.then((snapshot) => {
					this.#snapshots.set(snapshot.revision, snapshot);
					return snapshot;
				})
				.finally(() => this.#building.delete(revision));
			this.#building.set(revision, building);
		}
		return building;
	}

	/** The engine's state-free result for `since` → `target`: cached, or computed once. */
	#traced(since: PatchsetRecord, target: Snapshot): Promise<Traced> {
		const key = rereviewKey(
			since.revision,
			target.revision,
			this.#patchsets
				.filter((p) => p.number < since.number)
				.sort((a, b) => b.number - a.number)
				.map((p) => p.revision),
		);
		let pending = this.#tracing.get(key);
		if (!pending) {
			pending = (async () => {
				const cached = await this.#cache.get(key);
				if (cached) return cached;
				const progress = await this.#progress();
				const traced = await traceRereview(
					this.repo,
					await this.#sinceOf(since, progress),
					await this.#earlierOf(since, progress),
					this.#targetOf(target),
					this.#stop.signal,
				);
				// A cache that can't be written costs the next restart a
				// computation, never the answer.
				await this.#cache.set(key, traced).catch(() => {});
				return traced;
			})();
			this.#tracing.set(key, pending);
			pending.catch(() => this.#tracing.delete(key));
		}
		return pending;
	}

	/** The answer and the start the traced result gives under the marks of now. */
	async #answerFor(
		since: PatchsetRecord,
		target: Snapshot,
		traced: Traced,
	): Promise<ReturnType<typeof answerRereview>> {
		const progress = await this.#progress();
		return answerRereview(
			traced,
			await this.#sinceOf(since, progress),
			await this.#earlierOf(since, progress),
			this.#targetOf(target),
		);
	}

	async #sinceOf(
		record: PatchsetRecord,
		progress: ProgressState,
	): Promise<SincePatchset> {
		return {
			...record,
			// A patch set started before the name was recorded: taken as
			// the current one (a retarget before it can't be told).
			baseBranch: record.baseBranch ?? this.#snapshotBase,
			snapshot: await this.#snapshotOf(record),
			states: progress.statesByRevision.get(record.revision) ?? new Map(),
		};
	}

	/** The patch sets before `since`, latest first, for the carry's walk back. */
	async #earlierOf(
		since: PatchsetRecord,
		progress: ProgressState,
	): Promise<EarlierPatchset[]> {
		const earlier = progress.patchsets
			.filter((p) => p.number < since.number)
			.sort((a, b) => b.number - a.number);
		return Promise.all(
			earlier.map(async (record) => ({
				...record,
				snapshot: await this.#snapshotOf(record),
				states: progress.statesByRevision.get(record.revision) ?? new Map(),
			})),
		);
	}

	#targetOf(snapshot: Snapshot): TargetSnapshot {
		return { ...snapshot, baseBranch: this.#meta.baseBranch };
	}

	/** PS1's start: nothing before it, nothing carried; the base branch's name. */
	#firstStart(): PatchsetStart {
		return {
			since: null,
			shape: null,
			baseBranch: this.#meta.baseBranch,
			interdiff: null,
			carried: [],
		};
	}

	/**
	 * The start of the next patch set on `snapshot`: the engine's carries
	 * from the latest patch set (awaited; cached if the page asked already).
	 */
	async #startFor(
		snapshot: Snapshot,
		progress: ProgressState,
	): Promise<PatchsetStart> {
		const since = progress.patchset;
		if (!since) return this.#firstStart();
		const traced = await this.#traced(since, snapshot);
		return (await this.#answerFor(since, snapshot, traced)).start;
	}

	/**
	 * Puts the session on `snapshot`, just started as the latest patch set:
	 * the one left behind stays readable, and the head dot, if it is this
	 * head, has nothing newer.
	 */
	#adopt(snapshot: Snapshot, progress: ProgressState): void {
		this.#noted(progress);
		if (this.#snapshot !== snapshot) {
			this.#snapshots.set(this.#snapshot.revision, this.#snapshot);
			this.#snapshot = snapshot;
			this.#snapshotBase = this.#meta.baseBranch;
			this.#commentLeft = null;
			if (this.#head?.oid === snapshot.head) {
				this.#head = { ...this.#head, mergeBase: snapshot.base, commits: 0 };
			}
		}
		this.#patchset = progress.patchset?.number ?? null;
	}

	/**
	 * What a new thread or a verdict on `snapshot` runs before its GitHub
	 * write: the start of the patch set when the snapshot is none yet (a
	 * lasting action), nothing when it is the latest, a refusal (409
	 * "stale") when it is an earlier one, read-only.
	 */
	#startHook(snapshot: Snapshot): () => Promise<void> {
		return () =>
			this.#exclusive(async () => {
				try {
					const before = await this.#progress();
					const record = before.patchsets.find(
						(p) => p.revision === snapshot.revision,
					);
					if (record) {
						if (before.patchset?.revision !== snapshot.revision) {
							throw new ReadOnlyPatchsetError(
								`Patch set ${record.number} is read-only; patch set ${before.patchset?.number} is the latest`,
							);
						}
						return;
					}
					const start = await this.#startFor(snapshot, before);
					const progress = await this.reviews.ensurePatchset(
						this.reviewId,
						this.viewer,
						snapshot,
						start,
					);
					this.#adopt(snapshot, progress);
				} catch (error) {
					if (error instanceof StaleSnapshotError) {
						throw new WriteRefusedError(error.message, "stale");
					}
					throw error;
				}
			});
	}

	/**
	 * The snapshot a write names by its head: the current one, else a kept
	 * one with that head (a viewed head, an earlier patch set); the current
	 * one when none has it (the write's own check refuses it as stale).
	 */
	#snapshotForWrite(commit: string): Snapshot {
		if (this.#snapshot.head === commit) return this.#snapshot;
		const kept = [...this.#snapshots.values()].filter((s) => s.head === commit);
		// By snapshot id, never by head alone: a patch set's snapshot first
		// (read-only once superseded), else the head as viewed against the
		// base branch's tip.
		const patchsets = new Set(this.#patchsets.map((p) => p.revision));
		const record = kept.find((s) => patchsets.has(s.revision));
		if (record) return record;
		const viewed =
			this.#head?.oid === commit
				? kept.find(
						(s) =>
							s.revision === snapshotId(this.#head?.mergeBase ?? "", commit),
					)
				: undefined;
		return viewed ?? kept.at(-1) ?? this.#snapshot;
	}

	/**
	 * The PR's overview from a read of GitHub (OverviewRead; its review
	 * threads come apart, `threads`). Reads take seconds, so the last one is
	 * kept: its overview is served while it is at most `maxAgeMs` old,
	 * counted from when it came in (by default at any age: it moves on with
	 * a Refresh); else a read under way that started at most that long ago;
	 * else a new read. A read whose overview failed isn't kept.
	 */
	overview(
		maxAgeMs = Number.POSITIVE_INFINITY,
	): Promise<Omit<PrOverview, "servedAt">> {
		if (this.#closed) {
			return Promise.reject(new SessionClosedError("The session is closed"));
		}
		// Asked at once, never waited for: it is in by the time GitHub's
		// overview is, or the next one says (true until it is known).
		this.#commentLeftNow();
		return this.#pickRead(maxAgeMs).overview.then((o) => ({
			...o,
			commentLeft: this.#commentLeftNow(),
		}));
	}

	/** The read overview() serves (see there). */
	#pickRead(maxAgeMs: number): OverviewRead {
		const now = Date.now();
		// 0: a new read, even if the last came in this very millisecond.
		if (maxAgeMs <= 0) return this.#read();
		const current = this.#reads.filter((r) => !this.#superseded.has(r));
		const done = current.findLast(
			(r) => r.ended !== null && now - r.ended <= maxAgeMs,
		);
		if (done) return done;
		const reading = current.findLast(
			(r) => r.ended === null && now - r.started <= maxAgeMs,
		);
		return reading ?? this.#read();
	}

	/**
	 * The review threads of read `readId` (the overview's), once `stage` is
	 * in. An UnknownReadError when the read is no longer kept (the page
	 * reads the overview again).
	 */
	threads(readId: string, stage: ThreadsStage): Promise<ThreadsView> {
		const read = this.#reads.find((r) => r.id === readId);
		if (!read) throw new UnknownReadError(`No read ${readId}`);
		return read.threads(stage);
	}

	/**
	 * The comments of read `readId`'s threads with these ids
	 * (OverviewRead.comments). An UnknownReadError when the read is no
	 * longer kept.
	 */
	comments(readId: string, ids: string[]): Promise<CommentsView> {
		const read = this.#reads.find((r) => r.id === readId);
		if (!read) throw new UnknownReadError(`No read ${readId}`);
		return read.comments(ids);
	}

	/**
	 * The timeline of read `readId` (the overview's). An UnknownReadError
	 * when the read is no longer kept.
	 */
	timeline(readId: string): Promise<TimelineView> {
		const read = this.#reads.find((r) => r.id === readId);
		if (!read) throw new UnknownReadError(`No read ${readId}`);
		return read.timeline;
	}

	/**
	 * Whether this session writes to GitHub: never as of a cutoff (the past
	 * can't be answered), nor as `--viewer` someone else (the write would be
	 * the gh login's, not theirs).
	 */
	writes(): PrOverview["writes"] {
		if (this.options.asOf) return "as-of";
		const { viewer } = this.options;
		if (viewer !== undefined && slugify(viewer) !== this.viewer)
			return "viewer";
		return "on";
	}

	/**
	 * Replies to a thread on GitHub (threadWrites.ts), after any write to
	 * the same thread still running: a resend waits for the first attempt,
	 * then finds it posted.
	 */
	replyToThread(threadId: string, req: ReplyRequest): Promise<ThreadUpdate> {
		return this.#threadExclusive(threadId, () =>
			replyToThread(this.#writeTarget(), threadId, req),
		);
	}

	/** Resolves or unresolves a thread on GitHub (threadWrites.ts), in turn. */
	setThreadResolved(
		threadId: string,
		resolved: boolean,
	): Promise<ThreadUpdate> {
		return this.#threadExclusive(threadId, () =>
			setResolved(this.#writeTarget(), threadId, resolved),
		);
	}

	/** Edits a comment of a thread on GitHub (threadWrites.ts), in turn. */
	editThreadComment(
		threadId: string,
		commentId: string,
		req: EditRequest,
	): Promise<ThreadUpdate> {
		return this.#threadExclusive(threadId, () =>
			editComment(this.#writeTarget(), threadId, commentId, req),
		);
	}

	/** Deletes a comment of a thread on GitHub (threadWrites.ts), in turn. */
	deleteThreadComment(
		threadId: string,
		commentId: string,
	): Promise<DeleteAnswer> {
		return this.#threadExclusive(threadId, () =>
			deleteThreadComment(this.#writeTarget(), threadId, commentId),
		);
	}

	/**
	 * Starts a thread on GitHub (newThreads.ts), after any new thread
	 * still being started: a resend waits for the first attempt, then
	 * finds it posted.
	 */
	startThread(req: NewThreadRequest): Promise<NewThreadAnswer> {
		return this.#threadExclusive(NEW_THREADS, () =>
			startThread(this.#newThreadTarget(req.commit), req),
		);
	}

	/**
	 * What GitHub says about merging the PR (VerdictFacts), read only when
	 * asked (the Final Verdict tab; never on first open): its GraphQL read
	 * and the base branch's rule at once, a failed rule read giving none.
	 * Kept like the overview: served while at most `maxAgeMs` old (by
	 * default at any age), else a read under way that started no longer
	 * ago, else a new read. A Refresh or a verdict landing drops it; a
	 * failed read isn't kept.
	 */
	verdict(maxAgeMs = Number.POSITIVE_INFINITY): Promise<VerdictFacts> {
		if (this.#closed) {
			return Promise.reject(new SessionClosedError("The session is closed"));
		}
		const now = Date.now();
		const last = this.#verdictRead;
		if (
			last &&
			maxAgeMs > 0 &&
			now - (last.ended ?? last.started) <= maxAgeMs
		) {
			return last.facts;
		}
		const read: VerdictReadState = {
			started: now,
			ended: null,
			facts: this.#readVerdict(),
		};
		this.#verdictRead = read;
		read.facts.then(
			() => {
				read.ended = Date.now();
			},
			() => {
				if (this.#verdictRead === read) this.#verdictRead = null;
			},
		);
		return read.facts;
	}

	async #readVerdict(): Promise<VerdictFacts> {
		const { asOf, viewer } = this.options;
		const ref = this.#ref();
		const signal = this.#stop.signal;
		const [read, rule] = await Promise.all([
			asOf
				? fetchVerdictAsOf(ref, this.#meta.headOid, { signal })
				: fetchVerdict(ref, { signal }),
			// Present-only: not read as of a cutoff. Any failure is no rule.
			asOf
				? null
				: fetchRuleReads(ref, this.#meta.baseBranch, { signal }).then(
						ruleOf,
						() => null,
					),
		]);
		return mapVerdict({
			read,
			rule,
			viewer: viewer ?? this.viewer,
			asOf,
			fetchedAt: new Date().toISOString(),
		});
	}

	/**
	 * Sends the reviewer's verdict to GitHub (verdict.ts), after any
	 * verdict still being sent: a resend waits for the first attempt, then
	 * finds it sent.
	 */
	submitVerdict(req: VerdictRequest): Promise<VerdictAnswer> {
		return this.#threadExclusive(VERDICTS, () =>
			submitVerdict(this.#verdictTarget(req.commit), req),
		);
	}

	#verdictTarget(commit: string): VerdictTarget {
		const write = this.#writeTarget();
		// The snapshot the verdict is checked against (the one its head
		// names: the session's, or a viewed head's), even if a Refresh moves
		// the session's while it runs.
		const snapshot = this.#snapshotForWrite(commit);
		return {
			ref: write.ref,
			prUrl: write.prUrl,
			viewer: write.viewer,
			writes: write.writes,
			head: snapshot.head,
			startPatchset: this.#startHook(snapshot),
			sent: (clientId) => this.#verdicts.get(clientId),
			rememberSent: (clientId, record) => this.#verdicts.set(clientId, record),
			firstAttempt: (clientId) => this.#verdictAttempts.get(clientId),
			setFirstAttempt: (clientId, at) =>
				this.#verdictAttempts.set(clientId, at),
			inDoubt: write.inDoubt,
			setInDoubt: write.setInDoubt,
			claimedIds: (except) =>
				new Set(
					[...this.#verdicts]
						.filter(([clientId]) => clientId !== except)
						.map(([, r]) => r.answer.review.id),
				),
			setPendingReview: write.setPendingReview,
			landed: () => {
				// Read again when next asked, not now: the answer doesn't wait.
				this.#verdictRead = null;
				for (const read of this.#reads) this.#superseded.add(read);
			},
		};
	}

	/**
	 * Whether new comments may go on LEFT lines (PrOverview.commentLeft):
	 * whether GitHub's merge base for the snapshot's head (its compare of
	 * the base branch and it, which a LEFT line resolves against) is the
	 * snapshot's left side. They differ when the base moved on past what
	 * the snapshot shows: a pinned head, a started patch set.
	 * One compare per snapshot, asked lazily; a failed one is asked again
	 * after COMMENT_LEFT_RETRY_MS (a POST meanwhile gets its failure, a
	 * 502). Where nothing is written (as of a cutoff, --viewer someone
	 * else) it isn't asked: true.
	 */
	commentLeft(snapshot: Snapshot = this.#snapshot): Promise<boolean> {
		if (this.writes() !== "on") return Promise.resolve(true);
		// A write asks again at once rather than take a failure as the answer.
		if (this.#commentLeft?.failedAt !== undefined) this.#commentLeft = null;
		return this.#askCommentLeft(snapshot).left;
	}

	/** commentLeft's entry for `snapshot`'s base and head (cached, or asked now). */
	#askCommentLeft(snapshot: Snapshot): CommentLeft {
		const { base, head } = snapshot;
		const from = this.#meta.baseOid ?? this.#meta.baseBranch;
		// GitHub's base for the PR too: a Refresh may move it under a
		// snapshot that stays (a started patch set).
		const key = `${from} ${base}...${head}`;
		const last = this.#commentLeft;
		if (
			last?.key === key &&
			(last.failedAt === undefined ||
				Date.now() - last.failedAt <= COMMENT_LEFT_RETRY_MS)
		) {
			return last;
		}
		const entry: CommentLeft = {
			key,
			// The PR's own base commit: a merged PR's stays where it was
			// (gallery #11: GitHub still resolves its LEFT lines there).
			left: fetchMergeBase(this.#ref(), from, head, {
				signal: this.#stop.signal,
			}).then((mergeBase) => {
				entry.known = mergeBase === base;
				return entry.known;
			}),
		};
		entry.left.catch(() => {
			entry.failedAt = Date.now();
		});
		this.#commentLeft = entry;
		return entry;
	}

	/** commentLeft as known now, asking GitHub if no one has: true until it says. */
	#commentLeftNow(): boolean {
		if (this.writes() !== "on" || this.#closed) return true;
		return this.#askCommentLeft(this.#snapshot).known ?? true;
	}

	/** Runs thread writes one at a time per thread, in the order asked. */
	#threadExclusive<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
		const before = this.#threadWrites.get(threadId) ?? Promise.resolve();
		const run = before.then(fn, fn);
		const settled = run.then(
			() => {},
			() => {},
		);
		this.#threadWrites.set(threadId, settled);
		void settled.then(() => {
			if (this.#threadWrites.get(threadId) === settled) {
				this.#threadWrites.delete(threadId);
			}
		});
		return run;
	}

	#writeTarget(): ThreadWriteTarget {
		if (this.#closed) throw new SessionClosedError("The session is closed");
		const kept = () => [...this.#reads].reverse();
		return {
			ref: this.#ref(),
			prUrl: this.#meta.url,
			viewer: this.viewer,
			writes: this.writes(),
			prAuthor: async () => (await this.overview()).author,
			summaryOf: (id) => {
				for (const read of kept()) {
					const node = read.summaryOf(id);
					if (node !== undefined) return node;
				}
				return undefined;
			},
			cached: (id) => {
				for (const read of kept()) {
					const nodes = read.cached(id);
					if (nodes) return nodes;
				}
				return undefined;
			},
			nextSeq: () => ++this.#writeSeq,
			apply: (id, nodes, seq, startedAt) => {
				for (const read of this.#reads) {
					read.applyWrite(id, nodes, seq, startedAt);
				}
			},
			drop: (id, seq, startedAt) => {
				for (const read of this.#reads) read.dropThread(id, seq, startedAt);
			},
			dropped: (id) => this.#reads.some((read) => read.dropped(id)),
			deletedHere: (nodeId) => this.#deletedComments.has(nodeId),
			markDeleted: (nodeId) => this.#deletedComments.add(nodeId),
			posted: (clientId) => this.#posted.get(clientId),
			remember: (clientId, record) => this.#posted.set(clientId, record),
			inDoubt: (clientId) => this.#inDoubt.has(clientId),
			setInDoubt: (clientId, doubt) => {
				if (doubt) this.#inDoubt.add(clientId);
				else this.#inDoubt.delete(clientId);
			},
			claimedIds: (except) =>
				new Set(
					[...this.#posted]
						.filter(([clientId]) => clientId !== except)
						.map(([, r]) => r.nodeId),
				),
			setPendingReview: (pending) => {
				for (const read of this.#reads) read.setPendingReview(pending);
			},
			known: (id, edit) => {
				const seq = ++this.#writeSeq;
				const startedAt = Date.now();
				for (const read of this.#reads) {
					read.applyKnown(id, edit, seq, startedAt);
				}
			},
		};
	}

	#newThreadTarget(commit: string): NewThreadTarget {
		// The snapshot the post is checked against (the one its head names:
		// the session's, or a viewed head's), even if a Refresh moves the
		// session's while it runs.
		const snapshot = this.#snapshotForWrite(commit);
		return {
			...this.#writeTarget(),
			head: snapshot.head,
			commentLeft: () => this.commentLeft(snapshot),
			startPatchset: this.#startHook(snapshot),
			started: (clientId) => this.#started.get(clientId),
			rememberStarted: (clientId, record) =>
				this.#started.set(clientId, record),
			add: (id, nodes, seq, startedAt) => {
				for (const read of this.#reads) {
					read.addThread(id, nodes, seq, startedAt);
				}
			},
			code: (anchor, hunk) =>
				this.#threadCode.code(
					anchor,
					{
						snapshot: snapshot.base,
						ref: `refs/remotes/origin/${this.#meta.baseBranch}`,
					},
					async () => hunk,
				),
		};
	}

	/**
	 * Starts a read of GitHub; its thread code waits for `ready` (a Refresh
	 * moving the snapshot) to know the diff base.
	 */
	#read(ready?: Promise<unknown>): OverviewRead {
		if (this.#closed) throw new SessionClosedError("The session is closed");
		// Opt-in ($CRB_TRACE_DIR): the read until its overview is in.
		const traced = tracer();
		if (!traced.enabled) return this.#newRead(ready);
		const span = traced.start("crb: overview read", {
			first: this.#reads.length === 0,
		});
		const read = traced.run(span, () => this.#newRead(ready));
		read.overview.then(
			() => span.end(),
			(error: unknown) => span.end(undefined, (error as Error)?.message),
		);
		return read;
	}

	#newRead(ready?: Promise<unknown>): OverviewRead {
		const { asOf, viewer } = this.options;
		const read = new OverviewRead({
			ref: this.#ref(),
			viewer: viewer ?? this.viewer,
			writes: this.writes(),
			asOf: asOf ? { at: asOf, head: this.#meta.headOid } : undefined,
			code: this.#threadCode,
			base: async () => {
				await ready?.catch(() => {});
				return {
					snapshot: this.#snapshot.base,
					ref: `refs/remotes/origin/${this.#meta.baseBranch}`,
				};
			},
		});
		// Until it has settled, whether kept or not (close() stops it).
		this.#live.add(read);
		void read.settled.then(() => this.#live.delete(read));
		// The newest few, so a page still showing an older one gets its threads.
		this.#reads = [...this.#reads, read].slice(-KEPT_READS);
		read.overview.catch(() => {
			this.#reads = this.#reads.filter((r) => r !== read);
		});
		return read;
	}

	/** Reads GitHub again (after `ready`); older reads aren't served any more. */
	#rereadOverview(ready?: Promise<unknown>): void {
		if (this.#closed) return;
		for (const read of this.#reads) this.#superseded.add(read);
		this.#read(ready);
	}

	async review(): Promise<ReviewView> {
		const snapshot = this.#snapshot;
		const view = buildReviewView(snapshot, await this.#progress());
		if (snapshot === this.#snapshot) this.#patchset = view.patchset;
		return view;
	}

	/**
	 * The review of the reviewer's patch set `patchset` as they left it:
	 * its snapshot rebuilt from the pin refs (the recorded merge base when
	 * the -base pin is missing: a patch set older than that ref) with its
	 * own states. A RangeError for a number that is none of theirs. The
	 * snapshot is kept, so its hunks and context load by its revision.
	 */
	async reviewAt(patchset: number): Promise<ReviewView> {
		const progress = await this.#progress();
		const record = progress.patchsets.find((p) => p.number === patchset);
		if (!record) throw new RangeError(`No patch set ${patchset}`);
		return buildReviewView(await this.#snapshotOf(record), progress);
	}

	/** The patch set's snapshot: the current one, a kept one, or rebuilt. */
	async #snapshotOf(record: PatchsetRecord): Promise<Snapshot> {
		if (this.#snapshot.revision === record.revision) return this.#snapshot;
		const kept = this.#snapshots.get(record.revision);
		if (kept) return kept;
		const pins = await this.reviews.patchsetPins(
			this.reviewId,
			this.viewer,
			record.number,
		);
		const snapshot = await buildSnapshot(
			this.repo,
			pins.base ?? record.mergeBase,
			pins.head ?? record.head,
		);
		// Keyed by what was built: a pin that doesn't match the record gives
		// another snapshot id, and the record's states never apply to it.
		this.#snapshots.set(snapshot.revision, snapshot);
		return snapshot;
	}

	/** Display hunks of a file of the snapshot with this `revision`. */
	async fileHunks(revision: string, index: number): Promise<FileHunks> {
		return loadFileHunks(this.repo, this.#current(revision), index);
	}

	/** Display hunks of several files of the snapshot with this `revision`. */
	async fileHunksBatch(
		revision: string,
		indexes: readonly number[],
	): Promise<HunksBatch> {
		return loadHunksBatch(this.repo, this.#current(revision), indexes);
	}

	/** Unchanged lines of a file of the snapshot with this `revision`. */
	async context(
		revision: string,
		index: number,
		newFrom: number,
		newTo: number,
	): Promise<DiffLine[]> {
		const snapshot = this.#current(revision);
		return loadContext(this.repo, snapshot, index, newFrom, newTo);
	}

	/**
	 * Records state changes made against the snapshot with this `revision`
	 * (ReviewView.revision). A tab still showing a snapshot the session has
	 * moved off, by head or by base, gets a StaleSnapshotError, so no state
	 * lands on a snapshot the reviewer never saw.
	 */
	setStates(revision: string, changes: StateChange[]): Promise<ReviewView> {
		return this.#exclusive(async () => {
			const snapshot = this.#current(revision);
			try {
				// A snapshot that is no patch set yet starts the next one (the
				// first with nothing before it; a later one with the engine's
				// carries from the latest, awaited), then takes the marks.
				const before = await this.#progress();
				const known = before.patchsets.some(
					(p) => p.revision === snapshot.revision,
				);
				const start = known
					? undefined
					: await this.#startFor(snapshot, before);
				const progress = this.#noted(
					await this.reviews.recordStates(
						this.reviewId,
						this.viewer,
						snapshot,
						changes,
						start,
					),
				);
				if (!known) this.#adopt(snapshot, progress);
				const view = buildReviewView(snapshot, progress);
				if (snapshot === this.#snapshot) this.#patchset = view.patchset;
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
	 * head (unless the PR is merged or closed), or, pinned on a head, stays
	 * on it against the base branch's new tip; a started one stays on its
	 * patch set.
	 */
	refresh(): Promise<SessionInfo> {
		// Commits and code that couldn't be had may be there now.
		this.#threadCode.forgetFailures();
		this.#verdictRead = null;
		// As of a cutoff nothing moves but the overview is read again.
		if (this.options.asOf) {
			this.#rereadOverview();
			return Promise.resolve(this.info());
		}
		// GitHub is read while the snapshot moves; its code once it has.
		const moved = this.#exclusive(async () => {
			const seq = ++this.#metaSeq;
			const signal = this.#stop.signal;
			const meta = await fetchPrMeta(this.#ref(), { signal });
			const fetched = await fetchPr(this.repo, meta, {
				signal,
				pinned: this.pinned ?? undefined,
			});
			this.#setMeta(seq, meta);
			const progress = await this.#progress();
			// An unstarted review of a merged or closed PR has nothing to move
			// to (a merge commit empties the comparison): keep the current
			// snapshot (headMoved tells the UI). An open PR always moves, even
			// to an empty comparison.
			if (!progress.patchset && meta.state !== "OPEN") {
				this.#patchset = null;
				this.#head = null;
				return this.info();
			}
			await this.#moveTo(progress, fetched);
			this.#fetched(meta, fetched.mergeBase);
			this.#head = await this.#headInfo(meta, fetched.mergeBase);
			return this.info();
		});
		this.#rereadOverview(moved);
		return moved;
	}

	/**
	 * Asks GitHub for the PR's head and base, and fetches once per triple
	 * (head, base oid, base branch) for its merge base and commit count
	 * (info().head): a triple the open or a Refresh already fetched costs
	 * no fetch; the same head under a moved base oid does (its merge base
	 * may have moved).
	 */
	async checkHead(): Promise<SessionInfo> {
		if (this.options.asOf) return this.info();
		const seq = ++this.#metaSeq;
		const meta = await fetchPrMeta(this.#ref(), { signal: this.#stop.signal });
		this.#setMeta(seq, meta);
		if (this.#meta === meta) await this.#noteHead(meta);
		return this.info();
	}

	/** info().head for `meta`'s head once its merge base is known. */
	async #headInfo(
		meta: PrMeta,
		mergeBase: string,
	): Promise<SessionInfo["head"]> {
		if (this.pinned || this.options.asOf || meta.state !== "OPEN") return null;
		return {
			oid: meta.headOid,
			mergeBase,
			baseBranch: meta.baseBranch,
			commits: await commitsSince(
				this.repo,
				this.#patchsets.at(-1)?.head ?? this.#snapshot.head,
				meta.headOid,
				mergeBase,
				this.#stop.signal,
			),
		};
	}

	/** The (head, base oid, base branch) triple #fetchedHeads files a fetch under. */
	static #headKey(meta: PrMeta): string {
		return `${meta.headOid} ${meta.baseOid ?? ""} ${meta.baseBranch}`;
	}

	/**
	 * Sets info().head for `meta`, fetching the head when the triple
	 * differs: the same head against another base oid (the base took in
	 * some of the PR's commits) has another merge base.
	 */
	async #noteHead(meta: PrMeta): Promise<void> {
		if (this.pinned || meta.state !== "OPEN") {
			this.#head = null;
			return;
		}
		const key = Session.#headKey(meta);
		let pending = this.#fetchedHeads.get(key);
		if (!pending) {
			pending = fetchPr(this.repo, meta, { signal: this.#stop.signal }).then(
				({ mergeBase }) => ({ mergeBase }),
			);
			this.#fetchedHeads.set(key, pending);
			pending.catch(() => this.#fetchedHeads.delete(key));
		}
		const { mergeBase } = await pending;
		const snapshot = this.#snapshot;
		const head =
			meta.headOid === snapshot.head &&
			meta.baseBranch === this.#snapshotBase &&
			mergeBase === snapshot.base
				? {
						oid: meta.headOid,
						mergeBase,
						baseBranch: meta.baseBranch,
						commits: 0,
					}
				: await this.#headInfo(meta, mergeBase);
		// A newer check may have answered meanwhile.
		if (this.#meta === meta) this.#head = head;
	}

	/** Notes a fetch the session made anyway (open, refresh) under its triple. */
	#fetched(meta: PrMeta, mergeBase: string): void {
		this.#fetchedHeads.set(
			Session.#headKey(meta),
			Promise.resolve({ mergeBase }),
		);
	}

	/** Keeps the newest answer: a slow check started earlier can't undo a refresh. */
	#setMeta(seq: number, meta: PrMeta): void {
		if (seq < this.#metaSeqApplied) return;
		this.#metaSeqApplied = seq;
		this.#meta = meta;
	}

	/** The snapshot the client is on: the current one, or a kept patch set's. */
	#current(revision: string): Snapshot {
		const snapshot = this.#snapshot;
		if (revision === snapshot.revision) return snapshot;
		const kept = this.#snapshots.get(revision);
		if (kept) return kept;
		throw new StaleSnapshotError("The review moved to another snapshot");
	}

	#ref(): PrRef {
		const { owner, repo, number } = this.#meta;
		return { owner, repo, number };
	}

	async #progress(): Promise<ProgressState> {
		return this.#noted(
			await this.reviews.getProgress(this.reviewId, this.viewer),
		);
	}

	/** Keeps the fold's patch sets for info(). */
	#noted(progress: ProgressState): ProgressState {
		this.#patchsets = progress.patchsets;
		return progress;
	}

	/** Puts the session on the latest patch set if there is one, else on `fallback`. */
	async #moveTo(progress: ProgressState, fallback: Endpoints): Promise<void> {
		this.#noted(progress);
		const { mergeBase, head } = progress.patchset ?? fallback;
		const current = this.#snapshot;
		if (current.base !== mergeBase || current.head !== head) {
			// A patch set left behind stays readable (an old one's tab).
			if (progress.patchsets.some((p) => p.revision === current.revision)) {
				this.#snapshots.set(current.revision, current);
			}
			this.#snapshot =
				this.#snapshots.get(snapshotId(mergeBase, head)) ??
				(await buildSnapshot(this.repo, mergeBase, head));
			this.#snapshotBase =
				progress.patchset?.baseBranch ?? this.#meta.baseBranch;
		}
		this.#patchset = progress.patchset?.number ?? null;
	}

	#exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(fn, fn);
		this.#queue = run.catch(() => {});
		return run;
	}
}
