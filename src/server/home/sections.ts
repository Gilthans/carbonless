import type { Annotations, SectionId, Turn } from "../../shared/home.js";
import { type PrFacts, type StartedReview, sameLogin } from "./facts.js";

/**
 * Home's static sections and the turn column, from GitHub's PR facts only
 * (principle 7). Spec: "Sections" and "A row" in
 * docs/superpowers/specs/2026-10-28-home-and-always-on-server-design.md.
 */

/** Merged or closed PRs stay in Recently closed this long (owner, 2026-10-29). */
export const RECENTLY_CLOSED_MS = 3 * 86_400_000;

/** Whether the viewer counts as having started it: a patch set, not as of a cutoff. */
export const countsAsStarted = (reviews: readonly StartedReview[]) =>
	reviews.some((r) => r.asOf === null);

/** Whether a merged or closed PR closed within RECENTLY_CLOSED_MS of `now`. */
export function recentlyClosed(pr: PrFacts, now: number): boolean {
	if (pr.state === "OPEN" || pr.closedAt === null) return false;
	const at = Date.parse(pr.closedAt);
	return Number.isFinite(at) && now - at <= RECENTLY_CLOSED_MS;
}

/**
 * The one section the PR belongs to, or null when Home doesn't list it (closed
 * longer ago than RECENTLY_CLOSED_MS). `viewerTeams` (`org/slug`) is null when
 * unknown: a team's request then isn't the viewer's. `started`: the viewer's
 * started reviews of this PR. A PR asked only of the viewer's teams is up for
 * grabs until someone (not a bot) reviews it (owner, 2026-10-30); a team's
 * request is never Reviewing on its own.
 */
export function sectionOf(
	pr: PrFacts,
	viewer: string,
	viewerTeams: readonly string[] | null,
	started: readonly StartedReview[],
	now: number,
): SectionId | null {
	if (pr.state !== "OPEN") return recentlyClosed(pr, now) ? "closed" : null;
	if (sameLogin(pr.author.login, viewer)) return "mine";
	if (
		pr.requested.users.some((u) => sameLogin(u, viewer)) ||
		pr.reviewers.some((r) => sameLogin(r, viewer)) ||
		countsAsStarted(started)
	) {
		return "reviewing";
	}
	const askedOfOthers =
		pr.requested.users.length > 0 ||
		pr.requested.teams.some(
			(t) => !(viewerTeams ?? []).some((v) => sameLogin(v, t)),
		);
	const reviewed = pr.reviewers.some(
		(r) => !pr.bots.some((b) => sameLogin(b, r)),
	);
	if (!pr.draft && !askedOfOthers && !reviewed) return "grabs";
	return "other";
}

/** The viewer first, the rest in their order, no one twice. */
function viewerFirst(logins: readonly string[], viewer: string): string[] {
	const unique = logins.filter(
		(l, i) => logins.findIndex((m) => sameLogin(m, l)) === i,
	);
	return [
		...unique.filter((l) => sameLogin(l, viewer)),
		...unique.filter((l) => !sameLogin(l, viewer)),
	];
}

const lastOf = (pr: PrFacts, login: string) => {
	const at = pr.lastActivity[login.toLowerCase()];
	const ms = at ? Date.parse(at) : Number.NaN;
	return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
};

/**
 * Whose turn the facts say it is; rules in order, first match wins. Teams
 * the viewer is in (`viewerTeams`) come right after the viewer.
 */
export function turnOf(
	pr: PrFacts,
	viewer: string,
	viewerTeams: readonly string[] | null = null,
): Turn {
	const author: Turn = { kind: "people", logins: [pr.author.login] };
	// 1
	if (pr.state !== "OPEN") return { kind: "none" };
	// 2, 3
	if (pr.draft || pr.decision === "changes-requested") return author;
	// 4
	const mine = (t: string) => (viewerTeams ?? []).some((v) => sameLogin(v, t));
	const requested = [
		...pr.requested.teams.filter(mine),
		...pr.requested.users,
		...pr.requested.teams.filter((t) => !mine(t)),
	];
	if (requested.length > 0) {
		return { kind: "people", logins: viewerFirst(requested, viewer) };
	}
	// 5
	if (pr.decision === "approved") return { ...author, label: "merge" };
	// 6, 7
	if (pr.reviewers.length > 0) {
		const reviewersLast = Math.max(...pr.reviewers.map((r) => lastOf(pr, r)));
		if (lastOf(pr, pr.author.login) > reviewersLast) {
			return { kind: "people", logins: viewerFirst(pr.reviewers, viewer) };
		}
		return author;
	}
	// 8: on the viewer's own PR, it's theirs to request a review.
	if (sameLogin(pr.author.login, viewer)) {
		return { kind: "people", logins: [pr.author.login], label: "request" };
	}
	return { kind: "no-reviewer" };
}

/** The viewer's waiting-on overrides the turn of an open PR (their own login: "you"). */
export function turnWithWaiting(
	turn: Turn,
	waiting: Annotations["waiting"],
	viewer: string,
): Turn {
	if (!waiting || turn.kind === "none") return turn;
	return {
		kind: "people",
		logins: [sameLogin(waiting.who, viewer) ? viewer : waiting.who],
	};
}

/** The turn names the viewer (a team they're in names the team, not them). */
export function viewersTurn(turn: Turn, viewer: string): boolean {
	return (
		!!viewer &&
		turn.kind === "people" &&
		turn.logins.some((l) => sameLogin(l, viewer))
	);
}

/**
 * A section's order (owner, 2026-10-31: "things in my turn should appear
 * before things with someone else's turn"): the viewer's turn first, then
 * by last GitHub activity, newest first, in each group.
 */
export function compareRows(viewer: string) {
	return (
		a: { turn: Turn; updatedAt: string; number: number },
		b: { turn: Turn; updatedAt: string; number: number },
	): number =>
		Number(viewersTurn(b.turn, viewer)) - Number(viewersTurn(a.turn, viewer)) ||
		Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
		b.number - a.number;
}
