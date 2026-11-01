import type {
	AnnotationOp,
	Annotations,
	HomeRow,
	HomeView,
	Person,
	RepoHome,
} from "../../shared/home.js";
import { GhError } from "../errors.js";
import { slugify } from "../slug.js";
import {
	type PrFacts,
	prSlug,
	type StartedReview,
	sameLogin,
} from "./facts.js";
import {
	hiddenReason,
	InboxStore,
	waitHolds,
	waitsOnViewer,
	wokeOf,
} from "./inbox.js";
import {
	fetchRepoPrs,
	fetchViewer,
	fetchViewerTeams,
	type Known,
	newCost,
	type RefreshCost,
} from "./prFacts.js";
import {
	RECENTLY_CLOSED_MS,
	sectionOf,
	turnOf,
	turnWithWaiting,
} from "./sections.js";
import { StartedReviews } from "./started.js";

/**
 * Home's state: GitHub's PR facts per view repo (a PR started elsewhere
 * isn't read), each repo read when the page asks for it and its facts are
 * older than FRESH_MS (one read per repo at a time, shared), kept in
 * memory as a cache only. The page's queries drive freshness (owner,
 * 2026-11-01: "Every repo PR list should have its own tanstack query");
 * there is no server timer. The view, the inbox refs and the clones are
 * the state; every answer is folded afresh against the clock, so a snooze
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

/**
 * A repo's facts answer from the cache this long after its last read; an
 * older ask reads GitHub again. Shorter than any refresh.minutes, so the
 * page's every timed ask is a read.
 */
export const FRESH_MS = 30_000;
/** A repo out of the view keeps its facts this long (re-added: incremental). */
export const KEEP_MS = 3_600_000;
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

/** Why a read failed, short, for the repo's status. */
export function refreshReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/could not resolve to a repository/i.test(message)) {
		return "Not found on GitHub";
	}
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
	/**
	 * Coverage only for the repos `withCoverage` names; `only`: that repo's
	 * clone alone (StartedReviews.list).
	 */
	list(
		slug: string,
		withCoverage?: ReadonlySet<string>,
		only?: string,
	): Promise<StartedReview[]>;
}

/** What Home knows of one repo (`owner/repo`, lowercased). */
interface RepoState {
	/** By PR number. */
	facts: Map<number, Known>;
	/** When the last read that worked began (fetchRepoPrs' listedSince). */
	listedAt: number | undefined;
	/** When the last read, worked or not, began: FRESH_MS counts from it. */
	checkedAt: number;
	error: string | null;
	failures: number;
	/** The viewer's started reviews of its PRs, as of its last answer. */
	started: StartedReview[];
	reading: Promise<void> | null;
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
	#teamsReading: Promise<void> | null = null;
	readonly #repos = new Map<string, RepoState>();
	/** The view's repos as last read from the config (knownPrs is sync). */
	#inView = new Set<string>();
	/** Every started review, as the last view() listed them (search's recent repos). */
	#startedList: StartedReview[] = [];
	#problems: string[] = [];
	/** The last read's cost, for the report and the log. */
	lastCost: RefreshCost = newCost();
	readonly #onRefresh: (() => void)[] = [];

	constructor(options: HomeServiceOptions) {
		this.#config = options.config;
		this.#started = options.started ?? new StartedReviews();
		this.#now = options.now ?? Date.now;
		this.#inbox = options.inbox ?? new InboxStore(this.#now);
	}

