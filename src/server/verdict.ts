import {
	MAX_REPLY,
	type PrOverview,
	type RereviewAnswer,
	type ReviewVerdict,
	type VerdictAnswer,
	type VerdictEvent,
	type VerdictFacts,
	type VerdictRequest,
	type VerdictSince,
} from "../shared/types.js";
import { atOrBefore } from "./asOf.js";
import { WriteRefusedError } from "./errors.js";
import {
	dismissReview,
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
 * Each reviewer's verdict, newest first: their latest opinionated review
 * (approved, changes requested or dismissed, as GitHub's
 * latestOpinionatedReviews and PrOverview's `opinion`), else their latest
 * comment; pending ones left out, as of a cutoff those submitted by then;
 * with the commit it was on. A reply after an approval (a COMMENTED
 * review) leaves the approval standing; a comment after a dismissed
 * review reads as that comment (Comment withdrew the opinion: GitHub
 * dismissed it, and lists no opinion of theirs any more).
 */
function latestReviews(
	nodes: unknown[],
	viewer: string,
	asOf: string | undefined,
): { reviews: Review[]; yours: Review | null } {
	/** Each reviewer's latest opinionated review, and latest of any kind. */
	const opinionated = new Map<string, Review>();
	const any = new Map<string, Review>();
	/** The viewer's latest verdict-like review: an opinion, or a Comment with a message. */
	let verdictLike: Review | undefined;
	const later = (map: Map<string, Review>, key: string, review: Review) => {
		const prev = map.get(key);
		if (!prev || prev.submittedAt <= review.submittedAt) map.set(key, review);
	};
	for (const raw of nodes) {
		const r = obj(raw);
		const who = obj(r.author);
		const name = str(who.login);
		const state = str(r.state);
		if (!name || !REVIEW_STATES.has(state)) continue;
		if (asOf && !atOrBefore(r.submittedAt, asOf)) continue;
		const key = name.toLowerCase();
		const url = str(r.url);
		const review: Review = {
			author: name,
			state: state as ReviewVerdict,
			submittedAt: str(r.submittedAt),
			commitId: str(obj(r.commit).oid),
			...(url ? { url } : {}),
			you: slugify(name) === slugify(viewer),
			bot: isBotAuthor(who),
		};
		later(any, key, review);
		if (state !== "COMMENTED") later(opinionated, key, review);
		if (
			review.you &&
			(state !== "COMMENTED" || str(r.body).trim() !== "") &&
			(!verdictLike || verdictLike.submittedAt <= review.submittedAt)
		) {
			verdictLike = review;
		}
	}
	const reviews = [...any.keys()]
		.map((key) => standingOf(opinionated.get(key), any.get(key) as Review))
		.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
	const mine = reviews.find((r) => r.you);
	const opinion = mine ? opinionated.get(mine.author.toLowerCase()) : undefined;
	return {
		reviews,
		yours: verdictLike ? standingOf(opinion, verdictLike) : null,
	};
}

/**
 * A reviewer's verdict from their latest opinionated review and their
 * latest of any kind: the opinion, unless it was dismissed and they
 * commented after it (then the comment).
 */
export function standingOf<T extends { state: string; submittedAt: string }>(
	opinion: T | undefined,
	latest: T,
): T {
	if (!opinion) return latest;
	if (
		opinion.state === "DISMISSED" &&
		latest.state === "COMMENTED" &&
		// The same second too: GitHub's times are whole seconds.
		latest.submittedAt >= opinion.submittedAt
	) {
		return latest;
	}
	return opinion;
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
	const latest = latestReviews(read.reviews, viewer, asOf);
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
		reviews: latest.reviews,
		yourVerdict: latest.yours,
		head: read.head,
		fetchedAt: input.fetchedAt,
		// Worked out when served (Session.verdict, sinceTarget), never kept.
		since: null,
	};
}

/** What VerdictFacts.since compares: the verdict, its patch set, the head a verdict goes on now. */
export type SinceTarget = Omit<VerdictSince, "changes">;

/**
 * The reviewer's own verdict (VerdictFacts.yourVerdict), the
 * patch set it was given on (among those whose head is the verdict's
 * commit, the latest started by the verdict's time: a retarget keeps the
 * head and starts another; the earliest when none was, a clock apart),
 * and where a verdict goes now: the PR's head when it is past
 * the latest patch set's (`head`, as the head check last found it; null
 * when none is shown: pinned, as-of, merged or closed), else the latest
 * patch set's head. Null when there is no verdict, its commit is none of
 * the reviewer's patch sets' heads (given elsewhere, before any patch
 * set), or it is on the head a verdict goes on now (nothing since).
 */
export function sinceTarget(input: {
	verdict: VerdictFacts["yourVerdict"];
	patchsets: readonly { number: number; head: string; startedAt: number }[];
	head: string | null;
}): SinceTarget | null {
	const mine = input.verdict;
	if (!mine || mine.commitId === "") return null;
	const byNumber = [...input.patchsets].sort((a, b) => b.number - a.number);
	const onIt = byNumber.filter((p) => p.head === mine.commitId);
	// GitHub's times are whole seconds; the patch set starts before the post.
	const at = Date.parse(mine.submittedAt) + 1000;
	const given = onIt.find((p) => p.startedAt <= at) ?? onIt.at(-1);
	const latest = byNumber[0];
	if (!given || !latest) return null;
	const to =
		input.head && input.head !== latest.head
			? {
					head: input.head,
					// A head moved back onto an earlier patch set's: that one.
					patchset: byNumber.find((p) => p.head === input.head)?.number ?? null,
				}
			: { head: latest.head, patchset: latest.number };
	if (to.head === mine.commitId) return null;
	return {
		state: mine.state,
		head: mine.commitId,
		at: mine.submittedAt,
		...(mine.url ? { url: mine.url } : {}),
		patchset: given.number,
		to,
	};
}

/**
 * VerdictFacts.since from its target and the engine's answer from the
 * verdict's patch set to `to` (Session.rereview): pending while it is
 * computed, failed with the error's message, else the counts, every one
 * from the answer (the clusters' kinds, its files to read, its shape).
 */
export function sinceOf(
	target: SinceTarget,
	answer: RereviewAnswer | { pending: true } | { error: string },
): VerdictSince {
	if ("pending" in answer) return { ...target, changes: { status: "pending" } };
	if ("error" in answer) {
		return {
			...target,
			changes: { status: "failed", message: answer.error },
		};
	}
	const count = { reworked: 0, new: 0, gone: 0 };
	for (const file of answer.files) {
		for (const c of file.clusters) {
			if (c.kind !== "carried") count[c.kind] += 1;
		}
	}
	return {
		...target,
		changes: {
			status: "done",
			shape: answer.shape.code,
			commits: answer.shape.commits,
			files: answer.toRead.files,
			...count,
			identical: answer.shape.identical,
		},
	};
}

/** A verdict this session sent (or a retry found), by its client id. */
export interface VerdictRecord {
	event: VerdictEvent;
	answer: VerdictAnswer;
	/**
	 * Done: false only for a comment on GitHub whose withdrawal of the
	 * standing opinion (withdraw) hasn't finished; a resend finishes it.
	 */
	settled: boolean;
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
	/**
	 * Run once a post is cleared, before it goes to GitHub: a verdict is a
	 * lasting action on the snapshot, so the session starts the patch set
	 * when the snapshot is none yet (and refuses an earlier one, 409 stale).
	 */
	startPatchset?: () => Promise<void>;
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
 * mark), empty, on `req`'s commit and submitted no earlier than `since` (ms). The oldest
 * such one; null if none.
 */
export function findLanded(
	reviews: readonly RestReview[],
	req: Pick<VerdictRequest, "clientId" | "event" | "body" | "commit">,
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
				: r.body.trim() === "" &&
					r.commitId === req.commit &&
					Date.parse(r.submittedAt) >= since),
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
		...(r.url ? { url: r.url } : {}),
	},
});

