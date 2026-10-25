import { GhError } from "./errors.js";

/**
 * As-of mode (hidden dev flag `--as-of`): the PR as it was at a past moment.
 * Everything here is pure; gh.ts and clone.ts do the fetching.
 */

const ISO_WITH_ZONE =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * The cutoff as a canonical UTC ISO string ("2026-09-15T11:35:52Z"). It must
 * name its zone: a local time would mean different moments on different
 * machines.
 */
export function parseAsOf(text: string): string {
	const ms = Date.parse(text);
	if (!ISO_WITH_ZONE.test(text.trim()) || Number.isNaN(ms)) {
		throw new Error(
			`Invalid --as-of: ${text}. Use an ISO time with a zone, e.g. 2026-09-15T11:35:52Z`,
		);
	}
	return new Date(ms).toISOString().replace(".000Z", "Z");
}

/** Whether `iso` is a time at or before `cutoff` (unparseable: no). */
export function atOrBefore(iso: unknown, cutoff: string): boolean {
	if (typeof iso !== "string") return false;
	const t = Date.parse(iso);
	return !Number.isNaN(t) && t <= Date.parse(cutoff);
}

const obj = (v: unknown): Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * The PR's head at `cutoff`: the commit of the latest event at or before it,
 * where events are
 * - each review (`submittedAt`) with the commit it was made on, and
 * - each commit of the PR (`pushedDate`, else `committedDate`).
 * On a tie a review wins (a review at exactly the cutoff names the commit
 * that was reviewed); otherwise the later one in GitHub's list wins (both
 * lists are oldest first, and a rebase pushes commits within one second).
 * Reviews cover commits a later force-push dropped from the PR's commit
 * list; commit dates cover pushes nobody reviewed.
 * `committedDate` approximates the push time (GitHub no longer reports
 * pushes), so a commit made long before it was pushed counts from when it
 * was made.
 */
export function headAsOf(
	commits: unknown[],
	reviews: unknown[],
	cutoff: string,
): string {
	let best: { at: number; oid: string; review: boolean } | null = null;
	const consider = (at: unknown, oid: unknown, review: boolean) => {
		if (typeof oid !== "string" || !OID.test(oid)) return;
		if (!atOrBefore(at, cutoff)) return;
		const t = Date.parse(at as string);
		// Commits are considered before reviews, each list in order: on a tie
		// the later one wins, except that a commit never displaces a review.
		if (!best || t > best.at || (t === best.at && (review || !best.review))) {
			best = { at: t, oid, review };
		}
	};
	for (const raw of commits) {
		const c = obj(obj(raw).commit);
		consider(c.pushedDate ?? c.committedDate, c.oid, false);
	}
	for (const raw of reviews) {
		const r = obj(raw);
		consider(r.submittedAt, obj(r.commit).oid, true);
	}
	const found = best as { oid: string } | null;
	if (!found) {
		throw new GhError(`The PR has no commit at or before ${cutoff}`);
	}
	return found.oid;
}
