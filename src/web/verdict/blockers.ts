import type {
	PrOverview,
	ReviewThread,
	VerdictFacts,
} from "../../shared/types";
import { threadLabel } from "../files/RefusedWrites";

/**
 * One row of the Final Verdict tab's blocker list (owner: "There should be
 * 1 list of blockers, but it should be clear which are mandatory by github
 * and which aren't"). Its kind picks the icon; its tone the color:
 * - `bad`: GitHub requires it and it's unmet (red);
 * - `warn`: still running, or not required (yellow, never red);
 * - `unknown`: carbonless can't tell (grey);
 * - `ok`: what's fine, folded into one muted row, or "Ready to merge".
 */
export interface BlockerRow {
	id: string;
	kind: "check" | "thread" | "person" | "branch" | "more" | "summary" | "ready";
	tone: "bad" | "warn" | "unknown" | "ok";
	/** Tagged "Required by GitHub": GitHub won't merge without it. */
	required: boolean;
	text: string;
	/** Second line, muted: a thread's file:line, a code owner. */
	detail?: string;
	/** A thread's opener. */
	who?: string;
	/** When it happened (a review, a thread). */
	at?: string;
	/** Where to deal with it on GitHub (a check's run, the PR). */
	href?: string;
	/** The thread on the Overview. */
	threadId?: string;
	/** `more`: the rows folded under "N more". */
	more?: BlockerRow[];
}

/** Unresolved threads listed one by one before the rest fold under "N more". */
export const THREADS_SHOWN = 5;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Whether a GitHub login is the session's viewer, which is a slug
 * (`SessionInfo.viewer`: lowercase, other characters as "-", as the server's
 * slugify): "Octo_Cat" is "octo-cat".
 */
export const isViewer = (login: string, viewer: string) =>
	login
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.slice(0, 64) === viewer.toLowerCase();

/**
 * Everything between the PR and merging, as one list: GitHub's own
 * requirements first (tagged, red while unmet), then what a careful
 * reviewer would want settled (yellow), then one muted green row for
 * what's fine. Nothing unmet and GitHub saying CLEAN/HAS_HOOKS: one green
 * "Ready to merge" row; an empty list alone never says ready (the rule may
 * be unreadable). Merged or closed: nothing.
 */
