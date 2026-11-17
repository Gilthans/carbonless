/**
 * Comment on an agent conversation's card: a new GitHub thread on the
 * conversation's span. Once GitHub has it, the server moves the
 * conversation onto it (agent-thread-linked): it shows behind that
 * thread's agent button from then on.
 */
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import type {
	AgentSpanAnchor,
	AgentView,
	SpanAgentThread,
} from "../../shared/agent";
import type { DisplayHunk, PrOverview, SessionInfo } from "../../shared/types";
import { overviewQuery, sessionQuery } from "../api";
import { type CodeSpan, commentAvailable } from "../files/selectionActions";
import { LOADING } from "../threads/NewThread";
import {
	closeComposer,
	getComposers,
	newThreadItems,
	openComposer,
	sameSpan,
	targetOf,
} from "../threads/newThreads";
import { useThreadWriter } from "../threads/threadWrites";
import { spanOfAnchor } from "./askAgentAction";
import { clearLinkProblem } from "./linkProblems";
import { useSendView } from "./threadAgent";

/**
 * Where Comment can open a composer that shows: a file's diff in Files
 * changed. `headSure`: the diff on screen is the viewed head's;
 * `inDiff`: whether a span's ends are lines of GitHub's diff (undefined
 * while unknown, taken as yes, as the selection bar does).
 */
export interface CommentScope {
	headSure: boolean;
	inDiff: (span: CodeSpan) => boolean | undefined;
}

const CommentScopeContext = createContext<CommentScope | null>(null);
export const CommentScopeProvider = CommentScopeContext.Provider;
/** The scope cards are shown in; null outside Files changed's diff (no Comment). */
export const useCommentScope = () => useContext(CommentScopeContext);

/** Whether both ends of a line span are rows of `hunks` (GitHub's diff); a file span is. */
export function spanInHunks(
	span: CodeSpan,
	hunks: readonly DisplayHunk[],
): boolean {
	if (span.subject === "file") return true;
	const has = (side: CodeSpan["side"], n: number | undefined) =>
		n !== undefined &&
		hunks.some((h) =>
			h.lines.some((l) => (side === "LEFT" ? l.oldNo : l.newNo) === n),
		);
	return (
		has(span.side, span.line) &&
		has(span.startSide ?? span.side, span.startLine ?? span.line)
	);
}

export interface AgentCommentContext {
	writes: PrOverview["writes"];
	commentLeft: boolean;
	/** The head of the comparison on screen; undefined while unknown. */
	right: string | undefined;
	/** An earlier patch set is on screen. */
	readOnly: boolean;
	/** The diff on screen isn't the viewed head's yet. */
	headUnsure?: boolean;
	/** Both ends of the span are lines of GitHub's diff (undefined: unknown). */
	inDiff?: boolean;
	/**
	 * The comparison the conversation was first asked in (its first
	 * question's view): old lines name GitHub's base only when that was the
	 * base branch, at the merge base it has now.
	 */
	asked?: AgentView;
	/** The merge base of the head shown (GitHub's base for it); undefined if unknown. */
	base?: string;
	/** The session (where `base` comes from) isn't read yet. */
	baseLoading?: boolean;
}

const sidesOf = (a: AgentSpanAnchor) =>
	a.subject === "line" ? [a.side, a.startSide] : [];

/**
 * Why a GitHub comment can't go on the conversation's span; true when it
 * can: the Comment action's rules, the span on the head shown, and old
 * lines only when asked against the base branch (a since view's old lines
 * are a patch set's, not GitHub's base).
 */
