import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { AgentStatus } from "../../shared/agent";
import { agentStatusQuery, answerJoin, type JoinAnswer } from "./api";

type JoinRequest = NonNullable<AgentStatus["joinRequest"]>;

/**
 * Answering a session's request to join, as the join bar and the agent
 * modal's Approve step both do: one press posts once; an answer (or one
 * another tab gave first: `stale-join`) marks the request done, hidden
 * until the status moves on; another server's refusal is kept with the
 * request, shown until dismissed. The status is read again either way.
 */
export function useAnswerJoin() {
	const client = useQueryClient();
	// The request this tab answered (or found answered).
	const [done, setDone] = useState<string | null>(null);
	// An Approve another server refused: the request (gone from the status
	// once expired) and why.
	const [refused, setRefused] = useState<{
		request: JoinRequest;
		error: string;
	} | null>(null);
	const inFlight = useRef(false);
	const answer = useMutation({
		mutationFn: (v: { request: JoinRequest; approve: boolean }) =>
			answerJoin(v.request.id, v.approve),
		onSuccess: (result: JoinAnswer, v) => {
			if (result.ok || result.code === "stale-join") setDone(v.request.id);
			else
				setRefused({
					request: v.request,
					error: result.port
						? `Answered by the server on :${result.port}`
						: result.error,
				});
			void client.invalidateQueries({ queryKey: agentStatusQuery.queryKey });
		},
	});
	const press = (request: JoinRequest, approve: boolean) => {
		// Set at once: a second press before the re-render posts nothing.
		if (inFlight.current) return;
		inFlight.current = true;
		answer.mutate(
			{ request, approve },
			{
				onSettled: () => {
					inFlight.current = false;
				},
			},
		);
	};
	return {
		press,
		done,
		/** Hides the request (a refusal's Dismiss). */
		dismiss: setDone,
		refused,
		pending: answer.isPending,
		/** What the press under way answers: true Approve, false Decline. */
		approving: answer.isPending ? answer.variables?.approve : undefined,
		error: answer.error,
	};
}
