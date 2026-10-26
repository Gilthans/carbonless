import {
	MAX_REPLY,
	type PrOverview,
	type ReplyRequest,
	type ThreadUpdate,
} from "../shared/types.js";
import { visibleAt } from "./commentTime.js";
import { GhError, WriteRefusedError } from "./errors.js";
import {
	fetchThread,
	fetchThreadContents,
	type PostedReply,
	type PrRef,
	postReply,
	postResolved,
} from "./gh.js";
import { mapComments, mapThreads, withContent } from "./overview.js";
import { slugify } from "./slug.js";

/** A thread's summary and content nodes, as a read has them. */
export interface ThreadNodes {
	summary: unknown;
	content: unknown;
}

/** A reply this session posted, by its ReplyRequest.clientId. */
export interface PostedRecord {
	threadId: string;
	/** The comment's node id. */
	nodeId: string;
	/** GitHub's REST answer, when this session posted it (not found by the dedupe). */
	reply?: PostedReply;
}

/** What a thread write needs of the session (Session.#writeTarget). */
export interface ThreadWriteTarget {
	ref: PrRef;
	/** The PR's URL on GitHub (a pending review's link). */
	prUrl: string;
	/** The gh login's slug: whose replies these are. */
	viewer: string;
	writes: PrOverview["writes"];
	prAuthor: () => Promise<string>;
	/** Thread `id`'s summary node from the newest kept read listing it. */
	summaryOf: (id: string) => unknown;
	/** Thread `id`'s summary and content from the newest kept read having both. */
	cached: (id: string) => ThreadNodes | undefined;
	/** A number ordering a write's re-read after earlier ones'. */
	nextSeq: () => number;
	/**
	 * Puts a write's re-read of thread `id`, started at `startedAt` (ms),
	 * into every kept read that started no later.
	 */
	apply: (
		id: string,
		nodes: ThreadNodes,
		seq: number,
		startedAt: number,
	) => void;
	/** The reply this session posted under `clientId`, if any. */
	posted: (clientId: string) => PostedRecord | undefined;
	/** Remembers a reply as posted under `clientId`. */
	remember: (clientId: string, record: PostedRecord) => void;
	/** Whether an attempt under `clientId` failed with its outcome unknown. */
	inDoubt: (clientId: string) => boolean;
	setInDoubt: (clientId: string, doubt: boolean) => void;
	/** Comment ids of replies remembered under other client ids. */
	claimedIds: (exceptClientId: string) => Set<string>;
	/** Sets the kept reads' pendingReview (a 409 turns it on, a reply off). */
	setPendingReview: (pending: { url: string } | null) => void;
}

/** Re-reads of a thread after a reply until GitHub lists it, and the waits between. */
export const LIST_WAITS_MS = [300, 1000];

/** Longest client id, and most known comment ids, a request may carry. */
const MAX_CLIENT_ID = 200;
const MAX_KNOWN_IDS = 10_000;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A body as compared by the dedupe: line ends and trailing space aside. */
const normal = (body: string) => body.replace(/\r\n/g, "\n").trimEnd();

function writesOff(target: ThreadWriteTarget): void {
	if (target.writes === "on") return;
	throw new WriteRefusedError(
		target.writes === "as-of"
			? "Writing to GitHub is off as of a cutoff"
			: "Writing to GitHub is off when viewing as someone else",
		"writes-off",
	);
}

const gone = (message = "The thread is gone from GitHub") =>
	new WriteRefusedError(message, "gone");

/** Why a reply can't be sent as it is; null when it can. */
export function replyProblem(req: unknown): string | null {
	const r = obj(req);
	if (typeof r.body !== "string" || !r.body.trim()) {
		return "A reply can't be blank";
	}
	if (r.body.length > MAX_REPLY) {
		return `A reply is at most ${MAX_REPLY} characters`;
	}
	if (typeof r.attemptedAt !== "string") return "attemptedAt must be a string";
	if (typeof r.retry !== "boolean") return "retry must be true or false";
	// A thread always has its opener: an empty list would let any older
	// identical comment pass for this reply.
	if (
		r.retry === true &&
		Array.isArray(r.knownCommentIds) &&
		r.knownCommentIds.length === 0
	) {
		return "A retry needs the comment ids known when the reply was first sent";
	}
	if (
		typeof r.clientId !== "string" ||
		!r.clientId ||
		r.clientId.length > MAX_CLIENT_ID
	) {
		return `clientId must be a string of 1 to ${MAX_CLIENT_ID} characters`;
	}
	if (
		!Array.isArray(r.knownCommentIds) ||
		r.knownCommentIds.length > MAX_KNOWN_IDS ||
		!r.knownCommentIds.every((id) => typeof id === "string")
	) {
		return `knownCommentIds must be at most ${MAX_KNOWN_IDS} strings`;
	}
	return null;
}

