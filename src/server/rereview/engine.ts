import {
	all,
	fromIndexes,
	has,
	type LineRanges,
	subtract,
	union,
} from "../../shared/lineRanges.js";
import {
	clusterAt,
	lineRuns,
	type SincePiece,
	sincePieces,
	sinceUnits,
} from "../../shared/pieces.js";
import {
	type CarriedState,
	type CarryResult,
	carryTraced,
	type FileMappers,
	type SourcePatchset,
	type TargetFile,
	type TracedCluster,
	traceClusters,
} from "../../shared/rereview/carry.js";
import { linesCarriedView } from "../../shared/rereview/overlay.js";
import {
	createLineMapper,
	IDENTITY,
	type LineMapper,
	type MapHunk,
	TRACER_VERSION,
} from "../../shared/tracer/index.js";
import type {
	Cluster,
	ClusterView,
	DiffLine,
	FileHunks,
	FileStatus,
	RereviewAnswer,
	Snapshot,
} from "../../shared/types.js";
import { matchDisplayHunk, whitespaceLines } from "../../shared/whitespace.js";
import { buildAllClusters } from "../diff/clusters.js";
import { listChangedFiles } from "../diff/files.js";
import { buildDisplayHunks, contextLines } from "../diff/hunks.js";
import { type HumanMarks, humanMarksOf } from "../review/coverage.js";
import type { LinesCarriedEntry } from "../review/events.js";
import type { PatchsetRecord, StateEntry } from "../review/fold.js";
import type { PatchsetStart } from "../review/reviews.js";
import {
	buildInterdiff,
	type Interdiff,
	type InterdiffFile,
} from "./interdiff.js";
import { detectShape, type Shape } from "./shape.js";

/** Bumped when the engine's cached, state-free result could change for the same inputs. */
export const ENGINE_VERSION = 5;

/** The patch set a comparison is from, with its snapshot and folded states. */
export type SincePatchset = PatchsetRecord & {
	baseBranch: string;
	snapshot: Snapshot;
	states: Map<string, StateEntry>;
};

/** An earlier patch set the carry may fall back on (P8). */
export type EarlierPatchset = PatchsetRecord & {
	snapshot: Snapshot;
	states: Map<string, StateEntry>;
};

export type TargetSnapshot = Snapshot & { baseBranch: string };

/**
 * The engine's state-free work for one comparison, what the cache holds:
 * the shape, the interdiff, where every source cluster lands, and which
 * source cluster each line of the interdiff that the since view can't key
 * by a target cluster belongs to (an old-side line of the virtual rebase
 * that a since cluster added; a new-side line a since cluster had removed
 * and the author restored), by path and line.
 */
export interface Traced {
	shape: Shape;
	interdiff: Interdiff;
	traced: TracedCluster[];
	lineKeys: {
		/** By the virtual rebase's path, old line → since cluster key. */
		old: Record<string, Record<number, string>>;
		/** By the new head's path, new line → since cluster key. */
		new: Record<string, Record<number, string>>;
		/**
		 * By the new head's path, a line of the new merge base → the since
		 * cluster that removed it (its image through the bases' diff).
		 */
		base?: Record<string, Record<number, string>>;
		/**
		 * By the virtual rebase's path, for each file of the since patch set:
		 * an interdiff removed line (its old-side number) → the line of the
		 * new merge base it is, by position (through the virtual rebase, the
		 * patch set's own diff and the bases' diff); absent for a line the
		 * patch set added or one that can't be mapped. A file the since
		 * patch set didn't touch maps each line to itself (its old side is
		 * the new base); a file with no entry maps nothing (fails closed).
		 */
		baseLine?: Record<string, Record<number, number>>;
		/**
		 * By the virtual rebase's path, for each clean file of the
		 * interdiff: an interdiff removed line (its old-side number) → the
		 * line of the new merge base it is, by the virtual rebase's own diff
		 * against that base: GitHub's LEFT line on the head (CAR-217).
		 * Absent for a line the virtual rebase adds to the base (only the
		 * patch sets had it). Unlike `baseLine` it never goes through the
		 * old base, so a line the base move changed still maps.
		 */
		githubLeft?: Record<string, Record<number, number>>;
		/**
		 * By the virtual rebase's path, for each clean file of the
		 * interdiff: a removed line `githubLeft` has no base line for (only
		 * the patch sets had it) → its line in the since patch set's head,
		 * when that is an added line of the patch set's own diff (GitHub's
		 * RIGHT line on that commit, where a comment on it goes, CAR-233).
		 * Absent when the file has another path there.
		 */
		earlierRight?: Record<string, Record<number, number>>;
		/**
		 * By the virtual rebase's path: removed lines the since patch set's
		 * diff adds, but at another path than the head's (a rename between
		 * that patch set and the head): no comment can name them by the
		 * head's path on that commit (CAR-233).
		 */
		earlierMoved?: Record<string, number[]>;
	};
}

/** The cache key of a comparison: the two snapshot ids and the versions. */
export const rereviewKey = (
	fromRevision: string,
	toRevision: string,
	/** The earlier patch sets' snapshot ids, latest first (their numbers are the review's own). */
	earlierRevisions: readonly string[] = [],
) =>
	`${fromRevision}:${toRevision}:${earlierRevisions.join("+")}:${TRACER_VERSION}.${ENGINE_VERSION}`;

/** A mapper under which no line survives (the file is not on that side). */
export const NONE: LineMapper = {
	oldToNew: () => null,
	newToOld: () => null,
	hunkRemovingOld: () => null,
	hunkAddingNew: () => null,
	hunks: [],
};

export interface DiffEntry {
	oldPath?: string;
	status: FileStatus;
	hunks: MapHunk[];
}

/** A path as a pathspec that matches it alone (no globs, no magic). */
const literal = (path: string) => `:(literal)${path}`;

/**
 * The files changed from `old` to `fresh` among `paths`, by their new
 * path, with their -U0 hunks: the line mappers' input.
 */
export async function diffMap(
	repo: string,
	old: string,
	fresh: string,
	paths: Set<string>,
): Promise<Map<string, DiffEntry>> {
	const map = new Map<string, DiffEntry>();
	if (old === fresh || paths.size === 0) return map;
	const pathspec = [...paths].map(literal);
	const changed = await listChangedFiles(repo, old, fresh, pathspec);
	if (changed.length === 0) return map;
	const clusters = await buildAllClusters(
		repo,
		old,
		fresh,
		changed,
		[],
		pathspec,
	);
	changed.forEach((f, i) => {
		map.set(f.path, {
			...(f.oldPath === undefined ? {} : { oldPath: f.oldPath }),
			status: f.status,
			hunks: (clusters[i] ?? [])
				.filter((c) => c.kind === "lines")
				.map(({ oldStart, oldCount, newStart, newCount }) => ({
					oldStart,
					oldCount,
					newStart,
					newCount,
				})),
		});
	});
	return map;
}

