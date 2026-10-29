import { stat } from "node:fs/promises";
import type { AnnotationOp, Annotations, HomeRow } from "../../shared/home.js";
import { clonePath, ensureRepoInit } from "../clone.js";
import {
	type CrbEvent,
	type InboxEvent,
	isSlug,
	newEvent,
} from "../review/events.js";
import { RefStore } from "../review/refStore.js";
import type { PrFacts } from "./facts.js";

/**
 * The reviewer's own annotations of PRs on Home (snooze, waiting on, note),
 * as events in `refs/crb/inbox/<reviewer>` of each repo's cache clone. Only
 * the reviewer writes them, by hand (`by: "human"`); nothing automatic ever
 * hides a PR. See docs/review-data-storage.md ("Inbox ref").
 */

export const inboxRef = (slug: string) => `refs/crb/inbox/${slug}`;

/** A row woken this recently carries the "woke" badge. */
export const WOKE_MS = 24 * 3_600_000;

const iso = (ms: number) => new Date(ms).toISOString();

/** The events an annotation op writes, all at `ts`. */
export function opEvents(
	slug: string,
	pr: number,
	op: AnnotationOp,
	ts: number = Date.now(),
): InboxEvent[] {
	switch (op.op) {
		case "snooze":
			return [
				newEvent(
					"pr-snoozed",
					slug,
					{
						pr,
						until: Date.parse(op.until),
						wakeOnActivity: op.wakeOnActivity,
					},
					"human",
					ts,
				),
			];
		case "wait":
			return [
				newEvent("pr-waiting-on", slug, { pr, who: op.who }, "human", ts),
			];
		case "note":
			return [
				newEvent("pr-note", slug, { pr, text: op.text.trim() }, "human", ts),
			];
		case "wake":
			return (["snooze", "waiting"] as const).map((kind) =>
				newEvent("pr-cleared", slug, { pr, kind }, "human", ts),
			);
	}
}

const SUMMARY: Record<AnnotationOp["op"], string> = {
	snooze: "snoozed",
	wait: "waiting on",
	note: "note on",
	wake: "woke",
};

/**
 * Annotations by PR number: events deduplicated by id and sorted by
 * (ts, id), the last per (PR, kind) winning. Other event types are skipped.
 * PRs left with nothing are dropped.
 */
export function foldInbox(
	events: readonly CrbEvent[],
): Map<number, Annotations> {
	const seen = new Set<string>();
	const inbox = events
		.filter((e): e is InboxEvent => e.type.startsWith("pr-"))
		.filter((e) => !seen.has(e.id) && seen.add(e.id))
		.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const out = new Map<number, Annotations>();
	for (const e of inbox) {
		const a = out.get(e.pr) ?? {};
		switch (e.type) {
			case "pr-snoozed":
				a.snooze = {
					until: iso(e.until),
					wakeOnActivity: e.wakeOnActivity,
					at: iso(e.ts),
				};
				break;
			case "pr-waiting-on":
				a.waiting = { who: e.who, at: iso(e.ts) };
				break;
			case "pr-note":
				if (e.text) a.note = e.text;
				else delete a.note;
				break;
			case "pr-cleared":
				if (e.kind === "snooze") delete a.snooze;
				else delete a.waiting;
				break;
		}
		out.set(e.pr, a);
	}
	for (const [pr, a] of out) if (Object.keys(a).length === 0) out.delete(pr);
	return out;
}

type Activity = Pick<PrFacts, "updatedAt" | "lastActivity">;

const ms = (at: string | undefined) => {
	const v = at ? Date.parse(at) : Number.NaN;
	return Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
};

/** When the snooze ended (activity strictly after it, or its date), if it has by `now`. */
function snoozeEnded(
	s: NonNullable<Annotations["snooze"]>,
	pr: Activity,
	now: number,
): { at: number; by: "activity" | "time" } | null {
	const until = ms(s.until);
	const updated = ms(pr.updatedAt);
	if (
		s.wakeOnActivity &&
		updated > ms(s.at) &&
		updated < until &&
		updated <= now
	) {
		return { at: updated, by: "activity" };
	}
	return now >= until ? { at: until, by: "time" } : null;
}

/** When the person waited on acted after the annotation, if they have. */
function waitEnded(
	w: NonNullable<Annotations["waiting"]>,
	pr: Activity,
): number | null {
	if (w.who === "me") return null;
	const acted = ms(pr.lastActivity[w.who.toLowerCase()]);
	return acted > ms(w.at) ? acted : null;
}

/** Why the viewer's annotations hide the row now, if they do. */
export function hiddenReason(
	a: Annotations,
	pr: Activity,
	now: number,
): HomeRow["hidden"] {
	if (a.snooze && !snoozeEnded(a.snooze, pr, now)) return "snoozed";
	if (
		a.waiting &&
		a.waiting.who !== "me" &&
		waitEnded(a.waiting, pr) === null
	) {
		return "waiting";
	}
	return null;
}

/** The row woke (a snooze or a wait ended by itself) within WOKE_MS of `now`. */
export function wokeOf(
	a: Annotations,
	pr: Activity,
	now: number,
): HomeRow["woke"] {
	if (hiddenReason(a, pr, now)) return null;
	const ends: { at: number; by: "activity" | "time" }[] = [];
	if (a.snooze) {
		const end = snoozeEnded(a.snooze, pr, now);
		if (end) ends.push(end);
	}
	if (a.waiting) {
		const at = waitEnded(a.waiting, pr);
		if (at !== null) ends.push({ at, by: "activity" });
	}
	const latest = ends
		.filter((e) => e.at <= now && now - e.at < WOKE_MS)
		.sort((x, y) => y.at - x.at)[0];
	return latest ? { at: iso(latest.at), by: latest.by } : null;
}

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

/** Reads and writes reviewers' inbox refs, one RefStore (and its cache) per repo. */
export class InboxStore {
	#stores = new Map<string, RefStore>();

	#store(path: string): RefStore {
		let store = this.#stores.get(path);
		if (!store) {
			store = new RefStore(path);
			this.#stores.set(path, store);
		}
		return store;
	}

	/** The reviewer's annotations in `owner/repo`; none when it has no repo yet. */
	async read(
		slug: string,
		owner: string,
		repo: string,
	): Promise<Map<number, Annotations>> {
		checkSlug(slug);
		const path = clonePath(owner, repo);
		if (!(await exists(path))) return new Map();
		return foldInbox(await this.#store(path).readEvents(inboxRef(slug)));
	}

	/**
	 * Writes the op for PR `number` (one commit, compare-and-swap) into the
	 * repo's cache clone, made empty first if there is none (no clone
	 * needed), and returns the PR's annotations after it.
	 */
	async append(
		slug: string,
		owner: string,
		repo: string,
		number: number,
		op: AnnotationOp,
	): Promise<Annotations> {
		checkSlug(slug);
		const path = await ensureRepoInit(owner, repo);
		const store = this.#store(path);
		const ref = inboxRef(slug);
		// Stamped after everything stored, so a clock stepping back can't put
		// a clear before the snooze it ends (the fold orders by ts).
		let last = -1;
		for (const e of await store.readEvents(ref)) if (e.ts > last) last = e.ts;
		const events = opEvents(slug, number, op, Math.max(Date.now(), last + 1));
		await store.appendEvents(
			ref,
			`crb: ${SUMMARY[op.op]} #${number}`,
			events,
			slug,
		);
		return foldInbox(await store.readEvents(ref)).get(number) ?? {};
	}
}

function checkSlug(slug: string): void {
	if (!isSlug(slug)) throw new Error(`Invalid reviewer slug: ${slug}`);
}
