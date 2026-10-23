import { createHash } from "node:crypto";
import type {
	DiffLine,
	FileHunks,
	FileSummary,
	Snapshot,
} from "../../shared/types.js";
import { GitError, runGit, runGitBuffer } from "../git.js";
import { buildClusters } from "./clusters.js";
import { type ChangedFile, listChangedFiles } from "./files.js";
import { buildDisplayHunks, contextLines } from "./hunks.js";
import { clusterKeys } from "./identity.js";

const MAX_CACHED_BLOBS = 200;
const CLUSTER_CONCURRENCY = 8;

/** Blob lines by OID, least recently used first. */
const blobCache = new Map<string, string[]>();

function remember(oid: string, lines: string[]): void {
	blobCache.delete(oid);
	blobCache.set(oid, lines);
	while (blobCache.size > MAX_CACHED_BLOBS) {
		const oldest = blobCache.keys().next().value as string;
		blobCache.delete(oldest);
	}
}

/** Splits text into lines the way git counts them. */
function toLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Reads blobs by OID with one `git cat-file --batch` for all cache misses. */
async function readBlobs(
	repo: string,
	oids: string[],
): Promise<Map<string, string[]>> {
	const result = new Map<string, string[]>();
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
		const lines = toLines(out.toString("utf8", start, end));
		remember(oid, lines);
		result.set(oid, lines);
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

async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i] as T);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	return results;
}

/**
 * Every changed file between `base` and `head`, in raw diff order, with its
 * clusters and their identity keys.
 */
export async function buildSnapshot(
	repo: string,
	base: string,
	head: string,
): Promise<Snapshot> {
	const changed = await listChangedFiles(repo, base, head);
	const unkeyed = await mapLimit(changed, CLUSTER_CONCURRENCY, (file) =>
		buildClusters(repo, base, head, file),
	);
	const needsNewSide = (file: ChangedFile, i: number) =>
		file.status !== "deleted" &&
		(unkeyed[i] ?? []).some((c) => c.kind === "lines");
	const blobs = await readBlobs(
		repo,
		changed.filter(needsNewSide).map((f) => f.newOid),
	);
	const files = changed.map((file, index): FileSummary => {
		const { oldOid, newOid, ...summary } = file;
		const clusters = unkeyed[index] ?? [];
		const newLines = needsNewSide(file, index) ? (blobs.get(newOid) ?? []) : [];
		const keys = clusterKeys(file.path, clusters, newLines);
		return {
			index,
			...summary,
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

/** Old and new lines of a text file (empty for a missing side). */
async function fileLines(
	repo: string,
	snapshot: Snapshot,
	file: FileSummary,
): Promise<{ oldLines: string[]; newLines: string[] }> {
	const names: string[] = [];
	if (file.status !== "added") {
		names.push(`${snapshot.base}:${file.oldPath ?? file.path}`);
	}
	if (file.status !== "deleted") names.push(`${snapshot.head}:${file.path}`);
	const oids = await resolveBlobs(repo, names);
	const blobs = await readBlobs(repo, oids);
	const [first, second] = oids.map((oid) => blobs.get(oid) ?? []);
	if (file.status === "added") return { oldLines: [], newLines: first ?? [] };
	if (file.status === "deleted") return { oldLines: first ?? [], newLines: [] };
	return { oldLines: first ?? [], newLines: second ?? [] };
}

/** Display hunks for one file of the snapshot. */
export async function loadFileHunks(
	repo: string,
	snapshot: Snapshot,
	index: number,
): Promise<FileHunks> {
	const file = fileAt(snapshot, index);
	if (file.binary || file.submodule) return { hunks: [], newLineCount: 0 };
	const { oldLines, newLines } = await fileLines(repo, snapshot, file);
	return {
		hunks: buildDisplayHunks(oldLines, newLines, file.clusters),
		newLineCount: newLines.length,
	};
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
	const { oldLines, newLines } = await fileLines(repo, snapshot, file);
	return contextLines(oldLines, newLines, file.clusters, newFrom, newTo);
}
