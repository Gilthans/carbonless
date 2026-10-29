import type {
	AnnotationOp,
	Annotations,
	HomeRow,
	HomeSection,
	HomeView,
	Person,
	SectionId,
} from "../../shared/home.js";
import { GhError } from "../errors.js";
import { slugify } from "../slug.js";
import {
	type PrFacts,
	prSlug,
	type StartedReview,
	sameLogin,
} from "./facts.js";
import { hiddenReason, InboxStore, wokeOf } from "./inbox.js";
import {
	fetchPrDetails,
	fetchRepoPrs,
	fetchViewer,
	fetchViewerTeams,
	type Known,
	newCost,
	type RefreshCost,
} from "./prFacts.js";
import {
	RECENTLY_CLOSED_MS,
	recentlyClosed,
	sectionOf,
	turnOf,
	turnWithWaiting,
} from "./sections.js";
import { StartedReviews } from "./started.js";

/**
 * Home's state: GitHub's PR facts for the view's repos and every started
 * PR, refreshed on a timer (single flight, backing off on failure), kept in
 * memory as a cache only. The view, the inbox refs and the clones are the
 * state; every HomeView is folded afresh against the clock, so a snooze
 * whose date passes wakes on the next read.
 */

/** The parts of crb's config Home reads and writes (src/server/config.ts). */
export interface HomeConfig {
	views: { name: string; repos: string[] }[];
	refresh: { minutes: number };
}
export interface ConfigAccess {
	read(): Promise<{ config: HomeConfig; problems: string[] }>;
	update(change: (c: HomeConfig) => HomeConfig): Promise<HomeConfig>;
}

/**
 * ConfigAccess over crb's whole config (src/server/config.ts readConfig and
 * updateConfig): Home changes only its parts, the rest is kept.
 */
export function configAccess<C extends HomeConfig>(
	read: () => Promise<{ config: C; problems: string[] }>,
	update: (change: (c: C) => C) => Promise<C>,
): ConfigAccess {
	return {
		read,
		update: (change) => update((c) => ({ ...c, ...change(c) })),
	};
}

export const SECTIONS: readonly SectionId[] = [
	"mine",
	"reviewing",
	"grabs",
	"other",
	"closed",
];
export const MAX_BACKOFF_MS = 30 * 60_000;
/** The viewer's teams are read again this often. */
const TEAMS_MAX_AGE_MS = 30 * 60_000;
const DEFAULT_VIEW = "My PRs";

/** A request Home refuses for what it says (HTTP 400). */
export class HomeRequestError extends Error {}
/** A PR Home doesn't list (HTTP 404). */
export class NotOnHomeError extends Error {}

const OWNER_REPO = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;
const REPO_URL =
	/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:[/?#].*)?$/i;

/** `owner/repo`, lowercased, from that form or a GitHub URL; null otherwise. */
export function parseRepo(input: string): string | null {
	const text = input.trim();
	const m = OWNER_REPO.exec(text) ?? REPO_URL.exec(text);
	if (!m || m[2] === "." || m[2] === "..") return null;
	return `${m[1]}/${m[2]}`.toLowerCase();
}

/** Why a refresh failed, short, for the header's warning. */
export function refreshReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/rate limit/i.test(message)) return "Rate limited by GitHub";
	if (
		/could not resolve host|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network is unreachable|dial tcp|connection reset/i.test(
			message,
		)
	) {
		return "GitHub unreachable";
	}
	return message.replace(/^gh: /, "");
}

interface StartedSource {
	list(slug: string): Promise<StartedReview[]>;
}

export interface HomeServiceOptions {
	config: ConfigAccess;
	started?: StartedSource;
	inbox?: InboxStore;
	now?: () => number;
}

export class HomeService {
	readonly #config: ConfigAccess;
	readonly #started: StartedSource;
	readonly #inbox: InboxStore;
	readonly #now: () => number;

