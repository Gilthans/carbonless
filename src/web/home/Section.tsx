import { ChevronRightIcon } from "@primer/octicons-react";
import { useId, useState } from "react";
import type { HomeRow, HomeSection, SectionId } from "../../shared/home";
import { PrRow } from "./PrRow";
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

/** A section shows this many visible rows, then "show N more". */
export const FOLD = 20;

/** "2 snoozed · 1 waiting", only the parts that aren't zero. */
export function hiddenSummary(rows: HomeRow[]): string {
	const snoozed = rows.filter((r) => r.hidden === "snoozed").length;
	const waiting = rows.filter((r) => r.hidden === "waiting").length;
	return [
		snoozed ? `${snoozed} snoozed` : "",
		waiting ? `${waiting} waiting` : "",
	]
		.filter(Boolean)
		.join(" · ");
}

const footClass =
	"flex min-h-10 items-center gap-1.5 rounded-md px-3 text-xs text-muted hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/**
 * One section: its visible rows (20, then a fold), and its hidden ones
 * behind a footer that counts them and reveals them in place. Nothing is
 * dropped: the count in the heading is every visible row.
 */
export function Section(props: { section: HomeSection; viewer: string }) {
	const { id, rows } = props.section;
	const headingId = useId();
	const hiddenId = useId();
	const [all, setAll] = useState(false);
	const [reveal, setReveal] = useState(false);
	const visible = rows.filter((r) => r.hidden === null);
	const hidden = rows.filter((r) => r.hidden !== null);
	const shown = all ? visible : visible.slice(0, FOLD);
	const more = visible.length - shown.length;
	const summary = hiddenSummary(hidden);
	const key = (r: HomeRow) => `${r.owner}/${r.repo}#${r.number}`;
	return (
		<section aria-labelledby={headingId} data-section={id}>
			<div className="flex items-baseline gap-2 px-1 pb-1.5">
				<h2
					id={headingId}
					className="flex items-baseline gap-2 text-xs font-bold tracking-[0.14em] text-label uppercase"
				>
					{SECTION_LABELS[id]}
					<span className="font-semibold tracking-normal text-faint tabular-nums">
						{visible.length}
					</span>
				</h2>
				{HINTS[id] && <p className="text-xs text-faint">{HINTS[id]}</p>}
			</div>
			{(rows.length > 0 || summary) && (
				<div className="rounded-xl border border-line bg-surface">
					<ul>
						{shown.map((row) => (
							<PrRow
								key={key(row)}
								row={row}
								section={id}
								viewer={props.viewer}
								actions={<RowActions row={row} viewer={props.viewer} />}
							/>
						))}
					</ul>
					{(more > 0 || summary) && (
						<div className="flex flex-wrap items-center gap-x-2 border-t border-line px-1 py-0.5">
							{more > 0 && (
								<button
									type="button"
									onClick={() => setAll(true)}
									className={footClass}
								>
									show {more} more
								</button>
							)}
							{summary && (
								<button
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
					{summary && (
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
