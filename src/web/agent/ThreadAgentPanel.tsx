import { CheckCircleIcon, SquareFillIcon } from "@primer/octicons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { AgentMessage, AgentThread } from "../../shared/agent";
import type { ReviewThread } from "../../shared/types";
import { sessionQuery } from "../api";
import { canToggle } from "../threads/ResolveButton";
import { useThreadWriter, useWritesOn } from "../threads/threadWrites";
import { AgentMessageItems, agentName, useAnswering } from "./AgentThreadCard";
import { useAgentWrites } from "./agentWrites";
import { agentStatusQuery, postAgentCancel } from "./api";
import {
	standingSuggestion,
	unseenMessages,
	useSeenWriter,
	useThreadAgentContext,
} from "./threadAgent";

/** The strip of the comments left uncovered: their avatar column, a tap target. */
export const AGENT_STRIP_PX = 40;
/** The slide, in ms (`transform` only; none under reduced motion). */
const SLIDE_MS = 250;

/** Stands in for a conversation not opened yet (useAnswering wants one). */
const NONE: AgentThread = {
	id: "",
	anchor: { subject: "file", path: "", commit: "" },
	openedBy: "human",
	at: "",
	messages: [],
	resolved: false,
	waiting: false,
	unread: false,
};

/**
 * The box of a thread card's comments: with a thread agent, the panel
 * slides over them (ThreadAgentPanel), and the box grows to a minimum
 * height while it is open so the conversation has room. The comments
 * under it are out of reach (inert) while it covers them.
 */
export function AgentCover(props: { children: ReactNode; className?: string }) {
	const agent = useThreadAgentContext();
	const shown = useShown(agent?.open ?? false);
	if (!agent) {
		return (
			<div className={props.className ?? "space-y-2"}>{props.children}</div>
		);
	}
	return (
		<div
			data-testid="agent-cover"
			className={`relative ${shown ? "min-h-64 overflow-hidden" : ""}`}
		>
			<div inert={agent.open} className={props.className ?? "space-y-2"}>
				{props.children}
			</div>
			<ThreadAgentPanel
				thread={agent.thread}
				conversation={agent.conversation}
				open={agent.open}
				onClose={agent.close}
				stripWidth={AGENT_STRIP_PX}
			/>
		</div>
	);
}

/**
 * Whether the panel is drawn: from the press that opens it until its
 * slide out ends. In between its two frames the open class goes on, so
 * the slide in runs from off the box's edge.
 */
function useShown(open: boolean): boolean {
	const [shown, setShown] = useState(open);
	useEffect(() => {
		if (open) {
			setShown(true);
			return;
		}
		const timer = setTimeout(() => setShown(false), SLIDE_MS + 20);
		return () => clearTimeout(timer);
	}, [open]);
	return shown || open;
}

/** One frame after it is drawn, it slides in. */
function useEntered(open: boolean): boolean {
	const [entered, setEntered] = useState(false);
	useEffect(() => {
		if (!open) {
			setEntered(false);
			return;
		}
		const frame =
			typeof requestAnimationFrame === "function"
				? requestAnimationFrame(() => setEntered(true))
				: (setTimeout(() => setEntered(true), 0) as unknown as number);
		return () => {
			if (typeof cancelAnimationFrame === "function") {
				cancelAnimationFrame(frame);
			}
			clearTimeout(frame);
		};
	}, [open]);
	return entered && open;
}

/**
 * A GitHub thread's agent conversation, slid in from the right over the
 * thread's comments (inside AgentCover), leaving their avatar column
 * (`stripWidth`) in sight as a strip that brings the thread back. Its
 * messages as the agent card shows them, opened at its end (the list is
 * reversed, so the latest answer is what shows first); a "new" divider
 * above the first agent message unseen when it opened, kept until it
 * closes; the turn under way with Stop; "Resolve By Agent Suggestion"
 * under the latest message that suggests it, which resolves the GitHub
 * thread (the card's Resolve, a human's press) and is gone once it is
 * resolved. The card header and the composer row stay outside it.
 */
