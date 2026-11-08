import { monotonicFactory } from "ulid";
import { type LineRanges, parseRanges } from "../../shared/lineRanges.js";
import type {
	ClusterState,
	DiffSide,
	ShapeCode,
	ThreadAnchorRef,
} from "../../shared/types.js";

export type { ShapeCode, ThreadAnchorRef };

/**
 * crb events, stored one JSON object per line in crb commit messages.
 * See docs/review-data-storage.md ("Commit format", "Events").
 */

/** Who wrote an event: the reviewer, an AI, or the deterministic engine. */
export type By = "human" | "ai" | "auto";

export interface EventBase {
	v: 1;
	/** Lowercase ULID. */
	id: string;
	/** Milliseconds since epoch. */
	ts: number;
	by: By;
	/** Reviewer slug. */
	actor: string;
	/** Informational only: never affects folding or coverage. */
	details?: Record<string, unknown>;
}

export interface ReviewCreatedEvent extends EventBase {
	type: "review-created";
	source: "github-pr";
	key: string;
	pr: {
		owner: string;
		repo: string;
		number: number;
		url: string;
		baseBranch: string;
		headBranch: string;
		headRepo: string;
	};
}

export interface PatchsetStartedEvent extends EventBase {
	type: "patchset-started";
	patchset: number;
	/** The snapshot id. */
	revision: string;
	mergeBase: string;
	head: string;
	/** The patch set this one follows (its carries' source); none for PS1. */
	since?: number;
	shape?: ShapeCode;
	/** GitHub's base branch name when it started. */
	baseBranch?: string;
	interdiff?: "available" | "unavailable";
}

export interface ClusterStateEvent extends EventBase {
	type: "cluster-state";
	/** The patch set's revision ID. */
	patchset: string;
	/** Cluster identity hash. */
	cluster: string;
	path: string;
	state: ClusterState;
	reason?: string;
}

/**
 * The reviewer marked part of a cluster: `lines` of it (lineRanges.ts: its
 * removed lines, then its added ones) reviewed or crossed off, one piece
 * of it in the since view. A new type, not a `cluster-state` field, so a
 * reader that predates it skips it and sees the cluster unreviewed (GitDB
 * 8: fails closed). The writer always puts a `cluster-state` unreviewed
 * for the whole cluster first, then these, in one commit: the cluster's
 * marks, whole. Only `by: "human"`. See docs/review-data-storage.md.
 */
export interface LinesStateEvent extends EventBase {
	type: "lines-state";
	/** The patch set's snapshot id. */
	patchset: string;
	cluster: string;
	path: string;
	state: "reviewed" | "crossed-off";
	/** Normalized, non-empty. */
	lines: LineRanges;
}

/**
 * The reviewer's marks on the since view's pieces that own no line of the
 * patch set's snapshot (lines gone or reverted since patch set `since`),
 * in file `path`: every such line marked, by number on the since view's
 * sides (`old`: the compared head, or its rebase on the new base; `new`:
 * this head). The whole set for (since, path): the last one wins. They
 * never change a cluster's state, never carry. Only `by: "human"`.
 */
export interface SinceLinesStateEvent extends EventBase {
	type: "since-lines-state";
	patchset: string;
	since: number;
	path: string;
	reviewed: { old: LineRanges; new: LineRanges };
	crossed: { old: LineRanges; new: LineRanges };
}

/** One cluster state carried from one patch set to the next. */
export interface CarriedEntry {
	/** The cluster in the `to` patch set. */
	key: string;
	/**
	 * The cluster in the `from` patch set it was carried from. Written only
	 * when it differs from `key` (the exact rule's usual case has them equal,
	 * and a key is 64 hex characters); a read entry always has it, parse
	 * fills in `key`.
	 */
	fromKey?: string;
	state: "reviewed" | "crossed-off";
}

/**
 * The engine's carry of human states from patch set `from` to patch set
 * `to` under one rule: one event per rule per start, never per cluster.
 * Only `by: "auto"`. The fold trusts an entry only when its source state
 * folds to a human state equal to it (fold.ts).
 */
export interface CarriedEvent extends EventBase {
	type: "carried";
	from: number;
	to: number;
	rule: "exact" | "rename";
	states: CarriedEntry[];
}

/**
 * A thread placed in a patch set by the reviewer (or an AI), overriding the
 * engine's own placement. `engine` is the tracer's version at the time.
 */
export interface ThreadPlacedEvent extends EventBase {
	type: "thread-placed";
	/** The thread's id (ReviewThread.id). */
	thread: string;
	/** The patch set number. */
	patchset: number;
	anchor: ThreadAnchorRef;
	engine: number;
}

/** Parsed and validated only; not written in this milestone. */
export interface ReviewClosedEvent extends EventBase {
	type: "review-closed";
	outcome: "merged" | "closed";
	mergeCommit?: string;
}

