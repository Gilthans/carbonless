import { AlertIcon, ChevronRightIcon, SyncIcon } from "@primer/octicons-react";
import { useEffect, useId, useRef, useState } from "react";
import type { HomeRow, HomeSection, SectionId } from "../../shared/home";
import { SkeletonBar } from "../overview/parts";
import { PrRow, Sign } from "./PrRow";
import { RowActions } from "./RowActions";

export const SECTION_LABELS: Record<SectionId, string> = {
	mine: "Mine",
	reviewing: "Reviewing",
	grabs: "Up for grabs",
	other: "Other open",
	closed: "Recently closed",
};

const HINTS: Partial<Record<SectionId, string>> = {
	reviewing: "requested or started",
	grabs: "ready, no reviewer yet",
	closed: "last 3 days",
};

/** "snoozed · waiting": the kinds hidden, no counts (while still loading). */
export function hiddenKinds(rows: HomeRow[]): string {
	const kinds = new Set<string>(
		rows.map((r) =>
			r.hidden === "snoozed" || r.hidden === "waiting" ? r.hidden : "hidden",
		),
	);
	return ["snoozed", "waiting", "hidden"]
		.filter((k) => kinds.has(k))
		.join(" · ");
}

/** A section shows this many visible rows, then "show N more". */
export const FOLD = 20;

/**
 * "2 snoozed · 1 waiting", only the parts that aren't zero; any other
 * reason the server sends counts as "N hidden", so no hidden row goes
 * uncounted.
 */
export function hiddenSummary(rows: HomeRow[]): string {
	const snoozed = rows.filter((r) => r.hidden === "snoozed").length;
	const waiting = rows.filter((r) => r.hidden === "waiting").length;
	const other = rows.filter(
		(r) =>
			r.hidden !== null && r.hidden !== "snoozed" && r.hidden !== "waiting",
	).length;
	return [
		snoozed ? `${snoozed} snoozed` : "",
		waiting ? `${waiting} waiting` : "",
		other ? `${other} hidden` : "",
	]
		.filter(Boolean)
		.join(" · ");
}

const footClass =
	"flex min-h-10 items-center gap-1.5 rounded-md px-3 text-xs text-muted hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/** A row still on its way: grey bars where its title and meta will be. */
function SkeletonRow() {
	return (
		<li
			data-testid="row-skeleton"
			aria-hidden
			className="space-y-2 border-t border-line px-3 py-3 first:border-t-0"
		>
			<SkeletonBar className="w-2/3 max-w-md" />
			<SkeletonBar className="w-1/3 max-w-48" />
		</li>
	);
}

/**
 * One section: its visible rows (20, then a fold), and its hidden ones
 * behind a footer that counts them and reveals them in place. Nothing is
 * dropped: the count in the heading is every visible row. While `loading`
 * (a view repo's first read isn't in) the count is a spinner and
 * placeholder rows stand where rows may still come, so a section still
 * loading never reads as empty (owner, 2026-11-01: "An empty result should
 * always be easily distinguishable for a still loading result"); loaded
 * and empty, it says none.
 */
export function Section(props: {
	section: HomeSection;
	viewer: string;
	loading?: boolean;
	/**
	 * Repos never read (their first read failed), with why: the count
	 * leaves them out, so it says so, and never "none".
	 */
	missing?: string;
}) {
	const loading = props.loading ?? false;
	const missing = loading ? undefined : props.missing;
	const { id, rows } = props.section;
	const headingId = useId();
	const hiddenId = useId();
	const [all, setAll] = useState(false);
	const [reveal, setReveal] = useState(false);
	const visible = rows.filter((r) => r.hidden === null);
	const hidden = rows.filter((r) => r.hidden !== null);
	const shown = all ? visible : visible.slice(0, FOLD);
	const more = visible.length - shown.length;
	// Counts only once every repo has answered (no partial numbers).
	const summary = loading ? hiddenKinds(hidden) : hiddenSummary(hidden);
	const anyHidden = hidden.length > 0;
	// A row the reviewer just hid: focus follows it to the footer.
	const foot = useRef<HTMLButtonElement>(null);
	const [focusFoot, setFocusFoot] = useState(false);
	useEffect(() => {
		if (!focusFoot || !anyHidden || !foot.current) return;
		foot.current.focus();
		setFocusFoot(false);
		// The footer may first appear with the row's answer, a render later.
	}, [focusFoot, anyHidden]);
	const onHidden = () => setFocusFoot(true);
	const key = (r: HomeRow) => `${r.owner}/${r.repo}#${r.number}`;
	return (
		<section aria-labelledby={headingId} data-section={id}>
			<div className="flex items-baseline gap-2 px-1 pb-1.5">
				<h2
					id={headingId}
					className="flex items-baseline gap-2 text-xs font-bold tracking-[0.14em] text-label uppercase"
				>
					{SECTION_LABELS[id]}
					{loading ? (
						<Sign label="Loading" className="self-center text-faint">
							<SyncIcon
								size={12}
								aria-hidden
								className="animate-spin motion-reduce:animate-none"
							/>
						</Sign>
					) : (
						<span className="font-semibold tracking-normal text-faint tabular-nums">
							{visible.length}
						</span>
					)}
					{missing && (
						<Sign label={missing} className="self-center text-bad">
							<AlertIcon size={12} aria-hidden />
						</Sign>
					)}
				</h2>
				{HINTS[id] && <p className="text-xs text-faint">{HINTS[id]}</p>}
			</div>
			{rows.length === 0 && !loading && !missing && (
				<p
					data-testid="section-none"
					className="px-1 text-xs text-faint italic"
				>
					none
				</p>
			)}
			{(rows.length > 0 || loading) && (
				<div className="rounded-xl border border-line bg-surface">
					<ul>
						{loading && rows.length === 0 && (
							<>
								<SkeletonRow />
								<SkeletonRow />
							</>
						)}
						{shown.map((row) => (
							<PrRow
								key={key(row)}
								row={row}
								section={id}
								viewer={props.viewer}
								actions={
									<RowActions
										row={row}
										viewer={props.viewer}
										onHidden={onHidden}
									/>
								}
							/>
						))}
						{loading && rows.length > 0 && <SkeletonRow />}
					</ul>
					{(more > 0 || anyHidden) && (
						<div className="flex flex-wrap items-center gap-x-2 border-t border-line px-1 py-0.5">
							{more > 0 && (
								<button
									type="button"
									onClick={() => setAll(true)}
									className={footClass}
								>
									{loading ? "show more" : `show ${more} more`}
								</button>
							)}
							{anyHidden && (
								<button
									ref={foot}
									type="button"
									aria-expanded={reveal}
									aria-controls={hiddenId}
									onClick={() => setReveal((r) => !r)}
									className={footClass}
								>
									<ChevronRightIcon
										size={12}
										aria-hidden
										className={`transition-transform motion-reduce:transition-none ${reveal ? "rotate-90" : ""}`}
									/>
									{summary}
								</button>
							)}
						</div>
					)}
					{anyHidden && (
						<ul id={hiddenId} hidden={!reveal} className="border-t border-line">
							{reveal &&
								hidden.map((row) => (
									<PrRow
										key={key(row)}
										row={row}
										section={id}
										viewer={props.viewer}
										actions={<RowActions row={row} viewer={props.viewer} />}
									/>
								))}
						</ul>
					)}
				</div>
			)}
		</section>
	);
}
