import { SparkleFillIcon } from "@primer/octicons-react";
import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { AgentStatus } from "../../shared/agent";
import { ApiError, overviewQuery } from "../api";
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
 * Keeps the agent threads in step with the status: whenever its state
 * (or when it last changed), the thread being answered or the waiting count
 * moves, the threads are read again (a reply landed, a question was taken
 * up).
 */
export function useAgentSync(
	client: QueryClient,
	status: AgentStatus | undefined,
): void {
	// `since` moves on every state change: a turn that began and ended
	// between two polls still shows.
	const key = status
		? `${status.state}|${status.since}|${status.answering?.thread ?? ""}|${status.waiting}`
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

/** The chip's icon colour: the status dot's, as text (agentDot). */
export function agentInk(status: AgentStatus): string {
	switch (agentDot(status)) {
		case "bg-bad":
			return "text-bad";
		case "bg-ok":
			return "text-ok";
		case "bg-warn":
			return "text-warn";
		default:
			return "text-unreviewed";
	}
}

/** The chip's one size, wherever it is (and the space kept for it). */
export const CHIP_BOX = "flex h-10 w-7 shrink-0 items-center justify-center";

/**
 * Whether the header keeps a place for the chip: from the first paint
 * (the overview, which says whether there is an agent, still on its way),
 * until known to have none (as of a cutoff, --viewer, no agent).
 */
export function useAgentChipPlace(asOf: boolean): boolean {
	const overview = useQuery({ ...overviewQuery, enabled: false });
	const on = overview.data?.writes === "on";
	// Reads what the chip read; never asks itself (no chip, no read).
	const status = useQuery({ ...agentStatusQuery, enabled: false });
	if (asOf) return false;
	if (overview.data && !on) return false;
	return !(status.error instanceof ApiError && status.error.status === 404);
}

/**
 * The reviewer's agent in the header, by the logo (in the sticky row,
 * beside the compact mark, once scrolled): the sparkle alone, coloured by
 * its status; the name and detail in the tooltip. One size in every state
 * (CHIP_BOX). Pressing it opens the agent setup in every state. Until the
 * overview says whether there is an agent, and on its first read, a
 * spinner in the icon's place; a routine poll changes nothing unless the
 * answer does. None where the review has no agent (--viewer, --as-of).
 */
export function AgentChip({
	dismissKey,
	asOf = false,
}: {
	/** Closes the tooltip whenever it changes (the chip moved). */
	dismissKey?: unknown;
	/** As of a cutoff (the session says): no agent, no place for one. */
	asOf?: boolean;
} = {}) {
	const client = useQueryClient();
	const on = useAgentOn();
	const status = useQuery({ ...agentStatusQuery, enabled: on });
	const place = useAgentChipPlace(asOf);
	useAgentSync(client, status.data);
	if (!place) return null;
	if (!on) {
		// Whether there is an agent isn't known yet: its place, spinning.
		return (
			<span
				aria-hidden
				data-chip-space
				data-testid="agent-chip-pending"
				className={CHIP_BOX}
			>
				<SpinnerIcon size={16} className="text-muted" />
			</span>
		);
	}
	const data = status.data;
	const tip = data
		? agentTip(data)
		: status.error
			? status.error.message
			: "Loading your agent";
	return (
		<Tooltip content={tip} describe={false} dismissKey={dismissKey}>
			{(trigger) => (
				<button
					type="button"
					{...trigger}
					data-testid="agent-chip"
					data-state={data?.state}
					aria-label={`Your agent: ${tip}`}
					aria-busy={status.isPending || undefined}
					onClick={openAgentSetup}
					className={`${CHIP_BOX} rounded-full hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent`}
				>
					{status.isPending ? (
						<span data-testid="agent-chip-loading" className="flex">
							<SpinnerIcon size={16} className="text-muted" />
						</span>
					) : (
						<span
							data-testid="agent-chip-icon"
							className={`flex ${data ? agentInk(data) : "text-bad"}`}
						>
							<SparkleFillIcon size={16} aria-hidden />
						</span>
					)}
				</button>
			)}
		</Tooltip>
	);
}
