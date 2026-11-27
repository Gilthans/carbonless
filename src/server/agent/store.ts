import { monotonicFactory } from "ulid";
import {
	type AgentActivity,
	type AgentAnchor,
	type AgentIdentity,
	type AgentMessage,
	type AgentOrigin,
	type AgentPostedRequest,
	type AgentStop,
	type AgentThread,
	type AgentView,
	agentCommentClientId,
	linkedAnchor,
	MAX_ACTIVITY_BYTES,
	MAX_ACTIVITY_ENTRIES,
	MAX_AGENT_ERROR,
	MAX_AGENT_TEXT,
} from "../../shared/agent.js";
import type {
	MoveSnapshot,
	MoveUndo,
	ThreadMove,
	ThreadRef,
} from "../../shared/rereview/moves.js";
import { TRACER_VERSION } from "../../shared/tracer/index.js";
import type { ThreadAnchorRef } from "../../shared/types.js";
import {
	type AgentEvent,
	type CrbEvent,
	isLowerUlid,
	isSlug,
	newEvent,
} from "../review/events.js";
import type { RefStore } from "../review/refStore.js";

/**
 * The reviewer's private threads with their own agent, as events in
 * `refs/crb/reviews/<id>/reviewers/<reviewer>/agent/threads` of the cache
 * clone. Written only by this server on the reviewer's behalf; never pushed.
 * See docs/review-data-storage.md ("Agent threads ref").
 */

export const agentThreadsRef = (reviewId: string, slug: string): string =>
	`refs/crb/reviews/${reviewId}/reviewers/${slug}/agent/threads`;

/** A thread as stored: the code window is added on read by the caller. */
export interface AgentThreadFold extends Omit<AgentThread, "code"> {
	/** The reviewer's clientId of the opening question. */
	clientId?: string;
	/**
	 * A conversation asked on lines or a file that posted a ```comment block
	 * as a new GitHub thread (CAR-236): it is that thread's conversation
	 * (`anchor` is a thread anchor on the first, by when it was recorded).
	 * `asked` is where it was asked (it shows there again if no thread of
	 * `threads` is still on GitHub, or GitHub can't be read); `threads` the
	 * GitHub threads its blocks started, in the order recorded. Derived on
	 * read from `agent-comment-posted`: nothing more is stored. Ordered by
	 * when GitHub took the comment (its `#discussion_r<id>`, GitHub's
	 * increasing database id), not when the record was written (a record
	 * that failed is written on a later load).
	 */
	joins?: { asked: SpanAskedAnchor; threads: string[] };
}

/**
 * GitHub's id of a review comment, from its link (`…#discussion_r<id>`):
 * increasing with the time GitHub took it. Unknown: last.
 */
