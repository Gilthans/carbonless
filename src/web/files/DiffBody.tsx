import { useQueries, useQuery } from "@tanstack/react-query";
import { Fragment, type ReactNode, useId, useState } from "react";
import type {
	ClusterView,
	DiffLine,
	DisplayHunk,
	FileView,
} from "../../shared/types";
import { contextQuery, hunksQuery } from "../api";
import { Tooltip } from "../Tooltip";
import { ErrorMessage } from "../ui";
import { EXPAND_STEP, fileGaps, type Gap, gapState } from "./gaps";
import { highlightLine, languageFor } from "./highlight";

const COLUMNS = 5;

const RAIL: Record<ClusterView["state"], string> = {
	unreviewed: "bg-slate-300",
	reviewed: "bg-green-500",
	"crossed-off": "bg-purple-500",
};

const ROW_BG: Record<DiffLine["kind"], string> = {
	context: "",
	add: "bg-green-50",
	del: "bg-red-50",
};
const NUMBER_BG: Record<DiffLine["kind"], string> = {
	context: "text-slate-400",
	add: "bg-green-100 text-green-800",
	del: "bg-red-100 text-red-800",
};
const SIGN: Record<DiffLine["kind"], string> = {
	context: " ",
	add: "+",
	del: "−",
};

/** A line's code, plain until its highlighting arrives. */
function Code({ text, lang }: { text: string; lang: string | null }) {
	const tokens = useQuery({
		queryKey: ["highlight", lang, text],
		queryFn: () => highlightLine(text, lang),
		enabled: lang !== null && text.length > 0,
		staleTime: Number.POSITIVE_INFINITY,
	});
	if (!tokens.data?.length) return <>{text}</>;
	return (
		<>
			{tokens.data.map((token) => (
				<span
					key={token.offset}
					style={{
						color: token.color,
						fontStyle:
							token.fontStyle && token.fontStyle & 1 ? "italic" : undefined,
						fontWeight:
							token.fontStyle && token.fontStyle & 2 ? "bold" : undefined,
					}}
				>
					{token.content}
				</span>
			))}
		</>
	);
}

/** The left rail: cluster state, blue while the cluster has focus or the pointer. */
function Rail({ state }: { state?: ClusterView["state"] }) {
	const color = state
		? `${RAIL[state]} group-hover:bg-blue-500 group-focus-within:bg-blue-500`
		: "";
	return <td aria-hidden className={`w-1 min-w-1 p-0 ${color}`} />;
}

function LineRow(props: {
	line: DiffLine;
	lang: string | null;
	state?: ClusterView["state"];
	checkbox?: ReactNode;
}) {
	const { line, state } = props;
	const dim = state === "reviewed" ? "opacity-60" : "";
	return (
		<>
			<tr data-testid="diff-line" className={ROW_BG[line.kind]}>
				<Rail state={state} />
				<td className="w-11 px-1 align-top whitespace-nowrap pointer-coarse:w-20">
					{props.checkbox}
				</td>
				<td
					data-testid="old"
					className={`w-12 px-2 text-right align-top select-none ${NUMBER_BG[line.kind]} ${dim}`}
				>
					{line.oldNo}
				</td>
				<td
					data-testid="new"
					className={`w-12 px-2 text-right align-top select-none ${NUMBER_BG[line.kind]} ${dim}`}
				>
					{line.newNo}
				</td>
				<td className={`px-2 whitespace-pre ${dim}`}>
					<span aria-hidden className="mr-2 select-none text-slate-400">
						{SIGN[line.kind]}
					</span>
					<Code text={line.text} lang={props.lang} />
				</td>
			</tr>
			{line.noNewline && (
				<tr>
					<Rail state={state} />
					<td colSpan={COLUMNS - 1} className="px-2 text-slate-500 italic">
						{"\\ No newline at end of file"}
					</td>
				</tr>
			)}
		</>
	);
}

/**
 * A cluster's controls. The checkbox is checked when reviewed; a crossed-off
 * cluster shows a mixed box named "Undo cross-off" and described by its note,
 * and clicking it makes the cluster unreviewed again, never reviewed. Next to
 * it, a toggle crosses the cluster off or undoes that (to unreviewed); a
 * reviewed cluster must be unchecked first.
 */
