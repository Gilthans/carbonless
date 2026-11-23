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
import type { NoLine } from "../files/codeSpan";
import type { Viewing } from "../files/comparison";
import { type CodeSpan, commentAvailable } from "../files/selectionActions";
import type { SinceEarlier } from "../files/threadPlacement";
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
import { commentedFromCard } from "./pendingThread";
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
	/**
	 * The since view: a conversation's span on its compared patch set's
	 * lines that only that patch set had (earlierSpan, CAR-264); absent
	 * elsewhere.
	 */
	earlier?: (span: CodeSpan) => CodeSpan | NoLine | null;
}

/**
 * A conversation's span in the since view whose compared patch set's
 * lines only that patch set had (`early`, from the view's removed rows,
 * CAR-233), as a direct comment on those rows names them: that commit's
 * RIGHT lines, marked `earlier` (CAR-264). Why not when it can't be one:
 * some of its lines still in the head ("mixed"), or its file renamed
 * since (`renamed`: the file shown has lines that patch set's diff adds
 * at another path, and the span is on another path). Null when it isn't
 * on such lines at all (the conversation's usual rules apply).
 */
export function earlierSpan(
	span: CodeSpan,
	early: SinceEarlier | undefined,
	file: { path: string; renamed: boolean },
): CodeSpan | NoLine | null {
	if (!early || span.subject !== "line" || span.commit !== early.head) {
		return null;
	}
	const end = span.line;
	if (end === undefined || span.side !== "RIGHT") return null;
	if ((span.startSide ?? span.side) !== "RIGHT") return null;
	if (span.path !== file.path) return file.renamed ? "renamed" : null;
	const start = span.startLine ?? end;
	let on = 0;
	for (let n = start; n <= end; n++) if (early.row(n) !== null) on++;
	if (on === 0) return null;
	if (on < end - start + 1) return "mixed";
	return { ...span, earlier: true };
}

/**
 * The Files page's move of the comparison's viewed dot (its one
 * comparison): Comment on a conversation asked on another version than
 * the one on screen goes there first, its file (`path`) open. Null
 * elsewhere.
 */
const ShowVersionContext = createContext<
	((v: Viewing, path: string) => void) | null
>(null);
export const ShowVersionProvider = ShowVersionContext.Provider;

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
	/**
	 * Where the conversation's own head stands, when it isn't the one on
	 * screen (versionOf): a version that takes comments today, an
	 * earlier patch set (read-only), or neither.
	 */
	version?: Version;
	/** The merge base of the conversation's head (GitHub's base for it); undefined if unknown. */
	base?: string;
	/** The session (where `base` comes from) isn't read yet. */
	baseLoading?: boolean;
	/**
	 * The since view's take on the span (CommentScope.earlier): on lines
	 * only its compared patch set had, the span a comment goes on there,
	 * or why none can.
	 */
	earlier?: CodeSpan | NoLine;
}

/**
 * Where a head stands for a new comment, as the Files page and the server
 * take one today: `commentable`, the latest patch set's head (the
 * snapshot's before any) or GitHub's head (viewing it, a comment starts
 * its patch set); `read-only`, an earlier patch set's; `unknown`, a
 * commit neither names (pushed over before it became a patch set).
 */
export type Version = "commentable" | "read-only" | "unknown";

export function versionOf(
	session: Pick<SessionInfo, "patchsets" | "head" | "snapshotHead">,
	commit: string,
): Version {
	const latest = session.patchsets.at(-1);
	if (latest ? latest.head === commit : session.snapshotHead === commit) {
		return "commentable";
	}
	if (session.head?.oid === commit) return "commentable";
	if (session.patchsets.some((p) => p.head === commit)) return "read-only";
	return "unknown";
}

/**
 * What another head on screen does to a composer carrying an agent
 * conversation (its span on the conversation's commit): it stays while
 * that version still takes comments (Comment went there; the page shows
 * it again); else as any composer whose head is gone, closed when
 * untyped, kept as an orphan when typed, but never moved to the new
 * head (the link needs the conversation's commit). Undefined while the
 * session isn't read: nothing done yet.
 */
