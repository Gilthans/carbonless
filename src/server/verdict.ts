import {
	MAX_REPLY,
	type PrOverview,
	type ReviewVerdict,
	type VerdictAnswer,
	type VerdictEvent,
	type VerdictFacts,
	type VerdictRequest,
} from "../shared/types.js";
import { atOrBefore } from "./asOf.js";
import { WriteRefusedError } from "./errors.js";
import {
	fetchReviews,
	type PrRef,
	postReview,
	type RestAnswer,
	type RestReview,
	type RuleReads,
	type VerdictRead,
} from "./gh.js";
import { MARKER_ID, markerFor, parseMarker, stripMarker } from "./marker.js";
import {
	CHECK_ORDER,
	checksAsOf,
	isBotAuthor,
	mapCheck,
	REVIEW_STATES,
} from "./overview.js";
import { slugify } from "./slug.js";
import { LIST_WAITS_MS, writesOff, writeWaits } from "./threadWrites.js";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const MERGE_STATES: readonly string[] = [
	"BEHIND",
	"BLOCKED",
	"CLEAN",
	"DIRTY",
	"DRAFT",
	"HAS_HOOKS",
	"UNKNOWN",
	"UNSTABLE",
] satisfies NonNullable<VerdictFacts["mergeStateStatus"]>[];
const DECISIONS: readonly string[] = [
	"APPROVED",
	"CHANGES_REQUESTED",
	"REVIEW_REQUIRED",
] satisfies NonNullable<VerdictFacts["reviewDecision"]>[];

/**
 * The base branch's rule from its three reads (fetchRuleReads): the
 * classic protection and the rulesets' rules together (the most approvals
 * either asks; code owners or up to date if either does). Null when it
 * can't be known: a read failed, or the protection is hidden (403/404,
 * no admin access) on a branch GitHub says is protected (an empty rules
 * list there is unknown, not none). An unprotected branch, or GitHub's
 * "Branch not protected" (an admin's answer), has no classic protection,
 * so its rules alone say (none: zeros).
 */
export function ruleOf(reads: RuleReads): VerdictFacts["rule"] {
	const { branch, protection, rules } = reads;
	if (!branch.ok || !rules.ok || !Array.isArray(rules.json)) return null;
	const isProtected = obj(branch.json).protected;
	if (typeof isProtected !== "boolean") return null;
	let approvals = 0;
	let codeOwners = false;
	let strict = false;
	if (protection.ok) {
		const p = obj(protection.json);
		const reviews = p.required_pull_request_reviews;
		if (reviews !== undefined && reviews !== null) {
			const count = obj(reviews).required_approving_review_count;
			if (typeof count !== "number") return null;
			approvals = count;
			codeOwners = obj(reviews).require_code_owner_reviews === true;
		}
		const checks = p.required_status_checks;
		if (checks !== undefined && checks !== null) {
			strict = obj(checks).strict === true;
		}
	} else if (!unprotected(protection) && (!hidden(protection) || isProtected)) {
		return null;
	}
	for (const raw of rules.json.flat()) {
		const rule = obj(raw);
		const params = obj(rule.parameters);
		if (rule.type === "pull_request") {
			const count = params.required_approving_review_count;
			if (typeof count !== "number") return null;
			approvals = Math.max(approvals, count);
			codeOwners ||= params.require_code_owner_review === true;
		}
		if (rule.type === "required_status_checks") {
			strict ||= params.strict_required_status_checks_policy === true;
		}
	}
	return { approvals, codeOwners, strict };
}

/** A protection read GitHub refused as not the viewer's to see (or none there). */
const hidden = (a: RestAnswer) =>
	!a.ok && (a.status === 403 || a.status === 404);
/** GitHub's answer to an admin for a branch without classic protection. */
const unprotected = (a: RestAnswer) =>
	!a.ok && a.status === 404 && /branch not protected/i.test(a.message);

type Review = VerdictFacts["reviews"][number];

/**
 * Each reviewer's latest submitted review, newest first, as
 * PrOverview.reviews takes it (pending ones left out; as of a cutoff,
 * those submitted by then), with the commit it was on.
 */
