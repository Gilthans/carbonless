import type { QueryClient } from "@tanstack/react-query";
import type { VerdictEvent } from "../../shared/types";

/**
 * Writes GitHub refused, per PR, kept until the reviewer retries them
 * successfully or drops them (ThreadWrites): in `localStorage`
 * (`crb:refused:<owner>/<repo>#<number>`), beside the drafts, so a reload
 * lists them again. What a refused reply, edit or new thread said stays in
 * its draft (drafts.ts); this keeps that it was refused, and why. A
 * resolve's intended state and a delete's comment live only here. Storage
 * that throws or is missing falls back to memory for the page's life.
 */

export type RefusedAction =
	| "Reply"
	| "Resolve"
	| "Unresolve"
	| "Edit"
	| "Delete"
	| "New comment"
	| "Verdict";

export interface StoredRefusal {
	/** The thread's lane (`new:<clientId>` for a new thread). */
	threadId: string;
	/** Its slot in the lane (ThreadWrites `refusalKey`). */
	key: string;
	action: RefusedAction;
	/** GitHub's message. */
	message: string;
	code?: string;
	url?: string;
	commentId?: string;
	/** A refused "Save anyway": its Retry saves anyway too. */
	force?: boolean;
	/** A resolve or unresolve: the state intended. */
	resolved?: boolean;
	/** A verdict (lane `verdict`): the event pressed; its message is the verdict draft's. */
	event?: VerdictEvent;
	/** When GitHub refused it (ISO). */
	at: string;
}

export const refusalsKey = (pr: {
	owner: string;
	repo: string;
	number: number;
}) => `crb:refused:${pr.owner}/${pr.repo}#${pr.number}`;

const ACTIONS: readonly unknown[] = [
	"Reply",
	"Resolve",
	"Unresolve",
	"Edit",
	"Delete",
	"New comment",
	"Verdict",
];
const EVENTS: readonly unknown[] = [
	"APPROVE",
	"COMMENT",
	"REQUEST_CHANGES",
] satisfies VerdictEvent[];
const optString = (v: unknown) => v === undefined || typeof v === "string";
const optBool = (v: unknown) => v === undefined || typeof v === "boolean";

function isStored(value: unknown): value is StoredRefusal {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Partial<StoredRefusal>;
	return (
		typeof r.threadId === "string" &&
		r.threadId !== "" &&
		typeof r.key === "string" &&
		r.key !== "" &&
		ACTIONS.includes(r.action) &&
		typeof r.message === "string" &&
		typeof r.at === "string" &&
		optString(r.code) &&
		optString(r.url) &&
		optString(r.commentId) &&
		optBool(r.force) &&
		optBool(r.resolved) &&
		(r.event === undefined || EVENTS.includes(r.event)) &&
		// A verdict can't be retried without its event.
		(r.action !== "Verdict" || r.event !== undefined)
	);
}

const same = (a: StoredRefusal, threadId: string, key: string) =>
	a.threadId === threadId && a.key === key;

function defaultStorage(): Storage | undefined {
	try {
		return globalThis.localStorage ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * The refused writes kept for the PR. Every change is written through at
 * once, on top of what storage holds then (another tab's refusals stay).
 */
export class RefusalStore {
	readonly #storage: () => Storage | undefined;
	#key: string | null = null;
	#all: readonly StoredRefusal[] = [];
	#behind = false;

	constructor(storage: () => Storage | undefined = defaultStorage) {
		this.#storage = storage;
	}

	/** Keeps them under `key` from now on: the stored ones join those refused before. */
	bind(key: string): void {
		if (this.#key === key) return;
		this.#key = key;
		const now = this.#all;
		const stored = (this.#stored() ?? []).filter(
			(s) => !now.some((n) => same(n, s.threadId, s.key)),
		);
		this.#set([...stored, ...now]);
	}

	get = (): readonly StoredRefusal[] => this.#all;

	/** A reload keeps them: bound, and the last write reached storage. */
	durable = (): boolean => this.#key !== null && !this.#behind;

	/** The refusal, new or with a newer message. */
	put(refusal: StoredRefusal): void {
		this.#update((all) => [
			...all.filter((r) => !same(r, refusal.threadId, refusal.key)),
			refusal,
		]);
	}

	/** Settled (retried and taken, or dropped): nothing to keep. */
	remove(threadId: string, key: string): void {
		this.#update((all) => all.filter((r) => !same(r, threadId, key)));
	}

	#stored(): StoredRefusal[] | null {
		if (this.#key === null) return null;
		try {
			const storage = this.#storage();
			if (!storage) return null;
			const raw = storage.getItem(this.#key);
			if (!raw) return [];
			try {
				const parsed: unknown = JSON.parse(raw);
				return Array.isArray(parsed) ? parsed.filter(isStored) : [];
			} catch {
				return [];
			}
		} catch {
			return null;
		}
	}

	#update(
		change: (all: readonly StoredRefusal[]) => readonly StoredRefusal[],
	): void {
		const base = this.#behind ? null : this.#stored();
		this.#set(change(base ?? this.#all));
	}

	#set(all: readonly StoredRefusal[]): void {
		this.#all = all;
		if (this.#key === null) return;
		try {
			const storage = this.#storage();
			if (all.length === 0) storage?.removeItem(this.#key);
			else storage?.setItem(this.#key, JSON.stringify(all));
			this.#behind = !storage;
		} catch {
			this.#behind = true;
		}
	}
}

const stores = new WeakMap<QueryClient, RefusalStore>();

/** The page's refused writes, per query client. */
export function refusalsFor(client: QueryClient): RefusalStore {
	let store = stores.get(client);
	if (!store) {
		store = new RefusalStore();
		stores.set(client, store);
	}
	return store;
}
