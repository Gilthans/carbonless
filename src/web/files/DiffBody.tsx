import { InfoIcon } from "@primer/octicons-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
	Fragment,
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import type {
	ClusterView,
	DiffLine,
	DisplayHunk,
	FileView,
} from "../../shared/types";
import { contextQuery, hunksQuery } from "../api";
import { CodeLine } from "../code/Invisibles";
import { Tooltip } from "../Tooltip";
import { ErrorMessage } from "../ui";
import { EXPAND_STEP, fileGaps, type Gap, gapState } from "./gaps";
import { languageFor } from "./highlight";
import type { Landing } from "./landing";
import { CONTROLS, SLOT, useStickyControls } from "./stickyControls";

const COLUMNS = 5;

const RAIL: Record<ClusterView["state"], string> = {
	unreviewed: "bg-unreviewed",
	reviewed: "bg-ok-fill",
	"crossed-off": "hatch",
};

/**
 * A reviewed cluster's lines settle down: their added/deleted tint fades to
 * a quieter one, the text keeping full contrast (the green rail and checked
 * box say it's reviewed).
 */
const REVIEWED_ROW_BG: Record<DiffLine["kind"], string> = {
	context: "",
	add: "bg-add-done",
	del: "bg-del-done",
};
const REVIEWED_NUMBER_BG: Record<DiffLine["kind"], string> = {
	context: "text-faint",
	add: "bg-add-done text-add-ink",
	del: "bg-del-done text-del-ink",
};
const ROW_BG: Record<DiffLine["kind"], string> = {
	context: "",
	add: "bg-add",
	del: "bg-del",
};
const NUMBER_BG: Record<DiffLine["kind"], string> = {
	context: "text-faint",
	add: "bg-add-gutter text-add-ink",
	del: "bg-del-gutter text-del-ink",
};
const SIGN_COLOR: Record<DiffLine["kind"], string> = {
	context: "text-faint",
	add: "text-add-ink",
	del: "text-del-ink",
};
const SIGN: Record<DiffLine["kind"], string> = {
	context: " ",
	add: "+",
	del: "−",
};

/** The left rail: cluster state, the accent while the cluster has focus or the pointer. */
function Rail({ state }: { state?: ClusterView["state"] }) {
	const color = state
		? `${RAIL[state]} group-hover:bg-accent group-hover:bg-none group-focus-within:bg-accent group-focus-within:bg-none`
		: "";
	return <td aria-hidden className={`w-1 min-w-1 p-0 ${color}`} />;
}

function LineRow(props: {
	line: DiffLine;
	lang: string | null;
	tabWidth?: number;
	state?: ClusterView["state"];
	checkbox?: ReactNode;
	/** Landed on from a thread link (useLanding). */
	landed?: Landed["phase"];
}) {
	const { line, state } = props;
	const reviewed = state === "reviewed";
	const rowBg = (reviewed ? REVIEWED_ROW_BG : ROW_BG)[line.kind];
	const numberBg = (reviewed ? REVIEWED_NUMBER_BG : NUMBER_BG)[line.kind];
	return (
		<>
			<tr
				data-testid="diff-line"
				data-reviewed={reviewed || undefined}
				data-old-no={line.oldNo}
				data-new-no={line.newNo}
				data-landed={props.landed === "on" || undefined}
				className={`${rowBg} ${props.landed ? LANDED_CLASS[props.landed] : ""}`}
			>
				<Rail state={state} />
				<td className="w-11 px-1 align-top whitespace-nowrap pointer-coarse:w-20">
					{props.checkbox}
				</td>
				<td
					data-testid="old"
					className={`w-12 px-2 text-right align-top select-none ${numberBg}`}
				>
					{line.oldNo}
				</td>
				<td
					data-testid="new"
					className={`w-12 px-2 text-right align-top select-none ${numberBg}`}
				>
					{line.newNo}
				</td>
				<td className="px-2 whitespace-pre">
					<span
						aria-hidden
						className={`mr-2 select-none ${SIGN_COLOR[line.kind]}`}
					>
						{SIGN[line.kind]}
					</span>
					<CodeLine
						text={line.text}
						lang={props.lang}
						tabWidth={props.tabWidth}
						newline={!line.noNewline}
					/>
				</td>
			</tr>
			{line.noNewline && (
				<tr>
					<Rail state={state} />
					<td colSpan={COLUMNS - 1} className="px-2 text-muted italic">
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
		// The slot keeps its size while the controls float (stickyControls.ts).
		<span {...{ [SLOT]: "" }} className="block">
			<span
				{...{ [CONTROLS]: "" }}
				className="z-[5] flex w-fit items-center gap-1 rounded-md pointer-coarse:gap-0 data-[stuck]:bg-raised data-[stuck]:shadow-control data-[stuck]:ring-1 data-[stuck]:ring-line-strong"
			>
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
							crossedOff ? "accent-crossed" : "accent-ok-fill"
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
							className={`${target} group/x rounded focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-30`}
						>
							<span
								aria-hidden
								className={`flex h-4 w-4 items-center justify-center rounded font-sans text-xs leading-none ${
									crossedOff
										? "bg-crossed-strong text-ink"
										: "text-done group-hover/x:bg-crossed/25"
								}`}
							>
								⊘
							</span>
						</button>
					)}
				</Tooltip>
			</span>
		</span>
	);
}

