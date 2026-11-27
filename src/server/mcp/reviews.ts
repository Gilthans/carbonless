import type { Coverage } from "../../shared/home.js";
import { oneLine } from "../agent/prompt.js";
import type { StartedReview } from "../home/facts.js";

/**
 * The reviews a session can ask to join (the MCP `reviews` tool): the
 * reviewer's started reviews and the reviews open on this server, newest
 * activity first. Read from crb's own data (the clones' refs, the open
 * sessions, Home's cached PR facts), never from GitHub.
 */

export interface JoinableReview {
	/** The review's page on the origin the request came in on (no key). */
	link: string;
	repo: string;
	pr: number;
	title?: string;
	author?: string;
	branch?: { head: string; base: string };
	state?: "open" | "draft" | "merged" | "closed";
	lastActivity: string;
	progress: {
		reviewed: number;
		total: number;
		unit: "lines" | "clusters" | "files";
	} | null;
	buddy: "none" | "acp" | "joined" | "pending";
	joinable: boolean;
	reason?: string;
}

/** An open review, as the registry has it. */
export interface OpenReview {
	id: string;
	owner: string;
	repo: string;
	number: number;
	title: string;
	headBranch: string;
	baseBranch: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	lastUsed: number;
	/** False: no agent here (as of a cutoff, or as --viewer someone else). */
	agent: boolean;
	buddy: "joined" | "pending" | null;
	asOf: string | null;
}

export interface JoinableDeps {
	open(): OpenReview[];
	/** The reviewer's slug when known without asking GitHub, else null. */
	viewer(): Promise<string | null>;
	/** The started reviews, coverage not asked for (StartedReviews.list). */
	started(slug: string): Promise<readonly StartedReview[]>;
	/**
	 * The coverage of the started reviews it answers with, by id: counted
	 * only for those, never for every review ever started (CAR-324).
	 */
	coverage(
		slug: string,
		reviews: readonly StartedReview[],
	): Promise<Map<string, Coverage | null>>;
	/** Home's cached facts of a PR, if any. */
	cached(
		owner: string,
		repo: string,
		number: number,
	):
		| {
				title: string;
				author: { login: string };
				draft: boolean;
				state: "OPEN" | "CLOSED" | "MERGED";
		  }
		| undefined;
	/** Whether an ACP agent is configured. */
	acpConfigured(): Promise<boolean>;
	/** Whether review `id`'s ACP spawn flag is set (acp-on). */
	spawned(id: string): boolean;
	/** Whether review `id` has a joined session on disk (joined.json). */
	joinedOnDisk(id: string): boolean;
}

export const MAX_JOINABLE = 50;
/** A title, author or branch name, in code points. */
const MAX_TEXT = 300;

const stateOf = (
	state: "OPEN" | "CLOSED" | "MERGED",
	draft: boolean,
): JoinableReview["state"] =>
	state === "MERGED"
		? "merged"
		: state === "CLOSED"
			? "closed"
			: draft
				? "draft"
				: "open";

export async function listJoinable(
	deps: JoinableDeps,
	origin: string,
	query?: string,
): Promise<JoinableReview[]> {
	const open = deps.open();
	const slug = await deps.viewer().catch(() => null);
	const started = slug ? await deps.started(slug).catch(() => []) : [];
	const acp = await deps.acpConfigured().catch(() => false);
	const rows = new Map<string, JoinableReview>();
	const buddyOf = (
		id: string,
		live: "joined" | "pending" | null | undefined,
	): JoinableReview["buddy"] => {
		if (live) return live;
		if (live === undefined && deps.joinedOnDisk(id)) return "joined";
		return acp && deps.spawned(id) ? "acp" : "none";
	};
	const openById = new Map(open.map((o) => [o.id, o]));
	for (const s of started) {
		const o = openById.get(s.id);
		const cached = deps.cached(s.owner, s.repo, s.number);
		rows.set(s.id, {
			link: `${origin}/r/${s.id}`,
			repo: `${s.owner}/${s.repo}`,
			pr: s.number,
			...(o ? { title: o.title } : cached ? { title: cached.title } : {}),
			...(cached ? { author: cached.author.login } : {}),
			...(o ? { branch: { head: o.headBranch, base: o.baseBranch } } : {}),
			...(cached
				? { state: stateOf(cached.state, cached.draft) }
				: o
					? { state: stateOf(o.state, false) }
					: {}),
			lastActivity: s.lastActedAt,
			progress: s.coverage
				? {
						reviewed: s.coverage.done,
						total: s.coverage.total,
						unit: s.coverage.unit,
					}
				: null,
			buddy: o && !o.agent ? "none" : buddyOf(s.id, o ? o.buddy : undefined),
			joinable: true,
		});
	}
	for (const o of open) {
		if (rows.has(o.id)) continue;
		const cached = deps.cached(o.owner, o.repo, o.number);
		const noAgent = !o.agent;
		const reason = o.asOf
			? "a view as of a past moment has no buddy"
			: "a view as another reviewer has no buddy";
		rows.set(o.id, {
			link: `${origin}/r/${o.id}`,
			repo: `${o.owner}/${o.repo}`,
			pr: o.number,
			title: o.title,
			...(cached ? { author: cached.author.login } : {}),
			branch: { head: o.headBranch, base: o.baseBranch },
			state: cached
				? stateOf(cached.state, cached.draft)
				: stateOf(o.state, false),
			lastActivity: new Date(o.lastUsed).toISOString(),
			progress: null,
			buddy: noAgent ? "none" : buddyOf(o.id, o.buddy),
			joinable: !noAgent,
			...(noAgent ? { reason } : {}),
		});
	}
	// PR text is anyone's: one sanitised line each before a session reads it.
	for (const r of rows.values()) {
		if (r.title !== undefined) r.title = oneLine(r.title, MAX_TEXT);
		if (r.author !== undefined) r.author = oneLine(r.author, MAX_TEXT);
		if (r.branch) {
			r.branch = {
				head: oneLine(r.branch.head, MAX_TEXT),
				base: oneLine(r.branch.base, MAX_TEXT),
			};
		}
	}
	const q = query?.trim().toLowerCase();
	const matches = (r: JoinableReview) =>
		!q ||
		[
			r.repo,
			r.title ?? "",
			r.branch?.head ?? "",
			r.branch?.base ?? "",
			`#${r.pr}`,
		]
			.join("\n")
			.toLowerCase()
			.includes(q);
	const answer = [...rows]
		.filter(([, r]) => matches(r))
		.sort(
			([, a], [, b]) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity),
		)
		.slice(0, MAX_JOINABLE);
	// Coverage counted only for the started reviews in the answer (the
	// list's own may be null: not asked for).
	const startedById = new Map(started.map((s) => [s.id, s]));
	const shown = answer
		.map(([id]) => startedById.get(id))
		.filter((s): s is StartedReview => s !== undefined);
	if (slug && shown.length > 0) {
		const coverage = await deps
			.coverage(slug, shown)
			.catch(() => new Map<string, Coverage | null>());
		for (const [id, r] of answer) {
			const c = coverage.get(id);
			if (c) r.progress = { reviewed: c.done, total: c.total, unit: c.unit };
		}
	}
	return answer.map(([, r]) => r);
}