export function onHeadMove(
	session: Pick<SessionInfo, "patchsets" | "head" | "snapshotHead"> | undefined,
	commit: string,
	typed: boolean,
): "stay" | "close" | "orphan" | undefined {
	if (!session) return undefined;
	if (versionOf(session, commit) === "commentable") return "stay";
	return typed ? "orphan" : "close";
}

/**
 * Where the page goes to show `commit` (a version that takes comments):
 * its patch set, else the head.
 */
export function viewingOf(
	session: Pick<SessionInfo, "patchsets">,
	commit: string,
): Viewing {
	const ps = session.patchsets.find((p) => p.head === commit);
	return ps
		? { kind: "patchset", number: ps.number }
		: { kind: "head", oid: commit };
}

const sidesOf = (a: AgentSpanAnchor) =>
	a.subject === "line" ? [a.side, a.startSide] : [];

/**
 * Why a GitHub comment can't go on the conversation's span; true when it
 * can: the Comment action's rules on the conversation's own version (the
 * one on screen, or the one it was asked on: Comment goes there), and
 * old lines only when asked against the base branch (a since view's old
 * lines are a patch set's, not GitHub's base).
 */
export function agentCommentAvailable(
	anchor: AgentSpanAnchor,
	ctx: AgentCommentContext,
): true | string {
	const span = spanOfAnchor(anchor);
	if (ctx.right === undefined) {
		const rule = commentAvailable(span, {
			writes: ctx.writes,
			commentLeft: ctx.commentLeft,
			file: { binary: false, submodule: false },
		});
		return rule === true ? "The PR's head is loading" : rule;
	}
	// On lines only the since view's compared patch set had (CAR-264):
	// as a direct comment on those rows, on that patch set's commit.
	if (ctx.earlier !== undefined) {
		const early = typeof ctx.earlier === "string" ? span : ctx.earlier;
		return commentAvailable(early, {
			writes: ctx.writes,
			commentLeft: ctx.commentLeft,
			file: { binary: false, submodule: false },
			readOnly: ctx.readOnly,
			headUnsure: ctx.headUnsure,
			...(typeof ctx.earlier === "string" ? { noLine: ctx.earlier } : {}),
		});
	}
	const onScreen = anchor.commit === ctx.right;
	// Another version than the one on screen: its own rules, as the page
	// will show it (whether its lines are GitHub's diff isn't known here;
	// taken as yes, as the selection bar does while unknown).
	const rule = commentAvailable(span, {
		writes: ctx.writes,
		commentLeft: ctx.commentLeft,
		file: { binary: false, submodule: false },
		readOnly: onScreen ? ctx.readOnly : ctx.version === "read-only",
		headUnsure: onScreen ? ctx.headUnsure : false,
		inDiff: onScreen ? ctx.inDiff : undefined,
	});
	if (rule !== true) return rule;
	if (!onScreen && ctx.version !== "commentable") {
		return ctx.version === undefined
			? LOADING
			: "Asked on an earlier version: ask again on the latest";
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
	const asked = spanOfAnchor(thread.anchor);
	// On lines only the since view's compared patch set had: commented on
	// there, on that patch set's commit (CAR-264).
	const earlier = scope.earlier?.(asked) ?? undefined;
	const span = typeof earlier === "object" ? earlier : asked;
	const commit = thread.anchor.commit;
	const showVersion = useContext(ShowVersionContext);
	const ok = overview
		? agentCommentAvailable(thread.anchor, {
				writes: overview.writes,
				commentLeft: overview.commentLeft !== false,
				right,
				readOnly,
				headUnsure: !scope.headSure,
				inDiff: scope.inDiff(span),
				// Nowhere to go to another version: none takes the comment.
				version:
					session && (showVersion ? versionOf(session, commit) : "unknown"),
				asked: thread.messages.find((m) => m.by === "human")?.view,
				base: baseOf(session, commit),
				baseLoading: session === undefined,
				earlier,
			})
		: LOADING;
	return {
		ok,
		start: () => {
			if (ok !== true) return;
			clearLinkProblem(thread.id);
			commentedFromCard(thread.id);
			// Asked on another version than the one on screen: the page goes
			// there, where its lines are, and the comment is written (and
			// posted) on it, as any comment on that version is.
			if (session && commit !== right && !span.earlier) {
				showVersion?.(viewingOf(session, commit), span.path);
			}
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
