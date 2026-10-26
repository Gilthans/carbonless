import { GhError } from "./errors.js";
import { slugify } from "./slug.js";

/**
 * A pinned head (`crb --head <sha|reviewed>`): the snapshot is the
 * three-dot diff of the current base branch and that commit, while
 * everything else about the PR stays live. Everything here is pure; gh.ts
 * does the reading.
 */
export type HeadSpec = { kind: "reviewed" } | { kind: "sha"; prefix: string };

const SHA_PREFIX = /^[0-9a-f]{7,64}$/;
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** `--head`'s value: `reviewed`, or a commit sha of at least 7 hex digits. */
export function parseHead(text: string): HeadSpec {
	const t = text.trim().toLowerCase();
	if (t === "reviewed") return { kind: "reviewed" };
	if (SHA_PREFIX.test(t)) return { kind: "sha", prefix: t };
	throw new Error(
		`Invalid --head: ${text}. Use reviewed or a commit sha (7+ hex digits)`,
	);
}

const obj = (v: unknown): Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};

const oidOf = (v: unknown): string | null => {
	const oid = obj(v).oid;
	return typeof oid === "string" && OID.test(oid) ? oid : null;
};

/** Whether `r` is one of `viewer`'s submitted reviews (not pending). */
function submittedBy(r: Record<string, unknown>, viewer: string): boolean {
	if (r.state === "PENDING" || typeof r.submittedAt !== "string") return false;
	if (Number.isNaN(Date.parse(r.submittedAt))) return false;
	const login = obj(r.author).login;
	return typeof login === "string" && slugify(login) === viewer;
}

/** A COMMENTED review with no body: it may be replies only (replyOnly). */
const mayBeReplies = (r: Record<string, unknown>) =>
	r.state === "COMMENTED" &&
	(typeof r.body !== "string" || r.body.trim() === "");

/**
 * Whether review node `raw` of `viewer` needs the rest of its comments read
 * before replyOnly can tell (gh.ts pages them in).
 */
export function needsCommentPages(raw: unknown, viewer: string): boolean {
	const r = obj(raw);
	return (
		submittedBy(r, viewer) &&
		mayBeReplies(r) &&
		obj(obj(r.comments).pageInfo).hasNextPage === true
	);
}

/**
 * Whether a review only replied to existing threads: COMMENTED, no body,
 * and every one of its comments (at least one) a reply. GitHub makes each
 * reply on the PR page such a review, on the commit the PR was at then, so
 * it says nothing about which commit was reviewed. Throws when its
 * comments aren't all there to tell (fails closed, never guesses).
 */
function replyOnly(r: Record<string, unknown>, viewer: string, pr: string) {
	if (!mayBeReplies(r)) return false;
	const comments = obj(r.comments);
	const nodes = comments.nodes;
	if (!Array.isArray(nodes) || obj(comments.pageInfo).hasNextPage !== false) {
		throw new GhError(
			`Could not tell whether ${viewer}'s review of ${String(r.submittedAt)} on ${pr} only replies to threads`,
		);
	}
	return (
		nodes.length > 0 &&
		nodes.every((c) => {
			const to = obj(c).replyTo;
			return typeof to === "object" && to !== null;
		})
	);
}

/**
 * The commit `spec` names among the PR's `commits` and `reviews` (GitHub's
 * connections, oldest first), for `viewer` (a reviewer slug).
 * - `reviewed`: the commit of the viewer's latest submitted review, in any
 *   state, except one that only replied to existing threads (replyOnly).
 *   A pending review doesn't count. On a tie the later one in the list
 *   wins. If that review has no commit, it fails: an older review is never
 *   taken in its place.
 * - a sha: the one commit of the PR it abbreviates. The PR's commits are
 *   its current ones and those its reviews were made on (a force-push
 *   drops the reviewed ones from the commit list).
 */
export function pickHead(
	spec: HeadSpec,
	commits: unknown[],
	reviews: unknown[],
	viewer: string,
	pr: string,
): string {
	if (spec.kind === "reviewed") {
		// Newest first; a stable sort keeps GitHub's order, reversed, on ties.
		const mine = reviews
			.map(obj)
			.filter((r) => submittedBy(r, viewer))
			.reverse()
			.sort(
				(a, b) =>
					Date.parse(b.submittedAt as string) -
					Date.parse(a.submittedAt as string),
			);
		for (const r of mine) {
			if (replyOnly(r, viewer, pr)) continue;
			const oid = oidOf(r.commit);
			if (!oid) {
				throw new GhError(`${viewer}'s last review on ${pr} has no commit`);
			}
			return oid;
		}
		throw new GhError(
			mine.length
				? `${viewer} has only replied to threads on ${pr}, never reviewed it`
				: `${viewer} has no submitted review on ${pr}`,
		);
	}
	const known = new Set<string>();
	for (const raw of commits) {
		const oid = oidOf(obj(raw).commit);
		if (oid) known.add(oid);
	}
	for (const raw of reviews) {
		const oid = oidOf(obj(raw).commit);
		if (oid) known.add(oid);
	}
	const matches = [...known].filter((oid) => oid.startsWith(spec.prefix));
	if (matches.length === 0) {
		throw new GhError(`${spec.prefix} is not a commit of ${pr}`);
	}
	if (matches.length > 1) {
		throw new GhError(`${spec.prefix} names more than one commit of ${pr}`);
	}
	return matches[0] as string;
}
