import { SparkleFillIcon } from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../api";
import { SkeletonBar } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { agentDot, agentTip } from "./AgentChip";
import { agentStatusQuery, agentThreadsQuery } from "./api";
import { openAgentSetup } from "./setupStore";

/**
 * The reviewer's agent threads in "Is it ready", one band after the thread
 * groups: how many are open and how many wait for an answer, with the
 * chip's dot; with no agent set up, the button that sets one up. A
 * skeleton while they load, never a 0. None where the review has no agent.
 */
export function AgentOverviewRow() {
	const status = useQuery(agentStatusQuery);
	const threads = useQuery(agentThreadsQuery);
	if (
		(status.error instanceof ApiError && status.error.status === 404) ||
		(threads.error instanceof ApiError && threads.error.status === 404)
	) {
		return null;
	}
	const list = threads.data?.threads;
	const open = list?.filter((t) => !t.resolved).length ?? 0;
	const waiting = list?.filter((t) => !t.resolved && t.waiting).length ?? 0;
	const s = status.data;
	return (
		<section
			aria-label="Agent threads"
			data-testid="agent-overview-row"
			className="-mx-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-line bg-band px-4 py-1"
		>
			<h3 className="flex min-h-10 items-center gap-2 text-base font-semibold text-ink">
				<SparkleFillIcon size={18} aria-hidden className="text-agent-ink" />
				Agent threads
			</h3>
			{list === undefined ? (
				threads.isError ? (
					<span role="alert" className="text-sm text-bad">
						{threads.error.message}
					</span>
				) : (
					<SkeletonBar className="w-32" />
				)
			) : (
				<span
					data-testid="agent-overview-counts"
					className="text-sm text-muted"
				>
					{open} open · {waiting} waiting
				</span>
			)}
			{s?.configured ? (
				<Tooltip content={agentTip(s)} describe={false}>
					{(trigger) => (
						<button
							type="button"
							{...trigger}
							aria-label={`Your agent: ${agentTip(s)}`}
							onClick={openAgentSetup}
							className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
						>
							<span
								aria-hidden
								className={`h-2 w-2 rounded-full ${agentDot(s)}`}
							/>
						</button>
					)}
				</Tooltip>
			) : s ? (
				<button
					type="button"
					onClick={openAgentSetup}
					className="ml-auto flex h-10 items-center gap-1.5 rounded-md border border-agent-edge bg-agent px-3 text-sm font-medium text-agent-ink hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
				>
					<SparkleFillIcon size={16} aria-hidden />
					Set up an agent
				</button>
			) : null}
		</section>
	);
}
