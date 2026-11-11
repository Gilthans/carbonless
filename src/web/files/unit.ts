import { useState } from "react";
import { size } from "../../shared/lineRanges";
import type { Counts, FileView, Progress } from "../../shared/types";

/** The unit every count on the Files page is shown in. */
export type Unit = "lines" | "clusters" | "files";

export const UNITS: { id: Unit; label: string }[] = [
	{ id: "lines", label: "Lines" },
	{ id: "clusters", label: "Clusters" },
	{ id: "files", label: "Files" },
];

export const UNIT_STORAGE_KEY = "crb.files.unit";

const isUnit = (value: unknown): value is Unit =>
	UNITS.some((u) => u.id === value);

/** The remembered unit; lines when storage is empty, unknown or unavailable. */
export function readUnit(): Unit {
	try {
		const stored = localStorage.getItem(UNIT_STORAGE_KEY);
		return isUnit(stored) ? stored : "lines";
	} catch {
		return "lines";
	}
}

/** Remembers the unit for this viewer; silently does nothing without storage. */
export function writeUnit(unit: Unit): void {
	try {
		localStorage.setItem(UNIT_STORAGE_KEY, unit);
	} catch {
		// Storage is a convenience only.
	}
}

export function useUnit(): [Unit, (unit: Unit) => void] {
	const [unit, setUnit] = useState(readUnit);
	return [
		unit,
		(next) => {
			setUnit(next);
			writeUnit(next);
		},
	];
}

/** Reviewed out of what isn't crossed off, floored; 100 when nothing is left to review. */
export function percent({ total, reviewed, crossedOff }: Counts): number {
	const denominator = total - crossedOff;
	return denominator === 0 ? 100 : Math.floor((reviewed / denominator) * 100);
}

export function pageCounts(progress: Progress, unit: Unit): Counts {
	const { total, reviewed, crossedOff } = progress[unit];
	return { total, reviewed, crossedOff };
}

/** Clusters neither reviewed nor crossed off. */
export const clustersLeft = (progress: Progress) =>
	progress.clusters.total -
	progress.clusters.reviewed -
	progress.clusters.crossedOff;

/**
 * The page's percentage in the unit. Clusters without changed lines (a rename,
 * a mode change) weigh nothing in lines, so while any cluster is left the
 * percentage stays below 100 (0 when the unit has nothing to count):
 * nothing unreviewed may look finished.
 */
export function pagePercent(progress: Progress, unit: Unit): number {
	const counts = pageCounts(progress, unit);
	return capped(percent(counts), counts, clustersLeft(progress));
}

/** Caps a percentage below 100 while clusters are left (0 if nothing counts). */
function capped(value: number, counts: Counts, left: number): number {
	if (left === 0) return value;
	return counts.total === counts.crossedOff ? 0 : Math.min(value, 99);
}

/**
 * Everything the unit still counts was crossed off, and no cluster is left:
 * say "nothing left to review" rather than a bare 100%.
 */
export function nothingLeft(progress: Progress, unit: Unit): boolean {
	const counts = pageCounts(progress, unit);
	return (
		counts.total > 0 &&
		counts.total === counts.crossedOff &&
		clustersLeft(progress) === 0
	);
}

export interface FileUnitProgress {
	/** Counts behind the meter: clusters when the file has no changed lines. */
	counts: Counts;
	/** Never 100 while a cluster is unreviewed. */
	percent: number;
	/** "3 / 8" (reviewed / not crossed off), or null when `status` says it all. */
	fraction: string | null;
	/**
	 * "done", "crossed off" or "1 cluster left", when there's no fraction
	 * (see formatFileProgress for a partly crossed-off "done").
	 */
	status: string | null;
	/** Unreviewed clusters. */
	clustersLeft: number;
	/** Crossed-off clusters of a done file that isn't wholly crossed off (it counts reviewed). */
	partlyCrossedOff: number;
	/** The fraction looks finished but clusters without changed lines are left. */
	hiddenLeft: boolean;
}

const clustersPhrase = (n: number) =>
	`${n} ${n === 1 ? "cluster" : "clusters"}`;

