// Starts the slowest unit files first (docs/test-profiling.md, "Unit file
// order"). Loaded by vitest.config.ts; plain JS (types in sequencer.d.mts)
// so the config loads without Vite bundling a TypeScript import.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { BaseSequencer } from "vitest/node";

/**
 * Unit files' durations (ms) from a traced run, keyed by path from the repo
 * root with forward slashes: `pnpm test-profile --write-durations`
 * refreshes it.
 */
export const DURATIONS_FILE = "scripts/test-profile/unit-durations.json";

/**
 * `file`'s path from `root` with forward slashes on every OS, so the list
 * has one key per file. `paths`: node:path's own (tests pass `path.win32`).
 */
export function repoPath(root, file, paths = path) {
	return paths.relative(root, file).replaceAll("\\", "/");
}

/** The checked-in hint list; empty when missing or unreadable. */
export function readDurations(root) {
	try {
		const parsed = JSON.parse(
			readFileSync(path.join(root, DURATIONS_FILE), "utf8"),
		);
		if (!parsed || typeof parsed !== "object") return {};
		return Object.fromEntries(
			Object.entries(parsed).filter(
				([, ms]) => typeof ms === "number" && Number.isFinite(ms),
			),
		);
	} catch {
		return {};
	}
}

/**
 * Compares two files for the order they start in: failed first (cache),
 * then the longest known duration (Vitest's cache, else the hint list),
 * then files with no duration largest first. Longest first means the
 * slowest files never start last and run alone at the end.
 */
export function compareFiles(a, b) {
	const aFailed = a.cached?.failed ?? false;
	const bFailed = b.cached?.failed ?? false;
	if (aFailed !== bFailed) return aFailed ? -1 : 1;
	const aMs = a.cached?.duration ?? a.hint;
	const bMs = b.cached?.duration ?? b.hint;
	if (aMs !== undefined && bMs !== undefined) return bMs - aMs;
	// A known duration first: the list covers every file it saw, so an
	// unknown one is new since and size is a guess.
	if (aMs !== undefined) return -1;
	if (bMs !== undefined) return 1;
	return (b.size ?? 0) - (a.size ?? 0);
}

/**
 * Vitest's BaseSequencer with the hint list between its cache and file
 * size, so a fresh tree (or CI, which never has the cache) starts the
 * slow files first too. Sharding is BaseSequencer's.
 */
export class SlowFirstSequencer extends BaseSequencer {
	async sort(files) {
		const root = this.ctx.config.root;
		const hints = readDurations(root);
		const facts = new Map();
		for (const spec of files) {
			const cached = this.ctx.cache.getTestSpecificationResult(spec);
			const hint = hints[repoPath(root, spec.moduleId)];
			facts.set(spec, {
				cached: cached
					? { duration: cached.duration, failed: cached.failed }
					: undefined,
				hint,
				size: cached || hint !== undefined ? undefined : sizeOf(spec.moduleId),
			});
		}
		return [...files].sort((a, b) => {
			// BaseSequencer's own keys first: groups, projects, isolation.
			const group =
				a.project.config.sequence.groupOrder -
				b.project.config.sequence.groupOrder;
			if (group !== 0) return group;
			if (a.project.name !== b.project.name) {
				return a.project.name < b.project.name ? -1 : 1;
			}
			if (a.project.config.isolate !== b.project.config.isolate) {
				return a.project.config.isolate ? -1 : 1;
			}
			return compareFiles(facts.get(a), facts.get(b));
		});
	}
}

function sizeOf(file) {
	try {
		return statSync(file).size;
	} catch {
		return undefined;
	}
}
