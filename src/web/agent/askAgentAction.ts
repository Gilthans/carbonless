/**
 * Ask agent: a selection's second action, beside Comment. It opens a
 * composer under the span (one per span, like newThreads.ts); what is
 * asked goes to the reviewer's own agent (agentWrites.ts), never to GitHub.
 */
import { SparkleFillIcon } from "@primer/octicons-react";
import { useSyncExternalStore } from "react";
import type { AgentAnchor } from "../../shared/agent";
import {
	type CodeSpan,
	HEAD_UNSURE,
	type SelectionAction,
	type SelectionContext,
} from "../files/selectionActions";
import { newClientId, sameSpan } from "../threads/newThreads";

/** Why the agent can't be asked here; true when it can. */
export function askAgentAvailable(
	span: CodeSpan,
	ctx: Pick<SelectionContext, "writes" | "headUnsure">,
): true | string {
	if (ctx.writes === "as-of") return "Your agent is off as of a cutoff";
	if (ctx.writes === "viewer") {
		return "Your agent is off when viewing as someone else";
	}
	if (ctx.headUnsure && span.subject !== "file") return HEAD_UNSURE;
	// Any line (expanded context, old lines) or file: no GitHub rule applies,
	// and with no agent attached the thread waits.
	return true;
}

export const ASK_AGENT_ACTION: SelectionAction = {
	id: "ask-agent",
	icon: SparkleFillIcon,
	iconClassName: "text-agent-ink",
	label: "Ask agent",
	shortcut: "a",
	available: askAgentAvailable,
	start: (span) => {
		openAgentComposer(span);
	},
};

/** An opened Ask agent composer: its span, what is typed, whether it takes focus. */
export interface AgentComposerItem {
	clientId: string;
	span: CodeSpan;
	text: string;
	focus: boolean;
}

let composers: readonly AgentComposerItem[] = [];
const listeners = new Set<() => void>();
const changed = (next: readonly AgentComposerItem[]) => {
	composers = next;
	for (const l of listeners) l();
};

/** Opens a composer on the span (the open one again, focused); its client id. */
export function openAgentComposer(span: CodeSpan, id = newClientId()): string {
	const same = composers.find((c) => sameSpan(c.span, span));
	if (same) {
		changed(composers.map((c) => (c === same ? { ...c, focus: true } : c)));
		return same.clientId;
	}
	changed([...composers, { clientId: id, span, text: "", focus: true }]);
	return id;
}

export function closeAgentComposer(id: string): void {
	if (!composers.some((c) => c.clientId === id)) return;
	changed(composers.filter((c) => c.clientId !== id));
}

/** What is typed, kept while the row scrolls out of view. */
export function setAgentComposerText(id: string, text: string): void {
	changed(composers.map((c) => (c.clientId === id ? { ...c, text } : c)));
}

/** Its box took focus: not again on a later render. */
export function agentComposerFocused(id: string): void {
	if (!composers.some((c) => c.clientId === id && c.focus)) return;
	changed(
		composers.map((c) => (c.clientId === id ? { ...c, focus: false } : c)),
	);
}

export const getAgentComposers = (): readonly AgentComposerItem[] => composers;

/** Forgets every composer (tests). */
export function resetAgentComposers(): void {
	changed([]);
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
};

export function useAgentComposers(): readonly AgentComposerItem[] {
	return useSyncExternalStore(subscribe, getAgentComposers, getAgentComposers);
}

/** The span as the server stores it; null when a line span lacks its ends. */
export function anchorOf(span: CodeSpan): AgentAnchor | null {
	if (span.subject === "file") {
		return { subject: "file", path: span.path, commit: span.commit };
	}
	const { side, line } = span;
	if (side === undefined || line === undefined) return null;
	return {
		subject: "line",
		path: span.path,
		commit: span.commit,
		side,
		line,
		startSide: span.startSide ?? side,
		startLine: span.startLine ?? line,
		...(span.startCol != null && span.endCol != null
			? { startCol: span.startCol, endCol: span.endCol }
			: {}),
	};
}

/** A stored anchor as a span (to place and quote a thread). */
export function spanOfAnchor(anchor: AgentAnchor): CodeSpan {
	if (anchor.subject === "file") {
		return { path: anchor.path, commit: anchor.commit, subject: "file" };
	}
	if (anchor.subject === "thread") {
		// The span GitHub gave the thread; without lines, its file.
		if (
			anchor.side === undefined ||
			anchor.line === undefined ||
			anchor.startLine === undefined
		) {
			return { path: anchor.path, commit: anchor.commit, subject: "file" };
		}
		return {
			path: anchor.path,
			commit: anchor.commit,
			subject: "line",
			side: anchor.side,
			line: anchor.line,
			startSide: anchor.startSide ?? anchor.side,
			startLine: anchor.startLine,
			startCol: null,
			endCol: null,
		};
	}
	return {
		path: anchor.path,
		commit: anchor.commit,
		subject: "line",
		side: anchor.side,
		line: anchor.line,
		startSide: anchor.startSide,
		startLine: anchor.startLine,
		startCol: anchor.startCol ?? null,
		endCol: anchor.endCol ?? null,
	};
}