/** Weighs a cluster by its lines (a partly reviewed one's reviewed lines count). */
const BY_LINES = (lines: number) => lines;
const BY_CLUSTER = () => 1;

function clusterCounts(file: FileView, weight: (lines: number) => number) {
	const counts: Counts = { total: 0, reviewed: 0, crossedOff: 0 };
	for (const c of file.clusters) {
		const w = weight(c.lines);
		counts.total += w;
		const crossed = weight === BY_LINES ? size(c.crossedLines ?? []) : 0;
		if (c.state === "reviewed") {
			counts.reviewed += w - crossed;
			counts.crossedOff += crossed;
		} else if (c.state === "crossed-off") counts.crossedOff += w;
		else if (weight === BY_LINES) {
			counts.reviewed += size(c.reviewedLines ?? []);
			counts.crossedOff += crossed;
		}
	}
	return counts;
}

/**
 * One file's progress in the unit, by the same rules as the page's bar. A
 * file counts crossed off only when every cluster is; a done file with any
 * reviewed cluster counts as reviewed.
 */
export function fileUnitProgress(file: FileView, unit: Unit): FileUnitProgress {
	const clustersLeft = file.clusters.filter(
		(c) => c.state === "unreviewed",
	).length;
	// The server's rule (FileView.reviewed), not re-derived here.
	const reviewed = file.reviewed;
	const partlyCrossedOff =
		file.done && !file.crossedOff
			? file.clusters.filter((c) => c.state === "crossed-off").length
			: 0;
	const base = { clustersLeft, partlyCrossedOff, hiddenLeft: false };
	// A finished file: "crossed off" when all of it is, else "done" (plus
	// how much was crossed off, when formatted).
	const finished = file.crossedOff ? "crossed off" : "done";
	if (unit === "files") {
		const counts = {
			total: 1,
			reviewed: reviewed ? 1 : 0,
			crossedOff: file.crossedOff ? 1 : 0,
		};
		return {
			...base,
			counts,
			percent: percent(counts),
			fraction: file.done ? null : "0 / 1",
			status: file.done ? finished : null,
		};
	}
	let counts = clusterCounts(file, unit === "lines" ? BY_LINES : BY_CLUSTER);
	const noLines = counts.total === 0;
	if (noLines) counts = clusterCounts(file, BY_CLUSTER);
	const value = capped(percent(counts), counts, clustersLeft);
	// Nothing to show as a fraction: no changed lines, or all of what's left
	// in the unit was crossed off.
	if (file.crossedOff || noLines || counts.total === counts.crossedOff) {
		return {
			...base,
			counts,
			percent: value,
			fraction: null,
			status: file.done ? finished : `${clustersPhrase(clustersLeft)} left`,
		};
	}
	return {
		...base,
		counts,
		percent: value,
		fraction: `${counts.reviewed} / ${counts.total - counts.crossedOff}`,
		status: null,
		hiddenLeft:
			clustersLeft > 0 &&
			counts.total - counts.reviewed - counts.crossedOff === 0,
	};
}

export interface FormatOptions {
	/** "3 / 8 lines" rather than "3 / 8". */
	withUnit?: boolean;
	/** "· 1 left" rather than "· 1 cluster left". */
	short?: boolean;
}

/** "lines", or "line" when `count` is 1. */
export function unitWord(unit: Unit, count?: number): string {
	const plural = UNITS.find((u) => u.id === unit)?.label.toLowerCase() ?? unit;
	return count === 1 ? plural.replace(/s$/, "") : plural;
}

export function formatFileProgress(
	p: FileUnitProgress,
	unit: Unit,
	opts: FormatOptions = {},
): string {
	if (p.status === "done" && p.partlyCrossedOff > 0) {
		return opts.short
			? `done · ⊘${p.partlyCrossedOff}`
			: `done · ${p.partlyCrossedOff} crossed off`;
	}
	if (p.status !== null || p.fraction === null) return p.status ?? "";
	let text = p.fraction;
	if (opts.withUnit && unit !== "files") {
		const shown = p.counts.total - p.counts.crossedOff;
		text += ` ${unitWord(unit, shown)}`;
	}
	if (p.hiddenLeft) {
		text += opts.short
			? ` · ${p.clustersLeft} left`
			: ` · ${clustersPhrase(p.clustersLeft)} left`;
	}
	return text;
}

