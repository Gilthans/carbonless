import { join } from "node:path";
import {
	AGENT_TURN_MS,
	type AgentAnchor,
	type AgentConfig,
	type AgentMessage,
	type AgentMessageRequest,
	type AgentOrigin,
	type AgentSpanAnchor,
	type AgentStatus,
	type AgentThread,
	type AgentView,
	type AgentViewTarget,
	isAgentQuestion,
	isOpenToAgent,
	JOIN,
	JOINED_PREAMBLE,
	JOINED_THREAD_PREAMBLE,
	MAX_OPENED_PER_REQUEST,
	type OpenAgentThreadRequest,
	REVIEW_PREAMBLE,
	startedBy,
} from "../../shared/agent.js";
import { inGitOrder } from "../../shared/diffHunk.js";
import {
	all,
	type LineRanges,
	normalize,
	subtract,
	union,
} from "../../shared/lineRanges.js";
import { marksOf } from "../../shared/pieces.js";
import type { ThreadPlacement } from "../../shared/rereview/placement.js";
import type {
	ClusterState,
	ClusterView,
	CodeAnchor,
	CodeWindow,
	Counts,
	DiffLine,
	FileStatus,
	FileView,
	ReviewThread,
	ReviewView,
	Snapshot,
	ThreadComment,
} from "../../shared/types.js";
import { readConfig } from "../config.js";
import { loadFileHunks } from "../diff/snapshot.js";
import type { PrMeta } from "../gh.js";
import { runGitBuffer } from "../git.js";
import { stripMarker } from "../marker.js";
import { RefStore } from "../review/refStore.js";
import { slugify } from "../slug.js";
import { agentsDir } from "./checkout.js";
import { ReviewClaim } from "./claim.js";
import { joinRead, liveGithubThreads, resolveView } from "./githubJoin.js";
import { JoinBroker, type WatchLease } from "./join.js";
import {
	anchorFor,
	type CommentRole,
	type GithubThreadFacts,
	isSafePath,
	type PromptCodeEnvelope,
	type PromptEnvelope,
	type PromptMessage,
	type PromptReviewEnvelope,
	sanitizeEnvelope,
	sanitizeThirdParty,
	takeSuggestion,
	threadEnvelope,
} from "./prompt.js";
import {
	AgentRunner,
	type RunnerFacts,
	type SelfMcp,
	type SpawnJoin,
	viewOf,
} from "./runner.js";
import {
	type AgentThreadFold,
	AgentThreadStore,
	ReviewConversationError,
	UnknownAgentThreadError,
} from "./store.js";

/** No review page request this long ends a spawned agent (the registry's idle time). */
export const PAGE_IDLE_MS = 30 * 60_000;

/** The port this server listens on (serve.ts sets it): the claim names it. */
let listeningPort = 0;
export const setServerPort = (port: number): void => {
	listeningPort = port;
};
export const serverPort = (): number => listeningPort;

/** crb's own /mcp as this machine reaches it (serve.ts sets it once listening). */
let selfMcp: SelfMcp | null = null;
export const setServerMcp = (mcp: SelfMcp | null): void => {
	selfMcp = mcp;
};
export const serverMcp = (): SelfMcp | null => selfMcp;

/** What the host asks of its ACP runner (an AgentRunner; a stub in tests). */
export type HostRunner = Pick<
	AgentRunner,
	| "status"
	| "asked"
	| "poke"
	| "stop"
	| "detach"
	| "cancel"
	| "close"
	| "handed"
	| "activity"
	| "replied"
	| "takeNotice"
	| "fenced"
	| "holdsAgent"
	| "pastLimit"
>;

/** A joined session's token isn't (or is no longer) this review's (code unknown-token). */
export class SessionTokenError extends Error {
	constructor() {
		super(
			"This token isn't joined to the review (it left, was disconnected or replaced): call attach again",
		);
	}
}

/** A joined session's reply to a thread `next` didn't hand it (code not-handed). */
export class NotHandedError extends Error {
	constructor(readonly thread: string) {
		super(
			`Thread ${thread} isn't the one handed to you: call next and reply to the thread it gives`,
		);
	}
}

/** A joined session's reply that can't be stored as asked (code invalid). */
export class BadReplyError extends Error {}

/** `open` called with no question held, or one past its time limit (code not_answering). */
export class NotHoldingError extends Error {
	constructor(why?: string) {
		super(
			why ??
				"open works only while you answer a question: call next, open from that question, then reply",
		);
	}
}

/** `open` on code that isn't in the PR, or lines or columns out of range (code bad_anchor). */
export class BadAnchorError extends Error {}

/** `open` on a GitHub thread the reviewer couldn't ask on (code thread_unavailable). */
export class ThreadUnavailableError extends Error {}

/** `open` on the thread the request was asked on (code own_thread). */
export class OwnThreadError extends Error {
	constructor() {
		super(
			"That is the conversation the request was asked in: answer it with reply instead",
		);
	}
}

/** `open` past MAX_OPENED_PER_REQUEST conversations from one request (code too_many). */
export class TooManyOpenedError extends Error {
	constructor() {
		super(
			`This request already started ${MAX_OPENED_PER_REQUEST} conversations: say the rest in your reply`,
		);
	}
}

/** Where `open` puts a conversation: code (a file, or lines in it) or a GitHub thread. */
export type OpenTarget =
	| {
			code: {
				path: string;
				side?: "LEFT" | "RIGHT";
				line?: number;
				startLine?: number;
				startCol?: number;
				endCol?: number;
			};
			thread?: undefined;
	  }
	| { thread: string; code?: undefined };

/** What `open` answers: the conversation, whether it is new, and how to cite it in a reply. */
export interface OpenResult {
	thread: string;
	created: boolean;
	cite: string;
}

/** The citation token for an agent thread in a reply (the web links it). */
export const citeOf = (thread: string): string => `crb:c/${thread}`;

/** What `next` hands a joined session. */
export interface SessionQuestion {
	/** First: what follows is data. */
	preamble: string;
	thread: string;
	/** The last human message: the reply's `replyTo`. */
	replyTo: string | undefined;
	envelope: PromptEnvelope;
	anchoredFile: { path: string; commit: string; text: string } | null;
	hunk: string | null;
}

/** The review as a joined session sees it (`review`, an approved `attach`). */
export interface SessionReviewFacts {
	repo: string;
	pr: number;
	url: string;
	base: { ref: string; commit: string };
	head: { ref: string; commit: string };
	mergeBase: string;
	title?: string;
	body?: string;
	files?: string[];
	/** The PR's GitHub review threads (the `review` tool): ids to `open` on. */
	threads?: SessionGithubThread[];
	/** More than MAX_SESSION_THREADS: the rest are left out. */
	threadsTruncated?: boolean;
	/** GitHub's threads couldn't be read (why, one line). */
	threadsError?: string;
	/** When the GitHub read the threads come from started (ISO). */
	threadsReadAt?: string;
}

/** A GitHub review thread as the `review` tool lists it (bodies sanitised and capped). */
export interface SessionGithubThread {
	id: string;
	path: string;
	line: number | null;
	side: "LEFT" | "RIGHT" | null;
	resolved: boolean;
	outdated: boolean;
	comments: { author: string; body: string }[];
	/** Only the opening comment is listed: the others couldn't be read now. */
	commentsPartial?: boolean;
}

/**
 * How old a GitHub read `review` and `open`'s thread checks may use (ms):
 * a recent or running read is reused, an older one replaced, so "was it
 * resolved?" is answered from GitHub as of at most this long ago.
 */
export const AGENT_GITHUB_MAX_AGE_MS = 30_000;

/** At most this many GitHub threads in `review`. */
export const MAX_SESSION_THREADS = 200;
/** A comment body in `review`, in characters (cut with an ellipsis). */
export const MAX_SESSION_COMMENT = 2048;

/** What a joined session's tools read of the review (reviewAgentHost's facts). */
export interface SessionFacts {
	facts: RunnerFacts;
	viewer?: string;
	/** The coverage the page shows for `target` (none: the review's default comparison). */
	coverage?(target?: AgentViewTarget): Promise<SessionCoverage>;
}

/** One comparison's coverage, as the page reads it (Session.coverage). */
export interface SessionCoverage {
	/** The comparison's merge base and head. */
	base: string;
	head: string;
	view: ReviewView;
}

/** The reviewer's progress couldn't be read (code unavailable): never an empty or all-reviewed answer. */
export class CoverageError extends Error {}

/** Line ranges by side, inclusive: LEFT in the base's numbering, RIGHT in the head's. */
export interface SideRanges {
	LEFT: [number, number][];
	RIGHT: [number, number][];
}

/** One changed file's lines in `progress`: each changed line in exactly one of the three. */
export interface SessionProgressFile {
	path: string;
	oldPath?: string;
	status: FileStatus;
	reviewed: SideRanges;
	unreviewed: SideRanges;
	crossedOff: SideRanges;
	/** File-level changes (a rename, a mode, a binary file): their state. */
	whole?: { label?: string; state: ClusterState }[];
}

/** What `progress` answers: the comparison on screen and its coverage by line. */
export interface SessionProgress {
	comparison: {
		base: string;
		head: string;
		patchset: number | null;
		/** The view of the reviewer's latest message in the review conversation, or the review's default. */
		source: "message" | "default";
	};
	files: SessionProgressFile[];
	/** The page's line counts for this comparison. */
	lines: Counts;
}

