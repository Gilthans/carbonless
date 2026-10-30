import type { Person } from "../../shared/home.js";
import { GhError } from "../errors.js";
import { runGh } from "../gh.js";
import type { PrFacts } from "./facts.js";

/**
 * GitHub's facts about PRs for Home. A refresh of a repo lists its open PRs
 * and those closed recently cheaply (number and updatedAt, 100 a page), then
 * reads the full facts only of PRs it doesn't know at that updatedAt, 20 by
 * alias per query: a full page of 100 PRs with every field took over
 * GitHub's 10 s limit (HTTP 502) on a busy repo, and a quiet repo then costs
 * one point per refresh. Costs measured in the brief B report.
 */

const PERSON = "login avatarUrl(size: 40)";

/** The fields of one PR node (PR_NODE in test/fake-gh/scenario.ts serves them). */
export const PR_FIELDS = `number title url isDraft state updatedAt closedAt mergedAt headRefOid
author { ${PERSON} }
reviewDecision
reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { ${PERSON} } ... on Mannequin { ${PERSON} } ... on Team { slug organization { login } avatarUrl(size: 40) } } } }
latestReviews(first: 30) { nodes { author { ${PERSON} } state submittedAt } }
reviewThreads(first: 100) { totalCount nodes { isResolved } }
commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
timelineItems(last: 30, itemTypes: [PULL_REQUEST_COMMIT, ISSUE_COMMENT, PULL_REQUEST_REVIEW]) { nodes { __typename ... on PullRequestCommit { commit { committedDate author { user { ${PERSON} } } } } ... on IssueComment { createdAt author { ${PERSON} } } ... on PullRequestReview { submittedAt state author { ${PERSON} } } } }`;

/** One query's worth of a repo's PR list: number and updatedAt only. */
export const LIST_QUERY = `query($owner: String!, $name: String!, $openCursor: String, $closedCursor: String, $withOpen: Boolean!, $withClosed: Boolean!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    open: pullRequests(states: OPEN, first: 100, after: $openCursor, orderBy: { field: UPDATED_AT, direction: DESC }) @include(if: $withOpen) {
      pageInfo { hasNextPage endCursor }
      nodes { number updatedAt }
    }
    closed: pullRequests(states: [MERGED, CLOSED], first: 50, after: $closedCursor, orderBy: { field: UPDATED_AT, direction: DESC }) @include(if: $withClosed) {
      pageInfo { hasNextPage endCursor }
      nodes { number updatedAt closedAt mergedAt }
    }
  }
}`;

/** PRs whose full facts one query reads (20 took about 4 s on GitHub). */
export const DETAILS_BATCH = 20;
/** Detail queries in flight at once. */
const DETAILS_PARALLEL = 3;
/** List pages per repo at most (10,000 open PRs). */
const MAX_PAGES = 100;
/**
 * Known facts older than this are read again even if updatedAt didn't move:
 * checks finishing or re-running don't touch a PR's updatedAt.
 */
export const DETAILS_MAX_AGE_MS = 2 * 3_600_000;
/** Clock skew allowed between GitHub's updatedAt and ours when listing since a moment. */
export const LIST_MARGIN_MS = 5 * 60_000;
/** What a refresh of one repo cost, from GraphQL's `rateLimit`. */
export interface RefreshCost {
	calls: number;
	points: number;
	remaining: number | null;
	resetAt: string | null;
}

type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
const list = (v: unknown): unknown[] => {
	const nodes = rec(v).nodes;
	return Array.isArray(nodes) ? nodes : [];
};
const str = (v: unknown): string | null =>
	typeof v === "string" && v.length > 0 ? v : null;

function person(v: unknown): Person | null {
	const login = str(rec(v).login);
	if (!login) return null;
	return { login, avatarUrl: str(rec(v).avatarUrl) ?? "" };
}

const CHECKS: Record<string, PrFacts["checks"]> = {
	SUCCESS: "passing",
	FAILURE: "failing",
	ERROR: "failing",
	PENDING: "running",
	EXPECTED: "running",
};

const later = (a: string | undefined, b: string) =>
	a === undefined || Date.parse(b) > Date.parse(a) ? b : a;

