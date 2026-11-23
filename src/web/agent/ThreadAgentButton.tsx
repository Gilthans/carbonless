import { AlertIcon, SparkleFillIcon } from "@primer/octicons-react";
import type { MouseEvent, ReactNode } from "react";
import type { AgentThread } from "../../shared/agent";
import type { ReviewThread } from "../../shared/types";
import { Spinner } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { useAgentOn } from "./api";
import { ASK_HANDLE, HANDLE } from "./handle";
import {
	agentButtonName,
	agentFor,
	useAgentThreadsFailed,
	useAgentThreadsLoading,
	useThreadAgentContext,
} from "./threadAgent";

/**
 * A press leaves the focus where it is: beside the composer, taking it
 * would fold the box (it closes on blur) and move the handle out from
 * under the pointer before the click lands. The toggle then puts the
 * focus where it belongs (the composer, or the handle).
 */
const keepFocus = (e: MouseEvent) => e.preventDefault();

/**
 * A thread card's agent handle, at the right end of its bottom row
 * (ThreadActions, beside Resolve; the Show more row where that row is
 * closed): the teal handle with the sparkle and the number of messages
 * in the thread's agent conversation, an `accent` dot while one of the
 * agent's is unseen; a dashed sparkle on a light wash ("Ask agent")
 * before there is one. Pressed while the conversation is open: the
 * panel's handle. A spinner in its place while the agent threads load
 * (never "Ask agent" that would then turn into a count); an alert in
 * `bad` when they couldn't be read, still pressable (it reads them again,
 * and opens the panel when closed; open, it stays open). Absent on a thread with no id, a deleted one,
 * and where the session doesn't write.
 */
export function ThreadAgentButton(props: {
	thread: ReviewThread;
	conversation: AgentThread | undefined;
	open: boolean;
	onToggle: () => void;
	/** Its positioning (default `relative`; e.g. pinned to the right of the Show more row). */
	className?: string;
}) {
	const { conversation, open } = props;
	const handle = `${HANDLE} ${props.className ?? "relative"}`;
	const on = useAgentOn();
	const loading = useAgentThreadsLoading();
	const { failed, retry } = useAgentThreadsFailed();
	const ref = useThreadAgentContext()?.buttonRef;
	if (!agentFor(props.thread, on)) return null;
	if (loading && !conversation) {
		return (
			<span
				data-testid="thread-agent-loading"
				aria-busy="true"
				className={`${handle} border-line`}
			>
				<Spinner label="Loading agent messages" size={14} />
			</span>
		);
	}
	if (failed && !conversation) {
		const failedName = "Agent messages couldn't load";
		return (
			<Tooltip content={failedName} describe={false}>
				{(trigger) => (
					<button
						{...trigger}
						ref={(el) => {
							trigger.ref(el);
							if (ref) ref.current = el;
						}}
						type="button"
						data-testid="thread-agent-button"
						data-failed="true"
						aria-label={failedName}
						aria-pressed={open}
						onMouseDown={keepFocus}
						onClick={() => {
							retry();
							// Open, a press reads again and keeps the panel (its Retry's twin).
							if (!open) props.onToggle();
						}}
						className={`${handle} border-dashed border-bad text-bad hover:bg-agent focus-visible:outline-2 focus-visible:outline-accent`}
					>
						<AlertIcon size={14} aria-hidden />
					</button>
				)}
			</Tooltip>
		);
	}
	const name = agentButtonName(conversation, open);
	const tip = conversation ? name : "Ask agent";
	const unread = conversation?.unread === true && !open;
	return (
		<Tooltip content={tip} describe={false}>
			{(trigger) => (
				<button
					{...trigger}
					ref={(el) => {
						trigger.ref(el);
						if (ref) ref.current = el;
					}}
					type="button"
					data-testid="thread-agent-button"
					aria-label={name}
					aria-pressed={open}
					onMouseDown={keepFocus}
					onClick={props.onToggle}
					className={`${handle} text-xs font-semibold text-agent-ink focus-visible:outline-2 focus-visible:outline-accent ${
						conversation
							? open
								? "border-agent-ink bg-agent shadow-[inset_0_0_0_1px_var(--color-agent-ink)]"
								: "border-agent-edge bg-agent hover:border-agent-ink"
							: open
								? "border-dashed border-agent-ink bg-agent"
								: ASK_HANDLE
					}`}
				>
					<SparkleFillIcon size={14} aria-hidden />
					{conversation && (
						<span aria-hidden>{conversation.messages.length}</span>
					)}
					{unread && (
						<span
							aria-hidden
							data-testid="agent-unread-dot"
							className="absolute -top-1 -left-1 h-2.5 w-2.5 rounded-full border-2 border-surface bg-accent"
						/>
					)}
				</button>
			)}
		</Tooltip>
	);
}

/**
 * The thread's agent handle from its ThreadAgentContext (the card's
 * bottom row); nothing without an agent.
 */
export function AgentHandle(props: { className?: string }) {
	const agent = useThreadAgentContext();
	if (!agent) return null;
	return (
		<ThreadAgentButton
			thread={agent.thread}
			conversation={agent.conversation}
			open={agent.open}
			onToggle={agent.toggle}
			className={props.className}
		/>
	);
}

/**
 * A row centred under the card (the Show more toggle) with the agent's
 * handle at its right end while `handle`, after `end` (a closed card's
 * Resolve): with either, three columns,
 * the outer two equal while there is room, so the toggle stays centred;
 * when tight the left one gives way first, the right one never below
 * what it holds, so the toggle never runs under it. The
 * columns stay while the handle is elsewhere, so the toggle is never
 * remounted (its focus kept): `columns` keeps them for a row whose `end`
 * comes and goes without an agent. All sit on the row's bottom, sunk as
 * the toggle is (`-mb-2`), so none rises into what is above.
 */
export function CentredWithHandle(props: {
	/** Show the handle here (the card's actions row is closed). */
	handle: boolean;
	testId?: string;
	/** Before the handle at the row's right end (a closed card's Resolve). */
	end?: ReactNode;
	/** Three columns even without an agent (`end` may come and go). */
	columns?: boolean;
	children: ReactNode;
}) {
	const agent = useThreadAgentContext();
	if (!agent && !props.columns && !props.end) {
		return (
			<div data-testid={props.testId} className="flex justify-center">
				{props.children}
			</div>
		);
	}
	const handle = agent !== null && props.handle;
	return (
		<div
			data-testid={props.testId}
			// The right column never narrower than what it holds (a bare 1fr
			// resolved under the handle, and it ran into the toggle); the
			// toggle's column gives way last, wrapping its words if it must.
			className="grid grid-cols-[1fr_minmax(0,auto)_minmax(max-content,1fr)] items-end gap-2"
		>
			<div className="col-start-2 flex min-w-0 justify-center">
				{props.children}
			</div>
			{(handle || props.end) && (
				<div
					data-testid="row-end"
					className="col-start-3 -mb-2 flex items-end gap-2 justify-self-end"
				>
					{props.end}
					{handle && <AgentHandle />}
				</div>
			)}
		</div>
	);
}
