import { createHash } from "node:crypto";
import type {
	DiffLine,
	FileHunks,
	FileSummary,
	HunksBatch,
	Snapshot,
} from "../../shared/types.js";
import { GitError, runGit, runGitBuffer } from "../git.js";
import { buildAllClusters } from "./clusters.js";
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

const MAX_CACHED_BLOBS = 200;

/** Blob contents by OID, least recently used first. */
const blobCache = new Map<string, Buffer>();

function remember(oid: string, bytes: Buffer): void {
	blobCache.delete(oid);
	blobCache.set(oid, bytes);
	while (blobCache.size > MAX_CACHED_BLOBS) {
		const oldest = blobCache.keys().next().value as string;
		blobCache.delete(oldest);
	}
}

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
		if (cached) {
			remember(oid, cached);
			result.set(oid, cached);
		}
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
		const bytes = Buffer.from(out.subarray(start, end));
		remember(oid, bytes);
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
	const blobs = await readBlobs(
		repo,
		changed
			.filter(isText)
			.flatMap((f) => [f.oldOid, f.newOid])
			.filter((oid) => !isZeroOid(oid)),
	);
	const bytesOf = (oid: string) => blobs.get(oid) ?? EMPTY;
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
		const clusters = unkeyed[index] ?? [];
		const text = texts[index];
		const hasLines = clusters.some((c) => c.kind === "lines");
		const keys = clusterKeys(file.path, clusters, text?.newLines ?? [], {
			encoding: text?.encoding ?? "utf8",
			// Without lines, a binary, submodule or type change would otherwise
			// look the same whatever the content.
			contentOids:
				!text || (file.status === "type-changed" && !hasLines)
					? [oldOid, newOid]
					: undefined,
		});
		const tabWidth = tabWidths[index];
		return {
			index,
			...summary,
			...(tabWidth === undefined ? {} : { tabWidth }),
			clusters: clusters.map((c, i) => ({ ...c, key: keys[i] as string })),
		};
	});
	return { base, head, revision: snapshotId(base, head), files };
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