/**
 * One PR node as facts; null when it lacks what a row needs. Untrusted:
 * every field is checked, odd ones read as absent.
 */
export function mapPrNode(
	owner: string,
	repo: string,
	raw: unknown,
): PrFacts | null {
	const n = rec(raw);
	const number = n.number;
	const updatedAt = str(n.updatedAt);
	if (!Number.isSafeInteger(number) || (number as number) < 1 || !updatedAt) {
		return null;
	}
	// A deleted account has no author: GitHub's "ghost".
	const author = person(n.author) ?? { login: "ghost", avatarUrl: "" };
	const people: Record<string, Person> = {};
	const meet = (p: Person | null) => {
		if (p && !people[p.login.toLowerCase()]) people[p.login.toLowerCase()] = p;
		return p;
	};
	meet(author);
	const isAuthor = (login: string) =>
		login.toLowerCase() === author.login.toLowerCase();

	const users: string[] = [];
	const teams: string[] = [];
	for (const r of list(n.reviewRequests)) {
		const who = rec(rec(r).requestedReviewer);
		if (who.__typename === "Team") {
			const org = str(rec(who.organization).login);
			const slug = str(who.slug);
			if (!org || !slug) continue;
			const name = `${org}/${slug}`;
			teams.push(name);
			people[name.toLowerCase()] ??= {
				login: name,
				avatarUrl: str(who.avatarUrl) ?? "",
			};
		} else {
			const p = meet(person(who));
			if (p) users.push(p.login);
		}
	}

	const lastActivity: Record<string, string> = {};
	const acted = (p: Person | null, at: unknown) => {
		const when = str(at);
		if (!p || !when || !Number.isFinite(Date.parse(when))) return;
		const key = p.login.toLowerCase();
		lastActivity[key] = later(lastActivity[key], when);
	};
	const reviewers: string[] = [];
	/** Each reviewer's latest opinion, for a decision GitHub doesn't give. */
	const opinions = new Set<string>();
	const addReviewer = (p: Person | null, state: unknown) => {
		// A pending review is visible to its author only, never activity.
		if (!p || state === "PENDING" || isAuthor(p.login)) return;
		if (!reviewers.some((r) => r.toLowerCase() === p.login.toLowerCase())) {
			reviewers.push(p.login);
		}
	};
	for (const r of list(n.latestReviews)) {
		const p = meet(person(rec(r).author));
		if (p && !isAuthor(p.login)) opinions.add(String(rec(r).state));
		addReviewer(p, rec(r).state);
		if (rec(r).state !== "PENDING") acted(p, rec(r).submittedAt);
	}
	for (const item of list(n.timelineItems)) {
		const t = rec(item);
		if (t.__typename === "PullRequestCommit") {
			const c = rec(t.commit);
			// A commit by no known user is the PR author's push.
			acted(meet(person(rec(rec(c.author).user))) ?? author, c.committedDate);
		} else if (t.__typename === "IssueComment") {
			acted(meet(person(t.author)), t.createdAt);
		} else if (t.__typename === "PullRequestReview" && t.state !== "PENDING") {
			const p = meet(person(t.author));
			addReviewer(p, t.state);
			acted(p, t.submittedAt);
		}
	}
	const lastCommit = rec(rec(list(n.commits)[0]).commit);
	// Credited to the author whoever pushed, at its commit date (which can
	// predate the push): a wait on a co-author who pushes doesn't clear.
	acted(author, lastCommit.committedDate);

	const threads = list(n.reviewThreads);
	const totalThreads = rec(n.reviewThreads).totalCount;
	// Past the first 100 threads GitHub isn't asked; those count as unresolved,
	// so the count can only be too high. Resolving a thread likely doesn't
	// move updatedAt: the count can be up to DETAILS_MAX_AGE_MS old.
	const unread =
		Number.isSafeInteger(totalThreads) &&
		(totalThreads as number) > threads.length
			? (totalThreads as number) - threads.length
			: 0;
	const unresolvedThreads =
		threads.filter((t) => rec(t).isResolved !== true).length + unread;

	const state = n.state === "MERGED" || n.state === "CLOSED" ? n.state : "OPEN";
	return {
		owner,
		repo,
		number: number as number,
		title: typeof n.title === "string" ? n.title : "",
		url: str(n.url) ?? `https://github.com/${owner}/${repo}/pull/${number}`,
		author,
		draft: n.isDraft === true,
		state,
		closedAt: state === "OPEN" ? null : (str(n.mergedAt) ?? str(n.closedAt)),
		headOid: str(n.headRefOid) ?? "",
		updatedAt,
		checks: CHECKS[String(rec(lastCommit.statusCheckRollup).state)] ?? null,
		decision: decisionOf(n.reviewDecision, opinions),
		unresolvedThreads,
		requested: { users, teams },
		reviewers,
		lastActivity,
		people,
	};
}