function CrossedOffNote(props: { cluster: ClusterView; id?: string }) {
	if (props.cluster.state !== "crossed-off") return null;
	return (
		<span
			id={props.id}
			className="ml-2 rounded bg-crossed/20 px-1 font-sans text-done"
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
	landing?: Landing;
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
	const root = useRef<HTMLDivElement>(null);
	const scroller = useRef<HTMLDivElement>(null);
	useStickyControls(root, scroller);
	const { hint, landed } = useLanding(root, props.landing, hunks.isSuccess);

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
			if (line) {
				rows.push(
					<LineRow
						key={`c${n}`}
						line={line}
						lang={lang}
						tabWidth={file.tabWidth}
						landed={landedPhase(landed, line)}
					/>,
				);
			}
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
					<tr className="bg-hunk text-hunk-ink">
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
												className="rounded px-1 hover:bg-pressed hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
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
								<span role="alert" className="text-bad">
									{failed[0]?.error?.message}{" "}
									<button
										type="button"
										onClick={() => {
											for (const f of failed) void f.refetch();
										}}
										className="rounded border border-bad/60 px-1.5 text-xs hover:bg-bad/15 focus-visible:outline-2 focus-visible:outline-accent"
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
		<div ref={root}>
			{hint && <LandingHint hint={hint} />}
			<div ref={scroller} className="overflow-x-auto">
				<table className="min-w-full border-collapse bg-code font-mono text-xs leading-5 text-code-ink">
					{fileClusters.map((cluster) => (
						<tbody key={cluster.key} className="group">
							<tr className={cluster.state === "reviewed" ? "text-muted" : ""}>
								<Rail state={cluster.state} />
								<td className="w-11 px-1 py-1 align-top whitespace-nowrap pointer-coarse:w-20">
									{checkbox(cluster)}
								</td>
								<td
									colSpan={COLUMNS - 2}
									className="px-2 py-1 font-sans text-sm"
								>
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
								tabWidth={file.tabWidth}
								checkbox={checkbox}
								noteId={noteId}
								landed={landed}
							/>
						</Fragment>
					))}
					{hunks.data && gapRows(gapAt(hunks.data.hunks.length))}
				</table>
			</div>
			{hunks.isPending && (
				// A screen tall while loading, so a file picked in the tree can
				// scroll its header to the top before its lines arrive.
				<p className="min-h-[100dvh] px-3 py-2 text-sm text-muted">
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

/** How long a landed-on line stays highlighted before it fades. */
export const LANDED_MS = 2500;
/** How long its fade takes (the row's transition, below). */
const FADE_MS = 1000;
/**
 * A landed row: the tint and the accent rail over the cluster's own while
 * it lasts; while fading, only the transition, so the tint fades out (and
 * never in: it shows at once).
 */
const LANDED_CLASS = {
	on: "mark-tint [&>td:first-child]:bg-accent!",
	fading:
		"[&>td]:transition-shadow [&>td]:duration-1000 motion-reduce:[&>td]:transition-none",
} as const;

/** The landed-on line, by its number on one side, and how far along it is. */
export interface Landed {
	old: boolean;
	line: number;
	phase: keyof typeof LANDED_CLASS;
}

const landedPhase = (landed: Landed | null, line: DiffLine) =>
	landed && (landed.old ? line.oldNo : line.newNo) === landed.line
		? landed.phase
		: undefined;

/** Why a landing found no line: the text and its tooltip. */
interface Hint {
	text: string;
	tip: string;
}

/**
 * Follows a thread link's landing once the hunks are in: scrolls the line
 * just below the sticky headers and highlights it for a moment, or, when the
 * line isn't shown (or was numbered on another commit), scrolls to the file
 * and returns the hint to show at its top. Each landing (`seq`) runs once.
 */
function useLanding(
	root: RefObject<HTMLDivElement | null>,
	landing: Landing | undefined,
	ready: boolean,
): { hint: Hint | null; landed: Landed | null } {
	const [hint, setHint] = useState<Hint | null>(null);
	const [landed, setLanded] = useState<Landed | null>(null);
	const done = useRef(0);
	useEffect(() => {
		const el = root.current;
		if (!landing || !ready || !el || done.current === landing.seq) return;
		done.current = landing.seq;
		const section = el.closest("section");
		const header = section?.querySelector("header");
		const vars = getComputedStyle(el);
		const sticky =
			(Number.parseFloat(vars.getPropertyValue("--app-header")) || 0) +
			(Number.parseFloat(vars.getPropertyValue("--files-bar")) || 0) +
			(header?.offsetHeight ?? 0);
		const scrollTo = (target: Element, margin: number) =>
			window.scrollTo({
				top:
					target.getBoundingClientRect().top + window.scrollY - sticky - margin,
			});
		const old = landing.side === "LEFT";
		const where = `${old ? "Old line" : "Line"} ${landing.line}`;
		const row =
			landing.line === undefined || landing.moved
				? null
				: el.querySelector(
						`tr[data-${old ? "old" : "new"}-no="${landing.line}"]`,
					);
		if (!row) {
			setHint(
				landing.line === undefined
					? null
					: landing.moved
						? {
								text: `${where} is from another commit`,
								tip: "Commented on another commit: the line may have moved",
							}
						: {
								text: `${where} isn't in this diff`,
								tip: "Outdated, or an unchanged line the diff doesn't show",
							},
			);
			if (section) scrollTo(section, -1);
			return;
		}
		setHint(null);
		// A few lines of context above it stay in view.
		scrollTo(row, 60);
		const line = landing.line as number;
		setLanded({ old, line, phase: "on" });
		const fade = window.setTimeout(
			() => setLanded({ old, line, phase: "fading" }),
			LANDED_MS,
		);
		const end = window.setTimeout(() => setLanded(null), LANDED_MS + FADE_MS);
		return () => {
			window.clearTimeout(fade);
			window.clearTimeout(end);
			setLanded(null);
		};
	}, [root, landing, ready]);
	return { hint, landed };
}

function LandingHint({ hint }: { hint: Hint }) {
	return (
		<Tooltip content={hint.tip}>
			{(trigger) => (
				<p
					{...trigger}
					role="status"
					data-testid="landing-hint"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
					tabIndex={0}
					className="flex min-h-10 items-center gap-2 border-b border-line bg-band px-3 text-xs text-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
				>
					<InfoIcon size={14} aria-hidden className="shrink-0 text-accent" />
					{hint.text}
				</p>
			)}
		</Tooltip>
	);
}

/** A hunk's header and lines: context runs, and each cluster's run with its rail. */
function HunkRows(props: {
	hunk: DisplayHunk;
	clusters: Map<string, ClusterView>;
	lang: string | null;
	tabWidth?: number;
	checkbox: (cluster: ClusterView) => ReactNode;
	noteId: (cluster: ClusterView) => string | undefined;
	landed: Landed | null;
}) {
	return (
		<>
			<tbody>
				<tr className="bg-hunk text-hunk-ink">
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
								tabWidth={props.tabWidth}
								state={state}
								landed={landedPhase(props.landed, line)}
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