/** The paths a snapshot's files have on either side. */
function pathsOf(snapshot: Snapshot, into: Set<string>): void {
	for (const f of snapshot.files) {
		into.add(f.path);
		if (f.oldPath !== undefined) into.add(f.oldPath);
	}
}

export const linesMapper = (clusters: readonly Cluster[]) =>
	createLineMapper(clusters.filter((c) => c.kind === "lines"));

/**
 * The mappers of one source patch set into each target file: `bd` from
 * the source head's file (its path there, through the rename pair) and
 * `ac` from the source base's file to the target base's.
 */
async function mappersInto(
	repo: string,
	source: { mergeBase: string; head: string; snapshot: Snapshot },
	target: Snapshot,
): Promise<Map<string, FileMappers>> {
	const paths = new Set<string>();
	pathsOf(target, paths);
	pathsOf(source.snapshot, paths);
	const [bd, ac] = await Promise.all([
		diffMap(repo, source.head, target.head, paths),
		diffMap(repo, source.mergeBase, target.base, paths),
	]);
	const result = new Map<string, FileMappers>();
	for (const file of target.files) {
		const head = bd.get(file.path);
		// Not in the source head: nothing of it could have been reviewed.
		if (head?.status === "added") continue;
		const base = ac.get(file.oldPath ?? file.path);
		result.set(file.path, {
			bd: head ? createLineMapper(head.hunks) : IDENTITY,
			ac:
				base === undefined
					? IDENTITY
					: base.status === "added"
						? NONE
						: createLineMapper(base.hunks),
			...(head?.oldPath !== undefined ? { oldPath: head.oldPath } : {}),
		});
	}
	return result;
}

const sourceOf = (ps: {
	number: number;
	snapshot: Snapshot;
	states: Map<string, StateEntry>;
}): SourcePatchset => ({
	number: ps.number,
	files: ps.snapshot.files.map((f) => ({
		path: f.path,
		clusters: f.clusters,
		states: ps.states,
	})),
});

/**
 * The engine's state-free work: the shape of the move, the interdiff, and
 * where every cluster of the since patch set (and of the earlier ones)
 * lands in the target. Runs git (shape, interdiff, one diff per source
 * patch set for the heads and one for the bases, each limited to the
 * files involved); the rest is the pure tracer and carry.
 */
