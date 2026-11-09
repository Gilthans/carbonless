import { SparkleFillIcon } from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import type { ThreadPlacement } from "../../shared/rereview/placement";
import { FATES } from "../files/ThreadFate";
import { AgentThreadCard } from "./AgentThreadCard";
import { agentStatusQuery } from "./api";
import type { AgentPlaceable } from "./placeable";

/**
 * The agent threads whose file is not in this comparison (principle 2:
 * never hidden), after the review threads' group: those the tracer put
 * outside it with their fate, and those it has no place for yet (still
 * tracing, its trace failed) on a path the diff doesn't have, e.g. a file
 * renamed since, marked as asked on an earlier version. Each is its own
 * agent card under its original path; resolved ones last (the order
 * given), their cards closed.
 */
export function AgentNotInComparison(props: {
	threads: readonly AgentPlaceable[];
	/** The viewed head: one asked on another is marked outdated. */
	snapshotHead: string;
	placements: ReadonlyMap<string, ThreadPlacement> | null;
}) {
	const status = useQuery({ ...agentStatusQuery, enabled: false }).data;
	if (props.threads.length === 0) return null;
	return (
		<section
			aria-label="Agent threads not in this comparison"
			data-testid="agent-not-in-comparison"
			className="space-y-2 rounded-lg border border-agent-edge bg-surface p-2"
		>
			<h3 className="flex min-h-10 items-center gap-2 px-1 text-sm font-semibold text-ink">
				<SparkleFillIcon size={16} aria-hidden className="text-agent-ink" />
				Not in this comparison
			</h3>
			<ul className="space-y-1.5">
				{props.threads.map(({ thread, commit }) => {
					const placement = props.placements?.get(thread.id);
					const fate =
						placement?.kind === "outside" ? FATES[placement.fate] : null;
					return (
						<li
							key={thread.id}
							data-testid="agent-outside"
							data-thread={thread.id}
							data-fate={
								fate ? (placement as { fate: string }).fate : undefined
							}
							className="min-w-0 space-y-1.5"
						>
							<p className="flex min-h-10 min-w-0 flex-col justify-center px-1">
								{fate && (
									<span
										data-testid="agent-outside-fate"
										className={`truncate text-sm ${
											thread.resolved ? "text-muted" : "font-semibold text-ink"
										}`}
									>
										{thread.resolved ? fate.short : fate.sentence}
									</span>
								)}
								<code className="truncate font-mono text-xs text-ink-soft">
									{thread.anchor.path}
								</code>
							</p>
							<AgentThreadCard
								thread={thread}
								status={status}
								outdated={commit !== props.snapshotHead ? commit : undefined}
							/>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