/** A request the agent host refuses as made (the app answers 400). */
export class AgentRequestError extends Error {}

/**
 * A request that conflicts with what is there (the app answers 409): a
 * conversation already on that GitHub thread (`thread` names it), a
 * question on a resolved GitHub thread, a resolve of a thread conversation.
 */
export class AgentConflictError extends Error {
	constructor(
		message: string,
		readonly thread?: string,
	) {
		super(message);
	}
}

/** What the host reads of the review's GitHub threads and patch sets. */
export type AgentGithub = Pick<
	ReviewAgentSource,
	"threads" | "thread" | "patchsets" | "threadsAt"
> & {
	/** The snapshot's merge base (a viewed head's, unless it is a patch set's). */
	base(): string;
	/** The comments (author, markdown) of these threads, by id; absent: openers only. */
	comments?(
		ids: string[],
		maxAgeMs?: number,
	): Promise<Map<string, { author: string; body: string }[]>>;
};

/**
 * A review's agent as its Session owns it: the ACP runner, the join broker
 * (a session joined through MCP answers instead while it is joined), and
 * the one store of the reviewer's agent threads every route goes through
 * (its dedupe of clientIds holds within one store). Thread conversations
 * are joined with GitHub's threads on every read (githubJoin.ts).
 */
export class AgentHost {
	readonly #restored: Promise<void>;

	constructor(
		private readonly runner: HostRunner,
		private readonly store: AgentThreadStore,
		private readonly code: (
			anchor: AgentAnchor,
			at: string,
		) => Promise<CodeWindow | undefined>,
		private readonly github: AgentGithub,
		readonly join: JoinBroker,
		private readonly session?: SessionFacts,
		opts: { now?: () => number; pageIdleMs?: number; idleTurnMs?: number } = {},
	) {
		this.#restored = join.restore().catch(() => {});
		this.#now = opts.now ?? Date.now;
		this.#pageIdleMs = opts.pageIdleMs ?? PAGE_IDLE_MS;
		this.#idleTurnMs = opts.idleTurnMs ?? AGENT_TURN_MS;
		this.#pageSeenAt = this.#now();
		join.onTurnEnd(() => this.#turnEnded());
		this.#armPage();
	}

	readonly #now: () => number;
	readonly #pageIdleMs: number;
	/** The longest a closed page's agent waits for its turn to end. */
	readonly #idleTurnMs: number;
	/** The review page's last request (ms): its status polls count, MCP doesn't. */
	#pageSeenAt: number;
	#pageTimer: ReturnType<typeof setTimeout> | null = null;
	/** The page went idle during a turn: the spawned agent ends at its end. */
	#idleDue = false;
	#closed = false;

	/**
	 * A request from the review's page (its routes, its status polls):
	 * the page is open. A spawned agent ends once none came for
	 * pageIdleMs, between turns ("Closing the review page ends it").
	 */
	pageSeen(): void {
		this.#pageSeenAt = this.#now();
		this.#idleDue = false;
		this.#armPage();
	}

	#armPage(): void {
		if (this.#pageTimer) clearTimeout(this.#pageTimer);
		this.#pageTimer = null;
		if (this.#closed) return;
		const left = this.#pageSeenAt + this.#pageIdleMs - this.#now();
		this.#pageTimer = setTimeout(() => this.#pageIdle(), Math.max(0, left));
		this.#pageTimer.unref?.();
	}

	#pageStale(): boolean {
		return this.#now() - this.#pageSeenAt >= this.#pageIdleMs;
	}

	#pageIdle(): void {
		this.#pageTimer = null;
		if (this.#closed) return;
		if (!this.#pageStale()) {
			this.#armPage();
			return;
		}
		// Only the agent this server runs: its spawned join, or its runner
		// holding the claim. Not the shared spawn flag alone: that may be
		// another server's agent (this runner `elsewhere`), or set beside
		// an outside session joined here.
		if (!this.#runsSpawned()) return;
		// An answer in progress still lands: it ends at the turn's end, or
		// at the latest after idleTurnMs (a turn that never ends).
		if (this.join.inTurn()) {
			this.#idleDue = true;
			this.#pageTimer = setTimeout(() => {
				this.#pageTimer = null;
				if (!this.#idleDue || this.#closed) return;
				this.#idleDue = false;
				if (this.#pageStale() && this.#runsSpawned()) {
					void this.detach().catch(() => {});
				}
			}, this.#idleTurnMs);
			this.#pageTimer.unref?.();
			return;
		}
		void this.detach().catch(() => {});
	}

	/** This server runs the review's spawned agent (not just the shared flag). */
	#runsSpawned(): boolean {
		// An outside session joined here: whatever the runner still holds
		// (its claim until a status winds it down), the timer leaves it be.
		if (this.join.isJoined() && !this.join.isSpawned()) return false;
		return this.join.isSpawned() || this.runner.holdsAgent();
	}

	#turnEnded(): void {
		if (!this.#idleDue || this.#closed) return;
		this.#idleDue = false;
		if (this.#pageStale() && this.#runsSpawned()) {
			void this.detach().catch(() => {});
		} else this.#armPage();
	}

	/** The joined session (by `since`) and the head its last `next` saw. */
	#seen: { since: string; head: string; mergeBase: string } | null = null;

	/** The runner's status, with a joined session (or a request to join) laid over it. */
	async status(): Promise<AgentStatus> {
		await this.#restored;
		const { seen: acpSeen, ...base } = await this.runner.status();
		const { presence, ...view } = this.join.view();
		const joinSeen = this.join.seen();
		const seen = Math.max(
			acpSeen ? Date.parse(acpSeen) : Number.NEGATIVE_INFINITY,
			joinSeen ?? Number.NEGATIVE_INFINITY,
		);
		const out: AgentStatus = {
			...base,
			...view,
			...this.#spawnedFields(),
			...(Number.isFinite(seen) ? { seen: new Date(seen).toISOString() } : {}),
		};
		const joined = view.joined;
		if (!joined) return out;
		const handed = this.join.handedOut();
		const via = view.via ?? "mcp";
		if (via === "acp") {
			// crb's own agent: the page shows it as spawned (no `joined`,
			// which means an invited session there), with its live activity.
			// A failed turn keeps its reason up (red) until the next one.
			const { joined: _, elsewhere: __, ...rest } = out;
			return {
				...rest,
				state:
					presence === "busy"
						? "busy"
						: out.state === "error"
							? "error"
							: "ready",
				agent: { name: joined.name, version: joined.harness ?? "", via },
			};
		}
		// An invited session: its presence, the question it holds.
		const { answering: _, error: __, elsewhere: ___, ...rest } = out;
		return {
			...rest,
			state:
				presence === "listening"
					? "ready"
					: presence === "busy"
						? "busy"
						: "reconnecting",
			agent: {
				name: joined.name,
				version: joined.harness ?? "",
				via,
				machine: joined.machine,
			},
			since: joined.since,
			...(handed
				? {
						answering: {
							thread: handed.thread,
							text: "",
							activity: [],
							...(handed.asked ? { asked: handed.asked } : {}),
						},
					}
				: {}),
		};
	}

	/** `spawned` and `spawnedAt` while this review's spawn flag is set. */
	#spawnedFields(): Pick<AgentStatus, "spawned" | "spawnedAt"> {
		const at = this.join.spawnedAt();
		return at === null
			? {}
			: { spawned: true, spawnedAt: new Date(at).toISOString() };
	}

	/** The thread a replaced spawned agent may still answer (JOIN.acpStopMs after an Approve): `next` skips it. */
	busyThread(): string | null {
		return this.join.replaceGrace()?.thread ?? null;
	}

