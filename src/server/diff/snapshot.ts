import { createHash } from "node:crypto";
import { cutAtBlocks } from "../../shared/blockCut.js";
import { isImagePath } from "../../shared/imageTypes.js";
import { HUNK_ALIGN_WORD_OPS } from "../../shared/linePairing.js";
import { isMarkdownPath, markdownBlocks } from "../../shared/markdownBlocks.js";
import type {
	Cluster,
	ClusterSplit,
	DiffLine,
	FileHunks,
	FileSummary,
	HunksBatch,
	Snapshot,
} from "../../shared/types.js";
import { GitError, runGit, runGitBuffer } from "../git.js";
import { BlobCache } from "./blobCache.js";
import { buildAllClusters, splitCluster } from "./clusters.js";
import { readTabWidths } from "./editorconfig.js";
import { type ChangedFile, listChangedFiles } from "./files.js";
import {
	buildAllHeadings,
	type GitHunkHeading,
	type HeadingFile,
	withHeadings,
} from "./headings.js";
import { buildDisplayHunks, contextLines } from "./hunks.js";
import { clusterKeys } from "./identity.js";
import { chooseEncoding, decodeLines, type TextEncoding } from "./text.js";

/**
 * The blob cache's cap. A snapshot reads every changed text file's old and
 * new blob, and the Files page reads them again per file. Measured working
 * sets (distinct blobs of the three-dot diff, summed): a 49-file real PR
 * 0.6 MiB (72 blobs); this repo's largest merged PRs, 194 to 237 files,
 * 5.7 to 6.5 MiB (304 to 377 blobs, more than the old 200-entry limit
 * held). 32 MiB keeps about five of the largest at once (a re-review reads
 * two snapshots; the server keeps several reviews open), and bounds the
 * always-on server whatever the files' sizes.
 */
export const BLOB_CACHE_BYTES = 32 * 1024 * 1024;

const blobCache = new BlobCache(BLOB_CACHE_BYTES);

const MAX_CACHED_HEADINGS = 8;

/**
 * How long a file's hunks wait for the snapshot's headings once their own
 * text is in. The heading run starts with the snapshot, so it's normally
 * done long before; a slow or stuck one never holds the hunks up for more
 * (they come without headings).
 */
export const HEADING_WAIT_MS = 500;

/**
 * Every file's `-U3` hunk headings, per snapshot (`repo`, base, head), least
 * recently used first: one git run per snapshot, never per file. A failed
 * run resolves to null and stays cached: no headings for that snapshot
 * (they are a reading aid), never a run per file open.
 */
const headingRuns = new Map<string, Promise<GitHunkHeading[][] | null>>();

/**
 * Empties the blob and heading caches, as a fresh process has them (the
 * test hook's reset): tests' fixture repos share blob ids, so a warm cache
 * would hide a first open's cost from the next test.
 */
export function clearSnapshotCaches(): void {
	blobCache.clear();
	headingRuns.clear();
}

function snapshotHeadings(
	repo: string,
	base: string,
	head: string,
	files: HeadingFile[],
): Promise<GitHunkHeading[][] | null> {
	const key = `${repo}\0${base}\0${head}`;
	const run =
		headingRuns.get(key) ??
		buildAllHeadings(repo, base, head, files).catch(() => null);
	headingRuns.delete(key);
	headingRuns.set(key, run);
	while (headingRuns.size > MAX_CACHED_HEADINGS) {
		headingRuns.delete(headingRuns.keys().next().value as string);
	}
	return run;
}

/** `run`'s answer if it comes within `ms`, else null (it keeps going). */
function within<T>(run: Promise<T | null>, ms: number): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), ms);
	});
	return Promise.race([run, late]).finally(() => clearTimeout(timer));
}

const isZeroOid = (oid: string) => /^0+$/.test(oid);