	#viewer: Person | null = null;
	#teams: string[] | null = null;
	#teamsAt = Number.NEGATIVE_INFINITY;
	/** By prSlug. */
	#facts = new Map<string, Known>();
	/** Per view repo: when its last successful refresh began (listedSince). */
	#listedAt = new Map<string, number>();
	#startedList: StartedReview[] = [];
	#refreshedAt: number | null = null;
	#refreshError: string | null = null;
	#problems: string[] = [];
	#inflight: Promise<HomeView> | null = null;
	#delay: number | null = null;
	#timer: NodeJS.Timeout | null = null;
	#stopped = true;
	/** The last refresh cost, for the report and the log. */
	lastCost: RefreshCost = newCost();

	constructor(options: HomeServiceOptions) {
		this.#config = options.config;
		this.#started = options.started ?? new StartedReviews();
		this.#inbox = options.inbox ?? new InboxStore();
		this.#now = options.now ?? Date.now;
	}

	/** Refreshes now and then on the timer, until stop(). */
	start(): void {
		this.#stopped = false;
		void this.refresh().catch(() => {});
	}

	stop(): void {
		this.#stopped = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
	}

	/** How long until the next timed refresh: refresh.minutes, doubled per failure up to MAX_BACKOFF_MS. */
	nextDelayMs(): number {
		return this.#delay ?? 2 * 60_000;
	}