type Opinion = "APPROVED" | "CHANGES_REQUESTED";

/**
 * The viewer's opinion that their comment `commentId` (submitted at
 * `commentAt`) withdraws: their latest opinionated review (approved,
 * changes requested or dismissed; pending ones aside), if it is an
 * approval or a change request from before the comment. Null when there
 * is none, it is dismissed already, or it came after the comment (a newer
 * verdict a resend must not undo). Never anyone else's.
 */
export function standingOpinion(
	reviews: readonly RestReview[],
	viewer: string,
	commentId: string,
	commentAt: string,
): (RestReview & { state: Opinion }) | null {
	const mine = reviews.filter((r) => slugify(r.login) === slugify(viewer));
	const at = mine.findIndex((r) => r.nodeId === commentId);
	const opinions = mine.filter((r) =>
		["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state),
	);
	const latest = opinions.at(-1);
	if (!latest) return null;
	// REST lists reviews oldest first; without the comment listed, by time.
	const after =
		at >= 0
			? mine.indexOf(latest) > at
			: Date.parse(latest.submittedAt) > Date.parse(commentAt);
	if (after) return null;
	if (latest.state !== "APPROVED" && latest.state !== "CHANGES_REQUESTED") {
		return null;
	}
	return latest as RestReview & { state: Opinion };
}

/**
 * Comment withdraws the viewer's standing opinion (owner's tooltip: "No
 * approval, but approval by someone else acceptable"): once the comment
 * is on GitHub, the opinion it leaves behind (standingOpinion, from a
 * fresh REST read) is dismissed. A dismissal GitHub refuses or fails
 * leaves the comment posted: the answer says the opinion still stands.
 * A failed read throws (GhError): the record stays unsettled, so the
 * resend finishes it without posting again.
 */
async function withdraw(
	target: VerdictTarget,
	comment: VerdictAnswer,
): Promise<VerdictAnswer> {
	const standing = standingOpinion(
		await fetchReviews(target.ref),
		target.viewer,
		comment.review.id,
		comment.review.submittedAt,
	);
	if (!standing) return comment;
	try {
		if (!standing.restId) throw new Error("GitHub gave no id for the review");
		await dismissReview(target.ref, standing.restId);
		return { ...comment, dismissed: standing.state };
	} catch (error) {
		return {
			...comment,
			stillStands: {
				state: standing.state,
				message:
					error instanceof Error && error.message
						? error.message
						: "GitHub didn't dismiss it",
			},
		};
	}
}

/**
 * Sends the reviewer's verdict to GitHub, at once, as the gh login: one
 * submitted review (REST `pulls/{n}/reviews`, postReview) with the event,
 * `commit_id` the snapshot's head and the body (with carbonless's marker)
 * only when there is text. Never twice: a verdict this session sent under
 * `req.clientId` is answered as it is, and a retry (`req.retry`) first
 * lists the PR's reviews for it (findLanded), posting only if none is
 * there. Only a post is checked against the head ("stale" otherwise). A
 * pending review of the viewer's refuses it ("pending-review"). A comment
 * then withdraws the viewer's standing approval or change request
 * (withdraw), on a resend too until that is done. The session runs these
 * one at a time per PR (Session.submitVerdict).
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
		if (known.settled) return known.answer;
		return settle(target, req, known.answer);
	}
	if (req.retry) {
		const found = await lookFor(target, req);
		if (found) {
			target.setInDoubt(req.clientId, false);
			return settle(target, req, answerOf(found));
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
	// The patch set first, in its own transaction: the verdict then lands
	// on a started snapshot.
	await target.startPatchset?.();
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
	target.setInDoubt(req.clientId, false);
	// It posted: no pending review stands in the way (any more).
	target.setPendingReview(null);
	return settle(target, req, answerOf(posted));
}

/**
 * The review `answer` is on GitHub: remembered at once (a resend never
 * posts it again), then, for a comment, the standing opinion withdrawn,
 * and remembered as done.
 */
async function settle(
	target: VerdictTarget,
	req: VerdictRequest,
	answer: VerdictAnswer,
): Promise<VerdictAnswer> {
	const comment = req.event === "COMMENT";
	target.rememberSent(req.clientId, {
		event: req.event,
		answer,
		settled: !comment,
	});
	target.landed();
	if (!comment) return answer;
	const done = await withdraw(target, answer);
	target.rememberSent(req.clientId, {
		event: req.event,
		answer: done,
		settled: true,
	});
	target.landed();
	return done;
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
