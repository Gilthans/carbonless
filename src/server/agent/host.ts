import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AgentAnchor,
	type AgentConfig,
	type AgentMessageRequest,
	type AgentStatus,
	type AgentThread,
	type AgentView,
	JOIN,
	JOINED_PREAMBLE,
	JOINED_THREAD_PREAMBLE,
	type OpenAgentThreadRequest,
} from "../../shared/agent.js";
import type { ThreadPlacement } from "../../shared/rereview/placement.js";
import type {
	CodeAnchor,
	CodeWindow,
	DiffLine,
	ReviewThread,
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
	mimeTypeOf,
	type PromptEnvelope,
	type PromptMessage,
	sanitizeEnvelope,
	sanitizeThirdParty,
	takeSuggestion,
	threadEnvelope,
} from "./prompt.js";
import { AgentRunner, type RunnerFacts, viewOf } from "./runner.js";
import {
	type AgentThreadFold,
	AgentThreadStore,
	UnknownAgentThreadError,
} from "./store.js";

/** The port this server listens on (serve.ts sets it): the claim names it. */
let listeningPort = 0;
export const setServerPort = (port: number): void => {
	listeningPort = port;
};
export const serverPort = (): number => listeningPort;

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
	| "inFlight"
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
}

/** What a joined session's tools read of the review (reviewAgentHost's facts). */
export interface SessionFacts {
	facts: RunnerFacts;
	viewer?: string;
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
	"threads" | "thread" | "patchsets"
> & {
	/** The snapshot's merge base (a viewed head's, unless it is a patch set's). */
	base(): string;
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
	) {
		this.#restored = join.restore().catch(() => {});
	}

	/** The joined session (by `since`) and the head its last `next` saw. */
	#seen: { since: string; head: string } | null = null;

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
		// The ACP buddy's last turn (it finishes after an Approve) stays
		// visible until it ends, unless the session holds a thread.
		const { answering: acpTurn, error: __, elsewhere: ___, ...rest } = out;
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
				via: "mcp",
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
				: acpTurn
					? { answering: acpTurn }
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

	/** The thread the ACP buddy still answers (after an Approve, for up to JOIN.acpStopMs): `next` skips it. */
	busyThread(): string | null {
		return this.runner.inFlight();
	}