/** Reads blobs by OID with one `git cat-file --batch` for all cache misses. */
export async function readBlobs(
	repo: string,
	oids: string[],
): Promise<Map<string, Buffer>> {
	const result = new Map<string, Buffer>();
	const missing = [...new Set(oids)].filter((oid) => {
		const cached = blobCache.get(oid);
		if (cached) result.set(oid, cached);
		return !cached;
	});
	if (missing.length === 0) return result;
	const out = await runGitBuffer(repo, ["cat-file", "--batch"], {
		input: `${missing.join("\n")}\n`,
	});
	let pos = 0;
	for (const oid of missing) {
		const eol = out.indexOf(0x0a, pos);
		const header = out.toString("utf8", pos, eol < 0 ? out.length : eol);
		const match = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header);
		if (eol < 0 || !match || match[1] !== oid) {
			throw new GitError(`Could not read blob ${oid}: ${header}`);
		}
		const start = eol + 1;
		const end = start + Number(match[3]);
		// A short read would leave allocUnsafeSlow's bytes uninitialized.
		if (end > out.length) {
			throw new GitError(`Could not read blob ${oid}: output cut short`);
		}
		// Its own allocation: a slice of Node's shared pool (Buffer.from of a
		// small blob) would pin the whole 64 KiB slab while cached.
		const bytes = Buffer.allocUnsafeSlow(end - start);
		out.copy(bytes, 0, start, end);
		blobCache.set(oid, bytes);
		result.set(oid, bytes);
		pos = end + 1;
	}
	return result;
}

/** Resolves `<rev>:<path>` names to blob OIDs (NUL-separated, any path). */
async function resolveBlobs(repo: string, names: string[]): Promise<string[]> {
	const out = await runGit(
		repo,
		["cat-file", "-z", "--batch-check=%(objectname) %(objecttype)"],
		{ input: names.map((n) => `${n}\0`).join("") },
	);
	const lines = out.split("\n");
	return names.map((name, i) => {
		const match = /^([0-9a-f]+) blob$/.exec(lines[i] ?? "");
		if (!match) throw new GitError(`Could not find blob ${name}`);
		return match[1] as string;
	});
}

/**
 * The blob a `<rev>:<path>` name resolves to, with its byte size (one
 * `git cat-file --batch-check`, any path); null when the name is missing
 * or isn't a blob (a submodule's gitlink, a tree).
 */
export async function statBlob(
	repo: string,
	name: string,
): Promise<{ oid: string; size: number } | null> {
	const out = await runGit(
		repo,
		[
			"cat-file",
			"-z",
			"--batch-check=%(objectname) %(objecttype) %(objectsize)",
		],
		{ input: `${name}\0` },
	);
	const match = /^([0-9a-f]+) blob (\d+)$/.exec(out.split("\n")[0] ?? "");
	return match ? { oid: match[1] as string, size: Number(match[2]) } : null;
}

/**
 * Byte sizes of blobs by OID, with one `git cat-file --batch-check` for all.
 * An OID that isn't a blob here (a gitlink's commit, a missing object) has
 * no size.
 */
