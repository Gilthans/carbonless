import { ChevronDownIcon, ChevronRightIcon } from "@primer/octicons-react";
import { useMemo } from "react";
import type { FileView, ReviewThread } from "../../shared/types";
import { Spinner } from "../Spinner";
import { Tooltip, TooltipPath } from "../Tooltip";
import { ChangeKindIcon, changeKindLabel } from "./changeKind";
import { type Folds, useFolds } from "./folderFold";
import { Meter } from "./ProgressBar";
import { ChangeCount, crossOffReasons, StatusIcon } from "./status";
import { bubbleLabel } from "./ThreadBubble";
import {
	describeFileProgress,
	describeFolderProgress,
	fileUnitProgress,
	folderUnitProgress,
	type Unit,
} from "./unit";

const NONE = () => [];

type Node =
	| { kind: "folder"; folder: Folder }
	| { kind: "file"; file: FileView };
interface Folder {
	/** As shown: single-folder chains merged ("a/b"). */
	name: string;
	/** Full path from the root: the folder's identity (fold state). */
	path: string;
	children: Node[];
}

/** Folders in order of their first file; single-folder chains merge ("a/b"). */
function buildTree(files: readonly FileView[]): Folder {
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
		return {
			...merged,
			children: merged.children.map((n) =>
				n.kind === "folder"
					? { kind: "folder", folder: compress(n.folder) }
					: n,
			),
		};
	};
	return {
		...root,
		children: root.children.map((n) =>
			n.kind === "folder" ? { kind: "folder", folder: compress(n.folder) } : n,
		),
	};
}

/** Every file under the folder, at any depth. */
function filesIn(folder: Folder): FileView[] {
	return folder.children.flatMap((n) =>
		n.kind === "file" ? [n.file] : filesIn(n.folder),
	);
}

const indent = (depth: number) => ({
	paddingLeft: `${depth * 0.75 + 0.25}rem`,
});

/**
 * One file: status, name, change count and a mini progress bar like the
 * page's (same cap: never full while a cluster is left). The exact numbers end
 * the row's accessible name and show in a tooltip on hover and keyboard focus.
 */
function FileItem(props: {
	file: FileView;
	unit: Unit;
	depth: number;
	current: boolean;
	onSelect: (index: number) => void;
	threads: ReviewThread[];
}) {
	const { file, unit, threads } = props;
	// Its review threads, as the bubble says them: a yellow dot when one
	// waits on the viewer, green when all are resolved, else grey.
	const talk =
		threads.length > 0 ? bubbleLabel(threads, false, "in this file") : "";
	const dot = threads.some((t) => t.yourTurn && !t.resolved)
		? "bg-warn"
		: threads.every((t) => t.resolved)
			? "bg-ok"
			: "bg-muted";
	const name = file.path.slice(file.path.lastIndexOf("/") + 1);
	const p = fileUnitProgress(file, unit);
	const numbers = describeFileProgress(file, unit);
	const path = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
	return (
		<li>
			{/* The numbers are in the name already: the tooltip only shows them. */}
			<Tooltip
				content={
					<>
						{file.status === "renamed" ? "Renamed" : changeKindLabel(file)} ·{" "}
						<TooltipPath>{path}</TooltipPath> · {numbers}
						{talk && ` · ${talk}`}
					</>
				}
				describe={false}
			>
				{(trigger) => (
					<button
						type="button"
						{...trigger}
						aria-current={props.current ? "true" : undefined}
						data-finished={file.done || undefined}
						onClick={() => props.onSelect(file.index)}
						style={indent(props.depth)}
						className={`flex w-full items-center gap-1.5 rounded-md py-0.5 pr-1 pointer-coarse:min-h-10 text-left text-sm transition-colors hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none ${
							props.current
								? "bg-accent/12 text-ink shadow-[inset_2px_0_0_var(--color-accent)]"
								: file.done
									? "bg-ok/8 text-ink-soft shadow-[inset_2px_0_0_var(--color-ok-fill)]"
									: "text-ink-soft"
						}`}
					>
						<StatusIcon file={file} />
						<ChangeKindIcon file={file} />
						<span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">
							{file.crossedOff ? (
								<s className="text-muted decoration-done">{name}</s>
							) : (
								name
							)}
							{file.crossedOff &&
								crossOffReasons(file).map((reason) => (
									<span
										key={reason}
										className="ml-1 rounded bg-crossed/20 px-1 font-sans text-xs text-done"
									>
										{reason}
									</span>
								))}
						</span>
						{talk && (
							<span
								data-testid="tree-threads"
								className="flex h-4 w-2 shrink-0 items-center"
							>
								<span aria-hidden className={`h-2 w-2 rounded-full ${dot}`} />
								<span className="sr-only">{talk}</span>
							</span>
						)}
						<ChangeCount file={file} />
						<span data-testid="tree-numbers" className="sr-only">
							{numbers}
						</span>
						<span
							aria-hidden
							data-testid="tree-meter"
							className="flex h-4 w-10 shrink-0 items-center"
						>
							<Meter
								counts={p.counts}
								incomplete={p.clustersLeft > 0}
								className="h-1.5 w-full"
							/>
						</span>
					</button>
				)}
			</Tooltip>
		</li>
	);
}