	/**
	 * Threads `next` skips: the one a replaced spawned agent may still
	 * answer, and those whose stop message the runner is storing.
	 */
	#skipped(): Set<string> {
		const busy = this.busyThread();
		return new Set([...(busy ? [busy] : []), ...this.runner.fenced()]);
	}

	/**
	 * In use by a joined session (or a request to join): the registry
	 * doesn't evict it. A spawned agent counts only while its page was
	 * seen within pageIdleMs, or while it is in a turn: its own MCP calls
	 * never keep the review open.
	 */
	active(): boolean {
		if (this.join.isSpawned()) {
			return (
				this.join.inTurn() ||
				this.join.view().joinRequest !== undefined ||
				!this.#pageStale()
			);
		}
		return this.join.active();
	}

	/** The threads in opened order, joined with GitHub; a line anchor's carries its code window. */
	async threads(): Promise<AgentThread[]> {
		const folds = await this.#joined(await this.store.read());
		return Promise.all(folds.map((t) => this.#view(t)));
	}

	/**
	 * Each span thread's id, anchor and when it was asked (what placement
	 * reads): a live thread conversation goes where its GitHub thread goes,
	 * so it is left out; an orphan comes with its span anchor. The review
	 * conversation has no code to place on: left out.
	 */
	async asked(): Promise<
		{ id: string; anchor: AgentSpanAnchor; at: string }[]
	> {
		const out: { id: string; anchor: AgentSpanAnchor; at: string }[] = [];
		for (const { id, anchor, at } of await this.#joined(
			await this.store.read(),
		)) {
			if (anchor.subject === "thread" || anchor.subject === "review") continue;
			out.push({ id, anchor, at });
		}
		return out;
	}

	/**
	 * Opens a thread on a span, on a GitHub thread (`req.thread`): one
	 * listed, with an id and not deleted (else AgentRequestError), and with
	 * no conversation yet (else AgentConflictError naming it), or the review
	 * conversation (`req.review`: one per review, else AgentConflictError
	 * naming it). A resend of an opening already written returns its thread.
	 */
	async open(req: OpenAgentThreadRequest): Promise<AgentThread> {
		// A resend of an opening already stored: its thread, whatever GitHub says now.
		const known = await this.store.openedWith(req.clientId);
		if (known !== undefined) {
			return this.#view(await this.#joinedOne(await this.store.find(known)));
		}
		const view = req.view ? this.#resolveView(req.view) : undefined;
		const given = [req.span, req.thread, req.review].filter(
			(x) => x !== undefined,
		).length;
		if (given !== 1) {
			throw new AgentRequestError(
				"A span, a thread or the review, one of them",
			);
		}
		let anchor: AgentAnchor;
		if (req.span) anchor = req.span;
		else if (req.thread !== undefined) {
			anchor = await this.#threadAnchor(req.thread);
		} else anchor = { subject: "review" };
		const t = await this.store
			.open({
				anchor,
				text: req.text,
				by: "human",
				clientId: req.clientId,
				...(view ? { view } : {}),
			})
			.catch((error: unknown) => {
				if (error instanceof ReviewConversationError) {
					throw new AgentConflictError(error.message, error.thread);
				}
				throw error;
			});
		await this.#asked();
		return this.#view(await this.#joinedOne(t));
	}

	/**
	 * A question in a thread; refused (AgentConflictError) while its GitHub
	 * thread is resolved, and failing (the read's error, 502) while GitHub
	 * can't be read. A resend of a message already stored returns the
	 * thread before either check.
	 */
	async message(
		thread: string,
		req: AgentMessageRequest,
	): Promise<AgentThread> {
		if (await this.store.messagedWith(thread, req.clientId)) {
			return this.#view(await this.#joinedOne(await this.store.find(thread)));
		}
		const view = req.view ? this.#resolveView(req.view) : undefined;
		const current = await this.store.find(thread);
		if (current.anchor.subject === "thread") {
			// Fails closed: an unread GitHub never lets a question through.
			const rt = liveGithubThreads(await this.github.threads()).get(
				current.anchor.thread,
			);
			if (rt?.resolved) {
				throw new AgentConflictError(
					"The GitHub thread is resolved: unresolve it to ask again",
				);
			}
		}
		const t = await this.store.message(thread, {
			by: "human",
			text: req.text,
			clientId: req.clientId,
			...(view ? { view } : {}),
		});
		await this.#asked();
		return this.#view(await this.#joinedOne(t));
	}

	/**
	 * Resolves a span thread or an orphan; a live thread conversation has
	 * no resolved state of its own (AgentConflictError: resolve the GitHub
	 * thread, a human action on its card), and the review conversation is
	 * never resolved (AgentConflictError).
	 */
	async setResolved(thread: string, resolved: boolean): Promise<AgentThread> {
		const current = await this.store.find(thread);
		if (current.anchor.subject === "review") {
			throw new AgentConflictError("The review conversation is never resolved");
		}
		if (current.anchor.subject === "thread") {
			// Unknown GitHub threads fail the write (502), never resolve it here.
			const live = liveGithubThreads(await this.github.threads());
			if (live.has(current.anchor.thread)) {
				throw new AgentConflictError(
					"A thread conversation resolves with its GitHub thread",
				);
			}
		}
		const t = await this.store.setResolved(thread, resolved);
		return this.#view(await this.#joinedOne(t));
	}

	/** The reviewer has seen the thread up to a message (no write when already seen). */
	async seen(thread: string, upTo: string): Promise<AgentThread> {
		const t = await this.store.seen(thread, upTo);
		return this.#view(await this.#joinedOne(t));
	}

	cancel(): Promise<void> {
		return this.runner.cancel();
	}

	/** Spawns the agent if one is configured and answers the backlog (never awaited). */
	start(): void {
		this.runner.poke();
	}

	/** The reviewer's Spawn (Start): this review's spawn flag set, the ACP buddy on (a joined session leaves first). */
	async startAcp(): Promise<void> {
		await this.#restored;
		// A spawned agent already in place stays.
		if (!this.join.isSpawned()) this.join.leave("disconnected");
		await this.join.setSpawned(true);
		this.runner.asked();
	}

	/**
	 * The reviewer's Detach: a joined session is disconnected; else the
	 * spawn flag is cleared (review-wide: another server holding the agent
	 * stops it on its next status) and the ACP buddy here is detached (its
	 * turn cancelled, its process stopped, its checkout and claim gone).
	 */
	async detach(): Promise<void> {
		await this.#restored;
		if (this.join.isJoined() && !this.join.isSpawned()) {
			// The spawn flag is left as it is: set while joined (Spawn pressed
			// on another server), the ACP buddy starts once the session leaves.
			this.join.leave("disconnected");
			return;
		}
		// A spawned agent has no life outside the review: Detach ends it
		// (its token revoked first, then its process).
		this.join.spawnedGone("disconnected");
		await this.join.setSpawned(false);
		await this.runner.detach();
	}

	async close(): Promise<void> {
		this.#closed = true;
		if (this.#pageTimer) clearTimeout(this.#pageTimer);
		await this.#restored;
		this.join.close();
		await this.runner.close();
	}

	/** Who answers here besides ACP: a joined session, or one asking to join. */
	buddy(): "joined" | "pending" | null {
		const v = this.join.view();
		return v.joined ? "joined" : v.joinRequest ? "pending" : null;
	}

	/**
	 * Whether `secret` is the joined session's token (after a restart's
	 * restore), or a replaced spawned agent's in its grace (reply only).
	 */
	async sessionAllowed(secret: string): Promise<boolean> {
		await this.#restored;
		return this.join.check(secret) || this.join.graceAllows(secret);
	}

	/** The watcher's lease for `secret`; null for a token not joined here. */
	async sessionWatch(secret: string): Promise<WatchLease | null> {
		await this.#restored;
		return this.join.watcher(secret);
	}

	async #token(secret: string): Promise<void> {
		await this.#restored;
		if (!this.join.check(secret)) throw new SessionTokenError();
	}

	#facts(): SessionFacts {
		if (!this.session)
			throw new Error("This review has no facts for a joined session");
		return this.session;
	}

	/** Waiting questions a joined session can take (not the one the ACP buddy still answers). */
	async sessionWaiting(): Promise<number> {
		const skipped = this.#skipped();
		// Joined with GitHub: an orphan is a span thread (its resolve counts).
		return (await this.#joined(await this.store.read())).filter(
			(t) => isAgentQuestion(t) && !skipped.has(t.id),
		).length;
	}

	/** The review's facts for a joined session, sanitised; `withPr` adds the PR's title, body and files. */
	async sessionReview(
		secret: string,
		withPr: boolean,
		withThreads = false,
	): Promise<SessionReviewFacts> {
		await this.#token(secret);
		const { facts } = this.#facts();
		const r = facts.review();
		const s = sanitizeThirdParty;
		const out: SessionReviewFacts = {
			...r,
			base: { ...r.base, ref: s(r.base.ref) },
			head: { ...r.head, ref: s(r.head.ref) },
		};
		if (!withPr) return out;
		const pr = await facts.prFacts().catch(() => null);
		const withFacts = pr
			? { ...out, title: s(pr.title), body: s(pr.body), files: pr.files.map(s) }
			: out;
		return withThreads
			? { ...withFacts, ...(await this.#sessionThreads()) }
			: withFacts;
	}

	/** The PR's live GitHub threads for `review`, sanitised and capped. */
	async #sessionThreads(): Promise<
		Pick<
			SessionReviewFacts,
			"threads" | "threadsTruncated" | "threadsError" | "threadsReadAt"
		>
	> {
		let listed: ReviewThread[];
		let at: string | undefined;
		try {
			// At most AGENT_GITHUB_MAX_AGE_MS old: "resolved" is GitHub's now.
			const read = this.github.threadsAt
				? await this.github.threadsAt(AGENT_GITHUB_MAX_AGE_MS)
				: { threads: await this.github.threads(AGENT_GITHUB_MAX_AGE_MS) };
			listed = [...liveGithubThreads(read.threads).values()];
			at = "at" in read ? read.at : undefined;
		} catch (error) {
			return { threadsError: oneError(error) };
		}
		const kept = listed.slice(0, MAX_SESSION_THREADS);
		const all = await (
			this.github.comments?.(
				kept.map((t) => t.id),
				AGENT_GITHUB_MAX_AGE_MS,
			) ?? Promise.resolve(null)
		).catch(() => null);
		const s = sanitizeThirdParty;
		const cap = (body: string) => {
			const clean = s(body);
			return clean.length > MAX_SESSION_COMMENT
				? `${clean.slice(0, MAX_SESSION_COMMENT - 1)}…`
				: clean;
		};
		const threads = kept.map((t): SessionGithubThread => {
			const comments = all?.get(t.id);
			return {
				id: s(t.id),
				path: s(t.path),
				line: t.anchor?.line ?? t.line,
				side: t.anchor?.side ?? null,
				resolved: t.resolved,
				outdated: t.outdated,
				comments: (comments ?? [{ author: t.author, body: t.body }]).map(
					(c) => ({ author: s(c.author), body: cap(c.body) }),
				),
				...(comments ? {} : { commentsPartial: true }),
			};
		});
		return {
			threads,
			...(at ? { threadsReadAt: at } : {}),
			...(listed.length > kept.length ? { threadsTruncated: true } : {}),
		};
	}

	/**
	 * The question for a joined session: the thread handed to it and not
	 * yet answered (again, with what was added since), else the oldest
	 * waiting one (not the ACP buddy's last turn), handed to it; null when
	 * none waits.
	 */
	async sessionNext(secret: string): Promise<SessionQuestion | null> {
		await this.#token(secret);
		const { facts, viewer } = this.#facts();
		const threads = await this.#joined(await this.store.read());
		const handed = this.join.handedOut();
		const skipped = this.#skipped();
		const thread =
			(handed &&
				threads.find((t) => t.id === handed.thread && isOpenToAgent(t))) ||
			threads.find((t) => isAgentQuestion(t) && !skipped.has(t.id));
		if (!thread) return null;
		// The read took a while: the session may have left meanwhile.
		if (!this.join.check(secret)) throw new SessionTokenError();
		const joined = this.join.view().joined;
		if (!joined) throw new SessionTokenError();
		const asked = thread.messages.findLast((m) => m.by === "human")?.id;
		this.join.handOut(thread.id, asked);
		// The spawned agent's hand-out: its activity and time limit start.
		const spawned = this.join.isSpawned();
		const rejected = spawned ? this.runner.takeNotice(thread.id) : undefined;
		if (spawned) this.runner.handed(thread.id);
		const role = viewer ? await facts.authorOf(viewer) : undefined;
		const requestText = (o: AgentOrigin) =>
			threads
				.find((t) => t.id === o.thread)
				?.messages.find((m) => m.id === o.message)?.text;
		const messages = thread.messages.map(
			(m): PromptMessage =>
				m.by === "ai"
					? {
							author: { role: "agent" },
							at: m.at,
							text: m.text,
							...(m.origin && requestText(m.origin) !== undefined
								? { re: requestText(m.origin) as string }
								: {}),
						}
					: {
							author:
								viewer && role ? { login: viewer, role } : { role: "reviewer" },
							at: m.at,
							text: m.text,
						},
		);
		// The review conversation: generic instructions and its own messages,
		// no review data (no PR facts, head, file or hunk); the head this
		// session saw stays as it was.
		if (thread.anchor.subject === "review") {
			return {
				preamble: REVIEW_PREAMBLE,
				thread: thread.id,
				replyTo: asked,
				envelope: sessionReviewTurn(thread, messages, rejected),
				anchoredFile: null,
				hunk: null,
			};
		}
		const head = facts.review().head.commit;
		const seen = this.#seen?.since === joined.since ? this.#seen : null;
		const moved =
			joinNotices([
				rejected,
				seen && seen.head !== head
					? `The PR's head moved from ${seen.head} to ${head} since your last question.`
					: undefined,
			]) ?? undefined;
		let pr: PromptCodeEnvelope["pr"];
		if (!seen) {
			pr = await facts.prFacts().then(
				(p) => ({ title: p.title, body: p.body, files: p.files }),
				() => undefined,
			);
		}
		const turn =
			thread.anchor.subject === "thread"
				? await sessionThreadTurn(facts, thread, messages, moved, pr)
				: await sessionSpanTurn(facts, thread, messages, moved, pr);
		const { envelope } = turn;
		const anchor = envelope.thread.anchor;
		// The head this question showed.
		this.#seen = {
			since: joined.since,
			head: envelope.review.head.commit,
			mergeBase: envelope.review.mergeBase,
		};
		return {
			preamble:
				envelope.kind === "github_thread_conversation"
					? `${JOINED_PREAMBLE} ${JOINED_THREAD_PREAMBLE} Here \`hunk\` is the code the thread was opened on.`
					: JOINED_PREAMBLE,
			thread: thread.id,
			replyTo: asked,
			envelope,
			anchoredFile:
				turn.anchored && anchor.subject !== "review"
					? {
							path: anchor.path,
							commit: anchor.commit,
							text: turn.anchored.text,
						}
					: null,
			hunk: turn.hunk,
		};
	}

	/**
	 * A joined session's answer to the thread `next` handed it, answering
	 * human message `replyTo` (a newer one still waits: the fold).
	 */
	async sessionReply(
		secret: string,
		r: { thread: string; replyTo: string; text: string },
	): Promise<AgentThread> {
		await this.#restored;
		// A spawned agent replaced by an approved join may still land the
		// answer it was on (JOIN.acpStopMs): that thread only.
		const live = this.join.check(secret);
		if (!live && !this.join.graceAllows(secret)) throw new SessionTokenError();
		if (!live && !this.join.graceAllows(secret, r.thread)) {
			throw new NotHandedError(r.thread);
		}
		const handed = this.join.handedOut();
		if (live && handed?.thread !== r.thread) throw new NotHandedError(r.thread);
		const found = (await this.store.read()).find((t) => t.id === r.thread);
		if (!found) throw new UnknownAgentThreadError(r.thread);
		// As next gave it: an orphan is a span thread (no suggestion).
		const thread = await this.#joinedOne(found);
		// A GitHub thread conversation's answer may end with the suggestion
		// marker: data on the message, as the ACP buddy's (only a human
		// resolves).
		const { text, suggests } =
			thread.anchor.subject === "thread"
				? takeSuggestion(r.text)
				: { text: r.text, suggests: false };
		if (!text.trim()) throw new BadReplyError("The reply's text is empty");
		if (!thread.messages.some((m) => m.by === "human" && m.id === r.replyTo)) {
			throw new BadReplyError(
				`replyTo ${r.replyTo} isn't a reviewer's message in thread ${r.thread}: pass the replyTo next gave`,
			);
		}
		// Checked again after the read: a leave meanwhile stores nothing.
		let agent: AgentMessage["agent"];
		let spawned: boolean;
		if (live) {
			const joined = this.join.view().joined;
			if (!joined || !this.join.check(secret)) throw new SessionTokenError();
			if (this.join.handedOut()?.thread !== r.thread) {
				throw new NotHandedError(r.thread);
			}
			spawned = this.join.isSpawned();
			agent = spawned
				? { name: joined.name, version: joined.harness ?? "", via: "acp" }
				: {
						name: joined.name,
						version: joined.harness ?? "",
						via: "mcp",
						machine: joined.machine,
					};
		} else {
			const grace = this.join.replaceGrace();
			if (!grace || !this.join.graceAllows(secret, r.thread)) {
				throw new NotHandedError(r.thread);
			}
			spawned = true;
			agent = {
				name: grace.who.name,
				version: grace.who.harness ?? "",
				via: "acp",
			};
		}
		const stored = await this.store.message(r.thread, {
			by: "ai",
			text,
			agent,
			stop: "end_turn",
			// The spawned agent's tool calls while it held the question.
			activity: spawned ? this.runner.activity(r.thread) : [],
			replyTo: r.replyTo,
			...(suggests ? { suggests: "resolve" as const } : {}),
		});
		if (live) this.join.replied(r.thread);
		else this.join.endGrace();
		if (spawned) this.runner.replied(r.thread);
		return this.#view(await this.#joinedOne(stored));
	}

	/**
	 * The agent's `open`, while it answers the question `next` handed it:
	 * a conversation on code (at the head that question showed, its merge
	 * base for LEFT) or on a GitHub thread (continued, when it already has
	 * one), whose message records that question as its origin. It writes
	 * only that agent-thread event: no answer, no wake-up, nothing on
	 * GitHub. A `key` seen before for the same request returns what it wrote.
	 */
	async sessionOpen(
		secret: string,
		r: OpenTarget & { text: string; key?: string },
	): Promise<OpenResult> {
		await this.#token(secret);
		const handed = this.join.handedOut();
		if (!handed?.asked) throw new NotHoldingError();
		if (this.join.isSpawned() && this.runner.pastLimit(handed.thread)) {
			throw new NotHoldingError(
				"The question you hold is past its time limit: open nothing more for it",
			);
		}
		const origin: AgentOrigin = {
			thread: handed.thread,
			message: handed.asked,
		};
		// One open at a time: the 25 cap and a thread's conversation are
		// read and written in one step, so parallel calls can't pass either.
		const run = this.#opens.then(() => this.#open(secret, r, origin));
		this.#opens = run.catch(() => {});
		return run;
	}

	/** Serialises the agent's `open` calls (sessionOpen). */
	#opens: Promise<unknown> = Promise.resolve();

	async #open(
		secret: string,
		r: OpenTarget & { text: string; key?: string },
		origin: AgentOrigin,
	): Promise<OpenResult> {
		if (r.key !== undefined) {
			const known = await this.store.keyed(origin, r.key);
			if (known) {
				return {
					thread: known.thread,
					created: known.opened,
					cite: citeOf(known.thread),
				};
			}
		}
		if (!r.text.trim()) throw new BadReplyError("The text is empty");
		const threads = await this.store.read();
		const request = threads.find((t) => t.id === origin.thread);
		if (
			!request?.messages.some(
				(m) => m.by === "human" && m.id === origin.message,
			)
		) {
			throw new NotHoldingError();
		}
		const started = startedBy(threads).get(origin.message) ?? [];
		const atLimit = started.length >= MAX_OPENED_PER_REQUEST;
		let existing: AgentThreadFold | undefined;
		let anchor: AgentAnchor | undefined;
		if (r.thread !== undefined) {
			existing = await this.#openThreadTarget(r.thread, threads);
			if (!existing) {
				try {
					anchor = await this.#threadAnchor(r.thread, AGENT_GITHUB_MAX_AGE_MS);
				} catch (error) {
					// The reviewer asked there meanwhile: one conversation per
					// thread, so the agent's message continues theirs.
					if (error instanceof AgentConflictError && error.thread) {
						existing = await this.store.find(error.thread);
					} else if (error instanceof AgentRequestError) {
						throw new ThreadUnavailableError(
							`${error.message}: use an id from review's threads`,
						);
					} else throw error;
				}
			}
			if (existing?.id === origin.thread) throw new OwnThreadError();
		} else if (r.code) {
			// A review question showed no head: the review's, not an older question's.
			anchor = await this.#codeAnchor(
				r.code,
				request.anchor.subject === "review",
			);
		} else throw new BadAnchorError("Give code or thread, one of them");
		if (atLimit && !(existing && started.includes(existing.id))) {
			throw new TooManyOpenedError();
		}
		// Checked again after the reads: a leave or a new hand-out meanwhile stores nothing.
		const agent = this.#liveAgent(secret);
		const now = this.join.handedOut();
		if (now?.thread !== origin.thread || now.asked !== origin.message) {
			throw new NotHoldingError();
		}
		// It may have waited behind other opens (#opens) past the limit.
		if (this.join.isSpawned() && this.runner.pastLimit(origin.thread)) {
			throw new NotHoldingError(
				"The question you hold is past its time limit: open nothing more for it",
			);
		}
		const key = r.key !== undefined ? { key: r.key } : {};
		const t = existing
			? await this.store.message(existing.id, {
					by: "ai",
					text: r.text,
					agent,
					origin,
					...key,
				})
			: await this.store.open({
					anchor: anchor as AgentAnchor,
					text: r.text,
					by: "ai",
					agent,
					origin,
					...key,
				});
		// An opening that folded into a conversation the reviewer started
		// meanwhile (one per GitHub thread) continued it.
		const created = !existing && t.messages.length === 1;
		return { thread: t.id, created, cite: citeOf(t.id) };
	}

	/** The joined (or spawned) session's identity, as its messages carry it. */
	#liveAgent(secret: string): NonNullable<AgentMessage["agent"]> {
		const joined = this.join.view().joined;
		if (!joined || !this.join.check(secret)) throw new SessionTokenError();
		return this.join.isSpawned()
			? { name: joined.name, version: joined.harness ?? "", via: "acp" }
			: {
					name: joined.name,
					version: joined.harness ?? "",
					via: "mcp",
					machine: joined.machine,
				};
	}

	/**
	 * GitHub thread `id` for `open`: listed, not deleted, open, and GitHub
	 * readable (else ThreadUnavailableError, as the reviewer's ask fails
	 * closed); its conversation when it has one.
	 */
	async #openThreadTarget(
		id: string,
		threads: readonly AgentThreadFold[],
	): Promise<AgentThreadFold | undefined> {
		let listed: ReviewThread[];
		try {
			listed = await this.github.threads(AGENT_GITHUB_MAX_AGE_MS);
		} catch (error) {
			throw new ThreadUnavailableError(
				`GitHub's threads can't be read now (${oneError(error)}): don't open on a thread; mention it in your reply`,
			);
		}
		const rt = liveGithubThreads(listed).get(id);
		if (!rt) {
			throw new ThreadUnavailableError(
				`No GitHub thread ${id} on this PR (unknown or deleted): use an id from review's threads`,
			);
		}
		if (rt.resolved) {
			throw new ThreadUnavailableError(
				`GitHub thread ${id} is resolved: the reviewer can't ask there, so neither can you`,
			);
		}
		return threads.find(
			(t) => t.anchor.subject === "thread" && t.anchor.thread === id,
		);
	}

	/**
	 * A code anchor for `open`, pinned to the head the held question showed
	 * (its merge base for LEFT lines): the path must be one of the PR's
	 * files, the lines must exist in that version and the columns within
	 * their lines.
	 */
	async #codeAnchor(
		c: Extract<OpenTarget, { code: object }>["code"],
		reviewQuestion = false,
	) {
		const { facts } = this.#facts();
		const joined = this.join.view().joined;
		const seen =
			!reviewQuestion && joined && this.#seen?.since === joined.since
				? this.#seen
				: null;
		const review = facts.review();
		// A review question: the comparison progress reads (#comparisonView).
		// A review question: the very coverage read progress numbers its
		// lines in (head and merge base), so LEFT lines match it.
		let pinned: { head: string; base: string } | null = null;
		const { coverage } = this.#facts();
		if (reviewQuestion && coverage) {
			const view = await this.#comparisonView();
			pinned = await Promise.resolve()
				.then(() => coverage(view?.target))
				.then(
					(c) =>
						OID.test(c.head) && OID.test(c.base)
							? { head: c.head, base: c.base }
							: null,
					() => null,
				);
		}
		const head = pinned?.head ?? seen?.head ?? review.head.commit;
		const mergeBase = pinned?.base ?? seen?.mergeBase ?? review.mergeBase;
		const files = await facts.prFacts().then(
			(p) => p.files,
			() => null,
		);
		if (!files) {
			throw new BadAnchorError(
				"The PR's files can't be read now: mention the code in your reply",
			);
		}
		if (!files.includes(c.path)) {
			throw new BadAnchorError(
				`${c.path} isn't one of the PR's changed files: open only on those (review's files)`,
			);
		}
		if (c.line === undefined) {
			if (
				c.startLine !== undefined ||
				c.startCol !== undefined ||
				c.endCol !== undefined
			) {
				throw new BadAnchorError("startLine and columns need line");
			}
			return { subject: "file", path: c.path, commit: head } as AgentAnchor;
		}
		const side = c.side ?? "RIGHT";
		const startLine = c.startLine ?? c.line;
		const bad = (why: string): never => {
			throw new BadAnchorError(
				`${why} (${c.path} ${side === "LEFT" ? `at the merge base ${mergeBase}` : `at ${head}`})`,
			);
		};
		if (!Number.isInteger(c.line) || !Number.isInteger(startLine)) {
			bad("Lines are whole numbers");
		}
		if (startLine < 1 || startLine > c.line) {
			bad(`startLine ${startLine} must be from 1 to line ${c.line}`);
		}
		const hasCols = c.startCol !== undefined || c.endCol !== undefined;
		if (hasCols && (c.startCol === undefined || c.endCol === undefined)) {
			bad("Give startCol and endCol together");
		}
		const file = await facts
			.anchored({
				subject: "file",
				path: c.path,
				commit: side === "LEFT" ? mergeBase : head,
			})
			.catch(() => null);
		if (!file) {
			bad(
				side === "LEFT"
					? "The file isn't readable on the LEFT side (new, binary or too large)"
					: "The file isn't readable on the RIGHT side (deleted, binary or too large)",
			);
		}
		const lines = (file as { text: string }).text.split("\n");
		if (lines.at(-1) === "") lines.pop();
		if (c.line > lines.length) {
			bad(`line ${c.line} is past the file's ${lines.length} lines`);
		}
		if (hasCols) {
			const startCol = c.startCol as number;
			const endCol = c.endCol as number;
			const first = lines[startLine - 1] ?? "";
			const last = lines[c.line - 1] ?? "";
			if (
				!Number.isInteger(startCol) ||
				!Number.isInteger(endCol) ||
				startCol < 0 ||
				startCol > first.length ||
				endCol < 0 ||
				endCol > last.length ||
				(startLine === c.line && endCol <= startCol)
			) {
				bad(
					`Columns ${startCol}–${endCol} aren't within the lines (UTF-16 offsets; endCol exclusive)`,
				);
			}
		}
		return {
			subject: "line",
			path: c.path,
			commit: head,
			side,
			line: c.line,
			startSide: side,
			startLine,
			...(hasCols ? { startCol: c.startCol, endCol: c.endCol } : {}),
		} as AgentAnchor;
	}

	/**
	 * The reviewer's progress for `progress`, read-only: the comparison the
	 * view of their latest message in the review conversation names (else
	 * the review's default), read with the page's own coverage join. A read
	 * that fails is a CoverageError, never an empty or all-reviewed answer.
	 */
	async sessionProgress(secret: string): Promise<SessionProgress> {
		await this.#token(secret);
		const { coverage } = this.#facts();
		const fail = (why: string) =>
			new CoverageError(
				`The reviewer's progress can't be read now (${why}): say so, don't guess it`,
			);
		if (!coverage) throw fail("this review has no coverage");
		const view = await this.#comparisonView();
		let read: SessionCoverage;
		try {
			read = await coverage(view?.target);
		} catch (error) {
			throw fail(sanitizeThirdParty(oneError(error)));
		}
		if (!OID.test(read.base) || !OID.test(read.head)) {
			throw fail("no commit ids");
		}
		const { total, reviewed, crossedOff } = read.view.progress.lines;
		return {
			comparison: {
				base: read.base,
				head: read.head,
				patchset: read.view.patchset,
				source: view ? "message" : "default",
			},
			files: read.view.files.map(progressFile),
			lines: { total, reviewed, crossedOff },
		};
	}

	/**
	 * "The comparison" for `progress` and a review question's `open`: the
	 * view of the reviewer's message the held question answers (none: the
	 * default); with no question held, the view of the latest human
	 * message in the review conversation; else none (the default).
	 */
	async #comparisonView(): Promise<AgentView | undefined> {
		const threads = await this.store.read();
		const handed = this.join.handedOut();
		if (handed?.asked) {
			const asked = threads
				.find((t) => t.id === handed.thread)
				?.messages.find((m) => m.id === handed.asked);
			if (asked) return asked.view;
		}
		return threads
			.find((t) => t.anchor.subject === "review")
			?.messages.findLast((m) => m.by === "human")?.view;
	}

	/** Every thread, for a joined session. */
	async sessionThreads(secret: string): Promise<AgentThread[]> {
		await this.#token(secret);
		return this.threads();
	}

	/**
	 * The session's own detach. A spawned agent's ends it like Detach
	 * (process stopped, spawn flag cleared, checkout removed, claim
	 * released), after this call answers: it comes from inside its turn.
	 */
	async sessionDetach(secret: string): Promise<void> {
		await this.#token(secret);
		const spawned = this.join.isSpawned();
		this.join.leave("detached");
		if (!spawned) return;
		await this.join.setSpawned(false);
		void this.runner.detach().catch(() => {});
	}

	/** A human asked: a joined session's watcher wakes, else the spawned agent (spawned, or woken over ACP). */
	async #asked(): Promise<void> {
		await this.#restored;
		if (this.join.view().joined && !this.join.isSpawned()) {
			// A message to the thread the ACP buddy still answers waits for
			// that turn to end (buildAgentHost wakes the session then).
			if ((await this.sessionWaiting()) > 0) this.join.wake();
		} else this.runner.asked();
	}

	#resolveView(view: Omit<AgentView, "left" | "right">): AgentView {
		const v = resolveView(view, this.github.patchsets(), this.github.base());
		if (!v) throw new AgentRequestError("view names no patch set or commit");
		return v;
	}

	/** The anchor of a new conversation on GitHub thread `id`; see open(). */
	async #threadAnchor(id: string, maxAgeMs?: number): Promise<AgentAnchor> {
		// The agent's open reads GitHub fresh; the reviewer's ask any read.
		const rt = await this.github.thread(id, maxAgeMs);
		if (!rt || rt.id === "" || rt.unavailable === "deleted") {
			throw new AgentRequestError(`No GitHub thread ${id} to ask about`);
		}
		const anchor: AgentAnchor = {
			subject: "thread",
			thread: rt.id,
			path: rt.path,
			// One GitHub gave unreadably: on no known commit, like "".
			commit: OID.test(rt.commit) ? rt.commit : "",
			...(rt.anchor
				? {
						side: rt.anchor.side,
						line: rt.anchor.line,
						startSide: rt.anchor.startSide,
						startLine: rt.anchor.startLine,
					}
				: {}),
		};
		const existing = (await this.store.read()).find(
			(f) => f.anchor.subject === "thread" && f.anchor.thread === rt.id,
		);
		if (existing) {
			throw new AgentConflictError(
				"This thread already has a conversation",
				existing.id,
			);
		}
		return anchor;
	}

	/** The folds joined with GitHub's threads (joinRead). */
	#joined(folds: AgentThreadFold[]): Promise<AgentThreadFold[]> {
		return joinRead(folds, () => this.github.threads());
	}

	async #joinedOne(t: AgentThreadFold): Promise<AgentThreadFold> {
		return (await this.#joined([t]))[0] ?? t;
	}

	async #view(t: AgentThreadFold): Promise<AgentThread> {
		const { clientId: _, ...thread } = t;
		if (t.anchor.subject !== "line") return thread;
		const code = await this.code(t.anchor, t.at).catch(() => undefined);
		return code ? { ...thread, code } : thread;
	}
}

