import { createContext, useContext } from "react";
import type { AgentThread } from "../../shared/agent";
import type { Placeable, Placements } from "../files/threadPlacement";

/** An agent thread as placeThreads sees it, carrying the thread. */
export interface AgentPlaceable extends Placeable {
	id: string;
	thread: AgentThread;
}

/** An agent thread where it was asked: its own commit, path and range. */
export function agentPlaceable(thread: AgentThread): AgentPlaceable {
	const a = thread.anchor;
	return {
		id: thread.id,
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

/**
 * The agent threads as Files changed shows them in the viewed head
 * `snapshotHead`, by the tracer's placements (GET /agent/placements, by
 * thread id), as review threads are (shownThread): one asked on an
 * earlier head on its traced lines (a rewritten line's whole), a file
 * question on its file's path now, an unplaced one under its file (the
 * viewed head's, line-less: placeThreads lists it with its fate). One
 * asked on the viewed head keeps its own place. One with no placement
 * (not in yet, its tracing failed) or outside the comparison stays where
 * it was asked: on an earlier head, its file's lead, outdated; never gone.
 */
export function tracedAgentPlaceables(
	threads: readonly AgentThread[],
	snapshotHead: string,
	placements: Placements | null,
): AgentPlaceable[] {
	return threads.map((thread) => {
		const own = agentPlaceable(thread);
		if (own.commit === snapshotHead) return own;
		const p = placements?.get(thread.id);
		if (!p || p.kind === "outside") return own;
		if (p.kind === "placed" || p.kind === "changed") {
			const a = p.anchor;
			const cols =
				p.kind === "placed" && own.anchor
					? { startCol: own.anchor.startCol, endCol: own.anchor.endCol }
					: { startCol: null, endCol: null };
			return {
				...own,
				path: a.path,
				commit: snapshotHead,
				subject: "line",
				anchor: {
					side: a.side,
					line: a.line,
					startSide: a.startSide,
					startLine: a.startLine,
					...cols,
				},
			};
		}
		if (p.kind === "file") {
			return { ...own, path: p.path, commit: snapshotHead };
		}
		return {
			...own,
			path: p.path,
			commit: snapshotHead,
			subject: "line",
			anchor: null,
		};
	});
}

/** The agent threads' placements in the viewed snapshot (FilesPage reads them). */
const AgentPlacementsContext = createContext<Placements | null>(null);
export const AgentPlacementsProvider = AgentPlacementsContext.Provider;
export const useAgentPlacements = () => useContext(AgentPlacementsContext);
