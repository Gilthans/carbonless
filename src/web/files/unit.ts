import { useState } from "react";
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

export interface FileUnitProgress {
	/** Counts behind the meter: clusters when the file has no changed lines. */
	counts: Counts;
	/** Never 100 while a cluster is unreviewed. */
	percent: number;
	/** "3 / 8" (reviewed / not crossed off), or null when `status` says it all. */
	fraction: string | null;
	/** "done", "crossed off" or "1 cluster left", when there's no fraction. */
	status: string | null;
	/** Unreviewed clusters. */
	clustersLeft: number;
	/** The fraction looks finished but clusters without changed lines are left. */
	hiddenLeft: boolean;
}

const clustersPhrase = (n: number) =>
	`${n} ${n === 1 ? "cluster" : "clusters"}`;

function clusterCounts(file: FileView, weight: (lines: number) => number) {
	const counts: Counts = { total: 0, reviewed: 0, crossedOff: 0 };
	for (const c of file.clusters) {
		const w = weight(c.lines);
		counts.total += w;
		if (c.state === "reviewed") counts.reviewed += w;
		else if (c.state === "crossed-off") counts.crossedOff += w;
	}
	return counts;
}

/**
 * One file's progress in the unit, by the same rules as the page's bar. A
 * file counts reviewed only when every cluster is; a done file with any
 * crossed-off cluster counts as crossed off.
 */
export function fileUnitProgress(file: FileView, unit: Unit): FileUnitProgress {
	const clustersLeft = file.clusters.filter(
		(c) => c.state === "unreviewed",
	).length;
	const allReviewed =
		file.clusters.length > 0 &&
		file.clusters.every((c) => c.state === "reviewed");
	const finished = file.done
		? { status: allReviewed ? "done" : "crossed off", fraction: null }
		: null;
	if (unit === "files") {
		const counts = {
			total: 1,
			reviewed: allReviewed ? 1 : 0,
			crossedOff: file.done && !allReviewed ? 1 : 0,
		};
		return {
			counts,
			percent: percent(counts),
			fraction: finished ? null : "0 / 1",
			status: finished?.status ?? null,
			clustersLeft,
			hiddenLeft: false,
		};
	}
	let counts = clusterCounts(file, unit === "lines" ? (n) => n : () => 1);
	const noLines = counts.total === 0;
	if (noLines) counts = clusterCounts(file, () => 1);
	const value = capped(percent(counts), counts, clustersLeft);
	if (file.crossedOff || noLines) {
		return {
			counts,
			percent: value,
			fraction: null,
			status: file.crossedOff
				? "crossed off"
				: (finished?.status ?? `${clustersPhrase(clustersLeft)} left`),
			clustersLeft,
			hiddenLeft: false,
		};
	}
	return {
		counts,
		percent: value,
		fraction: `${counts.reviewed} / ${counts.total - counts.crossedOff}`,
		status: null,
		clustersLeft,
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

export const unitWord = (unit: Unit) =>
	UNITS.find((u) => u.id === unit)?.label.toLowerCase() ?? unit;

export function formatFileProgress(
	p: FileUnitProgress,
	unit: Unit,
	opts: FormatOptions = {},
): string {
	if (p.status !== null || p.fraction === null) return p.status ?? "";
	let text = p.fraction;
	if (opts.withUnit && unit !== "files") text += ` ${unitWord(unit)}`;
	if (p.hiddenLeft) {
		text += opts.short
			? ` · ${p.clustersLeft} left`
			: ` · ${clustersPhrase(p.clustersLeft)} left`;
	}
	return text;
}
