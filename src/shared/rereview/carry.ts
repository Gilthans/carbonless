/**
 * Carrying review marks from earlier patch sets to a new snapshot: a
 * cluster the reviewer marked carries when the exact same change (its
 * removed and added lines, byte for byte) sits where the line mappers say
 * it went. Context plays no part; nothing is searched by text.
 *
 * Two steps, so the first can be cached and the second applied to the
 * marks as they stand: `traceClusters` says where every source cluster
 * lands (no states involved), `carryTraced` turns that into carries, reworks
 * and gone clusters under the reviewer's human states. `carryClusters` is
 * both. Pure: nothing from `src/server/`, no git, no I/O.
 */

import type { LineMapper } from "../tracer/index.js";
import type { Cluster, ClusterState } from "../types.js";

export type CarryRule = "exact" | "rename";

/**
 * A cluster's folded state in a source patch set (the store's StateEntry
 * fits). A state the engine carried there is not a source: the walk goes
 * on to the patch set it was carried from.
 */
export interface SourceState {
	state: ClusterState;
	carried?: { from: number; rule: CarryRule };
}

export interface SourceFile {
	path: string;
	clusters: Cluster[];
	/** Cluster key → its state; a cluster with none was never marked. */
	states: Map<string, SourceState>;
}

export interface SourcePatchset {
	number: number;
	files: SourceFile[];
}

/** How one source patch set's file maps into a target file. */
export interface FileMappers {
	/** Source head → target head, this file (through its rename pair). */
	bd: LineMapper;
	/** Source base → target base, this file. */
	ac: LineMapper;
	/** The file's path in the source head when `bd` pairs it under another name. */
	oldPath?: string;
}

export interface TargetFile extends FileMappers {
	path: string;
	clusters: Cluster[];
	/**
	 * The mappers of each earlier source patch set (by number) into this
	 * file; `bd`, `ac` and `oldPath` above are the latest's (`sources[0]`).
	 * A patch set absent here is not traced into this file.
	 */
	earlier?: Map<number, FileMappers>;
}

export interface CarryInput {
	/** Latest first: the patch set the move is from, then the ones before it. */
	sources: SourcePatchset[];
	target: TargetFile[];
	/**
	 * Paths with any interdiff cluster or a conflict. Advisory only: a
	 * carried cluster in such a path is still carried (the interdiff can be
	 * non-empty elsewhere in the file).
	 */
	interdiffPaths: Set<string>;
}

export interface CarriedState {
	/** The target cluster. */
	key: string;
	/** The source cluster, in patch set `from`. */
	fromKey: string;
	from: number;
	rule: CarryRule;
	state: "reviewed" | "crossed-off";
}

export interface CarryResult {
	carried: CarriedState[];
	/** Target keys a marked source cluster traced to without being equal. */
	reworked: Set<string>;
	/** Marked clusters of the latest source patch set with no image at all. */
	gone: { fromKey: string; from: number; path: string }[];
}

/** Where one source cluster lands in the target, states aside. */
export interface TracedCluster {
	from: number;
	fromKey: string;
	/** The source file's path. */
	path: string;
	/**
	 * The target clusters its lines landed in: none (gone), one (its image
	 * when `equal`, else reworked), several (its lines now span them).
	 */
	images: string[];
	/** One image at the traced ranges, with the same removed and added lines. */
	equal: boolean;
	rule: CarryRule;
}

const sameLines = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((line, i) => line === b[i]);

/** The same change: removed and added lines byte for byte, newline-at-end flags too. */
function sameChange(a: Cluster, b: Cluster): boolean {
	return (
		sameLines(a.removed, b.removed) &&
		sameLines(a.added, b.added) &&
		(a.noNewlineOld ?? false) === (b.noNewlineOld ?? false) &&
		(a.noNewlineNew ?? false) === (b.noNewlineNew ?? false)
	);
}

/**
 * Whether a source range of `count` lines mapped onto exactly the target
 * cluster's range on that side: every line mapped, contiguously, from its
 * start, and the counts agree. An empty source range (a pure addition's
 * old side, a pure deletion's new side) constrains nothing: the lines
 * decide.
 */
function rangeMatches(
	images: readonly (number | null)[],
	count: number,
	targetStart: number,
	targetCount: number,
): boolean {
	if (count === 0) return true;
	if (targetCount !== count) return false;
	const first = images[0];
	if (first !== targetStart) return false;
	return images.every((line, i) => line === targetStart + i);
}

/** A key's identity hash: the key without its occurrence suffix. */
const hashOf = (key: string) => key.replace(/:\d+$/, "");