function ClusterControls(props: {
	cluster: ClusterView;
	noteId?: string;
	disabled: boolean;
	onToggle: (cluster: ClusterView) => void;
	onCrossOff: (cluster: ClusterView) => void;
}) {
	const crossedOff = props.cluster.state === "crossed-off";
	// On touch each control gets its own 40×40 target, side by side so a
	// mis-tap can't reach the other one; the negative margins keep the row
	// height. With a mouse they stay compact.
	const target =
		"flex items-center justify-center pointer-coarse:-my-2.5 pointer-coarse:h-10 pointer-coarse:w-10";
	return (
		<span className="flex items-center gap-1 pointer-coarse:gap-0">
			<label
				data-testid="cluster-box-target"
				className={`${target} cursor-pointer`}
			>
				<input
					type="checkbox"
					aria-label={crossedOff ? "Undo cross-off" : "Mark cluster reviewed"}
					aria-describedby={crossedOff ? props.noteId : undefined}
					ref={(box) => {
						if (box) box.indeterminate = crossedOff;
					}}
					checked={props.cluster.state === "reviewed"}
					disabled={props.disabled}
					onChange={() => props.onToggle(props.cluster)}
					className={`h-3.5 w-3.5 cursor-pointer disabled:cursor-wait ${
						crossedOff ? "accent-purple-600" : "accent-green-600"
					}`}
				/>
			</label>
			<Tooltip
				content={crossedOff ? "Undo cross-off" : "Cross off cluster"}
				describe={false}
			>
				{(trigger) => (
					<button
						type="button"
						{...trigger}
						aria-label="Cross off cluster"
						aria-pressed={crossedOff}
						disabled={props.disabled || props.cluster.state === "reviewed"}
						onClick={() => props.onCrossOff(props.cluster)}
						className={`${target} group/x rounded focus-visible:outline-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-30`}
					>
						<span
							aria-hidden
							className={`flex h-4 w-4 items-center justify-center rounded font-sans text-xs leading-none ${
								crossedOff
									? "bg-purple-600 text-white"
									: "text-purple-700 group-hover/x:bg-purple-100"
							}`}
						>
							⊘
						</span>
					</button>
				)}
			</Tooltip>
		</span>
	);
}

function CrossedOffNote(props: { cluster: ClusterView; id?: string }) {
	if (props.cluster.state !== "crossed-off") return null;
	return (
		<span
			id={props.id}
			className="ml-2 rounded bg-purple-100 px-1 font-sans text-purple-800"
		>
			{props.cluster.reason
				? `Crossed off: ${props.cluster.reason}`
				: "Crossed off"}
		</span>
	);
}

/** Splits a hunk into runs of context lines and runs of one cluster's lines. */
function runs(lines: DiffLine[]): { key?: string; lines: DiffLine[] }[] {
	const result: { key?: string; lines: DiffLine[] }[] = [];
	for (const line of lines) {
		const last = result[result.length - 1];
		if (last && last.key === line.clusterKey) last.lines.push(line);
		else result.push({ key: line.clusterKey, lines: [line] });
	}
	return result;
}

/** One click's worth of lines for each way a gap can grow. */
function expansions(gap: Gap, top: number, bottom: number, remaining: number) {
	const start = gap.from + top;
	const end = gap.to - bottom;
	const plural = (n: number) => `${n} ${n === 1 ? "line" : "lines"}`;
	if (gap.above && gap.below && remaining <= EXPAND_STEP) {
		return [
			{
				glyph: "↕",
				label: `Load all ${plural(remaining)}`,
				from: start,
				to: end,
			},
		];
	}
	const step = Math.min(EXPAND_STEP, remaining);
	const result = [];
	if (gap.above) {
		result.push({
			glyph: "↓",
			label: `Load ${plural(step)} below`,
			from: start,
			to: start + step - 1,
		});
	}
	if (gap.below) {
		result.push({
			glyph: "↑",
			label: `Load ${plural(step)} above`,
			from: end - step + 1,
			to: end,
		});
	}
	return result;
}