/** A joined session's turn: the envelope, the anchored file and the code block. */
interface SessionTurn {
	envelope: PromptCodeEnvelope;
	anchored: { text: string } | null;
	hunk: string | null;
}

/**
 * The review conversation's question for a joined (or spawned) session:
 * the thread and its own messages, nothing about the review (owner,
 * 2026-11-15); `notice` only a refused tool call's reason.
 */
function sessionReviewTurn(
	thread: AgentThreadFold,
	messages: PromptMessage[],
	notice: string | undefined,
): PromptReviewEnvelope {
	return sanitizeEnvelope({
		kind: "review_conversation",
		thread: { id: thread.id, anchor: { subject: "review" } },
		messages,
		...(notice ? { notice } : {}),
	});
}

/**
 * A span thread's question for a joined session (the runner's span turn,
 * without the checkout): the review, the anchor, the messages, the
 * anchored file and the hunk around it.
 */
async function sessionSpanTurn(
	facts: RunnerFacts,
	thread: AgentThreadFold,
	messages: PromptMessage[],
	moved: string | undefined,
	pr: PromptCodeEnvelope["pr"],
): Promise<SessionTurn> {
	const review = facts.review();
	const a = thread.anchor as AgentSpanAnchor;
	const notice = joinNotices([
		thread.orphaned
			? `The GitHub thread this conversation was about is gone (deleted, or no longer listed): it is a regular conversation on the thread's last known lines (${a.path} at ${a.commit || "an unknown commit"}).`
			: undefined,
		moved,
	]);
	const envelope = sanitizeEnvelope({
		kind: "agent_thread",
		review,
		thread: {
			id: thread.id,
			anchor: anchorFor(thread.anchor, review),
		},
		messages,
		...(notice ? { notice } : {}),
		...(pr ? { pr } : {}),
	});
	const [anchored, hunk] = await Promise.all([
		facts.anchored(a).catch(() => null),
		facts.hunk(a).catch(() => null),
	]);
	return { envelope, anchored, hunk };
}