/**
 * Inbox events (`refs/crb/inbox/<reviewer>`, one ref per reviewer per repo):
 * the reviewer's own annotations of a PR on Home. Only a human writes them.
 * See docs/review-data-storage.md ("Inbox ref").
 */
export interface PrSnoozedEvent extends EventBase {
	type: "pr-snoozed";
	/** PR number. */
	pr: number;
	/** Ms since epoch. */
	until: number;
	/** Activity on the PR after the snooze (its `updatedAt`) wakes it too. */
	wakeOnActivity: boolean;
}

export interface PrWaitingOnEvent extends EventBase {
	type: "pr-waiting-on";
	pr: number;
	/** A GitHub login; the reviewer's own means "me". */
	who: string;
}

export interface PrNoteEvent extends EventBase {
	type: "pr-note";
	pr: number;
	/** Empty clears the note. */
	text: string;
}

export interface PrClearedEvent extends EventBase {
	type: "pr-cleared";
	pr: number;
	kind: "snooze" | "waiting";
}

export type InboxEvent =
	| PrSnoozedEvent
	| PrWaitingOnEvent
	| PrNoteEvent
	| PrClearedEvent;

export type CrbEvent =
	| ReviewCreatedEvent
	| PatchsetStartedEvent
	| ClusterStateEvent
	| LinesStateEvent
	| SinceLinesStateEvent
	| CarriedEvent
	| ThreadPlacedEvent
	| ReviewClosedEvent
	| InboxEvent;

export type CrbEventType = CrbEvent["type"];
export type EventOf<T extends CrbEventType> = Extract<CrbEvent, { type: T }>;
export type EventPayload<T extends CrbEventType> = Omit<
	EventOf<T>,
	keyof EventBase | "type"
> & { details?: Record<string, unknown> };

const SLUG = /^[a-z0-9-]{1,64}$/;
/** A GitHub login. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** The latest moment a JS Date holds (ms): later `until`s are skipped on read. */
const MAX_DATE_MS = 8.64e15;
/** Longest note a reader keeps (the API's write limit is lower). */
export const MAX_NOTE_READ = 2000;
const INBOX_TYPES: readonly string[] = [
	"pr-snoozed",
	"pr-waiting-on",
	"pr-note",
	"pr-cleared",
] satisfies InboxEvent["type"][];
const LOWER_ULID = /^[0-9a-hjkmnp-tv-z]{26}$/;
const CLUSTER_STATES: readonly string[] = [
	"unreviewed",
	"reviewed",
	"crossed-off",
] satisfies ClusterState[];
const CARRIED_STATES: readonly string[] = [
	"reviewed",
	"crossed-off",
] satisfies CarriedEntry["state"][];
const SHAPES: readonly string[] = [
	"S1",
	"S3",
	"S4a",
	"S4b",
	"S4c",
	"S5",
	"S6",
	"S7",
] satisfies ShapeCode[];
/** A cluster key: sha256 hex, repeats suffixed `:2`, `:3`… (diff/identity.ts). */
const CLUSTER_KEY = /^[0-9a-f]{64}(?::[1-9][0-9]*)?$/;

export function isSlug(value: string): boolean {
	return SLUG.test(value);
}

const nextUlid = monotonicFactory();

export function newEvent<T extends CrbEventType>(
	type: T,
	actor: string,
	payload: EventPayload<T>,
	by: By = "human",
	/** Milliseconds since epoch; defaults to now. */
	ts: number = Date.now(),
): EventOf<T> {
	return {
		v: 1,
		id: nextUlid(ts).toLowerCase(),
		type,
		ts,
		by,
		actor,
		...payload,
	} as unknown as EventOf<T>;
}

/** Throws unless the event follows the write rules and readers would keep it. */
export function validateForWrite(e: CrbEvent): void {
	if (e.type === "cluster-state" && e.by !== "human") {
		throw new Error("cluster-state events must be written by a human");
	}
	if (
		(e.type === "lines-state" || e.type === "since-lines-state") &&
		e.by !== "human"
	) {
		throw new Error(`${e.type} events must be written by a human`);
	}
	if (INBOX_TYPES.includes(e.type) && e.by !== "human") {
		throw new Error(`${e.type} events must be written by a human`);
	}
	if (e.type === "carried" && e.by !== "auto") {
		throw new Error("carried events must be written by auto (the engine)");
	}
	if (e.type === "thread-placed" && e.by === "auto") {
		throw new Error("thread-placed events must be written by a human or ai");
	}
	if (parseEvent(JSON.parse(JSON.stringify(e))) === null) {
		throw new Error(`Refusing to write an invalid ${e.type} event`);
	}
}

