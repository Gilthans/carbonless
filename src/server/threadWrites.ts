import { escapeTags, unescapeTags } from "../shared/markdownEscape.js";
import {
	type DeleteAnswer,
	type EditRequest,
	MAX_REPLY,
	type PrOverview,
	type ReplyRequest,
	type ThreadGone,
	type ThreadUpdate,
} from "../shared/types.js";
import { visibleAt } from "./commentTime.js";
import { GhError, WriteRefusedError } from "./errors.js";
import {
	deleteComment,
	type EditedComment,
	fetchComment,
	fetchThread,
	fetchThreadContents,
	type PostedReply,
	type PrRef,
	patchComment,
	postReply,
	postResolved,
} from "./gh.js";
import { markerText, stripMarker } from "./marker.js";
import {
	DELETED_BODY,
	isDeletedBody,
	mapComments,
	mapThreads,
	withContent,
} from "./overview.js";
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
	/**
	 * Drops thread `id` (its last comment deleted, a re-read started at
	 * `startedAt` ms) from every kept read that started no later.
	 */
	drop: (id: string, seq: number, startedAt: number) => void;
	/** Whether a kept read has thread `id` dropped (drop). */
	dropped: (id: string) => boolean;
	/** Whether this session deleted comment `nodeId` (GraphQL may still list it). */
	deletedHere: (nodeId: string) => boolean;
	/** Remembers comment `nodeId` as deleted by this session. */
	markDeleted: (nodeId: string) => void;
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

/**
 * How a write waits between its re-reads (LIST_WAITS_MS). Tests replace
 * `sleep` to decide what GitHub shows by then, independent of the clock.
 */
export const writeWaits = {
	sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
};

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

export function writesOff(target: Pick<ThreadWriteTarget, "writes">): void {
	if (target.writes === "on") return;
	throw new WriteRefusedError(
		target.writes === "as-of"
			? "Writing to GitHub is off as of a cutoff"
			: "Writing to GitHub is off when viewing as someone else",
		"writes-off",
	);
}

export const gone = (message = "The thread is gone from GitHub") =>
	new WriteRefusedError(message, "gone");

/**
 * The most characters `body` may have as typed when it is too long once
 * escaped for GitHub (escapeTags, which GitHub's limit counts); null
 * when it fits.
 */
function tooLong(body: string): number | null {
	const posted = escapeTags(body).length;
	return posted > MAX_REPLY ? MAX_REPLY - (posted - body.length) : null;
}

