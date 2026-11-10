import { SearchIcon } from "@primer/octicons-react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useActivePage } from "../../pages";
import { useReviewId } from "../../reviewId";
import { Keys } from "../../shortcuts";
import { Tooltip } from "../../Tooltip";
import { NOT_PHONE, useMedia } from "../../useMedia";
import { findState, useFindScope } from "./findState";

const LABEL = "Find in PR";

/**
 * The app header's magnifying glass: on Files changed it opens or closes the
 * bar; elsewhere it goes to Files changed and opens it. Carries
 * `data-find-button` (the bar's close puts focus here).
 */
export function FindButton(): ReactNode {
	const onFiles = useActivePage() === "/r/$id/files";
	const { open } = findState.use();
	const navigate = useNavigate();
	const id = useReviewId();
	const desktop = useMedia(NOT_PHONE);
	useFindScope(onFiles, id);
	return (
		<Tooltip
			content={
				desktop ? (
					<span className="flex items-center gap-2">
						{LABEL}
						<Keys keys="Mod+f" />
					</span>
				) : (
					LABEL
				)
			}
			describe={false}
		>
			{(trigger) => (
				<button
					type="button"
					{...trigger}
					aria-label={LABEL}
					// Elsewhere it navigates: nothing expands there.
					aria-expanded={onFiles ? open : undefined}
					data-find-button
					onClick={() => {
						if (onFiles) {
							findState.toggle();
							return;
						}
						findState.open();
						void navigate({ to: "/r/$id/files", params: { id } });
					}}
					className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent aria-expanded:bg-overlay aria-expanded:text-ink motion-reduce:transition-none"
				>
					<SearchIcon aria-hidden />
				</button>
			)}
		</Tooltip>
	);
}