interface Level {
	unit: Unit;
	depth: number;
	current: number | null;
	/** The current file's path, if any. */
	currentPath: string | undefined;
	onSelect: (index: number) => void;
	threadsOf: (file: FileView) => ReviewThread[];
	folds: Folds;
}

/**
 * A folder: a toggle that folds its subtree away, with its files'
 * accumulated progress in the same columns as a file row's, open or folded.
 * Folding is view state only: the numbers and the meter never change with
 * it, and a folder with anything unreviewed never looks finished.
 */
function FolderItem(props: Level & { folder: Folder }) {
	const { folder, unit, folds } = props;
	const p = folderUnitProgress(filesIn(folder), unit);
	const numbers = describeFolderProgress(p, unit);
	const folded = folds.folded.has(folder.path);
	// Folded over the current file: the row stands in for it.
	const holdsCurrent =
		folded && !!props.currentPath?.startsWith(`${folder.path}/`);
	const Chevron = folded ? ChevronRightIcon : ChevronDownIcon;
	return (
		<li>
			{/* The numbers are in the name already: the tooltip only shows them. */}
			<Tooltip
				content={
					<>
						<TooltipPath>{folder.path}</TooltipPath> · {numbers}
					</>
				}
				describe={false}
			>
				{(trigger) => (
					<button
						type="button"
						{...trigger}
						aria-expanded={!folded}
						data-folder={folder.path}
						data-finished={p.done || undefined}
						data-holds-current={holdsCurrent || undefined}
						onClick={() => folds.toggle(folder.path)}
						style={indent(props.depth)}
						className={`flex w-full items-center gap-1.5 rounded-md py-0.5 pr-1 pointer-coarse:min-h-10 text-left text-sm text-muted transition-colors hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none ${
							holdsCurrent
								? "bg-accent/12 shadow-[inset_2px_0_0_var(--color-accent)]"
								: p.done
									? "bg-ok/8 shadow-[inset_2px_0_0_var(--color-ok-fill)]"
									: ""
						}`}
					>
						<Chevron
							size={16}
							aria-hidden
							className="w-4 shrink-0 text-faint"
						/>
						<span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">
							{folder.name}
						</span>
						<ChangeCount file={p} />
						<span data-testid="tree-numbers" className="sr-only">
							{numbers}
						</span>
						<span
							aria-hidden
							data-testid="tree-meter"
							className="flex h-4 w-10 shrink-0 items-center"
						>
							<Meter
								counts={p.counts}
								incomplete={p.clustersLeft > 0}
								className="h-1.5 w-full"
							/>
						</span>
					</button>
				)}
			</Tooltip>
			{!folded && (
				<Children {...props} nodes={folder.children} depth={props.depth + 1} />
			)}
		</li>
	);
}

function Children(props: Level & { nodes: Node[] }) {
	return (
		<ul>
			{props.nodes.map((node) =>
				node.kind === "file" ? (
					<FileItem
						key={`f:${node.file.index}`}
						file={node.file}
						unit={props.unit}
						depth={props.depth}
						current={props.current === node.file.index}
						onSelect={props.onSelect}
						threads={props.threadsOf(node.file)}
					/>
				) : (
					<FolderItem
						key={`d:${node.folder.path}`}
						{...props}
						folder={node.folder}
					/>
				),
			)}
		</ul>
	);
}

/**
 * The changed files as a folder tree, in snapshot order, with review status.
 * Folders fold (view state only, kept per PR under `foldKey`); the current
 * file's folded folders unfold whenever it changes.
 */
export function FileTree(props: {
	files: FileView[];
	unit: Unit;
	current: number | null;
	onSelect: (index: number) => void;
	/** Each file's review threads on the viewed head (fileThreads). */
	threadsOf?: (file: FileView) => ReviewThread[];
	/** The threads are still on their way: no file's dot means none yet. */
	threadsLoading?: boolean;
	/** Where this PR's fold state is kept (foldsKey); null: in memory only. */
	foldKey?: string | null;
}) {
	const { files, current } = props;
	const tree = useMemo(() => buildTree(files), [files]);
	const folds = useFolds(props.foldKey ?? null, files, current);
	return (
		<nav
			aria-label="Files"
			aria-busy={props.threadsLoading || undefined}
			data-testid="file-tree"
			className="relative"
		>
			{props.threadsLoading && (
				// Laid over the first row's end, so the tree doesn't move when
				// it goes; taps go through to the row under it.
				<Spinner
					label="Loading comments"
					className="pointer-events-none absolute top-0 right-0 z-[5] h-6 rounded-full border border-line bg-raised px-1 shadow-control"
				/>
			)}
			<Children
				nodes={tree.children}
				unit={props.unit}
				depth={0}
				current={current}
				currentPath={
					current === null
						? undefined
						: files.find((f) => f.index === current)?.path
				}
				onSelect={props.onSelect}
				threadsOf={props.threadsOf ?? NONE}
				folds={folds}
			/>
		</nav>
	);
}