/** One summary line, a blank line, then one JSON event per line. */
export function serializeCommitMessage(
	summary: string,
	events: CrbEvent[],
): string {
	const line = summary.replace(/\s*[\r\n]+\s*/g, " ").trim() || "crb";
	return `${line}\n\n${events.map((e) => `${JSON.stringify(e)}\n`).join("")}`;
}

/**
 * Reads the events from a commit message. The message is untrusted: the
 * summary line, blank or invalid lines, unknown types and versions, and
 * malformed events are skipped, and so is any cluster-state not written by a
 * human. Duplicate ids are kept; the fold deduplicates.
 */
export function parseEventLines(message: string): CrbEvent[] {
	const events: CrbEvent[] = [];
	for (const line of message.split(/\r?\n/).slice(1)) {
		const text = line.trim();
		if (!text.startsWith("{")) continue;
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			continue;
		}
		const event = parseEvent(value);
		if (event) events.push(event);
	}
	return events;
}

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isStr = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0;
const isPosInt = (value: unknown): value is number =>
	Number.isSafeInteger(value) && (value as number) > 0;
const isSide = (value: unknown): value is DiffSide =>
	value === "LEFT" || value === "RIGHT";

/** `{ old, new }` line ranges, or null. */
export function parseSides(
	value: unknown,
): { old: LineRanges; new: LineRanges } | null {
	if (!isObj(value)) return null;
	const old = parseRanges(value.old);
	const fresh = parseRanges(value.new);
	return old && fresh ? { old, new: fresh } : null;
}