function traceFile(
	ps: SourcePatchset,
	target: TargetFile,
	mappers: FileMappers,
): TracedCluster[] {
	const srcPath = mappers.oldPath ?? target.path;
	const source = ps.files.find((f) => f.path === srcPath);
	if (!source) return [];
	const rule: CarryRule = srcPath === target.path ? "exact" : "rename";
	const byNew = new Map<number, Cluster>();
	const byOld = new Map<number, Cluster>();
	const targetHashes = new Map<string, number>();
	let fileCluster: Cluster | undefined;
	for (const c of target.clusters) {
		targetHashes.set(hashOf(c.key), (targetHashes.get(hashOf(c.key)) ?? 0) + 1);
		if (c.kind === "file") {
			fileCluster ??= c;
			continue;
		}
		for (let i = 0; i < c.newCount; i++) byNew.set(c.newStart + i, c);
		for (let i = 0; i < c.oldCount; i++) byOld.set(c.oldStart + i, c);
	}

	const traced = source.clusters.map((s): TracedCluster => {
		const base = { from: ps.number, fromKey: s.key, path: srcPath, rule };
		if (s.kind === "file") {
			// A file-level change carries on its key alone: the key holds the
			// path, label and, for content without lines, both object ids.
			return {
				...base,
				images: fileCluster ? [fileCluster.key] : [],
				equal: fileCluster !== undefined && fileCluster.key === s.key,
			};
		}
		const newImages: (number | null)[] = [];
		for (let i = 0; i < s.newCount; i++) {
			newImages.push(mappers.bd.oldToNew(s.newStart + i));
		}
		const oldImages: (number | null)[] = [];
		for (let i = 0; i < s.oldCount; i++) {
			oldImages.push(mappers.ac.oldToNew(s.oldStart + i));
		}
		const candidates: Cluster[] = [];
		const consider = (c: Cluster | undefined) => {
			if (c && !candidates.includes(c)) candidates.push(c);
		};
		for (const line of newImages) if (line !== null) consider(byNew.get(line));
		for (const line of oldImages) if (line !== null) consider(byOld.get(line));
		const [only] = candidates;
		const exact =
			candidates.length === 1 &&
			only !== undefined &&
			rangeMatches(newImages, s.newCount, only.newStart, only.newCount) &&
			rangeMatches(oldImages, s.oldCount, only.oldStart, only.oldCount);
		return {
			...base,
			images: candidates.map((c) => c.key),
			equal: exact && only !== undefined && sameChange(s, only),
		};
	});

	// P12: clusters sharing an identity carry by occurrence only while the
	// source and the target hold the same number of them, each landing on
	// its own equal image; otherwise none of them carries.
	const groups = new Map<string, TracedCluster[]>();
	for (const t of traced) {
		const hash = hashOf(t.fromKey);
		groups.set(hash, [...(groups.get(hash) ?? []), t]);
	}
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		const images = group.flatMap((t) => t.images);
		const hashes = new Set(images.map(hashOf));
		const [imageHash] = hashes;
		const agree =
			group.every((t) => t.equal && t.images.length === 1) &&
			new Set(images).size === group.length &&
			hashes.size === 1 &&
			imageHash !== undefined &&
			targetHashes.get(imageHash) === group.length;
		if (!agree) for (const t of group) t.equal = false;
	}
	return traced;
}

/**
 * Where every cluster of every source patch set lands in the target: for
 * each target file, each source patch set it has mappers for (the latest
 * through the file's own, earlier ones through `earlier`), each cluster of
 * the paired source file. No states: the same for any marks.
 */
export function traceClusters(
	input: Pick<CarryInput, "sources" | "target">,
): TracedCluster[] {
	const traced: TracedCluster[] = [];
	const [latest, ...earlier] = input.sources;
	for (const target of input.target) {
		if (latest) traced.push(...traceFile(latest, target, target));
		for (const ps of earlier) {
			const mappers = target.earlier?.get(ps.number);
			if (mappers) traced.push(...traceFile(ps, target, mappers));
		}
	}
	return traced;
}

/**
 * The carries, reworks and gone clusters the traced landings give under
 * the reviewer's marks. Source patch sets latest first; for each cluster
 * key, the first patch set holding a human state for it decides (an
 * untick there is never undone by an older mark; a carried state is not
 * human and is skipped). A reviewed or crossed-off source with one equal
 * image carries it, unless a later patch set already did; one with images
 * but no equal one makes them reworked; one with none is gone when it is
 * the latest patch set's. Only the latest patch set's clusters count as
 * gone: an older one's absence was already shown at its own move.
 */
export function carryTraced(
	traced: readonly TracedCluster[],
	sources: readonly SourcePatchset[],
): CarryResult {
	const carried = new Map<string, CarriedState>();
	const reworked = new Set<string>();
	const gone: CarryResult["gone"] = [];
	const blocked = new Set<string>();
	sources.forEach((ps, i) => {
		const states = new Map<string, SourceState>();
		for (const file of ps.files) {
			for (const [key, state] of file.states) states.set(key, state);
		}
		for (const t of traced) {
			if (t.from !== ps.number || blocked.has(t.fromKey)) continue;
			const state = states.get(t.fromKey);
			if (!state || state.carried !== undefined) continue;
			blocked.add(t.fromKey);
			if (state.state === "unreviewed") continue;
			if (t.images.length === 0) {
				if (i === 0)
					gone.push({ fromKey: t.fromKey, from: t.from, path: t.path });
				continue;
			}
			const [image] = t.images;
			if (t.equal && t.images.length === 1 && image !== undefined) {
				if (carried.has(image)) continue;
				carried.set(image, {
					key: image,
					fromKey: t.fromKey,
					from: t.from,
					rule: t.rule,
					state: state.state,
				});
				reworked.delete(image);
			} else {
				for (const key of t.images) if (!carried.has(key)) reworked.add(key);
			}
		}
	});
	return { carried: [...carried.values()], reworked, gone };
}

/** `carryTraced(traceClusters(input), input.sources)`. */
export function carryClusters(input: CarryInput): CarryResult {
	return carryTraced(traceClusters(input), input.sources);
}
