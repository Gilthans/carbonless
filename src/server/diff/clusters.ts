import { isMarkdownPath } from "../../shared/markdownBlocks.js";
import type { Cluster, HunkPart, LineCluster } from "../../shared/types.js";
import { cutByLines, type HunkCut } from "../../shared/whitespace.js";
import { GitError, runGitBuffer } from "../git.js";
import { type ChangedFile, DIFF_ARGS } from "./files.js";
import { chooseEncoding, type TextEncoding } from "./text.js";

export type { HunkPart, LineCluster } from "../../shared/types.js";

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

/**
 * A `-U0` hunk's cluster cut at its whitespace-only runs (cutByLines, from
 * `cut`: which of its lines are whitespace-only and which pair inside it,
 * by the display hunk's matching, hunkCuts, CAR-218): each run its own
 * cluster flagged `whitespaceOnly`, the changes between them clusters of
 * their own, numbered as git would number them as hunks (a side with no
 * lines starts at the line it follows). A hunk that doesn't split comes
 * back as itself, flagged when it is all whitespace. A `cut` that doesn't
 * fit the hunk's lines counts nothing as whitespace (one change, the safe
 * direction). Never for a file-level cluster.
 */
export function splitCluster<C extends LineCluster>(
	c: C,
	cut: HunkCut,
): HunkPart<C & { whitespaceOnly?: true }>[] {
	const fits =
		cut.removedWs.length === c.removed.length &&
		cut.addedWs.length === c.added.length;
	const pieces = fits
		? cutByLines(cut.removedWs, cut.addedWs, cut.pairs)
		: cutByLines(
				Array(c.removed.length).fill(false),
				Array(c.added.length).fill(false),
				[],
			);
	const flag = (ws: boolean) => (ws ? { whitespaceOnly: true as const } : {});
	if (pieces.length === 1) {
		const { whitespaceOnly: _, ...rest } = c as C & { whitespaceOnly?: true };
		return [
			{
				cluster: { ...rest, ...flag(pieces[0]?.whitespaceOnly === true) } as C,
				removedAt: 0,
				addedAt: 0,
			},
		];
	}
	// The line each side's pieces follow: git's start for a side with no
	// lines, else the line above its first.
	const oldBefore = c.oldCount === 0 ? c.oldStart : c.oldStart - 1;
	const newBefore = c.newCount === 0 ? c.newStart : c.newStart - 1;
	return pieces.map((p) => {
		const oldCount = p.removedTo - p.removedFrom;
		const newCount = p.addedTo - p.addedFrom;
		const {
			noNewlineOld: _o,
			noNewlineNew: _n,
			whitespaceOnly: _w,
			...rest
		} = c as C & { whitespaceOnly?: true };
		const cluster = {
			...rest,
			oldStart: oldBefore + p.removedFrom + (oldCount > 0 ? 1 : 0),
			oldCount,
			newStart: newBefore + p.addedFrom + (newCount > 0 ? 1 : 0),
			newCount,
			removed: c.removed.slice(p.removedFrom, p.removedTo),
			added: c.added.slice(p.addedFrom, p.addedTo),
			lines: oldCount + newCount,
			...(c.noNewlineOld && oldCount > 0 && p.removedTo === c.removed.length
				? { noNewlineOld: true }
				: {}),
			...(c.noNewlineNew && newCount > 0 && p.addedTo === c.added.length
				? { noNewlineNew: true }
				: {}),
			...flag(p.whitespaceOnly),
		} as C;
		return { cluster, removedAt: p.removedFrom, addedAt: p.addedFrom };
	});
}

/** An empty line, or one of only whitespace (a CRLF line's `\r` included). */
const isBlankLine = (line: string): boolean => /^\s*$/.test(line);

/**
 * Lock files, by name (any folder): an added one stays one cluster, never
 * cut at its blank lines (owner 2026-11-24: "skip the custom split on a
 * blocklist of files (like lock)"). One cluster a file keeps a whole-file
 * mark one event: cut, a 4,000-line lockfile was 916 clusters and a 51 KB
 * commit for one "Mark all reviewed" (docs/review-data-storage.md).
 */
