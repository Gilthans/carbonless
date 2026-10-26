import type { FileView, ReviewThread } from "../../shared/types";
import { Tooltip, TooltipPath } from "../Tooltip";
import { ChangeKindIcon, changeKindLabel } from "./changeKind";
import { Meter } from "./ProgressBar";
import { ChangeCount, crossOffReasons, StatusIcon } from "./status";
import { bubbleLabel } from "./ThreadBubble";
import { describeFileProgress, fileUnitProgress, type Unit } from "./unit";

type Node =
	| { kind: "folder"; folder: Folder }
	| { kind: "file"; file: FileView };
interface Folder {
	name: string;
	children: Node[];
}

/** Folders in order of their first file; single-folder chains merge ("a/b"). */
function buildTree(files: FileView[]): Folder {
	const root: Folder = { name: "", children: [] };
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
				child = { name: part, children: [] };
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
			merged = { name: `${merged.name}/${only.name}`, children: only.children };
		}
		return {
			name: merged.name,
			children: merged.children.map((n) =>
				n.kind === "folder"
					? { kind: "folder", folder: compress(n.folder) }
					: n,
			),
		};
	};
	return {
		name: "",
		children: root.children.map((n) =>
			n.kind === "folder" ? { kind: "folder", folder: compress(n.folder) } : n,
		),
	};
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

function Children(props: {
	nodes: Node[];
	unit: Unit;
	depth: number;
	current: number | null;
	onSelect: (index: number) => void;
	threadsOf: (file: FileView) => ReviewThread[];
}) {
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
					<li key={`d:${node.folder.name}`}>
						<Tooltip
							content={<TooltipPath>{node.folder.name}</TooltipPath>}
							describe={false}
						>
							{(trigger) => (
								<div
									{...trigger}
									style={indent(props.depth)}
									className="truncate py-0.5 font-mono text-[0.8125rem] text-muted"
								>
									<span aria-hidden className="mr-1 text-faint">
										▾
									</span>
									{node.folder.name}
								</div>
							)}
						</Tooltip>
						<Children
							nodes={node.folder.children}
							unit={props.unit}
							depth={props.depth + 1}
							current={props.current}
							onSelect={props.onSelect}
							threadsOf={props.threadsOf}
						/>
					</li>
				),
			)}
		</ul>
	);
}

/** The changed files as a folder tree, in snapshot order, with review status. */
export function FileTree(props: {
	files: FileView[];
	unit: Unit;
	current: number | null;
	onSelect: (index: number) => void;
	/** Each file's review threads on the viewed head (fileThreads). */
	threadsOf?: (file: FileView) => ReviewThread[];
}) {
	return (
		<nav aria-label="Files" data-testid="file-tree">
			<Children
				nodes={buildTree(props.files).children}
				unit={props.unit}
				depth={0}
				current={props.current}
				onSelect={props.onSelect}
				threadsOf={props.threadsOf ?? (() => [])}
			/>
		</nav>
	);
}