export function agentCommentAvailable(
	anchor: AgentSpanAnchor,
	ctx: AgentCommentContext,
): true | string {
	const span = spanOfAnchor(anchor);
	const rule = commentAvailable(span, {
		writes: ctx.writes,
		commentLeft: ctx.commentLeft,
		file: { binary: false, submodule: false },
		readOnly: ctx.readOnly,
		headUnsure: ctx.headUnsure,
		inDiff: ctx.inDiff,
	});
	if (rule !== true) return rule;
	if (ctx.right === undefined) return "The PR's head is loading";
	if (anchor.commit !== ctx.right) {
		return "Asked on an earlier version: ask again on the latest";
	}
	if (sidesOf(anchor).includes("LEFT")) {
		const asked = ctx.asked;
		// No question with its comparison (one the agent opened, or older).
		if (!asked) return "Old lines: not known to be the base branch's";
		if (!("branch" in asked.from)) {
			return "Old lines asked against a patch set, not the base branch";
		}
		if (ctx.base === undefined && ctx.baseLoading) return LOADING;
		if (ctx.base === undefined || asked.left !== ctx.base) {
			return "Old lines asked against an earlier base";
		}
	}
	return true;
}

/**
 * The merge base of head `right`: its patch set's, else GitHub's head's
 * when that is it, else the snapshot's when it is the snapshot's head.
 */
export function baseOf(
	session:
		| Pick<SessionInfo, "patchsets" | "head" | "snapshotHead" | "snapshotBase">
		| undefined,
	right: string | undefined,
): string | undefined {
	if (!session || right === undefined) return undefined;
	return (
		session.patchsets.find((p) => p.head === right)?.mergeBase ??
		(session.head?.oid === right ? session.head.mergeBase : undefined) ??
		(session.snapshotHead === right ? session.snapshotBase : undefined)
	);
}

/**
 * The card's Comment: whether it can run (or why not), and its start: the
 * composer on the span, carrying the conversation; a plain comment
 * already written there (open or typed) is adopted, its text kept.
 */
export function useAgentComment(
	thread: SpanAgentThread,
	scope: CommentScope,
): { ok: true | string; start: () => void } {
	const overview = useQuery({ ...overviewQuery, enabled: false }).data;
	const session = useQuery({ ...sessionQuery, enabled: false }).data;
	const writer = useThreadWriter();
	const view = useSendView();
	const latest = session?.patchsets?.at(-1)?.number;
	const t = view.target;
	const right =
		"head" in t
			? t.head || session?.snapshotHead
			: session?.patchsets?.find((p) => p.number === t.patchset)?.head;
	const readOnly =
		"patchset" in t && latest !== undefined && t.patchset < latest;
	const span = spanOfAnchor(thread.anchor);
	const ok = overview
		? agentCommentAvailable(thread.anchor, {
				writes: overview.writes,
				commentLeft: overview.commentLeft !== false,
				right,
				readOnly,
				headUnsure: !scope.headSure,
				inDiff: scope.inDiff(span),
				asked: thread.messages.find((m) => m.by === "human")?.view,
				base: baseOf(session, right),
				baseLoading: session === undefined,
			})
		: LOADING;
	return {
		ok,
		start: () => {
			if (ok !== true) return;
			clearLinkProblem(thread.id);
			// A plain comment typed on the span takes the conversation along.
			const typed = newThreadItems(writer.drafts.get(), []).find(
				(i) => sameSpan(i.span, span) && !i.agentThread && !i.sending,
			);
			const draft = typed && writer.drafts.newThread(typed.clientId);
			if (typed && draft?.create) {
				writer.drafts.setNew(
					typed.clientId,
					targetOf(typed.span, thread.id),
					draft.text,
					draft.create.texts,
				);
				// Empty plain composers there would be a second box: gone.
				for (const c of getComposers()) {
					if (
						c.clientId !== typed.clientId &&
						!c.agentThread &&
						sameSpan(c.span, span) &&
						!writer.drafts.newThread(c.clientId)
					) {
						closeComposer(c.clientId);
					}
				}
				openComposer(typed.span, typed.clientId, thread.id);
				return;
			}
			openComposer(span, undefined, thread.id);
		},
	};
}