/**
 * The file's progress as a sentence with the exact numbers, for tooltips and
 * screen readers: "3 of 8 lines reviewed, 2 crossed off", or the status.
 */
export function describeFileProgress(file: FileView, unit: Unit): string {
	const p = fileUnitProgress(file, unit);
	if (p.status !== null) return formatFileProgress(p, unit);
	const { counts } = p;
	const crossed =
		counts.crossedOff > 0 ? `, ${counts.crossedOff} crossed off` : "";
	const left = p.hiddenLeft
		? `, ${p.clustersLeft} ${p.clustersLeft === 1 ? "cluster" : "clusters"} without changed lines left`
		: "";
	const shown = counts.total - counts.crossedOff;
	return `${counts.reviewed} of ${shown} ${unitWord(unit, shown)} reviewed${crossed}${left}`;
}

export interface FolderUnitProgress {
	/**
	 * The folder's files' counts summed in the unit (clusters when none of
	 * them has changed lines), behind its meter.
	 */
	counts: Counts;
	/** Unreviewed clusters in any of its files. */
	clustersLeft: number;
	/** Files not done. */
	filesLeft: number;
	/** Every file is done (reviewed or crossed off). */
	done: boolean;
	/** Every file is wholly crossed off. */
	crossedOff: boolean;
	additions: number;
	deletions: number;
	/** Every cluster of its files, for the change count. */
	clusters: FileView["clusters"];
}

/**
 * A folder's accumulated progress: its files' counts summed, by the same
 * rules as a file's. Done only when every file is; a cluster left anywhere
 * keeps it unfinished (the meter `incomplete`), whatever the counts say.
 */
export function folderUnitProgress(
	files: readonly FileView[],
	unit: Unit,
): FolderUnitProgress {
	const sum = (weight: (lines: number) => number): Counts => {
		const counts: Counts = { total: 0, reviewed: 0, crossedOff: 0 };
		for (const file of files) {
			const c = clusterCounts(file, weight);
			counts.total += c.total;
			counts.reviewed += c.reviewed;
			counts.crossedOff += c.crossedOff;
		}
		return counts;
	};
	let counts: Counts;
	if (unit === "files") {
		counts = { total: 0, reviewed: 0, crossedOff: 0 };
		for (const file of files) {
			const c = fileUnitProgress(file, "files").counts;
			counts.total += c.total;
			counts.reviewed += c.reviewed;
			counts.crossedOff += c.crossedOff;
		}
	} else {
		counts = sum(unit === "lines" ? BY_LINES : BY_CLUSTER);
		if (counts.total === 0) counts = sum(BY_CLUSTER);
	}
	return {
		counts,
		clustersLeft: files.reduce(
			(n, f) => n + f.clusters.filter((c) => c.state === "unreviewed").length,
			0,
		),
		filesLeft: files.filter((f) => !f.done).length,
		done: files.every((f) => f.done),
		crossedOff: files.length > 0 && files.every((f) => f.crossedOff),
		additions: files.reduce((n, f) => n + f.additions, 0),
		deletions: files.reduce((n, f) => n + f.deletions, 0),
		clusters: files.flatMap((f) => f.clusters),
	};
}

/**
 * A folder's progress with the exact numbers, for its row's name and
 * tooltip: "3 / 8 lines · 2 files left", "1 / 3 files", "done" or
 * "crossed off". Files left are always said while any is, so a folder never
 * reads finished while something in it is unreviewed.
 */
export function describeFolderProgress(
	p: FolderUnitProgress,
	unit: Unit,
): string {
	if (p.done) return p.crossedOff ? "crossed off" : "done";
	const shown = p.counts.total - p.counts.crossedOff;
	const left = `${p.filesLeft} ${unitWord("files", p.filesLeft)} left`;
	if (unit === "files")
		return `${p.counts.reviewed} / ${shown} ${unitWord(unit, shown)}`;
	if (shown === 0) return left;
	return `${p.counts.reviewed} / ${shown} ${unitWord(unit, shown)} · ${left}`;
}
