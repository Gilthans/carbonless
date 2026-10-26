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

/**
 * The commit `spec` names among the PR's `commits` and `reviews` (GitHub's
 * connections, oldest first), for `viewer` (a reviewer slug).
 * - `reviewed`: the commit of the viewer's latest submitted review, in any
 *   state; a pending review (no `submittedAt`) doesn't count. On a tie the
 *   later one in the list wins.
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
		let best: { at: number; oid: string } | null = null;
		for (const raw of reviews) {
			const r = obj(raw);
			if (r.state === "PENDING" || typeof r.submittedAt !== "string") continue;
			const login = obj(r.author).login;
			if (typeof login !== "string" || slugify(login) !== viewer) continue;
			const at = Date.parse(r.submittedAt);
			const oid = oidOf(r.commit);
			if (Number.isNaN(at) || !oid) continue;
			if (!best || at >= best.at) best = { at, oid };
		}
		if (!best) {
			throw new GhError(`${viewer} has no submitted review on ${pr}`);
		}
		return best.oid;
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
