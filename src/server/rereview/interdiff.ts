import type { Cluster, FileStatus } from "../../shared/types.js";
import { buildAllClusters } from "../diff/clusters.js";
import { type ChangedFile, listChangedFiles } from "../diff/files.js";
import { fileText, readBlobs } from "../diff/snapshot.js";
import { checkOid, type Endpoints, type Shape } from "./shape.js";

/**
 * One file of the interdiff: the author's own changes to it since the
 * patch set, as the diff of the virtual rebase `H1'` to the new head (for
 * a file the virtual rebase could not merge, `conflict`, the full diff
 * from the new merge base instead). The old and new lines are what the
 * since view shows and what the carry's mappers need.
 */
export interface InterdiffFile {
	path: string;
	oldPath?: string;
	status: FileStatus;
	conflict: boolean;
	clusters: Omit<Cluster, "key">[];
	/** The old side's lines (`H1'`, or `B2` for a conflicted file); [] for a binary. */
	oldLines: string[];
	/** The new head's lines; [] for a binary. */
	newLines: string[];
	/** The new side's last line has no newline at the end. */
	noNewlineAtEnd: boolean;
}

export type Interdiff =
	| { status: "available"; virtualHead: string; files: InterdiffFile[] }
	| { status: "unavailable"; reason: Shape["virtualRebase"] };

const isZeroOid = (oid: string) => /^0+$/.test(oid);
const EMPTY = Buffer.alloc(0);

/**
 * The files changed from `old` to `fresh` (commits or trees), with their
 * clusters and both sides' lines, as the snapshot builds them; `paths`
 * limits the diff to those paths.
 */
async function diffFiles(
	repo: string,
	old: string,
	fresh: string,
	paths: string[] = [],
): Promise<InterdiffFile[]> {
	const changed = await listChangedFiles(repo, old, fresh, paths);
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
	const clusters = await buildAllClusters(
		repo,
		old,
		fresh,
		changed,
		texts.map((t) => t?.encoding),
		paths,
	);
	return changed.map((f, i) => {
		const text = texts[i];
		return {
			path: f.path,
			...(f.oldPath === undefined ? {} : { oldPath: f.oldPath }),
			status: f.status,
			conflict: false,
			clusters: clusters[i] ?? [],
			oldLines: text?.oldLines ?? [],
			newLines: text?.newLines ?? [],
			noNewlineAtEnd: text?.noNewlineAtEnd ?? false,
		};
	});
}

/**
 * The interdiff of patch set `ps` to snapshot `r`: `diff(H1', H2)` with
 * the snapshot's own diff options, `H1'` being the virtual rebase from
 * `shape` (the old head's own tree when the merge base didn't move, so S1
 * is `diff(H1, H2)`). A file the virtual rebase could not merge is listed
 * as its full diff from `B2` with `conflict: true`, and nothing more: no
 * conflict markers. Unavailable when no virtual rebase could be built.
 */
export async function buildInterdiff(
	repo: string,
	shape: Shape,
	ps: Endpoints,
	r: Endpoints,
	signal?: AbortSignal,
): Promise<Interdiff> {
	if (
		(shape.virtualRebase !== "ok" && shape.virtualRebase !== "conflict") ||
		shape.virtualHead === null
	) {
		return { status: "unavailable", reason: shape.virtualRebase };
	}
	checkOid(ps.head);
	const virtualHead = checkOid(shape.virtualHead);
	const head = checkOid(r.head);
	const base = checkOid(r.mergeBase);
	if (signal?.aborted) throw new Error("git was stopped");
	const files = await diffFiles(repo, virtualHead, head);
	if (shape.conflicts.length === 0) {
		return { status: "available", virtualHead, files };
	}
	// A conflicted file: the virtual rebase holds git's markers for it, so
	// the diff to the new head would show them. The author's resolution
	// against the new base is what there is to read.
	const conflicted = new Set(shape.conflicts);
	// Each path as itself: a `[`, `*` or `?` in a name is not a glob.
	const resolved = await diffFiles(
		repo,
		base,
		head,
		[...conflicted].map((path) => `:(literal)${path}`),
	);
	for (const f of resolved) {
		f.conflict = true;
		conflicted.add(f.path);
		if (f.oldPath !== undefined) conflicted.add(f.oldPath);
	}
	const clean = files.filter(
		(f) => !conflicted.has(f.path) && !(f.oldPath && conflicted.has(f.oldPath)),
	);
	return { status: "available", virtualHead, files: [...clean, ...resolved] };
}
