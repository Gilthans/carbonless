import type {
	CommentsView,
	DeleteAnswer,
	DiffLine,
	EditRequest,
	FileHunks,
	NewThreadAnswer,
	NewThreadRequest,
	PrOverview,
	ReplyRequest,
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
import { ensureClone, fetchPr } from "./clone.js";
import { buildSnapshot, loadContext, loadFileHunks } from "./diff/snapshot.js";
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
import {
	type NewThreadTarget,
	type StartedRecord,
	startThread,
} from "./newThreads.js";
import { OverviewRead } from "./overviewRead.js";
import type { HeadSpec } from "./pinnedHead.js";
import { buildReviewView } from "./review/coverage.js";
import type { ProgressState } from "./review/fold.js";
import { RefStore } from "./review/refStore.js";
import { ReviewService, StaleSnapshotError } from "./review/reviews.js";
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

	private constructor(
		private readonly repo: string,
		private readonly viewer: string,
		private readonly reviewId: string,
		private readonly reviews: ReviewService,
		meta: PrMeta,
		snapshot: Snapshot,
		patchset: number | null,
		private readonly options: SessionOptions,
		/** The commit `options.head` named; null without one. */
		private readonly pinned: string | null,
	) {
		this.#meta = meta;
		this.#snapshot = snapshot;
		this.#patchset = patchset;
		this.#threadCode = new ThreadCodeSource(repo);
		Session.#open.add(this);
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
				this.#queue,
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
			ensureClone(meta.owner, meta.repo, () =>
				progress(`cloning ${meta.owner}/${meta.repo}…`),
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
		const fetched = await fetchPr(repo, meta, {
			asOf,
			pinned: pinned ?? undefined,
		});
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
		const { mergeBase, head } = state.patchset ?? fetched;
		const snapshot = await buildSnapshot(repo, mergeBase, head);
		return new Session(
			repo,
			viewer,
			reviewId,
			reviews,
			meta,
			snapshot,
			state.patchset?.number ?? null,
			options,
			pinned,
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
		};
	}

	snapshot(): Snapshot {
		return this.#snapshot;
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
			startThread(this.#newThreadTarget(), req),
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
			submitVerdict(this.#verdictTarget(), req),
		);
	}

	#verdictTarget(): VerdictTarget {
		const write = this.#writeTarget();
		return {
			ref: write.ref,
			prUrl: write.prUrl,
			viewer: write.viewer,
			writes: write.writes,
			// The snapshot the verdict is checked against, even if a Refresh
			// moves the session's while it runs.
			head: this.#snapshot.head,
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
		};
	}

	#newThreadTarget(): NewThreadTarget {
		// The snapshot the post is checked against, even if a Refresh moves
		// the session's while it runs.
		const snapshot = this.#snapshot;
		return {
			...this.#writeTarget(),
			head: snapshot.head,
			commentLeft: () => this.commentLeft(snapshot),
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
						snapshot: this.#snapshot.base,
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

	/** Display hunks of a file of the snapshot with this `revision`. */
	async fileHunks(revision: string, index: number): Promise<FileHunks> {
		return loadFileHunks(this.repo, this.#current(revision), index);
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
				return this.info();
			}
			await this.#moveTo(progress, fetched);
			return this.info();
		});
		this.#rereadOverview(moved);
		return moved;
	}

	/** Asks GitHub for the PR's head without fetching anything. */
	async checkHead(): Promise<SessionInfo> {
		if (this.options.asOf) return this.info();
		const seq = ++this.#metaSeq;
		this.#setMeta(
			seq,
			await fetchPrMeta(this.#ref(), { signal: this.#stop.signal }),
		);
		return this.info();
	}

	/** Keeps the newest answer: a slow check started earlier can't undo a refresh. */
	#setMeta(seq: number, meta: PrMeta): void {
		if (seq < this.#metaSeqApplied) return;
		this.#metaSeqApplied = seq;
		this.#meta = meta;
	}

	/** The snapshot, if it's the one the client is on. */
	#current(revision: string): Snapshot {
		const snapshot = this.#snapshot;
		if (revision !== snapshot.revision) {
			throw new StaleSnapshotError("The review moved to another snapshot");
		}
		return snapshot;
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
