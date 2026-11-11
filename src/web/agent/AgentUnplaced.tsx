import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AgentThread } from "../../shared/agent";
import type { Fate } from "../../shared/rereview/placement";
import { UnplacedShell } from "../files/ThreadFate";
import { AgentThreadCard } from "./AgentThreadCard";
import { agentStatusQuery } from "./api";

/**
 * An agent thread the tracer couldn't place, in the review threads' own
 * unplaced row (UnplacedShell): the fate sentence, "near N", the Original
 * Reviewed Change box, the quiet resolved line; only the body is the
 * agent's card.
 */
export function AgentUnplaced(props: {
	thread: AgentThread;
	/** Its fate; null: unknown (the placements couldn't be computed). */
	fate: Fate | null;
	/** Under the fate: the original path (the trailing groups). */
	path?: string;
	movedTo?: string;
	link?: ReactNode;
	/** Asked on this earlier head: its card says so. */
	outdated?: string;
	testId?: string;
}) {
	const { thread } = props;
	const status = useQuery({ ...agentStatusQuery, enabled: false }).data;
	return (
		<UnplacedShell
			thread={{
				id: thread.id,
				resolved: thread.resolved,
				code: thread.code ?? null,
				path: thread.anchor.path,
				createdAt: thread.at,
			}}
			who="you"
			fate={props.fate}
			path={props.path}
			movedTo={props.movedTo}
			link={props.link}
			testId={props.testId ?? "agent-unplaced"}
		>
			<AgentThreadCard
				thread={thread}
				status={status}
				outdated={props.outdated}
			/>
		</UnplacedShell>
	);
}
