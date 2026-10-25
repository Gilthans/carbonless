import type { PrOverview } from "../shared/types.js";
import { atOrBefore } from "./asOf.js";
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

/**
 * Unresolved threads in full, and resolved ones only counted, by the opening
 * comment's author: bot or human.
 */
function mapThreads(
	nodes: unknown[],
	asOf: string | undefined,
): {
	threads: PrOverview["threads"];
	resolved: PrOverview["resolved"];
} {
	const threads: PrOverview["threads"] = [];
	const resolved = { human: 0, bot: 0 };
	for (const raw of nodes) {
		const t = obj(raw);
		const listed = obj(t.comments);
		const all = arr(listed.nodes).map(obj);
		// `first` is the aliased comments(first: 1) with the opening comment's text.
		const first = obj(arr(obj(t.first).nodes)[0] ?? all[0]);
		const author = obj(first.author);
		const bot = isBotAuthor(author);
		// As of a cutoff: threads opened by then, counting only comments made
		// by then. When a thread was resolved isn't known: none is.
		if (asOf && !atOrBefore(first.createdAt, asOf)) continue;
		const comments = asOf
			? all.filter((c) => atOrBefore(c.createdAt, asOf))
			: all;
		if (!asOf && t.isResolved === true) {
			resolved[bot ? "bot" : "human"]++;
			continue;
		}
		const firstLogin = str(author.login);
		// bodyText is GitHub's plain-text rendering; the raw body is a fallback.
		const text = str(first.bodyText) || str(first.body);
		threads.push({
			path: str(t.path),
			line: typeof t.line === "number" ? t.line : null,
			excerpt: text.replace(/\s+/g, " ").trim().slice(0, 200),
			html: str(first.bodyHTML),
			createdAt: str(first.createdAt),
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
		});
	}
	return { threads, resolved: asOf ? null : resolved };
}

/** The GraphQL connections `fetchOverview` collects, already flattened to node lists. */
export interface PrGraph {
	/** The description as GitHub renders it; "" falls back to the plain body. */
	bodyHTML: string;
	reviewThreads: unknown[];
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
 * nodes to a PrOverview. Inputs are untrusted: unknown or missing fields fall
 * back to empty values, but a missing connection throws so a broken response
 * never reads as "no threads".
 */
export function mapOverview(
	view: unknown,
	graph: unknown,
	viewer: string,
	/**
	 * As-of mode's cutoff: only reviews, comments and threads made by then
	 * count, threads all show unresolved, mergeability is unknown and the
	 * checks are `graph.checks`, the snapshot head's.
	 */
	asOf?: string,
): PrOverview {
	if (typeof view !== "object" || view === null || Array.isArray(view)) {
		throw new GhError("gh returned an unexpected response for the PR");
	}
	const g = obj(graph);
	if (
		!Array.isArray(g.reviewThreads) ||
		!Array.isArray(g.comments) ||
		!Array.isArray(g.reviews)
	) {
		throw new GhError("gh returned an unexpected response for the PR threads");
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

	const threads = mapThreads(g.reviewThreads, asOf);
	// As of a cutoff, "updated" is the last activity seen by then.
	const updatedAt = asOf
		? [
				...reviews.map((r) => r.submittedAt),
				...commenters.map((c) => c.lastAt),
				...threads.threads.map((t) => t.createdAt),
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
		...threads,
		...(asOf ? { asOf } : {}),
	};
}
