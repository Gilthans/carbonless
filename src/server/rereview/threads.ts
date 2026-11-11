/**
 * Thread placement on the server: for each unresolved thread, its own
 * snapshot `(Bx, Hx)` (ThreadCodeSource, as its code pane finds it), the
 * three diffs of its file into a target snapshot (`ac` = Bx → B2, `bd` =
 * Hx → H2 with git's rename pairs, `cd` = the target's own clusters), the
 * thread's own diff (Bx → Hx, for `reverted`) and the texts the tracer
 * reads; then the pure `placeThread` (src/shared/rereview/placement.ts).
 * Everything git answers is keyed by OIDs, so it is cached for the
 * session; only the reviewer's stored placements are read each time.
 */

import type { AgentAnchor } from "../../shared/agent.js";
import {
	placeThread,
	type ThreadInput,
	type ThreadPlacement,
} from "../../shared/rereview/placement.js";
import {
	createLineMapper,
	IDENTITY,
	type LineMapper,
} from "../../shared/tracer/index.js";
import type {
	CodeAnchor,
	DiffSide,
	ReviewThread,
	Snapshot,
	ThreadAnchorRef,
} from "../../shared/types.js";
import { fileText } from "../diff/snapshot.js";
import { runGitBuffer } from "../git.js";
import type { DiffBase, ThreadCodeSource } from "../threadCode.js";
import { type DiffEntry, diffMap, linesMapper, NONE } from "./engine.js";

/** A placement the reviewer asked for that doesn't fit the patch set (400). */
export class InvalidPlacementError extends Error {}

export interface PlacedThread {
	id: string;
	placement: ThreadPlacement;
}

/**
 * What the tracer reads of a thread: a review thread, or an agent thread
 * seen the same way (agentTraceable).
 */
export type TraceableThread = Pick<
	ReviewThread,
	"id" | "path" | "commit" | "anchor" | "createdAt"
> & {
	unavailable?: ReviewThread["unavailable"];
	resolved?: boolean;
};

/**
 * The threads placement covers: those still on GitHub, with an id.
 * Resolved ones too (owner, 2026-11-08): an unplaced resolved thread
 * shows as one quiet line, never vanishing, and one resolved on the page
 * keeps its place.
 */
export const placeable = <T extends TraceableThread>(threads: readonly T[]) =>
	threads.filter((t) => t.id !== "" && t.unavailable !== "deleted");

/** What placeAgentThreads reads of an agent thread (its stored fold). */
export interface AgentAsked {
	id: string;
	anchor: AgentAnchor;
	at: string;
}

/** An agent thread as the tracer reads it: asked on its anchor's commit. */
export function agentTraceable(t: AgentAsked): TraceableThread {
	const a = t.anchor;
	return {
		id: t.id,
		path: a.path,
		commit: a.commit,
		createdAt: t.at,
		anchor:
			a.subject === "line"
				? {
						path: a.path,
						commit: a.commit,
						side: a.side,
						line: a.line,
						startSide: a.startSide,
						startLine: a.startLine,
						at: t.at,
					}
				: null,
	};
}

/**
 * The reviewer's agent threads placed into `target` by the same tracer as
 * review threads (no stored placements: a drag places review threads
 * only). Each is traced on its own, so one whose tracing fails is left
 * out, never the rest: the page then shows it where it was asked (on an
 * earlier head, its file's lead, outdated), never nowhere.
 */
export async function placeAgentThreads(
	placer: ThreadPlacer,
	target: Snapshot,
	threads: readonly AgentAsked[],
	base: DiffBase,
): Promise<PlacedThread[]> {
	const placed = await Promise.all(
		threads.map(async (t) => {
			try {
				const inputs = await placer.inputs(target, [agentTraceable(t)], base);
				return await placer.place(target, inputs, new Map());
			} catch {
				return [];
			}
		}),
	);
	return placed.flat();
}

const EMPTY = Buffer.alloc(0);

/** A thread's range as the tracer reads it, or a stand-in for a file comment. */
function anchorOf(t: TraceableThread): CodeAnchor {
	return (
		t.anchor ?? {
			path: t.path,
			commit: t.commit,
			side: "RIGHT",
			line: 1,
			startSide: "RIGHT",
			startLine: 1,
			at: t.createdAt,
		}
	);
}

/** The entry of a diff that a path at its old side became, and its new path. */
function entryFrom(
	map: Map<string, DiffEntry>,
	path: string,
): { path: string; entry: DiffEntry } | null {
	for (const [key, entry] of map) {
		if (entry.oldPath === path) return { path: key, entry };
	}
	const entry = map.get(path);
	return entry ? { path, entry } : null;
}

const mapperOf = (entry: DiffEntry | undefined): LineMapper =>
	entry === undefined
		? IDENTITY
		: entry.status === "deleted"
			? NONE
			: createLineMapper(entry.hunks);

/**
 * One session's placer: memos of git's answers by OIDs (diffs between two
 * commits over a set of paths, file texts at a commit).
 */
export class ThreadPlacer {
	readonly #diffs = new Map<string, Promise<Map<string, DiffEntry>>>();
	readonly #texts = new Map<string, Promise<string[] | null>>();

	constructor(
		private readonly repo: string,
		private readonly code: ThreadCodeSource,
	) {}

