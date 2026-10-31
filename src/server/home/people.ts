import type { PeopleResult, Person } from "../../shared/home.js";
import { sameLogin } from "./facts.js";
import type { HomeService } from "./homeService.js";
import { fetchOrgMembers, searchUsers } from "./prFacts.js";

/**
 * Who the waiting-on input suggests (owner, 2026-10-31: "the waiting on
 * feature needs autocomplete on github users, with users from my orgs or
 * interacting with my repos appearing first"): first the members of the
 * viewer's orgs and the people on the PRs Home knows (authors, requested
 * reviewers, reviewers, commenters), then GitHub's user search from
 * MIN_USER_SEARCH_CHARS. Never the viewer (that's "Me"), a team, a bot or
 * an org: none of them acts itself, so a wait on one would never end.
 */

/** GitHub's user search starts at this many characters. */
export const MIN_USER_SEARCH_CHARS = 2;
/** The org members are read again at most this often. */
export const ORG_MEMBERS_TTL_MS = 3_600_000;
/** A finished user search (or a failed members read) is reused this long. */
const SEARCH_TTL_MS = 60_000;
const MAX_CLOSE = 8;
const MAX_OTHERS = 8;
const MAX_CACHED = 200;

const errorText = (error: unknown) =>
	error instanceof Error ? error.message.replace(/^gh: /, "") : String(error);

interface Search {
	at: number;
	result?: Person[];
	error?: string;
}

export class HomePeople {
	readonly #home: HomeService;
	readonly #now: () => number;
	readonly #maxPages: number | undefined;
	/** The org members: one read per server, again at most hourly. */
	#members: {
		people: Person[] | null;
		at: number;
		loading: boolean;
		error?: string;
	} = { people: null, at: Number.NEGATIVE_INFINITY, loading: false };
	readonly #searches = new Map<string, Search>();
	/** A cut list is logged once per server. */
	#loggedCut = false;

	constructor(
		home: HomeService,
		options: { now?: () => number; maxPages?: number } = {},
	) {
		this.#home = home;
		this.#now = options.now ?? Date.now;
		this.#maxPages = options.maxPages;
		// Read with Home's refresh, so the first suggestions rarely wait.
		home.onRefresh(() => {
			this.#orgMembers();
		});
	}

	/**
	 * The org members as last read, starting a read when there are none
	 * (a failure is asked again after SEARCH_TTL_MS) or they are older
	 * than ORG_MEMBERS_TTL_MS. A stale list keeps answering meanwhile.
	 */
	#orgMembers(): { people: Person[]; pending: boolean; error?: string } {
		const m = this.#members;
		const now = this.#now();
		const ttl = m.people ? ORG_MEMBERS_TTL_MS : SEARCH_TTL_MS;
		if (!m.loading && now - m.at >= ttl) {
			m.loading = true;
			fetchOrgMembers({ maxPages: this.#maxPages }).then(
				({ people, truncated }) => {
					this.#members = { people, at: this.#now(), loading: false };
					if (truncated && !this.#loggedCut) {
						this.#loggedCut = true;
						console.error(
							`crb: an org's member list stopped at its page cap; waiting-on suggests the rest only from your repos and GitHub's search`,
						);
					}
				},
				(error: unknown) => {
					m.loading = false;
					m.at = this.#now();
					m.error = errorText(error);
				},
			);
		}
		return {
			people: m.people ?? [],
			pending: m.people === null && m.loading,
			...(m.people === null && !m.loading && m.error !== undefined
				? { error: m.error }
				: {}),
		};
	}

	/** GitHub's users for `text` once in; starts the search if not running. */
	#users(text: string): { people: Person[]; pending: boolean; error?: string } {
		const now = this.#now();
		const found = this.#searches.get(text);
		const done =
			found && (found.result !== undefined || found.error !== undefined);
		if (found && (!done || now - found.at < SEARCH_TTL_MS)) {
			return {
				people: found.result ?? [],
				pending: !done,
				...(found.error !== undefined ? { error: found.error } : {}),
			};
		}
		this.#searches.delete(text);
		if (this.#searches.size >= MAX_CACHED) {
			const oldest = this.#searches.keys().next().value;
			if (oldest !== undefined) this.#searches.delete(oldest);
		}
		const entry: Search = { at: now };
		this.#searches.set(text, entry);
		searchUsers(text).then(
			(people) => {
				entry.result = people;
				entry.at = this.#now();
			},
			(error: unknown) => {
				entry.error = errorText(error);
				entry.at = this.#now();
			},
		);
		return { people: [], pending: true };
	}

	/**
	 * The people on the PRs Home knows, with how many PRs each is on: the
	 * author, requested reviewers, reviewers and everyone active (comments,
	 * commits). Bots and teams left out.
	 */
	#repoPeople(): Map<string, { person: Person; prs: number }> {
		const out = new Map<string, { person: Person; prs: number }>();
		for (const f of this.#home.knownPrs()) {
			const bots = new Set(f.bots.map((b) => b.toLowerCase()));
			const logins = new Set<string>();
			for (const login of [
				f.author.login,
				...f.requested.users,
				...f.reviewers,
				...Object.keys(f.lastActivity),
			]) {
				const key = login.toLowerCase();
				if (!login || login.includes("/") || bots.has(key)) continue;
				if (key.endsWith("[bot]")) continue;
				logins.add(key);
			}
			for (const key of logins) {
				const known = out.get(key);
				if (known) {
					known.prs++;
					continue;
				}
				const person =
					f.people[key] ??
					(sameLogin(f.author.login, key)
						? f.author
						: { login: key, avatarUrl: "" });
				out.set(key, { person, prs: 1 });
			}
		}
		return out;
	}

	async people(q: string): Promise<PeopleResult> {
		const text = q.trim().replace(/^@/, "").toLowerCase();
		const viewer = await this.#home.viewerLogin();
		const members = this.#orgMembers();
		const close = this.#repoPeople();
		for (const person of members.people) {
			const key = person.login.toLowerCase();
			if (!close.has(key)) close.set(key, { person, prs: 0 });
		}
		const matching = [...close.entries()]
			.filter(([key]) => key.includes(text) && !sameLogin(key, viewer))
			.sort(
				([a, x], [b, y]) =>
					Number(b.startsWith(text)) - Number(a.startsWith(text)) ||
					y.prs - x.prs ||
					a.localeCompare(b),
			)
			.map(([, { person }]) => person);
		let others: Person[] = [];
		let pending = members.pending;
		let error = members.error;
		if (text.length >= MIN_USER_SEARCH_CHARS) {
			const users = this.#users(text);
			pending ||= users.pending;
			error ??= users.error;
			others = users.people.filter(
				(p) => !close.has(p.login.toLowerCase()) && !sameLogin(p.login, viewer),
			);
		}
		return {
			close: matching.slice(0, MAX_CLOSE),
			others: others.slice(0, MAX_OTHERS),
			pending,
			...(error !== undefined ? { error } : {}),
		};
	}
}
