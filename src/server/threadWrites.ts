import {
	MAX_REPLY,
	type PrOverview,
	type ReplyRequest,
	type ThreadComment,
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
	/** A number ordering this write's re-read after earlier ones'. */
	nextSeq: () => number;
	/** Puts a write's re-read of thread `id` into every kept read. */
	apply: (id: string, summary: unknown, content: unknown, seq: number) => void;
}

/**
 * How far before the first attempt a comment may be dated and still be
 * that attempt's (clocks differ between the reviewer's machine and GitHub).
 */
export const DEDUPE_SLACK_MS = 60_000;

/** Re-reads of a thread after a reply until GitHub lists it, and the waits between. */
const LIST_WAITS_MS = [300, 1000];

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

/** Why a reply can't be sent as it is; null when it can. */
export function replyProblem(req: unknown): string | null {
	const r = obj(req);
	if (typeof r.body !== "string" || !r.body.trim())
		return "A reply can't be blank";
	if (r.body.length > MAX_REPLY) {
		return `A reply is at most ${MAX_REPLY} characters`;
	}
	if (
		typeof r.attemptedAt !== "string" ||
		Number.isNaN(Date.parse(r.attemptedAt))
	) {
		return "attemptedAt must be an ISO time";
	}
	if (typeof r.retry !== "boolean") return "retry must be true or false";
	return null;
}

/**
 * The comment in a thread's content that is this reply already: by the
 * viewer, the same body (line ends and trailing whitespace aside), dated
 * no earlier than DEDUPE_SLACK_MS before the first attempt. The latest
 * such one; null if none.
 */
export function findReply(
	content: unknown,
	viewer: string,
	body: string,
	attemptedAt: string,
): Json | null {
	const since = Date.parse(attemptedAt) - DEDUPE_SLACK_MS;
	const want = normal(body);
	const matches = arr(obj(obj(content).comments).nodes)
		.map(obj)
		.filter((c) => {
			const at = visibleAt(c);
			return (
				slugify(str(obj(c.author).login)) === slugify(viewer) &&
				normal(str(c.body)) === want &&
				at !== null &&
				Date.parse(at) >= since
			);
		});
	return matches.at(-1) ?? null;
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

/** Thread `id`'s summary and content as GitHub has them now; null if gone. */
async function readThread(
	ref: PrRef,
	id: string,
): Promise<{ summary: unknown; content: unknown } | null> {
	const [summary, contents] = await Promise.all([
		fetchThread(ref, id),
		fetchThreadContents([id]),
	]);
	const content = contents.get(id);
	if (!summary || !content) return null;
	return { summary, content };
}

const ids = (nodes: unknown) =>
	new Set(arr(obj(nodes).nodes).map((c) => str(obj(c).id)));

/**
 * The thread with `posted` in it: GitHub's own list once it shows it (read
 * again a few times), else the last read with the posted comment added, so
 * the reply never vanishes from the page before a Refresh.
 */
async function readWithReply(
	ref: PrRef,
	id: string,
	posted: PostedReply,
): Promise<{ summary: unknown; content: unknown }> {
	let read = await readThread(ref, id);
	for (const wait of LIST_WAITS_MS) {
		if (!read) break;
		const listed =
			ids(obj(read.summary).comments).has(posted.nodeId) &&
			ids(obj(read.content).comments).has(posted.nodeId);
		if (listed) return read;
		await new Promise((r) => setTimeout(r, wait));
		read = await readThread(ref, id);
	}
	if (!read)
		throw new WriteRefusedError("The thread is gone from GitHub", "gone");
	const s = obj(read.summary);
	const c = obj(read.content);
	const author = { login: posted.author, __typename: "User" };
	const times = {
		createdAt: posted.createdAt,
		publishedAt: posted.createdAt,
		state: "SUBMITTED",
	};
	const add = (conn: unknown, node: Json) => {
		const list = obj(conn);
		if (ids(list).has(posted.nodeId)) return list;
		const nodes = [...arr(list.nodes), node];
		return {
			...list,
			nodes,
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

/** The thread's new state from its re-read, put into the kept reads. */
async function update(
	target: ThreadWriteTarget,
	threadId: string,
	read: { summary: unknown; content: unknown },
	seq: number,
): Promise<ThreadUpdate> {
	target.apply(threadId, read.summary, read.content, seq);
	const [thread] = mapThreads([withContent(read.summary, read.content)], {
		prAuthor: await target.prAuthor(),
		viewer: target.viewer,
		writes: true,
	});
	if (!thread)
		throw new GhError("gh returned an unexpected response for the thread");
	return {
		threadId,
		resolved: thread.resolved,
		commentCount: thread.commentCount,
		lastActivityAt: thread.lastActivityAt,
		attention: thread.attention,
		yourTurn: thread.yourTurn,
		viewerCan: thread.viewerCan,
		comments: { threadId, ...mapComments(read.summary, read.content) },
	};
}

/**
 * Posts a reply to thread `threadId` on GitHub, at once, as the gh login.
 * A retry (`req.retry`: a resend after a failed or unknown attempt) first
 * looks for the reply among the thread's comments (findReply) and posts
 * only if it isn't there, so a reply never lands twice. Refusals are
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
	const gone = () =>
		new WriteRefusedError("The thread is gone from GitHub", "gone");
	const seq = target.nextSeq();
	let summary = req.retry ? undefined : target.summaryOf(threadId);
	if (req.retry) {
		const now = await readThread(target.ref, threadId);
		if (!now) throw gone();
		const found = findReply(
			now.content,
			target.viewer,
			req.body,
			req.attemptedAt,
		);
		if (found) {
			const answer = await update(target, threadId, now, seq);
			const comment = answer.comments.comments.find(
				(c) => c.id === str(found.id),
			);
			return comment ? { ...answer, comment } : answer;
		}
		summary = now.summary;
	}
	summary ??= await fetchThread(target.ref, threadId);
	if (!summary) throw gone();
	const commentId = openerRestId(summary);
	if (commentId === null) {
		throw new WriteRefusedError("GitHub gave no comment to reply to", "gone");
	}
	const posted = await postReply(target.ref, commentId, req.body, target.prUrl);
	const answer = await update(
		target,
		threadId,
		await readWithReply(target.ref, threadId, posted),
		seq,
	);
	const comment: ThreadComment | undefined = answer.comments.comments.find(
		(c) => c.id === posted.nodeId,
	);
	return comment ? { ...answer, comment } : answer;
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
	const gone = () =>
		new WriteRefusedError("The thread is gone from GitHub", "gone");
	const seq = target.nextSeq();
	if (target.summaryOf(threadId) === undefined) {
		if (!(await fetchThread(target.ref, threadId))) throw gone();
	}
	await postResolved(threadId, resolved);
	const read = await readThread(target.ref, threadId);
	if (!read) throw gone();
	return update(target, threadId, read, seq);
}