/** Returns a clean copy holding only known fields, or null to skip it. */
function parseEvent(raw: unknown): CrbEvent | null {
	if (!isObj(raw) || raw.v !== 1) return null;
	const { id, ts, by, actor, details } = raw;
	if (typeof id !== "string" || !LOWER_ULID.test(id)) return null;
	if (!Number.isSafeInteger(ts) || (ts as number) < 0) return null;
	if (by !== "human" && by !== "ai" && by !== "auto") return null;
	if (typeof actor !== "string" || !isSlug(actor)) return null;
	const base = {
		v: 1 as const,
		id,
		ts: ts as number,
		by: by as By,
		actor,
		...(isObj(details) ? { details } : {}),
	};

	switch (raw.type) {
		case "review-created": {
			const { source, key, pr } = raw;
			if (source !== "github-pr" || !isStr(key) || !isObj(pr)) return null;
			const { owner, repo, number, url, baseBranch, headBranch, headRepo } = pr;
			if (
				!isStr(owner) ||
				!isStr(repo) ||
				!isPosInt(number) ||
				!isStr(url) ||
				!isStr(baseBranch) ||
				!isStr(headBranch) ||
				!isStr(headRepo)
			) {
				return null;
			}
			return {
				...base,
				type: "review-created",
				source,
				key,
				pr: { owner, repo, number, url, baseBranch, headBranch, headRepo },
			};
		}
		case "patchset-started": {
			const { patchset, revision, mergeBase, head } = raw;
			const { since, shape, baseBranch, interdiff } = raw;
			if (
				!isPosInt(patchset) ||
				!isStr(revision) ||
				!isStr(mergeBase) ||
				!isStr(head)
			) {
				return null;
			}
			// The optional fields: absent (older events), or well-formed.
			if (since !== undefined && (!isPosInt(since) || since >= patchset)) {
				return null;
			}
			if (
				shape !== undefined &&
				(typeof shape !== "string" || !SHAPES.includes(shape))
			) {
				return null;
			}
			if (baseBranch !== undefined && !isStr(baseBranch)) return null;
			if (
				interdiff !== undefined &&
				interdiff !== "available" &&
				interdiff !== "unavailable"
			) {
				return null;
			}
			return {
				...base,
				type: "patchset-started",
				patchset,
				revision,
				mergeBase,
				head,
				...(since !== undefined ? { since } : {}),
				...(shape !== undefined ? { shape: shape as ShapeCode } : {}),
				...(baseBranch !== undefined ? { baseBranch } : {}),
				...(interdiff !== undefined ? { interdiff } : {}),
			};
		}
		case "carried": {
			// Fail safe: only the engine carries, and only human states.
			if (base.by !== "auto") return null;
			const { from, to, rule, states } = raw;
			if (!isPosInt(from) || !isPosInt(to) || from >= to) return null;
			if (rule !== "exact" && rule !== "rename") return null;
			if (!Array.isArray(states)) return null;
			const entries: CarriedEntry[] = [];
			for (const entry of states) {
				if (!isObj(entry)) return null;
				const { key, state } = entry;
				// Absent: carried from the same key.
				const fromKey = entry.fromKey === undefined ? key : entry.fromKey;
				if (
					typeof key !== "string" ||
					!CLUSTER_KEY.test(key) ||
					typeof fromKey !== "string" ||
					!CLUSTER_KEY.test(fromKey) ||
					typeof state !== "string" ||
					!CARRIED_STATES.includes(state)
				) {
					return null;
				}
				entries.push({
					key,
					fromKey,
					state: state as CarriedEntry["state"],
				});
			}
			return { ...base, type: "carried", from, to, rule, states: entries };
		}
		case "thread-placed": {
			// A placement is a decision: the reviewer's or an AI's, never automatic.
			if (base.by === "auto") return null;
			const { thread, patchset, anchor, engine } = raw;
			if (!isStr(thread) || !isPosInt(patchset) || !isPosInt(engine)) {
				return null;
			}
			if (!isObj(anchor)) return null;
			const { path, startSide, startLine, side, line } = anchor;
			if (
				!isStr(path) ||
				!isSide(startSide) ||
				!isSide(side) ||
				!isPosInt(startLine) ||
				!isPosInt(line)
			) {
				return null;
			}
			return {
				...base,
				type: "thread-placed",
				thread,
				patchset,
				anchor: { path, startSide, startLine, side, line },
				engine,
			};
		}
		case "cluster-state": {
			// Fail safe: only a human can change a cluster's state.
			if (base.by !== "human") return null;
			const { patchset, cluster, path, state, reason } = raw;
			if (
				!isStr(patchset) ||
				!isStr(cluster) ||
				!isStr(path) ||
				typeof state !== "string" ||
				!CLUSTER_STATES.includes(state) ||
				(reason !== undefined && typeof reason !== "string")
			) {
				return null;
			}
			return {
				...base,
				type: "cluster-state",
				patchset,
				cluster,
				path,
				state: state as ClusterState,
				...(reason !== undefined ? { reason } : {}),
			};
		}
		case "lines-state": {
			// Fail safe: only a human marks lines.
			if (base.by !== "human") return null;
			const { patchset, cluster, path, state } = raw;
			const lines = parseRanges(raw.lines);
			if (
				!isStr(patchset) ||
				!isStr(cluster) ||
				!isStr(path) ||
				(state !== "reviewed" && state !== "crossed-off") ||
				!lines ||
				lines.length === 0
			) {
				return null;
			}
			return {
				...base,
				type: "lines-state",
				patchset,
				cluster,
				path,
				state,
				lines,
			};
		}
		case "since-lines-state": {
			if (base.by !== "human") return null;
			const { patchset, since, path } = raw;
			const reviewed = parseSides(raw.reviewed);
			const crossed = parseSides(raw.crossed);
			if (
				!isStr(patchset) ||
				!isPosInt(since) ||
				!isStr(path) ||
				!reviewed ||
				!crossed
			) {
				return null;
			}
			return {
				...base,
				type: "since-lines-state",
				patchset,
				since,
				path,
				reviewed,
				crossed,
			};
		}
		case "review-closed": {
			const { outcome, mergeCommit } = raw;
			if (outcome !== "merged" && outcome !== "closed") return null;
			if (mergeCommit !== undefined && !isStr(mergeCommit)) return null;
			return {
				...base,
				type: "review-closed",
				outcome,
				...(mergeCommit !== undefined ? { mergeCommit } : {}),
			};
		}
		case "pr-snoozed":
		case "pr-waiting-on":
		case "pr-note":
		case "pr-cleared":
			// Fail safe: only a human annotates a PR (nothing automatic hides one).
			return base.by === "human" ? parseInboxEvent(raw, base) : null;
		default:
			return null;
	}
}

function parseInboxEvent(
	raw: Obj,
	base: Omit<InboxEvent, "type" | "pr">,
): InboxEvent | null {
	const { pr } = raw;
	if (!isPosInt(pr)) return null;
	switch (raw.type) {
		case "pr-snoozed": {
			const { until, wakeOnActivity } = raw;
			if (
				!Number.isSafeInteger(until) ||
				(until as number) < 0 ||
				(until as number) > MAX_DATE_MS
			) {
				return null;
			}
			if (typeof wakeOnActivity !== "boolean") return null;
			return {
				...base,
				type: "pr-snoozed",
				pr,
				until: until as number,
				wakeOnActivity,
			};
		}
		case "pr-waiting-on": {
			const { who } = raw;
			if (typeof who !== "string" || !LOGIN.test(who)) return null;
			return { ...base, type: "pr-waiting-on", pr, who };
		}
		case "pr-note": {
			const { text } = raw;
			if (typeof text !== "string" || text.length > MAX_NOTE_READ) return null;
			return { ...base, type: "pr-note", pr, text };
		}
		case "pr-cleared": {
			const { kind } = raw;
			if (kind !== "snooze" && kind !== "waiting") return null;
			return { ...base, type: "pr-cleared", pr, kind };
		}
		default:
			return null;
	}
}
