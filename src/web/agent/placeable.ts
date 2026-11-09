import type { AgentThread } from "../../shared/agent";
import type { Placeable } from "../files/threadPlacement";

/** An agent thread as placeThreads sees it, carrying the thread. */
export interface AgentPlaceable extends Placeable {
	thread: AgentThread;
}

export function agentPlaceable(thread: AgentThread): AgentPlaceable {
	const a = thread.anchor;
	return {
		path: a.path,
		commit: a.commit,
		subject: a.subject,
		anchor:
			a.subject === "line"
				? {
						side: a.side,
						line: a.line,
						startSide: a.startSide,
						startLine: a.startLine,
						startCol: a.startCol ?? null,
						endCol: a.endCol ?? null,
					}
				: null,
		thread,
	};
}