/**
 * A GitHub thread conversation's question for a joined session (the
 * runner's thread turn, without the checkout): GitHub's newest head
 * checked first, the view of the last human message, GitHub's thread read
 * now (none when it can't be: never a made-up resolved), and the code the
 * thread was opened on.
 */
async function sessionThreadTurn(
	facts: RunnerFacts,
	thread: AgentThreadFold,
	messages: PromptMessage[],
	moved: string | undefined,
	pr: PromptCodeEnvelope["pr"],
): Promise<SessionTurn> {
	const anchor = thread.anchor as Extract<AgentAnchor, { subject: "thread" }>;
	const checked = await facts.checkHead().then(
		() => undefined,
		(error: unknown) => oneError(error),
	);
	const review = facts.review();
	const { patchsets, current } = facts.views();
	const view = viewOf(thread, patchsets, review);
	let github: GithubThreadFacts | null = null;
	let unread: string | undefined;
	let gone = false;
	if (thread.githubUnknown) unread = "";
	else {
		try {
			github = await facts.github(anchor.thread, view);
			gone = github === null;
		} catch (error) {
			unread = oneError(error);
		}
	}
	const notice = joinNotices([
		unread !== undefined
			? `GitHub couldn't be read${unread ? ` (${unread})` : ""}: the thread's comments and whether it is resolved are not in this prompt.`
			: undefined,
		gone
			? `The GitHub thread (${anchor.path}) is gone: it is no longer listed on GitHub.`
			: undefined,
		checked
			? `carbonless couldn't check GitHub for the PR's newest head (${checked}): \`current\` is the head as last read.`
			: undefined,
		moved,
	]);
	const env = sanitizeEnvelope(
		threadEnvelope({
			review,
			thread: { id: thread.id, anchor },
			github,
			view,
			current,
			patchsets,
			messages,
			...(notice ? { notice } : {}),
			...(pr ? { pr } : {}),
		}),
	);
	const envelope: PromptCodeEnvelope = env;
	const anchored = await facts.anchored(anchor).catch(() => null);
	return { envelope, anchored, hunk: github?.code ?? null };
}

