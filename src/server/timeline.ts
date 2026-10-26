import type {
	ReviewVerdict,
	TimelineActor,
	TimelineCommit,
	TimelineEvent,
	TimelineFact,
	TimelineReviewItem,
	TimelineView,
} from "../shared/types.js";
import { atOrBefore } from "./asOf.js";

/**
 * The PR's timeline from GitHub's timeline items (gh.ts fetchTimeline):
 * pure mapping and grouping into runs. Inputs are untrusted.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const oid = (v: unknown): string => (OID.test(str(v)) ? str(v) : "");

/** A review comment's line: on its own commit first, like the threads. */
function lineOf(c: Json): number | null {
	for (const v of [c.originalLine, c.line]) {
		if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
	}
	return null;
}

/** The first line of text, at most 200 characters. */
export function firstLine(text: unknown): string {
	const line =
		str(text)
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l) ?? "";
	return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

const isBotLogin = (login: string) =>
	login.endsWith("[bot]") || login.startsWith("app/");

/** A GitHub actor; a deleted account is GitHub's "ghost". */
function actorOf(raw: unknown): TimelineActor {
	const a = obj(raw);
	const login = str(a.login) || "ghost";
	return {
		login,
		avatarUrl: str(a.avatarUrl),
		bot: a.__typename === "Bot" || isBotLogin(login),
	};
}

/** A commit's author: its GitHub user, else the name in the commit. */
function commitActor(raw: unknown): TimelineActor {
	const author = obj(raw);
	const user = obj(author.user);
	const login = str(user.login) || str(author.name) || "unknown";
	return {
		login,
		avatarUrl: str(user.avatarUrl),
		bot: user.__typename === "Bot" || isBotLogin(login),
	};
}

const VERDICTS = new Set<string>([
	"APPROVED",
	"CHANGES_REQUESTED",
	"COMMENTED",
	"DISMISSED",
]);

/** One dated thing, before grouping. */
type Entry =
	| { run: "commits"; actor: TimelineActor; item: TimelineCommit }
	| { run: "review"; actor: TimelineActor; item: TimelineReviewItem }
	| { run: null; fact: TimelineFact };

const atOf = (e: Entry) => (e.run === null ? e.fact.at : e.item.at);
const actorOfEntry = (e: Entry) => (e.run === null ? e.fact.actor : e.actor);

export interface TimelineInput {
	/** GitHub's timeline items, in GitHub's order. */
	nodes: unknown[];
	/** The PR's commit count (`commits { totalCount }`); null if unknown. */
	commitCount: number | null;
	/** As-of mode: only what happened by then. */
	asOf?: string;
	/** A review comment's thread (ReviewThread.id) by the comment's id. */
	threadOf?: (commentId: string) => string | null;
}