export async function traceRereview(
	repo: string,
	ps: Omit<SincePatchset, "states">,
	earlier: Omit<EarlierPatchset, "states">[],
	target: TargetSnapshot,
	signal?: AbortSignal,
): Promise<Traced> {
	const from = {
		mergeBase: ps.mergeBase,
		head: ps.head,
		baseBranch: ps.baseBranch,
	};
	const to = {
		mergeBase: target.base,
		head: target.head,
		baseBranch: target.baseBranch,
	};
	const shape = await detectShape(repo, from, to, signal);
	const interdiff = await buildInterdiff(repo, shape, from, to, signal);
	const lineKeys: Traced["lineKeys"] = {
		old: {},
		new: {},
		base: {},
		baseLine: {},
	};
	// No carry across an unavailable interdiff: nothing is traced.
	if (interdiff.status !== "available") {
		return { shape, interdiff, traced: [], lineKeys };
	}
	const conflicted = new Set(
		interdiff.files.filter((f) => f.conflict).map((f) => f.path),
	);
	const [latest, ...older] = await Promise.all(
		[ps, ...earlier].map((s) => mappersInto(repo, s, target)),
	);
	const targetFiles: TargetFile[] = [];
	const conflictedSources = new Set<string>();
	for (const file of target.files) {
		const own = latest?.get(file.path);
		if (!own) continue;
		if (conflicted.has(file.path))
			conflictedSources.add(own.oldPath ?? file.path);
		const earlierMappers = new Map<number, FileMappers>();
		older.forEach((m, i) => {
			const mappers = m.get(file.path);
			const record = earlier[i];
			if (mappers && record) earlierMappers.set(record.number, mappers);
		});
		targetFiles.push({
			path: file.path,
			clusters: file.clusters,
			...own,
			...(earlierMappers.size > 0 ? { earlier: earlierMappers } : {}),
		});
	}
	// A conflicted file is all new: the author's resolution is to read, so
	// nothing lands in it (and nothing of it counts as gone).
	const traced = traceClusters({
		sources: [ps, ...earlier].map((s) => ({
			number: s.number,
			files: s.snapshot.files.map((f) => ({
				path: f.path,
				clusters: f.clusters,
				states: new Map(),
			})),
		})),
		target: targetFiles,
	}).filter((t) => !conflictedSources.has(t.path));

	// Lines of the interdiff a since cluster accounts for: its added lines
	// as they sit in the virtual rebase (old side), and its removed lines
	// where the author restored them in the new head (new side).
	const sinceBase = ps.mergeBase === target.base;
	const primePaths = new Set<string>();
	pathsOf(ps.snapshot, primePaths);
	for (const f of interdiff.files) {
		primePaths.add(f.path);
		if (f.oldPath !== undefined) primePaths.add(f.oldPath);
	}
	// The virtual rebase against the new base too (GitHub's LEFT lines of
	// the since view's removed ones, below), alongside.
	const [prime, rebaseDiff] = sinceBase
		? [new Map<string, DiffEntry>(), null]
		: await Promise.all([
				diffMap(repo, ps.head, interdiff.virtualHead, primePaths),
				diffMap(repo, target.base, interdiff.virtualHead, primePaths),
			]);
	const primeByOld = new Map<string, { path: string; mapper: LineMapper }>();
	for (const [path, entry] of prime) {
		primeByOld.set(entry.oldPath ?? path, {
			path,
			mapper: createLineMapper(entry.hunks),
		});
	}
	const targetByOld = new Map<string, TargetFile>();
	for (const t of targetFiles) targetByOld.set(t.oldPath ?? t.path, t);
	const interdiffByOld = new Map(
		interdiff.files.map((f) => [f.oldPath ?? f.path, f]),
	);
	// A file the since patch set didn't touch: its old side is the new base.
	const touched = new Set(
		ps.snapshot.files.map((f) => primeByOld.get(f.path)?.path ?? f.path),
	);
	for (const f of interdiff.files) {
		const primePath = f.oldPath ?? f.path;
		if (touched.has(primePath) || f.conflict) continue;
		// New in the virtual rebase against the patch set's head: perhaps a
		// file it touched under a name the rename detection didn't pair. No
		// map (fails closed: its lines are never read as left alone).
		if (prime.get(primePath)?.status === "added") continue;
		const same: Record<number, number> = {};
		for (const ic of f.clusters) {
			if (ic.kind !== "lines") continue;
			for (let i = 0; i < ic.oldCount; i++) {
				same[ic.oldStart + i] = ic.oldStart + i;
			}
		}
		const placed = lineKeys.baseLine ?? {};
		placed[primePath] = same;
		lineKeys.baseLine = placed;
	}
	// GitHub's LEFT line of each removed line the since view shows: the
	// virtual rebase against the new base (the patch set's own diff when
	// the base didn't move).
	const githubLeft: Record<string, Record<number, number>> = {};
	const earlierRight: Record<string, Record<number, number>> = {};
	const earlierMoved: Record<string, number[]> = {};
	for (const f of interdiff.files) {
		if (f.conflict) continue;
		const primePath = f.oldPath ?? f.path;
		let toBase: LineMapper = IDENTITY;
		// The base file this map counts in (the path it had there).
		let basePath = primePath;
		if (rebaseDiff) {
			const entry = rebaseDiff.get(primePath);
			if (entry) {
				toBase = createLineMapper(entry.hunks);
				basePath = entry.oldPath ?? primePath;
			}
		} else {
			const own = ps.snapshot.files.find((x) => x.path === primePath);
			if (own) {
				toBase = linesMapper(own.clusters);
				basePath = own.oldPath ?? primePath;
			}
		}
		// GitHub pairs the head's file with its base file over the whole
		// tree; this diff, over the PR's paths, may pair it with another.
		// Then no map: its removed lines are refused, never named in the
		// wrong file.
		const headFile = target.files.find((t) => t.path === f.path);
		if (headFile && (headFile.oldPath ?? headFile.path) !== basePath) continue;
		// The since patch set's own file at this path (the virtual rebase
		// back to its head), for lines no base has.
		const own = ps.snapshot.files.find(
			(x) => (primeByOld.get(x.path)?.path ?? x.path) === primePath,
		);
		const toHead = own ? (primeByOld.get(own.path)?.mapper ?? IDENTITY) : null;
		// The same path on that commit and in the head: a comment names it.
		const samePath = own?.path === primePath && f.path === primePath;
		const added = (h1: number) =>
			own?.clusters.some(
				(c) =>
					c.kind === "lines" &&
					c.newStart <= h1 &&
					h1 < c.newStart + c.newCount,
			) === true;
		const lines: Record<number, number> = {};
		const earlier: Record<number, number> = {};
		const moved: number[] = [];
		for (const ic of f.clusters) {
			if (ic.kind !== "lines") continue;
			for (let i = 0; i < ic.oldCount; i++) {
				const n = ic.oldStart + i;
				const b = toBase.newToOld(n);
				if (b !== null) {
					lines[n] = b;
					continue;
				}
				const h1 = toHead?.newToOld(n) ?? null;
				if (h1 === null || !added(h1)) continue;
				if (samePath) earlier[n] = h1;
				else moved.push(n);
			}
		}
		githubLeft[primePath] = lines;
		earlierRight[primePath] = earlier;
		if (moved.length > 0) earlierMoved[primePath] = moved;
	}
	lineKeys.githubLeft = githubLeft;
	lineKeys.earlierRight = earlierRight;
	lineKeys.earlierMoved = earlierMoved;
	for (const file of ps.snapshot.files) {
		const toPrime = primeByOld.get(file.path);
		const primePath = toPrime?.path ?? file.path;
		const primeMapper = toPrime?.mapper ?? IDENTITY;
		const t = targetByOld.get(file.path);
		const cd = t ? linesMapper(t.clusters) : null;
		// Each removed line the since view shows, as the new base's line.
		const baseLines: Record<number, number> = {};
		const shownFile = interdiffByOld.get(primePath);
		if (t && shownFile && !shownFile.conflict) {
			const own = linesMapper(file.clusters);
			for (const ic of shownFile.clusters) {
				if (ic.kind !== "lines") continue;
				for (let i = 0; i < ic.oldCount; i++) {
					const h1 = primeMapper.newToOld(ic.oldStart + i);
					const b1 = h1 === null ? null : own.newToOld(h1);
					const b2 = b1 === null ? null : t.ac.oldToNew(b1);
					if (b2 !== null) baseLines[ic.oldStart + i] = b2;
				}
			}
		}
		const placed = lineKeys.baseLine ?? {};
		placed[primePath] = baseLines;
		lineKeys.baseLine = placed;
		for (const c of file.clusters) {
			if (c.kind !== "lines") continue;
			for (let i = 0; i < c.newCount; i++) {
				const line = primeMapper.oldToNew(c.newStart + i);
				if (line === null) continue;
				const old = lineKeys.old[primePath] ?? {};
				old[line] = c.key;
				lineKeys.old[primePath] = old;
			}
			if (!t || !cd) continue;
			for (let i = 0; i < c.oldCount; i++) {
				const b2 = t.ac.oldToNew(c.oldStart + i);
				if (b2 === null) continue;
				const bases = lineKeys.base ?? {};
				const removedHere = bases[t.path] ?? {};
				removedHere[b2] = c.key;
				bases[t.path] = removedHere;
				lineKeys.base = bases;
				const h2 = cd.oldToNew(b2);
				if (h2 === null) continue;
				const fresh = lineKeys.new[t.path] ?? {};
				fresh[h2] = c.key;
				lineKeys.new[t.path] = fresh;
			}
		}
	}
	// A since cluster with no image whose lines the interdiff doesn't show
	// either (no removal at its place in the virtual rebase, no restored
	// line in the new head) went into the base: absorbed, not gone.
	// A file-level since cluster (binary, submodule, mode) is shown by the
	// interdiff's file-level cluster, or deletion, of the path it came from.
	const fileKeys = new Map<string, string[]>();
	for (const file of ps.snapshot.files) {
		fileKeys.set(
			file.path,
			file.clusters.filter((c) => c.kind === "file").map((c) => c.key),
		);
	}
	const shown = new Set<string>();
	for (const f of interdiff.files) {
		const old = lineKeys.old[f.oldPath ?? f.path] ?? {};
		const fresh = lineKeys.new[f.path] ?? {};
		if (f.status === "deleted" || f.clusters.some((c) => c.kind === "file")) {
			for (const key of fileKeys.get(f.oldPath ?? f.path) ?? []) {
				shown.add(key);
			}
		}
		for (const c of f.clusters) {
			if (c.kind !== "lines") continue;
			for (let i = 0; i < c.oldCount; i++) {
				const key = old[c.oldStart + i];
				if (key !== undefined) shown.add(key);
			}
			for (let i = 0; i < c.newCount; i++) {
				const key = fresh[c.newStart + i];
				if (key !== undefined) shown.add(key);
			}
		}
	}
	for (const t of traced) {
		if (
			t.from === ps.number &&
			t.images.length === 0 &&
			!shown.has(t.fromKey)
		) {
			t.absorbed = true;
		}
	}
	return { shape, interdiff, traced, lineKeys };
}

