import { monotonicFactory } from "ulid";
import type { ClusterState } from "../../shared/types.js";

/**
 * crb events, stored one JSON object per line in crb commit messages.
 * See docs/review-data-storage.md ("Commit format", "Events").
 */

export type By = "human" | "ai";

interface EventBase {
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
	revision: string;
	mergeBase: string;
	head: string;
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

/** Parsed and validated only; not written in this milestone. */
export interface ReviewClosedEvent extends EventBase {
	type: "review-closed";
	outcome: "merged" | "closed";
	mergeCommit?: string;
}

export type CrbEvent =
	| ReviewCreatedEvent
	| PatchsetStartedEvent
	| ClusterStateEvent
	| ReviewClosedEvent;

export type CrbEventType = CrbEvent["type"];
export type EventOf<T extends CrbEventType> = Extract<CrbEvent, { type: T }>;
export type EventPayload<T extends CrbEventType> = Omit<
	EventOf<T>,
	keyof EventBase | "type"
> & { details?: Record<string, unknown> };

const SLUG = /^[a-z0-9-]{1,64}$/;
const LOWER_ULID = /^[0-9a-hjkmnp-tv-z]{26}$/;
const CLUSTER_STATES: readonly string[] = [
	"unreviewed",
	"reviewed",
	"crossed-off",
] satisfies ClusterState[];

export function isSlug(value: string): boolean {
	return SLUG.test(value);
}

const nextUlid = monotonicFactory();

export function newEvent<T extends CrbEventType>(
	type: T,
	actor: string,
	payload: EventPayload<T>,
	by: By = "human",
): EventOf<T> {
	const ts = Date.now();
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

/** Returns a clean copy holding only known fields, or null to skip it. */
function parseEvent(raw: unknown): CrbEvent | null {
	if (!isObj(raw) || raw.v !== 1) return null;
	const { id, ts, by, actor, details } = raw;
	if (typeof id !== "string" || !LOWER_ULID.test(id)) return null;
	if (!Number.isSafeInteger(ts) || (ts as number) < 0) return null;
	if (by !== "human" && by !== "ai") return null;
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
			if (
				!isPosInt(patchset) ||
				!isStr(revision) ||
				!isStr(mergeBase) ||
				!isStr(head)
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
		default:
			return null;
	}
}
