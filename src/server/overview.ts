import type { PrOverview } from "../shared/types.js";
import { GhError } from "./errors.js";

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

/** `xyz[bot]` or `app/xyz`, as `gh pr view` spells GitHub App accounts. */
function isBotLogin(name: string): boolean {
	return name.endsWith("[bot]") || name.startsWith("app/");
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

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

const CHECK_ORDER = { failing: 0, pending: 1, passing: 2 } as const;

function mapThreads(threads: unknown): PrOverview["threads"] {
	const nodes = arr(
		obj(obj(obj(obj(obj(threads).data).repository).pullRequest).reviewThreads)
			.nodes,
	);
	const result: PrOverview["threads"] = [];
	for (const raw of nodes) {
		const t = obj(raw);
		if (t.isResolved === true) continue;
		const comments = obj(t.comments);
		const first = obj(arr(comments.nodes)[0]);
		const author = obj(first.author);
		const total =
			typeof comments.totalCount === "number" ? comments.totalCount : 0;
		result.push({
			path: str(t.path),
			line: typeof t.line === "number" ? t.line : null,
			excerpt: str(first.body).slice(0, 200),
			author: str(author.login),
			bot: author.__typename === "Bot",
			hasReply: total > 1,
			outdated: t.isOutdated === true,
		});
	}
	return result;
}

/**
 * Pure mapping from `gh pr view --json` output and the review-threads GraphQL
 * response to a PrOverview. Both inputs are untrusted: unknown or missing
 * fields fall back to empty values instead of throwing.
 */
export function mapOverview(
	view: unknown,
	threads: unknown,
	viewer: string,
): PrOverview {
	if (typeof view !== "object" || view === null || Array.isArray(view)) {
		throw new GhError("gh returned an unexpected response for the PR");
	}
	const v = obj(view);
	const author = login(v.author);
	const isYou = (name: string) => same(name, viewer);

	const state = ["OPEN", "CLOSED", "MERGED"].includes(str(v.state))
		? (str(v.state) as PrOverview["state"])
		: "OPEN";
	const mergeable = ["MERGEABLE", "CONFLICTING"].includes(str(v.mergeable))
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

	const latest = new Map<string, PrOverview["reviews"][number]>();
	for (const raw of arr(v.reviews)) {
		const r = obj(raw);
		const name = login(r.author);
		const reviewState = str(r.state);
		if (!name || !REVIEW_STATES.has(reviewState)) continue;
		const submittedAt = str(r.submittedAt);
		const key = name.toLowerCase();
		const prev = latest.get(key);
		if (prev && prev.submittedAt > submittedAt) continue;
		latest.set(key, {
			author: name,
			state: reviewState as PrOverview["reviews"][number]["state"],
			submittedAt,
			you: isYou(name),
		});
	}
	const reviews = [...latest.values()].sort((a, b) =>
		b.submittedAt.localeCompare(a.submittedAt),
	);

	const last = new Map<string, { author: string; lastAt: string }>();
	for (const raw of arr(v.comments)) {
		const c = obj(raw);
		const name = login(c.author);
		if (!name) continue;
		const at = str(c.createdAt);
		const key = name.toLowerCase();
		const prev = last.get(key);
		if (!prev || prev.lastAt < at) last.set(key, { author: name, lastAt: at });
	}
	const commenters = [...last.values()]
		.map((c) => ({
			...c,
			bot: isBotLogin(c.author),
			you: isYou(c.author),
		}))
		.sort((a, b) => b.lastAt.localeCompare(a.lastAt));

	const isOtherHuman = (name: string) =>
		!isBotLogin(name) && !same(name, author) && !isYou(name);
	const humanStarted =
		reviews.some((r) => isOtherHuman(r.author)) ||
		commenters.some((c) => isOtherHuman(c.author));

	const checks = arr(v.statusCheckRollup)
		.map(mapCheck)
		.filter((c): c is Check => c !== null)
		.sort((a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status]);

	return {
		title: str(v.title),
		number: typeof v.number === "number" ? v.number : 0,
		url: str(v.url),
		author,
		body: str(v.body),
		isDraft: v.isDraft === true,
		state,
		createdAt: str(v.createdAt),
		updatedAt: str(v.updatedAt),
		baseBranch: str(v.baseRefName),
		headBranch: str(v.headRefName),
		mergeable,
		requestedReviewers,
		reviews,
		commenters,
		humanStarted,
		checks,
		threads: mapThreads(threads),
	};
}
