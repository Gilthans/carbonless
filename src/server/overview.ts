import { unescapeTags } from "../shared/markdownEscape.js";
import type {
	CodeAnchor,
	DiffSide,
	PrOverview,
	ReviewThread,
	ThreadComment,
	ThreadParticipant,
} from "../shared/types.js";
import { atOrBefore } from "./asOf.js";
import { attentionSet } from "./attention.js";
import { hunkWindowRows } from "./codeWindow.js";
import { visibleAt } from "./commentTime.js";
import { GhError } from "./errors.js";
import {
	parseMarker,
	spanCols,
	stripMarker,
	stripMarkerHtml,
} from "./marker.js";
import { slugify } from "./slug.js";

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Json)
		: {};
}

function arr(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function login(value: unknown): string {
	return str(obj(value).login);
}

/**
 * GraphQL says `__typename: "Bot"`; the login spellings `xyz[bot]` and
 * `app/xyz` are a fallback only (REST-style and `gh pr view` author fields).
 */
export function isBotAuthor(author: Json): boolean {
	const name = str(author.login);
	return (
		author.__typename === "Bot" ||
		name.endsWith("[bot]") ||
		name.startsWith("app/")
	);
}

export const REVIEW_STATES = new Set([
	"APPROVED",
	"CHANGES_REQUESTED",
	"COMMENTED",
	"DISMISSED",
]);
const FAILING_CONCLUSIONS = new Set([
	"FAILURE",
	"TIMED_OUT",
	"CANCELLED",
	"ACTION_REQUIRED",
	"STARTUP_FAILURE",
]);

type Check = PrOverview["checks"][number];

export function mapCheck(raw: unknown): Check | null {
	const c = obj(raw);
	if (c.__typename === "StatusContext" || "context" in c) {
		const name = str(c.context);
		if (!name) return null;
		const state = str(c.state);
		const status =
			state === "FAILURE" || state === "ERROR"
				? "failing"
				: state === "PENDING" || state === "EXPECTED"
					? "pending"
					: "passing";
		const url = str(c.targetUrl);
		return url ? { name, status, url } : { name, status };
	}
	const name = str(c.name);
	if (!name) return null;
	const status = FAILING_CONCLUSIONS.has(str(c.conclusion))
		? "failing"
		: str(c.status) !== "COMPLETED"
			? "pending"
			: "passing";
	const url = str(c.detailsUrl);
	return url ? { name, status, url } : { name, status };
}

/**
 * A commit's check contexts as they stood at `cutoff`: started later, left
 * out; finished later, pending.
 */
export function checksAsOf(nodes: unknown[], cutoff: string): unknown[] {
	const out: unknown[] = [];
	for (const raw of nodes) {
		const c = obj(raw);
		if (c.__typename === "StatusContext" || "context" in c) {
			if (atOrBefore(c.createdAt, cutoff)) out.push(c);
			continue;
		}
		if (!atOrBefore(c.startedAt, cutoff)) continue;
		out.push(
			atOrBefore(c.completedAt, cutoff)
				? c
				: { ...c, status: "IN_PROGRESS", conclusion: null },
		);
	}
	return out;
}

export const CHECK_ORDER = { failing: 0, pending: 1, passing: 2 } as const;

const SIDES = new Set(["LEFT", "RIGHT"]);
type Side = DiffSide;

function lineNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: null;
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * GitHub's side of a thread's code at `anchor` (threadAnchor): the window
 * of GitHub's own diff hunk, the fallback (`source: "github"`) to the
 * clone's (threadCode.ts); until the comment's content is read (`loaded`
 * false), `source: "pending"`. The hunk is of the commit the comment was
 * made on and ends at `originalLine`, which is why the anchor is the
 * `original*` range. Null for a file comment (no anchor), or with neither
 * a hunk nor a commit. GitHub sometimes keeps no hunk for a line comment:
 * no rows then.
 */
function threadCode(
	first: Json,
	anchor: CodeAnchor | null,
	loaded: boolean,
): Thread["code"] {
	if (anchor === null) return null;
	const diffHunk = str(first.diffHunk);
	if (loaded && !diffHunk.trim() && !anchor.commit) return null;
	if (!loaded) return { anchor, rows: [], source: "pending" };
	return {
		anchor,
		rows: diffHunk.trim() ? hunkWindowRows(diffHunk, anchor) : [],
		source: "github",
		// GitHub's hunk is the commenter's own view.
		snapshot: { same: true },
	};
}

/** The commit a comment was made on (GitHub's originalCommit); "" if none or not an oid. */
function commitOf(comment: Json): string {
	const oid = str(obj(comment.originalCommit).oid);
	return OID.test(oid) ? oid : "";
}

/**
 * Where a thread points, from its summary: GitHub's fields mapped to the
 * source-neutral CodeAnchor. The range is the `original*` pair (on the
 * commit the opening comment was made on); the current `line`/`startLine`
 * pair only stands in when there is no original line, and the two pairs
 * are never mixed. Sides are GitHub's own, LEFT included. Null for a file
 * comment (subject FILE, or no line).
 */
function threadAnchor(
	t: Json,
	first: Json,
	path: string,
	at: string,
): CodeAnchor | null {
	if (t.subjectType === "FILE") return null;
	const original = lineNumber(t.originalLine);
	const line = original ?? lineNumber(t.line);
	if (line === null) return null;
	const commit = commitOf(first);
	const side: Side = SIDES.has(str(t.diffSide))
		? (str(t.diffSide) as Side)
		: "RIGHT";
	const startSide: Side = SIDES.has(str(t.startDiffSide))
		? (str(t.startDiffSide) as Side)
		: side;
	// GitHub's current startLine on LEFT is the NEW number when the range
	// starts on a context line (checked on gallery #2): never taken; with
	// no original line, such a range is its last line only.
	const start = lineNumber(
		original !== null
			? t.originalStartLine
			: startSide === "LEFT"
				? null
				: t.startLine,
	);
	return {
		path,
		commit,
		side,
		line,
		startSide: start === null ? side : startSide,
		startLine:
			start === null || (startSide === side && start > line) ? line : start,
		at,
	};
}

type Thread = ReviewThread;

/**
 * Whether a thread node carries its opening comment's content (the
 * summary query leaves it out; threadContents reads it).
 */
function hasContent(first: Json): boolean {
	return (
		typeof first.bodyHTML === "string" ||
		typeof first.body === "string" ||
		typeof first.bodyText === "string"
	);
}

/**
 * The opening comment of a content node (every comment, CONTENT_FIELDS in
 * gh.ts; an older `first`-only one too).
 */
export function openerOf(content: unknown): Json {
	const c = obj(content);
	return obj(arr(obj(c.comments).nodes)[0] ?? arr(obj(c.first).nodes)[0]);
}

/**
 * A summary node with its content node (by the same id) merged in: the
 * opening comment's text and hunk, as the single query used to return them.
 */
export function withContent(summary: unknown, content: unknown): unknown {
	const t = obj(summary);
	const first = obj(arr(obj(t.first).nodes)[0]);
	const more = openerOf(content);
	const { body, bodyText, bodyHTML, diffHunk } = more;
	const text = Object.fromEntries(
		Object.entries({ body, bodyText, bodyHTML, diffHunk }).filter(
			([, v]) => v !== undefined,
		),
	);
	return { ...t, first: { nodes: [{ ...first, ...text }] } };
}

/**
 * A thread's comments from its content node (every comment with its text),
 * oldest first: those its summary lists (so they agree with the thread's
 * count; a comment added since waits for the next read), published ones
 * dated by publication, and the viewer's pending ones marked. As of a
 * cutoff: only those published by then, none pending. `missing` counts
 * the published comments the summary lists (as of a cutoff, by then) that
 * the content didn't bring (deleted since): shown, never hidden.
 */
export function mapComments(
	summary: unknown,
	content: unknown,
	asOf?: string,
	writes = false,
): { comments: ThreadComment[]; missing?: number } {
	const listed = obj(obj(summary).comments);
	const known = arr(listed.nodes).map(obj);
	// The summary lists all (pages in past 100): only then is it the list.
	const complete =
		typeof listed.totalCount === "number" &&
		known.length >= listed.totalCount &&
		known.every((c) => str(c.id));
	const ids = new Set(known.map((c) => str(c.id)));
	const owed = (c: Json) => {
		const at = visibleAt(c);
		return at !== null && (!asOf || atOrBefore(at, asOf));
	};
	const comments: ThreadComment[] = [];
	const nodes = arr(obj(obj(content).comments).nodes);
	// Published comments after the opener (a delete of it blanks it then).
	const followed = nodes.slice(1).some((n) => visibleAt(obj(n)) !== null);
	for (const [index, raw] of nodes.entries()) {
		const c = obj(raw);
		const id = str(c.id);
		if (complete && !ids.has(id)) continue;
		const publishedAt = visibleAt(c);
		if (asOf && (publishedAt === null || !atOrBefore(publishedAt, asOf))) {
			continue;
		}
		const author = obj(c.author);
		const pending = publishedAt === null;
		// Only the thread's first comment: a reply saying so is just text.
		const deleted = index === 0 && isDeletedBody(str(c.body));
		// What GitHub lets the viewer do, where carbonless writes at all,
		// to their own published comments only (not others', even where
		// GitHub would). A blanked opener is a comment like any other (its
		// text may be written back), deleted again only once no published
		// comment follows it (it really goes then).
		const can = (v: unknown) =>
			!asOf && writes && !pending && c.viewerDidAuthor === true && v === true;
		comments.push({
			id,
			author: str(author.login),
			bot: isBotAuthor(author),
			avatarUrl: str(author.avatarUrl),
			publishedAt,
			pending,
			// carbonless's marker (marker.ts) stays on the server.
			html: stripMarkerHtml(str(c.bodyHTML)),
			// As typed: without the escapes carbonless posts (markdownEscape.ts).
			body: unescapeTags(stripMarker(str(c.body))),
			// GitHub's plain-text rendering; the raw body is a fallback.
			text: stripMarker(str(c.bodyText) || str(c.body)),
			editedAt: str(c.lastEditedAt) || null,
			viewerCan: {
				update: can(c.viewerCanUpdate),
				delete: (!deleted || !followed) && can(c.viewerCanDelete),
			},
			deleted,
		});
	}
	const shown = new Set(comments.map((c) => c.id));
	let missing: number;
	if (complete) {
		missing = known.filter((c) => owed(c) && !shown.has(str(c.id))).length;
	} else {
		// Not all listed (not paged in): the total less pending ones is due.
		const due =
			!asOf && typeof listed.totalCount === "number"
				? listed.totalCount - known.filter((c) => visibleAt(c) === null).length
				: known.filter(owed).length;
		missing = due - comments.filter((c) => !c.pending).length;
	}
	return missing > 0 ? { comments, missing } : { comments };
}

/** What carbonless's delete leaves of an opener that has replies. */
export const DELETED_BODY = "[deleted]";

/** Whether a body is an opener blanked by carbonless's delete. */
export const isDeletedBody = (body: string) =>
	stripMarker(body).trim() === DELETED_BODY;

/** An ISO time in ms; a missing or invalid one sorts first. */
function timeOf(at: string): number {
	const ms = Date.parse(at);
	return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** The later of two ISO times; a missing or invalid one loses. */
function later(a: string, b: string): string {
	const ta = Date.parse(a);
	const tb = Date.parse(b);
	if (Number.isNaN(tb)) return a;
	if (Number.isNaN(ta)) return b;
	return tb > ta ? b : a;
}

/**
 * Every thread with its first comment, grouped later by the opener (bot or
 * human), most recent activity first. Comments are dated by when they were
 * published (commentTime.ts); a pending one (the viewer's unsubmitted
 * review) doesn't count, and a thread it opened is left out. As of a
 * cutoff: threads opened by then, counting only comments published by
 * then, none resolved (GitHub keeps no resolution history). A node without
 * its opening comment's content (a summary) gives a thread that isn't
 * `loaded`.
 */
export function mapThreads(
	nodes: unknown[],
	ctx: {
		/** As-of mode's cutoff. */
		asOf?: string;
		/** The PR author's login: in every open thread's attention set. */
		prAuthor: string;
		/** The PR author is a bot (default: told by its login, isBotAuthor). */
		prAuthorBot?: boolean;
		/** The viewer's login or slug: `yourTurn` when in the set. */
		viewer: string;
		/**
		 * This session may write to the host (PrOverview.writes "on"):
		 * without it, `viewerCan` is all false.
		 */
		writes?: boolean;
	},
): Thread[] {
	const { asOf, prAuthor } = ctx;
	const prAuthorBot = ctx.prAuthorBot ?? isBotAuthor({ login: prAuthor });
	const viewer = slugify(ctx.viewer);
	const threads: Thread[] = [];
	for (const raw of nodes) {
		const t = obj(raw);
		const listed = obj(t.comments);
		const all = arr(listed.nodes).map(obj);
		// `first` is the aliased comments(first: 1) with the opening comment's text.
		const first = obj(arr(obj(t.first).nodes)[0] ?? all[0]);
		const author = obj(first.author);
		const bot = isBotAuthor(author);
		const createdAt = visibleAt(first);
		if (createdAt === null) continue;
		if (asOf && !atOrBefore(createdAt, asOf)) continue;
		const dated = all.flatMap((c) => {
			const at = visibleAt(c);
			return at === null ? [] : [{ c, at }];
		});
		// `latest` is the aliased comments(last: 1): past the first 100 listed.
		const latestNode = arr(obj(t.latest).nodes)[0];
		const latestAt = latestNode === undefined ? null : visibleAt(latestNode);
		const comments = asOf
			? dated.filter(({ at }) => atOrBefore(at, asOf))
			: dated;
		const lastActivityAt = [
			...comments.map((c) => c.at),
			...(latestAt === null || asOf ? [] : [latestAt]),
		].reduce(later, createdAt);
		// Pending comments among those listed, and the latest past them.
		const pending =
			all.length -
			dated.length +
			(latestNode !== undefined &&
			latestAt === null &&
			typeof listed.totalCount === "number" &&
			listed.totalCount > all.length
				? 1
				: 0);
		const firstLogin = str(author.login);
		const loaded = hasContent(first);
		// The code is the commenter's view when they wrote it.
		const lines = threadAnchor(
			t,
			first,
			str(t.path),
			str(first.createdAt) || createdAt,
		);
		// A span inside the lines: from carbonless's marker on the opener,
		// when it was made on these very lines.
		const cols =
			lines && loaded ? spanCols(parseMarker(str(first.body)), lines) : null;
		const anchor = lines && cols ? { ...lines, ...cols } : lines;
		const code = threadCode(first, anchor, loaded);
		// Older answers have no subjectType: no line there meant the file.
		const onFile =
			t.subjectType === "FILE" ||
			(t.subjectType === undefined && anchor === null);
		const resolved = !asOf && t.isResolved === true;
		// Who commented, in the order they were published (a reply drafted
		// early in a review submitted late spoke after those before the
		// submission); past the listed ones (when they weren't paged in),
		// the latest by creation still tells who spoke last, though a late
		// submission among the unlisted can't be told.
		const commenters = [
			...[...comments]
				.sort((a, b) => timeOf(a.at) - timeOf(b.at))
				.map(({ c }) => obj(c.author)),
			...(!asOf &&
			latestAt !== null &&
			typeof listed.totalCount === "number" &&
			listed.totalCount > all.length
				? [obj(obj(latestNode).author)]
				: []),
		].map((a) => ({ login: str(a.login), bot: isBotAuthor(a) }));
		// Each commenter once, in the order they first spoke.
		const participants: ThreadParticipant[] = [];
		for (const { c, at } of [
			...[...comments].sort((a, b) => timeOf(a.at) - timeOf(b.at)),
			...(!asOf && latestAt !== null
				? [{ c: obj(latestNode), at: latestAt }]
				: []),
		]) {
			const a = obj(c.author);
			const name = str(a.login);
			if (!name || participants.some((p) => p.login === name)) continue;
			participants.push({ login: name, avatarUrl: str(a.avatarUrl), at });
		}
		const attention = attentionSet({
			comments: commenters,
			prAuthor,
			prAuthorBot,
			resolved,
		});
		// bodyText is GitHub's plain-text rendering; the raw body is a fallback.
		const text = stripMarker(str(first.bodyText) || str(first.body));
		threads.push({
			id: str(t.id),
			path: str(t.path),
			// The commented line on the comment's own commit when there is
			// code (a carried-forward comment's current line may differ),
			// else where it is now or was; as of a cutoff, where it was
			// (today's line is past the cutoff).
			// A file comment has none (GitHub reports it on line 1).
			line: onFile
				? null
				: (code?.anchor.line ??
					(asOf
						? (lineNumber(t.originalLine) ?? lineNumber(t.line))
						: (lineNumber(t.line) ?? lineNumber(t.originalLine)))),
			currentLine: asOf || onFile ? null : lineNumber(t.line),
			...((head) => (!asOf && OID.test(head) ? { currentHead: head } : {}))(
				str(obj(t.headOf).headRefOid),
			),
			loaded,
			excerpt: text.replace(/\s+/g, " ").trim().slice(0, 200),
			html: stripMarkerHtml(str(first.bodyHTML)),
			// The raw markdown: suggested changes come from it exactly.
			body: unescapeTags(stripMarker(str(first.body))),
			createdAt,
			lastActivityAt,
			author: firstLogin,
			bot,
			avatarUrl: str(author.avatarUrl),
			participants,
			// The total, less pending comments (the viewer's), which don't
			// count; past the listed ones (gh.ts pages them in when there are
			// more than 100), only the latest can be told. As of a cutoff,
			// those listed and published by then.
			commentCount:
				!asOf && typeof listed.totalCount === "number"
					? Math.max(1, listed.totalCount - pending)
					: Math.max(1, comments.length),
			// Someone other than the thread's opener answered.
			hasReply: comments.some(
				({ c }) => str(obj(c.author).login) !== firstLogin,
			),
			// GitHub's flag is about today's head, not the cutoff's.
			outdated: !asOf && t.isOutdated === true,
			resolved,
			code,
			anchor,
			commit: commitOf(first),
			subject: onFile ? "file" : "line",
			attention,
			yourTurn: attention.some((login) => slugify(login) === viewer),
			viewerCan: {
				reply: !asOf && ctx.writes === true && t.viewerCanReply === true,
				resolve: !asOf && ctx.writes === true && t.viewerCanResolve === true,
				unresolve:
					!asOf && ctx.writes === true && t.viewerCanUnresolve === true,
			},
		});
	}
	return sortThreads(threads);
}

/** Most recent activity first; stable for ties. */
export function sortThreads<T extends { lastActivityAt: string }>(
	threads: T[],
): T[] {
	const time = (t: T) => {
		const ms = Date.parse(t.lastActivityAt);
		return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
	};
	return [...threads].sort((a, b) => time(b) - time(a));
}

/** The GraphQL connections `fetchOverview` collects, already flattened to node lists. */
export interface PrGraph {
	/** The description as GitHub renders it; "" falls back to the plain body. */
	bodyHTML: string;
	comments: unknown[];
	reviews: unknown[];
	/**
	 * As-of mode only: the snapshot head's check contexts (its
	 * statusCheckRollup), in place of the PR's current ones.
	 */
	checks?: unknown[];
}

/**
 * Pure mapping from `gh pr view --json` output plus the paginated GraphQL
 * nodes to a PrOverview (its review threads are mapThreads'). Inputs are
 * untrusted: unknown or missing fields fall back to empty values, but a
 * missing connection throws so a broken response never reads as "no
 * reviews".
 */
export function mapOverview(
	view: unknown,
	graph: unknown,
	viewer: string,
	/**
	 * As-of mode's cutoff: only reviews and comments made by then count,
	 * mergeability is unknown and the checks are `graph.checks`, the
	 * snapshot head's.
	 */
	asOf?: string,
): Omit<
	PrOverview,
	"readId" | "fetchedAt" | "servedAt" | "writes" | "commentLeft"
> {
	if (typeof view !== "object" || view === null || Array.isArray(view)) {
		throw new GhError("gh returned an unexpected response for the PR");
	}
	const g = obj(graph);
	if (!Array.isArray(g.comments) || !Array.isArray(g.reviews)) {
		throw new GhError("gh returned an unexpected response for the PR reviews");
	}
	if (asOf && !Array.isArray(g.checks)) {
		throw new GhError("gh returned an unexpected response for the checks");
	}
	const inTime = (at: unknown) => !asOf || atOrBefore(at, asOf);
	const v = obj(view);
	const author = login(v.author);
	// The viewer is a login or its slug; compare slugs so both spellings match.
	const viewerSlug = slugify(viewer);
	const isYou = (name: string) => slugify(name) === viewerSlug;
	const isAuthor = (name: string) =>
		name.toLowerCase() === author.toLowerCase();

	// As of a cutoff, the PR was open then (the snapshot exists).
	const state =
		!asOf && ["OPEN", "CLOSED", "MERGED"].includes(str(v.state))
			? (str(v.state) as PrOverview["state"])
			: "OPEN";
	const mergeable =
		!asOf && ["MERGEABLE", "CONFLICTING"].includes(str(v.mergeable))
			? (str(v.mergeable) as PrOverview["mergeable"])
			: "UNKNOWN";

	const requestedReviewers: PrOverview["requestedReviewers"] = [];
	for (const raw of arr(v.reviewRequests)) {
		const r = obj(raw);
		if (r.__typename === "Team") {
			const name = str(r.name) || str(r.slug);
			if (name) requestedReviewers.push({ name, team: true });
		} else if (str(r.login)) {
			requestedReviewers.push({ name: str(r.login), team: false });
		}
	}

	type Review = PrOverview["reviews"][number];
	const byReviewer = new Map<string, Review>();
	const opinions = new Map<
		string,
		{ at: string; state: NonNullable<Review["opinion"]> }
	>();
	for (const raw of g.reviews) {
		const r = obj(raw);
		const who = obj(r.author);
		const name = str(who.login);
		const reviewState = str(r.state);
		if (!name || !REVIEW_STATES.has(reviewState)) continue;
		if (!inTime(r.submittedAt)) continue;
		const at = str(r.submittedAt);
		const key = name.toLowerCase();
		const prev = byReviewer.get(key);
		if (!prev || prev.submittedAt <= at) {
			byReviewer.set(key, {
				author: name,
				state: reviewState as Review["state"],
				submittedAt: at,
				you: isYou(name),
				bot: isBotAuthor(who),
			});
		}
		if (reviewState !== "COMMENTED") {
			const prevOp = opinions.get(key);
			if (!prevOp || prevOp.at <= at) {
				opinions.set(key, {
					at,
					state: reviewState as NonNullable<Review["opinion"]>,
				});
			}
		}
	}
	// GitHub lists a pending review to its author only: the viewer's own,
	// unless --viewer names someone else. Today's state, never as of a cutoff.
	const pending =
		!asOf &&
		g.reviews.some((raw) => {
			const r = obj(raw);
			return str(r.state) === "PENDING" && isYou(login(r.author));
		});
	const reviewers = [...byReviewer.entries()].sort((a, b) =>
		b[1].submittedAt.localeCompare(a[1].submittedAt),
	);
	const reviews: Review[] = reviewers.map(([key, review]) => {
		const op = opinions.get(key);
		// Dismissed, then a comment of theirs: Comment withdrew it (as
		// verdict.ts standingOf), so the comment alone stands.
		const withdrawn =
			op?.state === "DISMISSED" &&
			review.state === "COMMENTED" &&
			review.submittedAt >= op.at;
		return op && !withdrawn ? { ...review, opinion: op.state } : review;
	});

	const last = new Map<
		string,
		{ author: string; lastAt: string; bot: boolean }
	>();
	for (const raw of g.comments) {
		const c = obj(raw);
		const who = obj(c.author);
		const name = str(who.login);
		if (!name || !inTime(c.createdAt)) continue;
		const at = str(c.createdAt);
		const key = name.toLowerCase();
		const prev = last.get(key);
		if (!prev || prev.lastAt < at) {
			last.set(key, { author: name, lastAt: at, bot: isBotAuthor(who) });
		}
	}
	const commenters = [...last.values()]
		.map((c) => ({ ...c, you: isYou(c.author) }))
		.sort((a, b) => b.lastAt.localeCompare(a.lastAt));

	const isOtherHuman = (name: string, bot: boolean) =>
		!bot && !isAuthor(name) && !isYou(name);
	const humanStarted =
		reviewers.some(([, r]) => isOtherHuman(r.author, r.bot)) ||
		commenters.some((c) => isOtherHuman(c.author, c.bot));

	const checks = (
		asOf ? checksAsOf(arr(g.checks), asOf) : arr(v.statusCheckRollup)
	)
		.map(mapCheck)
		.filter((c): c is Check => c !== null)
		.sort((a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status]);

	// As of a cutoff, "updated" is the last activity seen by then (the page
	// adds the review threads' once they are in).
	const updatedAt = asOf
		? [
				...reviews.map((r) => r.submittedAt),
				...commenters.map((c) => c.lastAt),
			].reduce(
				(latest, at) => (Date.parse(at) > Date.parse(latest) ? at : latest),
				str(v.createdAt),
			)
		: str(v.updatedAt);

	return {
		title: str(v.title),
		number: typeof v.number === "number" ? v.number : 0,
		url: str(v.url),
		author,
		body: str(v.body),
		bodyHtml: str(g.bodyHTML),
		isDraft: v.isDraft === true,
		state,
		createdAt: str(v.createdAt),
		updatedAt,
		baseBranch: str(v.baseRefName),
		headBranch: str(v.headRefName),
		mergeable,
		requestedReviewers,
		reviews,
		commenters,
		humanStarted,
		youAuthor: isYou(author),
		checks,
		...(asOf ? { asOf } : {}),
		pendingReview:
			pending && str(v.url)
				? { url: `${str(v.url).replace(/\/+$/, "")}/files` }
				: null,
	};
}