function discussionId(url: string): number {
	const m = /#discussion_r(\d+)$/.exec(url);
	return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

/** Where a conversation that can join a GitHub thread was asked: lines or a file. */
export type SpanAskedAnchor = Extract<
	AgentAnchor,
	{ subject: "line" | "file" }
>;

/** The thread anchor a conversation asked at `asked` has once it joins GitHub thread `thread`. */
export function joinedAnchor(
	asked: SpanAskedAnchor,
	thread: string,
): Extract<AgentAnchor, { subject: "thread" }> {
	const { path, commit } = asked;
	if (asked.subject === "file")
		return { subject: "thread", thread, path, commit };
	const { side, line, startSide, startLine } = asked;
	return {
		subject: "thread",
		thread,
		path,
		commit,
		side,
		line,
		startSide,
		startLine,
	};
}

/** Thrown for a seen mark on a message the thread doesn't hold (the app answers 400). */
export class UnknownAgentMessageError extends Error {
	constructor(readonly messageId: string) {
		super(`Unknown agent message: ${messageId}`);
	}
}

/** Thrown for a second review conversation, or one the agent opens; `thread` names the one there. */
export class ReviewConversationError extends Error {
	constructor(
		message: string,
		readonly thread?: string,
	) {
		super(message);
	}
}

/** Thrown for a thread id the ref doesn't hold (the app answers 404). */
export class UnknownAgentThreadError extends Error {
	constructor(readonly thread: string) {
		super(`Unknown agent thread: ${thread}`);
	}
}

/**
 * A link the store won't write (the app answers 409): the conversation is
 * already a GitHub thread's, or that GitHub thread already has one.
 */
export class AgentLinkError extends Error {}

const iso = (ms: number) => new Date(ms).toISOString();
const isAgentEvent = (e: CrbEvent): e is AgentEvent =>
	e.type === "agent-thread-opened" ||
	e.type === "agent-message" ||
	e.type === "agent-thread-resolved" ||
	e.type === "agent-thread-seen" ||
	e.type === "agent-comment-posted" ||
	e.type === "agent-thread-linked";

const clientIdOf = (e: CrbEvent): string | undefined => {
	const id = e.details?.clientId;
	return typeof id === "string" ? id : undefined;
};

/** The message an opened or message event carries. */
function messageOf(
	e: Extract<AgentEvent, { type: "agent-thread-opened" | "agent-message" }>,
): AgentMessage {
	return {
		id: e.id,
		by: e.by,
		at: iso(e.ts),
		text: e.text,
		...(e.truncated !== undefined ? { truncated: e.truncated } : {}),
		...(e.agent ? { agent: e.agent } : {}),
		...(e.type === "agent-message" && e.stop ? { stop: e.stop } : {}),
		...(e.type === "agent-message" && e.activity
			? { activity: e.activity }
			: {}),
		...(e.type === "agent-message" && e.replyTo !== undefined
			? { replyTo: e.replyTo }
			: {}),
		...(e.type === "agent-message" && e.error !== undefined
			? { error: e.error }
			: {}),
		...(e.view ? { view: e.view } : {}),
		...(e.type === "agent-message" && e.head !== undefined
			? { head: e.head }
			: {}),
		...(e.suggests ? { suggests: e.suggests } : {}),
		...(e.origin ? { origin: e.origin } : {}),
	};
}

/**
 * The threads, in the order they were opened: events deduplicated by id and
 * sorted by (ts, id). A thread's opening text is its first message; it waits
 * while a human message has no answer (isWaiting); resolved is the last resolve's word.
 * Messages and resolves of a thread never opened are dropped. Openings that
 * anchor the same GitHub thread fold into the first, and so do review
 * openings (one review conversation): later openings and everything written
 * under their ids join it. A resolve of the review conversation is ignored. `seenUpTo` is the latest seen
 * message by position; `unread` is an ai message after it.
 */
export function foldAgentThreads(
	events: readonly CrbEvent[],
): AgentThreadFold[] {
	return foldWithAliases(events).threads;
}

interface Folded {
	threads: AgentThreadFold[];
	/** A later opening's thread id → the first opening's, for one GitHub thread or the review. */
	alias: ReadonlyMap<string, string>;
}

function foldWithAliases(events: readonly CrbEvent[]): Folded {
	const seen = new Set<string>();
	const sorted = events
		.filter(isAgentEvent)
		.filter((e) => !seen.has(e.id) && seen.add(e.id))
		.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const threads = new Map<string, AgentThreadFold>();
	const alias = new Map<string, string>();
	/** GitHub thread id → the folded thread that anchors it. */
	const byGithub = new Map<string, string>();
	/** The review conversation's thread: later review openings join it. */
	let byReview: string | undefined;
	const seenUpTo = new Map<string, string[]>();
	/** A joined conversation's GitHub threads, with their comment's id. */
	const joinOrder = new Map<string, { thread: string; n: number }[]>();
	for (const e of sorted) {
		const id = alias.get(e.thread) ?? e.thread;
		const thread = threads.get(id);
		switch (e.type) {
			case "agent-thread-opened": {
				// A thread opens once; a second opening of one id is ignored.
				if (thread) continue;
				const github =
					e.anchor.subject === "thread" ? e.anchor.thread : undefined;
				const first =
					github !== undefined
						? byGithub.get(github)
						: e.anchor.subject === "review"
							? byReview
							: undefined;
				const into = first !== undefined ? threads.get(first) : undefined;
				if (into && first !== undefined) {
					alias.set(e.thread, first);
					into.messages.push(messageOf(e));
					break;
				}
				const clientId = e.by === "human" ? clientIdOf(e) : undefined;
				threads.set(e.thread, {
					id: e.thread,
					anchor: e.anchor,
					openedBy: e.by,
					at: iso(e.ts),
					messages: [messageOf(e)],
					resolved: false,
					waiting: false,
					unread: false,
					...(clientId !== undefined ? { clientId } : {}),
				});
				if (github !== undefined) byGithub.set(github, e.thread);
				if (e.anchor.subject === "review") byReview = e.thread;
				break;
			}
			case "agent-message":
				thread?.messages.push(messageOf(e));
				break;
			case "agent-thread-resolved":
				// The review conversation is never resolved.
				if (thread && thread.anchor.subject !== "review") {
					thread.resolved = e.resolved;
				}
				break;
			case "agent-thread-seen":
				if (thread) seenUpTo.set(id, [...(seenUpTo.get(id) ?? []), e.upTo]);
				break;
			case "agent-comment-posted": {
				// Only onto an agent message the thread holds; a block once.
				const m = thread?.messages.find((x) => x.id === e.message);
				if (m?.by !== "ai") break;
				if (m.posted?.some((p) => p.block === e.block)) break;
				m.posted = [
					...(m.posted ?? []),
					{ block: e.block, url: e.github.url, at: iso(e.ts), text: e.text },
				].sort((a, b) => a.block - b.block);
				// Asked on lines or a file, its block started a GitHub thread:
				// the conversation is that thread's (the first one's; a later
				// one is a fallback should the first be gone). One another
				// conversation already holds stays that one's.
				if (!thread) break;
				const gt = e.github.thread;
				const a = thread.anchor;
				const order = { thread: gt, n: discussionId(e.github.url) };
				if (a.subject === "line" || a.subject === "file") {
					if (byGithub.has(gt)) break;
					thread.joins = { asked: a, threads: [gt] };
					thread.anchor = joinedAnchor(a, gt);
					joinOrder.set(id, [order]);
					byGithub.set(gt, id);
				} else if (thread.joins && !byGithub.has(gt)) {
					thread.joins.threads.push(gt);
					joinOrder.get(id)?.push(order);
					byGithub.set(gt, id);
				}
				break;
			}
			case "agent-thread-linked":
				// A span conversation becomes the GitHub thread's, once; a link
				// onto a GitHub thread that has a conversation already is
				// dropped (the conversation stays on its span, still listed).
				if (!thread || thread.anchor.subject === "thread") break;
				if (byGithub.has(e.github)) break;
				thread.anchor = linkedAnchor(thread.anchor, e.github);
				byGithub.set(e.github, id);
				break;
		}
	}
	const out = [...threads.values()];
	// A joined conversation is on the thread GitHub took first.
	for (const t of out) {
		const order = joinOrder.get(t.id);
		if (!t.joins || !order || order.length < 2) continue;
		const sorted = [...order].sort((a, b) => a.n - b.n).map((o) => o.thread);
		t.joins.threads = sorted;
		t.anchor = joinedAnchor(t.joins.asked, sorted[0] as string);
	}
	// A message `open` wrote answers nothing, even when its origin is dropped
	// below (fail safe: a bad origin never makes a question look answered).
	const fromOpen = new Set<string>();
	for (const t of out) {
		for (const m of t.messages) if (m.origin) fromOpen.add(m.id);
	}
	// An origin must name a human message of a folded thread; else it's dropped.
	const human = new Set<string>();
	for (const t of out) {
		for (const m of t.messages)
			if (m.by === "human") human.add(`${t.id} ${m.id}`);
	}
	for (const t of out) {
		for (const m of t.messages) {
			if (!m.origin) continue;
			const target = alias.get(m.origin.thread) ?? m.origin.thread;
			if (!human.has(`${target} ${m.origin.message}`)) delete m.origin;
			else if (target !== m.origin.thread)
				m.origin = { ...m.origin, thread: target };
		}
	}
	for (const t of out) {
		t.waiting = isWaiting(t.messages, fromOpen);
		// The seen mark furthest along; a message the fold doesn't hold counts for nothing.
		let mark = -1;
		for (const upTo of seenUpTo.get(t.id) ?? []) {
			mark = Math.max(
				mark,
				t.messages.findIndex((m) => m.id === upTo),
			);
		}
		const markMessage = t.messages[mark];
		if (markMessage) t.seenUpTo = markMessage.id;
		t.unread = t.messages.some((m, i) => i > mark && m.by === "ai");
	}
	return { threads: out, alias };
}

/**
 * Whether a human message waits for an answer: one after the last answer's
 * `replyTo` (the last human message its prompt included), or, for an answer
 * without it, after that answer. An ai message with an origin (the agent's
 * `open`; `fromOpen`, so also one whose origin was dropped on read)
 * answers nothing and is skipped: it never stops a question waiting.
 */
function isWaiting(
	messages: readonly AgentMessage[],
	fromOpen: ReadonlySet<string>,
): boolean {
	let lastAi = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.by === "ai" && !fromOpen.has(m.id)) {
			lastAi = i;
			break;
		}
	}
	const ai = messages[lastAi];
	if (!ai) return messages.some((m) => m.by === "human");
	const answered = ai.replyTo
		? messages.findIndex((m) => m.id === ai.replyTo)
		: lastAi;
	// A replyTo the fold doesn't hold: the ai message itself is the mark.
	const mark = answered < 0 ? lastAi : answered;
	return messages.some((m, i) => i > mark && m.by === "human");
}