	async #ensureViewer(): Promise<Person> {
		this.#viewer ??= await fetchViewer();
		return this.#viewer;
	}

	/**
	 * The viewer, or while their login can't be read (offline, logged out)
	 * a blank one and why: Home still answers.
	 */
	async #viewerOrBlank(): Promise<{ viewer: Person; error: string | null }> {
		try {
			return { viewer: await this.#ensureViewer(), error: null };
		} catch (error) {
			return {
				viewer: { login: "", avatarUrl: "" },
				error: refreshReason(error),
			};
		}
	}

	/** Calls `listener` as each repo read begins (search warms its repo list). */
	onRefresh(listener: () => void): void {
		this.#onRefresh.push(listener);
	}

	/** The viewer's teams, read again after TEAMS_MAX_AGE_MS; one read at a time. */
	async #ensureTeams(login: string, at: number): Promise<string | null> {
		if (at - this.#teamsAt < TEAMS_MAX_AGE_MS) return null;
		let failed: string | null = null;
		this.#teamsReading ??= fetchViewerTeams(login)
			.then((teams) => {
				this.#teams = teams;
				this.#teamsAt = at;
			})
			.finally(() => {
				this.#teamsReading = null;
			});
		await this.#teamsReading.catch((error) => {
			failed = `teams: ${refreshReason(error)}`;
		});
		return failed;
	}

	#state(name: string): RepoState {
		let state = this.#repos.get(name);
		if (!state) {
			state = {
				facts: new Map(),
				listedAt: undefined,
				checkedAt: Number.NEGATIVE_INFINITY,
				error: null,
				failures: 0,
				started: [],
				reading: null,
			};
			this.#repos.set(name, state);
		}
		return state;
	}

	/**
	 * One view repo's rows: read from GitHub first when its facts are older
	 * than FRESH_MS (or `fresh`), joining a read in flight; from the cache
	 * otherwise. A repo out of the view is a NotOnHomeError, asked of no one.
	 * GitHub's failures are the answer's `error`, never a throw.
	 */
	async repo(
		owner: string,
		repo: string,
		opts: { fresh?: boolean } = {},
	): Promise<RepoHome> {
		const name = `${owner}/${repo}`.toLowerCase();
		if (!(await this.viewRepos()).includes(name)) {
			throw new NotOnHomeError(`${name} is not in the view`);
		}
		const state = this.#state(name);
		if (
			state.reading ||
			opts.fresh ||
			this.#now() - state.checkedAt >= FRESH_MS
		) {
			state.reading ??= this.#read(name, state).finally(() => {
				state.reading = null;
			});
			await state.reading;
		}
		return this.#repoView(name, state);
	}

	async #read(name: string, state: RepoState): Promise<void> {
		const begun = this.#now();
		for (const listener of this.#onRefresh) listener();
		const [owner = "", repo = ""] = name.split("/");
		const cost = newCost();
		try {
			const viewer = await this.#ensureViewer();
			const teamsError = await this.#ensureTeams(viewer.login, begun);
			const missing: number[] = [];
			const prs = await fetchRepoPrs(owner, repo, begun - RECENTLY_CLOSED_MS, {
				known: state.facts,
				listedSince: state.listedAt,
				now: begun,
				cost,
				missing,
			});
			const facts = new Map<number, Known>();
			for (const pr of prs) {
				const before = state.facts.get(pr.number);
				// Kept facts keep the time they were read.
				const readAt = before && before.facts === pr ? before.readAt : begun;
				facts.set(pr.number, { facts: pr, readAt });
			}
			state.facts = facts;
			state.listedAt = begun;
			state.failures = 0;
			const errors = [
				...(teamsError ? [teamsError] : []),
				...(missing.length > 0
					? [
							`${missing.map((n) => `${name}#${n}`).join(", ")}: not read from GitHub`,
						]
					: []),
			];
			state.error = errors.length > 0 ? errors.join("; ") : null;
		} catch (error) {
			state.failures++;
			state.error = refreshReason(error);
		} finally {
			state.checkedAt = begun;
			this.lastCost = cost;
		}
	}

	/**
	 * A repo's answer as of now, from its facts, the inbox ref and the
	 * clock. Its started reviews are listed again on every answer (one
	 * for-each-ref, snapshots cached): coverage is never staler than the
	 * progress refs, and a review started since the last read shows at once.
	 */
	async #repoView(name: string, state: RepoState): Promise<RepoHome> {
		const now = this.#now();
		const viewer = this.#viewer ?? { login: "", avatarUrl: "" };
		const slug = slugify(viewer.login);
		if (viewer.login) {
			try {
				state.started = (
					await this.#started.list(slug, new Set([name]), name)
				).filter((s) => `${s.owner}/${s.repo}`.toLowerCase() === name);
			} catch {
				// Keep the last list.
			}
		}
		const [owner = "", repo = ""] = name.split("/");
		const inbox: Map<number, Annotations> = slug
			? await this.#inbox.read(slug, owner, repo).catch(() => new Map())
			: new Map();
		const rows: HomeRow[] = [];
		for (const { facts } of state.facts.values()) {
			const started = state.started.filter((s) => s.number === facts.number);
			const row = this.#row(
				facts,
				viewer,
				started,
				inbox.get(facts.number) ?? {},
				now,
			);
			if (row) rows.push(row);
		}
		const refreshedAt = state.listedAt;
		return {
			repo: name,
			rows,
			refreshedAt:
				refreshedAt === undefined ? null : new Date(refreshedAt).toISOString(),
			error: state.error,
			failures: state.failures,
		};
	}

	/**
	 * Home's view: the viewer, the repos, the config's problems and the
	 * started reviews' repos. No repo is read here (each has its own
	 * request), only the viewer's login the first time.
	 */
	async view(): Promise<HomeView> {
		const { viewer, error } = await this.#viewerOrBlank();
		if (viewer.login) {
			try {
				this.#startedList = await this.#started.list(
					slugify(viewer.login),
					new Set(),
				);
			} catch {
				// Keep the last list.
			}
		}
		return this.#homeView(viewer, error);
	}

	async #homeView(viewer: Person, viewerError: string | null) {
		const { config, problems } = await this.#config.read();
		this.#problems = problems;
		const repos = viewReposOf(config);
		this.#inView = new Set(repos);
		return {
			viewer,
			view: { name: config.views[0]?.name ?? DEFAULT_VIEW, repos },
			configProblems: [...new Set(this.#problems)],
			viewerError,
			refreshMinutes: Math.max(1, config.refresh.minutes),
			startedRepos: [
				...new Set(
					[...this.#startedList]
						.sort(
							(a, b) => Date.parse(b.lastActedAt) - Date.parse(a.lastActedAt),
						)
						.map((s) => `${s.owner}/${s.repo}`.toLowerCase()),
				),
			],
		} satisfies HomeView;
	}

	/** The row Home shows for `pr`, in its section; null when it shows none. */
	#row(
		pr: PrFacts,
		viewer: Person,
		started: readonly StartedReview[],
		annotations: Annotations,
		now: number,
	): HomeRow | null {
		const section = sectionOf(pr, viewer.login, this.#teams, started, now);
		if (!section) return null;
		const hidden = hiddenReason(annotations, pr, now, viewer.login);
		// A wait overrides the turn while it holds, snoozed or not; one on
		// the viewer ("me") always.
		const w = annotations.waiting;
		const waiting =
			w &&
			(waitsOnViewer(w, viewer.login) ||
				waitHolds(annotations, pr, viewer.login))
				? w
				: undefined;
		const turn = turnWithWaiting(
			turnOf(pr, viewer.login, this.#teams),
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
				// Listed before the repo joined the view: none read yet, so
				// nothing claimed (the next read has it).
				coverage: s.coverage ?? { done: 0, total: 0, unit: "clusters" },
				lastActedAt: s.lastActedAt,
				headMoved: pr.headOid !== "" && s.head !== pr.headOid,
			}));
		return {
			owner: pr.owner,
			repo: pr.repo,
			number: pr.number,
			section,
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
			woke: wokeOf(annotations, pr, now, viewer.login),
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
		const name = `${owner}/${repo}`.toLowerCase();
		const state = this.#repos.get(name);
		const known = state?.facts.get(number);
		const viewer = known && (await this.#ensureViewer());
		const shown =
			state &&
			known &&
			viewer &&
			(await this.viewRepos()).includes(name) &&
			sectionOf(
				known.facts,
				viewer.login,
				this.#teams,
				state.started,
				this.#now(),
			);
		if (!state || !known || !viewer || !shown)
			throw new NotOnHomeError(`${owner}/${repo}#${number} is not on Home`);
		if (op.op === "snooze" && !(Date.parse(op.until) > this.#now())) {
			throw new HomeRequestError("A snooze must end in the future");
		}
		const { owner: o, repo: r } = known.facts;
		const annotations = await this.#inbox.append(
			slugify(viewer.login),
			o,
			r,
			number,
			op,
		);
		const started = state.started.filter((s) => s.number === number);
		const row = this.#row(
			known.facts,
			viewer,
			started,
			annotations,
			this.#now(),
		);
		if (!row)
			throw new NotOnHomeError(`${owner}/${repo}#${number} is not on Home`);
		return row;
	}

	/**
	 * Sets the first view's repos (made "My PRs" if none) and answers the
	 * view at once: no GitHub call, no read (owner, 2026-11-01: "Saving
	 * saves the configured repos immediately"). A repo GitHub doesn't know
	 * says so in its own answer. Facts of repos out of the view for over
	 * KEEP_MS go.
	 */
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
		const now = this.#now();
		for (const [name, state] of this.#repos) {
			if (!repos.includes(name) && now - state.checkedAt > KEEP_MS) {
				this.#repos.delete(name);
			}
		}
		return this.#homeView(this.#viewer ?? { login: "", avatarUrl: "" }, null);
	}

	/** The first view's repos, `owner/repo` lowercased. */
	async viewRepos(): Promise<string[]> {
		const repos = viewReposOf((await this.#config.read()).config);
		this.#inView = new Set(repos);
		return repos;
	}

	/** The viewer's login, "" while it can't be read. */
	async viewerLogin(): Promise<string> {
		return (await this.#viewerOrBlank()).viewer.login;
	}

	/** Every PR Home knows of the view's repos, for search. */
	knownPrs(): PrFacts[] {
		return [...this.#repos]
			.filter(([name]) => this.#inView.has(name))
			.flatMap(([, state]) => [...state.facts.values()].map((k) => k.facts));
	}

	/** The viewer's started reviews as of the last view. */
	startedReviews(): readonly StartedReview[] {
		return this.#startedList;
	}

	/**
	 * The hidden reason of each PR (by prSlug), for search's "snoozed" tag:
	 * one inbox read per repo, whatever the PR count.
	 */
	async hiddenOfMany(
		prs: readonly PrFacts[],
	): Promise<Map<string, HomeRow["hidden"]>> {
		const out = new Map<string, HomeRow["hidden"]>();
		const { viewer } = await this.#viewerOrBlank();
		if (!viewer.login) return out;
		const slug = slugify(viewer.login);
		const byRepo = new Map<string, PrFacts[]>();
		for (const pr of prs) {
			const key = `${pr.owner}/${pr.repo}`.toLowerCase();
			byRepo.set(key, [...(byRepo.get(key) ?? []), pr]);
		}
		const now = this.#now();
		await Promise.all(
			[...byRepo.values()].map(async (list) => {
				const [first] = list as [PrFacts];
				const inbox = await this.#inbox
					.read(slug, first.owner, first.repo)
					.catch(() => new Map<number, Annotations>());
				for (const pr of list) {
					out.set(
						prSlug(pr),
						hiddenReason(inbox.get(pr.number) ?? {}, pr, now, viewer.login),
					);
				}
			}),
		);
		return out;
	}
}

/** The first view's repos, lowercased (a hand edit may not be). */
const viewReposOf = (config: HomeConfig) => [
	...new Set((config.views[0]?.repos ?? []).map((r) => r.toLowerCase())),
];

export { GhError };