/**
 * The comment in a thread's content that is this reply already: by the
 * viewer, the same body (line ends and trailing whitespace aside), and
 * new to the client when it first sent the reply (not in `known`), nor
 * another reply this session posted (`claimed`). The oldest such one;
 * null if none. No clocks: the client's may be off.
 */
export function findReply(
	content: unknown,
	viewer: string,
	body: string,
	known: readonly string[],
	claimed: ReadonlySet<string> = new Set(),
): Json | null {
	const want = normal(body);
	const old = new Set(known);
	return (
		arr(obj(obj(content).comments).nodes)
			.map(obj)
			.find(
				(c) =>
					slugify(str(obj(c.author).login)) === slugify(viewer) &&
					normal(str(c.body)) === want &&
					visibleAt(c) !== null &&
					!old.has(str(c.id)) &&
					!claimed.has(str(c.id)),
			) ?? null
	);
}

/** The opening comment's REST id, which replies are posted to. */
function openerRestId(summary: unknown): number | null {
	const t = obj(summary);
	const first = obj(
		arr(obj(t.first).nodes)[0] ?? arr(obj(t.comments).nodes)[0],
	);
	const id = first.databaseId;
	return typeof id === "number" && Number.isSafeInteger(id) && id > 0
		? id
		: null;
}

/** A re-read of a thread, ordered (seq) and dated by when it started. */
interface Reread {
	nodes: ThreadNodes | null;
	seq: number;
	startedAt: number;
}

/** Thread `id`'s summary and content as GitHub has them now (null if gone). */
async function reread(target: ThreadWriteTarget, id: string): Promise<Reread> {
	const seq = target.nextSeq();
	const startedAt = Date.now();
	const [summary, contents] = await Promise.all([
		fetchThread(target.ref, id),
		fetchThreadContents([id]),
	]);
	const content = contents.get(id);
	return {
		nodes: summary && content ? { summary, content } : null,
		seq,
		startedAt,
	};
}

const ids = (nodes: unknown) =>
	new Set(arr(obj(nodes).nodes).map((c) => str(obj(c).id)));

const lists = (nodes: ThreadNodes, nodeId: string) =>
	ids(obj(nodes.summary).comments).has(nodeId) &&
	ids(obj(nodes.content).comments).has(nodeId);

/** `nodes` with `posted` added at the end, unless they list it already. */
export function withPosted(
	nodes: ThreadNodes,
	posted: PostedReply,
): ThreadNodes {
	if (lists(nodes, posted.nodeId)) return nodes;
	const s = obj(nodes.summary);
	const c = obj(nodes.content);
	const author = { login: posted.author, __typename: "User" };
	const times = {
		createdAt: posted.createdAt,
		publishedAt: posted.createdAt,
		state: "SUBMITTED",
	};
	const add = (conn: unknown, node: Json) => {
		const list = obj(conn);
		if (ids(list).has(posted.nodeId)) return list;
		return {
			...list,
			nodes: [...arr(list.nodes), node],
			...(typeof list.totalCount === "number"
				? { totalCount: list.totalCount + 1 }
				: {}),
		};
	};
	return {
		summary: {
			...s,
			comments: add(s.comments, { id: posted.nodeId, author, ...times }),
			latest: { nodes: [{ author, ...times }] },
		},
		content: {
			...c,
			comments: add(c.comments, {
				id: posted.nodeId,
				author,
				...times,
				body: posted.body,
				bodyText: posted.bodyText,
				bodyHTML: posted.bodyHtml,
				diffHunk: "",
			}),
		},
	};
}

/**
 * The thread's new state from `nodes`, put into the kept reads that
 * started no later than the re-read (a newer read has fresher data).
 */
async function update(
	target: ThreadWriteTarget,
	threadId: string,
	nodes: ThreadNodes,
	read: Pick<Reread, "seq" | "startedAt">,
	commentId?: string,
): Promise<ThreadUpdate> {
	target.apply(threadId, nodes, read.seq, read.startedAt);
	const [thread] = mapThreads([withContent(nodes.summary, nodes.content)], {
		prAuthor: await target.prAuthor(),
		viewer: target.viewer,
		writes: true,
	});
	if (!thread) {
		throw new GhError("gh returned an unexpected response for the thread");
	}
	const comments = { threadId, ...mapComments(nodes.summary, nodes.content) };
	const comment = commentId
		? comments.comments.find((c) => c.id === commentId)
		: undefined;
	return {
		threadId,
		resolved: thread.resolved,
		commentCount: thread.commentCount,
		lastActivityAt: thread.lastActivityAt,
		attention: thread.attention,
		yourTurn: thread.yourTurn,
		viewerCan: thread.viewerCan,
		comments,
		...(comment ? { comment } : {}),
	};
}

/**
 * The thread's new state with reply `record` in it: GitHub's own list
 * once it shows it (read again after each of LIST_WAITS_MS), else the last
 * read with the posted comment added, so the reply never vanishes from the
 * page before a Refresh. A thread gone by then answers from the kept
 * read's copy with the reply in it: the reply did land.
 */