function latestReviews(
	nodes: unknown[],
	viewer: string,
	asOf: string | undefined,
): Review[] {
	const byReviewer = new Map<string, Review>();
	for (const raw of nodes) {
		const r = obj(raw);
		const who = obj(r.author);
		const name = str(who.login);
		const state = str(r.state);
		if (!name || !REVIEW_STATES.has(state)) continue;
		if (asOf && !atOrBefore(r.submittedAt, asOf)) continue;
		const at = str(r.submittedAt);
		const key = name.toLowerCase();
		const prev = byReviewer.get(key);
		if (!prev || prev.submittedAt <= at) {
			byReviewer.set(key, {
				author: name,
				state: state as ReviewVerdict,
				submittedAt: at,
				commitId: str(obj(r.commit).oid),
				you: slugify(name) === slugify(viewer),
				bot: isBotAuthor(who),
			});
		}
	}
	return [...byReviewer.values()].sort((a, b) =>
		b.submittedAt.localeCompare(a.submittedAt),
	);
}

/**
 * VerdictFacts from what fetchVerdict (or fetchVerdictAsOf) read and the
 * rule. GitHub's present-only facts (merge state, review decision, the
 * rule, which checks are required) are null as of a cutoff, and the first
 * three on a merged or closed PR too; never today's in their place.
 */
export function mapVerdict(input: {
	read: VerdictRead;
	rule: VerdictFacts["rule"];
	/** Whose reviews are "you" (the session's viewer). */
	viewer: string;
	asOf?: string;
	fetchedAt: string;
}): VerdictFacts {
	const { read, viewer, asOf } = input;
	const pr = obj(read.pr);
	const open = !asOf && read.pr !== null && pr.state === "OPEN";
	const merge = str(pr.mergeStateStatus);
	const decision = str(pr.reviewDecision);
	const checks = (asOf ? checksAsOf(read.checks, asOf) : read.checks)
		.flatMap((raw): VerdictFacts["checks"] => {
			const check = mapCheck(raw);
			if (!check) return [];
			const required = obj(raw).isRequired;
			return [
				{
					...check,
					required: !asOf && typeof required === "boolean" ? required : null,
				},
			];
		})
		.sort((a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status]);
	const codeOwnerRequests: VerdictFacts["codeOwnerRequests"] = [];
	// Who GitHub asks now: not known as of a cutoff.
	for (const raw of asOf ? [] : arr(obj(pr.reviewRequests).nodes)) {
		const request = obj(raw);
		if (request.asCodeOwner !== true) continue;
		const r = obj(request.requestedReviewer);
		if (r.__typename === "Team") {
			const name = str(r.name) || str(r.slug);
			if (name) codeOwnerRequests.push({ name, team: true });
		} else if (str(r.login)) {
			codeOwnerRequests.push({ name: str(r.login), team: false });
		}
	}
	return {
		mergeStateStatus:
			open && MERGE_STATES.includes(merge)
				? (merge as VerdictFacts["mergeStateStatus"])
				: null,
		reviewDecision:
			open && DECISIONS.includes(decision)
				? (decision as VerdictFacts["reviewDecision"])
				: null,
		checks,
		rule: open ? input.rule : null,
		codeOwnerRequests,
		reviews: latestReviews(read.reviews, viewer, asOf),
		head: read.head,
		fetchedAt: input.fetchedAt,
	};
}

/** A verdict this session sent (or a retry found), by its client id. */
export interface VerdictRecord {
	event: VerdictEvent;
	answer: VerdictAnswer;
}

