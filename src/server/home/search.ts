import type { HomeRow, Person, SearchResult } from "../../shared/home.js";
import { GhError } from "../errors.js";
import { parsePrArg, runGh } from "../gh.js";
import type { PrFacts } from "./facts.js";
import type { HomeService } from "./homeService.js";
import { fetchPrDetails } from "./prFacts.js";

/**
 * Home's open box: a PR named outright, a title search inside a repo, or
 * repos and PR titles at once. Answers at once from what Home knows; GitHub
 * searches run in the background and come in on a later ask (`pending`).
 */

export type ParsedQuery =
	| { kind: "pr"; owner: string; repo: string; number: number }
	| { kind: "scoped"; owner: string; repo: string; words: string[] }
	| { kind: "free"; text: string; words: string[] };

const SCOPE =
	/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\s+(.*)$/s;
const NUMBER = /^#?(\d{1,9})$/;

const wordsOf = (text: string) =>
	text.toLowerCase().split(/\s+/).filter(Boolean);

export function parseQuery(q: string): ParsedQuery {
	const text = q.trim();
	try {
		const pr = parsePrArg(text);
		if ("owner" in pr) return { kind: "pr", ...pr };
	} catch {
		// Not a PR on its own.
	}
	const scoped = SCOPE.exec(q.trimStart());
	if (scoped) {
		const [, owner = "", repo = "", rest = ""] = scoped;
		const words = wordsOf(rest);
		const n = words.length === 1 ? NUMBER.exec(words[0] ?? "") : null;
		if (n) return { kind: "pr", owner, repo, number: Number(n[1]) };
		return { kind: "scoped", owner, repo, words };
	}
	return { kind: "free", text: text.toLowerCase(), words: wordsOf(text) };
}

/** GitHub searches start only for this many characters. */
export const MIN_GITHUB_CHARS = 3;
/** A finished GitHub search is reused this long. */
const SEARCH_TTL_MS = 60_000;
const MAX_REPOS = 10;
const MAX_PRS = 30;
const MAX_CACHED = 200;

type Pr = SearchResult["prs"][number];
type Repo = SearchResult["repos"][number];

interface Pending<T> {
	at: number;
	promise: Promise<void>;
	result?: T;
}

const matches = (title: string, words: readonly string[]) => {
	const t = title.toLowerCase();
	return words.every((w) => t.includes(w));
};

/** Open first, then merged and closed; each by last activity, newest first. */
const byRank = (a: Pr, b: Pr) =>
	Number(b.state === "OPEN") - Number(a.state === "OPEN") ||
	Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

const GH_STATES: Record<string, HomeRow["state"]> = {
	open: "OPEN",
	merged: "MERGED",
	closed: "CLOSED",
};

export class HomeSearch {
	readonly #home: HomeService;
	readonly #now: () => number;
	readonly #searches = new Map<string, Pending<unknown>>();

	constructor(home: HomeService, options: { now?: () => number } = {}) {
		this.#home = home;
		this.#now = options.now ?? Date.now;
	}

