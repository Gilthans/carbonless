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
import {
	createLineMapper,
	IDENTITY,
	type LineMapper,
	type MapHunk,
	TRACER_VERSION,
} from "../../shared/tracer/index.js";
import type {
	Cluster,
	DiffLine,
	FileHunks,
	FileStatus,
	RereviewAnswer,
	Snapshot,
} from "../../shared/types.js";
import { buildAllClusters } from "../diff/clusters.js";
import { listChangedFiles } from "../diff/files.js";
import { buildDisplayHunks } from "../diff/hunks.js";
import type { PatchsetRecord, StateEntry } from "../review/fold.js";
import type { PatchsetStart } from "../review/reviews.js";
import {
	buildInterdiff,
	type Interdiff,
	type InterdiffFile,
} from "./interdiff.js";
import { detectShape, type Shape } from "./shape.js";

/** Bumped when the engine's cached, state-free result could change for the same inputs. */
export const ENGINE_VERSION = 1;

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
const NONE: LineMapper = {
	oldToNew: () => null,
	newToOld: () => null,
	hunkRemovingOld: () => null,
	hunkAddingNew: () => null,
};

interface DiffEntry {
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
async function diffMap(
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

const linesMapper = (clusters: readonly Cluster[]) =>
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
	const lineKeys: Traced["lineKeys"] = { old: {}, new: {} };
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
	const prime = sinceBase
		? new Map<string, DiffEntry>()
		: await diffMap(repo, ps.head, interdiff.virtualHead, primePaths);
	const primeByOld = new Map<string, { path: string; mapper: LineMapper }>();
	for (const [path, entry] of prime) {
		primeByOld.set(entry.oldPath ?? path, {
			path,
			mapper: createLineMapper(entry.hunks),
		});
	}
	const targetByOld = new Map<string, TargetFile>();
	for (const t of targetFiles) targetByOld.set(t.oldPath ?? t.path, t);
	for (const file of ps.snapshot.files) {
		const toPrime = primeByOld.get(file.path);
		const primePath = toPrime?.path ?? file.path;
		const primeMapper = toPrime?.mapper ?? IDENTITY;
		const t = targetByOld.get(file.path);
		const cd = t ? linesMapper(t.clusters) : null;
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
	for (const f of files) {
		const count = f.clusters.filter(
			(c) => c.kind === "reworked" || c.kind === "new",
		).length;
		toReadClusters += count;
		if (count > 0 || f.conflict) toReadFiles++;
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
	};
	return { answer, start, absorbed };
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
 * The since view's hunks of one file: the interdiff's clusters of it over
 * its lines, the old side numbered in the virtual rebase (the new base for
 * a conflicted file), the new side in the new head. Each line's
 * `clusterKey` is what the page chips and marks by: an added line's is
 * the target cluster it is in (reworked or new), else the gone since
 * cluster whose removed line the author restored; a removed line's is the
 * gone since cluster it was an added line of, else its interdiff
 * cluster's first added line's. A conflicted file's keys are its target
 * clusters' on both sides (its interdiff is the target's own diff). A
 * file the interdiff doesn't touch has no hunks.
 */
export function interdiffFileHunks(
	traced: Traced,
	target: Snapshot,
	answer: RereviewAnswer,
	index: number,
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
						: (gone(goneOld[line.oldNo as number]) ?? firstAdd.get(temp));
			if (key === undefined) delete line.clusterKey;
			else line.clusterKey = key;
		}
	}
	return { hunks, newLineCount: file.newLines.length };
}
