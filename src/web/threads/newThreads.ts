import { useSyncExternalStore } from "react";
import type { CodeSpan } from "../files/selectionActions";
import type { Draft, NewTarget } from "./drafts";

/**
 * New-thread composers opened and not typed in yet. Once typed in, a
 * composer is a draft (drafts.ts `create`, kept across reloads); until
 * then it lives here, for the page's life only (nothing to lose).
 */
export interface Composer {
	clientId: string;
	span: CodeSpan;
	/** Opened by the reviewer just now: its box takes focus once shown. */
	focus: boolean;
}

/** A random id for a new thread; unique enough where randomUUID is missing. */
export function newClientId(): string {
	try {
		if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	} catch {}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

let composers: readonly Composer[] = [];
const listeners = new Set<() => void>();
const changed = (next: readonly Composer[]) => {
	composers = next;
	for (const l of listeners) l();
};

/** Opens a composer on the span (one per span: the open one again). Answers its client id. */
export function openComposer(span: CodeSpan, id = newClientId()): string {
	const same = composers.find((c) => sameSpan(c.span, span));
	if (same) {
		changed(composers.map((c) => (c === same ? { ...c, focus: true } : c)));
		return same.clientId;
	}
	changed([...composers, { clientId: id, span, focus: true }]);
	return id;
}

/** The composer is gone (posted, cancelled, or now a draft that lists it). */
export function closeComposer(clientId: string): void {
	if (!composers.some((c) => c.clientId === clientId)) return;
	changed(composers.filter((c) => c.clientId !== clientId));
}

/** Its box took focus: not again on a later render. */
export function composerFocused(clientId: string): void {
	if (!composers.some((c) => c.clientId === clientId && c.focus)) return;
	changed(
		composers.map((c) =>
			c.clientId === clientId ? { ...c, focus: false } : c,
		),
	);
}

/** Forgets every composer (tests). */
export function resetComposers(): void {
	changed([]);
}

export const getComposers = (): readonly Composer[] => composers;

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
};

export function useComposers(): readonly Composer[] {
	return useSyncExternalStore(subscribe, getComposers, getComposers);
}

export function sameSpan(a: CodeSpan, b: CodeSpan): boolean {
	return (
		a.path === b.path &&
		a.commit === b.commit &&
		a.subject === b.subject &&
		a.startSide === b.startSide &&
		a.startLine === b.startLine &&
		a.side === b.side &&
		a.line === b.line &&
		(a.startCol ?? null) === (b.startCol ?? null) &&
		(a.endCol ?? null) === (b.endCol ?? null)
	);
}

/** The request fields of a span (what a draft keeps besides its text). */
export function targetOf(span: CodeSpan): NewTarget {
	if (span.subject === "file") {
		return { path: span.path, commit: span.commit, subject: "file" };
	}
	const cols =
		span.startCol != null && span.endCol != null
			? { startCol: span.startCol, endCol: span.endCol }
			: {};
	return {
		path: span.path,
		commit: span.commit,
		subject: "line",
		startSide: span.startSide,
		startLine: span.startLine,
		side: span.side,
		line: span.line,
		...cols,
	};
}

/** A draft's span. */
export function spanOfDraft(d: Draft): CodeSpan | null {
	const c = d.create;
	if (!c) return null;
	return {
		path: c.path,
		commit: c.commit,
		subject: c.subject,
		...(c.subject === "line"
			? {
					startSide: c.startSide,
					startLine: c.startLine,
					side: c.side,
					line: c.line,
					startCol: c.startCol ?? null,
					endCol: c.endCol ?? null,
				}
			: {}),
	};
}

/** One new thread being written or posted, as a file shows it. */
export interface NewThreadItem {
	clientId: string;
	span: CodeSpan;
	/** The draft's text ("" while only opened). */
	text: string;
	/** Posted, waiting for GitHub. */
	sending: boolean;
	/** Its box takes focus once shown. */
	focus: boolean;
}

/**
 * Every new thread of the page: drafts (typed in, or posted and waiting)
 * and composers only opened, each once, in the order they were started.
 */
export function newThreadItems(
	drafts: readonly Draft[],
	open: readonly Composer[],
): NewThreadItem[] {
	const items: NewThreadItem[] = [];
	const seen = new Set<string>();
	for (const d of drafts) {
		const span = spanOfDraft(d);
		if (!span || !d.create) continue;
		seen.add(d.create.clientId);
		const opened = open.find((c) => c.clientId === d.create?.clientId);
		items.push({
			clientId: d.create.clientId,
			span,
			text: d.text,
			sending: d.create.sending !== undefined,
			focus: opened?.focus ?? false,
		});
	}
	for (const c of open) {
		if (seen.has(c.clientId)) continue;
		items.push({
			clientId: c.clientId,
			span: c.span,
			text: "",
			sending: false,
			focus: c.focus,
		});
	}
	return items;
}
