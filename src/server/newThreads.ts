import {
	type CodeAnchor,
	type CodeWindow,
	type DiffSide,
	MAX_REPLY,
	type NewThreadAnswer,
	type NewThreadRequest,
} from "../shared/types.js";
import { GhError, WriteRefusedError } from "./errors.js";
import {
	fetchReviewComments,
	findThreadOf,
	type PostedComment,
	postThread,
	type ThreadPlace,
} from "./gh.js";
import { MARKER_ID, markerFor, parseMarker } from "./marker.js";
import { mapComments, mapThreads, openerOf, withContent } from "./overview.js";
import { slugify } from "./slug.js";
import {
	gone,
	LIST_WAITS_MS,
	lists,
	rereadUntil,
	type ThreadNodes,
	type ThreadWriteTarget,
	withoutDeleted,
	writesOff,
	writeWaits,
} from "./threadWrites.js";

/** A thread this session started (or found started), by its client id. */
export interface StartedRecord {
	/** Its first comment's GraphQL node id. */
	nodeId: string;
	path: string;
	/** GitHub's REST answer (the post's, or the list's a retry found it in). */
	posted: PostedComment;
	/** The thread's id, once GitHub's GraphQL lists it. */
	threadId?: string;
}

/** What starting a thread needs of the session, on top of a thread write's. */
export interface NewThreadTarget extends ThreadWriteTarget {
	/** The snapshot's head: what a new comment's `commit` must be. */
	head: string;
	/** Whether LEFT lines take comments (PrOverview.commentLeft). */
	commentLeft: () => Promise<boolean>;
	started: (clientId: string) => StartedRecord | undefined;
	rememberStarted: (clientId: string, record: StartedRecord) => void;
	/**
	 * Puts a new thread, as a re-read started at `startedAt` (ms) found it,
	 * into every kept read that started no later: listed from then on.
	 */
	add: (id: string, nodes: ThreadNodes, seq: number, startedAt: number) => void;
	/** A thread's code from the clone, checked against GitHub's hunk. */
	code: (anchor: CodeAnchor, hunk: string) => Promise<CodeWindow | null>;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};

const SIDES: readonly unknown[] = ["LEFT", "RIGHT"] satisfies DiffSide[];
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const MAX_LINE = 999_999_999;
const MAX_PATH = 4096;

const absent = (v: unknown) => v === undefined || v === null;
const lineNo = (v: unknown) =>
	typeof v === "number" && Number.isInteger(v) && v > 0 && v <= MAX_LINE;
const col = (v: unknown) =>
	typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_LINE;

/** Why a new thread can't be started as asked; null when it can. */
export function newThreadProblem(req: unknown): string | null {
	const r = obj(req);
	if (typeof r.clientId !== "string" || !MARKER_ID.test(r.clientId)) {
		return "clientId must be 1 to 100 letters, digits or _.:-";
	}
	if (typeof r.body !== "string" || !r.body.trim()) {
		return "A comment can't be blank";
	}
	if (typeof r.attemptedAt !== "string") return "attemptedAt must be a string";
	if (typeof r.retry !== "boolean") return "retry must be true or false";
	if (
		typeof r.path !== "string" ||
		!r.path ||
		r.path.length > MAX_PATH ||
		r.path.includes("\0")
	) {
		return "path must be a file's path";
	}
	if (typeof r.commit !== "string" || !OID.test(r.commit)) {
		return "commit must be a commit id";
	}
	const lineFields = [r.startSide, r.startLine, r.side, r.line];
	const cols = [r.startCol, r.endCol];
	if (r.subject === "file") {
		if (!lineFields.every(absent) || !cols.every(absent)) {
			return "A file comment has no lines or columns";
		}
		return null;
	}
	if (r.subject !== "line") return 'subject must be "line" or "file"';
	if (!SIDES.includes(r.side) || !lineNo(r.line)) {
		return "A line comment needs side and line";
	}
	if (absent(r.startSide) !== absent(r.startLine)) {
		return "startSide and startLine go together";
	}
	if (
		!absent(r.startSide) &&
		(!SIDES.includes(r.startSide) || !lineNo(r.startLine))
	) {
		return "startSide and startLine must be a side and a line";
	}
	const startSide = r.startSide ?? r.side;
	const startLine = (r.startLine ?? r.line) as number;
	const line = r.line as number;
	if (startSide === r.side && startLine > line) {
		return "A range's start comes before its end";
	}
	if (absent(r.startCol) !== absent(r.endCol)) {
		return "startCol and endCol go together";
	}
	if (!absent(r.startCol)) {
		if (!col(r.startCol) || !col(r.endCol)) {
			return "startCol and endCol must be offsets";
		}
		if (
			startSide === r.side &&
			startLine === line &&
			(r.startCol as number) >= (r.endCol as number)
		) {
			return "A span ends after it starts";
		}
	}
	return null;
}