/** The notices that are set, one per line; undefined when none is. */
/**
 * A file's coverage by line for `progress`: its clusters' reviewed,
 * crossed-off and unreviewed lines on each side (pieces.ts marksOf, as
 * the page counts them). Fails closed: a state it doesn't know is
 * unreviewed whatever lines it names, marks are cut to the cluster's
 * lines, and a line both reviewed and crossed off counts crossed off.
 * Paths and labels are sanitised.
 */
function progressFile(f: FileView): SessionProgressFile {
	const s = sanitizeThirdParty;
	const half = () => ({ LEFT: [] as LineRanges, RIGHT: [] as LineRanges });
	const sets = { reviewed: half(), unreviewed: half(), crossedOff: half() };
	const whole: { label?: string; state: ClusterState }[] = [];
	const known = (c: ClusterView) =>
		c.state === "reviewed" ||
		c.state === "crossed-off" ||
		c.state === "unreviewed";
	for (const c of f.clusters) {
		const state: ClusterState = known(c) ? c.state : "unreviewed";
		if (c.kind !== "lines") {
			whole.push({ ...(c.label ? { label: s(c.label) } : {}), state });
			continue;
		}
		const removed = c.removed.length;
		const n = removed + c.added.length;
		const every = all(n);
		const within = (r: LineRanges) => subtract(every, subtract(every, r));
		const marks = known(c) ? marksOf(c) : { reviewed: [], crossed: [] };
		const crossed = within(marks.crossed);
		const reviewed = subtract(within(marks.reviewed), crossed);
		const rest = subtract(every, union(reviewed, crossed));
		const place = (r: LineRanges, into: ReturnType<typeof half>) => {
			for (const [a, b] of r) {
				if (a < removed) {
					into.LEFT.push([c.oldStart + a, c.oldStart + Math.min(b, removed)]);
				}
				if (b > removed) {
					const from = Math.max(a, removed) - removed;
					into.RIGHT.push([c.newStart + from, c.newStart + b - removed]);
				}
			}
		};
		place(reviewed, sets.reviewed);
		place(crossed, sets.crossedOff);
		place(rest, sets.unreviewed);
	}
	const out = (h: ReturnType<typeof half>): SideRanges => ({
		LEFT: normalize(h.LEFT).map(([a, b]) => [a, b - 1]),
		RIGHT: normalize(h.RIGHT).map(([a, b]) => [a, b - 1]),
	});
	return {
		path: s(f.path),
		...(f.oldPath !== undefined ? { oldPath: s(f.oldPath) } : {}),
		status: f.status,
		reviewed: out(sets.reviewed),
		unreviewed: out(sets.unreviewed),
		crossedOff: out(sets.crossedOff),
		...(whole.length > 0 ? { whole } : {}),
	};
}