	/** In use by a joined session (or a request to join): the registry doesn't evict it. */
	active(): boolean {
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
	 * so it is left out; an orphan comes with its span anchor.
	 */
	async asked(): Promise<{ id: string; anchor: AgentAnchor; at: string }[]> {
		return (await this.#joined(await this.store.read()))
			.filter((t) => t.anchor.subject !== "thread")
			.map(({ id, anchor, at }) => ({ id, anchor, at }));
	}

	/**
	 * Opens a thread on a span, or on a GitHub thread (`req.thread`): one
	 * listed, with an id and not deleted (else AgentRequestError), and with
	 * no conversation yet (else AgentConflictError naming it). A resend of
	 * an opening already written returns its thread.
	 */
	async open(req: OpenAgentThreadRequest): Promise<AgentThread> {
		// A resend of an opening already stored: its thread, whatever GitHub says now.
		const known = await this.store.openedWith(req.clientId);
		if (known !== undefined) {
			return this.#view(await this.#joinedOne(await this.store.find(known)));
		}
		const view = req.view ? this.#resolveView(req.view) : undefined;
		let anchor: AgentAnchor;
		if (req.span) anchor = req.span;
		else if (req.thread !== undefined) {
			anchor = await this.#threadAnchor(req.thread);
		} else throw new AgentRequestError("A span or a thread, one of them");
		const t = await this.store.open({
			anchor,
			text: req.text,
			by: "human",
			clientId: req.clientId,
			...(view ? { view } : {}),
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
	 * thread, a human action on its card).
	 */
	async setResolved(thread: string, resolved: boolean): Promise<AgentThread> {
		const current = await this.store.find(thread);
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
		this.join.leave("disconnected");
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
		if (this.join.isJoined()) {
			this.join.leave("disconnected");
			return;
		}
		await this.join.setSpawned(false);
		await this.runner.detach();
	}

	/** The reviewer's Disconnect of a joined session; the ACP buddy stays as it is (off). */
	async disconnect(): Promise<void> {
		await this.#restored;
		this.join.leave("disconnected");
	}

	async close(): Promise<void> {
		await this.#restored;
		this.join.close();
		await this.runner.close();
	}

	/** Who answers here besides ACP: a joined session, or one asking to join. */
	buddy(): "joined" | "pending" | null {
		const v = this.join.view();
		return v.joined ? "joined" : v.joinRequest ? "pending" : null;
	}

	/** Whether `secret` is the joined session's token (after a restart's restore). */
	async sessionAllowed(secret: string): Promise<boolean> {
		await this.#restored;
		return this.join.check(secret);
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
		const busy = this.busyThread();
		// Joined with GitHub: an orphan is a span thread (its resolve counts).
		return (await this.#joined(await this.store.read())).filter(
			(t) => isQuestion(t) && t.id !== busy,
		).length;
	}

	/** The review's facts for a joined session, sanitised; `withPr` adds the PR's title, body and files. */
	async sessionReview(
		secret: string,
		withPr: boolean,
	): Promise<SessionReviewFacts> {
		await this.#token(secret);
		const { facts } = this.#facts();
		const { tree: _, ...r } = facts.review();
		const s = sanitizeThirdParty;
		const out: SessionReviewFacts = {
			...r,
			base: { ...r.base, ref: s(r.base.ref) },
			head: { ...r.head, ref: s(r.head.ref) },
		};
		if (!withPr) return out;
		const pr = await facts.prFacts().catch(() => null);
		return pr
			? { ...out, title: s(pr.title), body: s(pr.body), files: pr.files.map(s) }
			: out;
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
		const busy = this.busyThread();
		const thread =
			(handed &&
				threads.find(
					(t) =>
						t.id === handed.thread &&
						(t.anchor.subject === "thread" || !t.resolved),
				)) ||
			threads.find((t) => isQuestion(t) && t.id !== busy);
		if (!thread) return null;
		// The read took a while: the session may have left meanwhile.
		if (!this.join.check(secret)) throw new SessionTokenError();
		const joined = this.join.view().joined;
		if (!joined) throw new SessionTokenError();
		const asked = thread.messages.findLast((m) => m.by === "human")?.id;
		this.join.handOut(thread.id, asked);
		const head = facts.review().head.commit;
		const seen = this.#seen?.since === joined.since ? this.#seen : null;
		const moved =
			seen && seen.head !== head
				? `The PR's head moved from ${seen.head} to ${head} since your last question.`
				: undefined;
		let pr: PromptEnvelope["pr"];
		if (!seen) {
			pr = await facts.prFacts().then(
				(p) => ({ title: p.title, body: p.body, files: p.files }),
				() => undefined,
			);
		}
		const role = viewer ? await facts.authorOf(viewer) : undefined;
		const messages = thread.messages.map(
			(m): PromptMessage =>
				m.by === "ai"
					? { author: { role: "agent" }, at: m.at, text: m.text }
					: {
							author:
								viewer && role ? { login: viewer, role } : { role: "reviewer" },
							at: m.at,
							text: m.text,
						},
		);
		const turn =
			thread.anchor.subject === "thread"
				? await sessionThreadTurn(facts, thread, messages, moved, pr)
				: await sessionSpanTurn(facts, thread, messages, moved, pr);
		const { envelope } = turn;
		// The head this question showed.
		this.#seen = { since: joined.since, head: envelope.review.head.commit };
		return {
			preamble:
				envelope.kind === "github_thread_conversation"
					? `${JOINED_PREAMBLE} ${JOINED_THREAD_PREAMBLE} Here \`hunk\` is the code the thread was opened on.`
					: JOINED_PREAMBLE,
			thread: thread.id,
			replyTo: asked,
			envelope,
			anchoredFile: turn.anchored
				? {
						path: envelope.thread.anchor.path,
						commit: envelope.thread.anchor.commit,
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
		await this.#token(secret);
		const handed = this.join.handedOut();
		if (handed?.thread !== r.thread) throw new NotHandedError(r.thread);
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
		const joined = this.join.view().joined;
		if (!joined || !this.join.check(secret)) throw new SessionTokenError();
		if (this.join.handedOut()?.thread !== r.thread) {
			throw new NotHandedError(r.thread);
		}
		const stored = await this.store.message(r.thread, {
			by: "ai",
			text,
			agent: {
				name: joined.name,
				version: joined.harness ?? "",
				via: "mcp",
				machine: joined.machine,
			},
			stop: "end_turn",
			activity: [],
			replyTo: r.replyTo,
			...(suggests ? { suggests: "resolve" as const } : {}),
		});
		this.join.replied(r.thread);
		return this.#view(await this.#joinedOne(stored));
	}

	/** Every thread, for a joined session. */
	async sessionThreads(secret: string): Promise<AgentThread[]> {
		await this.#token(secret);
		return this.threads();
	}

	/** The session's own detach. */
	async sessionDetach(secret: string): Promise<void> {
		await this.#token(secret);
		this.join.leave("detached");
	}

	/** A human asked: a joined session's watcher wakes, else the ACP runner. */
	async #asked(): Promise<void> {
		await this.#restored;
		if (this.join.view().joined) {
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
	async #threadAnchor(id: string): Promise<AgentAnchor> {
		const rt = await this.github.thread(id);
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

/**
 * Whether a thread waits for an answer, by the runner's rule: a question
 * on a GitHub thread conversation even once that thread is resolved (it
 * was asked), on a span thread only while it is open.
 */
function isQuestion(t: AgentThreadFold): boolean {
	return t.waiting && (t.anchor.subject === "thread" || !t.resolved);
}

/** A joined session's turn: the envelope, the anchored file and the code block. */
interface SessionTurn {
	envelope: PromptEnvelope;
	anchored: { text: string } | null;
	hunk: string | null;
}

/** The review without the ACP buddy's checkout (a joined session has its own copy, if any). */
function noTree(facts: RunnerFacts) {
	const { tree: _, ...review } = facts.review();
	return review;
}

/** The anchor as the envelope gives it, without a path in carbonless's checkout. */
function bareAnchor(anchor: AgentAnchor & { file?: string }): AgentAnchor {
	const { file: _, ...rest } = anchor;
	// Dropping `file` keeps the anchor's kind (a union: Omit would lose it).
	return rest as AgentAnchor;
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
	pr: PromptEnvelope["pr"],
): Promise<SessionTurn> {
	const review = noTree(facts);
	const notice = joinNotices([
		thread.orphaned
			? `The GitHub thread this conversation was about is gone (deleted, or no longer listed): it is a regular conversation on the thread's last known lines (${thread.anchor.path} at ${thread.anchor.commit || "an unknown commit"}).`
			: undefined,
		moved,
	]);
	const envelope = sanitizeEnvelope({
		kind: "agent_thread",
		review,
		thread: {
			id: thread.id,
			anchor: bareAnchor(anchorFor(thread.anchor, review)),
		},
		messages,
		...(notice ? { notice } : {}),
		...(pr ? { pr } : {}),
	});
	const [anchored, hunk] = await Promise.all([
		facts.anchored(thread.anchor).catch(() => null),
		facts.hunk(thread.anchor).catch(() => null),
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
	pr: PromptEnvelope["pr"],
): Promise<SessionTurn> {
	const anchor = thread.anchor as Extract<AgentAnchor, { subject: "thread" }>;
	const checked = await facts.checkHead().then(
		() => undefined,
		(error: unknown) => oneError(error),
	);
	const review = noTree(facts);
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
	const envelope: PromptEnvelope = {
		...env,
		thread: { ...env.thread, anchor: bareAnchor(env.thread.anchor) },
	};
	const anchored = await facts.anchored(anchor).catch(() => null);
	return { envelope, anchored, hunk: github?.code ?? null };
}

/** The notices that are set, one per line; undefined when none is. */
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
	runner: (acpOff: () => boolean, claim?: ReviewClaim) => HostRunner;
	/** The review's agent claim, shared by the runner and the joined session. */
	claim?: ReviewClaim;
	now?: () => number;
	/** What a joined session's tools read (none: those tools fail). */
	session?: SessionFacts;
}): AgentHost {
	let runner: HostRunner | undefined;
	// The thread the ACP buddy still answers isn't the session's.
	const waiting = async () => {
		const busy = runner?.inFlight() ?? null;
		// Joined with GitHub, as sessionNext reads them: an orphan is a span thread.
		const folds = await joinRead(await o.store.read(), () =>
			o.github.threads(),
		);
		return folds.some((t) => isQuestion(t) && t.id !== busy);
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
	// Off until the reviewer's Spawn; a joined session keeps it off even
	// with the flag set.
	runner = o.runner(() => !join.spawned() || join.isJoined(), o.claim);
	return new AgentHost(runner, o.store, o.code, o.github, join, o.session);
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
	/** The PR's review threads as last read from GitHub (their summaries). */
	threads(): Promise<ReviewThread[]>;
	/** One review thread, null when GitHub doesn't list it; a deleted one says so (`unavailable`). */
	thread(id: string): Promise<ReviewThread | null>;
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
	const tree = join(agentsDir(), src.reviewId, "tree");
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
				tree,
			};
		},
		prFacts: async () => ({
			...(await src.prFacts()),
			files: src.snapshot().files.map((f) => f.path),
		}),
		anchored: (anchor) => anchoredFile(src, tree, anchor),
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
			threads: () => src.threads(),
			thread: (id) => src.thread(id),
			patchsets: () => src.patchsets(),
			base: () => src.snapshot().base,
		},
		session: { facts, viewer: src.viewer },
		claim: new ReviewClaim(dir, () => ({
			pid: process.pid,
			port: serverPort(),
		})),
		runner: (acpOff, claim) =>
			new AgentRunner({
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
 * LEFT anchor), read from the clone with a checked OID and a path that
 * stays inside the tree; null when it can't be read, is binary or large.
 */
export async function anchoredFile(
	src: Pick<ReviewAgentSource, "repo" | "snapshot"> &
		Partial<Pick<ReviewAgentSource, "patchsets">>,
	tree: string,
	anchor: AgentAnchor,
): Promise<{ uri: string; mimeType: string; text: string } | null> {
	if (!isSafePath(anchor.path)) return null;
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
	return {
		uri: pathToFileURL(join(tree, anchor.path)).href,
		mimeType: mimeTypeOf(anchor.path),
		text: blob.toString("utf8"),
	};
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
	const first = hunk.lines.findIndex(touches);
	const last = hunk.lines.findLastIndex(touches);
	const lines = hunk.lines.slice(
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
