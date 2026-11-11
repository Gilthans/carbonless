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
	const base = { id: thread.id, path: a.path, commit: a.commit, thread };
	if (a.subject === "line") {
		return {
			...base,
			subject: "line",
			anchor: {
				side: a.side,
				line: a.line,
				startSide: a.startSide,
				startLine: a.startLine,
				startCol: a.startCol ?? null,
				endCol: a.endCol ?? null,
			},
		};
	}
	// A GitHub-thread anchor places as the span GitHub gave it, else as a file.
	if (
		a.subject === "thread" &&
		a.side !== undefined &&
		a.line !== undefined &&
		a.startLine !== undefined
	) {
		return {
			...base,
			subject: "line",
			anchor: {
				side: a.side,
				line: a.line,
				startSide: a.startSide ?? a.side,
				startLine: a.startLine,
				startCol: null,
				endCol: null,
			},
		};
	}
	return { ...base, subject: "file", anchor: null };
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

/**
 * What the page knows to show the agent threads by (FilesPage): the
 * tracer's placements in the viewed snapshot, and on an earlier patch set
 * the moment the next one started (ms; null: no cutoff).
 */
export interface AgentPlacing {
	placements: Placements | null;
	until: number | null;
	/**
	 * Asked and not in yet: one asked on another head waits for its place
	 * (a spinner shows, AgentNotInComparison), never shown outdated first.
	 */
	pending?: boolean;
	/**
	 * They couldn't be computed: one asked on another head is listed in the
	 * failure group with an unknown fate (as review threads), never in a lead.
	 */
	failed?: boolean;
}

const AgentPlacingContext = createContext<AgentPlacing>({
	placements: null,
	until: null,
});
export const AgentPlacingProvider = AgentPlacingContext.Provider;
export const useAgentPlacing = () => useContext(AgentPlacingContext);

/**
 * The agent threads Files changed shows in the viewed head (span threads
 * only; a GitHub thread's conversation is its card's): on an earlier
 * patch set only those asked before the next one started (as review
 * threads, threadsUntil: never traced backwards) or on its own head, each placed
 * (tracedAgentPlaceables), resolved ones after the rest so every group
 * built from them lists them last.
 */
export function shownAgentPlaceables(
	threads: readonly AgentThread[],
	snapshotHead: string,
	placing: AgentPlacing,
): AgentPlaceable[] {
	const { until } = placing;
	// A live thread conversation goes where its GitHub thread goes (on its
	// card's agent button): never an agent card or bubble of its own. An
	// orphan reaches here with a span anchor (the GitHub join).
	const spans = threads.filter((t) => t.anchor.subject !== "thread");
	const kept =
		until === null
			? spans
			: spans.filter(
					// One asked on this very head stays where it was asked.
					(t) => t.anchor.commit === snapshotHead || Date.parse(t.at) < until,
				);
	const placed =
		placing.pending || placing.failed
			? kept.filter((t) => t.anchor.commit === snapshotHead)
			: kept;
	const shown = tracedAgentPlaceables(placed, snapshotHead, placing.placements);
	return [
		...shown.filter((p) => !p.thread.resolved),
		...shown.filter((p) => p.thread.resolved),
	];
}

/**
 * The agent threads no file of the comparison shows (principle 2: they go
 * to AgentNotInComparison): those the tracer put outside it, and those on
 * a path the diff doesn't have (`paths`): a file renamed since whose trace
 * is pending or failed.
 */
export function agentOutside(
	shown: readonly AgentPlaceable[],
	paths: ReadonlySet<string>,
	placements: Placements | null,
): AgentPlaceable[] {
	return shown.filter(
		(p) => placements?.get(p.id)?.kind === "outside" || !paths.has(p.path),
	);
}

/**
 * The agent threads that wait for the placements (asked on another head,
 * shown on this view once placed): what the spinners and, on a failure,
 * the unknown-fate rows are for; resolved ones last.
 */
export function agentWaiting(
	threads: readonly AgentThread[],
	snapshotHead: string,
	placing: Pick<AgentPlacing, "until">,
): AgentPlaceable[] {
	return shownAgentPlaceables(threads, snapshotHead, {
		placements: null,
		until: placing.until,
	}).filter((p) => p.commit !== snapshotHead);
}