export function blockers(
	facts: VerdictFacts,
	overview: PrOverview,
	threads: readonly ReviewThread[] | undefined,
	viewer: string,
): BlockerRow[] {
	if (overview.state !== "OPEN") return [];
	const pr = overview.url;
	const base = overview.baseBranch;
	const required: BlockerRow[] = [];
	const rest: BlockerRow[] = [];

	// Checks: required first (failing, then running), then the others.
	const failing = facts.checks.filter((c) => c.status === "failing");
	const running = facts.checks.filter((c) => c.status === "pending");
	const checkRow = (
		c: VerdictFacts["checks"][number],
		tone: BlockerRow["tone"],
		req: boolean,
	): BlockerRow => ({
		id: `check:${c.status}:${c.name}`,
		kind: "check",
		tone,
		required: req,
		text: `${c.name} ${c.status === "failing" ? "failing" : "running"}`,
		...(c.url ? { href: c.url } : {}),
	});
	for (const c of failing.filter((c) => c.required === true)) {
		required.push(checkRow(c, "bad", true));
	}
	for (const c of running.filter((c) => c.required === true)) {
		required.push(checkRow(c, "warn", true));
	}

	// Approvals: GitHub's decision is the source of truth; the detail rows explain it.
	const approved = facts.reviews.filter((r) => r.state === "APPROVED");
	const owners = facts.codeOwnerRequests;
	const ownerName = (o: { name: string }) => `@${o.name.replace(/^@/, "")}`;
	const ownersRequired = facts.rule?.codeOwners === true;
	let ownersShown = false;
	if (facts.reviewDecision === "REVIEW_REQUIRED") {
		const need = facts.rule?.approvals;
		const unknownRule = facts.rule === null;
		const detail =
			unknownRule && owners.length > 0
				? owners.map((o) => `${ownerName(o)} · code owner`).join(", ")
				: undefined;
		if (detail) ownersShown = true;
		required.push({
			id: "review-required",
			kind: "person",
			tone: "bad",
			required: true,
			text:
				typeof need === "number" && need > 0
					? `${Math.min(approved.length, need)} of ${need} approvals`
					: "Review required",
			...(detail ? { detail } : {}),
			href: pr,
		});
	}
	if (facts.reviewDecision === "CHANGES_REQUESTED") {
		const names = facts.reviews
			.filter((r) => r.state === "CHANGES_REQUESTED")
			.map((r) => (r.you ? "you" : r.author));
		const latest = facts.reviews.find((r) => r.state === "CHANGES_REQUESTED");
		required.push({
			id: "changes-requested",
			kind: "person",
			tone: "bad",
			required: true,
			text: names.length
				? `Changes requested by ${names.join(", ")}`
				: "Changes requested",
			...(latest ? { at: latest.submittedAt } : {}),
			href: pr,
		});
	}
	if (ownersRequired) {
		ownersShown = true;
		for (const o of owners) {
			required.push({
				id: `owner:${o.name}`,
				kind: "person",
				tone: "bad",
				required: true,
				text: `${ownerName(o)} · code owner`,
				href: pr,
			});
		}
	}

	// Branch: GitHub's merge state.
	const state = facts.mergeStateStatus;
	const branch = (id: string, text: string) =>
		required.push({
			id,
			kind: "branch",
			tone: "bad",
			required: true,
			text,
			href: pr,
		});
	if (state === "DIRTY") branch("conflicts", `Conflicts with ${base}`);
	if (state === "BEHIND") branch("behind", `Branch is behind ${base}`);
	if (state === "DRAFT") branch("draft", "Draft");
	// Blocked, and nothing above says why: say so rather than leave it out.
	if (state === "BLOCKED" && required.length === 0) {
		branch("blocked", "Blocked by a branch rule");
	}

	// The rest: never red.
	for (const c of failing.filter((c) => c.required !== true)) {
		rest.push(checkRow(c, "warn", false));
	}
	for (const c of running.filter((c) => c.required !== true)) {
		rest.push(checkRow(c, "warn", false));
	}
	const open = (threads ?? []).filter(
		(t) => !t.resolved && t.unavailable === undefined && t.id !== "",
	);
	const human = open.filter((t) => !t.bot);
	const mine = human.filter((t) => isViewer(t.author, viewer));
	const theirs = human.filter((t) => !isViewer(t.author, viewer));
	const threadRows = [...mine, ...theirs].map(
		(t): BlockerRow => ({
			id: `thread:${t.id}`,
			kind: "thread",
			tone: "warn",
			required: false,
			text: t.excerpt,
			detail: threadLabel(t),
			who: isViewer(t.author, viewer) ? "you" : t.author,
			at: t.lastActivityAt,
			threadId: t.id,
		}),
	);
	rest.push(...threadRows.slice(0, THREADS_SHOWN));
	const folded = threadRows.slice(THREADS_SHOWN);
	if (folded.length > 0) {
		rest.push({
			id: "threads:more",
			kind: "more",
			tone: "warn",
			required: false,
			text: `${folded.length} more`,
			more: folded,
		});
	}
	const bots = open.filter((t) => t.bot).length;
	if (bots > 0) {
		rest.push({
			id: "threads:bots",
			kind: "thread",
			tone: "warn",
			required: false,
			text: `${bots} unresolved bot ${bots === 1 ? "thread" : "threads"}`,
		});
	}
	if (!ownersShown) {
		for (const o of owners) {
			rest.push({
				id: `owner:${o.name}`,
				kind: "person",
				tone: "warn",
				required: false,
				text: `${ownerName(o)} · code owner`,
				href: pr,
			});
		}
	}
	// Not one already named above (a code owner, a reviewer asking for changes).
	const answered = new Set(facts.reviews.map((r) => r.author.toLowerCase()));
	const blocking = new Set(
		facts.reviewDecision === "CHANGES_REQUESTED"
			? facts.reviews
					.filter((r) => r.state === "CHANGES_REQUESTED")
					.map((r) => r.author.toLowerCase())
			: [],
	);
	for (const r of overview.requestedReviewers) {
		if (owners.some((o) => same(o.name, r.name))) continue;
		if (blocking.has(r.name.toLowerCase())) continue;
		if (!r.team && answered.has(r.name.toLowerCase())) continue;
		rest.push({
			id: `requested:${r.name}`,
			kind: "person",
			tone: "warn",
			required: false,
			text: `Waiting on ${r.team ? ownerName(r) : r.name}`,
			href: pr,
		});
	}
	// GitHub doesn't say what the repo requires: unknown, never "none".
	if (facts.rule === null && facts.reviewDecision === null) {
		rest.push({
			id: "approvals:unknown",
			kind: "person",
			tone: "unknown",
			required: false,
			text: "Required approvals unknown",
		});
	}

	const unmet = [...required, ...rest].filter((r) => r.tone !== "unknown");
	const out: BlockerRow[] = [...required, ...rest];
	const fine: string[] = [];
	const passing = facts.checks.filter((c) => c.status === "passing").length;
	if (passing > 0) {
		fine.push(`${passing} ${passing === 1 ? "check" : "checks"} passing`);
	}
	if (approved.length > 0) {
		fine.push(
			`${approved.map((r) => (r.you ? "you" : r.author)).join(", ")} approved`,
		);
	}
	if (overview.mergeable === "MERGEABLE" && state !== "DIRTY") {
		fine.push("no conflicts");
	}
	if (unmet.length === 0 && (state === "CLEAN" || state === "HAS_HOOKS")) {
		out.push({
			id: "ready",
			kind: "ready",
			tone: "ok",
			required: false,
			text: "Ready to merge",
			...(fine.length ? { detail: fine.join(" · ") } : {}),
			href: pr,
		});
	} else if (fine.length > 0) {
		out.push({
			id: "summary",
			kind: "summary",
			tone: "ok",
			required: false,
			text: fine.join(" · "),
		});
	}
	return out;
}