function joinNotices(parts: (string | undefined)[]): string | undefined {
	return parts.filter(Boolean).join("\n") || undefined;
}

/** An error's message on one line, cut to 300 characters. */
function oneError(error: unknown): string {
	return String((error as Error)?.message ?? error)
		.trim()
		.replace(/\s+/g, " ")
		.slice(0, 300);
}

/**
 * The host with its join broker on `dir` (`<agentsDir()>/<review-id>`):
 * the runner runs only while the broker's spawn flag is set and no session
 * is joined, and approving a join clears the flag and stops the runner
 * (its running turn gets JOIN.acpStopMs, then is cancelled).
 */
export function buildAgentHost(o: {
	dir: string;
	store: AgentThreadStore;
	code: (anchor: AgentAnchor, at: string) => Promise<CodeWindow | undefined>;
	github: AgentGithub;
	runner: (
		acpOff: () => boolean,
		claim: ReviewClaim | undefined,
		join: SpawnJoin,
	) => HostRunner;
	/** The review's agent claim, shared by the runner and the joined session. */
	claim?: ReviewClaim;
	now?: () => number;
	/** What a joined session's tools read (none: those tools fail). */
	session?: SessionFacts;
	/** How long no page request ends a spawned agent (default PAGE_IDLE_MS). */
	pageIdleMs?: number;
	/** The longest that end waits for a turn (default AGENT_TURN_MS). */
	idleTurnMs?: number;
}): AgentHost {
	let runner: HostRunner | undefined;
	// The thread a replaced spawned agent still answers isn't the session's.
	const waiting = async () => {
		const skipped = new Set(
			[join.replaceGrace()?.thread, ...(runner?.fenced() ?? [])].filter(
				(t): t is string => typeof t === "string",
			),
		);
		// Joined with GitHub, as sessionNext reads them: an orphan is a span thread.
		const folds = await joinRead(await o.store.read(), () =>
			o.github.threads(),
		);
		return folds.some((t) => isAgentQuestion(t) && !skipped.has(t.id));
	};
	const join: JoinBroker = new JoinBroker({
		dir: o.dir,
		...(o.now ? { now: o.now } : {}),
		...(o.claim ? { claim: o.claim } : {}),
		// The broker already cleared the spawn flag (before joined.json).
		// Once the ACP buddy's last turn ends (or is cancelled), what it
		// left waiting is the session's: wake its watcher.
		onApproved: async () => {
			void runner
				?.stop(JOIN.acpStopMs)
				.then(async () => {
					if (await waiting()) join.wake();
				})
				.catch(() => {});
		},
		onLeft: () => {},
		waiting: () => waiting(),
	});
	// Off until the reviewer's Spawn; an outside joined session keeps it
	// off even with the flag set (the spawned agent is a joined one too).
	runner = o.runner(
		() => !join.spawned() || (join.isJoined() && !join.isSpawned()),
		o.claim,
		join,
	);
	return new AgentHost(runner, o.store, o.code, o.github, join, o.session, {
		...(o.now ? { now: o.now } : {}),
		...(o.pageIdleMs !== undefined ? { pageIdleMs: o.pageIdleMs } : {}),
		...(o.idleTurnMs !== undefined ? { idleTurnMs: o.idleTurnMs } : {}),
	});
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** The anchored file is sent up to this size (bytes); past it, or binary, not at all. */
const MAX_ANCHORED = 256 * 1024;
/** Lines of the hunk kept on each side of the anchor. */
const HUNK_CONTEXT = 20;

/** What a Session hands its agent: its clone, its review and its live views. */
export interface ReviewAgentSource {
	repo: string;
	reviewId: string;
	viewer: string;
	meta(): PrMeta;
	snapshot(): Snapshot;
	prFacts(): Promise<{ title: string; body: string }>;
	code(anchor: CodeAnchor): Promise<CodeWindow | null>;
	/** The PR's review threads as read from GitHub (their summaries), at most `maxAgeMs` old (default: any). */
	threads(maxAgeMs?: number): Promise<ReviewThread[]>;
	/** As threads, with when that read started (ISO). */
	threadsAt?(
		maxAgeMs: number,
	): Promise<{ threads: ReviewThread[]; at: string }>;
	/** One review thread, null when GitHub doesn't list it; a deleted one says so (`unavailable`). */
	thread(id: string, maxAgeMs?: number): Promise<ReviewThread | null>;
	/** The reviewer's patch sets (`startedAt` in ms). */
	patchsets(): readonly {
		number: number;
		head: string;
		mergeBase: string;
		startedAt: number;
	}[];
	/** The PR's head on GitHub as last read (it may be past the snapshot's). */
	currentHead(): string;
	/** Asks GitHub for the PR's head, fetching a new one into the clone (Session.checkHead). */
	checkHead(): Promise<void>;
	/** The PR author's login. */
	prAuthor(): Promise<string>;
	/**
	 * GitHub thread `id` from the current read, for a thread turn: its
	 * summary, its comments and its placement on `view`; null when GitHub
	 * no longer lists it (or it was deleted).
	 */
	githubThread(id: string, view: AgentView): Promise<AgentThreadRead | null>;
	/** These threads' comments (author, markdown) from a read at most `maxAgeMs` old (default: any), by id. */
	comments?(
		ids: string[],
		maxAgeMs?: number,
	): Promise<Map<string, { author: string; body: string }[]>>;
	/** The coverage the page shows for a comparison (`progress`). */
	coverage?(target?: AgentViewTarget): Promise<SessionCoverage>;
}

/** What the session reads of one GitHub thread for a thread turn. */
export interface AgentThreadRead {
	thread: Pick<
		ReviewThread,
		| "path"
		| "line"
		| "commit"
		| "createdAt"
		| "outdated"
		| "resolved"
		| "anchor"
		| "code"
	>;
	comments: Pick<ThreadComment, "author" | "publishedAt" | "body">[];
	/** The opening comment's REST id (its `#discussion_r` link); null when GitHub gave none. */
	openerRestId: number | null;
	placement?: ThreadPlacement;
}

/**
 * Who `login` is in a thread: the reviewer (the viewer: first, so your own
 * PR's threads read as yours), the PR's author, or someone else. Logins
 * compare as slugs, as the viewer is one.
 */
export function authorOf(
	login: string,
	people: { viewer: string; prAuthor: string },
): CommentRole {
	const who = slugify(login);
	if (who === "") return "other";
	if (who === slugify(people.viewer)) return "reviewer";
	if (who === slugify(people.prAuthor)) return "pr_author";
	return "other";
}

/**
 * A GitHub thread as a thread turn gives it to the prompt: its lines and
 * span columns (both or neither), a link to its first comment (the PR's
 * when GitHub gave no id), the comments with their roles (bodies without
 * a crb marker; a pending one undated) and its code window as diff text.
 */
export function threadFacts(
	read: AgentThreadRead,
	prUrl: string,
	roleOf: (login: string) => CommentRole,
): GithubThreadFacts {
	const { thread: t, comments, openerRestId, placement } = read;
	const a = t.anchor;
	const cols =
		typeof a?.startCol === "number" && typeof a?.endCol === "number"
			? { startCol: a.startCol, endCol: a.endCol }
			: {};
	return {
		url:
			openerRestId !== null && Number.isSafeInteger(openerRestId)
				? `${prUrl}#discussion_r${openerRestId}`
				: prUrl,
		path: t.path,
		startLine: a ? a.startLine : t.line,
		line: t.line,
		...cols,
		openedOn: OID.test(t.commit) ? t.commit : "",
		createdAt: t.createdAt,
		outdated: t.outdated,
		resolved: t.resolved,
		comments: comments.map((c) => ({
			login: c.author,
			role: roleOf(c.author),
			at: c.publishedAt ?? "",
			body: stripMarker(c.body),
		})),
		...(placement ? { placement } : {}),
		code: windowText(t.code),
	};
}

/** A code window's rows as unified diff text; null with none (a file thread, pending). */
export function windowText(code: CodeWindow | null): string | null {
	const rows = code?.rows ?? [];
	if (rows.length === 0) return null;
	const start = (no: "oldNo" | "newNo") =>
		rows.find((r) => r[no] !== null)?.[no] ?? 0;
	const count = (kind: "add" | "del") =>
		rows.filter((r) => r.kind === "context" || r.kind === kind).length;
	const header = `@@ -${start("oldNo")},${count("del")} +${start("newNo")},${count("add")} @@`;
	const sign = { context: " ", add: "+", del: "-" } as const;
	return [header, ...rows.map((r) => `${sign[r.kind]}${r.text}`)].join("\n");
}

/** The setup modal's Saves since the server started (PUT /api/config/agent). */
let agentConfigSaves = 0;
/** A Save, even of the same config: every review's crashed agent may start again. */
export const noteAgentConfigSaved = (): void => {
	agentConfigSaves++;
};
/** How many Saves this server has seen (each review's runner compares). */
export const agentConfigSaveCount = (): number => agentConfigSaves;

/** The agent config from config.json, with the problems that concern it. */
export async function agentConfig(): Promise<{
	agent: AgentConfig | null;
	problems: string[];
}> {
	const { config, problems } = await readConfig();
	return {
		agent: config.agent,
		problems: problems.filter((p) => /^(agent|config\.json)\b/.test(p)),
	};
}

/** The review's agent host: one thread store, one runner, the session's facts. */
export function reviewAgentHost(src: ReviewAgentSource): AgentHost {
	const store = new AgentThreadStore(
		new RefStore(src.repo),
		src.reviewId,
		src.viewer,
	);
	/** The PR author's login; "" when it can't be read (nobody is then). */
	const prAuthor = () => src.prAuthor().catch(() => "");
	const facts: RunnerFacts = {
		review: () => {
			const m = src.meta();
			const s = src.snapshot();
			return {
				repo: `${m.owner}/${m.repo}`,
				pr: m.number,
				url: m.url,
				base: { ref: m.baseBranch, commit: m.baseOid ?? s.base },
				head: { ref: m.headBranch, commit: s.head },
				mergeBase: s.base,
			};
		},
		prFacts: async () => ({
			...(await src.prFacts()),
			files: src.snapshot().files.map((f) => f.path),
		}),
		anchored: (anchor) => anchoredFile(src, anchor),
		hunk: (anchor) => anchorHunk(src, anchor),
		authorOf: async (login) =>
			authorOf(login, { viewer: src.viewer, prAuthor: await prAuthor() }),
		join: (folds) => joinRead(folds, () => src.threads()),
		github: async (id, view) => {
			const read = await src.githubThread(id, view);
			if (!read) return null;
			const author = await prAuthor();
			return threadFacts(read, src.meta().url, (login) =>
				authorOf(login, { viewer: src.viewer, prAuthor: author }),
			);
		},
		views: () => ({
			patchsets: src.patchsets().map((p) => ({
				number: p.number,
				head: p.head,
				mergeBase: p.mergeBase,
				startedAt: new Date(p.startedAt).toISOString(),
			})),
			current: src.currentHead(),
		}),
		// Read-only towards GitHub: it asks for the head and fetches.
		checkHead: () => src.checkHead(),
	};
	const code = async (anchor: AgentAnchor, at: string) => {
		if (anchor.subject !== "line") return undefined;
		const window = await src.code({
			path: anchor.path,
			commit: anchor.commit,
			side: anchor.side,
			line: anchor.line,
			startSide: anchor.startSide,
			startLine: anchor.startLine,
			at,
			startCol: anchor.startCol ?? null,
			endCol: anchor.endCol ?? null,
		});
		return window ?? undefined;
	};
	const dir = join(agentsDir(), src.reviewId);
	return buildAgentHost({
		dir,
		store,
		code,
		github: {
			threads: (maxAgeMs) => src.threads(maxAgeMs),
			thread: (id, maxAgeMs) => src.thread(id, maxAgeMs),
			...(src.threadsAt ? { threadsAt: src.threadsAt.bind(src) } : {}),
			patchsets: () => src.patchsets(),
			base: () => src.snapshot().base,
			...(src.comments ? { comments: src.comments } : {}),
		},
		session: {
			facts,
			viewer: src.viewer,
			...(src.coverage ? { coverage: src.coverage } : {}),
		},
		claim: new ReviewClaim(dir, () => ({
			pid: process.pid,
			port: serverPort(),
		})),
		runner: (acpOff, claim, join) =>
			new AgentRunner({
				join,
				mcp: serverMcp,
				reviewId: src.reviewId,
				config: async () => ({
					...(await agentConfig()),
					saves: agentConfigSaveCount(),
				}),
				store,
				cacheClone: src.repo,
				head: src.snapshot().head,
				port: serverPort(),
				viewer: src.viewer,
				facts,
				acpOff,
				...(claim ? { claim } : {}),
			}),
	});
}

/**
 * The anchored file's text at the anchor's commit (the merge base for a
 * LEFT anchor), read from the clone with a checked OID and a relative
 * path; null when it can't be read, is binary or large, and for the
 * review conversation (no path).
 */
export async function anchoredFile(
	src: Pick<ReviewAgentSource, "repo" | "snapshot"> &
		Partial<Pick<ReviewAgentSource, "patchsets">>,
	anchor: AgentAnchor,
): Promise<{ text: string } | null> {
	// The review conversation has no file.
	if (anchor.subject === "review" || !isSafePath(anchor.path)) return null;
	let commit = anchor.commit;
	if (anchor.subject !== "file" && anchor.side === "LEFT") {
		// A thread's LEFT side: its patch set's merge base, as the prompt says.
		commit =
			(anchor.subject === "thread"
				? src.patchsets?.().find((p) => p.head === anchor.commit)?.mergeBase
				: undefined) ?? src.snapshot().base;
	}
	if (!OID.test(commit)) return null;
	const blob = await runGitBuffer(
		src.repo,
		["cat-file", "blob", `${commit}:${anchor.path}`],
		{ allowFailure: true },
	);
	if (blob.length === 0 || blob.length > MAX_ANCHORED || blob.includes(0)) {
		return null;
	}
	return { text: blob.toString("utf8") };
}

/**
 * The snapshot's diff hunk around a line anchor, as unified diff text,
 * HUNK_CONTEXT lines each side of the anchored range; null for a file
 * anchor, an unsafe path or a file the snapshot doesn't change.
 */
export async function anchorHunk(
	src: Pick<ReviewAgentSource, "repo" | "snapshot">,
	anchor: AgentAnchor,
): Promise<string | null> {
	if (anchor.subject !== "line" || !isSafePath(anchor.path)) return null;
	const snapshot = src.snapshot();
	const file = snapshot.files.find(
		(f) => f.path === anchor.path || f.oldPath === anchor.path,
	);
	if (!file) return null;
	const { hunks } = await loadFileHunks(src.repo, snapshot, file.index, {
		headings: false,
	});
	const numberOf = (l: DiffLine, side: "LEFT" | "RIGHT") =>
		side === "LEFT" ? l.oldNo : l.newNo;
	const touches = (l: DiffLine) => {
		const no = numberOf(l, anchor.side);
		const from = anchor.startSide === anchor.side ? anchor.startLine : 1;
		return no !== undefined && no >= from && no <= anchor.line;
	};
	const hunk = hunks.find((h) => h.lines.some(touches));
	if (!hunk) return null;
	// GitHub's order: a cut hunk's clusters each list removed-then-added.
	const ordered = inGitOrder(hunk.lines);
	const first = ordered.findIndex(touches);
	const last = ordered.findLastIndex(touches);
	const lines = ordered.slice(
		Math.max(0, first - HUNK_CONTEXT),
		last + HUNK_CONTEXT + 1,
	);
	const start = (side: "LEFT" | "RIGHT") =>
		lines.find((l) => numberOf(l, side) !== undefined)?.[
			side === "LEFT" ? "oldNo" : "newNo"
		] ?? 0;
	const count = (kind: DiffLine["kind"]) =>
		lines.filter((l) => l.kind === "context" || l.kind === kind).length;
	const header = `@@ -${start("LEFT")},${count("del")} +${start("RIGHT")},${count("add")} @@`;
	const sign = { context: " ", add: "+", del: "-" } as const;
	return [header, ...lines.map((l) => `${sign[l.kind]}${l.text}`)].join("\n");
}
