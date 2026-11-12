import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { TestSpecification } from "vitest/node";
import { BaseSequencer } from "vitest/node";

/**
 * Unit files' durations (ms) from a traced run, keyed by path from the repo
 * root: `pnpm test-profile unit --write-durations` refreshes it
 * (docs/test-profiling.md).
 */
export const DURATIONS_FILE = "scripts/test-profile/unit-durations.json";

export type Durations = Record<string, number>;

/** The checked-in hint list; empty when missing or unreadable. */
export function readDurations(root: string): Durations {
	try {
		const parsed = JSON.parse(
			readFileSync(join(root, DURATIONS_FILE), "utf8"),
		) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		return Object.fromEntries(
			Object.entries(parsed).filter(
				(e): e is [string, number] =>
					typeof e[1] === "number" && Number.isFinite(e[1]),
			),
		);
	} catch {
		return {};
	}
}

/** What the order knows about one file. */
export interface FileFacts {
	/** Vitest's cached result, when this tree has run the file before. */
	cached?: { duration: number; failed: boolean };
	/** The hint list's duration. */
	hint?: number;
	/** The file's size, the last resort. */
	size?: number;
}

/**
 * Compares two files for the order they start in: failed first (cache),
 * then the longest known duration (Vitest's cache, else the hint list),
 * then files with no duration largest first. Longest first means the
 * slowest files never start last and run alone at the end.
 */
export function compareFiles(a: FileFacts, b: FileFacts): number {
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
	override async sort(
		files: TestSpecification[],
	): Promise<TestSpecification[]> {
		const root = this.ctx.config.root;
		const hints = readDurations(root);
		const facts = new Map<TestSpecification, FileFacts>();
		for (const spec of files) {
			const cached = this.ctx.cache.getTestSpecificationResult(spec);
			const hint = hints[relative(root, spec.moduleId)];
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
			return compareFiles(facts.get(a) as FileFacts, facts.get(b) as FileFacts);
		});
	}
}

function sizeOf(path: string): number | undefined {
	try {
		return statSync(path).size;
	} catch {
		return undefined;
	}
}
