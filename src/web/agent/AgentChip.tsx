import { SparkleFillIcon } from "@primer/octicons-react";
import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { AgentStatus } from "../../shared/agent";
import { ApiError } from "../api";
import { plural } from "../overview/parts";
import { SpinnerIcon } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { agentStatusQuery, agentThreadsQuery, useAgentOn } from "./api";
import { openAgentSetup } from "./setupStore";

/** The status dot's colour: muted off or elsewhere, yellow on its way or busy, green ready, red failing. */
export function agentDot(status: AgentStatus): string {
	if (status.state === "error" || status.error) return "bg-bad";
	if (status.state === "ready") return "bg-ok";
	if (status.state === "starting" || status.state === "busy") return "bg-warn";
	return "bg-unreviewed";
}

/** What the chip's tooltip says of the status. */
export function agentTip(status: AgentStatus): string {
	const who = status.agent
		? `${status.agent.name}${status.agent.version ? ` ${status.agent.version}` : ""}`
		: "";
	if (status.error) return status.error;
	switch (status.state) {
		case "off":
			return "No agent · set one up";
		case "starting":
			return who ? `${who} · starting` : "Starting";
		case "busy": {
			const n = Math.max(1, status.waiting);
			const doing = `answering ${plural(n, "thread")}`;
			return who ? `${who} · ${doing}` : doing;
		}
		case "elsewhere":
			return status.elsewhere
				? `answered by the server on :${status.elsewhere}`
				: "answered by another server";
		case "error":
			return "The agent failed";
		default:
			return who || "Ready";
	}
}

/**
 * Keeps the agent threads in step with the status: whenever its state, the
 * thread being answered or the waiting count moves, the threads are read
 * again (a reply landed, a question was taken up).
 */
export function useAgentSync(
	client: QueryClient,
	status: AgentStatus | undefined,
): void {
	const key = status
		? `${status.state}|${status.answering?.thread ?? ""}|${status.waiting}`
		: "";
	const last = useRef(key);
	useEffect(() => {
		if (!key || key === last.current) return;
		const first = last.current === "";
		last.current = key;
		if (first) return;
		void client.invalidateQueries({
			queryKey: agentThreadsQuery.queryKey,
			exact: true,
		});
	}, [key, client]);
}

/**
 * The reviewer's agent in the header's meta line: the sparkle, its name
 * (the dot alone on a phone) and a status dot, the detail in the tooltip.
 * Pressing it opens the agent setup in every state. Its first read shows a
 * spinner in the dot's place; a routine poll changes nothing unless the
 * answer does. None where the review has no agent (--viewer, --as-of).
 */
export function AgentChip() {
	const client = useQueryClient();
	const on = useAgentOn();
	const status = useQuery({ ...agentStatusQuery, enabled: on });
	useAgentSync(client, status.data);
	if (
		!on ||
		(status.error instanceof ApiError && status.error.status === 404)
	) {
		return null;
	}
	const data = status.data;
	const tip = data
		? agentTip(data)
		: status.error
			? status.error.message
			: "Loading your agent";
	const off = !data || data.state === "off" || data.state === "elsewhere";
	const name = data?.agent?.name;
	return (
		<Tooltip content={tip} describe={false}>
			{(trigger) => (
				<button
					type="button"
					{...trigger}
					data-testid="agent-chip"
					data-state={data?.state}
					aria-label={`Your agent: ${tip}`}
					aria-busy={status.isPending || undefined}
					onClick={openAgentSetup}
					className="inline-flex min-h-10 items-center rounded-full focus-visible:outline-2 focus-visible:outline-accent sm:min-h-0"
				>
					<span className="inline-flex min-h-6 items-center gap-1.5 rounded-full border border-line bg-raised px-2 text-xs text-ink-soft hover:text-ink">
						<SparkleFillIcon
							size={14}
							aria-hidden
							className={`text-agent-ink ${off ? "opacity-50" : ""}`}
						/>
						{name && (
							<span className="hidden max-w-[10rem] truncate sm:inline">
								{name}
							</span>
						)}
						{status.isPending ? (
							<SpinnerIcon size={10} className="text-muted" />
						) : (
							<span
								aria-hidden
								data-testid="agent-chip-dot"
								className={`h-2 w-2 shrink-0 rounded-full ${
									data ? agentDot(data) : "bg-bad"
								}`}
							/>
						)}
					</span>
				</button>
			)}
		</Tooltip>
	);
}
