import {
	AlertIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	ListUnorderedIcon,
	ReplyIcon,
} from "@primer/octicons-react";
import { useId, useState } from "react";
import {
	type AgentOrigin,
	type AgentThread,
	startedBy,
} from "../../shared/agent";
import { SpinnerIcon } from "../Spinner";
import { Tooltip } from "../Tooltip";
import {
	LINK_ERROR,
	linkState,
	useLinkFacts,
	useOpenConversation,
} from "./conversationLinks";
import { firstLine, StartedList } from "./StartedList";

const ICON_BUTTON =
	"flex h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-md text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:text-faint";

/**
 * Above an agent message the agent wrote from a request (`open`): "RE",
 * the request's first words in a box (Show more shows it whole), Go to
 * your request, and the list of the conversations that request started.
 * The request is the reviewer's own message, read from the threads, shown
 * as plain text. Nothing when the request isn't among `threads`.
 */
export function ReRow(props: {
	origin: AgentOrigin;
	/** The conversation this row is in (marked in the list). */
	current: string;
	threads: readonly AgentThread[];
}) {
	const { origin, threads } = props;
	const [more, setMore] = useState(false);
	const [listed, setListed] = useState(false);
	const boxId = useId();
	const listId = useId();
	const open = useOpenConversation();
	const facts = useLinkFacts();
	const request = threads.find((t) => t.id === origin.thread);
	const message = request?.messages.find((m) => m.id === origin.message);
	if (!request || !message) return null;
	const started = (startedBy(threads).get(message.id) ?? [])
		.map((id) => threads.find((t) => t.id === id))
		.filter((t): t is AgentThread => t !== undefined);
	// The review conversation's place is its drawer: always reachable.
	const inReview = request.anchor.subject === "review";
	const go = inReview ? "ready" : linkState(request, facts, message.id).state;
	const reachable = go === "ready";
	const goTip = inReview
		? "In the review conversation"
		: go === "none"
			? "Not in this review's files"
			: go === "error"
				? LINK_ERROR
				: "Go to your request";
	return (
		<div data-testid="agent-re" className="min-w-0 space-y-1">
			<div className="flex min-w-0 items-center gap-1">
				<span className="shrink-0 px-0.5 text-xs font-semibold tracking-wide text-label">
					RE
				</span>
				<p
					id={boxId}
					data-testid="agent-re-text"
					className={`min-w-0 flex-1 rounded-md border border-edge bg-overlay px-2 py-1 text-sm text-ink-soft ${
						more ? "whitespace-pre-wrap break-words" : "truncate"
					}`}
				>
					“{more ? message.text : firstLine(message.text)}”
				</p>
				<Tooltip content={more ? "Show less" : "Show more"} describe={false}>
					{(trigger) => (
						<button
							{...trigger}
							type="button"
							data-testid="agent-re-more"
							aria-label={more ? "Show less" : "Show more"}
							aria-expanded={more}
							aria-controls={boxId}
							onClick={() => setMore((m) => !m)}
							className={ICON_BUTTON}
						>
							{more ? (
								<ChevronUpIcon size={16} aria-hidden />
							) : (
								<ChevronDownIcon size={16} aria-hidden />
							)}
						</button>
					)}
				</Tooltip>
				<Tooltip content={goTip} describe={false}>
					{(trigger) => (
						<button
							{...trigger}
							type="button"
							data-testid="agent-re-go"
							aria-label={goTip}
							aria-disabled={!reachable || undefined}
							aria-busy={go === "loading" || undefined}
							onClick={() => {
								if (reachable) open(request, message.id);
							}}
							className={`${ICON_BUTTON} ${go === "none" ? "cursor-not-allowed text-faint" : go === "error" ? "cursor-not-allowed text-bad" : ""}`}
						>
							{/* Its place is still being read: the icon spins, never "not in the files". */}
							{go === "loading" ? (
								<SpinnerIcon size={16} />
							) : go === "error" ? (
								<AlertIcon size={16} aria-hidden />
							) : (
								<ReplyIcon size={16} aria-hidden />
							)}
						</button>
					)}
				</Tooltip>
				<Tooltip content="Conversations from this request" describe={false}>
					{(trigger) => (
						<button
							{...trigger}
							type="button"
							data-testid="agent-re-list"
							aria-label={`Conversations from this request: ${started.length}`}
							aria-expanded={listed}
							aria-controls={listed ? listId : undefined}
							onClick={() => setListed((l) => !l)}
							className={`${ICON_BUTTON} px-2 text-xs font-semibold`}
						>
							<ListUnorderedIcon size={16} aria-hidden />
							<span aria-hidden>{started.length}</span>
						</button>
					)}
				</Tooltip>
			</div>
			{listed && (
				<StartedList
					id={listId}
					request={message.id}
					threads={started}
					current={props.current}
				/>
			)}
		</div>
	);
}

/**
 * Under a request message that started conversations: "Started N" with an
 * `accent` count of the unread ones, opening the list of them.
 */
export function StartedButton(props: {
	/** The request message's id. */
	request: string;
	threads: readonly AgentThread[];
}) {
	const [listed, setListed] = useState(false);
	const listId = useId();
	const unread = props.threads.filter((t) => t.unread).length;
	const n = props.threads.length;
	return (
		<div className="min-w-0 space-y-1">
			<button
				type="button"
				data-testid="agent-started"
				aria-expanded={listed}
				aria-controls={listed ? listId : undefined}
				aria-label={`Started ${n}${unread > 0 ? `, ${unread} unread` : ""}`}
				onClick={() => setListed((l) => !l)}
				className="flex h-10 items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
			>
				<ListUnorderedIcon size={16} aria-hidden />
				<span aria-hidden>Started {n}</span>
				{unread > 0 && (
					<span
						aria-hidden
						data-testid="agent-started-unread"
						className="min-w-5 rounded-full bg-accent px-1.5 text-center text-xs font-semibold text-canvas"
					>
						{unread}
					</span>
				)}
			</button>
			{listed && (
				<StartedList
					id={listId}
					request={props.request}
					threads={props.threads}
				/>
			)}
		</div>
	);
}
