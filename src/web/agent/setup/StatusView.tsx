import {
	PlugIcon,
	SparkleFillIcon,
	SquareFillIcon,
	SyncIcon,
	UnlinkIcon,
} from "@primer/octicons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { AgentStatus, AgentThread } from "../../../shared/agent";
import { RelativeTime } from "../../RelativeTime";
import { useReviewId } from "../../reviewId";
import { SkeletonBar, SpinnerIcon } from "../../Spinner";
import { Tooltip } from "../../Tooltip";
import { landingOf } from "../AgentOverviewRow";
import { ActivityLine } from "../AgentThreadCard";
import {
	agentConfigQuery,
	agentStatusQuery,
	agentThreadsQuery,
	postAgentCancel,
	postAgentDetach,
	postAgentStart,
} from "../api";
import { formatArgs } from "../args";
import { BUTTON, CloseButton, ErrorLine, Footer, SECTION } from "./parts";

/** Stop current's tooltip for a joined session: carbonless can't interrupt its turn. */
export const STOP_IN_SESSION = "Stop it in the session";

/** The state pill: its words, colour and whether it spins. */
function pillOf(status: AgentStatus): {
	label: string;
	tone: string;
	dot: string;
	spin?: boolean;
} {
	// Spawned with no agent configured: nothing will ever start.
	if (unconfigured(status))
		return { label: "Error", tone: "text-bad", dot: "bg-bad" };
	switch (status.state) {
		case "ready":
			return { label: "Ready", tone: "text-ok", dot: "bg-ok" };
		case "busy":
			return { label: "Busy", tone: "text-agent-ink", dot: "bg-agent-ink" };
		case "reconnecting":
			return { label: "Reconnecting", tone: "text-warn", dot: "bg-warn" };
		case "error":
			return { label: "Error", tone: "text-bad", dot: "bg-bad" };
		case "elsewhere":
			return {
				label: `Running in another carbonless${
					status.elsewhere ? ` :${status.elsewhere}` : ""
				}`,
				tone: "text-muted",
				dot: "bg-unreviewed",
			};
		default:
			// Off with the flag set: the runner hasn't taken it up yet.
			return { label: "Starting", tone: "text-muted", dot: "", spin: true };
	}
}

/** Spawned (not joined) with no agent configured: an error, whatever the runner's state. */
const unconfigured = (status: AgentStatus): boolean =>
	!status.joined && Boolean(status.spawned) && !status.configured;

/** A path's last part. */
const fileOf = (path: string) => path.split("/").pop() ?? path;

/** The question a turn answers: the message it names, else the last human one; its first line. */
function questionOf(thread: AgentThread, asked: string | undefined): string {
	const human = thread.messages.filter((m) => m.by === "human");
	const m = (asked && human.find((x) => x.id === asked)) || human.at(-1);
	return m?.text.split("\n")[0]?.trim() ?? "";
}

/**
 * Review Agent: the agent connected to this review (a joined session, or
 * this review's spawned ACP agent). Status (who, its state, since when,
 * last seen, where, leash), Activity (the thread it answers, with its tool
 * calls, or Idle; the questions waiting; Stop current), and the footer's
 * Detach. The view follows the status: once it says no agent, the setup
 * view takes over.
 */
