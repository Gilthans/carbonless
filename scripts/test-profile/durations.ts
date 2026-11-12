import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Span } from "./load";
import { DURATIONS_FILE, type Durations, readDurations } from "./sequencer.mjs";

/**
 * Each unit file's duration in a run (its `file:` span, test/setup.ts),
 * rounded to 100 ms so a refresh changes only what moved; a file run
 * twice keeps its longest. Keys with forward slashes (a Windows run's
 * backslashes turned), sorted, so diffs stay readable.
 */
export function fileDurations(spans: Span[]): Durations {
	const out = new Map<string, number>();
	for (const s of spans) {
		if (s.service !== "vitest" || s.attrs["crb.kind"] !== "file") continue;
		const raw = s.attrs["test.file"];
		if (typeof raw !== "string" || raw === "?") continue;
		const file = raw.replaceAll("\\", "/");
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

/** A run covering less than this share of the listed files is partial. */
export const MIN_COVERAGE = 0.9;
/** A file now under this share of its listed time dropped sharply. */
export const SHARP_DROP = 1 / 3;
/** Listed files shorter than this are noise for the drop check (ms). */
const DROP_FLOOR_MS = 1000;

export interface RefreshCheck {
	/** Why the run looks unfit to refresh the list from; empty: fine. */
	problems: string[];
	/** Files whose time changed, biggest change first: [file, old, new]. */
	changes: [string, number | undefined, number | undefined][];
}

/**
 * Whether `run` is fit to refresh the list `old`: a filtered (`-t`) run
 * runs every file but few tests, so many times drop sharply; a run of a
 * few files (`pnpm test <file>`, flake-check) covers few of the listed.
 */
export function checkRefresh(
	old: Durations,
	run: Durations,
	exists: (file: string) => boolean,
): RefreshCheck {
	const problems: string[] = [];
	const listed = Object.keys(old).filter(exists);
	const covered = listed.filter((f) => f in run).length;
	if (listed.length > 0 && covered < MIN_COVERAGE * listed.length) {
		problems.push(
			`the run covers ${covered} of the ${listed.length} listed files`,
		);
	}
	const compared = listed.filter(
		(f) => f in run && (old[f] as number) >= DROP_FLOOR_MS,
	);
	const dropped = compared.filter(
		(f) => (run[f] as number) < SHARP_DROP * (old[f] as number),
	);
	if (dropped.length > Math.max(2, 0.1 * compared.length)) {
		problems.push(
			`${dropped.length} of ${compared.length} files took under a third of their listed time`,
		);
	}
	const files = new Set([...listed, ...Object.keys(run)]);
	const changes = [...files]
		.map((f): RefreshCheck["changes"][number] => [f, old[f], run[f]])
		.filter(([, a, b]) => a !== b && b !== undefined)
		.sort(
			([, a1, b1], [, a2, b2]) =>
				Math.abs((b2 ?? 0) - (a2 ?? 0)) - Math.abs((b1 ?? 0) - (a1 ?? 0)),
		);
	return { problems, changes };
}

/** The biggest changes, one line each. */
export function formatChanges(
	changes: RefreshCheck["changes"],
	top = 10,
): string {
	const s = (ms: number | undefined) =>
		ms === undefined ? "new" : `${(ms / 1000).toFixed(1)}s`;
	return changes
		.slice(0, top)
		.map(([f, a, b]) => `  ${s(a)} → ${s(b)}  ${f}`)
		.join("\n");
}

/**
 * Writes the hint list the sequencer reads, after checkRefresh (throwing
 * its problems unless `force`); returns the run's file count and the
 * biggest changes, for printing.
 */
export function writeDurations(
	root: string,
	spans: Span[],
	force = false,
): { count: number; changes: string } {
	const run = fileDurations(spans);
	const count = Object.keys(run).length;
	if (count === 0) throw new Error("no unit file spans in this run");
	const exists = (f: string) => existsSync(join(root, f));
	const old = readDurations(root);
	const check = checkRefresh(old, run, exists);
	const changes = formatChanges(check.changes);
	if (check.problems.length > 0 && !force) {
		throw new Error(
			`not refreshing ${DURATIONS_FILE}: ${check.problems.join("; ")} (a filtered or partial run?). --force writes it anyway.\nbiggest changes:\n${changes}`,
		);
	}
	writeFileSync(
		join(root, DURATIONS_FILE),
		`${JSON.stringify(mergeDurations(old, run, exists), null, "\t")}\n`,
	);
	return { count, changes };
}
