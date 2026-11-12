import { CheckIcon, PlugIcon, XIcon } from "@primer/octicons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { AgentStatus } from "../../../shared/agent";
import { MCP_HARNESSES, type McpHarness } from "../../../shared/agentHarnesses";
import { boundReviewId } from "../../api";
import { RelativeTime } from "../../RelativeTime";
import { Spinner } from "../../Spinner";
import {
	agentStatusQuery,
	answerJoin,
	type JoinAnswer,
	joinLine,
	joinSetupQuery,
	mcpLine,
} from "../api";
import { approveTip } from "../JoinBar";
import {
	CopyRow,
	ErrorLine,
	PICK,
	PICKED,
	RELOAD_HINT,
	Step,
	UNPICKED,
} from "./parts";

type McpId = McpHarness["id"];

/** The last harness picked on Invite (my call: remembered like the tab). */
export const MCP_HARNESS_KEY = "crb.agentSetup.mcpHarness";

function storedHarness(): McpId {
	try {
		const v = localStorage.getItem(MCP_HARNESS_KEY);
		const h = MCP_HARNESSES.find((x) => x.id === v);
		if (h) return h.id;
	} catch {
		// Storage refused: the default.
	}
	return "claude-code";
}

/**
 * Invite: a session the reviewer already runs joins the review. Step 1
 * adds this crb's /mcp to the session's harness (once per machine), step 2
 * is the sentence to send it, step 3 answers its request to join (the
 * same answer as the join bar's, so either one clears the other).
 */
export function InviteTab(props: { status: AgentStatus }) {
	const setup = useQuery(joinSetupQuery);
	const id = boundReviewId();
	const origin = window.location.origin;
	const [harness, setHarness] = useState<McpId>(storedHarness);
	const pick = (h: McpId) => {
		setHarness(h);
		try {
			localStorage.setItem(MCP_HARNESS_KEY, h);
		} catch {
			// Remembered for this opening only.
		}
	};
	return (
		<>
			<p className="text-sm text-ink-soft">
				Invite a session you already created to join the review.
			</p>
			<Step n={1} title="One-time setup">
				<fieldset className="m-0 min-w-0 border-0 p-0">
					<legend className="sr-only">Harness</legend>
					<div className="flex flex-wrap gap-1.5">
						{MCP_HARNESSES.map((h) => (
							<button
								key={h.id}
								type="button"
								aria-pressed={harness === h.id}
								onClick={() => pick(h.id)}
								className={`${PICK} font-medium whitespace-nowrap ${
									harness === h.id ? PICKED : UNPICKED
								}`}
							>
								{h.label}
							</button>
						))}
					</div>
				</fieldset>
				{setup.data ? (
					<CopyRow
						label="Setup line"
						testId="join-setup-line"
						value={mcpLine(harness, origin, setup.data.key)}
						hint={harness === "claude-code" ? RELOAD_HINT : undefined}
					/>
				) : setup.isError ? (
					<ErrorLine>{setup.error.message}</ErrorLine>
				) : (
					<div aria-busy="true" className="flex h-10 items-center">
						<Spinner label="Loading the setup line" size={14} />
					</div>
				)}
			</Step>
			<Step n={2} title="Invite your agent">
				<p className="text-[13px] text-muted">
					Send this instruction to your agent
				</p>
				{id && (
					<CopyRow
						label="Join line"
						testId="join-line"
						value={joinLine(origin, id)}
					/>
				)}
			</Step>
			<Step n={3} title="Approve">
				{props.status.joinRequest ? (
					<RequestCard
						key={props.status.joinRequest.id}
						status={props.status}
						request={props.status.joinRequest}
					/>
				) : (
					<div
						data-testid="join-request-none"
						className="flex min-h-12 items-center gap-2.5 rounded-lg border border-dashed border-edge px-3.5 text-[13px] text-muted"
					>
						<span
							aria-hidden
							className="size-2 shrink-0 rounded-full border-2 border-line-strong"
						/>
						No agent requesting to join
					</div>
				)}
			</Step>
		</>
	);
}

/**
 * A session's request to join: its name, harness, machine and when it
 * asked, with Decline and Approve (what the join bar posts). A refusal
 * from another server shows here.
 */
function RequestCard(props: {
	status: AgentStatus;
	request: NonNullable<AgentStatus["joinRequest"]>;
}) {
	const { request } = props;
	const client = useQueryClient();
	const inFlight = useRef(false);
	const [refused, setRefused] = useState<string | null>(null);
	const answer = useMutation({
		mutationFn: (approve: boolean) => answerJoin(request.id, approve),
		onSuccess: (result: JoinAnswer) => {
			if (!result.ok && result.code === "elsewhere")
				setRefused(
					result.port
						? `Answered by the server on :${result.port}`
						: result.error,
				);
			void client.invalidateQueries({ queryKey: agentStatusQuery.queryKey });
		},
	});
	const press = (approve: boolean) => {
		// Set at once: a second press before the re-render posts nothing.
		if (inFlight.current) return;
		inFlight.current = true;
		answer.mutate(approve, {
			onSettled: () => {
				inFlight.current = false;
			},
		});
	};
	const tip = approveTip(props.status);
	const busy = answer.isPending;
	const who = [request.harness, request.machine].filter(Boolean).join(" · ");
	return (
		<div
			data-testid="join-request-card"
			className="flex min-w-0 flex-col gap-3 rounded-lg border border-warn bg-raised p-3.5"
		>
			<div className="flex min-w-0 items-start gap-3">
				<span
					aria-hidden
					className="flex size-9 shrink-0 items-center justify-center rounded-full bg-agent-edge text-ink"
				>
					<PlugIcon size={16} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate text-sm font-semibold text-ink">
						{request.name}
					</span>
					<span className="text-xs break-words text-muted">
						{who} · asked <RelativeTime iso={request.at} />
					</span>
					{tip !== "Approve" && (
						<span className="text-xs text-muted">{tip}</span>
					)}
				</div>
				<span className="shrink-0 text-[11px] font-semibold tracking-[0.08em] text-warn uppercase">
					Waiting
				</span>
			</div>
			{(refused || answer.error) && (
				<ErrorLine>{refused ?? answer.error?.message}</ErrorLine>
			)}
			<div className="flex justify-end gap-2">
				<button
					type="button"
					disabled={busy}
					onClick={() => press(false)}
					className="flex h-10 items-center gap-1.5 rounded-md border border-line-strong px-3.5 text-sm font-medium text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
				>
					{busy && answer.variables === false ? (
						<Spinner label="Declining" size={14} />
					) : (
						<XIcon size={16} aria-hidden />
					)}
					Decline
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() => press(true)}
					className="flex h-10 items-center gap-1.5 rounded-md bg-ok-fill px-4 text-sm font-semibold text-canvas hover:brightness-110 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
				>
					{busy && answer.variables === true ? (
						<Spinner label="Approving" size={14} />
					) : (
						<CheckIcon size={16} aria-hidden />
					)}
					Approve
				</button>
			</div>
		</div>
	);
}
