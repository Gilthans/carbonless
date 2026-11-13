import { CheckIcon, PlugIcon, XIcon } from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import type { AgentStatus } from "../../shared/agent";
import { Spinner } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { agentStatusQuery, useAgentOn, useHiddenJoinPoll } from "./api";
import { useAnswerJoin } from "./useAnswerJoin";

/** The hidden tab's title prefix while a session asks to join. */
export const JOIN_TITLE_PREFIX = "⏚ ";

/** `title` with the prefix on or off (never twice). */
export function withJoinPrefix(title: string, on: boolean): string {
	const bare = title.startsWith(JOIN_TITLE_PREFIX)
		? title.slice(JOIN_TITLE_PREFIX.length)
		: title;
	return on ? `${JOIN_TITLE_PREFIX}${bare}` : bare;
}

/**
 * While a session asks to join and the tab is hidden, the tab's title
 * starts with ⏚, so it shows in the tab strip; off once it is answered or
 * the tab is seen.
 */
export function useJoinTitle(pending: boolean): void {
	useEffect(() => {
		const apply = () => {
			const on = pending && document.visibilityState === "hidden";
			const next = withJoinPrefix(document.title, on);
			if (next !== document.title) document.title = next;
		};
		apply();
		document.addEventListener("visibilitychange", apply);
		return () => {
			document.removeEventListener("visibilitychange", apply);
			const bare = withJoinPrefix(document.title, false);
			if (bare !== document.title) document.title = bare;
		};
	}, [pending]);
}

/** What Approve does to the buddy there is now, for its tooltip. */
export function approveTip(status: AgentStatus): string {
	if (status.joined) return `Replaces ${status.joined.name}`;
	const acp =
		status.via !== "mcp" &&
		status.agent &&
		(status.state === "ready" ||
			status.state === "busy" ||
			status.state === "starting");
	return acp && status.agent ? `Replaces ${status.agent.name}` : "Approve";
}

const BUTTON =
	"flex h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 rounded-md text-sm font-semibold focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60 sm:px-3";

/**
 * A session asks to join this review as its buddy: a strip at the top of
 * every page of the review (App puts it above the header, in flow and
 * pinned), with the session's name and machine (its harness in the plug's
 * tooltip), Deny and Approve. One press posts once; the bar goes once
 * answered, or when another tab answered first (409). Another crb server
 * holding the review's agent says so in the bar.
 */
export function JoinBar() {
	const on = useAgentOn();
	const status = useQuery({ ...agentStatusQuery, enabled: on });
	const live = on ? status.data?.joinRequest : undefined;
	const {
		press: answer,
		done,
		dismiss,
		refused,
		pending,
		approving,
		error,
	} = useAnswerJoin();
	const request =
		refused && (!live || live.id === refused.request.id)
			? refused.request
			: live;
	// Hidden, the status isn't polled: the light join poll says.
	const hiddenPoll = useHiddenJoinPoll(on);
	const asking = hiddenPoll ? hiddenPoll.joinRequest : live;
	useJoinTitle(Boolean(asking && asking.id !== done));
	if (!request || request.id === done || !status.data) return null;
	const who = request.harness
		? `${request.name} · ${request.machine} · ${request.harness}`
		: `${request.name} · ${request.machine}`;
	const stopped = refused?.request.id === request.id ? refused.error : null;
	const busy = pending;
	const press = (approve: boolean) => answer(request, approve);
	const tip = approveTip(status.data);
	return (
		<section
			aria-label="Join request"
			data-testid="join-bar"
			className="border-b border-agent-edge bg-agent"
		>
			<div className="mx-auto flex max-w-5xl items-center gap-2 px-3 py-1.5 sm:px-6">
				<Tooltip content={`Asks to join: ${who}`} describe={false}>
					{(trigger) => (
						<span
							{...trigger}
							role="img"
							aria-label={`Asks to join: ${who}`}
							// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
							tabIndex={0}
							className="flex h-10 w-8 shrink-0 cursor-help items-center justify-center rounded-sm text-agent-ink focus-visible:outline-2 focus-visible:outline-accent"
						>
							<PlugIcon size={16} aria-hidden />
						</span>
					)}
				</Tooltip>
				<span className="flex min-w-0 flex-1 flex-col leading-tight">
					<b
						data-testid="join-bar-name"
						className="truncate text-sm font-semibold text-ink"
					>
						{request.name}
					</b>
					<span
						data-testid="join-bar-machine"
						className="truncate text-xs text-agent-ink"
					>
						{request.machine}
					</span>
				</span>
				{stopped ? (
					<>
						<span
							role="alert"
							data-testid="join-bar-error"
							className="min-w-0 text-sm break-words text-bad"
						>
							{stopped}
						</span>
						<Tooltip content="Dismiss" describe={false}>
							{(trigger) => (
								<button
									type="button"
									{...trigger}
									aria-label="Dismiss"
									onClick={() => dismiss(request.id)}
									className={`${BUTTON} w-10 text-ink-soft hover:bg-overlay hover:text-ink sm:px-0`}
								>
									<XIcon aria-hidden />
								</button>
							)}
						</Tooltip>
					</>
				) : (
					<>
						{error && (
							<span role="alert" className="min-w-0 text-xs text-bad">
								{error.message}
							</span>
						)}
						<Tooltip content="Deny" describe={false}>
							{(trigger) => (
								<button
									type="button"
									{...trigger}
									aria-label="Deny"
									data-testid="join-deny"
									disabled={busy}
									onClick={() => press(false)}
									className={`${BUTTON} border border-line-strong text-ink-soft hover:bg-overlay hover:text-ink`}
								>
									{approving === false ? (
										<Spinner label="Denying" size={14} />
									) : (
										<XIcon aria-hidden className="sm:hidden" />
									)}
									<span className="hidden sm:inline">Deny</span>
								</button>
							)}
						</Tooltip>
						<Tooltip content={tip} describe={tip !== "Approve"}>
							{(trigger) => (
								<button
									type="button"
									{...trigger}
									aria-label="Approve"
									data-testid="join-approve"
									disabled={busy}
									onClick={() => press(true)}
									className={`${BUTTON} bg-ok-fill text-canvas hover:brightness-110`}
								>
									{approving === true ? (
										<Spinner label="Approving" size={14} />
									) : (
										<CheckIcon aria-hidden className="sm:hidden" />
									)}
									<span className="hidden sm:inline">Approve</span>
								</button>
							)}
						</Tooltip>
					</>
				)}
			</div>
		</section>
	);
}
