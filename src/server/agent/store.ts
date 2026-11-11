import { monotonicFactory } from "ulid";
import {
	type AgentActivity,
	type AgentAnchor,
	type AgentIdentity,
	type AgentMessage,
	type AgentStop,
	type AgentThread,
	type AgentView,
	MAX_ACTIVITY_BYTES,
	MAX_ACTIVITY_ENTRIES,
	MAX_AGENT_ERROR,
	MAX_AGENT_TEXT,
	MAX_ORIGIN_REQUEST,
} from "../../shared/agent.js";
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
}

/** Thrown for a thread id the ref doesn't hold (the app answers 404). */
export class UnknownAgentThreadError extends Error {
	constructor(readonly thread: string) {
		super(`Unknown agent thread: ${thread}`);
	}
}

const iso = (ms: number) => new Date(ms).toISOString();
const isAgentEvent = (e: CrbEvent): e is AgentEvent =>
	e.type === "agent-thread-opened" ||
	e.type === "agent-message" ||
	e.type === "agent-thread-resolved" ||
	e.type === "agent-thread-seen";
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
		...(e.type === "agent-message" && e.suggests
			? { suggests: e.suggests }
			: {}),
	};
}

/**
 * The threads, in the order they were opened: events deduplicated by id and
 * sorted by (ts, id). A thread's opening text is its first message; it waits
 * while a human message has no answer (isWaiting); resolved is the last resolve's word.
 * Messages and resolves of a thread never opened are dropped. Openings that
 * anchor the same GitHub thread fold into the first: later openings and
 * everything written under their ids join it. `seenUpTo` is the latest seen
 * message by position; `unread` is an ai message after it.
 */
export function foldAgentThreads(
	events: readonly CrbEvent[],
): AgentThreadFold[] {
	return foldWithAliases(events).threads;
}

interface Folded {
	threads: AgentThreadFold[];
	/** A later opening's thread id → the first opening's, for one GitHub thread. */
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
	const seenUpTo = new Map<string, string[]>();
	for (const e of sorted) {
		const id = alias.get(e.thread) ?? e.thread;
		const thread = threads.get(id);
		switch (e.type) {
			case "agent-thread-opened": {
				// A thread opens once; a second opening of one id is ignored.
				if (thread) continue;
				const github =
					e.anchor.subject === "thread" ? e.anchor.thread : undefined;
				const first = github !== undefined ? byGithub.get(github) : undefined;
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
					...(e.origin ? { origin: e.origin } : {}),
					...(clientId !== undefined ? { clientId } : {}),
				});
				if (github !== undefined) byGithub.set(github, e.thread);
				break;
			}
			case "agent-message":
				thread?.messages.push(messageOf(e));
				break;
			case "agent-thread-resolved":
				if (thread) thread.resolved = e.resolved;
				break;
			case "agent-thread-seen":
				if (thread) seenUpTo.set(id, [...(seenUpTo.get(id) ?? []), e.upTo]);
				break;
		}
	}
	const out = [...threads.values()];
	for (const t of out) {
		t.waiting = isWaiting(t.messages);
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
 * Whether a human message waits for an answer: one after the last ai
 * message's `replyTo` (the last human message its prompt included), or,
 * for an ai message without it, after that ai message.
 */
function isWaiting(messages: readonly AgentMessage[]): boolean {
	let lastAi = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.by === "ai") {
			lastAi = i;
			break;
		}
	}
	const ai = messages[lastAi];
	if (!ai) return messages.length > 0;
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
			/** Why the agent opened it; cut to MAX_ORIGIN_REQUEST characters. */
			origin?: { request: string };
	  };