/** The text within MAX_AGENT_TEXT UTF-8 bytes, cut on a code point boundary. */
export function capText(text: string): { text: string; truncated: boolean } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= MAX_AGENT_TEXT) return { text, truncated: false };
	let end = MAX_AGENT_TEXT;
	// Back off from the middle of a multi-byte sequence to its first byte.
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/** The first MAX_ACTIVITY_ENTRIES, then fewer until the JSON fits MAX_ACTIVITY_BYTES. */
export function capActivity(a: AgentActivity[]): AgentActivity[] {
	const out = a.slice(0, MAX_ACTIVITY_ENTRIES);
	while (
		out.length > 0 &&
		Buffer.byteLength(JSON.stringify(out)) > MAX_ACTIVITY_BYTES
	) {
		out.pop();
	}
	return out;
}

const nextUlid = monotonicFactory();

type OpenInput =
	| {
			anchor: AgentAnchor;
			text: string;
			by: "human";
			clientId: string;
			view?: AgentView;
	  }
	| {
			anchor: AgentAnchor;
			text: string;
			by: "ai";
			agent: AgentIdentity;
			/** The request the agent opened it from. */
			origin?: AgentOrigin;
			/** The agent's idempotency key: a key already stored returns that thread. */
			key?: string;
			/** Its text suggests resolving the GitHub thread it opens on. */
			suggests?: "resolve";
	  };
