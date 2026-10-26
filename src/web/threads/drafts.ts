import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

/**
 * The reviewer's reply drafts, per PR: what is typed in each thread's box,
 * and each reply sent but not yet confirmed by GitHub. Kept in
 * `localStorage` (`crb:drafts:<owner>/<repo>#<number>`) so a reload loses
 * nothing: an unconfirmed reply is resent then (ThreadWrites.resume), with
 * the server's duplicate check. Storage that throws or is missing (a
 * private window, blocked site data) falls back to memory for the page's
 * life.
 */

export interface Draft {
	threadId: string;
	text: string;
	/** Sent, not yet confirmed. */
	sending?: Sending;
}

/** A sent reply's identity for the server's duplicate check, kept across reloads. */
export interface Sending {
	attemptedAt: string;
	sentOnce: boolean;
	/** Made by the client once per reply; the same on every resend. */
	clientId: string;
	/** The thread's comment ids known when it was first sent. */
	knownCommentIds: string[];
}

/** What a reply is sent with besides its text. */
export type SendingId = Omit<Sending, "sentOnce">;

export const draftsKey = (pr: {
	owner: string;
	repo: string;
	number: number;
}) => `crb:drafts:${pr.owner}/${pr.repo}#${pr.number}`;

function isDraft(value: unknown): value is Draft {
	if (typeof value !== "object" || value === null) return false;
	const d = value as Partial<Draft>;
	if (typeof d.threadId !== "string" || typeof d.text !== "string") {
		return false;
	}
	if (d.sending === undefined) return true;
	return (
		typeof d.sending === "object" &&
		d.sending !== null &&
		typeof d.sending.attemptedAt === "string" &&
		typeof d.sending.sentOnce === "boolean" &&
		typeof d.sending.clientId === "string" &&
		Array.isArray(d.sending.knownCommentIds) &&
		d.sending.knownCommentIds.every((id) => typeof id === "string")
	);
}

