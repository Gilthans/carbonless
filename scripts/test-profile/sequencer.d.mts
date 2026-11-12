import type path from "node:path";
import type { TestSpecification } from "vitest/node";
import { BaseSequencer } from "vitest/node";

export const DURATIONS_FILE: string;
export type Durations = Record<string, number>;
export function repoPath(
	root: string,
	file: string,
	paths?: Pick<typeof path, "relative">,
): string;
export function readDurations(root: string): Durations;

/** What the order knows about one file. */
export interface FileFacts {
	/** Vitest's cached result, when this tree has run the file before. */
	cached?: { duration: number; failed: boolean };
	/** The hint list's duration. */
	hint?: number;
	/** The file's size, the last resort. */
	size?: number;
}
export function compareFiles(a: FileFacts, b: FileFacts): number;

export class SlowFirstSequencer extends BaseSequencer {
	sort(files: TestSpecification[]): Promise<TestSpecification[]>;
}