	/** The result of `run` for `key` once in; starts it if not running (undefined until then). */
	#background<T>(
		key: string,
		run: () => Promise<T>,
	): { result?: T; pending: boolean } {
		const now = this.#now();
		const found = this.#searches.get(key) as Pending<T> | undefined;
		if (
			found &&
			(found.result === undefined || now - found.at < SEARCH_TTL_MS)
		) {
			return { result: found.result, pending: found.result === undefined };
		}
		if (this.#searches.size >= MAX_CACHED) {
			const oldest = this.#searches.keys().next().value;
			if (oldest !== undefined) this.#searches.delete(oldest);
		}
		const entry: Pending<T> = { at: now, promise: Promise.resolve() };
		entry.promise = run().then(
			(result) => {
				entry.result = result;
				entry.at = this.#now();
			},
			() => {
				// A failed search shows nothing more; asked again later.
				this.#searches.delete(key);
			},
		);
		this.#searches.set(key, entry as Pending<unknown>);
		return { pending: true };
	}

	async #asPr(f: PrFacts): Promise<Pr> {
		return {
			owner: f.owner,
			repo: f.repo,
			number: f.number,
			title: f.title,
			author: f.author,
			state: f.state,
			updatedAt: f.updatedAt,
			hidden: await this.#home.hiddenOf(f),
		};
	}

	async search(q: string): Promise<SearchResult> {
		const parsed = parseQuery(q);
		const known = this.#home.knownPrs();
		const viewRepos = await this.#home.viewRepos();
		if (parsed.kind === "pr") {
			const { owner, repo, number } = parsed;
			const scope = `${owner}/${repo}`.toLowerCase();
			const hit = known.find(
				(f) =>
					`${f.owner}/${f.repo}`.toLowerCase() === scope && f.number === number,
			);
			if (hit)
				return {
					repos: [],
					prs: [await this.#asPr(hit)],
					scope,
					pending: false,
				};
			const read = this.#background(`pr:${scope}#${number}`, async () => {
				const [f] = await fetchPrDetails([{ owner, repo, number }]);
				return f ?? null;
			});
			const prs = read.result ? [await this.#asPr(read.result)] : [];
			return { repos: [], prs, scope, pending: read.pending };
		}
		if (parsed.kind === "scoped") {
			const { owner, repo, words } = parsed;
			const scope = `${owner}/${repo}`.toLowerCase();
			const inView = viewRepos.includes(scope);
			const local = await Promise.all(
				known
					.filter((f) => `${f.owner}/${f.repo}`.toLowerCase() === scope)
					.filter((f) => matches(f.title, words))
					.map((f) => this.#asPr(f)),
			);
			// A view repo's list is complete without words; beyond the cache
			// (older closed PRs) or outside the view, GitHub's search.
			const askGitHub = !inView || words.join(" ").length >= MIN_GITHUB_CHARS;
			let pending = false;
			let remote: Pr[] = [];
			if (askGitHub) {
				const found = this.#background(`prs:${scope}:${words.join(" ")}`, () =>
					searchPrs(owner, repo, words),
				);
				pending = found.pending;
				remote = found.result ?? [];
			}
			const seen = new Set(local.map((p) => p.number));
			const prs = [...local, ...remote.filter((p) => !seen.has(p.number))]
				.sort(byRank)
				.slice(0, MAX_PRS);
			return { repos: [], prs, scope, pending };
		}
		const { text, words } = parsed;
		const repos: Repo[] = [];
		const add = (r: Repo) => {
			if (!repos.some((x) => x.name === r.name)) repos.push(r);
		};
		const openCount = (name: string) =>
			known.filter(
				(f) =>
					`${f.owner}/${f.repo}`.toLowerCase() === name && f.state === "OPEN",
			).length;
		for (const name of viewRepos) {
			if (name.includes(text))
				add({ name, inView: true, openCount: openCount(name) });
		}
		const recent = [...this.#home.startedReviews()].sort(
			(a, b) => Date.parse(b.lastActedAt) - Date.parse(a.lastActedAt),
		);
		for (const s of recent) {
			const name = `${s.owner}/${s.repo}`.toLowerCase();
			if (name.includes(text)) add({ name, inView: false, openCount: null });
		}
		let pending = false;
		if (text.length >= MIN_GITHUB_CHARS) {
			const found = this.#background(`repos:${text}`, () => searchRepos(text));
			pending = found.pending;
			for (const name of found.result ?? []) {
				add({ name, inView: viewRepos.includes(name), openCount: null });
			}
		}
		const prs =
			words.length === 0
				? []
				: (
						await Promise.all(
							known
								.filter((f) => matches(f.title, words))
								.map((f) => this.#asPr(f)),
						)
					)
						.sort(byRank)
						.slice(0, MAX_PRS);
		return { repos: repos.slice(0, MAX_REPOS), prs, scope: null, pending };
	}
}

type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};

function json(out: string): unknown[] {
	try {
		const v = JSON.parse(out);
		if (Array.isArray(v)) return v;
	} catch {}
	throw new GhError("gh returned output that is not JSON");
}

/** `gh search repos`: full names, lowercased. */
export async function searchRepos(text: string): Promise<string[]> {
	const out = await runGh(
		[
			"search",
			"repos",
			"--limit",
			String(MAX_REPOS),
			"--json",
			"fullName",
			"--",
			text,
		],
		{ what: "the repo search" },
	);
	return json(out)
		.map((r) => rec(r).fullName)
		.filter(
			(n): n is string => typeof n === "string" && /^[^/\s]+\/[^/\s]+$/.test(n),
		)
		.map((n) => n.toLowerCase());
}

/** `gh search prs --repo`: title words, by last activity. */
export async function searchPrs(
	owner: string,
	repo: string,
	words: readonly string[],
): Promise<Pr[]> {
	const out = await runGh(
		[
			"search",
			"prs",
			"--repo",
			`${owner}/${repo}`,
			"--limit",
			String(MAX_PRS),
			"--sort",
			"updated",
			"--json",
			"number,title,author,state,updatedAt",
			"--",
			...words,
		],
		{ what: "the PR search" },
	);
	const prs: Pr[] = [];
	for (const raw of json(out)) {
		const p = rec(raw);
		const login = rec(p.author).login;
		if (!Number.isSafeInteger(p.number) || typeof p.updatedAt !== "string")
			continue;
		const author: Person =
			typeof login === "string" && login
				? { login, avatarUrl: `https://github.com/${login}.png?size=40` }
				: { login: "ghost", avatarUrl: "" };
		prs.push({
			owner: owner.toLowerCase(),
			repo: repo.toLowerCase(),
			number: p.number as number,
			title: typeof p.title === "string" ? p.title : "",
			author,
			state: GH_STATES[String(p.state)] ?? "OPEN",
			updatedAt: p.updatedAt,
			hidden: null,
		});
	}
	return prs;
}