	#diff(
		old: string,
		fresh: string,
		paths: Set<string>,
	): Promise<Map<string, DiffEntry>> {
		const key = `${old} ${fresh} ${JSON.stringify([...paths].sort())}`;
		let made = this.#diffs.get(key);
		if (!made) {
			made = diffMap(this.repo, old, fresh, paths);
			this.#diffs.set(key, made);
			made.catch(() => this.#diffs.delete(key));
		}
		return made;
	}

	/** A file's lines at a commit; null when it isn't there (or git fails). */
	text(commit: string, path: string): Promise<string[] | null> {
		const key = JSON.stringify([commit, path]);
		let made = this.#texts.get(key);
		if (!made) {
			made = runGitBuffer(this.repo, ["cat-file", "blob", `${commit}:${path}`])
				.then((bytes) => fileText(EMPTY, bytes).newLines)
				.catch(() => null);
			this.#texts.set(key, made);
		}
		return made;
	}

	/**
	 * A target file's length on a side: the head's lines for RIGHT, the
	 * base's (its old path) for LEFT; null for a path that is no file of
	 * the snapshot, or a side the file doesn't have.
	 */
	async lineCount(
		target: Snapshot,
		path: string,
		side: DiffSide,
	): Promise<number | null> {
		const file = target.files.find((f) => f.path === path);
		if (!file || file.binary || file.submodule) return null;
		if (side === "RIGHT" && file.status === "deleted") return null;
		if (side === "LEFT" && file.status === "added") return null;
		const lines =
			side === "RIGHT"
				? await this.text(target.head, path)
				: await this.text(target.base, file.oldPath ?? path);
		return lines?.length ?? null;
	}

	/**
	 * Each placeable thread's input for `placeThread` into `target`, with
	 * no stored placement yet: git's work, cached by OIDs. `base` is the
	 * session's diff base (the code panes' own).
	 */
	async inputs(
		target: Snapshot,
		threads: readonly TraceableThread[],
		base: DiffBase,
	): Promise<ThreadInput[]> {
		const list = placeable(threads);
		const own = await Promise.all(
			list.map((t) => this.code.endpoints(anchorOf(t), base)),
		);
		const paths = new Set<string>();
		for (const f of target.files) {
			paths.add(f.path);
			if (f.oldPath !== undefined) paths.add(f.oldPath);
		}
		for (const t of list) paths.add(t.path);
		const threadPaths = new Set(list.map((t) => t.path));
		const inTarget = (p: string) =>
			target.files.some((f) => f.path === p || f.oldPath === p);
		return Promise.all(
			list.map(async (t, i): Promise<ThreadInput> => {
				const ends = own[i];
				const anchor = t.anchor
					? {
							side: t.anchor.side,
							line: t.anchor.line,
							startSide: t.anchor.startSide,
							startLine: t.anchor.startLine,
						}
					: null;
				if (!ends) {
					// Its own snapshot can't be had: never traced, never placed.
					return {
						id: t.id,
						path: t.path,
						anchor,
						diffs: null,
						newPath: t.path,
						inComparison: inTarget(t.path),
					};
				}
				const [ownDiff, bd] = await Promise.all([
					this.#diff(ends.base, ends.head, threadPaths),
					this.#diff(ends.head, target.head, paths),
				]);
				// The file in its own snapshot's base (the PR may have renamed it).
				const ownEntry = ownDiff.get(t.path);
				const basePath = ownEntry?.oldPath ?? t.path;
				const ac = await this.#diff(
					ends.base,
					target.base,
					new Set([...paths, basePath]),
				);
				const head = entryFrom(bd, t.path);
				const gone = head?.entry.status === "deleted";
				const newPath = gone ? null : (head?.path ?? t.path);
				const inComparison = inTarget(newPath ?? t.path);
				if (newPath === null) {
					return {
						id: t.id,
						path: t.path,
						anchor,
						diffs: null,
						newPath: null,
						inComparison,
					};
				}
				const baseEntry = entryFrom(ac, basePath);
				const targetFile = target.files.find((f) => f.path === newPath);
				const [oldRight, oldLeft, newRight, newLeft] = await Promise.all([
					this.text(ends.head, t.path),
					this.text(ends.base, basePath),
					this.text(target.head, newPath),
					this.text(target.base, targetFile?.oldPath ?? newPath),
				]);
				return {
					id: t.id,
					path: t.path,
					anchor,
					newPath,
					inComparison,
					own: mapperOf(ownEntry),
					newLineText: (pos) =>
						(pos.side === "RIGHT" ? newRight : newLeft)?.[pos.line - 1] ?? null,
					diffs: {
						ac: mapperOf(baseEntry?.entry),
						bd: mapperOf(head?.entry),
						cd: targetFile ? linesMapper(targetFile.clusters) : IDENTITY,
						oldLineText: (pos) =>
							(pos.side === "RIGHT" ? oldRight : oldLeft)?.[pos.line - 1] ??
							null,
						newLineCount: {
							LEFT: newLeft?.length ?? 0,
							RIGHT: newRight?.length ?? 0,
						},
					},
				};
			}),
		);
	}

	/**
	 * The placements of `inputs` in `target` with the reviewer's stored
	 * ones (by thread id) laid over, each checked against the target.
	 */
	async place(
		target: Snapshot,
		inputs: readonly ThreadInput[],
		stored: ReadonlyMap<string, ThreadAnchorRef>,
	): Promise<PlacedThread[]> {
		const counts = new Map<string, number | null>();
		await Promise.all(
			[...stored.values()].flatMap((a) =>
				[a.side, a.startSide].map(async (side) => {
					const key = `${side}:${a.path}`;
					if (!counts.has(key)) {
						counts.set(key, null);
						counts.set(key, await this.lineCount(target, a.path, side));
					}
				}),
			),
		);
		return inputs.map((input) => {
			const s = stored.get(input.id);
			return {
				id: input.id,
				placement: placeThread(
					s ? { ...input, stored: s } : input,
					(path, side) => counts.get(`${side}:${path}`) ?? null,
				),
			};
		});
	}
}
