import {
	ChevronDownIcon,
	ChevronRightIcon,
	DiffRenamedIcon,
	FoldIcon,
	UnfoldIcon,
} from "@primer/octicons-react";
import { useId, useMemo } from "react";
import type { FileView, ReviewThread } from "../../shared/types";
import { Spinner } from "../Spinner";
import { Tooltip, TooltipPath } from "../Tooltip";
import { ChangeKindIcon, changeKindLabel } from "./changeKind";
import {
	buildTree,
	type Folder,
	filesIn,
	folderPaths,
	type Node,
} from "./fileOrder";
import { type Folds, useFolds } from "./folderFold";
import { Meter } from "./ProgressBar";
import { ChangeCount, crossOffReasons, StatusIcon } from "./status";
import { bubbleLabel, waitingLabel, waitsOnYou } from "./ThreadBubble";
import {
	describeFileProgress,
	describeFolderProgress,
	fileUnitProgress,
	folderUnitProgress,
	type Unit,
} from "./unit";

const NONE = () => [];

/**
 * Which file a row marks: the one opened (picked, linked or expanded; it
 * wins when a row is both) or the one in view while scrolling.
 */
type Mark = "opened" | "in view" | null;

const markOf = (
	path: string | undefined,
	opened: string | undefined,
	inView: string | undefined,
): Mark =>
	path === undefined
		? null
		: opened !== undefined && (opened === path || opened.startsWith(`${path}/`))
			? "opened"
			: inView !== undefined &&
					(inView === path || inView.startsWith(`${path}/`))
				? "in view"
				: null;

/** What a row's dot says: "opened", or "holds the opened file" on a folder. */
const markText = (mark: Mark, folder: boolean) =>
	mark &&
	(folder
		? `holds the ${mark === "opened" ? "opened file" : "file in view"}`
		: mark);

