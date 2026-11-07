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

const isZeroOid = (oid: string) => /^0+$/.test(oid);

/** Reads blobs by OID with one `git cat-file --batch` for all cache misses. */
async function readBlobs(
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
interface FileText {
	encoding: TextEncoding;
	oldLines: string[];
	newLines: string[];
	noNewlineAtEnd: boolean;
}

function fileText(oldBytes: Buffer, newBytes: Buffer): FileText {
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
	const revision = createHash("sha256")
		.update(`${base}\0${head}`)
		.digest("hex");
	return { base, head, revision, files };
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
): Promise<FileHunks> {
	const file = fileAt(snapshot, index);
	if (file.binary || file.submodule) return { hunks: [], newLineCount: 0 };
	const text = await loadText(repo, snapshot, file);
	return {
		hunks: buildDisplayHunks(
			text.oldLines,
			text.newLines,
			file.clusters,
			3,
			text.noNewlineAtEnd,
		),
		newLineCount: text.newLines.length,
	};
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
		} catch (error) {
			files.push({
				index,
				error: error instanceof Error ? error.message : String(error),
			});
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