/** Why a reply can't be sent as it is; null when it can. */
export function replyProblem(req: unknown): string | null {
	const r = obj(req);
	if (typeof r.body !== "string" || !r.body.trim()) {
		return "A reply can't be blank";
	}
	const reply = tooLong(r.body);
	if (reply !== null) return `A reply is at most ${reply} characters`;
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
 * viewer, the same body as posted (escapeTags; line ends and trailing
 * whitespace aside), and
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
	const want = normal(escapeTags(body));
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
export interface Reread {
	nodes: ThreadNodes | null;
	seq: number;
	startedAt: number;
}

/** Thread `id`'s summary and content as GitHub has them now (null if gone). */
export async function reread(
	target: ThreadWriteTarget,
	id: string,
): Promise<Reread> {
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

export const lists = (nodes: ThreadNodes, nodeId: string) =>
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
	const author = {
		login: posted.author,
		__typename: "User",
		avatarUrl: posted.avatarUrl,
	};
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
				// The viewer's own, just posted: theirs to edit or delete.
				...(posted.restId > 0 ? { databaseId: posted.restId } : {}),
				viewerDidAuthor: true,
				viewerCanUpdate: true,
				viewerCanDelete: true,
				lastEditedAt: null,
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
	// What this session deleted stays out, even while GraphQL lists it.
	nodes = withoutDeleted(target, nodes);
	target.apply(threadId, nodes, read.seq, read.startedAt);
	const [thread] = mapThreads([withContent(nodes.summary, nodes.content)], {
		prAuthor: await target.prAuthor(),
		viewer: target.viewer,
		writes: true,
	});
	if (!thread) {
		throw new GhError("gh returned an unexpected response for the thread");
	}
	const comments = {
		threadId,
		...mapComments(nodes.summary, nodes.content, undefined, true),
	};
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
		await writeWaits.sleep(wait);
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
			await writeWaits.sleep(wait);
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
		// GitHub would drop the tags in `List<String>`: escaped, as typed.
		reply = await postReply(
			target.ref,
			commentId,
			escapeTags(req.body),
			target.prUrl,
		);
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

/** Why an edit can't be saved as it is; null when it can. */
export function editProblem(req: unknown): string | null {
	const r = obj(req);
	if (typeof r.body !== "string" || !r.body.trim()) {
		return "A comment can't be blank: delete it instead";
	}
	const edit = tooLong(r.body);
	if (edit !== null) return `A comment is at most ${edit} characters`;
	if (typeof r.from !== "string") return "from must be a string";
	if (typeof r.force !== "boolean") return "force must be true or false";
	return null;
}

/** The comments of a thread's content node, opener first. */
const contentComments = (nodes: ThreadNodes) =>
	arr(obj(obj(nodes.content).comments).nodes).map(obj);

/** A comment's REST id (GraphQL databaseId), which edits and deletes go to. */
function restIdOf(comment: Json): number | null {
	const id = comment.databaseId;
	return typeof id === "number" && Number.isSafeInteger(id) && id > 0
		? id
		: null;
}

/** Only the viewer's own comments are edited or deleted (not others', even where GitHub would). */
function ownOnly(comment: Json): void {
	if (comment.viewerDidAuthor !== true) {
		throw new WriteRefusedError(
			"Only your own comments can be edited or deleted",
			"forbidden",
		);
	}
}

/** `nodes` with comment `nodeId`'s text as an edit's REST answer has it. */
export function withEdited(
	nodes: ThreadNodes,
	nodeId: string,
	edited: EditedComment,
): ThreadNodes {
	const c = obj(nodes.content);
	const list = obj(c.comments);
	return {
		summary: nodes.summary,
		content: {
			...c,
			comments: {
				...list,
				nodes: arr(list.nodes).map((n) =>
					str(obj(n).id) === nodeId
						? {
								...obj(n),
								body: edited.body,
								bodyText: edited.bodyText,
								bodyHTML: edited.bodyHtml,
								// GitHub's own when it already shows this text (REST's
								// updated_at is set on a never-edited comment too).
								lastEditedAt:
									normal(str(obj(n).body)) === normal(edited.body)
										? (obj(n).lastEditedAt ?? null)
										: edited.updatedAt || str(obj(n).lastEditedAt) || null,
							}
						: n,
				),
			},
		},
	};
}

/** `nodes` without comment `nodeId` (a delete GitHub doesn't show yet). */
export function withoutComment(
	nodes: ThreadNodes,
	nodeId: string,
): ThreadNodes {
	const drop = (conn: unknown) => {
		const list = obj(conn);
		const all = arr(list.nodes);
		const kept = all.filter((n) => str(obj(n).id) !== nodeId);
		if (kept.length === all.length) return list;
		return {
			...list,
			nodes: kept,
			...(typeof list.totalCount === "number"
				? { totalCount: list.totalCount - (all.length - kept.length) }
				: {}),
		};
	};
	const s = obj(nodes.summary);
	const summaryComments = drop(s.comments);
	const firstGone = ids(s.first).has(nodeId);
	const next = obj(arr(obj(summaryComments).nodes)[0]);
	const lastGone =
		arr(obj(s.comments).nodes).length > 0 &&
		str(obj(arr(obj(s.comments).nodes).at(-1)).id) === nodeId;
	const last = obj(arr(obj(summaryComments).nodes).at(-1));
	const timesOf = (n: Json) => ({
		author: n.author,
		createdAt: n.createdAt,
		publishedAt: n.publishedAt,
		state: n.state,
	});
	return {
		summary: {
			...s,
			comments: summaryComments,
			...(firstGone
				? {
						first: {
							nodes: [
								{
									...next,
									originalCommit: obj(arr(obj(s.first).nodes)[0])
										.originalCommit,
								},
							],
						},
					}
				: {}),
			...(lastGone && last.id ? { latest: { nodes: [timesOf(last)] } } : {}),
		},
		content: {
			...obj(nodes.content),
			comments: drop(obj(nodes.content).comments),
		},
	};
}

/**
 * Re-reads thread `threadId` until `shows` holds of it (GitHub's GraphQL
 * may lag a REST write), after each of LIST_WAITS_MS; the last read either
 * way (its nodes null once the thread is gone).
 */
export async function rereadUntil(
	target: ThreadWriteTarget,
	threadId: string,
	shows: (nodes: ThreadNodes) => boolean,
): Promise<Reread> {
	let read = await reread(target, threadId);
	for (const wait of LIST_WAITS_MS) {
		if (!read.nodes || shows(read.nodes)) break;
		await writeWaits.sleep(wait);
		read = await reread(target, threadId);
	}
	return read;
}

/** A thread's current state: a fresh read, or gone (a thread of this PR's or not). */
async function current(
	target: ThreadWriteTarget,
	threadId: string,
): Promise<Reread & { nodes: ThreadNodes }> {
	const read = await reread(target, threadId);
	if (!read.nodes) throw gone();
	return { ...read, nodes: read.nodes };
}

/**
 * The 409 for an edit of a comment that changed on GitHub since the edit
 * began: with the comment as it is now.
 */
function changed(nodes: ThreadNodes, commentId: string): WriteRefusedError {
	const now = mapComments(
		nodes.summary,
		nodes.content,
		undefined,
		true,
	).comments.find((c) => c.id === commentId);
	return new WriteRefusedError(
		"Changed on GitHub since you opened it",
		"changed",
		undefined,
		now,
	);
}

/** Where a comment was found for a write: the nodes listing it, and its place. */
interface Found {
	nodes: ThreadNodes;
	comment: Json;
	index: number;
	/** Whether GitHub's fresh read lists it (else only a kept read does). */
	fresh: boolean;
}

/**
 * Comment `commentId` in thread `threadId`'s fresh read, else in a kept
 * read (a reply this session just posted that GitHub's GraphQL doesn't
 * list yet); null when neither has it.
 */
function locate(
	target: ThreadWriteTarget,
	threadId: string,
	commentId: string,
	fresh: ThreadNodes,
): Found | null {
	const find = (nodes: ThreadNodes, isFresh: boolean): Found | null => {
		const all = contentComments(nodes);
		const index = all.findIndex((c) => str(c.id) === commentId);
		const comment = all[index];
		return comment ? { nodes, comment, index, fresh: isFresh } : null;
	};
	const kept = target.cached(threadId);
	return find(fresh, true) ?? (kept ? find(kept, false) : null);
}

/** Pending comments (the viewer's unsubmitted review) are left to GitHub's own UI. */
function notPending(comment: Json): void {
	if (visibleAt(comment) === null) {
		throw new WriteRefusedError(
			"Comments in a pending review are edited on GitHub",
			"forbidden",
		);
	}
}

/** Whether published comments follow the opener (a delete then blanks it). */
function othersAfter(
	target: ThreadWriteTarget,
	threadId: string,
	fresh: ThreadNodes,
): boolean {
	// GitHub's fresh list, and the kept read's published comments it lacks
	// (a reply this session just posted, GraphQL not listing it yet); not
	// those this session deleted (GraphQL may still list them). When in
	// doubt they count: blanking is the safe side.
	const kept = target.cached(threadId);
	const all = [
		...contentComments(fresh).slice(1),
		...(kept ? contentComments(kept).slice(1) : []),
	];
	return all.some(
		(c) => visibleAt(c) !== null && !target.deletedHere(str(c.id)),
	);
}

/** `nodes` without the comments this session deleted. */
export function withoutDeleted(
	target: ThreadWriteTarget,
	nodes: ThreadNodes,
): ThreadNodes {
	return contentComments(nodes)
		.map((c) => str(c.id))
		.filter((id) => target.deletedHere(id))
		.reduce((n, id) => withoutComment(n, id), nodes);
}

/**
 * Edits comment `commentId` (its GraphQL node id) of thread `threadId` to
 * `req.body` on GitHub, as the gh login. Its current body is read by REST
 * first (no GraphQL lag): one that already is `req.body` is answered as
 * it is, with no edit sent (a retry that landed); one that isn't
 * `req.from` any more is refused ("changed", with it as it is now)
 * unless `req.force`. A reply GraphQL doesn't list yet is edited all the
 * same (from the kept read). The answer shows the new text even while
 * GitHub's GraphQL still has the old one. One write per thread at a time
 * (Session).
 */
export async function editComment(
	target: ThreadWriteTarget,
	threadId: string,
	commentId: string,
	req: EditRequest,
): Promise<ThreadUpdate> {
	writesOff(target);
	const problem = editProblem(req);
	if (problem) throw new WriteRefusedError(problem, "invalid");
	const now = await current(target, threadId);
	const found = locate(target, threadId, commentId, now.nodes);
	if (!found) throw gone("The comment is gone from GitHub");
	ownOnly(found.comment);
	notPending(found.comment);
	const restId = restIdOf(found.comment);
	if (restId === null) {
		throw new WriteRefusedError(
			"GitHub gave no id to edit the comment by",
			"forbidden",
		);
	}
	const rest = await fetchComment(target.ref, restId);
	if (!rest) throw gone("The comment is gone from GitHub");
	/** The nodes to answer from, with GitHub's REST text in. */
	const answerNodes = (read: Reread, text: EditedComment) => {
		const base =
			read.nodes && lists(read.nodes, commentId) ? read.nodes : found.nodes;
		return withEdited(base, commentId, text);
	};
	// Compared without carbonless's marker, which the page never sees,
	// and put back on the new text (marker.ts). The new text as it would
	// be posted (escapeTags); `from` as the page had it (unescaped).
	const shown = normal(stripMarker(rest.body));
	const typed = escapeTags(req.body);
	if (shown === normal(typed)) {
		return update(target, threadId, answerNodes(now, rest), now, commentId);
	}
	const from = normal(req.from);
	if (!req.force && shown !== from && normal(unescapeTags(shown)) !== from) {
		throw changed(answerNodes(now, rest), commentId);
	}
	const body = typed + markerText(rest.body);
	if (body.length > MAX_REPLY) {
		throw new WriteRefusedError(
			`A comment is at most ${MAX_REPLY - (body.length - req.body.length)} characters`,
			"invalid",
		);
	}
	const edited = await patchOrGone(target, restId, () =>
		patchComment(target.ref, restId, body),
	);
	const shows = (nodes: ThreadNodes) =>
		contentComments(nodes).some(
			(c) =>
				str(c.id) === commentId && normal(str(c.body)) === normal(edited.body),
		);
	const read = await rereadUntil(target, threadId, shows);
	if (!read.nodes) throw gone("Edited, but the thread is gone from GitHub");
	const nodes = shows(read.nodes) ? read.nodes : answerNodes(read, edited);
	return update(target, threadId, nodes, read, commentId);
}

/**
 * Runs an edit of the comment with REST id `restId`; GitHub's 404 means
 * gone only when REST has no such comment either (a 404 is also what a
 * repo GitHub won't show answers): otherwise a refusal.
 */
async function patchOrGone<T>(
	target: ThreadWriteTarget,
	restId: number,
	write: () => Promise<T>,
): Promise<T> {
	try {
		return await write();
	} catch (error) {
		if (error instanceof WriteRefusedError && error.code === "gone") {
			if (await fetchComment(target.ref, restId)) {
				throw new WriteRefusedError(
					`GitHub refused the write: ${error.message}`,
					"forbidden",
				);
			}
			throw gone("The comment is gone from GitHub");
		}
		throw error;
	}
}

/** Thread `threadId` dropped from the kept reads: its last comment is deleted. */
function threadGone(
	target: ThreadWriteTarget,
	threadId: string,
	read: Pick<Reread, "seq" | "startedAt">,
): ThreadGone {
	target.drop(threadId, read.seq, read.startedAt);
	return { threadId, gone: true };
}

/**
 * Deletes comment `commentId` (its GraphQL node id) of thread `threadId`
 * on GitHub, as the gh login. The thread's first comment, with published
 * comments after it, is edited to "[deleted]" instead, so the thread
 * keeps its opener and place (one already blanked is answered as it is:
 * a retry that landed); any other is deleted, a blanked opener left
 * alone too, and a thread left with none is gone (ThreadGone, dropped
 * from the kept reads). A reply GraphQL doesn't list yet is deleted all
 * the same (from the kept read). Already gone (REST has no such comment,
 * or neither the fresh nor a kept read lists it) counts as done. One
 * write per thread at a time (Session).
 */
export async function deleteThreadComment(
	target: ThreadWriteTarget,
	threadId: string,
	commentId: string,
): Promise<DeleteAnswer> {
	writesOff(target);
	const now = await reread(target, threadId);
	if (!now.nodes) {
		// Gone with the thread: done, if it is a thread of this PR's.
		if (target.summaryOf(threadId) !== undefined || target.dropped(threadId)) {
			return threadGone(target, threadId, now);
		}
		throw gone();
	}
	const found = locate(target, threadId, commentId, now.nodes);
	if (!found) return update(target, threadId, now.nodes, now);
	const { comment } = found;
	ownOnly(comment);
	notPending(comment);
	const restId = restIdOf(comment);
	// A delete's 404 means only that the thread is gone.
	if (restId === null) {
		throw new WriteRefusedError(
			"GitHub gave no id to delete the comment by",
			"forbidden",
		);
	}
	if (found.index === 0 && othersAfter(target, threadId, now.nodes)) {
		if (isDeletedBody(str(comment.body))) {
			return update(target, threadId, now.nodes, now, commentId);
		}
		// The marker stays: a retry of the thread's start still finds it.
		const edited = await patchOrGone(target, restId, () =>
			patchComment(
				target.ref,
				restId,
				DELETED_BODY + markerText(str(comment.body)),
			),
		);
		const shows = (nodes: ThreadNodes) =>
			contentComments(nodes).some(
				(c) => str(c.id) === commentId && isDeletedBody(str(c.body)),
			);
		const read = await rereadUntil(target, threadId, shows);
		if (!read.nodes) return threadGone(target, threadId, read);
		const nodes = shows(read.nodes)
			? read.nodes
			: withEdited(read.nodes, commentId, edited);
		return update(target, threadId, nodes, read, commentId);
	}
	try {
		await deleteComment(target.ref, restId);
	} catch (error) {
		if (!(error instanceof WriteRefusedError && error.code === "gone")) {
			throw error;
		}
		// Already deleted (an attempt that landed, or elsewhere) unless REST
		// still has it: a 404 is also what a repo GitHub won't show answers.
		if (await fetchComment(target.ref, restId)) {
			throw new WriteRefusedError(
				`GitHub refused the delete: ${error.message}`,
				"forbidden",
			);
		}
	}
	target.markDeleted(commentId);
	const listed = (nodes: ThreadNodes) =>
		contentComments(nodes).some((c) => str(c.id) === commentId);
	const read = await rereadUntil(target, threadId, (n) => !listed(n));
	if (!read.nodes) return threadGone(target, threadId, read);
	// Deleted (and what this session deleted before): gone from the
	// answer even while GraphQL still lists it.
	const nodes = withoutDeleted(target, read.nodes);
	// None published left (at most the viewer's pending ones, which the
	// lists leave out): gone from the page.
	if (!contentComments(nodes).some((c) => visibleAt(c) !== null)) {
		return threadGone(target, threadId, read);
	}
	return update(target, threadId, nodes, read);
}
