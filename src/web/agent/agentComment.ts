/**
 * Comment on an agent conversation's card: a new GitHub thread on the
 * conversation's span. Once GitHub has it, the server moves the
 * conversation onto it (agent-thread-linked): it shows behind that
 * thread's agent button from then on.
 */
import { useQuery } from "@tanstack/react-query";
import type { AgentAnchor, AgentThread } from "../../shared/agent";
import type { PrOverview } from "../../shared/types";
import { overviewQuery, sessionQuery } from "../api";
import { commentAvailable } from "../files/selectionActions";
import { newClientId, openComposer } from "../threads/newThreads";
import { spanOfAnchor } from "./askAgentAction";
import { useSendView } from "./threadAgent";

export interface AgentCommentContext {
	writes: PrOverview["writes"];
	commentLeft: boolean;
	/** The head of the comparison on screen; undefined while unknown. */
	right: string | undefined;
	/** An earlier patch set is on screen. */
	readOnly: boolean;
}

/**
 * Why a GitHub comment can't go on the conversation's span; true when it
 * can: the Comment action's rules, and the span must be on the head shown.
 */
export function agentCommentAvailable(
	anchor: AgentAnchor,
	ctx: AgentCommentContext,
): true | string {
	const span = spanOfAnchor(anchor);
	const rule = commentAvailable(span, {
		writes: ctx.writes,
		commentLeft: ctx.commentLeft,
		file: { binary: false, submodule: false },
		readOnly: ctx.readOnly,
	});
	if (rule !== true) return rule;
	if (ctx.right === undefined) return "The PR's head is loading";
	if (anchor.commit !== ctx.right) {
		return "Asked on an earlier version: ask again on the latest";
	}
	return true;
}

/** The card's Comment: whether it can run (or why not), and its start. */
export function useAgentComment(thread: AgentThread): {
	ok: true | string;
	start: () => void;
} {
	const overview = useQuery({ ...overviewQuery, enabled: false }).data;
	const session = useQuery({ ...sessionQuery, enabled: false }).data;
	const view = useSendView();
	const latest = session?.patchsets?.at(-1)?.number;
	const t = view.target;
	const right =
		"head" in t
			? t.head || session?.snapshotHead
			: session?.patchsets?.find((p) => p.number === t.patchset)?.head;
	const readOnly =
		"patchset" in t && latest !== undefined && t.patchset < latest;
	const ok = overview
		? agentCommentAvailable(thread.anchor, {
				writes: overview.writes,
				commentLeft: overview.commentLeft !== false,
				right,
				readOnly,
			})
		: "The PR is loading";
	return {
		ok,
		start: () => {
			if (ok !== true) return;
			openComposer(spanOfAnchor(thread.anchor), newClientId(), thread.id);
		},
	};
}
