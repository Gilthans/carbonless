import { useState } from "react";
import type { ClusterView, FileView, StateChange } from "../../shared/types";
import { ErrorMessage } from "../ui";
import { CrossOffDialog } from "./CrossOffDialog";
import { DiffBody } from "./DiffBody";
import { AddDel, StatusIcon } from "./status";
import { isStale, useSetStates } from "./useSetStates";

const buttonClass =
	"rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-50";

/**
 * One file of the diff: header with review status and bulk actions, and the
 * diff once expanded. Every file starts collapsed; collapsing is only a view
 * setting. `onStaleChange(true)`: a write was refused because the snapshot
 * moved; `onStaleChange(false)`: a later write was stored.
 */
export function FileDiff(props: {
	file: FileView;
	revision: string;
	onStaleChange?: (stale: boolean) => void;
}) {
	const { file, revision } = props;
	const [expanded, setExpanded] = useState(false);
	const [crossingOff, setCrossingOff] = useState(false);
	const setStates = useSetStates({ onStaleChange: props.onStaleChange });
	const pending = setStates.isPending;

	const save = (changes: StateChange[]) =>
		setStates.mutateAsync({ revision, changes });
	// Only an unreviewed cluster's box marks it reviewed: unchecking a reviewed
	// one or undoing a cross-off makes it unreviewed (R21).
	const toggle = (cluster: ClusterView) => {
		save([
			{
				key: cluster.key,
				state: cluster.state === "unreviewed" ? "reviewed" : "unreviewed",
			},
		]).catch(() => {});
	};
	const unreviewed = file.clusters.filter((c) => c.state === "unreviewed");
	const crossed = file.clusters.filter((c) => c.state === "crossed-off");
	const reviewed = file.clusters.filter((c) => c.state === "reviewed").length;

	return (
		<section
			id={`file-${file.index}`}
			data-file-index={file.index}
			aria-label={file.path}
			className="scroll-mt-28 rounded-md border border-slate-200"
		>
			<header className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-t-md border-b border-slate-200 bg-slate-50 px-2 py-1.5">
				<button
					type="button"
					aria-expanded={expanded}
					aria-label={expanded ? "Collapse file" : "Expand file"}
					onClick={() => setExpanded((e) => !e)}
					className="rounded px-1 text-slate-600 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-blue-600"
				>
					{expanded ? "▾" : "▸"}
				</button>
				<StatusIcon file={file} />
				<span className="min-w-0 font-mono text-sm break-all">
					{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
				</span>
				<AddDel file={file} />
				<span className="text-xs text-slate-600">
					<span>
						{reviewed} of {file.clusters.length} clusters reviewed
					</span>
					{crossed.length > 0 && (
						<span className="text-purple-700">
							{" "}
							· {crossed.length} crossed off
						</span>
					)}
				</span>
				<span className="ml-auto flex gap-2">
					{crossed.length > 0 && (
						<button
							type="button"
							disabled={pending}
							onClick={() => {
								save(
									crossed.map((c) => ({ key: c.key, state: "unreviewed" })),
								).catch(() => {});
							}}
							className={buttonClass}
						>
							Undo cross-off
						</button>
					)}
					<button
						type="button"
						onClick={() => setCrossingOff(true)}
						disabled={
							pending ||
							crossingOff ||
							file.clusters.every((c) => c.state === "reviewed")
						}
						className={buttonClass}
					>
						Cross off file…
					</button>
					<button
						type="button"
						disabled={pending || unreviewed.length === 0}
						onClick={() => {
							save(
								unreviewed.map((c) => ({ key: c.key, state: "reviewed" })),
							).catch(() => {});
						}}
						className={buttonClass}
					>
						Mark remaining reviewed
					</button>
				</span>
			</header>
			{crossingOff && (
				<CrossOffDialog
					path={file.path}
					disabled={pending}
					onCancel={() => setCrossingOff(false)}
					onConfirm={(reason) =>
						// What the reviewer already read stays reviewed (R21).
						save(
							file.clusters
								.filter((c) => c.state !== "reviewed")
								.map((c) => ({ key: c.key, state: "crossed-off", reason })),
						).then(
							() => setCrossingOff(false),
							() => {},
						)
					}
				/>
			)}
			{setStates.isError && !isStale(setStates.error) && (
				<div className="px-2 py-1.5">
					<ErrorMessage error={setStates.error} />
				</div>
			)}
			{expanded && (
				<DiffBody
					file={file}
					revision={revision}
					disabled={pending}
					onToggle={toggle}
				/>
			)}
		</section>
	);
}
