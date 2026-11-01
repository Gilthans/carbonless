import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { VerdictEvent } from "../../shared/types";

/**
 * The reviewer's verdict draft, per PR: the "Include a message" text, and a
 * verdict pressed and not yet confirmed by GitHub. Kept in `localStorage`
 * (`crb:verdict:<owner>/<repo>#<number>`, apart from the reply drafts) so
 * a reload loses neither: a verdict on its way is resent then, with
 * `retry: true` and the same client id (ThreadWrites.resume), and the
 * server finds one that landed. Storage that throws or is missing falls
 * back to memory for the page's life.
 */

/** A verdict pressed, until GitHub has it: what every resend sends again. */
export interface VerdictSending {
	clientId: string;
	event: VerdictEvent;
	/** The message, when one was included. */
	body?: string;
	commit: string;
	attemptedAt: string;
	/** Its request has gone out at least once: a resend looks for it first. */
	sentOnce: boolean;
}

export interface VerdictDraft {
	text: string;
	sending?: VerdictSending;
}

export const verdictKey = (pr: {
	owner: string;
	repo: string;
	number: number;
}) => `crb:verdict:${pr.owner}/${pr.repo}#${pr.number}`;

const EVENTS: readonly unknown[] = [
	"APPROVE",
	"COMMENT",
	"REQUEST_CHANGES",
] satisfies VerdictEvent[];

function isSending(value: unknown): value is VerdictSending {
	if (typeof value !== "object" || value === null) return false;
	const s = value as Partial<VerdictSending>;
	return (
		typeof s.clientId === "string" &&
		s.clientId !== "" &&
		EVENTS.includes(s.event) &&
		(s.body === undefined || typeof s.body === "string") &&
		typeof s.commit === "string" &&
		typeof s.attemptedAt === "string" &&
		typeof s.sentOnce === "boolean"
	);
}

function parse(raw: string | null): VerdictDraft {
	if (!raw) return { text: "" };
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null) return { text: "" };
		const d = value as Partial<VerdictDraft>;
		const text = typeof d.text === "string" ? d.text : "";
		return isSending(d.sending) ? { text, sending: d.sending } : { text };
	} catch {
		return { text: "" };
	}
}

function defaultStorage(): Storage | undefined {
	try {
		return globalThis.localStorage ?? undefined;
	} catch {
		return undefined;
	}
}

const EMPTY: VerdictDraft = { text: "" };

export class VerdictStore {
	readonly #storage: () => Storage | undefined;
	#key: string | null = null;
	#draft: VerdictDraft = EMPTY;
	#behind = false;
	readonly #listeners = new Set<() => void>();

	constructor(storage: () => Storage | undefined = defaultStorage) {
		this.#storage = storage;
	}

	/** Kept under `key` from now on: what's typed or sent here wins over what's stored. */
	bind(key: string): void {
		if (this.#key === key) return;
		this.#key = key;
		const stored = this.#stored() ?? EMPTY;
		const now = this.#draft;
		this.#set({
			text: now.text || stored.text,
			...((now.sending ?? stored.sending)
				? { sending: now.sending ?? stored.sending }
				: {}),
		});
	}

	get = (): VerdictDraft => this.#draft;

	/** A reload keeps it: bound, and the last write reached storage. */
	durable = (): boolean => this.#key !== null && !this.#behind;

	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	text = (): string => this.#draft.text;

	setText(text: string): void {
		this.#update((d) => ({ ...d, text }));
	}

	sending = (): VerdictSending | undefined => this.#draft.sending;

	/** Pressed (kept until GitHub has it), or settled (null). */
	setSending(sending: VerdictSending | null): void {
		this.#update(({ sending: _, ...d }) => (sending ? { ...d, sending } : d));
	}

	/** The verdict's request has gone out at least once. */
	markSent(clientId: string): void {
		this.#update((d) =>
			d.sending?.clientId === clientId && !d.sending.sentOnce
				? { ...d, sending: { ...d.sending, sentOnce: true } }
				: d,
		);
	}

	/**
	 * A refused verdict's message back into the box, ahead of anything
	 * typed since; its sending is settled.
	 */
	returnToBox(clientId: string): void {
		this.#update((d) => {
			if (d.sending?.clientId !== clientId) return d;
			const body = d.sending.body ?? "";
			const text =
				body && d.text ? `${body}\n\n${d.text}` : body ? body : d.text;
			return { text };
		});
	}

	#stored(): VerdictDraft | null {
		if (this.#key === null) return null;
		try {
			const storage = this.#storage();
			return storage ? parse(storage.getItem(this.#key)) : null;
		} catch {
			return null;
		}
	}

	#update(change: (d: VerdictDraft) => VerdictDraft): void {
		this.#set(change(this.#draft));
	}

	#set(draft: VerdictDraft): void {
		this.#draft = draft;
		if (this.#key !== null) {
			try {
				const storage = this.#storage();
				if (!draft.text && !draft.sending) storage?.removeItem(this.#key);
				else storage?.setItem(this.#key, JSON.stringify(draft));
				this.#behind = !storage;
			} catch {
				this.#behind = true;
			}
		}
		for (const listener of this.#listeners) listener();
	}
}

const stores = new WeakMap<QueryClient, VerdictStore>();

/** The page's verdict draft, per query client. */
export function verdictDraftFor(client: QueryClient): VerdictStore {
	let store = stores.get(client);
	if (!store) {
		store = new VerdictStore();
		stores.set(client, store);
	}
	return store;
}

/** The verdict draft, as it changes. */
export function useVerdictDraft(): VerdictDraft {
	const store = verdictDraftFor(useQueryClient());
	return useSyncExternalStore(store.subscribe, store.get, store.get);
}
