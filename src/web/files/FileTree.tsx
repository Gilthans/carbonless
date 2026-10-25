import type { FileView } from "../../shared/types";
import { Meter } from "./ProgressBar";
import { ChangeCount, crossOffReasons, StatusIcon } from "./status";
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
 * The file's progress as a mini bar like the page's, its exact numbers in the
 * tooltip and accessible value. Same cap: never full while a cluster is left.
 */
function FileMeter({ file, unit }: { file: FileView; unit: Unit }) {
	const p = fileUnitProgress(file, unit);
	const sentence = describeFileProgress(file, unit);
	return (
		<span
			role="progressbar"
			aria-label="File progress"
			aria-valuenow={p.percent}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuetext={sentence}
			title={sentence}
			className="flex h-4 w-10 shrink-0 items-center"
		>
			<Meter
				counts={p.counts}
				incomplete={p.clustersLeft > 0}
				className="h-1.5 w-full"
			/>
		</span>
	);
}

function FileItem(props: {
	file: FileView;
	unit: Unit;
	depth: number;
	current: boolean;
	onSelect: (index: number) => void;
}) {
	const { file } = props;
	const name = file.path.slice(file.path.lastIndexOf("/") + 1);
	return (
		<li>
			<button
				type="button"
				title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
				aria-current={props.current ? "true" : undefined}
				onClick={() => props.onSelect(file.index)}
				style={indent(props.depth)}
				className={`flex w-full items-center gap-1.5 rounded py-0.5 pr-1 pointer-coarse:min-h-10 text-left text-sm hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-600 ${
					props.current ? "bg-blue-50 font-medium text-blue-900" : ""
				}`}
			>
				<StatusIcon file={file} />
				<span className="min-w-0 flex-1 truncate">
					{file.crossedOff ? <s className="text-slate-500">{name}</s> : name}
					{file.crossedOff &&
						crossOffReasons(file).map((reason) => (
							<span
								key={reason}
								className="ml-1 rounded bg-purple-100 px-1 text-xs text-purple-800"
							>
								{reason}
							</span>
						))}
				</span>
				<ChangeCount file={file} unit={props.unit} />
				<FileMeter file={file} unit={props.unit} />
			</button>
		</li>
	);
}

function Children(props: {
	nodes: Node[];
	unit: Unit;
	depth: number;
	current: number | null;
	onSelect: (index: number) => void;
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
					/>
				) : (
					<li key={`d:${node.folder.name}`}>
						<div
							style={indent(props.depth)}
							title={node.folder.name}
							className="truncate py-0.5 text-sm text-slate-600"
						>
							<span aria-hidden className="mr-1 text-slate-400">
								▾
							</span>
							{node.folder.name}
						</div>
						<Children
							nodes={node.folder.children}
							unit={props.unit}
							depth={props.depth + 1}
							current={props.current}
							onSelect={props.onSelect}
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
}) {
	return (
		<nav aria-label="Files" data-testid="file-tree">
			<Children
				nodes={buildTree(props.files).children}
				unit={props.unit}
				depth={0}
				current={props.current}
				onSelect={props.onSelect}
			/>
		</nav>
	);
}
