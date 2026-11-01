import { SyncIcon, XIcon } from "@primer/octicons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { HomeView } from "../../shared/home";
import {
	DelayedNotice,
	FailedNotice,
	NOTICE_STACK,
} from "../files/SyncNotices";
import { DELAYED_MS } from "../files/stateSync";
import { Tooltip } from "../Tooltip";
import { viewSaverFor } from "./viewSaver";

/**
 * Home as it will be once `repos` are saved: the view lists them. The page
 * shows only the listed repos' rows, so a removed repo's go at once.
 */
export function pendingView(home: HomeView, repos: string[]): HomeView {
	return { ...home, view: { ...home.view, repos } };
}

export interface ViewSave {
	/** Saves the view's repos; Home shows them at once. */
	save(repos: string[]): void;
	/** Home with the save being made laid over what the server last said. */
	shown(home: HomeView): HomeView;
	saving: boolean;
	/** The save has waited over DELAYED_MS. */
	delayed: boolean;
	/** Why it waits: the last transient failure, in a few words. */
	waiting: string | null;
	/** STALL_ATTEMPTS transient failures in a row: red, still retrying. */
	stalled: Error | null;
	/** The last save refused; Home went back to the last saved view. */
	failed: { repos: string[]; error: Error } | null;
	retry(): void;
	dismiss(): void;
}

/** Saving the view's repos the way the review state saves (ViewSaver). */
export function useViewSave(): ViewSave {
	const client = useQueryClient();
	// The page's own (viewSaverFor): it keeps saving if Home goes, and the
	// unsaved guard asks before the page does.
	const saver = viewSaverFor(client);
	const state = useSyncExternalStore(saver.subscribe, saver.snapshot);
	const delayed = useDelayed(state.since);
	const intended = state.intended;
	return {
		save: saver.save,
		shown: (home) => (intended ? pendingView(home, intended) : home),
		saving: intended !== null,
		delayed,
		waiting: state.waiting,
		stalled: state.stalled,
		failed: state.refused,
		retry: saver.retry,
		dismiss: saver.dismiss,
	};
}

/** True once DELAYED_MS have passed since `since` (null: nothing waits). */
function useDelayed(since: number | null): boolean {
	const [delayed, setDelayed] = useState(false);
	useEffect(() => {
		setDelayed(false);
		if (since === null) return;
		const timer = setTimeout(
			() => setDelayed(true),
			Math.max(0, since + DELAYED_MS - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [since]);
	return since !== null && delayed;
}

const iconButton =
	"flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent";

/** The view save's notices, where the review page shows its own (SyncNotices). */
export function ViewSaveNotices(props: { save: ViewSave; name: string }) {
	const { save } = props;
	const button = (
		label: string,
		tip: string,
		Icon: typeof XIcon,
		onClick: () => void,
	) => (
		<Tooltip content={tip} describe={false}>
			{(trigger) => (
				<button
					type="button"
					{...trigger}
					aria-label={label}
					onClick={onClick}
					className={iconButton}
				>
					<Icon aria-hidden />
				</button>
			)}
		</Tooltip>
	);
	if (!save.failed && !save.saving) return null;
	const retryButton = button("Retry saving", "Retry", SyncIcon, save.retry);
	return (
		<div data-testid="view-save-notices" className={NOTICE_STACK}>
			{save.failed && (
				<FailedNotice
					testId="view-save-failed"
					label="Not saved"
					what={props.name}
					detail={save.failed.repos.join(", ") || undefined}
					error={save.failed.error.message}
					actions={
						<div className="flex flex-col">
							{retryButton}
							{button("Dismiss", "Dismiss", XIcon, save.dismiss)}
						</div>
					}
				/>
			)}
			{save.saving && save.stalled && (
				// Transient failures that kept on: red, though retrying goes on.
				<FailedNotice
					testId="view-save-stalled"
					label="Not saved yet, still retrying"
					what={props.name}
					error={save.stalled.message}
					actions={retryButton}
				/>
			)}
			<div role="status">
				{save.saving && save.delayed && !save.stalled && (
					<DelayedNotice
						what={`Saving ${props.name}…`}
						waiting={save.waiting}
					/>
				)}
			</div>
		</div>
	);
}