async function answerWith(
	target: ThreadWriteTarget,
	threadId: string,
	record: PostedRecord,
): Promise<ThreadUpdate> {
	let read = await reread(target, threadId);
	for (const wait of LIST_WAITS_MS) {
		if (!read.nodes || lists(read.nodes, record.nodeId)) break;
		await new Promise((r) => setTimeout(r, wait));
		read = await reread(target, threadId);
	}
	const base = read.nodes ?? target.cached(threadId);
	if (!base || (!record.reply && !lists(base, record.nodeId))) {
		throw gone("Posted, but the thread is gone from GitHub");
	}
	const nodes = record.reply ? withPosted(base, record.reply) : base;
	return update(target, threadId, nodes, read, record.nodeId);
}

/**
 * Posts a reply to thread `threadId` on GitHub, at once, as the gh login.
 * Never twice: a reply this session already posted under `req.clientId`
 * isn't posted again (a resend while the first attempt still ran, or
 * after a reload); a retry (`req.retry`: a resend after a failed or
 * unknown attempt) also looks for it among the thread's comments
 * (findReply) and posts only if it isn't there. The session runs one
 * write per thread at a time (Session.replyToThread). Refusals are
 * WriteRefusedError; anything else a GhError (it may have landed: resend
 * with `retry`).
 */
export async function replyToThread(
	target: ThreadWriteTarget,
	threadId: string,
	req: ReplyRequest,
): Promise<ThreadUpdate> {
	writesOff(target);
	const problem = replyProblem(req);
	if (problem) throw new WriteRefusedError(problem, "invalid");
	const known = target.posted(req.clientId);
	if (known) {
		if (known.threadId !== threadId) {
			throw new WriteRefusedError(
				"This reply was posted to another thread",
				"invalid",
			);
		}
		return answerWith(target, threadId, known);
	}
	let summary = req.retry ? undefined : target.summaryOf(threadId);
	if (req.retry) {
		// An attempt of this session's whose outcome is unknown may have
		// landed without GitHub listing it yet: look again after each wait.
		const waits = target.inDoubt(req.clientId) ? LIST_WAITS_MS : [];
		let now = await reread(target, threadId);
		let found: Json | null = null;
		for (let i = 0; ; i++) {
			if (!now.nodes) throw gone();
			found = findReply(
				now.nodes.content,
				target.viewer,
				req.body,
				req.knownCommentIds,
				target.claimedIds(req.clientId),
			);
			const wait = waits[i];
			if (found || wait === undefined) break;
			await new Promise((r) => setTimeout(r, wait));
			now = await reread(target, threadId);
		}
		if (found) {
			const nodeId = str(found.id);
			target.remember(req.clientId, { threadId, nodeId });
			target.setInDoubt(req.clientId, false);
			// Not a sign about any pending review now: only a post is.
			return update(target, threadId, now.nodes, now, nodeId);
		}
		summary = now.nodes.summary;
	}
	summary ??= await fetchThread(target.ref, threadId);
	if (!summary) throw gone();
	const commentId = openerRestId(summary);
	if (commentId === null) throw gone("GitHub gave no comment to reply to");
	let reply: PostedReply;
	try {
		reply = await postReply(target.ref, commentId, req.body, target.prUrl);
	} catch (error) {
		if (error instanceof WriteRefusedError) {
			if (error.code === "pending-review" && error.url) {
				target.setPendingReview({ url: error.url });
			}
			// GitHub's 404 is also what a repo it won't show answers: gone
			// only if the thread really is.
			if (error.code === "gone" && (await fetchThread(target.ref, threadId))) {
				throw new WriteRefusedError(
					`GitHub refused the reply: ${error.message}`,
					"forbidden",
				);
			}
		}
		// It may have landed: its retry looks harder before posting again.
		if (!(error instanceof WriteRefusedError)) {
			target.setInDoubt(req.clientId, true);
		}
		throw error;
	}
	target.setInDoubt(req.clientId, false);
	const record = { threadId, nodeId: reply.nodeId, reply };
	target.remember(req.clientId, record);
	// It posted: no pending review stands in the way (any more).
	target.setPendingReview(null);
	return answerWith(target, threadId, record);
}

/**
 * Resolves or unresolves thread `threadId` on GitHub (idempotent). Only a
 * thread of this PR: one no kept read lists is checked on GitHub first.
 */
export async function setResolved(
	target: ThreadWriteTarget,
	threadId: string,
	resolved: boolean,
): Promise<ThreadUpdate> {
	writesOff(target);
	if (target.summaryOf(threadId) === undefined) {
		if (!(await fetchThread(target.ref, threadId))) throw gone();
	}
	await postResolved(threadId, resolved);
	const read = await reread(target, threadId);
	if (!read.nodes) throw gone();
	return update(target, threadId, read.nodes, read);
}