/** The row's dot, in accent: filled for the opened file, a ring for the one in view. */
function MarkDot({ mark }: { mark: Mark }) {
	if (!mark) return null;
	return (
		<span
			aria-hidden
			data-testid="tree-dot"
			data-mark={mark}
			className={`h-1.5 w-1.5 shrink-0 rounded-full ${
				mark === "opened" ? "bg-accent" : "border border-accent"
			}`}
		/>
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
	mark: Mark;
	onSelect: (index: number) => void;
	threads: ReviewThread[];
}) {
	const { file, unit, threads, mark } = props;
	// Its review threads, as the bubble says them: a yellow dot when one
	// waits on the viewer, green when all are resolved, else grey.
	const talk =
		threads.length > 0 ? bubbleLabel(threads, false, "in this file") : "";
	const dot = threads.some(waitsOnYou)
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
						{/* A rename's new path in green: where the file is now. */}
						<ChangeKindIcon
							file={file}
							tone={file.status === "renamed" ? "text-ok" : undefined}
						/>
						<span
							data-testid="tree-name"
							className="min-w-0 truncate font-mono text-[0.8125rem]"
						>
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
						<span className="flex min-w-0 flex-1 items-center">
							<MarkDot mark={mark} />
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
						{mark && <span className="sr-only">, {markText(mark, false)}</span>}
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
	/** The path of the file in view, if any. */
	currentPath: string | undefined;
	/** The path of the opened file, if any. */
	openedPath: string | undefined;
	onSelect: (index: number) => void;
	threadsOf: (file: FileView) => ReviewThread[];
	/** The threads are still on their way: no folder says none wait. */
	threadsLoading: boolean;
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
	const files = filesIn(folder);
	// Only renamed files' old paths inside: a faded ghost with no numbers.
	const ghost = files.length === 0;
	const p = folderUnitProgress(files, unit);
	const numbers = ghost ? "" : describeFolderProgress(p, unit);
	const folded = folds.folded.has(folder.path);
	// A breadcrumb: the opened file, or the one in view, is inside.
	const mark = markOf(folder.path, props.openedPath, props.currentPath);
	const said = markText(mark, true);
	// Folded, its files' dots are hidden: a yellow dot when a thread in a
	// file inside (old paths aside) waits on the viewer. Nothing while the
	// threads load.
	const waiting =
		folded && !ghost && !props.threadsLoading
			? waitingLabel(files.flatMap((f) => props.threadsOf(f)))
			: "";
	const Chevron = folded ? ChevronRightIcon : ChevronDownIcon;
	return (
		// The whole group (row and children) in a subtle border, nested
		// groups inside it, each a small step in: folders read apart from files.
		<li
			data-folder-group={folder.path}
			style={{ marginLeft: `${props.depth * 0.75}rem` }}
			className="my-0.5 rounded-md border border-line"
		>
			{/* The numbers are in the name already: the tooltip only shows them. */}
			<Tooltip
				content={
					<>
						<TooltipPath>{folder.path}</TooltipPath>
						{ghost ? " · moved away" : ` · ${numbers}`}
						{waiting && ` · ${waiting}`}
						{said && ` · ${said}`}
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
						data-ghost={ghost || undefined}
						data-finished={(!ghost && p.done) || undefined}
						data-holds-current={mark === "in view" || undefined}
						data-holds-opened={mark === "opened" || undefined}
						onClick={() => folds.toggle(folder.path)}
						style={indent(0)}
						className={`flex w-full items-center gap-1.5 rounded-md py-0.5 pr-1 pointer-coarse:min-h-10 text-left text-sm text-muted transition-colors hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none ${
							ghost
								? "opacity-60"
								: p.done
									? "bg-ok/8 shadow-[inset_2px_0_0_var(--color-ok-fill)]"
									: "bg-band"
						}`}
					>
						<Chevron
							size={16}
							aria-hidden
							className="w-4 shrink-0 text-faint"
						/>
						<span
							data-testid="tree-name"
							className="min-w-0 truncate font-mono text-[0.8125rem]"
						>
							{folder.name}
						</span>
						<span className="flex min-w-0 flex-1 items-center">
							<MarkDot mark={mark} />
						</span>
						{waiting && (
							// The file rows' thread column; its name follows the numbers.
							<span
								aria-hidden
								data-testid="tree-threads"
								className="flex h-4 w-2 shrink-0 items-center"
							>
								<span className="h-2 w-2 rounded-full bg-warn" />
							</span>
						)}
						{!ghost && (
							<>
								<ChangeCount file={p} />
								<span data-testid="tree-numbers" className="sr-only">
									{numbers}
								</span>
							</>
						)}
						{waiting && (
							<span data-testid="tree-waiting" className="sr-only">
								, {waiting}
							</span>
						)}
						{ghost && <span className="sr-only">, moved away</span>}
						{said && <span className="sr-only">, {said}</span>}
						{!ghost && (
							<span
								aria-hidden
								data-testid="tree-meter"
								className="flex h-4 w-10 shrink-0 items-center"
							>
								<Meter
									counts={p.counts}
									// Never full while any file is left (one with no
									// clusters counts nothing but isn't done either).
									incomplete={!p.done}
									className="h-1.5 w-full"
								/>
							</span>
						)}
					</button>
				)}
			</Tooltip>
			{!folded && <Children {...props} nodes={folder.children} depth={1} />}
		</li>
	);
}

/**
 * A renamed file's old path: where it was. Faded, the rename icon reversed
 * in red (like a deletion), no counts: it adds nothing to any progress.
 * Picking it opens the file at its new path.
 */