export async function readBlobSizes(
	repo: string,
	oids: string[],
): Promise<Map<string, number>> {
	const sizes = new Map<string, number>();
	const wanted = [...new Set(oids)];
	if (wanted.length === 0) return sizes;
	const out = await runGit(
		repo,
		["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
		{ input: `${wanted.join("\n")}\n` },
	);
	for (const line of out.split("\n")) {
		const match = /^([0-9a-f]+) blob (\d+)$/.exec(line);
		if (match) sizes.set(match[1] as string, Number(match[2]));
	}
	return sizes;
}

/** The first line of a Git LFS pointer file. */
const LFS_POINTER_LINE = "version https://git-lfs.github.com/spec/v1";
/** A side this size or larger is never taken for an LFS pointer. */
const LFS_POINTER_MAX_BYTES = 200;

/**
 * Whether `bytes` (a missing side when empty) look like an LFS pointer: under
 * 200 bytes, and a first line of exactly LFS's `version` line. A CRLF pointer
 * (`...v1\r`) deliberately doesn't count: the spec says "exactly".
 */
function isLfsPointer(bytes: Buffer): boolean {
	if (bytes.length === 0 || bytes.length >= LFS_POINTER_MAX_BYTES) return false;
	const eol = bytes.indexOf(0x0a);
	return (
		bytes.toString("latin1", 0, eol < 0 ? bytes.length : eol) ===
		LFS_POINTER_LINE
	);
}

/** Old and new text of a file, decoded the same way on both sides. */
export interface FileText {
	encoding: TextEncoding;
	oldLines: string[];
	newLines: string[];
	noNewlineAtEnd: boolean;
}

export function fileText(oldBytes: Buffer, newBytes: Buffer): FileText {
	const encoding = chooseEncoding(oldBytes, newBytes);
	const after = decodeLines(newBytes, encoding);
	return {
		encoding,
		oldLines: decodeLines(oldBytes, encoding).lines,
		newLines: after.lines,
		noNewlineAtEnd: after.noNewlineAtEnd,
	};
}

const EMPTY = Buffer.alloc(0);

/**
 * Every changed file between `base` and `head`, in raw diff order, with its
 * clusters and their identity keys. Text files' blobs are read (one
 * `git cat-file --batch` for all) to pick each file's encoding and to hash
 * the context around clusters.
 */
export async function buildSnapshot(
	repo: string,
	base: string,
	head: string,
): Promise<Snapshot> {
	const changed = await listChangedFiles(repo, base, head);
	// Started now, beside the clusters' run: ready by the first file's hunks.
	void snapshotHeadings(repo, base, head, changed);
	const isText = (f: ChangedFile) => !f.binary && !f.submodule;
	const oidsOf = (files: ChangedFile[]) =>
		files.flatMap((f) => [f.oldOid, f.newOid]).filter((oid) => !isZeroOid(oid));
	// Text files' sizes are their bytes' length. The other sides' (binary,
	// and gitlinks, which aren't blobs and get none) come from one read
	// beside the blobs': none at all without such files, and opening a
	// review waits no longer.
	const [blobs, sizes] = await Promise.all([
		readBlobs(repo, oidsOf(changed.filter(isText))),
		readBlobSizes(repo, oidsOf(changed.filter((f) => !isText(f)))),
	]);
	const bytesOf = (oid: string) => blobs.get(oid) ?? EMPTY;
	const sizeOf = (oid: string) =>
		isZeroOid(oid) ? undefined : (blobs.get(oid)?.length ?? sizes.get(oid));
	// Only text files with an image path: the bytes are already read.
	const lfs = (f: ChangedFile) =>
		isText(f) &&
		isImagePath(f.path) &&
		(isLfsPointer(bytesOf(f.oldOid)) || isLfsPointer(bytesOf(f.newOid)));
	const texts = changed.map((f) =>
		isText(f) ? fileText(bytesOf(f.oldOid), bytesOf(f.newOid)) : null,
	);
	// One whole-diff patch for every file: renames pair as in the listing.
	const unkeyed = await buildAllClusters(
		repo,
		base,
		head,
		changed,
		texts.map((t) => t?.encoding),
	);
	const tabWidths = await readTabWidths(
		repo,
		head,
		changed.map((f) => f.path),
	);
	const files = changed.map((file, index): FileSummary => {
		const { oldOid, newOid, ...summary } = file;
		const hunks = unkeyed[index] ?? [];
		const text = texts[index];
		const hasLines = hunks.some((c) => c.kind === "lines");
		const keysOf = (clusters: Omit<Cluster, "key">[]) =>
			clusterKeys(file.path, clusters, text?.newLines ?? [], {
				encoding: text?.encoding ?? "utf8",
				// Without lines, a binary, submodule or type change would otherwise
				// look the same whatever the content.
				contentOids:
					!text || (file.status === "type-changed" && !hasLines)
						? [oldOid, newOid]
						: undefined,
			});
		// A Markdown file's clusters are cut at its blocks too (CAR-167), when
		// both sides are text under the cap, neither a symlink nor an LFS
		// pointer (not Markdown); the Rendered view needs the cut.
		const markdown =
			text && cutsMarkdown(file, bytesOf(oldOid), bytesOf(newOid))
				? { oldLines: text.oldLines, newLines: text.newLines }
				: undefined;
		const clusters = cutClusters(hunks, keysOf, markdown);
		const tabWidth = tabWidths[index];
		const oldSize = sizeOf(oldOid);
		const newSize = sizeOf(newOid);
		return {
			index,
			...summary,
			...(tabWidth === undefined ? {} : { tabWidth }),
			...(oldSize === undefined ? {} : { oldSize }),
			...(newSize === undefined ? {} : { newSize }),
			...(lfs(file) ? { lfs: true as const } : {}),
			...(markdown ? { markdownBlocks: true as const } : {}),
			...(oldOid === newOid && !file.submodule
				? { sameBlob: true as const }
				: {}),
			clusters,
		};
	});
	return { base, head, revision: snapshotId(base, head), files };
}

/**
 * The largest Markdown blob (either side, bytes) whose clusters are cut at
 * its blocks (CAR-167); a larger file keeps the whitespace cut alone and
 * isn't offered the Rendered view. The cap is part of cluster identity: a
 * file growing past it, or a changed cap, changes the cut (marks on the
 * pieces reset: the safe direction). Its cost is per file, linear in the
 * file's size, on the server as the snapshot is built (a review's first
 * open).
 * Measured on the devbox (2026-11-22, CPU of `markdownBlocks` of both sides
 * plus `cutClusters`, best of 3), generated READMEs of headings,
 * paragraphs, lists, tables and fences: at 300 KiB 100 ms with every 7th
 * line edited, 220 ms with most lines edited; at 512 KiB 155 and 340 ms.
 * Costlier shapes: every section one hunk across three list items and a
 * table row, edited (the CPU test's, snapshot.test.ts), 330 ms at 300 KiB;
 * runs of 50 changed list items of ~190 words (each piece's pairing at its
 * budget), 285 ms at 300 KiB and 430 ms at 512 KiB.
 * 512 KiB also stays under `markdownBlocks`' 1,000,000-character lex limit,
 * so a cut file is always cut at its real blocks.
 */
export const MARKDOWN_CUT_MAX_BYTES = 512 * 1024;

/** A symlink's mode: its blob is a target path, not Markdown. */
const SYMLINK_MODE = "120000";

/**
 * Whether a text file's lines are cut at its Markdown blocks (CAR-167):
 * a Markdown path, neither side a symlink or an LFS pointer, both sides'
 * bytes (empty for a missing side) under MARKDOWN_CUT_MAX_BYTES. The full
 * diff's clusters and the since view's pieces both ask it.
 */
export function cutsMarkdown(
	file: Pick<ChangedFile, "path" | "oldMode" | "newMode">,
	oldBytes: Buffer,
	newBytes: Buffer,
): boolean {
	return (
		isMarkdownPath(file.path) &&
		file.oldMode !== SYMLINK_MODE &&
		file.newMode !== SYMLINK_MODE &&
		!isLfsPointer(oldBytes) &&
		!isLfsPointer(newBytes) &&
		oldBytes.length <= MARKDOWN_CUT_MAX_BYTES &&
		newBytes.length <= MARKDOWN_CUT_MAX_BYTES
	);
}

/**
 * One file's git hunks (and its file-level cluster) as its clusters: each
 * hunk cut at its whitespace-only runs (splitCluster, CAR-156), and for a
 * Markdown file (`markdown`, its old and new lines) each piece cut again at
 * its blocks (cutAtBlocks, CAR-167), keyed by `keysOf` (clusterKeys over
 * the file's clusters). A piece of a hunk that split, by either cut,
 * remembers the key the whole git hunk had (`keysOf` over the hunks, as
 * before any cut) and where its lines sit in it, so marks on the hunk
 * carry onto the pieces (splitCarry.ts). A piece the block cut leaves whole
 * keeps the key it had with the whitespace cut alone; one it splits names
 * that CAR-156 piece's key (`split.piece`) when the hunk had several.
 */
export function cutClusters(
	hunks: Omit<Cluster, "key">[],
	keysOf: (clusters: Omit<Cluster, "key">[]) => string[],
	markdown?: { oldLines: string[]; newLines: string[] },
): Cluster[] {
	// Parsed once per side, and only with lines to cut (not a pure rename).
	const blocks =
		markdown && hunks.some((h) => h.kind === "lines")
			? {
					old: markdownBlocks(markdown.oldLines),
					new: markdownBlocks(markdown.newLines),
				}
			: undefined;
	const clusters: Omit<Cluster, "key">[] = [];
	const parts: {
		hunk: number;
		removedAt: number;
		addedAt: number;
		/** Its CAR-156 piece's index in `wsClusters`, when the block cut split that piece of a split hunk. */
		piece: number;
	}[] = [];
	// The file's clusters as the whitespace cut alone makes them (CAR-156),
	// keyed only when a block piece needs its CAR-156 piece's key.
	const wsClusters: Omit<Cluster, "key">[] = [];
	hunks.forEach((hunk, h) => {
		const ws =
			hunk.kind === "lines"
				? splitCluster(hunk)
				: [{ cluster: hunk, removedAt: 0, addedAt: 0 }];
		const pieces = ws.flatMap((p) => {
			const at = wsClusters.push(p.cluster) - 1;
			if (!blocks || hunk.kind !== "lines") return [{ ...p, piece: -1 }];
			// Each CAR-156 piece cut at the blocks with its own pairing budget
			// (a piece's cut, and so its keys, never depends on another's
			// cost), its pieces' places made the git hunk's.
			const cut = cutAtBlocks(p.cluster, blocks.old, blocks.new, {
				left: HUNK_ALIGN_WORD_OPS,
			});
			const piece = cut.length > 1 && ws.length > 1 ? at : -1;
			return cut.map((q) => ({
				cluster: q.cluster,
				removedAt: p.removedAt + q.removedAt,
				addedAt: p.addedAt + q.addedAt,
				piece,
			}));
		});
		for (const piece of pieces) {
			clusters.push(piece.cluster);
			parts.push({
				hunk: pieces.length > 1 ? h : -1,
				removedAt: piece.removedAt,
				addedAt: piece.addedAt,
				piece: piece.piece,
			});
		}
	});
	const keys = keysOf(clusters);
	const hunkKeys = parts.some((p) => p.hunk >= 0) ? keysOf(hunks) : [];
	const wsKeys = parts.some((p) => p.piece >= 0) ? keysOf(wsClusters) : [];
	return clusters.map((c, i) => {
		const part = parts[i];
		const split: ClusterSplit | undefined =
			part && part.hunk >= 0
				? {
						key: hunkKeys[part.hunk] as string,
						removedAt: part.removedAt,
						addedAt: part.addedAt,
						removed: (hunks[part.hunk] as Omit<Cluster, "key">).removed.length,
						...(part.piece >= 0 ? { piece: wsKeys[part.piece] as string } : {}),
					}
				: undefined;
		return { ...c, key: keys[i] as string, ...(split ? { split } : {}) };
	});
}

/** The snapshot id of the comparison `base` → `head` (`Snapshot.revision`). */
export function snapshotId(base: string, head: string): string {
	return createHash("sha256").update(`${base}\0${head}`).digest("hex");
}

function fileAt(snapshot: Snapshot, index: number): FileSummary {
	const file = snapshot.files[index];
	if (!file || file.index !== index) {
		throw new RangeError(`No file ${index} in this snapshot`);
	}
	return file;
}

/**
 * The `<rev>:<path>` name of one side of file `index` of the snapshot, as
 * its text is read (loadText): the old side at the merge base and the old
 * path, the new side at the head. Null for a side the file hasn't (an
 * added file's old, a deleted file's new) and for a submodule.
 */
export function blobName(
	snapshot: Snapshot,
	index: number,
	side: "old" | "new",
): string | null {
	const file = fileAt(snapshot, index);
	if (file.submodule) return null;
	if (side === "old") {
		return file.status === "added"
			? null
			: `${snapshot.base}:${file.oldPath ?? file.path}`;
	}
	return file.status === "deleted" ? null : `${snapshot.head}:${file.path}`;
}

/** Old and new text of a file in the snapshot (empty for a missing side). */
async function loadText(
	repo: string,
	snapshot: Snapshot,
	file: FileSummary,
): Promise<FileText> {
	const names: string[] = [];
	if (file.status !== "added") {
		names.push(`${snapshot.base}:${file.oldPath ?? file.path}`);
	}
	if (file.status !== "deleted") names.push(`${snapshot.head}:${file.path}`);
	const oids = await resolveBlobs(repo, names);
	const blobs = await readBlobs(repo, oids);
	const [first, second] = oids.map((oid) => blobs.get(oid) ?? EMPTY);
	if (file.status === "added") return fileText(EMPTY, first ?? EMPTY);
	if (file.status === "deleted") return fileText(first ?? EMPTY, EMPTY);
	return fileText(first ?? EMPTY, second ?? EMPTY);
}

/** Display hunks for one file of the snapshot. */
export async function loadFileHunks(
	repo: string,
	snapshot: Snapshot,
	index: number,
	options: {
		/** Without headings (callers that don't show them): never waits for them. */
		headings?: boolean;
		/** The longest wait for headings after the text is in. */
		headingWaitMs?: number;
	} = {},
): Promise<FileHunks> {
	const file = fileAt(snapshot, index);
	if (file.binary || file.submodule) return { hunks: [], newLineCount: 0 };
	const wanted = options.headings !== false;
	const headingRun = wanted
		? snapshotHeadings(repo, snapshot.base, snapshot.head, snapshot.files)
		: null;
	const text = await loadText(repo, snapshot, file);
	const hunks = buildDisplayHunks(
		text.oldLines,
		text.newLines,
		file.clusters,
		3,
		text.noNewlineAtEnd,
	);
	const headings = headingRun
		? await within(headingRun, options.headingWaitMs ?? HEADING_WAIT_MS)
		: null;
	return {
		hunks: headings
			? withHeadings(hunks, headings[index] ?? [], text.encoding)
			: hunks,
		newLineCount: text.newLines.length,
	};
}

/**
 * The new side's lines of one file of the snapshot (none for a binary, a
 * submodule or a deleted file): the since view's text of a file the
 * interdiff doesn't touch, the same on both sides.
 */
export async function loadNewText(
	repo: string,
	snapshot: Snapshot,
	index: number,
): Promise<FileText> {
	const file = fileAt(snapshot, index);
	if (file.binary || file.submodule || file.status === "deleted") {
		return fileText(EMPTY, EMPTY);
	}
	const [oid] = await resolveBlobs(repo, [`${snapshot.head}:${file.path}`]);
	const blobs = await readBlobs(repo, oid ? [oid] : []);
	return fileText(EMPTY, (oid && blobs.get(oid)) || EMPTY);
}

/**
 * Display hunks of several files of the snapshot, one git read at a time
 * (the server is shared with the open file's own reads). A file whose
 * hunks fail answers with `error`; an index not in the snapshot throws
 * (RangeError, "No file N in this snapshot", as loadFileHunks does).
 */
export async function loadHunksBatch(
	repo: string,
	snapshot: Snapshot,
	indexes: readonly number[],
	load: typeof loadFileHunks = loadFileHunks,
): Promise<HunksBatch> {
	for (const index of indexes) fileAt(snapshot, index);
	const files: HunksBatch["files"] = [];
	for (const index of indexes) {
		try {
			files.push({ index, hunks: await load(repo, snapshot, index) });
		} catch {
			// Not git's message: it can carry the clone cache's path.
			files.push({ index, error: "Couldn't read this file" });
		}
	}
	return { files };
}

/** Unchanged lines `newFrom..newTo` of one file, for expanding context. */
export async function loadContext(
	repo: string,
	snapshot: Snapshot,
	index: number,
	newFrom: number,
	newTo: number,
): Promise<DiffLine[]> {
	const file = fileAt(snapshot, index);
	if (file.binary || file.submodule) return [];
	const text = await loadText(repo, snapshot, file);
	return contextLines(
		text.oldLines,
		text.newLines,
		file.clusters,
		newFrom,
		newTo,
		text.noNewlineAtEnd,
	);
}