/**
 * The answer and the patch set start the traced landings give under the
 * marks as they stand now: carries by the pure rule, every cluster of
 * the target by kind, gone clusters under their file (or, for a file only
 * the interdiff has, a file entry past the snapshot's), and the counts.
 */
export function answerRereview(
	traced: Traced,
	ps: SincePatchset,
	earlier: EarlierPatchset[],
	target: TargetSnapshot,
): {
	answer: RereviewAnswer;
	start: PatchsetStart;
	absorbed: CarryResult["absorbed"];
	/**
	 * The since patch set's human marks the answer's pieces were judged by
	 * (humanMarksOf): the page's hunks take the same (Session.#interdiffOf).
	 */
	sources: ReadonlyMap<string, HumanMarks>;
} {
	const { shape, interdiff } = traced;
	const { carried, reworked, gone, absorbed } = carryTraced(
		traced.traced,
		[ps, ...earlier].map(sourceOf),
	);
	const carriedByKey = new Map(carried.map((c) => [c.key, c]));
	const conflicted = new Set(
		interdiff.status === "available"
			? interdiff.files.filter((f) => f.conflict).map((f) => f.path)
			: [],
	);
	// Gone clusters hang under the target file their source file became
	// (the rename pair, or the same path), else under the interdiff's file.
	const goneByPath = new Map<
		string,
		RereviewAnswer["files"][number]["clusters"]
	>();
	const targetPathOf = new Map<string, string>();
	for (const file of target.files) {
		targetPathOf.set(file.path, file.path);
		if (file.oldPath !== undefined) targetPathOf.set(file.oldPath, file.path);
	}
	for (const g of gone) {
		const path = targetPathOf.get(g.path) ?? g.path;
		goneByPath.set(path, [
			...(goneByPath.get(path) ?? []),
			{ key: g.fromKey, kind: "gone", from: g.from },
		]);
	}
	const files: RereviewAnswer["files"] = target.files.map((file) => ({
		index: file.index,
		path: file.path,
		conflict: conflicted.has(file.path),
		clusters: [
			...file.clusters.map(
				(c): RereviewAnswer["files"][number]["clusters"][number] => {
					const carry = carriedByKey.get(c.key);
					if (carry) {
						return {
							key: c.key,
							kind: "carried",
							from: carry.from,
							state: carry.state,
							rule: carry.rule,
						};
					}
					if (reworked.has(c.key)) return { key: c.key, kind: "reworked" };
					return { key: c.key, kind: "new" };
				},
			),
			...(goneByPath.get(file.path) ?? []),
		],
	}));
	const listed = new Set(target.files.map((f) => f.path));
	const extra: string[] = [];
	if (interdiff.status === "available") {
		for (const f of interdiff.files) {
			if (!listed.has(f.path) && !extra.includes(f.path)) extra.push(f.path);
		}
	}
	for (const path of goneByPath.keys()) {
		if (!listed.has(path) && !extra.includes(path)) extra.push(path);
	}
	extra.forEach((path, i) => {
		files.push({
			index: target.files.length + i,
			path,
			conflict: conflicted.has(path),
			clusters: goneByPath.get(path) ?? [],
		});
	});
	let toReadFiles = 0;
	let toReadClusters = 0;
	// The same count without the whitespace-only clusters (what a reviewer
	// with "Ignore whitespace" on reads); the page picks by its switch.
	const wsKeys = new Set(
		target.files.flatMap((f) =>
			f.clusters.filter((c) => c.whitespaceOnly).map((c) => c.key),
		),
	);
	let countedFiles = 0;
	let countedClusters = 0;
	for (const f of files) {
		const read = f.clusters.filter(
			(c) => c.kind === "reworked" || c.kind === "new",
		);
		const count = read.length;
		const counted = read.filter((c) => !wsKeys.has(c.key)).length;
		toReadClusters += count;
		countedClusters += counted;
		if (count > 0 || f.conflict) toReadFiles++;
		if (counted > 0 || f.conflict) countedFiles++;
	}
	const answer: RereviewAnswer = {
		from: ps.number,
		toHead: target.head,
		toRevision: target.revision,
		shape,
		interdiff: interdiff.status,
		...(interdiff.status === "unavailable" ? { reason: interdiff.reason } : {}),
		files,
		toRead: { files: toReadFiles, clusters: toReadClusters },
		threads: [],
	};
	if (countedFiles !== toReadFiles || countedClusters !== toReadClusters) {
		answer.toRead.withoutWhitespaceOnly = {
			files: countedFiles,
			clusters: countedClusters,
		};
	}
	// The since view's pieces, every one of them (its counts count them:
	// sinceUnits), with the since patch set's states for what they own; to
	// read is every unit, as nothing of the target is marked yet.
	// The line carries (CAR-195): a reworked or new cluster's lines no
	// piece shows take the mark their counterparts held on the since patch
	// set (by hand), one to one.
	const linesCarried: LinesCarriedEntry[] = [];
	const sources = humanMarksOf(ps.snapshot, ps.states);
	if (interdiff.status === "available") {
		for (const f of files) {
			const { pieces = [] } = interdiffFileHunks(
				traced,
				target,
				answer,
				f.index,
				sources,
			);
			if (pieces.length > 0) f.pieces = pieces;
			const carries = sinceLineCarries(
				traced,
				target,
				answer,
				f.index,
				pieces,
				sources,
			);
			for (const c of f.clusters) {
				if (c.kind !== "reworked" && c.kind !== "new") continue;
				const mine = carries.filter((e) => e.key === c.key);
				if (mine.length === 0) continue;
				const of = (state: LinesCarriedEntry["state"]) =>
					mine
						.filter((e) => e.state === state)
						.reduce<LineRanges>((all, e) => union(all, e.lines), []);
				const reviewedLines = of("reviewed");
				const crossedLines = of("crossed-off");
				c.lines = {
					...(reviewedLines.length > 0 ? { reviewed: reviewedLines } : {}),
					...(crossedLines.length > 0 ? { crossed: crossedLines } : {}),
				};
				linesCarried.push(...mine);
			}
		}
		// The target as the carries leave it: a carried cluster holds its
		// mark (not to read), every other is unmarked.
		// By index once (the first, as a scan finds): a scan per file is
		// quadratic in the files.
		const targetAt = new Map<number, (typeof target.files)[number]>();
		for (const t of target.files) {
			if (!targetAt.has(t.index)) targetAt.set(t.index, t);
		}
		const linesOf = new Map(
			files.flatMap((f) =>
				f.clusters.flatMap((c) => (c.lines ? [[c.key, c.lines] as const] : [])),
			),
		);
		const unmarked = (index: number): ClusterView[] =>
			(targetAt.get(index)?.clusters ?? []).map((c): ClusterView => {
				const carry = carriedByKey.get(c.key);
				if (carry) {
					return {
						...c,
						state: carry.state,
						carried: { from: carry.from, rule: carry.rule },
					};
				}
				return linesCarriedView(
					{ ...c, state: "unreviewed" },
					linesOf.get(c.key),
					ps.number,
				);
			});
		const units = sinceUnits(files, ps.number, unmarked, undefined);
		const byFile = new Set(units.map((u) => u.index));
		for (const f of files) if (f.conflict) byFile.add(f.index);
		answer.toRead = { files: byFile.size, clusters: units.length };
		const counted = units.filter((u) => !u.whitespaceOnly);
		if (counted.length !== units.length) {
			const countedFiles = new Set(counted.map((u) => u.index));
			for (const f of files) if (f.conflict) countedFiles.add(f.index);
			answer.toRead.withoutWhitespaceOnly = {
				files: countedFiles.size,
				clusters: counted.length,
			};
		}
	}
	// One carried event per (source patch set, rule).
	const events = new Map<string, PatchsetStart["carried"][number]>();
	for (const c of carried) {
		const id = `${c.from}:${c.rule}`;
		let event = events.get(id);
		if (!event) {
			event = { type: "carried", from: c.from, rule: c.rule, states: [] };
			events.set(id, event);
		}
		event.states.push(entryOf(c));
	}
	const start: PatchsetStart = {
		since: ps.number,
		shape: shape.code,
		baseBranch: target.baseBranch,
		interdiff: interdiff.status,
		carried: [...events.values()],
		...(linesCarried.length > 0
			? { linesCarried: { from: ps.number, states: linesCarried } }
			: {}),
	};
	return { answer, start, absorbed, sources };
}

