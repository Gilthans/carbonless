import { SparkleFillIcon } from "@primer/octicons-react";
import type { AgentThread } from "../../shared/agent";
import type { ReviewThread } from "../../shared/types";
import { Spinner } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { useAgentOn } from "./api";
import {
	agentButtonName,
	agentFor,
	useAgentThreadsLoading,
	useThreadAgentContext,
} from "./threadAgent";

/** The header's pill size: 40px tall on a phone and under a finger. */
const PILL = "h-7 max-sm:h-10 pointer-coarse:h-10";

/**
 * A thread card's agent button, beside its comment counter: a teal pill
 * with the sparkle and the number of messages in the thread's agent
 * conversation, an `accent` dot while one of the agent's is unseen; a
 * dashed sparkle ("Ask agent") before there is one. Pressed while the
 * conversation is open. A spinner in its place while the agent threads
 * load (never "Ask agent" that would then turn into a count). Absent on a
 * thread with no id, a deleted one, and where the session doesn't write.
 */
export function ThreadAgentButton(props: {
	thread: ReviewThread;
	conversation: AgentThread | undefined;
	open: boolean;
	onToggle: () => void;
}) {
	const { conversation, open } = props;
	const on = useAgentOn();
	const loading = useAgentThreadsLoading();
	const ref = useThreadAgentContext()?.buttonRef;
	if (!agentFor(props.thread, on)) return null;
	if (loading && !conversation) {
		return (
			<span
				data-testid="thread-agent-loading"
				aria-busy="true"
				className={`inline-flex min-w-10 items-center justify-center ${PILL}`}
			>
				<Spinner label="Loading agent messages" size={14} />
			</span>
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
					onClick={props.onToggle}
					className={`relative inline-flex min-w-10 shrink-0 items-center justify-center gap-1 rounded-full border px-2 text-xs font-semibold text-agent-ink focus-visible:outline-2 focus-visible:outline-accent ${PILL} ${
						conversation
							? open
								? "border-agent-ink bg-agent shadow-[inset_0_0_0_1px_var(--color-agent-ink)]"
								: "border-agent-edge bg-agent hover:border-agent-ink"
							: open
								? "border-dashed border-agent-ink bg-agent"
								: "border-dashed border-agent-edge hover:border-agent-ink hover:bg-agent"
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
							className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-accent"
						/>
					)}
				</button>
			)}
		</Tooltip>
	);
}