const LOCK_FILES: ReadonlySet<string> = new Set([
	".terraform.lock.hcl",
	"Cargo.lock",
	"Gemfile.lock",
	"Package.resolved",
	"Pipfile.lock",
	"Podfile.lock",
	"bun.lock",
	"composer.lock",
	"conan.lock",
	"deno.lock",
	"flake.lock",
	"go.sum",
	"gradle.lockfile",
	"mix.lock",
	"npm-shrinkwrap.json",
	"package-lock.json",
	"packages.lock.json",
	"pdm.lock",
	"pnpm-lock.yaml",
	"poetry.lock",
	"pubspec.lock",
	"uv.lock",
	"yarn.lock",
]);

/**
 * Files almost always machine-made, by the end of their name (any folder,
 * case-sensitive): an added one stays one cluster, as a lock file (CAR-322,
 * owner 2026-11-27: "Let's go back to extension based exceptions"). Never
 * Markdown, whose Rendered view needs its block cut. Short and obvious on
 * purpose: the owner amends it.
 */
const MACHINE_MADE: readonly RegExp[] = [
	/\.min\.js$/,
	/\.min\.css$/,
	/\.map$/,
	/\.snap$/,
	/\.svg$/,
	/\.pb\.go$/,
	/_pb2\.py$/,
	/\.g\.dart$/,
	/\.designer\.cs$/,
	// Visual Studio's own spelling (Form1.Designer.cs).
	/\.Designer\.cs$/,
	/\.generated\.[^/]+$/,
];

/**
 * How an added file at `path` is cut (CAR-235, CAR-322): `"blocks"`, at its
 * blank lines; `"lock"`, whole (a lock file, LOCK_FILES); `"machine"`,
 * whole (a machine-made file, MACHINE_MADE), its key salted (`WHOLE_SALT`)
 * so marks on the pieces CAR-235 cut it into never read on the whole.
 */
export function addedCut(path: string): "blocks" | "lock" | "machine" {
	const name = path.slice(path.lastIndexOf("/") + 1);
	if (LOCK_FILES.has(name)) return "lock";
	if (isMarkdownPath(name)) return "blocks";
	return MACHINE_MADE.some((r) => r.test(name)) ? "machine" : "blocks";
}

/**
 * The key salt of an added machine-made file's cluster (CAR-322): a new
 * key, so nothing marked on it before (whole before CAR-235, or its pieces
 * under it) carries. Reads unreviewed once, never more reviewed.
 */
export const WHOLE_SALT = "whole:CAR-322";

/**
 * A pure addition (an added file's hunk) cut at its blank lines (CAR-235,
 * owner 2026-11-22: "each cluster should end when reaching a line of only
 * whitespace"): a blank line ends its cluster and stays in it, as does a
 * run of them; blank lines before the first non-blank one join the
 * cluster that line starts. A cluster with removed lines, or with no
 * non-blank line after a blank one, comes back as itself. Pieces are
 * numbered as git would number them as hunks; the end-of-file flag stays
 * on the last.
 */
export function splitAtBlankLines<C extends LineCluster>(c: C): HunkPart<C>[] {
	const starts = [0];
	if (c.removed.length === 0) {
		let text = false;
		let afterBlank = false;
		c.added.forEach((line, i) => {
			const blank = isBlankLine(line);
			if (!blank && afterBlank && text) starts.push(i);
			if (!blank) text = true;
			afterBlank = blank;
		});
	}
	if (starts.length === 1) return [{ cluster: c, removedAt: 0, addedAt: 0 }];
	return starts.map((from, k) => {
		const to = starts[k + 1] ?? c.added.length;
		const { noNewlineNew: _n, ...rest } = c;
		const cluster = {
			...rest,
			newStart: c.newStart + from,
			newCount: to - from,
			added: c.added.slice(from, to),
			lines: to - from,
			...(c.noNewlineNew && to === c.added.length
				? { noNewlineNew: true }
				: {}),
		} as C;
		return { cluster, removedAt: 0, addedAt: from };
	});
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
		// A binary whose two sides are the same blob (only renamed, or only
		// its mode changed) says what changed, never that its bytes did.
		if (file.binary && file.oldOid !== file.newOid) add("Binary file changed");
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
export function headersFor(file: { path: string; oldPath?: string }): string[] {
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
function clustersFromSection(
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