export function ThreadAgentPanel(props: {
	thread: ReviewThread;
	conversation: AgentThread | undefined;
	open: boolean;
	onClose: () => void;
	stripWidth: number;
}) {
	const { thread, conversation, open } = props;
	const shown = useShown(open);
	const entered = useEntered(shown && open);
	const scroller = useRef<HTMLDivElement>(null);
	useSeenWriter(conversation, open, scroller);
	// The first agent message unseen as it opened: the divider stays there.
	const [divider, setDivider] = useState<string | undefined>(undefined);
	const firstUnseen = conversation?.unread
		? unseenMessages(conversation)[0]?.id
		: undefined;
	useEffect(() => {
		if (!open) setDivider(undefined);
		else if (firstUnseen) setDivider((d) => d ?? firstUnseen);
	}, [open, firstUnseen]);
	return (
		<>
			{open && (
				<button
					type="button"
					aria-label="Back to the thread"
					data-testid="thread-agent-strip"
					onClick={props.onClose}
					style={{ width: props.stripWidth }}
					className="absolute inset-y-0 left-0 z-10 cursor-pointer rounded-l-md hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
				/>
			)}
			<section
				data-testid="thread-agent-panel"
				data-open={open}
				aria-label="Agent conversation"
				aria-hidden={!open}
				inert={!open}
				style={{ width: `calc(100% - ${props.stripWidth}px)` }}
				className={`absolute inset-y-0 right-0 z-10 flex flex-col rounded-md border border-agent-edge bg-surface shadow-control transition-transform duration-250 ease-out motion-reduce:transition-none ${
					shown ? "" : "hidden"
				} ${entered ? "translate-x-0" : "translate-x-[calc(100%+2px)]"}`}
			>
				{shown && (
					<div
						ref={scroller}
						data-testid="thread-agent-scroll"
						className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto overscroll-contain p-2.5"
					>
						<div className="space-y-2">
							<PanelMessages
								thread={thread}
								conversation={conversation}
								divider={divider}
							/>
						</div>
					</div>
				)}
			</section>
		</>
	);
}

function PanelMessages(props: {
	thread: ReviewThread;
	conversation: AgentThread | undefined;
	divider: string | undefined;
}) {
	const { thread, conversation } = props;
	const client = useQueryClient();
	const status = useQuery({ ...agentStatusQuery, enabled: false }).data;
	const viewer =
		useQuery({ ...sessionQuery, enabled: false }).data?.viewer ?? "you";
	const turn = useAnswering(conversation ?? NONE, status);
	const answering = conversation ? turn : undefined;
	const writes = useAgentWrites();
	const pending = [...writes.pending.entries()].filter(
		([, w]) =>
			(conversation !== undefined && w.thread === conversation.id) ||
			w.githubThread === thread.id,
	);
	const stop = useMutation({
		mutationFn: postAgentCancel,
		onSettled: () =>
			client.invalidateQueries({ queryKey: agentStatusQuery.queryKey }),
	});
	const suggestion = standingSuggestion(conversation, thread);
	const writer = useThreadWriter();
	const agent = useThreadAgentContext();
	const mayResolve = canToggle(thread, useWritesOn());
	const after = (m: AgentMessage) =>
		m.id === suggestion?.id && mayResolve ? (
			<div data-message={m.id} className="flex">
				<button
					type="button"
					data-testid="resolve-by-agent"
					onClick={(e) => {
						writer.setResolved(thread.id, true);
						agent?.onToggle?.(true, e.currentTarget);
					}}
					className="flex h-10 items-center gap-2 rounded-md border border-ok/60 bg-ok/10 px-3 text-sm font-semibold text-ok hover:bg-ok/20 focus-visible:outline-2 focus-visible:outline-accent"
				>
					<CheckCircleIcon size={16} aria-hidden />
					Resolve By Agent Suggestion
				</button>
			</div>
		) : null;
	return (
		<AgentMessageItems
			thread={conversation}
			status={status}
			answering={answering}
			viewer={viewer}
			name={agentName(conversation ?? NONE, status)}
			pending={pending}
			divider={props.divider}
			after={after}
			stop={
				<button
					type="button"
					data-testid="agent-stop"
					disabled={stop.isPending}
					onClick={() => stop.mutate()}
					className="ml-auto flex h-10 items-center gap-1.5 rounded-md border border-line-strong px-3 text-sm font-medium text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:text-faint"
				>
					<SquareFillIcon size={12} aria-hidden />
					Stop
				</button>
			}
		/>
	);
}