/** Where `req` goes on GitHub: one line has no start (GitHub's own form). */
export function placeOf(req: NewThreadRequest): ThreadPlace {
	if (req.subject === "file") return { subject: "file", path: req.path };
	const side = req.side as DiffSide;
	const line = req.line as number;
	const startSide = req.startSide ?? side;
	const startLine = req.startLine ?? line;
	const single = startSide === side && startLine === line;
	return {
		subject: "line",
		path: req.path,
		side,
		line,
		...(single ? {} : { start: { side: startSide, line: startLine } }),
	};
}

/** The body posted for `req`: as typed, with the marker (marker.ts). */
export function postedBody(req: NewThreadRequest): string {
	const span =
		req.subject === "line" &&
		typeof req.startCol === "number" &&
		typeof req.endCol === "number"
			? {
					startLine: req.startLine ?? (req.line as number),
					startCol: req.startCol,
					line: req.line as number,
					endCol: req.endCol,
				}
			: null;
	return req.body + markerFor(req.clientId, span);
}

/**
 * Starts a thread on GitHub, at once, as the gh login: REST
 * `pulls/{n}/comments` (never GraphQL's addPullRequestReviewThread, which
 * joins a pending review), with carbonless's marker (marker.ts) on the
 * body. Never twice: a thread this session started under `req.clientId`
 * isn't posted again, and a retry (`req.retry`) first looks for the
 * viewer's comment carrying the client id among the PR's (findStarted);
 * either is answered as it is. Only a post is checked: on the snapshot's
 * head ("stale" otherwise), LEFT lines only where GitHub's merge base is
 * the snapshot's (commentLeft), and the length with the marker. The answer is the
 * thread as GitHub's GraphQL lists it, mapped as the overview read maps
 * it, and it joins the session's kept reads. Posted but not listed yet:
 * a GhError (502), whose resend finds it. The session runs these one at
 * a time per PR (Session.startThread).
 */
export async function startThread(
	target: NewThreadTarget,
	req: NewThreadRequest,
): Promise<NewThreadAnswer> {
	writesOff(target);
	const problem = newThreadProblem(req);
	if (problem) throw new WriteRefusedError(problem, "invalid");
	const place = placeOf(req);
	const body = postedBody(req);
	// Landed already (an answer lost, crb restarted): answered as it is,
	// whatever moved since. Only a post is checked against the head.
	let record = target.started(req.clientId);
	if (!record && req.retry) record = await findStarted(target, req.clientId);
	if (record && record.path !== req.path) {
		throw new WriteRefusedError(
			"This comment was posted on another file",
			"invalid",
		);
	}
	if (!record) {
		if (req.commit !== target.head) {
			throw new WriteRefusedError(
				"The PR moved on since: refresh to comment on its new head",
				"stale",
			);
		}
		const left =
			place.subject === "line" &&
			(place.side === "LEFT" || place.start?.side === "LEFT");
		if (left && !(await target.commentLeft())) {
			throw new WriteRefusedError(
				"GitHub's base for this commit differs from the one shown: no comments on old lines",
				"invalid",
			);
		}
		if (body.length > MAX_REPLY) {
			const room = MAX_REPLY - (body.length - req.body.length);
			throw new WriteRefusedError(
				`A comment is at most ${room} characters`,
				"invalid",
			);
		}
	}
	if (!record) {
		let posted: PostedComment;
		try {
			posted = await postThread(
				target.ref,
				req.commit,
				place,
				body,
				target.prUrl,
			);
		} catch (error) {
			if (
				error instanceof WriteRefusedError &&
				error.code === "pending-review" &&
				error.url
			) {
				target.setPendingReview({ url: error.url });
			}
			if (!(error instanceof WriteRefusedError)) {
				target.setInDoubt(req.clientId, true);
			}
			throw error;
		}
		record = { nodeId: posted.nodeId, path: req.path, posted };
		target.rememberStarted(req.clientId, record);
		target.setInDoubt(req.clientId, false);
		// It posted: no pending review stands in the way (any more).
		target.setPendingReview(null);
	}
	return answer(target, req.clientId, record);
}