const entryOf = (c: CarriedState) => ({
	key: c.key,
	fromKey: c.fromKey,
	state: c.state,
});

/** `traceRereview` then `answerRereview`, in one call. */
export async function computeRereview(
	repo: string,
	ps: SincePatchset,
	earlier: EarlierPatchset[],
	target: TargetSnapshot,
	signal?: AbortSignal,
): Promise<{
	answer: RereviewAnswer;
	start: PatchsetStart;
	interdiff: Interdiff;
	absorbed: CarryResult["absorbed"];
}> {
	const traced = await traceRereview(repo, ps, earlier, target, signal);
	const { answer, start, absorbed } = answerRereview(
		traced,
		ps,
		earlier,
		target,
	);
	return { answer, start, interdiff: traced.interdiff, absorbed };
}

/** The interdiff's file for the answer's file at `index` (RangeError for none). */
function interdiffFileAt(
	traced: Traced,
	answer: RereviewAnswer,
	index: number,
): { entry: RereviewAnswer["files"][number]; file: InterdiffFile | null } {
	const entry = answer.files[index];
	if (!entry || entry.index !== index) {
		throw new RangeError(`No file ${index} in this snapshot`);
	}
	const file =
		traced.interdiff.status === "available"
			? (traced.interdiff.files.find((f) => f.path === entry.path) ?? null)
			: null;
	return { entry, file };
}

/**
 * The `<treeish>:<path>` name of one side of the since view's file at
 * `index`, from the same interdiff its hunks come from, so the two can't
 * drift apart: the old side is the virtual rebase's (`H1'`), or for a
 * conflicted file the target's merge base (`B2`), never the patch set's
 * own commit; the new side is the target head's. A file the interdiff
 * doesn't list is the head's on both sides. Null for a side the file
 * hasn't (an added file's old, a deleted file's new) and for the old side
 * without an interdiff. RangeError for an index the answer hasn't.
 */
export function interdiffBlobName(
	traced: Traced,
	target: Snapshot,
	answer: RereviewAnswer,
	index: number,
	side: "old" | "new",
): string | null {
	const { entry, file } = interdiffFileAt(traced, answer, index);
	if (traced.interdiff.status !== "available") {
		return side === "old" ? null : `${target.head}:${entry.path}`;
	}
	if (!file) {
		const own = target.files.find((f) => f.path === entry.path);
		return own?.status === "deleted" ? null : `${target.head}:${entry.path}`;
	}
	if (side === "new") {
		return file.status === "deleted" ? null : `${target.head}:${file.path}`;
	}
	if (file.status === "added") return null;
	const tree = file.conflict ? target.base : traced.interdiff.virtualHead;
	return `${tree}:${file.oldPath ?? file.path}`;
}

/**
 * The since view's unchanged lines `newFrom..newTo` of one file, for its
 * gaps: the interdiff's context, the old side numbered as its hunks' are
 * (interdiffFileHunks), so lines the patch set added and left unchanged
 * since load too. `untouched`: the interdiff doesn't change the file, so
 * both sides are the new head's lines (the caller reads them); `none`:
 * no interdiff to read (unavailable).
 */
export function interdiffFileContext(
	traced: Traced,
	answer: RereviewAnswer,
	index: number,
	newFrom: number,
	newTo: number,
): DiffLine[] | "untouched" | "none" {
	const { file } = interdiffFileAt(traced, answer, index);
	if (traced.interdiff.status !== "available") return "none";
	if (!file) return "untouched";
	const clusters: Cluster[] = file.clusters
		.filter((c) => c.kind === "lines")
		.map((c, i) => ({ ...c, key: String(i) }));
	return contextLines(
		file.oldLines,
		file.newLines,
		clusters,
		newFrom,
		newTo,
		file.noNewlineAtEnd,
	);
}

/**
 * The since view's hunks of one file: the interdiff's clusters of it over
 * its lines, the old side numbered in the virtual rebase (the new base for
 * a conflicted file), the new side in the new head. Each line's
 * `clusterKey` is what the page chips and marks by: an added line's is
 * the target cluster it is in (reworked or new), else the gone since
 * cluster whose removed line the author restored; a removed line's is the
 * gone since cluster it was an added line of, else the target cluster
 * that removes it (a base line at that place with its text), else its
 * interdiff cluster's first added line's, else the target cluster at its
 * place. Each run of changed lines is a piece (`pieces`). A conflicted file's keys are its target
 * clusters' on both sides (its interdiff is the target's own diff). A
 * file the interdiff doesn't touch has no hunks (the caller makes it one
 * whole-file gap, Session.interdiffHunks).
 *
 * `sources`: the compared patch set's human marks (humanMarksOf), for the
 * pieces' whitespace flag (CAR-218): a piece is whitespace-only when its
 * lines are on the interdiff and each one's counterpart at the compared
 * patch set held a mark there, or was a base line it left alone
 * (sinceWhitespace). Without it no piece is (they all count).
 */
