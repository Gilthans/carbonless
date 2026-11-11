import type { AgentAnchor, AgentView } from "../../shared/agent.js";
import type { ReviewThread } from "../../shared/types.js";
import type { AgentThreadFold } from "./store.js";

/**
 * Thread conversations (an agent thread on a GitHub review thread) as the
 * page and the runner see them. See "What a thread conversation is" in
 * docs/superpowers/specs/2026-11-09-thread-agent-design.md.
 */

type ThreadAnchor = Extract<AgentAnchor, { subject: "thread" }>;

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The GitHub threads a conversation can still belong to: listed, with an id, not deleted. */
export function liveGithubThreads(
	threads: readonly ReviewThread[],
): Map<string, ReviewThread> {
	const live = new Map<string, ReviewThread>();
	for (const t of threads) {
		if (t.id !== "" && t.unavailable !== "deleted") live.set(t.id, t);
	}
	return live;
}

/**
 * The folds as the page and the runner see them: a live thread
 * conversation is resolved exactly when its GitHub thread is (its own
 * agent-thread-resolved events count for nothing); one whose GitHub
 * thread is gone (not listed, or deleted) is an orphan: a span thread on
 * its recorded lines, resolved by its own events. Span threads pass
 * through unchanged.
 */
export function joinGithub(
	folds: readonly AgentThreadFold[],
	threads: readonly ReviewThread[],
): AgentThreadFold[] {
	const live = liveGithubThreads(threads);
	return folds.map((f) => {
		if (f.anchor.subject !== "thread") return f;
		const rt = live.get(f.anchor.thread);
		if (rt) return { ...f, resolved: rt.resolved };
		return { ...f, anchor: orphanAnchor(f.anchor), orphaned: true };
	});
}

/** The span anchor an orphan falls back to: line anchor on the recorded lines at `commit`, else a file anchor. */
export function orphanAnchor(a: ThreadAnchor): AgentAnchor {
	const { path, commit, side, line } = a;
	if (commit === "" || side === undefined || line === undefined) {
		return { subject: "file", path, commit };
	}
	// A start on another side, or none: as recorded, else the one line.
	const start =
		a.startSide !== undefined && a.startLine !== undefined
			? { startSide: a.startSide, startLine: a.startLine }
			: { startSide: side, startLine: line };
	return { subject: "line", path, commit, side, line, ...start };
}

/**
 * left/right of a view, from the session's patch sets and `base` (the
 * snapshot's merge base): the right is the viewed patch set's head or the
 * viewed head; the left is the compared-from patch set's head, or for the
 * base branch the viewed patch set's merge base (a head's patch set's, else
 * `base`). Null for a patch set that isn't one, or a head that isn't an OID.
 */
export function resolveView(
	view: Omit<AgentView, "left" | "right">,
	patchsets: readonly { number: number; head: string; mergeBase: string }[],
	base: string,
): AgentView | null {
	const ps = (n: number) => patchsets.find((p) => p.number === n);
	let right: string;
	let mergeBase: string;
	if ("patchset" in view.target) {
		const target = ps(view.target.patchset);
		if (!target) return null;
		right = target.head;
		mergeBase = target.mergeBase;
	} else {
		const head = view.target.head;
		if (!OID.test(head)) return null;
		right = head;
		mergeBase = patchsets.find((p) => p.head === head)?.mergeBase ?? base;
	}
	let left: string;
	if ("branch" in view.from) left = mergeBase;
	else {
		const from = ps(view.from.patchset);
		if (!from) return null;
		left = from.head;
	}
	return { target: view.target, from: view.from, left, right };
}