type MessageInput =
	| { by: "human"; text: string; clientId: string; view?: AgentView }
	| {
			by: "ai";
			text: string;
			agent: AgentIdentity;
			/** An origin message (the agent's `open` on a thread): no stop, activity or replyTo. */
			origin: AgentOrigin;
			/** The agent's idempotency key on this thread. */
			key?: string;
			/** Its text suggests resolving the GitHub thread (`open` on one). */
			suggests?: "resolve";
	  }
	| {
			by: "ai";
			text: string;
			agent: AgentIdentity;
			origin?: undefined;
			stop: AgentStop;
			activity: AgentActivity[];
			/** The id of the last human message the prompt included. */
			replyTo?: string;
			/** With stop "error": the agent's reason. */
			error?: string;
			/** The OID of the checkout the answer came from. */
			head?: string;
			suggests?: "resolve";
	  };

/**
 * One reviewer's agent threads in one review. Writes run one at a time per
 * store, each a compare-and-swap commit stamped after the ref's newest event.
 * A human's opening or message carries a clientId: an opening already seen,
 * or a message already seen on the same thread (in this store, or stored in
 * the ref), is not written again. Dedupe and stamping hold within one store:
 * keep one per review and reviewer.
 */
export class AgentThreadStore {
	readonly #ref: string;
	/** An opening's clientId → its thread; seeded from the ref on read. */
	readonly #opened = new Map<string, string>();
	/** `<thread> <clientId>` of every human message; seeded from the ref on read. */
	readonly #messaged = new Set<string>();
	/**
	 * `<request message> <key>` of the agent's keyed writes (an opening, or
	 * an origin message on a thread) → the thread written and whether it was
	 * opened then; seeded from the ref on read.
	 */
	readonly #aiKeys = new Map<string, { thread: string; opened: boolean }>();
	#writes: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly store: RefStore,
		reviewId: string,
		private readonly slug: string,
	) {
		// The id is a ref path segment: anything else could leave the review's refs.
		if (!isLowerUlid(reviewId))
			throw new Error(`Invalid review id: ${reviewId}`);
		if (!isSlug(slug)) throw new Error(`Invalid reviewer slug: ${slug}`);
		this.#ref = agentThreadsRef(reviewId, slug);
	}

	async read(): Promise<AgentThreadFold[]> {
		return foldAgentThreads(await this.#events());
	}

	/**
	 * The threads, and a revision that changes with every write to the ref
	 * (any server's): the tip commit the threads were read from, "" before
	 * the first write.
	 */
	async readWithRevision(): Promise<{
		threads: AgentThreadFold[];
		revision: string;
	}> {
		const { tip, events } = await this.store.readEventsAt(this.#ref);
		for (const e of events) this.#remember(e);
		return { threads: foldAgentThreads(events), revision: tip ?? "" };
	}

	/** The thread with this id (a later opening's id finds the first's); UnknownAgentThreadError if none. */
	async find(thread: string): Promise<AgentThreadFold> {
		return this.#find(await this.#events(), thread);
	}

	/** The thread a human opening with this clientId opened, if any (open() returns it). */
	async openedWith(clientId: string): Promise<string | undefined> {
		await this.#events();
		return this.#opened.get(clientId);
	}

	/** Whether a human message with this clientId is stored in this thread (message() returns the thread unchanged). */
	async messagedWith(thread: string, clientId: string): Promise<boolean> {
		await this.#events();
		return this.#messaged.has(`${thread} ${clientId}`);
	}

	/** Opens a thread; a clientId already seen (in memory, or in details.clientId of a stored opened event) returns that thread unchanged. */
	open(input: OpenInput): Promise<AgentThreadFold> {
		return this.#serial(() =>
			this.#write((events) => {
				const known =
					input.by === "human"
						? this.#opened.get(input.clientId)
						: input.key !== undefined && input.origin
							? this.#aiKeys.get(aiKey(input.origin, input.key))?.thread
							: undefined;
				if (known !== undefined)
					return { unchanged: this.#find(events, known) };
				if (input.anchor.subject === "review") {
					if (input.by !== "human") {
						throw new ReviewConversationError(
							"The review conversation is opened by the reviewer",
						);
					}
					const existing = foldAgentThreads(events).find(
						(t) => t.anchor.subject === "review",
					);
					if (existing) {
						throw new ReviewConversationError(
							"The review already has a conversation",
							existing.id,
						);
					}
				}
				const { text, truncated } = capText(input.text);
				const event = newEvent(
					"agent-thread-opened",
					this.slug,
					{
						thread: nextUlid().toLowerCase(),
						anchor: input.anchor,
						text,
						...(truncated ? { truncated } : {}),
						...(input.by === "ai"
							? {
									agent: input.agent,
									...(input.origin ? { origin: input.origin } : {}),
									...(input.key !== undefined
										? { details: { key: input.key } }
										: {}),
									...(input.suggests ? { suggests: input.suggests } : {}),
								}
							: {
									details: { clientId: input.clientId },
									...(input.view ? { view: input.view } : {}),
								}),
					},
					input.by,
					stampAfter(events),
				);
				return { summary: "crb: agent thread opened", event };
			}),
		);
	}

	message(thread: string, input: MessageInput): Promise<AgentThreadFold> {
		return this.#serial(() =>
			this.#write((events) => {
				const current = this.#find(events, thread);
				// Only a resend to this thread is a no-op: a clientId seen on another
				// thread is a new message here.
				if (
					input.by === "human" &&
					this.#messaged.has(`${thread} ${input.clientId}`)
				) {
					return { unchanged: current };
				}
				// A keyed write already made returns what it wrote, wherever that was.
				const keyed =
					input.by === "ai" && input.origin && input.key !== undefined
						? this.#aiKeys.get(aiKey(input.origin, input.key))
						: undefined;
				if (keyed) return { unchanged: this.#find(events, keyed.thread) };
				const { text, truncated } = capText(input.text);
				const event = newEvent(
					"agent-message",
					this.slug,
					{
						thread,
						text,
						...(truncated ? { truncated } : {}),
						...(input.by === "ai" && input.origin
							? {
									agent: input.agent,
									stop: "end_turn" as const,
									activity: [],
									origin: input.origin,
									...(input.key !== undefined
										? { details: { key: input.key } }
										: {}),
									...(input.suggests ? { suggests: input.suggests } : {}),
								}
							: input.by === "ai"
								? {
										agent: input.agent,
										stop: input.stop,
										activity: capActivity(input.activity),
										...(input.replyTo ? { replyTo: input.replyTo } : {}),
										...(input.stop === "error" && input.error
											? { error: input.error.slice(0, MAX_AGENT_ERROR) }
											: {}),
										...(input.head ? { head: input.head } : {}),
										...(input.suggests ? { suggests: input.suggests } : {}),
									}
								: {
										details: { clientId: input.clientId },
										...(input.view ? { view: input.view } : {}),
									}),
					},
					input.by,
					stampAfter(events),
				);
				return { summary: "crb: agent message", event };
			}),
		);
	}

	setResolved(thread: string, resolved: boolean): Promise<AgentThreadFold> {
		return this.#serial(() =>
			this.#write((events) => {
				this.#find(events, thread);
				const event = newEvent(
					"agent-thread-resolved",
					this.slug,
					{ thread, resolved },
					"human",
					stampAfter(events),
				);
				const summary = `crb: agent thread ${resolved ? "resolved" : "unresolved"}`;
				return { summary, event };
			}),
		);
	}

	/**
	 * The reviewer has seen the thread up to a message. Writes nothing when
	 * the thread is already seen up to it or later.
	 */
	seen(thread: string, upTo: string): Promise<AgentThreadFold> {
		return this.#serial(() =>
			this.#write((events) => {
				const current = this.#find(events, thread);
				const at = current.messages.findIndex((m) => m.id === upTo);
				if (at < 0) throw new UnknownAgentMessageError(upTo);
				const mark = current.messages.findIndex(
					(m) => m.id === current.seenUpTo,
				);
				if (mark >= at) return { unchanged: current };
				const event = newEvent(
					"agent-thread-seen",
					this.slug,
					{ thread: current.id, upTo },
					"human",
					stampAfter(events),
				);
				return { summary: "crb: agent thread seen", event };
			}),
		);
	}

	/**
	 * The reviewer posted block `block` of agent message `message` to
	 * GitHub (after GitHub took it). A block already recorded writes
	 * nothing; a message the thread doesn't hold, or not the agent's, is
	 * UnknownAgentMessageError.
	 */
	posted(thread: string, input: AgentPostedRequest): Promise<AgentThreadFold> {
		return this.#serial(() =>
			this.#write((events) => {
				const current = this.#find(events, thread);
				const m = current.messages.find((x) => x.id === input.message);
				if (m?.by !== "ai") throw new UnknownAgentMessageError(input.message);
				if (m.posted?.some((p) => p.block === input.block))
					return { unchanged: current };
				const event = newEvent(
					"agent-comment-posted",
					this.slug,
					{
						thread: current.id,
						message: input.message,
						block: input.block,
						clientId: agentCommentClientId(
							current.id,
							input.message,
							input.block,
						),
						github: input.github,
						text: capText(input.text).text,
					},
					"human",
					stampAfter(events),
				);
				return { summary: "crb: agent comment posted", event };
			}),
		);
	}

	/**
	 * The thread moves in the ref (`thread-moved`, `thread-move-undone`),
	 * as read: an agent thread's move is dropped unless that thread was
	 * opened on lines (a file thread, a thread conversation and the review
	 * conversation are never moved); a GitHub thread's is kept (the
	 * caller uses it only for a thread GitHub lists). Folding is the
	 * caller's (foldMoves), with the legacy moves it holds.
	 */
	async moves(): Promise<{ moves: ThreadMove[]; undos: MoveUndo[] }> {
		return movesOf(await this.#events());
	}

	/**
	 * Writes a `thread-moved` (by the reviewer); returns the move. `check`
	 * sees the ref's moves as each try reads them (another server may have
	 * written since the caller's check) and throws to refuse the write.
	 */
	move(
		input: {
			thread: ThreadRef;
			on: MoveSnapshot;
			anchor: ThreadAnchorRef;
		},
		check?: MovesCheck,
	): Promise<ThreadMove> {
		const { path, startSide, startLine, side, line } = input.anchor;
		const where = `${oneLinePath(path)}:${line}`;
		const on =
			input.on.patchset !== undefined
				? `PS${input.on.patchset}`
				: input.on.head.slice(0, 7);
		return this.#serial(async () => {
			const { event } = await this.#append((events) => {
				check?.(movesOf(events));
				return {
					summary: `crb: moved a thread to ${where} on ${on}`,
					event: newEvent(
						"thread-moved",
						this.slug,
						{
							thread: { source: input.thread.source, id: input.thread.id },
							on: input.on,
							anchor: { path, startSide, startLine, side, line },
							engine: TRACER_VERSION,
						},
						"human",
						stampAfter(events),
					),
				};
			});
			return {
				id: event.id,
				ts: event.ts,
				thread: event.thread,
				on: event.on,
				anchor: event.anchor,
				engine: event.engine,
			};
		});
	}

	/**
	 * Writes a `thread-move-undone` taking back move `move` of `thread`;
	 * `check` as move's.
	 */
	undoMove(
		thread: ThreadRef,
		move: string,
		check?: MovesCheck,
	): Promise<MoveUndo> {
		return this.#serial(async () => {
			const { event } = await this.#append((events) => {
				check?.(movesOf(events));
				return {
					summary: "crb: undid a thread move",
					event: newEvent(
						"thread-move-undone",
						this.slug,
						{ thread: { source: thread.source, id: thread.id }, move },
						"human",
						stampAfter(events),
					),
				};
			});
			return { id: event.id, ts: event.ts, thread: event.thread, move };
		});
	}

	/**
	 * The reviewer started GitHub thread `github` from this span
	 * conversation: it becomes that thread's conversation. Already linked
	 * to it: nothing written. Refused (AgentLinkError) when the
	 * conversation is another GitHub thread's, or `github` has one.
	 */
	link(thread: string, github: string): Promise<AgentThreadFold> {
		return this.#serial(() =>
			this.#write((events) => {
				const { threads } = foldWithAliases(events);
				const current = this.#find(events, thread);
				if (current.anchor.subject === "thread") {
					if (current.anchor.thread === github) return { unchanged: current };
					throw new AgentLinkError(
						"This conversation is already on a GitHub thread",
					);
				}
				const taken = threads.find(
					(t) => t.anchor.subject === "thread" && t.anchor.thread === github,
				);
				if (taken) {
					throw new AgentLinkError(
						"That GitHub thread already has a conversation",
					);
				}
				const event = newEvent(
					"agent-thread-linked",
					this.slug,
					{ thread: current.id, github },
					"human",
					stampAfter(events),
				);
				return {
					summary: "crb: agent thread linked to a GitHub thread",
					event,
				};
			}),
		);
	}

	/** The ref's events; every human clientId in them is remembered. */
	async #events(): Promise<CrbEvent[]> {
		const events = await this.store.readEvents(this.#ref);
		for (const e of events) this.#remember(e);
		return events;
	}

	#remember(e: CrbEvent): void {
		if (e.by === "ai") {
			this.#rememberKey(e);
			return;
		}
		if (e.by !== "human") return;
		if (e.type !== "agent-thread-opened" && e.type !== "agent-message") return;
		const clientId = clientIdOf(e);
		if (clientId === undefined) return;
		if (e.type === "agent-message") {
			this.#messaged.add(`${e.thread} ${clientId}`);
		} else if (!this.#opened.has(clientId)) {
			this.#opened.set(clientId, e.thread);
		}
	}

	/** The agent's idempotency keys (`details.key`), scoped by the origin's request message. */
	#rememberKey(e: CrbEvent): void {
		const key = e.details?.key;
		if (typeof key !== "string") return;
		if (e.type !== "agent-thread-opened" && e.type !== "agent-message") return;
		if (!e.origin) return;
		const k = aiKey(e.origin, key);
		if (this.#aiKeys.has(k)) return;
		this.#aiKeys.set(k, {
			thread: e.thread,
			opened: e.type === "agent-thread-opened",
		});
	}

	/**
	 * The agent's keyed write from request `origin`, if stored: its thread
	 * (a later opening's id finds the first's) and whether it opened it.
	 */
	async keyed(
		origin: AgentOrigin,
		key: string,
	): Promise<{ thread: string; opened: boolean } | undefined> {
		const events = await this.#events();
		const k = this.#aiKeys.get(aiKey(origin, key));
		if (!k) return undefined;
		const thread = this.#find(events, k.thread).id;
		// An opening folded into a conversation already on its GitHub thread
		// (an alias) continued that one: not opened, as its first call said.
		return { thread, opened: k.opened && thread === k.thread };
	}

	#find(events: readonly CrbEvent[], thread: string): AgentThreadFold {
		const { threads, alias } = foldWithAliases(events);
		const id = alias.get(thread) ?? thread;
		const found = threads.find((t) => t.id === id);
		if (!found) throw new UnknownAgentThreadError(thread);
		return found;
	}

	/**
	 * Appends the event `build` makes from the ref's events, in one commit.
	 * On a moved ref each try reads the new tip and builds again (a fresh
	 * stamp, a fresh check: RefStore.appendBuilt), so an event never lands
	 * stamped or checked against a tip another server has since moved.
	 * `build` throws to refuse. Returns the event and what its try read.
	 */
	async #append<E extends CrbEvent>(
		build: (events: CrbEvent[]) => { summary: string; event: E },
	): Promise<{ events: CrbEvent[]; event: E }> {
		let built: { events: CrbEvent[]; event: E } | undefined;
		await this.store.appendBuilt(this.#ref, this.slug, (events) => {
			for (const e of events) this.#remember(e);
			const { summary, event } = build(events);
			// The last try's is the one that landed.
			built = { events, event };
			return { summary, events: [event] };
		});
		if (!built) throw new Error("appendBuilt landed nothing built");
		this.#remember(built.event);
		return built;
	}

	/**
	 * #append for a thread's event; returns the thread as the write left
	 * it. `build` returns `unchanged` (that try's fold) to write nothing.
	 */
	async #write(
		build: (
			events: CrbEvent[],
		) =>
			| { summary: string; event: AgentEvent }
			| { unchanged: AgentThreadFold },
	): Promise<AgentThreadFold> {
		let out: { events: CrbEvent[]; event: AgentEvent };
		try {
			out = await this.#append((events) => {
				const b = build(events);
				if ("unchanged" in b) throw new Unchanged(b.unchanged);
				return b;
			});
		} catch (error) {
			if (error instanceof Unchanged) return error.value;
			throw error;
		}
		// Folded from what the landing try read plus what it wrote: no second read.
		return this.#find([...out.events, out.event], out.event.thread);
	}

	#serial<T>(run: () => Promise<T>): Promise<T> {
		const next = this.#writes.then(run);
		this.#writes = next.catch(() => {});
		return next;
	}
}