export function interdiffFileHunks(
	traced: Traced,
	target: Snapshot,
	answer: RereviewAnswer,
	index: number,
	sources?: ReadonlyMap<string, HumanMarks>,
): FileHunks {
	const { entry, file } = interdiffFileAt(traced, answer, index);
	if (!file) return { hunks: [], newLineCount: 0 };
	if (file.clusters.every((c) => c.kind !== "lines")) {
		return { hunks: [], newLineCount: file.newLines.length };
	}
	const targetFile = target.files.find((f) => f.path === entry.path);
	const byNew = new Map<number, string>();
	const byOld = new Map<number, string>();
	for (const c of targetFile?.clusters ?? []) {
		if (c.kind !== "lines") continue;
		for (let i = 0; i < c.newCount; i++) byNew.set(c.newStart + i, c.key);
		for (let i = 0; i < c.oldCount; i++) byOld.set(c.oldStart + i, c.key);
	}
	const goneKeys = new Set(
		entry.clusters.filter((c) => c.kind === "gone").map((c) => c.key),
	);
	const goneOld = traced.lineKeys.old[file.oldPath ?? file.path] ?? {};
	const goneNew = traced.lineKeys.new[file.path] ?? {};
	const gone = (key: string | undefined) =>
		key !== undefined && goneKeys.has(key) ? key : undefined;

	// Temporary keys name each interdiff cluster; the lines are re-keyed below.
	const TEMP = "\0";
	const clusters: Cluster[] = file.clusters
		.filter((c) => c.kind === "lines")
		.map((c, i) => ({ ...c, key: `${TEMP}${i}` }));
	const hunks = buildDisplayHunks(
		file.oldLines,
		file.newLines,
		clusters,
		3,
		file.noNewlineAtEnd,
	);
	const addKey = (line: DiffLine): string | undefined => {
		const newNo = line.newNo as number;
		return (
			byNew.get(newNo) ?? (file.conflict ? undefined : gone(goneNew[newNo]))
		);
	};
	const targetClusters = targetFile?.clusters ?? [];
	// A removed line's line in the new base, by position: a conflicted
	// file's old side is the new base; else the engine's map (none for a
	// line the patch set added, one it can't map, or a file it has no map
	// for: such a line is none of a cluster's).
	const mapped = traced.lineKeys.baseLine?.[file.oldPath ?? file.path];
	const baseNo = (line: DiffLine): number | undefined =>
		line.kind !== "del" || line.oldNo === undefined
			? undefined
			: file.conflict
				? line.oldNo
				: mapped?.[line.oldNo];
	/** The target cluster that removes a removed base line (by its place in the new base). */
	const removedBy = (line: DiffLine): string | undefined => {
		const b = baseNo(line);
		if (b === undefined) return undefined;
		return targetClusters.find(
			(c) =>
				c.kind === "lines" &&
				c.oldCount > 0 &&
				c.oldStart <= b &&
				b < c.oldStart + c.oldCount,
		)?.key;
	};
	for (const hunk of hunks) {
		// The first added line's key of each interdiff cluster, for its removed lines.
		const firstAdd = new Map<string, string | undefined>();
		for (const line of hunk.lines) {
			if (
				line.kind === "add" &&
				line.clusterKey &&
				!firstAdd.has(line.clusterKey)
			) {
				firstAdd.set(line.clusterKey, addKey(line));
			}
		}
		for (const line of hunk.lines) {
			if (!line.clusterKey?.startsWith(TEMP)) continue;
			const temp = line.clusterKey;
			const key =
				line.kind === "add"
					? addKey(line)
					: file.conflict
						? byOld.get(line.oldNo as number)
						: (gone(goneOld[line.oldNo as number]) ??
							removedBy(line) ??
							firstAdd.get(temp));
			if (key === undefined) delete line.clusterKey;
			else line.clusterKey = key;
		}
		// A removal with no key (no added line beside it, no gone cluster's):
		// the target cluster at its place, when there is one (the author
		// changed that place again; its lines are then that cluster's piece).
		if (!file.conflict) {
			let before = hunk.newStart - 1;
			for (const line of hunk.lines) {
				if (line.newNo !== undefined) before = line.newNo;
				else if (line.kind === "del" && line.clusterKey === undefined) {
					const at = clusterAt(targetClusters, before);
					if (at) line.clusterKey = at.key;
				}
			}
		}
	}
	// Each run of changed lines is a piece (pieces.ts): it owns the lines it
	// shows; a removed line shown is one of the cluster's only when it isn't
	// a line the patch set added. A line no piece shows is unchanged since
	// the compared patch set: it takes its mark there, if any, as a carry
	// (sinceLineCarries), never through a piece.
	// The keys are final here: the view matches these same arrays (its `~`
	// rows), so the pieces' cut and its rows agree, the cap's per-run
	// fallback included.
	const pieces = sincePieces(
		hunks,
		targetClusters,
		() => ({ baseNo }),
		sinceWhitespace(traced, entry.path, file, hunks, sources),
	);
	// A removed line's GitHub line on the head (LEFT, in the base): what a
	// comment on it posts with, never its number here (CAR-217). A
	// conflicted file's old side is the base; else the virtual rebase's
	// diff against it (null: a line only the patch sets had). A file with
	// no such map leaves it unset, which the page refuses (fails closed).
	const left = file.conflict
		? undefined
		: traced.lineKeys.githubLeft?.[file.oldPath ?? file.path];
	const earlier = file.conflict
		? undefined
		: traced.lineKeys.earlierRight?.[file.oldPath ?? file.path];
	const moved = new Set(
		file.conflict
			? []
			: (traced.lineKeys.earlierMoved?.[file.oldPath ?? file.path] ?? []),
	);
	for (const hunk of hunks) {
		for (const line of hunk.lines) {
			if (line.kind !== "del" || line.oldNo === undefined) continue;
			if (file.conflict) line.baseNo = line.oldNo;
			else if (left) {
				line.baseNo = left[line.oldNo] ?? null;
				// Only the patch sets had it: its line on the compared patch
				// set's commit, when that commit's diff adds it (CAR-233).
				const ps = line.baseNo === null ? earlier?.[line.oldNo] : undefined;
				if (ps !== undefined) line.psNo = ps;
				else if (line.baseNo === null && moved.has(line.oldNo)) {
					line.psMoved = true;
				}
			}
		}
	}
	return { hunks, newLineCount: file.newLines.length, pieces };
}