/**
 * The viewer's thread opener on GitHub carrying `clientId` in its marker
 * (REST: no GraphQL lag), remembered once found; undefined if none. After
 * an attempt whose outcome is unknown (gh killed mid-call, GitHub may
 * still make it), listed again after each of LIST_WAITS_MS, as replies are.
 */
async function findStarted(
	target: NewThreadTarget,
	clientId: string,
): Promise<StartedRecord | undefined> {
	const waits = target.inDoubt(clientId) ? LIST_WAITS_MS : [];
	for (let i = 0; ; i++) {
		const mine = (await fetchReviewComments(target.ref)).find(
			(c) =>
				c.inReplyTo === null &&
				slugify(c.login) === slugify(target.viewer) &&
				parseMarker(c.body)?.id === clientId,
		);
		if (mine) {
			const record = {
				nodeId: mine.nodeId,
				path: mine.path,
				posted: mine.posted,
			};
			target.rememberStarted(clientId, record);
			target.setInDoubt(clientId, false);
			return record;
		}
		const wait = waits[i];
		if (wait === undefined) return undefined;
		await writeWaits.sleep(wait);
	}
}

/**
 * The new thread as GitHub's GraphQL lists it: found by its first
 * comment among the newest threads (after each of LIST_WAITS_MS while
 * GitHub lags; then among all of them), read like a write's re-read,
 * added to the kept reads and mapped as the overview read maps it.
 */
async function answer(
	target: NewThreadTarget,
	clientId: string,
	record: StartedRecord,
): Promise<NewThreadAnswer> {
	let threadId = record.threadId ?? null;
	for (let i = 0; !threadId; i++) {
		threadId = await findThreadOf(target.ref, record.nodeId);
		const wait = LIST_WAITS_MS[i];
		if (threadId || wait === undefined) break;
		await writeWaits.sleep(wait);
	}
	threadId ??= await findThreadOf(target.ref, record.nodeId, true);
	if (!threadId) {
		throw new GhError(
			"Posted, but GitHub doesn't list the new thread yet: try again",
		);
	}
	record.threadId = threadId;
	target.rememberStarted(clientId, record);
	const id = threadId;
	const read = await rereadUntil(target, id, (n) => lists(n, record.nodeId));
	if (!read.nodes || !lists(read.nodes, record.nodeId)) {
		throw gone("Posted, but the thread is gone from GitHub");
	}
	const nodes = withoutDeleted(target, read.nodes);
	target.add(id, nodes, read.seq, read.startedAt);
	const [thread] = mapThreads([withContent(nodes.summary, nodes.content)], {
		prAuthor: await target.prAuthor(),
		viewer: target.viewer,
		writes: true,
	});
	if (!thread) {
		throw new GhError("gh returned an unexpected response for the thread");
	}
	const hunk = openerOf(nodes.content).diffHunk;
	const code = thread.anchor
		? await target.code(thread.anchor, typeof hunk === "string" ? hunk : "")
		: null;
	return {
		thread: { ...thread, code },
		comments: {
			threadId: id,
			...mapComments(nodes.summary, nodes.content, undefined, true),
		},
	};
}