/**
 * GitHub's review decision; when it gives none (the base branch doesn't
 * require reviews), the reviewers' latest opinions: any changes requested,
 * else any approval.
 */
function decisionOf(
	given: unknown,
	opinions: ReadonlySet<string>,
): PrFacts["decision"] {
	if (given === "APPROVED") return "approved";
	if (given === "CHANGES_REQUESTED") return "changes-requested";
	if (given === "REVIEW_REQUIRED") return null;
	if (opinions.has("CHANGES_REQUESTED")) return "changes-requested";
	if (opinions.has("APPROVED")) return "approved";
	return null;
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** Takes GraphQL's partial data (nodes it couldn't resolve come back null). */
const hasData = (stdout: string) => {
	try {
		return rec(JSON.parse(stdout)).data !== undefined;
	} catch {
		return false;
	}
};

async function graphql(
	args: string[],
	what: string,
	cost: RefreshCost,
	signal?: AbortSignal,
	partial?: (stdout: string) => boolean,
): Promise<Obj> {
	const out = await runGh(["api", "graphql", ...args], {
		signal,
		what,
		partial,
	});
	let json: unknown;
	try {
		json = JSON.parse(out);
	} catch {
		throw new GhError("gh returned output that is not JSON");
	}
	const data = rec(rec(json).data);
	const rate = rec(data.rateLimit);
	cost.calls++;
	if (typeof rate.cost === "number") cost.points += rate.cost;
	if (typeof rate.remaining === "number") cost.remaining = rate.remaining;
	cost.resetAt = str(rate.resetAt) ?? cost.resetAt;
	return data;
}

export const newCost = (): RefreshCost => ({
	calls: 0,
	points: 0,
	remaining: null,
	resetAt: null,
});

/** A listed PR: enough to tell whether known facts are current. */
export interface Listed {
	number: number;
	updatedAt: string;
}

/**
 * Every open PR of `owner/repo` and every one merged or closed at or after
 * `closedSince` (ms), as numbers and updatedAt. With `openSince` (ms), open
 * PRs are listed only down to the first page reaching back past it (the
 * caller knows the rest).
 */