/** What sending a verdict needs of the session (Session.submitVerdict). */
export interface VerdictTarget {
	ref: PrRef;
	/** The PR's URL on GitHub (a pending review's link). */
	prUrl: string;
	/** The gh login's slug: whose reviews these are. */
	viewer: string;
	writes: PrOverview["writes"];
	/** The snapshot's head: what `commit` must be. */
	head: string;
	sent: (clientId: string) => VerdictRecord | undefined;
	rememberSent: (clientId: string, record: VerdictRecord) => void;
	/** When this server first tried to post under `clientId` (ms, its clock). */
	firstAttempt: (clientId: string) => number | undefined;
	setFirstAttempt: (clientId: string, at: number) => void;
	/** Whether an attempt under `clientId` failed with its outcome unknown. */
	inDoubt: (clientId: string) => boolean;
	setInDoubt: (clientId: string, doubt: boolean) => void;
	/** Review ids remembered under other client ids. */
	claimedIds: (exceptClientId: string) => Set<string>;
	/** Sets the kept reads' pendingReview (a 409 turns it on, a post off). */
	setPendingReview: (pending: { url: string } | null) => void;
	/** A verdict landed: the next overview and verdict reads read GitHub again. */
	landed: () => void;
}

const EVENTS: readonly unknown[] = [
	"APPROVE",
	"COMMENT",
	"REQUEST_CHANGES",
] satisfies VerdictEvent[];

/** The review state GitHub records for each event. */
const STATE_OF: Record<VerdictEvent, ReviewVerdict> = {
	APPROVE: "APPROVED",
	COMMENT: "COMMENTED",
	REQUEST_CHANGES: "CHANGES_REQUESTED",
};

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Whether `body` is text to send: present and not blank. */
const hasText = (body: unknown): body is string =>
	typeof body === "string" && body.trim() !== "";

/** Why a verdict can't be sent as asked; null when it can. */
export function verdictProblem(req: unknown): string | null {
	const r = obj(req);
	if (typeof r.clientId !== "string" || !MARKER_ID.test(r.clientId)) {
		return "clientId must be 1 to 100 letters, digits or _.:-";
	}
	if (!EVENTS.includes(r.event)) {
		return "event must be APPROVE, COMMENT or REQUEST_CHANGES";
	}
	if (r.body !== undefined && typeof r.body !== "string") {
		return "body must be a string";
	}
	if (r.event !== "APPROVE" && !hasText(r.body)) {
		return r.event === "COMMENT"
			? "A comment needs a message"
			: "Requesting changes needs a message";
	}
	if (hasText(r.body)) {
		const room = MAX_REPLY - markerFor(r.clientId).length;
		if (r.body.length > room) return `A message is at most ${room} characters`;
	}
	if (typeof r.commit !== "string" || !OID.test(r.commit)) {
		return "commit must be a commit id";
	}
	if (
		typeof r.attemptedAt !== "string" ||
		Number.isNaN(Date.parse(r.attemptedAt))
	) {
		return "attemptedAt must be a time";
	}
	if (typeof r.retry !== "boolean") return "retry must be true or false";
	return null;
}

/** The body posted for `req`: as typed, with the marker; none without text. */
export function verdictBody(req: VerdictRequest): string | undefined {
	return hasText(req.body) ? req.body + markerFor(req.clientId) : undefined;
}

/**
 * How far GitHub's `submitted_at` (whole seconds, GitHub's clock) may read
 * before this server's first attempt and still be that attempt's.
 */
export const CLOCK_SLACK_MS = 10_000;
/** Without a first attempt of this server's: the client's `attemptedAt` less this. */
export const ATTEMPT_SLACK_MS = 2 * 60_000;

/**
 * The review in `reviews` that is `req` landed already: the viewer's,
 * in the event's state, not another client id's, and either carrying
 * `req`'s marker (a body was sent) or, with no body sent (nothing to
 * mark), empty and submitted no earlier than `since` (ms). The oldest
 * such one; null if none.
 */
export function findLanded(
	reviews: readonly RestReview[],
	req: Pick<VerdictRequest, "clientId" | "event" | "body">,
	viewer: string,
	since: number,
	claimed: ReadonlySet<string> = new Set(),
): RestReview | null {
	const marked = hasText(req.body);
	const matches = reviews.filter(
		(r) =>
			slugify(r.login) === slugify(viewer) &&
			r.state === STATE_OF[req.event] &&
			!claimed.has(r.nodeId) &&
			(marked
				? parseMarker(r.body)?.id === req.clientId
				: r.body.trim() === "" && Date.parse(r.submittedAt) >= since),
	);
	return (
		matches.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))[0] ??
		null
	);
}

