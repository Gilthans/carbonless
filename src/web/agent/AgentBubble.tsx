import { CheckIcon, SparkleFillIcon } from "@primer/octicons-react";
import type { AgentThread } from "../../shared/agent";
import { plural } from "../overview/parts";
import { Tooltip } from "../Tooltip";

/**
 * The threads a bubble counts: the unresolved ones (a resolved one is
 * counted nowhere); all resolved, all of them, beside the check.
 */
export function agentBubbleCount(threads: readonly AgentThread[]): number {
	const open = threads.filter((t) => !t.resolved).length;
	return open > 0 ? open : threads.length;
}

/** "2 agent threads on line 16, 1 waiting". */
export function agentBubbleLabel(
	threads: AgentThread[],
	where?: string,
): string {
	const n = agentBubbleCount(threads);
	const head = `${plural(n, "agent thread")}${where ? ` ${where}` : ""}`;
	const waiting = threads.filter((t) => t.waiting && !t.resolved).length;
	const parts = [head];
	if (n > 0 && threads.every((t) => t.resolved)) parts.push("resolved");
	if (waiting > 0) parts.push(`${waiting} waiting`);
	return parts.join(", ");
}

/**
 * The agent threads on one line (or a file's header), beside the comment
 * bubble and apart from it: the sparkle and the thread count in the agent
 * tint, a check once all are resolved, a yellow dot while one waits for an
 * answer. A 40px target on touch, the row's height with a mouse; it opens
 * and closes them.
 */
export function AgentBubble(props: {
	threads: AgentThread[];
	open: boolean;
	onToggle: () => void;
	controls?: string;
	/** Where, for its name: "on line 16", "in this file". */
	where?: string;
	inline?: boolean;
}) {
	const { threads } = props;
	const label = agentBubbleLabel(threads, props.where);
	const resolved = threads.length > 0 && threads.every((t) => t.resolved);
	const waiting = threads.some((t) => t.waiting && !t.resolved);
	return (
		<Tooltip content={label} describe={false} dismissKey={props.open}>
			{(trigger) => (
				<button
					type="button"
					{...trigger}
					data-testid="agent-bubble"
					aria-label={label}
					aria-expanded={props.open}
					aria-controls={props.controls}
					onClick={props.onToggle}
					className={`group/bubble z-[4] flex min-w-10 shrink-0 items-center justify-center rounded-md font-sans focus-visible:outline-2 focus-visible:outline-accent ${
						props.inline ? "h-5 pointer-coarse:h-10" : "h-10"
					}`}
				>
					<span
						aria-hidden
						data-resolved={resolved || undefined}
						className={`flex h-5 items-center gap-1 rounded-full border px-1.5 text-xs leading-none tabular-nums shadow-control transition-colors motion-reduce:transition-none ${
							props.open
								? "border-accent bg-pressed text-agent-ink"
								: resolved
									? "border-agent-edge bg-agent text-muted group-hover/bubble:text-ink"
									: "border-agent-edge bg-agent text-agent-ink group-hover/bubble:text-ink"
						}`}
					>
						{/* The sparkle always: resolved, it is still the agent's. */}
						<SparkleFillIcon size={12} className="text-agent-ink" />
						{agentBubbleCount(threads)}
						{resolved && <CheckIcon size={12} className="text-ok" />}
						{waiting && (
							<span
								data-testid="agent-waiting-dot"
								className="h-2 w-2 rounded-full bg-warn"
							/>
						)}
					</span>
				</button>
			)}
		</Tooltip>
	);
}