type MessageInput =
	| { by: "human"; text: string; clientId: string; view?: AgentView }
	| {
			by: "ai";
			text: string;
			agent: AgentIdentity;
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

	/** Opens a thread; a clientId already seen (in memory, or in details.clientId of a stored opened event) returns that thread unchanged. */
	open(input: OpenInput): Promise<AgentThreadFold> {
		return this.#serial(async () => {
			const events = await this.#events();
			if (input.by === "human") {
				const known = this.#opened.get(input.clientId);
				if (known !== undefined) return this.#find(events, known);
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
								...(input.origin
									? {
											origin: {
												request: input.origin.request.slice(
													0,
													MAX_ORIGIN_REQUEST,
												),
											},
										}
									: {}),
							}
						: {
								details: { clientId: input.clientId },
								...(input.view ? { view: input.view } : {}),
							}),
				},
				input.by,
				stampAfter(events),
			);
			return this.#write(events, "crb: agent thread opened", event);
		});
	}

	message(thread: string, input: MessageInput): Promise<AgentThreadFold> {
		return this.#serial(async () => {
			const events = await this.#events();
			const current = this.#find(events, thread);
			// Only a resend to this thread is a no-op: a clientId seen on another
			// thread is a new message here.
			if (
				input.by === "human" &&
				this.#messaged.has(`${thread} ${input.clientId}`)
			) {
				return current;
			}
			const { text, truncated } = capText(input.text);
			const event = newEvent(
				"agent-message",
				this.slug,
				{
					thread,
					text,
					...(truncated ? { truncated } : {}),
					...(input.by === "ai"
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
			return this.#write(events, "crb: agent message", event);
		});
	}

	setResolved(thread: string, resolved: boolean): Promise<AgentThreadFold> {
		return this.#serial(async () => {
			const events = await this.#events();
			this.#find(events, thread);
			const event = newEvent(
				"agent-thread-resolved",
				this.slug,
				{ thread, resolved },
				"human",
				stampAfter(events),
			);
			const summary = `crb: agent thread ${resolved ? "resolved" : "unresolved"}`;
			return this.#write(events, summary, event);
		});
	}

	/**
	 * The reviewer has seen the thread up to a message. Writes nothing when
	 * the thread is already seen up to it or later.
	 */
	seen(thread: string, upTo: string): Promise<AgentThreadFold> {
		return this.#serial(async () => {
			const events = await this.#events();
			const current = this.#find(events, thread);
			const at = current.messages.findIndex((m) => m.id === upTo);
			if (at < 0) throw new Error(`Unknown message: ${upTo}`);
			const mark = current.messages.findIndex((m) => m.id === current.seenUpTo);
			if (mark >= at) return current;
			const event = newEvent(
				"agent-thread-seen",
				this.slug,
				{ thread: current.id, upTo },
				"human",
				stampAfter(events),
			);
			return this.#write(events, "crb: agent thread seen", event);
		});
	}

	/** The ref's events; every human clientId in them is remembered. */
	async #events(): Promise<CrbEvent[]> {
		const events = await this.store.readEvents(this.#ref);
		for (const e of events) this.#remember(e);
		return events;
	}

	#remember(e: CrbEvent): void {
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

	#find(events: readonly CrbEvent[], thread: string): AgentThreadFold {
		const { threads, alias } = foldWithAliases(events);
		const id = alias.get(thread) ?? thread;
		const found = threads.find((t) => t.id === id);
		if (!found) throw new UnknownAgentThreadError(thread);
		return found;
	}

	async #write(
		events: readonly CrbEvent[],
		summary: string,
		event: AgentEvent,
	): Promise<AgentThreadFold> {
		await this.store.appendEvent(this.#ref, summary, event, this.slug);
		this.#remember(event);
		// Folded from what was read plus what was written: no second read.
		return this.#find([...events, event], event.thread);
	}

	#serial<T>(run: () => Promise<T>): Promise<T> {
		const next = this.#writes.then(run);
		this.#writes = next.catch(() => {});
		return next;
	}
}

/** Now, or just after the newest stored event when the clock is behind it. */
function stampAfter(events: readonly CrbEvent[]): number {
	// A loop, not Math.max(...): spreading many events overflows the stack.
	let last = -1;
	for (const e of events) if (e.ts > last) last = e.ts;
	return Math.max(Date.now(), last + 1);
}