/** Refuses a move or an undo (by throwing) given the ref's moves as read. */
export type MovesCheck = (state: {
	moves: ThreadMove[];
	undos: MoveUndo[];
}) => void;

/** Thrown out of a write's build: write nothing, answer `value`. */
class Unchanged {
	constructor(readonly value: AgentThreadFold) {}
}

/** A path on one line, for a commit's summary. */
const oneLinePath = (path: string) =>
	path.replace(/[\r\n]+/g, " ").slice(0, 200);

/** The moves and undos of a ref's events (AgentThreadStore.moves). */
function movesOf(events: readonly CrbEvent[]): {
	moves: ThreadMove[];
	undos: MoveUndo[];
} {
	const lines = new Set(
		foldAgentThreads(events)
			.filter((t) => t.anchor.subject === "line")
			.map((t) => t.id),
	);
	const movable = (t: ThreadRef) => t.source === "github" || lines.has(t.id);
	const moves: ThreadMove[] = [];
	const undos: MoveUndo[] = [];
	for (const e of events) {
		if (e.by !== "human") continue;
		if (e.type === "thread-moved" && movable(e.thread)) {
			moves.push({
				id: e.id,
				ts: e.ts,
				thread: e.thread,
				on: e.on,
				anchor: e.anchor,
				engine: e.engine,
			});
		} else if (e.type === "thread-move-undone") {
			undos.push({ id: e.id, ts: e.ts, thread: e.thread, move: e.move });
		}
	}
	return { moves, undos };
}

const aiKey = (origin: AgentOrigin, key: string) => `${origin.message} ${key}`;

/** Now, or just after the newest stored event when the clock is behind it. */
function stampAfter(events: readonly CrbEvent[]): number {
	// A loop, not Math.max(...): spreading many events overflows the stack.
	let last = -1;
	for (const e of events) if (e.ts > last) last = e.ts;
	return Math.max(Date.now(), last + 1);
}
