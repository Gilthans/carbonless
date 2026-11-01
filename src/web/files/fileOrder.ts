import type { FileView } from "../../shared/types";

/**
 * The Files page's one order: the tree's, depth-first. The diff list and
 * the tree both follow it, so they never disagree. `FileView.index` stays
 * each file's identity; only the order shown changes.
 */

const collator = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: "base",
});

/**
 * Like a file explorer: case-insensitive and numeric-aware ("a2" before
 * "a10"), then bytewise so equal-looking names still order the same way.
 */
export function byName(a: string, b: string): number {
	return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

const nameOf = (n: Node) =>
	n.kind === "folder"
		? n.folder.name
		: n.file.path.slice(n.file.path.lastIndexOf("/") + 1);

export type Node =
	| { kind: "folder"; folder: Folder }
	| { kind: "file"; file: FileView };
export interface Folder {
	/** As shown: single-folder chains merged ("a/b"). */
	name: string;
	/** Full path from the root: the folder's identity (fold state). */
	path: string;
	children: Node[];
}

/**
 * The changed files as a folder tree: at every level folders first, then
 * files, each by name (byName); single-folder chains merge ("a/b") and sort
 * by that name.
 */
export function buildTree(files: readonly FileView[]): Folder {
	const root: Folder = { name: "", path: "", children: [] };
	for (const file of files) {
		const parts = file.path.split("/");
		parts.pop();
		let folder = root;
		for (const part of parts) {
			let child = folder.children.find(
				(n): n is Extract<Node, { kind: "folder" }> =>
					n.kind === "folder" && n.folder.name === part,
			)?.folder;
			if (!child) {
				child = {
					name: part,
					path: folder.path ? `${folder.path}/${part}` : part,
					children: [],
				};
				folder.children.push({ kind: "folder", folder: child });
			}
			folder = child;
		}
		folder.children.push({ kind: "file", file });
	}
	const compress = (folder: Folder): Folder => {
		let merged = folder;
		while (
			merged.children.length === 1 &&
			merged.children[0]?.kind === "folder"
		) {
			const only = merged.children[0].folder;
			merged = {
				name: `${merged.name}/${only.name}`,
				path: only.path,
				children: only.children,
			};
		}
		return { ...merged, children: sorted(merged.children) };
	};
	const sorted = (nodes: Node[]): Node[] =>
		nodes
			.map(
				(n): Node =>
					n.kind === "folder"
						? { kind: "folder", folder: compress(n.folder) }
						: n,
			)
			.sort(
				(a, b) =>
					(a.kind === "folder" ? 0 : 1) - (b.kind === "folder" ? 0 : 1) ||
					byName(nameOf(a), nameOf(b)),
			);
	return { ...root, children: sorted(root.children) };
}

/** Every file under the folder, at any depth. */
export function filesIn(folder: Folder): FileView[] {
	return folder.children.flatMap((n) =>
		n.kind === "file" ? [n.file] : filesIn(n.folder),
	);
}

/** The files in the tree's order: depth-first, folders before files. */
export function treeOrder<F extends FileView>(files: readonly F[]): F[] {
	return filesIn(buildTree(files)) as F[];
}