export function StatusView(props: { status: AgentStatus; onClose(): void }) {
	const { status, onClose } = props;
	const client = useQueryClient();
	const joined = status.joined;
	const acp = !joined;
	const config = useQuery({ ...agentConfigQuery, enabled: acp });
	const refresh = () =>
		client.invalidateQueries({ queryKey: agentStatusQuery.queryKey });
	// One write per press, each button its own: set at once, before any
	// re-render.
	const detachFlight = useRef(false);
	const restartFlight = useRef(false);
	const once = (
		flight: { current: boolean },
		run: (opts: { onSettled(): void }) => void,
	) => {
		if (flight.current) return;
		flight.current = true;
		run({
			onSettled: () => {
				flight.current = false;
			},
		});
	};
	// Pressed: "Detaching…" until the status says no agent (this view goes).
	const [detaching, setDetaching] = useState(false);
	// The connected kind changed under a Detach (a joined session's Detach
	// while another server spawned this review's agent): the press is spent.
	const kind = joined ? "joined" : "acp";
	const [detachedKind, setDetachedKind] = useState(kind);
	if (detachedKind !== kind) {
		setDetachedKind(kind);
		setDetaching(false);
	}
	const detach = useMutation({
		mutationFn: postAgentDetach,
		onMutate: () => setDetaching(true),
		onError: () => setDetaching(false),
		onSettled: () => void refresh(),
	});
	const restart = useMutation({
		mutationFn: postAgentStart,
		onSettled: () => void refresh(),
	});
	const error = detach.error ?? restart.error;
	const name = joined
		? joined.name
		: status.agent
			? `${status.agent.name}${status.agent.version ? ` ${status.agent.version}` : ""}`
			: "Agent";
	const pill = pillOf(status);
	// Since when: the join, or the Spawn (never the last state change).
	const connectedAt = joined ? joined.since : status.spawnedAt;
	const failed = status.state === "error";
	const why =
		unconfigured(status) || (failed && !status.configured)
			? "No agent configured"
			: (status.error ?? null);
	const command = config.data?.agent
		? [config.data.agent.command, formatArgs(config.data.agent.args)]
				.filter(Boolean)
				.join(" ")
		: null;
	return (
		<>
			<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto border-t border-line px-4 pt-3.5 pb-5 sm:px-5">
				<section aria-labelledby="agent-status-heading" className="space-y-2.5">
					<h3 id="agent-status-heading" className={SECTION}>
						Status
					</h3>
					<div
						data-testid="agent-status-card"
						className="flex min-w-0 flex-col gap-4 rounded-[10px] border border-agent-edge bg-raised p-4"
					>
						<div className="flex min-w-0 flex-wrap items-center gap-3.5">
							<span
								aria-hidden
								className="flex size-12 shrink-0 items-center justify-center rounded-full bg-agent-edge text-ink shadow-[0_0_0_3px_var(--color-surface),0_0_0_5px_var(--color-agent-ink)]"
							>
								<SparkleFillIcon size={22} />
							</span>
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<span className="truncate text-lg font-bold text-ink">
									{name}
								</span>
								<span className="flex items-center gap-1.5 text-[13px] text-muted">
									{joined ? (
										<PlugIcon size={14} aria-hidden />
									) : (
										<SparkleFillIcon size={14} aria-hidden />
									)}
									{joined ? "Invited · MCP" : "Spawned · ACP"}
								</span>
							</div>
							<span
								data-testid="agent-state"
								className={`inline-flex min-h-[26px] items-center gap-1.5 rounded-full border border-edge bg-surface px-2.5 text-xs font-semibold ${pill.tone}`}
							>
								{pill.spin ? (
									<SpinnerIcon size={12} />
								) : (
									<span
										aria-hidden
										className={`size-2 rounded-full ${pill.dot}`}
									/>
								)}
								{pill.label}
							</span>
						</div>
						<dl className="m-0 grid min-w-0 grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
							{connectedAt && (
								<Fact term="Connected">
									<RelativeTime iso={connectedAt} />
								</Fact>
							)}
							<Fact term="Last seen">
								{status.seen ? (
									<RelativeTime iso={status.seen} />
								) : (
									<span className="text-muted">—</span>
								)}
							</Fact>
							{joined ? (
								<Fact term="Machine">
									<span className="block truncate">
										{[joined.machine, joined.harness]
											.filter(Boolean)
											.join(" · ")}
									</span>
								</Fact>
							) : (
								<Fact term="Command">
									{command !== null ? (
										<span className="block truncate font-mono text-xs">
											{command}
										</span>
									) : config.isPending ? (
										<span
											aria-busy="true"
											aria-label="Loading the command"
											role="status"
											className="flex h-5 items-center"
										>
											<SkeletonBar className="w-28" />
										</span>
									) : (
										<span className="text-muted">—</span>
									)}
								</Fact>
							)}
							<Fact term="Leash">
								<span className="flex items-center gap-1.5">
									open
									<span aria-hidden className="size-2 rounded-full bg-ok" />
								</span>
							</Fact>
						</dl>
					</div>
					{why && <ErrorLine testId="agent-error">{why}</ErrorLine>}
				</section>
				<Activity status={status} onClose={onClose} />
			</div>
			<Footer>
				<button
					type="button"
					data-testid="agent-detach"
					disabled={detaching}
					onClick={() => once(detachFlight, (o) => detach.mutate(undefined, o))}
					className={`${BUTTON} border-bad font-semibold text-bad hover:bg-bad/10 hover:text-bad disabled:text-bad disabled:opacity-60`}
				>
					{detaching ? (
						<SpinnerIcon size={14} />
					) : (
						<UnlinkIcon size={14} aria-hidden />
					)}
					{detaching ? "Detaching…" : "Detach"}
				</button>
				{failed && status.spawned && (
					<button
						type="button"
						data-testid="agent-restart"
						disabled={restart.isPending}
						onClick={() =>
							once(restartFlight, (o) => restart.mutate(undefined, o))
						}
						className={BUTTON}
					>
						{restart.isPending ? (
							<SpinnerIcon size={14} />
						) : (
							<SyncIcon size={14} aria-hidden />
						)}
						Restart
					</button>
				)}
				{error && <ErrorLine>{error.message}</ErrorLine>}
				<CloseButton onClose={onClose} />
			</Footer>
		</>
	);
}