/** Each timeline node as dated entries, in GitHub's order. */
function entries(input: TimelineInput, gaps: string[]): Entry[] {
	const out: Entry[] = [];
	let commits = 0;
	let unlisted = 0;
	const threadOf = input.threadOf ?? (() => null);
	for (const raw of input.nodes) {
		const n = obj(raw);
		switch (n.__typename) {
			case "PullRequestCommit": {
				const c = obj(n.commit);
				commits++;
				out.push({
					run: "commits",
					actor: commitActor(c.author),
					item: {
						kind: "commit",
						at: str(c.pushedDate) || str(c.committedDate),
						oid: oid(c.oid),
						headline: firstLine(c.messageHeadline),
						url: str(n.url),
					},
				});
				break;
			}
			case "PullRequestReview": {
				const state = str(n.state);
				// Not submitted (the viewer's pending review): nobody sees it yet.
				if (!VERDICTS.has(state) || !str(n.submittedAt)) break;
				const actor = actorOf(n.author);
				const text = firstLine(n.bodyText);
				// A plain reply is a COMMENTED review with no text: its comment alone.
				if (state !== "COMMENTED" || text) {
					out.push({
						run: "review",
						actor,
						item: {
							kind: "review",
							at: str(n.submittedAt),
							state: state as ReviewVerdict,
							text,
							url: str(n.url),
						},
					});
				}
				const comments = obj(n.comments);
				const nodes = arr(comments.nodes);
				if (
					typeof comments.totalCount === "number" &&
					comments.totalCount > nodes.length
				) {
					unlisted += comments.totalCount - nodes.length;
				}
				for (const rawComment of nodes) {
					const c = obj(rawComment);
					const id = str(c.id);
					const root = str(obj(c.replyTo).id);
					out.push({
						run: "review",
						actor,
						item: {
							kind: "comment",
							at: str(c.createdAt),
							path: str(c.path),
							line: lineOf(c),
							text: firstLine(c.bodyText),
							url: str(c.url),
							threadId:
								(id && threadOf(id)) || (root && threadOf(root)) || null,
						},
					});
				}
				break;
			}
			case "IssueComment":
				out.push({
					run: "review",
					actor: actorOf(n.author),
					item: {
						kind: "conversation",
						at: str(n.createdAt),
						text: firstLine(n.bodyText),
						url: str(n.url),
					},
				});
				break;
			case "HeadRefForcePushedEvent":
				out.push({
					run: null,
					fact: {
						kind: "force-push",
						actor: actorOf(n.actor),
						at: str(n.createdAt),
						before: oid(obj(n.beforeCommit).oid),
						after: oid(obj(n.afterCommit).oid),
					},
				});
				break;
			case "BaseRefChangedEvent":
				out.push({
					run: null,
					fact: {
						kind: "base-change",
						actor: actorOf(n.actor),
						at: str(n.createdAt),
						before: str(n.previousRefName),
						after: str(n.currentRefName),
					},
				});
				break;
			case "MergedEvent":
				out.push({
					run: null,
					fact: {
						kind: "merged",
						actor: actorOf(n.actor),
						at: str(n.createdAt),
						commit: oid(obj(n.commit).oid),
					},
				});
				break;
			case "ReadyForReviewEvent":
			case "ConvertToDraftEvent":
			case "ClosedEvent":
			case "ReopenedEvent":
				out.push({
					run: null,
					fact: {
						kind: FACT_KINDS[n.__typename],
						actor: actorOf(n.actor),
						at: str(n.createdAt),
					},
				});
				break;
		}
	}
	if (input.commitCount !== null && input.commitCount > commits) {
		gaps.push(`GitHub listed ${commits} of ${input.commitCount} commits`);
	}
	if (unlisted > 0) {
		gaps.push(
			`${unlisted} review comment${unlisted === 1 ? "" : "s"} past GitHub's first 100 of a review not listed`,
		);
	}
	return out;
}

const FACT_KINDS = {
	ReadyForReviewEvent: "ready",
	ConvertToDraftEvent: "draft",
	ClosedEvent: "closed",
	ReopenedEvent: "reopened",
} as const;

/**
 * The timeline: GitHub's items oldest first (by their own times; equal
 * times, and an item with no usable time, keep GitHub's order), as of the
 * cutoff if any, with consecutive commits by one author, and consecutive
 * review activity by one person, each made one run. Another person or
 * another kind starts a new run; a history fact stands alone and ends a
 * run.
 */
export function buildTimeline(input: TimelineInput): TimelineView {
	const gaps: string[] = [];
	const listed = entries(input, gaps);
	// A merge also closes the PR, at the same moment: GitHub shows the merge.
	const merges = new Set(
		listed.flatMap((e) =>
			e.run === null && e.fact.kind === "merged" ? [e.fact.at] : [],
		),
	);
	const all = listed.filter(
		(e) =>
			(!input.asOf || atOrBefore(atOf(e), input.asOf)) &&
			!(e.run === null && e.fact.kind === "closed" && merges.has(e.fact.at)),
	);
	// An undated entry stays after what GitHub listed before it.
	let carried = Number.NEGATIVE_INFINITY;
	const keyed = all.map((e, index) => {
		const ms = Date.parse(atOf(e));
		if (!Number.isNaN(ms)) carried = ms;
		return { e, index, ms: Number.isNaN(ms) ? carried : ms };
	});
	keyed.sort((a, b) => a.ms - b.ms || a.index - b.index);
	const events: TimelineEvent[] = [];
	for (const { e } of keyed) {
		if (e.run === null) {
			events.push(e.fact);
			continue;
		}
		const last = events.at(-1);
		const same =
			last?.kind === e.run &&
			last.actor.login.toLowerCase() === actorOfEntry(e).login.toLowerCase() &&
			last.actor.bot === actorOfEntry(e).bot;
		if (same && last.kind === "commits" && e.run === "commits") {
			last.items.push(e.item);
			last.to = e.item.at;
		} else if (same && last.kind === "review" && e.run === "review") {
			last.items.push(e.item);
			last.to = e.item.at;
		} else if (e.run === "commits") {
			events.push({
				kind: "commits",
				actor: e.actor,
				from: e.item.at,
				to: e.item.at,
				items: [e.item],
			});
		} else {
			events.push({
				kind: "review",
				actor: e.actor,
				from: e.item.at,
				to: e.item.at,
				items: [e.item],
			});
		}
	}
	return { events, gaps };
}
