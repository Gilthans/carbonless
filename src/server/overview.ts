import type {
	CodeAnchor,
	DiffSide,
	PrOverview,
	ReviewThread,
} from "../shared/types.js";
import { atOrBefore } from "./asOf.js";
import { hunkWindowRows } from "./codeWindow.js";
import { GhError } from "./errors.js";
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
function isBotAuthor(author: Json): boolean {
	const name = str(author.login);
	return (
		author.__typename === "Bot" ||
		name.endsWith("[bot]") ||
		name.startsWith("app/")
	);
}

const REVIEW_STATES = new Set([
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

function mapCheck(raw: unknown): Check | null {
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
function checksAsOf(nodes: unknown[], cutoff: string): unknown[] {
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

const CHECK_ORDER = { failing: 0, pending: 1, passing: 2 } as const;

const SIDES = new Set(["LEFT", "RIGHT"]);
type Side = DiffSide;

function lineNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: null;
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * GitHub's side of a thread's code: the anchor (GitHub's fields mapped to
 * the source-neutral CodeAnchor) and the window of GitHub's own diff hunk,
 * the fallback (`source: "github"`) to the clone's (threadCode.ts); until
 * the comment's content is read (`loaded` false), `source: "pending"`. The
 * hunk is of the commit the comment was made on and ends at
 * `originalLine`, so the range is the `original*` pair; the current
 * `line`/`startLine` pair only stands in when there is no original line.
 * The two pairs are never mixed. Null for a file comment (subject FILE, or
 * no line), or with neither a hunk nor a commit. GitHub sometimes keeps no
 * hunk for a line comment: no rows then.
 */
function threadCode(
	t: Json,
	first: Json,
	path: string,
	at: string,
	loaded: boolean,
): Thread["code"] {
	if (t.subjectType === "FILE") return null;
	const diffHunk = str(first.diffHunk);
	const original = lineNumber(t.originalLine);
	const line = original ?? lineNumber(t.line);
	const oid = str(obj(first.originalCommit).oid);
	const commit = OID.test(oid) ? oid : "";
	if (line === null || (loaded && !diffHunk.trim() && !commit)) return null;
	const side: Side = SIDES.has(str(t.diffSide))
		? (str(t.diffSide) as Side)
		: "RIGHT";
	const start = lineNumber(
		original === null ? t.startLine : t.originalStartLine,
	);
	const startSide: Side = SIDES.has(str(t.startDiffSide))
		? (str(t.startDiffSide) as Side)
		: side;
	const anchor: CodeAnchor = {
		path,
		commit,
		side,
		line,
		startSide: start === null ? side : startSide,
		startLine:
			start === null || (startSide === side && start > line) ? line : start,
		at,
	};
	if (!loaded) return { anchor, rows: [], source: "pending" };
	return {
		anchor,
		rows: diffHunk.trim() ? hunkWindowRows(diffHunk, anchor) : [],
		source: "github",
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
 * A summary node with its content node (by the same id) merged in, as the
 * single query used to return them.
 */
export function withContent(summary: unknown, content: unknown): unknown {
	const t = obj(summary);
	const first = obj(arr(obj(t.first).nodes)[0]);
	const more = obj(arr(obj(obj(content).first).nodes)[0]);
	return { ...t, first: { nodes: [{ ...first, ...more }] } };
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
 * human), most recent activity first. As of a cutoff: threads opened by
 * then, counting only comments made by then, none resolved (GitHub keeps no
 * resolution history). A node without its opening comment's content (a
 * summary) gives a thread that isn't `loaded`.
 */
export function mapThreads(
	nodes: unknown[],
	asOf: string | undefined,
): Thread[] {
	const threads: Thread[] = [];
	for (const raw of nodes) {
		const t = obj(raw);
		const listed = obj(t.comments);
		const all = arr(listed.nodes).map(obj);
		// `first` is the aliased comments(first: 1) with the opening comment's text.
		const first = obj(arr(obj(t.first).nodes)[0] ?? all[0]);
		const author = obj(first.author);
		const bot = isBotAuthor(author);
		if (asOf && !atOrBefore(first.createdAt, asOf)) continue;
		const comments = asOf
			? all.filter((c) => atOrBefore(c.createdAt, asOf))
			: all;
		// `latest` is the aliased comments(last: 1): past the first 100 listed.
		const latest = asOf ? [] : arr(obj(t.latest).nodes).map(obj);
		const createdAt = str(first.createdAt);
		const lastActivityAt = [...comments, ...latest].reduce(
			(at, c) => later(at, str(c.createdAt)),
			createdAt,
		);
		const firstLogin = str(author.login);
		const loaded = hasContent(first);
		const code = threadCode(t, first, str(t.path), createdAt, loaded);
		// bodyText is GitHub's plain-text rendering; the raw body is a fallback.
		const text = str(first.bodyText) || str(first.body);
		threads.push({
			id: str(t.id),
			path: str(t.path),
			// The commented line on the comment's own commit when there is
			// code (a carried-forward comment's current line may differ),
			// else where it is now or was; as of a cutoff, where it was
			// (today's line is past the cutoff).
			line:
				code?.anchor.line ??
				(asOf
					? (lineNumber(t.originalLine) ?? lineNumber(t.line))
					: (lineNumber(t.line) ?? lineNumber(t.originalLine))),
			currentLine: asOf ? null : lineNumber(t.line),
			loaded,
			excerpt: text.replace(/\s+/g, " ").trim().slice(0, 200),
			html: str(first.bodyHTML),
			// The raw markdown: suggested changes come from it exactly.
			body: str(first.body),
			createdAt,
			lastActivityAt,
			author: firstLogin,
			bot,
			// The author list stops at 100; the total doesn't (as of a cutoff,
			// only the first 100 can be dated).
			commentCount:
				!asOf && typeof listed.totalCount === "number"
					? listed.totalCount
					: Math.max(1, comments.length),
			// Someone other than the thread's opener answered.
			hasReply: comments.some((c) => str(obj(c.author).login) !== firstLogin),
			// GitHub's flag is about today's head, not the cutoff's.
			outdated: !asOf && t.isOutdated === true,
			resolved: !asOf && t.isResolved === true,
			code,
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
): Omit<PrOverview, "readId" | "fetchedAt" | "servedAt"> {
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
	const reviewers = [...byReviewer.entries()].sort((a, b) =>
		b[1].submittedAt.localeCompare(a[1].submittedAt),
	);
	const reviews: Review[] = reviewers.map(([key, review]) => {
		const opinion = opinions.get(key)?.state;
		return opinion ? { ...review, opinion } : review;
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
		checks,
		...(asOf ? { asOf } : {}),
	};
}
