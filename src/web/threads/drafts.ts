import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

/**
 * The reviewer's reply drafts, per PR: what is typed in each thread's box,
 * each reply sent but not yet confirmed by GitHub, and each edit of one of
 * their comments (by comment id) changed from where it started, until
 * GitHub has it. Kept in
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
	/** A box draft: how much of its start was put back by refused replies. */
	returned?: number;
	/** An edit of a comment, not a reply: `text` is the comment's new Markdown. */
	edit?: EditDraft;
}

/** An edit in progress (or saving) of one comment. */
export interface EditDraft {
	commentId: string;
	/** The body the edit started from: GitHub refuses it if that changed since. */
	from: string;
	/** Saved and not yet confirmed: resent on load (the editor is closed). */
	saving?: boolean;
	/** Saved with "Save anyway": no changed-on-GitHub check. */
	force?: boolean;
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
	if (d.edit !== undefined) {
		const e = d.edit as Partial<EditDraft> | null;
		return (
			d.sending === undefined &&
			typeof e === "object" &&
			e !== null &&
			typeof e.commentId === "string" &&
			e.commentId !== "" &&
			typeof e.from === "string" &&
			(e.saving === undefined || typeof e.saving === "boolean") &&
			(e.force === undefined || typeof e.force === "boolean")
		);
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

/** The thread's reply box draft (not a sent reply, not an edit). */
const isBox = (d: Draft, threadId: string) =>
	d.threadId === threadId && !d.sending && !d.edit;

/** What a draft is one of: a box, a sent reply, an edit. Each slot holds one. */
const slot = (d: Draft) =>
	d.sending
		? `s\n${d.threadId}\n${d.sending.attemptedAt}`
		: d.edit
			? `e\n${d.edit.commentId}`
			: `b\n${d.threadId}`;

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
 * `attemptedAt`). Every change is written through to storage at once, on
 * top of what storage holds then (another tab's changes to other drafts
 * stay), and another tab's writes are taken in as they happen (`storage`
 * events): a confirmed reply is never written back.
 */