function MovedItem(props: {
	file: FileView;
	depth: number;
	onSelect: (index: number) => void;
}) {
	const { file } = props;
	const old = file.oldPath ?? "";
	const where = useId();
	return (
		<li>
			<Tooltip
				content={
					<>
						<TooltipPath>{old}</TooltipPath> →{" "}
						<TooltipPath>{file.path}</TooltipPath>
					</>
				}
				describe={false}
			>
				{(trigger) => (
					<button
						type="button"
						{...trigger}
						aria-describedby={where}
						data-moved={old}
						onClick={() => props.onSelect(file.index)}
						style={indent(props.depth)}
						className="flex w-full items-center gap-1.5 rounded-md py-0.5 pr-1 pointer-coarse:min-h-10 text-left text-sm text-muted opacity-60 transition-colors hover:bg-overlay hover:opacity-100 focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none"
					>
						<span aria-hidden className="w-4 shrink-0" />
						<DiffRenamedIcon
							size={12}
							aria-hidden
							className="shrink-0 -scale-x-100 text-bad"
						/>
						<span
							data-testid="tree-name"
							className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]"
						>
							{old.slice(old.lastIndexOf("/") + 1)}
						</span>
						<span className="sr-only">, moved away</span>
					</button>
				)}
			</Tooltip>
			{/* Where it went: the row's description, outside it so its name
			    doesn't carry the new path (a lookup by that path finds one row). */}
			<span id={where} className="sr-only">
				moved to {file.path}
			</span>
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
						mark={markOf(node.file.path, props.openedPath, props.currentPath)}
						onSelect={props.onSelect}
						threads={props.threadsOf(node.file)}
					/>
				) : node.kind === "moved" ? (
					<MovedItem
						key={`m:${node.file.index}`}
						file={node.file}
						depth={props.depth}
						onSelect={props.onSelect}
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

/** A Fold all / Open all icon button above the tree. */
function TreeAction(props: {
	label: string;
	icon: typeof FoldIcon;
	onClick: () => void;
}) {
	const { icon: Icon } = props;
	return (
		<Tooltip content={props.label}>
			{(trigger) => (
				<button
					type="button"
					{...trigger}
					aria-label={props.label}
					onClick={props.onClick}
					className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none pointer-coarse:h-10 pointer-coarse:w-10"
				>
					<Icon size={16} aria-hidden />
				</button>
			)}
		</Tooltip>
	);
}

/**
 * The changed files as a folder tree, in the page's order (fileOrder), with
 * review status; a renamed file also shows at its old path. Folders fold
 * (view state only, kept per PR under `foldKey`); opening a file
 * (`revealSeq`) unfolds its folded folders. Dots mark the opened file and
 * the one in view, on their rows and their folders.
 */
export function FileTree(props: {
	files: FileView[];
	unit: Unit;
	/** The file in view (scroll-tracked). */
	current: number | null;
	/** The file last opened (picked, linked or expanded); null: none yet. */
	opened?: number | null;
	onSelect: (index: number) => void;
	/** Each file's review threads on the viewed head (fileThreads). */
	threadsOf?: (file: FileView) => ReviewThread[];
	/** The threads are still on their way: no file's dot means none yet. */
	threadsLoading?: boolean;
	/** Where this PR's fold state is kept (foldsKey); null: in memory only. */
	foldKey?: string | null;
	/**
	 * Bumped on each opening of a file (a pick, a link, a header): the
	 * opened file's folded folders unfold, even right after load.
	 */
	revealSeq?: number;
}) {
	const { files, current } = props;
	const opened = props.opened ?? null;
	const tree = useMemo(() => buildTree(files), [files]);
	const allFolders = useMemo(() => folderPaths(tree), [tree]);
	const folds = useFolds(props.foldKey ?? null, files, {
		seq: props.revealSeq ?? 0,
		index: opened,
	});
	const pathOf = (index: number | null) =>
		index === null ? undefined : files.find((f) => f.index === index)?.path;
	return (
		<div>
			{allFolders.length > 0 && (
				// Stays on top while the tree scrolls under it, on the
				// background of what holds the tree (--tree-bg).
				<div
					role="toolbar"
					aria-label="Folders"
					className="sticky top-0 z-10 mb-1 flex justify-end gap-1 pt-1 bg-(--tree-bg,var(--color-canvas))"
				>
					<TreeAction
						label="Fold all"
						icon={FoldIcon}
						onClick={() => folds.setAll(allFolders)}
					/>
					<TreeAction
						label="Open all"
						icon={UnfoldIcon}
						onClick={() => folds.setAll([])}
					/>
				</div>
			)}
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
					currentPath={pathOf(current)}
					openedPath={pathOf(opened)}
					onSelect={props.onSelect}
					threadsOf={props.threadsOf ?? NONE}
					threadsLoading={props.threadsLoading === true}
					folds={folds}
				/>
			</nav>
		</div>
	);
}