/**
 * The since view's whitespace-only lines of one file and whether each was
 * read at the compared patch set (CAR-218): `lines`, every interdiff
 * display hunk's `whitespaceLines` that the view draws as `~` rows;
 * `marked(line)`, the line's counterpart
 * on the interdiff's old side (the compared patch set's head, rebased)
 * left nothing to read there: it held a human mark (`sources`,
 * humanMarksOf), traced as the line carries trace lines (sinceLineSources
 * over `lineKeys.old`), or it is a base line that patch set left alone
 * (no cluster added it, nor one of its slider twins, and `lineKeys.baseLine`
 * places it in the new base), as the full diff leaves the same re-indent
 * out. A removed line's counterpart is itself; an added line's, its twin
 * in the matching (a removed or context line; a context twin counts only
 * when marked, never as left alone: an extra copy of a line kept is new).
 * No counterpart, a changed line unmarked or not traced, one already
 * taken, a conflicted file, or no `sources`: not marked (principle 2: it
 * counts). A file nothing of which was marked there and whose interdiff
 * removes no line left alone skips the matching: no lines, so its pieces
 * aren't cut at whitespace runs either (they all count).
 */
function sinceWhitespace(
	traced: Traced,
	path: string,
	file: InterdiffFile,
	hunks: readonly { lines: readonly DiffLine[] }[],
	sources: ReadonlyMap<string, HumanMarks> | undefined,
): { lines: ReadonlySet<DiffLine>; marked: (line: DiffLine) => boolean } {
	const lines = new Set<DiffLine>();
	const none = { lines, marked: () => false };
	if (!sources || file.conflict) return none;
	const addedThen = traced.lineKeys.old[file.oldPath ?? file.path] ?? {};
	// Nothing of this file marked at the compared patch set: no piece can
	// be whitespace-only, so no matching and no cut (its pieces count).
	const anyMarked = [...new Set(Object.values(addedThen))].some((key) => {
		const marks = sources.get(key);
		return !!marks && (marks.reviewed.length > 0 || marks.crossed.length > 0);
	});
	// A base line that patch set left alone, placed in the new base (a
	// positive answer: a line the map can't place is not one).
	const placed = traced.lineKeys.baseLine?.[file.oldPath ?? file.path] ?? {};
	const leftAlone = (oldNo: number) =>
		addedThen[oldNo] === undefined && placed[oldNo] !== undefined;
	// ... or one the interdiff removes: its re-indent may be left out too.
	const anyLeftAlone =
		!anyMarked &&
		file.clusters.some((c) => {
			if (c.kind !== "lines") return false;
			for (let i = 0; i < c.oldCount; i++) {
				if (leftAlone(c.oldStart + i)) return true;
			}
			return false;
		});
	if (!anyMarked && !anyLeftAlone) return none;
	const twins = new Map<DiffLine, DiffLine>();
	for (const hunk of hunks) {
		const ws = whitespaceLines(hunk.lines);
		for (const [l, t] of matchDisplayHunk(hunk.lines)) twins.set(l, t);
		// Only what the view draws as `~` (src/web/files/whitespace.ts
		// hunkView, pairRun): a keyed run of removed lines, then added ones.
		// An unkeyed run, or one of another shape, shows its lines plain:
		// they count.
		for (const run of lineRuns(hunk.lines)) {
			if (!run.change || run.key === undefined) continue;
			const firstAdd = run.lines.findIndex((l) => l.kind === "add");
			const shaped =
				firstAdd < 0 ||
				run.lines.slice(firstAdd).every((l) => l.kind === "add");
			if (!shaped) continue;
			for (const l of run.lines) if (ws.has(l)) lines.add(l);
		}
	}
	if (lines.size === 0) return none;
	const then = sinceLineSources(
		sources,
		addedThen,
		traced.lineKeys.base?.[path] ?? {},
		file.oldLines,
	);
	// sinceLineSources answers each earlier line once: asked again (a
	// removed line and the added twin that pairs with it), the first answer.
	const byOld = new Map<number, boolean>();
	const markedAt = (oldNo: number, removed: boolean): boolean => {
		let marked = byOld.get(oldNo);
		if (marked === undefined) {
			// Left alone at that patch set: nothing was there to read (only
			// a removed line, positively placed in the new base).
			if (removed && leftAlone(oldNo) && then.untouched(oldNo)) {
				byOld.set(oldNo, true);
				return true;
			}
			const source = then.added(oldNo);
			const marks = source && sources.get(source.key);
			marked =
				!!source &&
				!!marks &&
				(has(marks.reviewed, source.index) || has(marks.crossed, source.index));
			byOld.set(oldNo, marked);
		}
		return marked;
	};
	return {
		lines,
		marked: (line) => {
			const old =
				line.kind === "del"
					? line
					: line.kind === "add"
						? twins.get(line)
						: undefined;
			if (!old || old.kind === "add" || old.oldNo === undefined) return false;
			return markedAt(old.oldNo, old.kind === "del");
		},
	};
}

/** A line of a cluster of the compared patch set (its own line index). */
export interface LineSource {
	key: string;
	index: number;
}

/**
 * Which line of the compared patch set each line the since view doesn't
 * show stands for (CAR-195). `added(line)`: a line of the since view's
 * old side (the virtual rebase) that a cluster of that patch set added
 * (`addedThen`, by key); or a line none added that is the twin of one
 * such line by git's slider: the same text right next to a run of one
 * cluster's added lines, so the same diff could show either as the added
 * one (PS1's diff took the second of two blank lines, PS2's the first);
 * a line two runs claim stands for none. `removed(line)`: a line of the
 * new merge base that a cluster removed (`removedThen`). A line's place
 * in its cluster is its rank among the cluster's lines in the map, only
 * when the map holds all of them (else none: fails closed). One to one:
 * each earlier line stands for one line at most, the first asked about
 * (itself or one of its twins); a later ask gets none. `untouched(line)`:
 * no cluster added the line and it is no slider twin of one (a line the
 * patch set left alone, as far as these maps tell). Make one per file
 * of the since view, and ask each line once.
 */
