import { SyncIcon, XIcon } from "@primer/octicons-react";
import {
	useMutation,
	useMutationState,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { HomeView } from "../../shared/home";
import {
	DelayedNotice,
	FailedNotice,
	NOTICE_STACK,
} from "../files/SyncNotices";
import {
	DELAYED_MS,
	isTransient,
	RETRY_DELAYS_MS,
	STALL_ATTEMPTS,
	waitReason,
} from "../files/stateSync";
import { Tooltip } from "../Tooltip";
import { homeQuery, putView } from "./homeApi";

const SAVE_KEY = ["home-view-save"];

/**
 * Home as it will be once `repos` are saved: the view lists them, and the
 * rows of repos taken out go, as the server will drop them (a started PR
 * stays: Home lists those from any repo). Rows of added repos come with
 * the server's answer.
 */
export function pendingView(home: HomeView, repos: string[]): HomeView {
	const inView = new Set(repos.map((r) => r.toLowerCase()));
	return {
		...home,
		view: { ...home.view, repos },
		sections: home.sections.map((s) => ({
			...s,
			rows: s.rows.filter(
				(r) =>
					r.reviews.length > 0 ||
					inView.has(`${r.owner}/${r.repo}`.toLowerCase()),
			),
		})),
	};
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
	/** The last save refused (or failing STALL_ATTEMPTS times in a row). */
	failed: { repos: string[]; error: Error } | null;
	retry(): void;
	dismiss(): void;
}

/**
 * Saving the view's repos the way the rest of carbonless saves: the new view
 * shows at once, and the save goes on behind it. Saves go one at a time, in
 * order. A transient failure (crb unreachable, a timeout, a 5xx) retries
 * with the review state's backoff, a PUT of the whole list being safe to
 * repeat, up to STALL_ATTEMPTS; a refusal, or that many transient
 * failures, shows why (red, Retry) and Home goes back to the last saved
 * view. Nothing refused is sent again on its own.
 */
export function useViewSave(): ViewSave {
	const client = useQueryClient();
	const [failed, setFailed] = useState<ViewSave["failed"]>(null);
	const mutation = useMutation({
		mutationKey: SAVE_KEY,
		scope: { id: "home-view-save" },
		mutationFn: (repos: string[]) => putView(repos),
		retry: (count, error) => isTransient(error) && count < STALL_ATTEMPTS,
		retryDelay: (attempt) =>
			RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 1000,
		onMutate: () => {
			setFailed(null);
		},
		onSuccess: async (answer) => {
			// A read of the old view still out mustn't land after the answer.
			await client.cancelQueries({ queryKey: homeQuery.queryKey });
			client.setQueryData(homeQuery.queryKey, answer);
		},
		onError: (error, repos) => {
			setFailed({ repos, error });
			void client.invalidateQueries({ queryKey: homeQuery.queryKey });
		},
	});
	const pending = useMutationState({
		filters: { mutationKey: SAVE_KEY, status: "pending" },
		select: (m) => ({
			repos: m.state.variables as string[],
			since: m.state.submittedAt,
			reason: m.state.failureReason,
		}),
	});
	const first = pending[0];
	const latest = pending.at(-1);
	const delayed = useDelayed(first?.since ?? null);
	const reason = pending.findLast((p) => p.reason)?.reason;
	return {
		save: (repos) => mutation.mutate(repos),
		shown: (home) => (latest ? pendingView(home, latest.repos) : home),
		saving: pending.length > 0,
		delayed,
		waiting: reason ? waitReason(reason) : null,
		failed,
		retry: () => {
			if (failed) mutation.mutate(failed.repos);
		},
		dismiss: () => setFailed(null),
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
							{button("Retry saving", "Retry", SyncIcon, save.retry)}
							{button("Dismiss", "Dismiss", XIcon, save.dismiss)}
						</div>
					}
				/>
			)}
			<div role="status">
				{save.saving && save.delayed && (
					<DelayedNotice
						what={`Saving ${props.name}…`}
						waiting={save.waiting}
					/>
				)}
			</div>
		</div>
	);
}