	#schedule(): void {
		if (this.#stopped) return;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			void this.refresh().catch(() => {});
		}, this.nextDelayMs());
		this.#timer.unref();
	}

	async #ensureViewer(): Promise<Person> {
		this.#viewer ??= await fetchViewer();
		return this.#viewer;
	}

	/** Refreshes from GitHub, joining one in flight; never throws for GitHub's failures. */
	refresh(): Promise<HomeView> {
		this.#inflight ??= this.#refresh().finally(() => {
			this.#inflight = null;
			this.#schedule();
		});
		return this.#inflight;
	}

	async #refresh(): Promise<HomeView> {
		const begun = this.#now();
		const { config, problems } = await this.#config.read();
		this.#problems = problems;
		const base = Math.max(1, config.refresh.minutes) * 60_000;
		const repos = config.views[0]?.repos ?? [];
		const cost = newCost();
		const errors: string[] = [];
		try {
			const viewer = await this.#ensureViewer();
			if (begun - this.#teamsAt >= TEAMS_MAX_AGE_MS) {
				try {
					this.#teams = await fetchViewerTeams(viewer.login);
					this.#teamsAt = begun;
				} catch (error) {
					errors.push(refreshReason(error));
				}
			}
			this.#startedList = await this.#started.list(slugify(viewer.login));
			const closedSince = begun - RECENTLY_CLOSED_MS;
			const inView = new Set(repos);
			await Promise.all(
				repos.map(async (name) => {
					const [owner = "", repo = ""] = name.split("/");
					const known = new Map<number, Known>();
					for (const [key, k] of this.#facts) {
						if (key.startsWith(`${name}#`)) known.set(k.facts.number, k);
					}
					try {
						const prs = await fetchRepoPrs(owner, repo, closedSince, {
							known,
							listedSince: this.#listedAt.get(name),
							now: begun,
							cost,
						});
						for (const key of [...this.#facts.keys()]) {
							if (key.startsWith(`${name}#`)) this.#facts.delete(key);
						}
						for (const pr of prs) this.#remember(pr, known, begun);
						this.#listedAt.set(name, begun);
					} catch (error) {
						errors.push(`${name}: ${refreshReason(error)}`);
					}
				}),
			);
			// Started PRs outside the view, until 3 days after they closed.
			const outside = this.#startedList.filter((s) => {
				const key = prSlug(s);
				if (inView.has(`${s.owner}/${s.repo}`.toLowerCase())) return false;
				const k = this.#facts.get(key);
				return !k || k.facts.state === "OPEN" || recentlyClosed(k.facts, begun);
			});
			const unique = [...new Map(outside.map((s) => [prSlug(s), s])).values()];
			if (unique.length > 0) {
				try {
					const read = await fetchPrDetails(
						unique.map(({ owner, repo, number }) => ({ owner, repo, number })),
						cost,
					);
					for (const pr of read) this.#remember(pr, new Map(), begun);
				} catch (error) {
					errors.push(refreshReason(error));
				}
			}
		} catch (error) {
			errors.push(refreshReason(error));
		}
		this.lastCost = cost;
		if (errors.length === 0) {
			this.#refreshedAt = begun;
			this.#refreshError = null;
			this.#delay = base;
		} else {
			this.#refreshError = errors.join("; ");
			this.#delay = Math.min(
				MAX_BACKOFF_MS,
				Math.max(base, this.#delay ?? base) * 2,
			);
		}
		return this.view();
	}

	#remember(pr: PrFacts, known: ReadonlyMap<number, Known>, at: number) {
		const before = known.get(pr.number);
		// Kept facts keep the time they were read.
		const readAt = before && before.facts === pr ? before.readAt : at;
		this.#facts.set(prSlug(pr), { facts: pr, readAt });
	}

	/** Home as of now, from the cache, the inbox refs and the clock. */
	async view(): Promise<HomeView> {
		const now = this.#now();
		const { config, problems } = await this.#config.read();
		const first = config.views[0];
		const repos = first?.repos ?? [];
		const viewer = await this.#ensureViewer();
		const slug = slugify(viewer.login);
		const inView = new Set(repos);
		const startedBy = new Map<string, StartedReview[]>();
		for (const s of this.#startedList) {
			const key = prSlug(s);
			startedBy.set(key, [...(startedBy.get(key) ?? []), s]);
		}
		const inboxes = new Map<string, Map<number, Annotations>>();
		const inboxOf = async (owner: string, repo: string) => {
			const key = `${owner}/${repo}`.toLowerCase();
			let inbox = inboxes.get(key);
			if (!inbox) {
				inbox = await this.#inbox
					.read(slug, owner, repo)
					.catch(() => new Map());
				inboxes.set(key, inbox);
			}
			return inbox;
		};
		const sections = new Map<SectionId, HomeRow[]>(
			SECTIONS.map((id) => [id, []]),
		);
		for (const [key, { facts }] of this.#facts) {
			const started = startedBy.get(key) ?? [];
			const listed = inView.has(`${facts.owner}/${facts.repo}`.toLowerCase());
			if (!listed && started.length === 0) continue;
			const section = sectionOf(facts, viewer.login, this.#teams, started, now);
			if (!section) continue;
			const annotations =
				(await inboxOf(facts.owner, facts.repo)).get(facts.number) ?? {};
			sections
				.get(section)
				?.push(this.#row(facts, viewer, started, annotations, now));
		}
		const out: HomeSection[] = SECTIONS.map((id) => ({
			id,
			rows: (sections.get(id) ?? []).sort(
				(a, b) =>
					Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
					b.number - a.number,
			),
		}));
		return {
			viewer,
			view: { name: first?.name ?? DEFAULT_VIEW, repos },
			configProblems: [...new Set([...this.#problems, ...problems])],
			refreshedAt:
				this.#refreshedAt === null
					? null
					: new Date(this.#refreshedAt).toISOString(),
			refreshError: this.#refreshError,
			sections: out,
		};
	}

	#row(
		pr: PrFacts,
		viewer: Person,
		started: readonly StartedReview[],
		annotations: Annotations,
		now: number,
	): HomeRow {
		const hidden = hiddenReason(annotations, pr, now);
		// A wait overrides the turn while it holds ("me": always).
		const waiting =
			annotations.waiting &&
			(annotations.waiting.who === "me" || hidden === "waiting")
				? annotations.waiting
				: undefined;
		const turn = turnWithWaiting(
			turnOf(pr, viewer.login),
			waiting,
			viewer.login,
		);
		const reviewers = [
			...pr.requested.users,
			...pr.requested.teams,
			...pr.reviewers,
		].filter(
			(l, i, all) =>
				!sameLogin(l, pr.author.login) &&
				all.findIndex((m) => sameLogin(m, l)) === i,
		);
		reviewers.sort(
			(a, b) =>
				Number(sameLogin(b, viewer.login)) - Number(sameLogin(a, viewer.login)),
		);
		const people: Record<string, Person> = {};
		const logins = [
			...(turn.kind === "people" ? turn.logins : []),
			...reviewers,
		];
		for (const login of logins) {
			const p = sameLogin(login, viewer.login)
				? viewer
				: pr.people[login.toLowerCase()];
			people[login] = p ?? { login, avatarUrl: "" };
		}
		const reviews = started
			.filter((s) => s.asOf === null)
			.sort((a, b) => Date.parse(b.lastActedAt) - Date.parse(a.lastActedAt))
			.map((s) => ({
				id: s.id,
				label: s.pinnedHead ? s.pinnedHead.slice(0, 7) : "head",
				pinnedHead: s.pinnedHead,
				coverage: s.coverage,
				lastActedAt: s.lastActedAt,
			}));
		return {
			owner: pr.owner,
			repo: pr.repo,
			number: pr.number,
			title: pr.title,
			url: pr.url,
			author: pr.author,
			draft: pr.draft,
			state: pr.state,
			closedAt: pr.closedAt,
			updatedAt: pr.updatedAt,
			checks: pr.checks,
			decision: pr.decision,
			unresolvedThreads: pr.unresolvedThreads,
			turn,
			reviewers,
			people,
			annotations,
			hidden,
			woke: wokeOf(annotations, pr, now),
			reviews,
			openable: pr.state === "OPEN" || reviews.length > 0,
		};
	}

	/** Writes the viewer's annotation of a PR Home lists and returns its row. */
	async annotate(
		owner: string,
		repo: string,
		number: number,
		op: AnnotationOp,
	): Promise<HomeRow> {
		const key = prSlug({ owner, repo, number });
		const known = this.#facts.get(key);
		if (!known)
			throw new NotOnHomeError(`${owner}/${repo}#${number} is not on Home`);
		if (op.op === "snooze" && !(Date.parse(op.until) > this.#now())) {
			throw new HomeRequestError("A snooze must end in the future");
		}
		const viewer = await this.#ensureViewer();
		const { owner: o, repo: r } = known.facts;
		const annotations = await this.#inbox.append(
			slugify(viewer.login),
			o,
			r,
			number,
			op,
		);
		const started = this.#startedList.filter((s) => prSlug(s) === key);
		return this.#row(known.facts, viewer, started, annotations, this.#now());
	}

	/** Sets the first view's repos (made "My PRs" if none) and refreshes. */
	async setRepos(input: readonly string[]): Promise<HomeView> {
		const repos: string[] = [];
		for (const item of input) {
			const name = parseRepo(item);
			if (!name)
				throw new HomeRequestError(
					`Not a repository: ${item}. Use owner/repo or its URL`,
				);
			if (!repos.includes(name)) repos.push(name);
		}
		await this.#config.update((c) => {
			const [first, ...rest] = c.views;
			return {
				...c,
				views: [{ ...(first ?? { name: DEFAULT_VIEW }), repos }, ...rest],
			};
		});
		return this.refresh();
	}

	/** The first view's repos, `owner/repo` lowercased. */
	async viewRepos(): Promise<string[]> {
		return (await this.#config.read()).config.views[0]?.repos ?? [];
	}

	/** Every PR Home knows (view repos and started ones), for search. */
	knownPrs(): PrFacts[] {
		return [...this.#facts.values()].map((k) => k.facts);
	}

	/** The viewer's started reviews as of the last refresh. */
	startedReviews(): readonly StartedReview[] {
		return this.#startedList;
	}

	/** Annotations' hidden reason for a known PR, for search ("snoozed" tag). */
	async hiddenOf(pr: PrFacts): Promise<HomeRow["hidden"]> {
		const viewer = await this.#ensureViewer();
		const inbox = await this.#inbox
			.read(slugify(viewer.login), pr.owner, pr.repo)
			.catch(() => new Map());
		return hiddenReason(inbox.get(pr.number) ?? {}, pr, this.#now());
	}
}

export { GhError };
