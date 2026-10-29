import type { Coverage, HomeRow, Person } from "../../shared/home.js";

/**
 * One PR as Home needs it from GitHub (prFacts.ts reads it): what the
 * sections, the turn rules and a row show. Logins are GitHub's spelling;
 * every comparison is case-insensitive (sameLogin).
 */
export interface PrFacts {
	owner: string;
	repo: string;
	number: number;
	title: string;
	url: string;
	author: Person;
	draft: boolean;
	state: HomeRow["state"];
	/** When it was merged or closed; null while open. */
	closedAt: string | null;
	/** GitHub's `updatedAt`: any push, comment, review or state change. */
	updatedAt: string;
	checks: HomeRow["checks"];
	decision: HomeRow["decision"];
	unresolvedThreads: number;
	/** Pending review requests (GitHub drops one once its reviewer submits). */
	requested: {
		users: string[];
		/** `org/slug`. */
		teams: string[];
	};
	/** Logins (not the author) who submitted a review or a review comment. */
	reviewers: string[];
	/**
	 * Each login's last activity on the PR (a commit, a comment, a review):
	 * ISO time, by lowercased login.
	 */
	lastActivity: Record<string, string>;
	/** Avatars of the people above (author, requested, reviewers), by lowercased login; teams by `org/slug`. */
	people: Record<string, Person>;
}

export const sameLogin = (a: string, b: string) =>
	a.toLowerCase() === b.toLowerCase();

export const prSlug = (p: { owner: string; repo: string; number: number }) =>
	`${p.owner.toLowerCase()}/${p.repo.toLowerCase()}#${p.number}`;

/**
 * A review the viewer has started (has a patch set in), from the cache
 * clones (started.ts). `asOf` reviews are dev mode: never counted as started.
 */
export interface StartedReview {
	owner: string;
	repo: string;
	number: number;
	/** Review id. */
	id: string;
	/** The head a `crb --head` review is pinned on; null for the PR's plain review. */
	pinnedHead: string | null;
	asOf: string | null;
	coverage: Coverage;
	/** The viewer's last event in the review's progress ref. */
	lastActedAt: string;
}
