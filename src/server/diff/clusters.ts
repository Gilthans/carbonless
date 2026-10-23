import type { Cluster } from "../../shared/types.js";
import { GitError, runGit } from "../git.js";
import { type ChangedFile, DIFF_ARGS } from "./files.js";

export type LineCluster = Omit<Cluster, "key" | "kind" | "label"> & {
	noNewlineOld?: boolean;
	noNewlineNew?: boolean;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses `git diff -U0` output: every hunk is one cluster. Each hunk consumes
 * exactly the line counts from its header; everything outside a hunk (file
 * headers, `diff --git` lines) is ignored.
 */
export function parseU0Patch(patch: string): LineCluster[] {
	const clusters: LineCluster[] = [];
	let current = null as LineCluster | null;
	let oldLeft = 0;
	let newLeft = 0;
	let last: "-" | "+" | null = null;
	const lines = patch.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			current = null;
			continue;
		}
		const inHunk: boolean = current !== null && (oldLeft > 0 || newLeft > 0);
		const header: RegExpExecArray | null = inHunk
			? null
			: HUNK_HEADER.exec(line);
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
			oldLeft = current.oldCount;
			newLeft = current.newCount;
			clusters.push(current);
			last = null;
		} else if (!current) {
		} else if (line.startsWith("-") && oldLeft > 0) {
			current.removed.push(line.slice(1));
			current.lines++;
			oldLeft--;
			last = "-";
		} else if (line.startsWith("+") && newLeft > 0) {
			current.added.push(line.slice(1));
			current.lines++;
			newLeft--;
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
	const parts: string[] = [];
	const add = (text: string) =>
		parts.push(parts.length === 0 ? text : text.toLowerCase());
	if (file.submodule) {
		add(`Submodule moved ${short(file.oldOid)} → ${short(file.newOid)}`);
	} else {
		if (file.status === "renamed") add(`Renamed from ${file.oldPath}`);
		if (file.binary) add("Binary file changed");
		if (modeChanged) add(`Mode changed ${file.oldMode} → ${file.newMode}`);
	}
	if (parts.length === 0 && !hasLineClusters) {
		if (file.additions === 0 && file.deletions === 0) {
			if (file.status === "added") add("Empty file added");
			else if (file.status === "deleted") add("Empty file deleted");
		}
	}
	if (parts.length === 0) return null;
	const label = parts.join(", ");
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

const quoteHeaderPath = (path: string) =>
	/["\\]/.test(path) || [...path].some((ch) => ch.charCodeAt(0) < 32)
		? `"${path
				.replace(/\\/g, "\\\\")
				.replace(/"/g, '\\"')
				.replace(/\n/g, "\\n")
				.replace(/\t/g, "\\t")}"`
		: path;

/** Keeps only the `diff --git` sections that belong to this exact file. */
function sectionsFor(patch: string, file: ChangedFile): string {
	const oldPath = file.oldPath ?? file.path;
	const wanted = new Set([
		`diff --git a/${oldPath} b/${file.path}`,
		`diff --git ${quoteHeaderPath(`a/${oldPath}`)} ${quoteHeaderPath(`b/${file.path}`)}`,
	]);
	const kept: string[] = [];
	let keep = false;
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) keep = wanted.has(line);
		if (keep) kept.push(line);
	}
	return kept.join("\n");
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
		const parsed = parseU0Patch(sectionsFor(patch, file));
		const removed = parsed.reduce((n, c) => n + c.removed.length, 0);
		const added = parsed.reduce((n, c) => n + c.added.length, 0);
		if (removed !== file.deletions || added !== file.additions) {
			throw new GitError(
				`Could not extract line clusters for ${file.path}: expected -${file.deletions}/+${file.additions} lines, parsed -${removed}/+${added}`,
			);
		}
		lineClusters = parsed.map(({ noNewlineOld, noNewlineNew, ...c }) => ({
			...c,
			kind: "lines" as const,
		}));
	}
	const fileCluster = fileLevelCluster(file, lineClusters.length > 0);
	return fileCluster ? [fileCluster, ...lineClusters] : lineClusters;
}
