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
	repoExists,
} from "./prFacts.js";
import {
	compareRows,
	RECENTLY_CLOSED_MS,
	sectionOf,
	turnOf,
	turnWithWaiting,
} from "./sections.js";
import { StartedReviews } from "./started.js";

/**
 * Home's state: GitHub's PR facts for the view's repos only (a PR started
 * elsewhere isn't read), refreshed on a timer (single flight, backing off
 * on failure), kept in memory as a cache only. The view, the inbox refs
 * and the clones are the state; every HomeView is folded afresh against
 * the clock, so a snooze whose date passes wakes on the next read.
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

/**
 * A failure that says GitHub can't be asked right now (rate limited,
 * unreachable, logged out): the refresh backs off. A repo that doesn't
 * exist is its own error and slows nothing.
 */
export function isTransient(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /rate limit|could not resolve host|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network is unreachable|dial tcp|connection reset|took longer than|not logged in|gh auth login/i.test(
		message,
	);
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
	/** Coverage only for the repos `withCoverage` names (StartedReviews.list). */
	list(
		slug: string,
		withCoverage?: ReadonlySet<string>,
	): Promise<StartedReview[]>;
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
	/** One more refresh, after the one in flight (refreshAfterCurrent). */
	#queued: Promise<HomeView> | null = null;
	#delay: number | null = null;
	#timer: NodeJS.Timeout | null = null;
	#stopped = true;
	/** start() or stop() was called. */
	#began = false;
	/** The last refresh cost, for the report and the log. */
	lastCost: RefreshCost = newCost();
	readonly #onRefresh: (() => void)[] = [];

	constructor(options: HomeServiceOptions) {
		this.#config = options.config;
		this.#started = options.started ?? new StartedReviews();
		this.#now = options.now ?? Date.now;
		this.#inbox = options.inbox ?? new InboxStore(this.#now);
	}

	/**
	 * Refreshes now and then on the timer, until stop(). Once only: later
	 * calls (every Home request) do nothing, and nothing restarts it after
	 * stop().
	 */
	start(): void {
		if (this.#began) return;
		this.#began = true;
		this.#stopped = false;
		void this.refresh().catch(() => {});
	}

	stop(): void {
		this.#began = true;
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

	/** Calls `listener` as each refresh begins (search warms its repo list). */
	onRefresh(listener: () => void): void {
		this.#onRefresh.push(listener);
	}

	/** Refreshes from GitHub, joining one in flight; never throws for GitHub's failures. */
	refresh(): Promise<HomeView> {
		this.#inflight ??= this.#refresh().finally(() => {
			this.#inflight = null;
			this.#schedule();
		});
		return this.#inflight;
	}

	/**
	 * A refresh that starts after any in flight (which may have read an older
	 * config): one queued at most, shared by every caller meanwhile.
	 */
	refreshAfterCurrent(): Promise<HomeView> {
		const running = this.#inflight;
		if (!running) return this.refresh();
		this.#queued ??= running
			.catch(() => undefined)
			.then(() => {
				this.#queued = null;
				return this.refresh();
			});
		return this.#queued;
	}

	async #refresh(): Promise<HomeView> {
		const begun = this.#now();
		for (const listener of this.#onRefresh) listener();
		const { config, problems } = await this.#config.read();
		this.#problems = problems;
		const base = Math.max(1, config.refresh.minutes) * 60_000;
		const repos = viewReposOf(config);
		const inView = new Set(repos);
		const cost = newCost();
		const errors: string[] = [];
		// Back off when GitHub can't be asked, or nothing could be read.
		let transient = false;
		let failedRepos = 0;
		const fail = (error: unknown, what?: string) => {
			const reason = refreshReason(error);
			errors.push(what ? `${what}: ${reason}` : reason);
			if (isTransient(error)) transient = true;
		};
		let viewer: Person | null = null;
		try {
			viewer = await this.#ensureViewer();
		} catch (error) {
			fail(error);
		}
		if (viewer) {
			if (begun - this.#teamsAt >= TEAMS_MAX_AGE_MS) {
				try {
					this.#teams = await fetchViewerTeams(viewer.login);
					this.#teamsAt = begun;
				} catch (error) {
					fail(error, "teams");
				}
			}
			try {
				this.#startedList = await this.#started.list(
					slugify(viewer.login),
					inView,
				);
			} catch (error) {
				fail(error, "started reviews");
			}
			const closedSince = begun - RECENTLY_CLOSED_MS;
			await Promise.all(
				repos.map(async (name) => {
					const [owner = "", repo = ""] = name.split("/");
					const known = new Map<number, Known>();
					for (const [key, k] of this.#facts) {
						if (key.startsWith(`${name}#`)) known.set(k.facts.number, k);
					}
					const missing: number[] = [];
					try {
						const prs = await fetchRepoPrs(owner, repo, closedSince, {
							known,
							listedSince: this.#listedAt.get(name),
							now: begun,
							cost,
							missing,
						});
						for (const key of [...this.#facts.keys()]) {
							if (key.startsWith(`${name}#`)) this.#facts.delete(key);
						}
						for (const pr of prs) this.#remember(pr, known, begun);
						this.#listedAt.set(name, begun);
						if (missing.length > 0) {
							errors.push(
								`${missing.map((n) => `${name}#${n}`).join(", ")}: not read from GitHub`,
							);
						}
					} catch (error) {
						failedRepos++;
						fail(error, name);
					}
				}),
			);
			// Facts of repos that left the view (owner, 2026-11-01: "only prs
			// from the selected repos should appear"): started ones too.
			for (const [key, { facts }] of this.#facts) {
				const repo = `${facts.owner}/${facts.repo}`.toLowerCase();
				if (!inView.has(repo)) this.#facts.delete(key);
			}
			for (const name of [...this.#listedAt.keys()]) {
				if (!inView.has(name)) this.#listedAt.delete(name);
			}
		}
		this.lastCost = cost;
		const allFailed = repos.length > 0 && failedRepos === repos.length;
		const backOff = viewer === null || transient || allFailed;
		this.#refreshError =
			errors.length > 0 ? [...new Set(errors)].join("; ") : null;
		if (backOff) {
			this.#delay = Math.min(
				MAX_BACKOFF_MS,
				Math.max(base, this.#delay ?? base) * 2,
			);
		} else {
			this.#refreshedAt = begun;
			this.#delay = base;
		}
		// Its started list was just read.
		return this.#view();
	}

	#remember(pr: PrFacts, known: ReadonlyMap<number, Known>, at: number) {
		const before = known.get(pr.number);
		// Kept facts keep the time they were read.
		const readAt = before && before.facts === pr ? before.readAt : at;
		this.#facts.set(prSlug(pr), { facts: pr, readAt });
	}

	/**
	 * Home as of now, from the cache, the inbox refs and the clock. The
	 * started reviews are listed again on every read (one for-each-ref per
	 * clone, snapshots cached): coverage is never staler than the progress
	 * refs, and a review started since the last refresh shows at once.
	 */
	async view(): Promise<HomeView> {
		const { viewer } = await this.#viewerOrBlank();
		if (viewer.login) {
			try {
				this.#startedList = await this.#started.list(
					slugify(viewer.login),
					new Set(await this.viewRepos()),
				);
			} catch {
				// Keep the last list; the next refresh says why.
			}
		}
		return this.#view();
	}

	async #view(): Promise<HomeView> {
		const now = this.#now();
		const { config, problems } = await this.#config.read();
		const first = config.views[0];
		const repos = viewReposOf(config);
		const { viewer, error: viewerError } = await this.#viewerOrBlank();
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
			// Only the view's repos, started or not: the cache may still hold
			// a repo just taken out, until the next refresh.
			if (!inView.has(`${facts.owner}/${facts.repo}`.toLowerCase())) continue;
			const section = sectionOf(facts, viewer.login, this.#teams, started, now);
			if (!section) continue;
			const annotations = slug
				? ((await inboxOf(facts.owner, facts.repo)).get(facts.number) ?? {})
				: {};
			sections
				.get(section)
				?.push(this.#row(facts, viewer, started, annotations, now));
		}
		const out: HomeSection[] = SECTIONS.map((id) => ({
			id,
			rows: (sections.get(id) ?? []).sort(compareRows(viewer.login)),
		}));
		return {
			viewer,
			view: { name: first?.name ?? DEFAULT_VIEW, repos },
			configProblems: [...new Set([...this.#problems, ...problems])],
			refreshedAt:
				this.#refreshedAt === null
					? null
					: new Date(this.#refreshedAt).toISOString(),
			refreshError: this.#refreshError ?? viewerError,
			sections: out,
			startedRepos: [
				...new Set(
					[...this.#startedList]
						.sort(
							(a, b) => Date.parse(b.lastActedAt) - Date.parse(a.lastActedAt),
						)
						.map((s) => `${s.owner}/${s.repo}`.toLowerCase()),
				),
			],
		};
	}

	#row(
		pr: PrFacts,
		viewer: Person,
		started: readonly StartedReview[],
		annotations: Annotations,
		now: number,
	): HomeRow {
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
		// A repo new to the view must exist (a typo would fail every refresh).
		const before = new Set(await this.viewRepos());
		for (const name of repos) {
			if (before.has(name)) continue;
			const [owner = "", repo = ""] = name.split("/");
			if ((await repoExists(owner, repo)) === false) {
				throw new HomeRequestError(`Repository ${name} not found on GitHub`);
			}
		}
		await this.#config.update((c) => {
			const [first, ...rest] = c.views;
			return {
				...c,
				views: [{ ...(first ?? { name: DEFAULT_VIEW }), repos }, ...rest],
			};
		});
		return this.refreshAfterCurrent();
	}

	/** The first view's repos, `owner/repo` lowercased. */
	async viewRepos(): Promise<string[]> {
		return viewReposOf((await this.#config.read()).config);
	}

	/** The viewer's login, "" while it can't be read. */
	async viewerLogin(): Promise<string> {
		return (await this.#viewerOrBlank()).viewer.login;
	}

	/** Every PR Home knows (the view repos'), for search. */
	knownPrs(): PrFacts[] {
		return [...this.#facts.values()].map((k) => k.facts);
	}

	/** The viewer's started reviews as of the last refresh. */
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
