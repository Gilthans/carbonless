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
	const value = percent(counts);
	if (clustersLeft(progress) === 0) return value;
	return counts.total === counts.crossedOff ? 0 : Math.min(value, 99);
}

export interface FileUnitProgress {
	/** The unit shown: clusters when the file has no changed lines to count. */
	unit: Unit;
	counts: Counts;
	/** "3 / 8" (reviewed / not crossed off), "done", or "crossed off". */
	text: string;
}

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

/** One file's progress in the unit, by the same rule as the page's bar. */
export function fileUnitProgress(file: FileView, unit: Unit): FileUnitProgress {
	let shown = unit;
	let counts: Counts;
	if (unit === "files") {
		counts = {
			total: 1,
			reviewed: file.done && !file.crossedOff ? 1 : 0,
			crossedOff: file.crossedOff ? 1 : 0,
		};
	} else {
		counts = clusterCounts(file, unit === "lines" ? (n) => n : () => 1);
		if (counts.total === 0) {
			shown = "clusters";
			counts = clusterCounts(file, () => 1);
		}
	}
	let text: string;
	if (file.crossedOff) text = "crossed off";
	else if (unit === "files") text = file.done ? "done" : "0 / 1";
	else text = `${counts.reviewed} / ${counts.total - counts.crossedOff}`;
	return { unit: shown, counts, text };
}