export function sinceLineSources(
	sources: ReadonlyMap<string, { cluster: Cluster }>,
	addedThen: Readonly<Record<number, string>>,
	removedThen: Readonly<Record<number, string>>,
	oldLines: readonly string[],
): {
	added: (line: number) => LineSource | null;
	removed: (line: number) => LineSource | null;
	untouched: (line: number) => boolean;
} {
	const byKey = (map: Readonly<Record<number, string>>) => {
		const out = new Map<string, number[]>();
		for (const [line, key] of Object.entries(map)) {
			const list = out.get(key) ?? [];
			list.push(Number(line));
			out.set(key, list);
		}
		for (const list of out.values()) list.sort((a, b) => a - b);
		return out;
	};
	/** Each line's rank among its key's lines. */
	const ranks = (by: Map<string, number[]>) => {
		const out = new Map<number, number>();
		for (const list of by.values()) {
			for (const [i, l] of list.entries()) out.set(l, i);
		}
		return out;
	};
	const addedBy = byKey(addedThen);
	const removedBy = byKey(removedThen);
	const addedRank = ranks(addedBy);
	const removedRank = ranks(removedBy);
	const sourceOf = (
		map: Readonly<Record<number, string>>,
		lines: Map<string, number[]>,
		rankOf: Map<number, number>,
		side: "removed" | "added",
		line: number,
	): LineSource | null => {
		const key = map[line];
		const then = key === undefined ? undefined : sources.get(key);
		const rank = rankOf.get(line);
		if (key === undefined || !then || rank === undefined) return null;
		const { cluster } = then;
		const removed = cluster.removed.length;
		const count = side === "removed" ? removed : cluster.added.length;
		if ((lines.get(key) ?? []).length !== count) return null;
		return { key, index: side === "removed" ? rank : removed + rank };
	};

	// Slider twins of each run [s, e) of one cluster's added lines: up,
	// line s - 1 when it reads as line e - 1; down, line e when it reads as
	// line s; slid on, each further line stands in for the line its twin
	// did (`origin`).
	const twins = new Map<number, number[]>();
	const text = (line: number) => oldLines[line - 1];
	const free = (line: number) =>
		line >= 1 && line <= oldLines.length && addedThen[line] === undefined;
	for (const list of addedBy.values()) {
		for (let i = 0; i < list.length; ) {
			let j = i + 1;
			while (j < list.length && list[j] === (list[j - 1] as number) + 1) j++;
			const s = list[i] as number;
			const e = (list[j - 1] as number) + 1;
			i = j;
			const origin = new Map<number, number>();
			for (let l = s; l < e; l++) origin.set(l, l);
			for (let a = s, b = e; free(a - 1) && text(a - 1) === text(b - 1); ) {
				origin.set(a - 1, origin.get(b - 1) as number);
				a--;
				b--;
			}
			for (let a = s, b = e; free(b) && text(b) === text(a); ) {
				origin.set(b, origin.get(a) as number);
				a++;
				b++;
			}
			for (const [l, from] of origin) {
				if (l < s || l >= e) twins.set(l, [...(twins.get(l) ?? []), from]);
			}
		}
	}
	// The earlier lines taken already, by side.
	const usedAdded = new Set<number>();
	const usedRemoved = new Set<number>();
	return {
		added: (line) => {
			const of = twins.get(line);
			const from =
				addedThen[line] !== undefined
					? line
					: of?.length === 1
						? of[0]
						: undefined;
			if (from === undefined || usedAdded.has(from)) return null;
			usedAdded.add(from);
			return sourceOf(addedThen, addedBy, addedRank, "added", from);
		},
		removed: (line) => {
			if (usedRemoved.has(line)) return null;
			usedRemoved.add(line);
			return sourceOf(removedThen, removedBy, removedRank, "removed", line);
		},
		untouched: (line) => addedThen[line] === undefined && !twins.has(line),
	};
}

/**
 * The line carries into one file of the target (CAR-195): each line of a
 * reworked or new cluster that no piece of the since view owns (so
 * unchanged since the compared patch set), whose counterpart there
 * (sinceLineSources) the reviewer marked by hand (`sources`, humanMarksOf)
 * reviewed or crossed off, takes that mark: one entry per (cluster,
 * cluster it came from, state). A line with no counterpart, or one not
 * marked then, gets nothing (principle 2: it stays to read). A conflicted
 * file carries nothing.
 */
export function sinceLineCarries(
	traced: Traced,
	target: Snapshot,
	answer: RereviewAnswer,
	index: number,
	pieces: readonly SincePiece[],
	sources: ReadonlyMap<string, HumanMarks>,
): LinesCarriedEntry[] {
	if (traced.interdiff.status !== "available") return [];
	const { entry, file } = interdiffFileAt(traced, answer, index);
	if (file?.conflict) return [];
	const targetFile = target.files.find((f) => f.path === entry.path);
	if (!targetFile) return [];
	const kinds = new Map(entry.clusters.map((c) => [c.key, c.kind]));
	const owned = new Map<string, LineRanges>();
	for (const p of pieces) {
		if (p.key === undefined || !p.owns) continue;
		owned.set(p.key, union(owned.get(p.key) ?? [], p.owns));
	}
	const primePath = file ? (file.oldPath ?? file.path) : entry.path;
	const lines = sinceLineSources(
		sources,
		traced.lineKeys.old[primePath] ?? {},
		traced.lineKeys.base?.[entry.path] ?? {},
		file?.oldLines ?? [],
	);
	// A file the interdiff doesn't touch: its old side is the new head.
	const interdiff = file
		? createLineMapper(file.clusters.filter((c) => c.kind === "lines"))
		: IDENTITY;
	const pairs = new Map<
		string,
		{
			key: string;
			fromKey: string;
			state: LinesCarriedEntry["state"];
			to: number[];
			from: number[];
		}
	>();
	for (const c of targetFile.clusters) {
		if (c.kind !== "lines") continue;
		const kind = kinds.get(c.key);
		if (kind !== "reworked" && kind !== "new") continue;
		const rest = subtract(all(c.lines), owned.get(c.key) ?? []);
		const removed = c.removed.length;
		for (const [start, end] of rest) {
			for (let i = start; i < end; i++) {
				let source: LineSource | null = null;
				if (i < removed) source = lines.removed(c.oldStart + i);
				else {
					const h1 = interdiff.newToOld(c.newStart + i - removed);
					source = h1 === null ? null : lines.added(h1);
				}
				if (!source) continue;
				const then = sources.get(source.key);
				if (!then) continue;
				const state = has(then.reviewed, source.index)
					? "reviewed"
					: has(then.crossed, source.index)
						? "crossed-off"
						: null;
				if (!state) continue;
				const id = `${c.key}:${source.key}:${state}`;
				const pair = pairs.get(id) ?? {
					key: c.key,
					fromKey: source.key,
					state,
					to: [],
					from: [],
				};
				pair.to.push(i);
				pair.from.push(source.index);
				pairs.set(id, pair);
			}
		}
	}
	return [...pairs.values()].map((p) => ({
		key: p.key,
		fromKey: p.fromKey,
		state: p.state,
		lines: fromIndexes(p.to),
		fromLines: fromIndexes(p.from),
	}));
}