const answerOf = (r: RestReview): VerdictAnswer => ({
	review: {
		id: r.nodeId,
		state: r.state as ReviewVerdict,
		submittedAt: r.submittedAt,
		commitId: r.commitId,
		body: stripMarker(r.body),
	},
});

/**
 * Sends the reviewer's verdict to GitHub, at once, as the gh login: one
 * submitted review (REST `pulls/{n}/reviews`, postReview) with the event,
 * `commit_id` the snapshot's head and the body (with carbonless's marker)
 * only when there is text. Never twice: a verdict this session sent under
 * `req.clientId` is answered as it is, and a retry (`req.retry`) first
 * lists the PR's reviews for it (findLanded), posting only if none is
 * there. Only a post is checked against the head ("stale" otherwise). A
 * pending review of the viewer's refuses it ("pending-review"). The
 * session runs these one at a time per PR (Session.submitVerdict).
 */
export async function submitVerdict(
	target: VerdictTarget,
	req: VerdictRequest,
): Promise<VerdictAnswer> {
	writesOff(target);
	const problem = verdictProblem(req);
	if (problem) throw new WriteRefusedError(problem, "invalid");
	const known = target.sent(req.clientId);
	if (known) {
		if (known.event !== req.event) {
			throw new WriteRefusedError(
				"This verdict was sent as another one",
				"invalid",
			);
		}
		return known.answer;
	}
	if (req.retry) {
		const found = await lookFor(target, req);
		if (found) {
			const answer = answerOf(found);
			target.rememberSent(req.clientId, { event: req.event, answer });
			target.setInDoubt(req.clientId, false);
			target.landed();
			return answer;
		}
	}
	if (req.commit !== target.head) {
		throw new WriteRefusedError(
			"The PR moved on since: refresh to give a verdict on its new head",
			"stale",
		);
	}
	if (target.firstAttempt(req.clientId) === undefined) {
		target.setFirstAttempt(req.clientId, Date.now());
	}
	const body = verdictBody(req);
	let posted: RestReview;
	try {
		posted = await postReview(
			target.ref,
			{ event: req.event, commit: req.commit, ...(body ? { body } : {}) },
			target.prUrl,
		);
	} catch (error) {
		if (
			error instanceof WriteRefusedError &&
			error.code === "pending-review" &&
			error.url
		) {
			target.setPendingReview({ url: error.url });
		}
		// It may have landed: its retry looks harder before posting again.
		if (!(error instanceof WriteRefusedError)) {
			target.setInDoubt(req.clientId, true);
		}
		throw error;
	}
	const answer = answerOf(posted);
	target.rememberSent(req.clientId, { event: req.event, answer });
	target.setInDoubt(req.clientId, false);
	// It posted: no pending review stands in the way (any more).
	target.setPendingReview(null);
	target.landed();
	return answer;
}

/**
 * `req` among the PR's reviews on GitHub (REST: no GraphQL lag), or
 * undefined. After an attempt whose outcome is unknown (gh killed
 * mid-call, GitHub may still make it), listed again after each of
 * LIST_WAITS_MS, as replies and new threads are.
 */
async function lookFor(
	target: VerdictTarget,
	req: VerdictRequest,
): Promise<RestReview | undefined> {
	const first = target.firstAttempt(req.clientId);
	const since =
		first === undefined
			? Date.parse(req.attemptedAt) - ATTEMPT_SLACK_MS
			: first - CLOCK_SLACK_MS;
	const waits = target.inDoubt(req.clientId) ? LIST_WAITS_MS : [];
	const claimed = target.claimedIds(req.clientId);
	for (let i = 0; ; i++) {
		const found = findLanded(
			await fetchReviews(target.ref),
			req,
			target.viewer,
			since,
			claimed,
		);
		if (found) return found;
		const wait = waits[i];
		if (wait === undefined) return undefined;
		await writeWaits.sleep(wait);
	}
}
