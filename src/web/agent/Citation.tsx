import { AlertIcon } from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Spinner } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { agentThreadsQuery } from "./api";
import {
	conversationLabel,
	LINK_ERROR,
	linkState,
	useGithubAuthors,
	useLinkFacts,
} from "./conversationLinks";

const CITATION_LINK_CLASS =
	"rounded-sm text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent";

/**
 * One citation (`crb:c/<id>`) in an agent's answer, drawn where the token
 * was (AgentMarkdown mounts it there): a link labelled with where the
 * conversation is, built by crb from this review's conversation. While the
 * review's files load, a spinner with the label (never "not in the
 * files"); an error when they couldn't be read; a muted label once they
 * are in and the conversation's file isn't. It re-renders as any of these
 * come in, the threads' authors too.
 */
export function Citation(props: { thread: string }) {
	const thread = useQuery({
		...agentThreadsQuery,
		enabled: false,
	}).data?.threads.find((t) => t.id === props.thread);
	const facts = useLinkFacts();
	const authorOf = useGithubAuthors();
	const { id: review } = useParams({ strict: false }) as { id?: string };
	// Gone from the threads since (or never this review's): the token as text.
	if (!thread || !review) return <>{`crb:c/${props.thread}`}</>;
	const label = conversationLabel(thread, authorOf);
	const link = linkState(thread, facts);
	switch (link.state) {
		case "ready":
			return (
				<Link
					{...(link.target as unknown as { to: "/" })}
					params={{ id: review } as never}
					data-testid="agent-conversation-link"
					data-state="ready"
					className={CITATION_LINK_CLASS}
				>
					{label}
				</Link>
			);
		case "loading":
			return (
				<span
					data-testid="agent-conversation-link"
					data-state="loading"
					aria-busy="true"
					aria-disabled="true"
					className="inline-flex items-baseline gap-1 text-muted"
				>
					<Spinner label="Placing this conversation" size={12} />
					{label}
				</span>
			);
		case "error":
			return (
				<Tooltip content={LINK_ERROR} describe={false}>
					{(trigger) => (
						<span
							{...trigger}
							data-testid="agent-conversation-link"
							data-state="error"
							aria-disabled="true"
							// Focusable so keyboard and touch users get the tip.
							// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
							tabIndex={0}
							className="inline-flex items-baseline gap-1 rounded-sm text-bad focus-visible:outline-2 focus-visible:outline-accent"
						>
							<AlertIcon
								size={12}
								aria-label={LINK_ERROR}
								className="self-center"
							/>
							{label}
						</span>
					)}
				</Tooltip>
			);
		case "none":
			return (
				<span
					data-testid="agent-conversation-link"
					data-state="none"
					aria-disabled="true"
					title="Not in this review's files"
					className="text-faint"
				>
					{label}
				</span>
			);
	}
}