export class DraftStore {
	readonly #storage: () => Storage | undefined;
	#key: string | null = null;
	#drafts: readonly Draft[] = [];
	/** The last write didn't reach storage: memory is ahead of it. */
	#behind = false;
	#listening = false;
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
		this.#listen();
		const stored = this.#stored() ?? [];
		const now = this.#drafts.filter((d) => d.sending || d.edit || d.text);
		const mine = new Set(now.map(slot));
		const kept = stored.filter((d) => !mine.has(slot(d)));
		this.#set([...kept, ...now]);
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
		return this.#drafts.find((d) => isBox(d, threadId))?.text ?? "";
	}

	/** The thread's box text is now `text` (none when empty). */
	setText(threadId: string, text: string): void {
		this.#update((all) => {
			const rest = all.filter((d) => !isBox(d, threadId));
			return text ? [...rest, { threadId, text }] : rest;
		});
	}

	/** The edit of a comment in progress or saving, if any. */
	edit(commentId: string): Draft | undefined {
		return this.#drafts.find((d) => d.edit?.commentId === commentId);
	}

	/**
	 * The comment's edit now reads `text`, started from `from`: kept while
	 * it differs from `from`, dropped when back to it (nothing to lose).
	 */
	setEdit(threadId: string, commentId: string, from: string, text: string) {
		this.#update((all) => {
			const rest = all.filter((d) => d.edit?.commentId !== commentId);
			return text === from
				? rest
				: [...rest, { threadId, text, edit: { commentId, from } }];
		});
	}

	/** Saved (sent to GitHub until it has it), or back in the editor (refused). */
	markSaving(commentId: string, saving: boolean, force = false): void {
		this.#update((all) =>
			all.map((d) =>
				d.edit?.commentId === commentId
					? {
							...d,
							edit: {
								commentId,
								from: d.edit.from,
								...(saving ? { saving: true } : {}),
								...(saving && force ? { force: true } : {}),
							},
						}
					: d,
			),
		);
	}

	/** The edit starts from GitHub's newer body now (the reviewer saw theirs). */
	setFrom(commentId: string, from: string): void {
		this.#update((all) =>
			all.map((d) =>
				d.edit?.commentId === commentId
					? { ...d, edit: { ...d.edit, from } }
					: d,
			),
		);
	}

	/** GitHub has the edit, or the reviewer let it go. */
	dropEdit(commentId: string): void {
		this.#update((all) => all.filter((d) => d.edit?.commentId !== commentId));
	}

	/** A reply is sent: kept until confirmed (or returned to the box). */
	addSending(threadId: string, text: string, id: SendingId): void {
		this.#update((all) => [
			...all.filter((d) => !this.#is(d, threadId, id.attemptedAt)),
			{ threadId, text, sending: { ...id, sentOnce: false } },
		]);
	}

	/** The reply's request has gone out at least once. */
	markSent(threadId: string, attemptedAt: string): void {
		this.#update((all) =>
			all.map((d) =>
				this.#is(d, threadId, attemptedAt) && d.sending && !d.sending.sentOnce
					? { ...d, sending: { ...d.sending, sentOnce: true } }
					: d,
			),
		);
	}

	/** The comment ids the reply was first sent knowing: kept for its resends. */
	setKnown(threadId: string, attemptedAt: string, ids: string[]): void {
		this.#update((all) =>
			all.map((d) =>
				this.#is(d, threadId, attemptedAt) && d.sending
					? { ...d, sending: { ...d.sending, knownCommentIds: ids } }
					: d,
			),
		);
	}

	/** GitHub has the reply (or the reviewer dropped it): nothing to keep. */
	confirm(threadId: string, attemptedAt: string): void {
		this.#update((all) =>
			all.filter((d) => !this.#is(d, threadId, attemptedAt)),
		);
	}

	/** Drops the thread's box text and its sent replies (the reviewer discarded them). */
	discard(threadId: string): void {
		this.#update((all) => all.filter((d) => d.threadId !== threadId));
	}

	/**
	 * The reply was refused: its text goes back into the box, after any
	 * text returned there before and ahead of anything typed since.
	 * Answers the text put back ("" if none).
	 */
	returnToBox(threadId: string, attemptedAt: string): string {
		let back = "";
		this.#update((all) => {
			const sent = all.find((d) => this.#is(d, threadId, attemptedAt));
			if (!sent) return all;
			back = sent.text;
			const box = all.find((d) => d.threadId === threadId && !d.sending);
			const typed = box?.text ?? "";
			const returned = box?.returned ?? 0;
			const before = typed.slice(0, returned);
			const after = typed.slice(returned).replace(/^\n\n/, "");
			const head = before ? `${before}\n\n${sent.text}` : sent.text;
			const text = after ? `${head}\n\n${after}` : head;
			const rest = all.filter(
				(d) =>
					!this.#is(d, threadId, attemptedAt) &&
					!(d.threadId === threadId && !d.sending),
			);
			return [...rest, { threadId, text, returned: head.length }];
		});
		return back;
	}

	#is(d: Draft, threadId: string, attemptedAt: string) {
		return d.threadId === threadId && d.sending?.attemptedAt === attemptedAt;
	}

	/** What storage holds now; null when it can't be read (memory is all). */
	#stored(): Draft[] | null {
		if (this.#key === null) return null;
		try {
			const storage = this.#storage();
			if (!storage) return null;
			const raw = storage.getItem(this.#key);
			if (!raw) return [];
			try {
				const parsed: unknown = JSON.parse(raw);
				return Array.isArray(parsed) ? parsed.filter(isDraft) : [];
			} catch {
				return [];
			}
		} catch {
			return null;
		}
	}

	/** One change, on top of what storage holds now (another tab's too). */
	#update(change: (all: readonly Draft[]) => readonly Draft[]): void {
		const base = this.#behind ? null : this.#stored();
		this.#set(change(base ?? this.#drafts));
	}

	/** Another tab's writes, taken in as they happen. */
	#listen(): void {
		if (this.#listening || typeof window === "undefined") return;
		this.#listening = true;
		window.addEventListener("storage", (e) => {
			if (e.key !== null && e.key !== this.#key) return;
			if (this.#behind) return;
			if (e.key === null) {
				// Storage cleared (another tab, or site data): what this tab
				// holds stays, and goes back in.
				this.#set(this.#drafts);
				return;
			}
			const stored = this.#stored();
			if (!stored) return;
			this.#drafts = stored;
			for (const listener of this.#listeners) listener();
		});
	}

	#set(drafts: readonly Draft[]): void {
		this.#drafts = drafts;
		if (this.#key !== null) {
			try {
				const storage = this.#storage();
				if (drafts.length === 0) storage?.removeItem(this.#key);
				else storage?.setItem(this.#key, JSON.stringify(drafts));
				this.#behind = !storage;
			} catch {
				// Memory only: the page keeps them for its life.
				this.#behind = true;
			}
		}
		for (const listener of this.#listeners) listener();
	}
}

/** A draft worth keeping and showing: typed text, a reply sent, an edit changed. */
export const kept = (d: Draft) =>
	d.sending !== undefined || d.edit !== undefined || d.text.trim() !== "";

/** Something here would be lost by leaving the page. */
export const unsent = (drafts: readonly Draft[]) => drafts.some(kept);

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

/** The comment's edit draft (in progress or saving), kept like a reply draft. */
export function useEditDraft(commentId: string): Draft | undefined {
	const store = draftsFor(useQueryClient());
	const get = () => (commentId ? store.edit(commentId) : undefined);
	return useSyncExternalStore(store.subscribe, get, get);
}

/** Every draft and unconfirmed reply (the Drafts filter, the leave guard). */
export function useDrafts(): readonly Draft[] {
	const store = draftsFor(useQueryClient());
	return useSyncExternalStore(store.subscribe, store.get, store.get);
}