const hunkHeader = (h: DisplayHunk) =>
	`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`;

/** The expanded file: file-level clusters, then hunks with loadable context between them. */
export function DiffBody(props: {
	file: FileView;
	revision: string;
	disabled: boolean;
	onToggle: (cluster: ClusterView) => void;
	onCrossOff: (cluster: ClusterView) => void;
}) {
	const { file, revision } = props;
	const hunks = useQuery(hunksQuery(revision, file.index));
	const [ranges, setRanges] = useState<[number, number][]>([]);
	const contexts = useQueries({
		queries: ranges.map(([from, to]) =>
			contextQuery(revision, file.index, from, to),
		),
	});
	const lang = languageFor(file.path);
	const clusters = new Map(file.clusters.map((c) => [c.key, c]));
	const idBase = useId();
	const noteIds = new Map(
		file.clusters.map((c, i) => [c.key, `${idBase}-note-${i}`]),
	);
	const noteId = (cluster: ClusterView) => noteIds.get(cluster.key);
	const fileClusters = file.clusters.filter((c) => c.kind === "file");

	const loaded = new Map<number, DiffLine>();
	for (const result of contexts) {
		for (const line of result.data ?? []) {
			if (line.newNo !== undefined) loaded.set(line.newNo, line);
		}
	}
	/**
	 * Lines that are shown, on their way, or failed (and wait for Retry). A
	 * line a finished range didn't return stays hidden, so it can be loaded
	 * again instead of waiting forever.
	 */
	const taken = new Set(loaded.keys());
	const loadedRanges = ranges.map(([from, to], i) => ({
		from,
		to,
		result: contexts[i],
	}));
	for (const { from, to, result } of loadedRanges) {
		if (result && !result.isSuccess) {
			for (let n = from; n <= to; n++) taken.add(n);
		}
	}
	const addRange = (from: number, to: number) =>
		setRanges((r) =>
			r.some(([f, t]) => f === from && t === to) ? r : [...r, [from, to]],
		);

	const checkbox = (cluster: ClusterView) => (
		<ClusterControls
			cluster={cluster}
			noteId={noteId(cluster)}
			disabled={props.disabled}
			onToggle={props.onToggle}
			onCrossOff={props.onCrossOff}
		/>
	);

	const contextRows = (from: number, to: number) => {
		const rows: ReactNode[] = [];
		for (let n = from; n <= to; n++) {
			const line = loaded.get(n);
			if (line) rows.push(<LineRow key={`c${n}`} line={line} lang={lang} />);
		}
		return rows;
	};

	const gapRows = (gap: Gap | undefined) => {
		if (!gap) return null;
		const { top, bottom, remaining } = gapState(gap, taken);
		const inGap = loadedRanges.filter(
			(r) => r.from <= gap.to && r.to >= gap.from,
		);
		const failed = inGap.flatMap((r) => (r.result?.isError ? [r.result] : []));
		const pending = inGap.some((r) => r.result?.isPending);
		const buttons = expansions(gap, top, bottom, remaining);
		return (
			<tbody key={`gap${gap.index}`}>
				{contextRows(gap.from, gap.from + top - 1)}
				{(remaining > 0 || pending || failed.length > 0) && (
					<tr className="bg-blue-50 text-slate-600">
						<td colSpan={2} className="px-1">
							<div className="flex">
								{buttons.map((b) => (
									<Tooltip key={b.glyph} content={b.label} describe={false}>
										{(trigger) => (
											<button
												type="button"
												{...trigger}
												aria-label={b.label}
												onClick={() => addRange(b.from, b.to)}
												className="rounded px-1 hover:bg-blue-200 focus-visible:outline-2 focus-visible:outline-blue-600"
											>
												{b.glyph}
											</button>
										)}
									</Tooltip>
								))}
							</div>
						</td>
						<td colSpan={COLUMNS - 2} className="px-2 font-sans">
							{failed.length > 0 ? (
								<span role="alert" className="text-red-800">
									{failed[0]?.error?.message}{" "}
									<button
										type="button"
										onClick={() => {
											for (const f of failed) void f.refetch();
										}}
										className="rounded border border-red-300 bg-white px-1.5 text-xs hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-blue-600"
									>
										Retry
									</button>
								</span>
							) : pending ? (
								"Loading…"
							) : (
								`${remaining} hidden ${remaining === 1 ? "line" : "lines"}`
							)}
						</td>
					</tr>
				)}
				{contextRows(gap.to - bottom + 1, gap.to)}
			</tbody>
		);
	};

	const gaps = hunks.data
		? fileGaps(hunks.data.hunks, hunks.data.newLineCount)
		: [];
	const gapAt = (index: number) => gaps.find((g) => g.index === index);

	return (
		<div className="overflow-x-auto">
			<table className="min-w-full border-collapse font-mono text-xs leading-5">
				{fileClusters.map((cluster) => (
					<tbody key={cluster.key} className="group">
						<tr className={cluster.state === "reviewed" ? "opacity-60" : ""}>
							<Rail state={cluster.state} />
							<td className="w-11 px-1 py-1 align-top whitespace-nowrap pointer-coarse:w-20">
								{checkbox(cluster)}
							</td>
							<td colSpan={COLUMNS - 2} className="px-2 py-1 font-sans text-sm">
								{cluster.label}
								<CrossedOffNote cluster={cluster} id={noteId(cluster)} />
							</td>
						</tr>
					</tbody>
				))}
				{hunks.data?.hunks.map((hunk, index) => (
					<Fragment key={hunkHeader(hunk)}>
						{gapRows(gapAt(index))}
						<HunkRows
							hunk={hunk}
							clusters={clusters}
							lang={lang}
							checkbox={checkbox}
							noteId={noteId}
						/>
					</Fragment>
				))}
				{hunks.data && gapRows(gapAt(hunks.data.hunks.length))}
			</table>
			{hunks.isPending && (
				// A screen tall while loading, so a file picked in the tree can
				// scroll its header to the top before its lines arrive.
				<p className="min-h-[100dvh] px-3 py-2 text-sm text-slate-500">
					Loading diff…
				</p>
			)}
			{hunks.isError && (
				<div className="p-2">
					<ErrorMessage error={hunks.error} />
				</div>
			)}
		</div>
	);
}

