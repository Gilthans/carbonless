import type { Cluster } from "../../shared/types.js";
import { GitError, runGitBuffer } from "../git.js";
import { type ChangedFile, DIFF_ARGS } from "./files.js";
import { chooseEncoding, type TextEncoding } from "./text.js";

export type LineCluster = Omit<Cluster, "key" | "kind" | "label">;

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

const NEWLINE = Buffer.from("\n");
const DIFF_HEADER = Buffer.from("diff --git ");

/** The `diff --git` header lines git can print for this file. */
function headersFor(file: ChangedFile): string[] {
	const oldPath = file.oldPath ?? file.path;
	return [
		`diff --git a/${oldPath} b/${file.path}`,
		`diff --git ${quoteHeaderPath(`a/${oldPath}`)} ${quoteHeaderPath(`b/${file.path}`)}`,
	];
}

/**
 * Splits a whole-diff patch into its `diff --git` sections, by header line.
 * Works on bytes so content lines stay byte-exact until decoded. A type
 * change (file ↔ symlink) prints a deletion and an addition under one
 * header: they stay together, as that one file's section.
 */
export function splitPatch(patch: Buffer): Map<string, Buffer> {
	const sections = new Map<string, Buffer[]>();
	let current: Buffer[] | null = null;
	for (let pos = 0; pos < patch.length; ) {
		const found = patch.indexOf(0x0a, pos);
		const eol = found < 0 ? patch.length : found;
		const line = patch.subarray(pos, eol);
		if (line.subarray(0, DIFF_HEADER.length).equals(DIFF_HEADER)) {
			const header = line.toString("utf8");
			current = sections.get(header) ?? [];
			sections.set(header, current);
		}
		if (current) {
			current.push(current.length > 0 ? Buffer.concat([NEWLINE, line]) : line);
		} else if (line.length > 0) {
			throw new GitError("git diff printed text before its first file");
		}
		pos = eol + 1;
	}
	return new Map([...sections].map(([h, parts]) => [h, Buffer.concat(parts)]));
}

/**
 * One file's clusters from its own `-U0` section. The changed lines parsed
 * must add up to the file's numstat counts (taken with the same diff
 * options and zero context), or this throws: a cluster can never go missing.
 */
export function clustersFromSection(
	section: Buffer,
	file: ChangedFile,
	encoding?: TextEncoding,
): Omit<Cluster, "key">[] {
	let lineClusters: Omit<Cluster, "key">[] = [];
	if (!file.binary && !file.submodule) {
		// Non-strict decoding: header lines may hold non-UTF-8 path bytes;
		// content lines are valid in the chosen encoding.
		const parsed = parseU0Patch(
			section.toString(encoding ?? chooseEncoding(section)),
		);
		const removed = parsed.reduce((n, c) => n + c.removed.length, 0);
		const added = parsed.reduce((n, c) => n + c.added.length, 0);
		if (removed !== file.deletions || added !== file.additions) {
			throw new GitError(
				`Could not extract line clusters for ${file.path}: expected -${file.deletions}/+${file.additions} lines, parsed -${removed}/+${added}`,
			);
		}
		lineClusters = parsed.map((c) => ({ ...c, kind: "lines" as const }));
	}
	const fileCluster = fileLevelCluster(file, lineClusters.length > 0);
	return fileCluster ? [fileCluster, ...lineClusters] : lineClusters;
}

/**
 * Clusters of every file in `files` (the raw listing of base..head, in
 * order), from ONE whole-diff `-U0` patch, so renames pair exactly as in
 * the listing. Each file must have exactly one section and every section
 * must belong to a listed file, or this throws.
 * `encodings[i]`: how to decode file i's lines (default: per section).
 * `paths`: the pathspec the listing was made with, if any.
 */
export async function buildAllClusters(
	repo: string,
	base: string,
	head: string,
	files: ChangedFile[],
	encodings: (TextEncoding | undefined)[] = [],
	paths: string[] = [],
): Promise<Omit<Cluster, "key">[][]> {
	const patch = await runGitBuffer(repo, [
		...DIFF_ARGS,
		"-U0",
		base,
		head,
		"--",
		...paths,
	]);
	const sections = splitPatch(patch);
	const result = files.map((file, i) => {
		const header = headersFor(file).find((h) => sections.has(h));
		if (header === undefined) {
			throw new GitError(`git diff printed no section for ${file.path}`);
		}
		const section = sections.get(header) as Buffer;
		sections.delete(header);
		return clustersFromSection(section, file, encodings[i]);
	});
	if (sections.size > 0) {
		const [extra] = sections.keys();
		throw new GitError(
			`git diff printed a section not in the listing: ${extra}`,
		);
	}
	return result;
}

/**
 * File-level cluster first (if any), then line clusters in file order, for
 * one file of base..head (`buildAllClusters` for all of them at once).
 */
export async function buildClusters(
	repo: string,
	base: string,
	head: string,
	file: ChangedFile,
	encoding?: TextEncoding,
): Promise<Omit<Cluster, "key">[]> {
	const patch = await runGitBuffer(repo, [
		...DIFF_ARGS,
		"-U0",
		base,
		head,
		"--",
	]);
	const sections = splitPatch(patch);
	const header = headersFor(file).find((h) => sections.has(h));
	if (header === undefined) {
		throw new GitError(`git diff printed no section for ${file.path}`);
	}
	return clustersFromSection(sections.get(header) as Buffer, file, encoding);
}
