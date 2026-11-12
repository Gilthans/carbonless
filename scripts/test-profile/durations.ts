import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Span } from "./load";
import { DURATIONS_FILE, type Durations, readDurations } from "./sequencer";

/**
 * Each unit file's duration in a run (its `file:` span, test/setup.ts),
 * rounded to 100 ms so a refresh changes only what moved; a file run
 * twice keeps its longest. Sorted by path, so diffs stay readable.
 */
export function fileDurations(spans: Span[]): Durations {
	const out = new Map<string, number>();
	for (const s of spans) {
		if (s.service !== "vitest" || s.attrs["crb.kind"] !== "file") continue;
		const file = s.attrs["test.file"];
		if (typeof file !== "string" || file === "?") continue;
		const ms = Math.max(100, Math.round((s.endMs - s.startMs) / 100) * 100);
		out.set(file, Math.max(out.get(file) ?? 0, ms));
	}
	return Object.fromEntries([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * The list after a run: the run's files take its durations, files it
 * didn't run keep theirs (a partial run updates only what it ran), and
 * files no longer in the tree drop out.
 */
export function mergeDurations(
	old: Durations,
	run: Durations,
	exists: (file: string) => boolean,
): Durations {
	const merged = { ...old, ...run };
	return Object.fromEntries(
		Object.entries(merged)
			.filter(([file]) => file in run || exists(file))
			.sort(([a], [b]) => (a < b ? -1 : 1)),
	);
}

/** Writes the hint list the sequencer reads; returns the run's file count. */
export function writeDurations(root: string, spans: Span[]): number {
	const run = fileDurations(spans);
	const count = Object.keys(run).length;
	if (count === 0) throw new Error("no unit file spans in this run");
	const merged = mergeDurations(readDurations(root), run, (f) =>
		existsSync(join(root, f)),
	);
	writeFileSync(
		join(root, DURATIONS_FILE),
		`${JSON.stringify(merged, null, "\t")}\n`,
	);
	return count;
}