/** A hunk's header and lines: context runs, and each cluster's run with its rail. */
function HunkRows(props: {
	hunk: DisplayHunk;
	clusters: Map<string, ClusterView>;
	lang: string | null;
	checkbox: (cluster: ClusterView) => ReactNode;
	noteId: (cluster: ClusterView) => string | undefined;
}) {
	return (
		<>
			<tbody>
				<tr className="bg-blue-50 text-slate-500">
					<td colSpan={COLUMNS} className="px-2 py-0.5">
						{hunkHeader(props.hunk)}
					</td>
				</tr>
			</tbody>
			{runs(props.hunk.lines).map((run) => {
				const first = run.lines[0];
				const runKey = `${run.key ?? ""}:${first?.oldNo}:${first?.newNo}`;
				const cluster =
					run.key === undefined ? undefined : props.clusters.get(run.key);
				// A cluster the review doesn't list still shows as unreviewed.
				const state =
					run.key === undefined ? undefined : (cluster?.state ?? "unreviewed");
				return (
					<tbody key={runKey} className={state ? "group" : undefined}>
						{run.lines.map((line, i) => (
							<LineRow
								key={`${line.kind}${line.oldNo ?? line.newNo}`}
								line={line}
								lang={props.lang}
								state={state}
								checkbox={
									i === 0 && cluster ? props.checkbox(cluster) : undefined
								}
							/>
						))}
						{cluster?.state === "crossed-off" && (
							<tr>
								<Rail state={cluster.state} />
								<td colSpan={COLUMNS - 1} className="px-2 text-xs">
									<CrossedOffNote
										cluster={cluster}
										id={props.noteId(cluster)}
									/>
								</td>
							</tr>
						)}
					</tbody>
				);
			})}
		</>
	);
}