/** The page's storage, or undefined where touching it throws. */
function defaultStorage(): Storage | undefined {
	try {
		return globalThis.localStorage ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Drafts and unconfirmed replies. A thread has at most one box draft (no
 * `sending`) and any number of sent replies (`sending`, told apart by
 * `attemptedAt`). Every change is written through to storage at once.
 */
export class DraftStore {
	readonly #storage: () => Storage | undefined;
	#key: string | null = null;
	#drafts: readonly Draft[] = [];
	readonly #listeners = new Set<() => void>();

	constructor(storage: () => Storage | undefined = defaultStorage) {
		this.#storage = storage;
	}

	/**
	 * Keeps the drafts under `key` from now on: those stored there join the
	 * ones typed before (a box typed in now wins over a stored one).
	 */
	bind(key: string): void {
		if (this.#key === key) return;
		this.#key = key;
		const stored = this.#read(key);
		const now = this.#drafts;
		const typed = new Set(
			now.filter((d) => !d.sending && d.text).map((d) => d.threadId),
		);
		const sent = new Set(
			now.flatMap((d) =>
				d.sending ? [`${d.threadId}\n${d.sending.attemptedAt}`] : [],
			),
		);
		const kept = stored.filter((d) =>
			d.sending
				? !sent.has(`${d.threadId}\n${d.sending.attemptedAt}`)
				: !typed.has(d.threadId),
		);
		this.#set([...kept, ...now.filter((d) => d.sending || d.text)]);
	}

	get = (): readonly Draft[] => this.#drafts;

	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	/** The thread's box text ("" for none). */
	text(threadId: string): string {
		return (
			this.#drafts.find((d) => d.threadId === threadId && !d.sending)?.text ??
			""
		);
	}

	/** The thread's box text is now `text` (none when empty). */
	setText(threadId: string, text: string): void {
		const rest = this.#drafts.filter(
			(d) => !(d.threadId === threadId && !d.sending),
		);
		this.#set(text ? [...rest, { threadId, text }] : rest);
	}

	/** A reply is sent: kept until confirmed (or returned to the box). */
	addSending(threadId: string, text: string, id: SendingId): void {
		this.#set([
			...this.#drafts,
			{ threadId, text, sending: { ...id, sentOnce: false } },
		]);
	}

	/** The reply's request has gone out at least once. */
	markSent(threadId: string, attemptedAt: string): void {
		let changed = false;
		const next = this.#drafts.map((d) => {
			if (!this.#is(d, threadId, attemptedAt) || d.sending?.sentOnce) return d;
			changed = true;
			return d.sending
				? { ...d, sending: { ...d.sending, sentOnce: true } }
				: d;
		});
		if (changed) this.#set(next);
	}

	/** The comment ids the reply was first sent knowing: kept for its resends. */
	setKnown(threadId: string, attemptedAt: string, ids: string[]): void {
		this.#set(
			this.#drafts.map((d) =>
				this.#is(d, threadId, attemptedAt) && d.sending
					? { ...d, sending: { ...d.sending, knownCommentIds: ids } }
					: d,
			),
		);
	}

	/** GitHub has the reply: nothing to keep. */
	confirm(threadId: string, attemptedAt: string): void {
		this.#set(this.#drafts.filter((d) => !this.#is(d, threadId, attemptedAt)));
	}

	/**
	 * The reply was refused: its text goes back into the box, ahead of
	 * anything typed since. Answers the text put back ("" if none).
	 */
	returnToBox(threadId: string, attemptedAt: string): string {
		const sent = this.#drafts.find((d) => this.#is(d, threadId, attemptedAt));
		if (!sent) return "";
		const typed = this.text(threadId);
		const text = typed ? `${sent.text}\n\n${typed}` : sent.text;
		const rest = this.#drafts.filter(
			(d) =>
				!this.#is(d, threadId, attemptedAt) &&
				!(d.threadId === threadId && !d.sending),
		);
		this.#set([...rest, { threadId, text }]);
		return sent.text;
	}

	#is(d: Draft, threadId: string, attemptedAt: string) {
		return d.threadId === threadId && d.sending?.attemptedAt === attemptedAt;
	}

	#read(key: string): Draft[] {
		try {
			const raw = this.#storage()?.getItem(key);
			if (!raw) return [];
			const parsed: unknown = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter(isDraft) : [];
		} catch {
			return [];
		}
	}

	#set(drafts: Draft[]): void {
		this.#drafts = drafts;
		if (this.#key !== null) {
			try {
				const storage = this.#storage();
				if (drafts.length === 0) storage?.removeItem(this.#key);
				else storage?.setItem(this.#key, JSON.stringify(drafts));
			} catch {
				// Memory only: the page keeps them for its life.
			}
		}
		for (const listener of this.#listeners) listener();
	}
}

/** Something here would be lost by leaving the page. */
export const unsent = (drafts: readonly Draft[]) =>
	drafts.some((d) => d.sending !== undefined || d.text.trim() !== "");

const stores = new WeakMap<QueryClient, DraftStore>();

/** The page's drafts, per query client. */
export function draftsFor(client: QueryClient): DraftStore {
	let store = stores.get(client);
	if (!store) {
		store = new DraftStore();
		stores.set(client, store);
	}
	return store;
}

/** A thread's box text, kept across closing it, page switches and reloads. */
export function useDraft(threadId: string): [string, (text: string) => void] {
	const store = draftsFor(useQueryClient());
	const text = useSyncExternalStore(
		store.subscribe,
		() => store.text(threadId),
		() => store.text(threadId),
	);
	const setText = useCallback(
		(t: string) => store.setText(threadId, t),
		[store, threadId],
	);
	return [text, setText];
}

/** Every draft and unconfirmed reply (the Drafts filter, the leave guard). */
export function useDrafts(): readonly Draft[] {
	const store = draftsFor(useQueryClient());
	return useSyncExternalStore(store.subscribe, store.get, store.get);
}