function Fact(props: { term: string; children: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<dt className="text-xs text-faint">{props.term}</dt>
			<dd className="m-0 min-w-0 text-sm text-ink">{props.children}</dd>
		</div>
	);
}

/**
 * What the agent is doing: the thread it answers (a link that closes the
 * modal and goes there), with an ACP agent's tool calls, or Idle; how many
 * questions wait besides; and Stop current (an ACP reply only: a joined
 * session's turn is stopped in the session).
 */
function Activity(props: { status: AgentStatus; onClose(): void }) {
	const { status, onClose } = props;
	const client = useQueryClient();
	const answering = status.answering;
	const joined = Boolean(status.joined);
	const waiting = Math.max(0, status.waiting - (answering ? 1 : 0));
	const threads = useQuery({
		...agentThreadsQuery,
		enabled: Boolean(answering),
	});
	const thread = answering
		? threads.data?.threads.find((t) => t.id === answering.thread)
		: undefined;
	const inFlight = useRef(false);
	const stop = useMutation({
		mutationFn: postAgentCancel,
		onSettled: () => {
			inFlight.current = false;
			void client.invalidateQueries({ queryKey: agentStatusQuery.queryKey });
		},
	});
	return (
		<section aria-labelledby="agent-activity-heading" className="space-y-2.5">
			<div className="flex items-center gap-2">
				<h3 id="agent-activity-heading" className={SECTION}>
					Activity
				</h3>
				<span
					data-testid="agent-waiting-count"
					title={`${waiting} ${waiting === 1 ? "thread" : "threads"} waiting for the agent`}
					className={`inline-flex h-[22px] items-center rounded-full px-2 text-xs font-semibold ${
						waiting > 0 ? "bg-warn/15 text-warn" : "bg-overlay text-muted"
					}`}
				>
					{waiting} waiting
				</span>
			</div>
			<div className="flex min-w-0 flex-col gap-3 rounded-[10px] border border-line bg-raised px-4 py-3.5">
				{answering ? (
					<div className="flex min-w-0 flex-col gap-1">
						<div className="flex min-w-0 items-start gap-2.5 text-sm text-ink">
							<SpinnerIcon size={16} className="mt-0.5 text-agent-ink" />
							<span className="min-w-0 break-words">
								Responding to{" "}
								{thread ? (
									<ThreadLink thread={thread} onClose={onClose} />
								) : threads.isError ? (
									<span className="text-bad">{threads.error.message}</span>
								) : (
									<span
										role="status"
										aria-label="Loading the thread"
										aria-busy="true"
										className="inline-flex h-4 w-24 align-middle"
									>
										<SkeletonBar className="w-24" />
									</span>
								)}{" "}
								{thread && (
									<span
										data-testid="agent-answering-question"
										className="text-muted"
									>
										“{questionOf(thread, answering.asked)}”
									</span>
								)}
							</span>
						</div>
						{!joined && (
							<div className="pl-6">
								<ActivityLine activity={answering.activity} />
							</div>
						)}
					</div>
				) : (
					<div className="flex items-center gap-2.5 text-sm text-muted">
						<span aria-hidden className="size-2 rounded-full bg-unreviewed" />
						Idle
					</div>
				)}
				<div className="flex justify-end">
					{joined ? (
						<Tooltip content={STOP_IN_SESSION}>
							{(trigger) => (
								<button
									type="button"
									{...trigger}
									aria-disabled="true"
									data-testid="agent-stop"
									className={`${BUTTON} cursor-not-allowed border-line text-faint hover:bg-transparent hover:text-faint`}
								>
									<SquareFillIcon size={14} aria-hidden />
									Stop current
								</button>
							)}
						</Tooltip>
					) : (
						<button
							type="button"
							data-testid="agent-stop"
							disabled={!answering || stop.isPending}
							onClick={() => {
								if (inFlight.current) return;
								inFlight.current = true;
								stop.mutate();
							}}
							className={`${BUTTON} disabled:border-line`}
						>
							{stop.isPending ? (
								<SpinnerIcon size={14} />
							) : (
								<SquareFillIcon size={14} aria-hidden />
							)}
							Stop current
						</button>
					)}
				</div>
				{stop.error && <ErrorLine>{stop.error.message}</ErrorLine>}
			</div>
		</section>
	);
}

/** The thread answered, as `file:line`, going to it in Files changed (the modal closes). */
function ThreadLink(props: { thread: AgentThread; onClose(): void }) {
	const id = useReviewId();
	const a = props.thread.anchor;
	const line = "line" in a && a.line !== undefined ? `:${a.line}` : "";
	return (
		<Link
			to="/r/$id/files"
			params={{ id }}
			search={landingOf(props.thread)}
			onClick={props.onClose}
			aria-label={`${a.path}${line}`}
			className="font-mono text-[13px] text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
		>
			{fileOf(a.path)}
			{line}
		</Link>
	);
}