export async function listRepoPrs(
	owner: string,
	repo: string,
	closedSince: number,
	cost: RefreshCost = newCost(),
	signal?: AbortSignal,
	openSince?: number,
): Promise<{ listed: Listed[]; complete: boolean }> {
	const listed: Listed[] = [];
	let openCursor: string | null = null;
	let closedCursor: string | null = null;
	let withOpen = true;
	let withClosed = true;
	let complete = true;
	for (let page = 0; page < MAX_PAGES && (withOpen || withClosed); page++) {
		const data = await graphql(
			[
				"-f",
				`query=${LIST_QUERY}`,
				"-f",
				`owner=${owner}`,
				"-f",
				`name=${repo}`,
				"-F",
				`withOpen=${withOpen}`,
				"-F",
				`withClosed=${withClosed}`,
				...(openCursor ? ["-f", `openCursor=${openCursor}`] : []),
				...(closedCursor ? ["-f", `closedCursor=${closedCursor}`] : []),
			],
			`the PRs of ${owner}/${repo}`,
			cost,
			signal,
		);
		if (data.repository === null || typeof data.repository !== "object") {
			throw new GhError(`Repository ${owner}/${repo} not found`);
		}
		const r = rec(data.repository);
		if (withOpen) {
			const conn = rec(r.open);
			if (!Array.isArray(conn.nodes)) {
				throw new GhError(
					`gh returned an unexpected response for ${owner}/${repo}`,
				);
			}
			let reachedBack = false;
			for (const n of conn.nodes) {
				const item = asListed(n);
				if (!item) continue;
				listed.push(item);
				if (openSince !== undefined && Date.parse(item.updatedAt) < openSince) {
					reachedBack = true;
				}
			}
			const info = rec(conn.pageInfo);
			openCursor = str(info.endCursor);
			const more = info.hasNextPage === true && openCursor !== null;
			if (more && reachedBack) complete = false;
			withOpen = more && !reachedBack;
		}
		if (withClosed) {
			const conn = rec(r.closed);
			if (!Array.isArray(conn.nodes)) {
				throw new GhError(
					`gh returned an unexpected response for ${owner}/${repo}`,
				);
			}
			let older = conn.nodes.length === 0;
			for (const n of conn.nodes) {
				const item = asListed(n);
				if (!item) continue;
				const closed = str(rec(n).mergedAt) ?? str(rec(n).closedAt);
				if (closed && Date.parse(closed) >= closedSince) listed.push(item);
				// By updatedAt, which a close also sets: past the cutoff,
				// nothing later closed recently.
				if (Date.parse(item.updatedAt) < closedSince) older = true;
			}
			const info = rec(conn.pageInfo);
			closedCursor = str(info.endCursor);
			withClosed = !older && info.hasNextPage === true && closedCursor !== null;
		}
	}
	if (withOpen || withClosed) {
		throw new GhError(`Too many PRs to read in ${owner}/${repo}`);
	}
	return { listed, complete };
}

function asListed(raw: unknown): Listed | null {
	const n = rec(raw);
	const updatedAt = str(n.updatedAt);
	if (!Number.isSafeInteger(n.number) || (n.number as number) < 1) return null;
	if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) return null;
	return { number: n.number as number, updatedAt };
}

export interface PrId {
	owner: string;
	repo: string;
	number: number;
}

/**
 * The full facts of these PRs, in any repos, DETAILS_BATCH a query (repos
 * and PRs by alias). A PR GitHub doesn't know is left out.
 */
export async function fetchPrDetails(
	ids: readonly PrId[],
	cost: RefreshCost = newCost(),
	signal?: AbortSignal,
): Promise<PrFacts[]> {
	for (const id of ids) {
		if (
			!OWNER.test(id.owner) ||
			!REPO.test(id.repo) ||
			!Number.isSafeInteger(id.number)
		) {
			throw new GhError(`Not a PR: ${id.owner}/${id.repo}#${id.number}`);
		}
	}
	const batches: PrId[][] = [];
	for (let i = 0; i < ids.length; i += DETAILS_BATCH) {
		batches.push(ids.slice(i, i + DETAILS_BATCH));
	}
	const out: PrFacts[] = [];
	let next = 0;
	const worker = async () => {
		while (next < batches.length) {
			const batch = batches[next++] ?? [];
			out.push(...(await fetchBatch(batch, cost, signal)));
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(DETAILS_PARALLEL, batches.length) }, worker),
	);
	return out;
}

