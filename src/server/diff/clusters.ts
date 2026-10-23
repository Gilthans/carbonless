import type { Cluster } from "../../shared/types.js";
import { runGit } from "../git.js";
import { type ChangedFile, DIFF_ARGS } from "./files.js";

export type LineCluster = Omit<Cluster, "key" | "kind" | "label"> & {
	noNewlineOld?: boolean;
	noNewlineNew?: boolean;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses `git diff -U0` output: every hunk is one cluster. */
export function parseU0Patch(patch: string): LineCluster[] {
	const clusters: LineCluster[] = [];
	let current: LineCluster | null = null;
	let last: "-" | "+" | null = null;
	const lines = patch.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	for (const line of lines) {
		const header = HUNK_HEADER.exec(line);
		if (header) {
			current = {
				oldStart: Number(header[1]),
				oldCount: header[2] === undefined ? 1 : Number(header[2]),
				newStart: Number(header[3]),
				newCount: header[4] === undefined ? 1 : Number(header[4]),
				removed: [],
				added: [],
				lines: 0,
			};
			clusters.push(current);
			last = null;
		} else if (!current) {
		} else if (line.startsWith("-")) {
			current.removed.push(line.slice(1));
			current.lines++;
			last = "-";
		} else if (line.startsWith("+")) {
			current.added.push(line.slice(1));
			current.lines++;
			last = "+";
		} else if (line.startsWith("\\")) {
			if (last === "-") current.noNewlineOld = true;
			else if (last === "+") current.noNewlineNew = true;
		}
	}
	return clusters;
}

const short = (oid: string) => oid.slice(0, 7);

/**
 * The synthetic cluster for changes that have no changed lines (or that
 * line clusters can't express), so nothing can be missed.
 */
export function fileLevelCluster(
	file: ChangedFile,
	hasLineClusters: boolean,
): Omit<Cluster, "key"> | null {
	const modeChanged =
		file.oldMode !== undefined &&
		file.newMode !== undefined &&
		file.oldMode !== file.newMode;
	let label: string | null = null;
	if (file.submodule) {
		label = `Submodule moved ${short(file.oldOid)} → ${short(file.newOid)}`;
	} else if (file.status === "renamed") {
		label = `Renamed from ${file.oldPath}`;
		if (modeChanged) {
			label += ` (mode ${file.oldMode} → ${file.newMode})`;
		}
	} else if (file.binary) {
		label = "Binary file changed";
	} else if (modeChanged) {
		label = `Mode changed ${file.oldMode} → ${file.newMode}`;
	} else if (!hasLineClusters && file.additions === 0 && file.deletions === 0) {
		if (file.status === "added") label = "Empty file added";
		else if (file.status === "deleted") label = "Empty file deleted";
	}
	if (label === null) return null;
	return {
		kind: "file",
		label,
		oldStart: 0,
		oldCount: 0,
		newStart: 0,
		newCount: 0,
		removed: [],
		added: [],
		lines: 0,
	};
}

const literal = (path: string) => `:(literal)${path}`;

/** File-level cluster first (if any), then line clusters in file order. */
export async function buildClusters(
	repo: string,
	base: string,
	head: string,
	file: ChangedFile,
): Promise<Omit<Cluster, "key">[]> {
	let lineClusters: Omit<Cluster, "key">[] = [];
	if (!file.binary && !file.submodule) {
		const paths = [file.oldPath, file.path]
			.filter((p): p is string => p !== undefined)
			.map(literal);
		const patch = await runGit(repo, [
			...DIFF_ARGS,
			"-U0",
			base,
			head,
			"--",
			...paths,
		]);
		lineClusters = parseU0Patch(patch).map(
			({ noNewlineOld, noNewlineNew, ...c }) => ({
				...c,
				kind: "lines" as const,
			}),
		);
	}
	const fileCluster = fileLevelCluster(file, lineClusters.length > 0);
	return fileCluster ? [fileCluster, ...lineClusters] : lineClusters;
}