/** How many rows stand in the way (folded ones counted; summary, ready and unknown not). */
export function blockerCount(rows: readonly BlockerRow[]): number {
	let n = 0;
	for (const r of rows) {
		if (r.kind === "more") n += r.more?.length ?? 0;
		else if (r.tone === "bad" || r.tone === "warn") n++;
	}
	return n;
}

export type GithubStatus =
	| { tone: "ok"; text: "GitHub: ready to merge" }
	| { tone: "bad"; text: "GitHub: blocked" }
	| { tone: "warn"; text: "GitHub: waiting" }
	| { tone: "unknown"; text: "GitHub: checking…" | "GitHub: unknown" }
	| { tone: "asof"; text: "As of"; asOf: string }
	| { tone: "done"; text: "Merged" | "Closed" };

/**
 * GitHub's own verdict on merging, from its merge state: ready, blocked,
 * waiting (only required checks still running), checking (UNKNOWN). As of
 * a cutoff: "As of <date>" (today's merge state isn't shown as then's).
 */
export function githubStatus(
	facts: Pick<VerdictFacts, "mergeStateStatus" | "checks" | "reviewDecision">,
	overview: Pick<PrOverview, "state" | "asOf">,
): GithubStatus {
	if (overview.state === "MERGED") return { tone: "done", text: "Merged" };
	if (overview.state === "CLOSED") return { tone: "done", text: "Closed" };
	if (overview.asOf)
		return { tone: "asof", text: "As of", asOf: overview.asOf };
	const requiredFailing = facts.checks.some(
		(c) => c.required === true && c.status === "failing",
	);
	const requiredRunning = facts.checks.some(
		(c) => c.required === true && c.status === "pending",
	);
	const reviewsBlock =
		facts.reviewDecision === "REVIEW_REQUIRED" ||
		facts.reviewDecision === "CHANGES_REQUESTED";
	const ready = { tone: "ok", text: "GitHub: ready to merge" } as const;
	const blocked = { tone: "bad", text: "GitHub: blocked" } as const;
	const waiting = { tone: "warn", text: "GitHub: waiting" } as const;
	switch (facts.mergeStateStatus) {
		case "CLEAN":
		case "HAS_HOOKS":
			return ready;
		case "BLOCKED":
			return requiredRunning && !requiredFailing && !reviewsBlock
				? waiting
				: blocked;
		case "DIRTY":
		case "BEHIND":
		case "DRAFT":
			return blocked;
		case "UNSTABLE":
			if (requiredFailing) return blocked;
			return requiredRunning ? waiting : ready;
		case "UNKNOWN":
			return { tone: "unknown", text: "GitHub: checking…" };
		default:
			return { tone: "unknown", text: "GitHub: unknown" };
	}
}