/** The details query for one batch: `r<i>` per repo, `p<number>` per PR. */
export function detailsQuery(batch: readonly PrId[]): string {
	const repos = new Map<string, PrId[]>();
	for (const id of batch) {
		const key = `${id.owner}/${id.repo}`.toLowerCase();
		repos.set(key, [...(repos.get(key) ?? []), id]);
	}
	const parts = [...repos.values()].map((prs, i) => {
		const [{ owner, repo }] = prs as [PrId];
		const fields = prs
			.map((p) => `p${p.number}: pullRequest(number: ${p.number}) { ...F }`)
			.join(" ");
		return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { ${fields} }`;
	});
	return `query {\n  rateLimit { cost remaining resetAt }\n  ${parts.join("\n  ")}\n}\nfragment F on PullRequest { ${PR_FIELDS} }`;
}

async function fetchBatch(
	batch: readonly PrId[],
	cost: RefreshCost,
	signal?: AbortSignal,
): Promise<PrFacts[]> {
	const repos = [
		...new Map(
			batch.map((b) => [`${b.owner}/${b.repo}`.toLowerCase(), b]),
		).values(),
	];
	// A PR or repo GitHub doesn't resolve comes back null, with an error.
	const data = await graphql(
		["-f", `query=${detailsQuery(batch)}`],
		"the PRs' details",
		cost,
		signal,
		hasData,
	);
	const facts: PrFacts[] = [];
	repos.forEach(({ owner, repo }, i) => {
		const r = rec(data[`r${i}`]);
		for (const id of batch) {
			if (
				`${id.owner}/${id.repo}`.toLowerCase() !==
				`${owner}/${repo}`.toLowerCase()
			)
				continue;
			const pr = mapPrNode(owner, repo, r[`p${id.number}`]);
			if (pr) facts.push(pr);
		}
	});
	return facts;
}

export interface Known {
	facts: PrFacts;
	/** When these facts were read (ms). */
	readAt: number;
}

/**
 * Every open PR of `owner/repo` plus every one merged or closed at or after
 * `closedSince`, reusing `known` facts (by number) when the PR's updatedAt
 * is unchanged, its checks weren't running and they're younger than
 * DETAILS_MAX_AGE_MS. `listedSince` (ms): `known` holds every PR updated
 * before it, so the open list stops there (LIST_MARGIN_MS earlier); known
 * open PRs it didn't reach are kept, or read again once too old. A PR
 * closing moves its updatedAt, so the closed list (always complete) still
 * catches it.
 */
export async function fetchRepoPrs(
	owner: string,
	repo: string,
	closedSince: number,
	options: {
		known?: ReadonlyMap<number, Known>;
		listedSince?: number;
		now?: number;
		cost?: RefreshCost;
		signal?: AbortSignal;
		/** Filled with the numbers of listed PRs whose details GitHub didn't give. */
		missing?: number[];
	} = {},
): Promise<PrFacts[]> {
	const {
		known = new Map(),
		now = Date.now(),
		cost = newCost(),
		signal,
	} = options;
	const openSince =
		options.listedSince === undefined
			? undefined
			: options.listedSince - LIST_MARGIN_MS;
	const { listed } = await listRepoPrs(
		owner,
		repo,
		closedSince,
		cost,
		signal,
		openSince,
	);
	const fresh = (k: Known | undefined): k is Known =>
		k !== undefined &&
		k.facts.checks !== "running" &&
		now - k.readAt < DETAILS_MAX_AGE_MS;
	const kept: PrFacts[] = [];
	const stale: PrId[] = [];
	const seen = new Set<number>();
	for (const { number, updatedAt } of listed) {
		if (seen.has(number)) continue;
		seen.add(number);
		const k = known.get(number);
		if (fresh(k) && k.facts.updatedAt === updatedAt) kept.push(k.facts);
		else stale.push({ owner, repo, number });
	}
	// Known open PRs the list didn't reach (it stopped at known history) or
	// skipped (a PR updated between two pages' reads moves to a page already
	// read) stay: a PR never drops off for a refresh. One that closed shows
	// in the closed list, which is always complete.
	for (const [number, k] of known) {
		if (seen.has(number) || k.facts.state !== "OPEN") continue;
		if (fresh(k)) kept.push(k.facts);
		else stale.push({ owner, repo, number });
	}
	const read = await fetchPrDetails(stale, cost, signal);
	const got = new Set(read.map((pr) => pr.number));
	// Details GitHub didn't give (a null node in partial data): the known
	// facts stay, and the caller hears of it.
	for (const { number } of stale) {
		if (got.has(number)) continue;
		options.missing?.push(number);
		const k = known.get(number);
		if (k) kept.push(k.facts);
	}
	// A PR listed open but read closed (it closed in between) stays only if
	// it closed recently.
	const current = read.filter(
		(pr) => pr.closedAt === null || Date.parse(pr.closedAt) >= closedSince,
	);
	return [...kept, ...current];
}

/** The `gh` user, with their avatar. */
export async function fetchViewer(signal?: AbortSignal): Promise<Person> {
	const data = await graphql(
		["-f", "query=query { viewer { login avatarUrl(size: 40) } }"],
		"your GitHub login",
		newCost(),
		signal,
	);
	const viewer = person(data.viewer);
	if (!viewer) throw new GhError("Could not determine your GitHub login");
	return viewer;
}

/**
 * The viewer's teams as `org/slug`; null when they can't be read (a token
 * without `read:org`): a team's review request then isn't counted as the
 * viewer's.
 */
export async function fetchViewerTeams(
	login: string,
	signal?: AbortSignal,
): Promise<string[] | null> {
	if (!OWNER.test(login)) return null;
	try {
		const data = await graphql(
			[
				"-f",
				`query=query { viewer { organizations(first: 100) { nodes { login teams(first: 100, userLogins: [${JSON.stringify(login)}]) { nodes { slug } } } } } }`,
			],
			"your teams",
			newCost(),
			signal,
		);
		const teams: string[] = [];
		for (const org of list(rec(data.viewer).organizations)) {
			const name = str(rec(org).login);
			if (!name) continue;
			for (const t of list(rec(org).teams)) {
				const slug = str(rec(t).slug);
				if (slug) teams.push(`${name}/${slug}`);
			}
		}
		return teams;
	} catch (error) {
		// Only a missing scope means "unknown"; other failures keep what
		// the caller knew.
		if (error instanceof GhError && /scope|read:org/i.test(error.message)) {
			return null;
		}
		throw error;
	}
}

/** Relations to a repo that make it the viewer's (never a public stranger's). */
const RELATIONS = "[OWNER, COLLABORATOR, ORGANIZATION_MEMBER]";
const VIEWER_REPOS_QUERY = `query($cursor: String) { viewer { repositories(first: 100, after: $cursor, affiliations: ${RELATIONS}, ownerAffiliations: ${RELATIONS}, orderBy: { field: PUSHED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { nameWithOwner } } } rateLimit { cost remaining resetAt } }`;
/** At most this many pages (100 each) of the viewer's repos. */
const VIEWER_REPOS_MAX_PAGES = 50;

/**
 * Every repo the viewer owns, collaborates on or reaches as an org member,
 * most recently pushed first, as lowercased `owner/repo` (owner, 2026-10-30:
 * "search results should be my repos only, not public repos from github").
 */
export async function fetchViewerRepos(
	signal?: AbortSignal,
): Promise<string[]> {
	const names: string[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < VIEWER_REPOS_MAX_PAGES; page++) {
		const data = await graphql(
			[
				"-f",
				`query=${VIEWER_REPOS_QUERY}`,
				...(cursor ? ["-f", `cursor=${cursor}`] : []),
			],
			"your repos",
			newCost(),
			signal,
		);
		const repos = rec(rec(data.viewer).repositories);
		for (const node of list(repos)) {
			const name = str(rec(node).nameWithOwner);
			if (name && /^[^/\s]+\/[^/\s]+$/.test(name)) {
				names.push(name.toLowerCase());
			}
		}
		const info = rec(repos.pageInfo);
		cursor = info.hasNextPage === true ? (str(info.endCursor) ?? null) : null;
		if (!cursor) break;
	}
	return names;
}

const REPO_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { nameWithOwner }
}`;

/**
 * Whether GitHub has `owner/repo` (visible to the viewer); null when it
 * couldn't be asked (offline, rate limited): the caller can't tell.
 */
export async function repoExists(
	owner: string,
	repo: string,
): Promise<boolean | null> {
	if (!OWNER.test(owner) || !REPO.test(repo)) return false;
	try {
		const data = await graphql(
			[
				"-f",
				`query=${REPO_QUERY}`,
				"-f",
				`owner=${owner}`,
				"-f",
				`name=${repo}`,
			],
			`the repository ${owner}/${repo}`,
			newCost(),
		);
		return typeof rec(data.repository).nameWithOwner === "string";
	} catch (error) {
		if (
			error instanceof GhError &&
			/could not resolve to a repository|not found/i.test(error.message)
		) {
			return false;
		}
		return null;
	}
}
