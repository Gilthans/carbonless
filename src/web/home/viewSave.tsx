import { SyncIcon, XIcon } from "@primer/octicons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
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

interface SaveState {
	/** The newest repos asked for and not yet stored; null when none. */
	intended: string[] | null;
	/** When the view first had an unsaved change (Date.now()). */
	since: number | null;
	/** Why it waits: the last transient failure, in a few words. */
	waiting: string | null;
	/** The last transient failure once STALL_ATTEMPTS in a row failed. */
	stalled: Error | null;
	/** The last save the server refused; the view went back. */
	refused: { repos: string[]; error: Error } | null;
}

const IDLE: SaveState = {
	intended: null,
	since: null,
	waiting: null,
	stalled: null,
	refused: null,
};

interface SaverDeps {
	put: (repos: string[]) => Promise<HomeView>;
	/** A save's answer: what the server stores now. */
	stored: (view: HomeView) => void | Promise<void>;
	/** A save was refused: Home goes back to the last saved view. */
	refused: () => void;
}

/**
 * Saves the view's repos as the review state's sync (StateSync) saves:
 * the newest list is what's meant, one PUT at a time; a PUT superseded
 * while out isn't sent again, the newest goes next. Transient failures
 * (crb unreachable, a timeout, a 5xx) retry with RETRY_DELAYS_MS, the last
 * repeating, for as long as it takes (a PUT of the whole list is safe to
 * repeat), red after STALL_ATTEMPTS in a row; they never roll the view
 * back. A refusal puts the last saved view back and is never sent again
 * on its own (Retry). A newer save clears an older refusal.
 */
export class ViewSaver {
	readonly #deps: SaverDeps;
	#state: SaveState = IDLE;
	readonly #listeners = new Set<() => void>();
	/** Grows with every save: an answer settles only the save it sent. */
	#version = 0;
	#out = false;
	#failures = 0;
	#timer: ReturnType<typeof setTimeout> | null = null;

	constructor(deps: SaverDeps) {
		this.#deps = deps;
	}

	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	snapshot = () => this.#state;

	#set(change: Partial<SaveState>) {
		this.#state = { ...this.#state, ...change };
		for (const l of this.#listeners) l();
	}

	save = (repos: string[]) => {
		this.#version++;
		this.#set({
			intended: repos,
			since: this.#state.since ?? Date.now(),
			refused: null,
		});
		this.#kick();
	};

	/** Sends at once: the refused list again, or the waiting one now. */
	retry = () => {
		const { refused } = this.#state;
		if (refused) return this.save(refused.repos);
		this.#kick();
	};

	dismiss = () => this.#set({ refused: null });

	/** Stops a scheduled retry (the page went); resume() picks it up. */
	pause() {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
	}

	resume() {
		this.#kick();
	}

	#kick() {
		if (this.#out || this.#state.intended === null) return;
		this.pause();
		void this.#send(this.#state.intended, this.#version);
	}

	async #send(repos: string[], version: number) {
		this.#out = true;
		let answer: HomeView;
		try {
			answer = await this.#deps.put(repos);
		} catch (error) {
			this.#out = false;
			if (version !== this.#version) return this.#kick();
			if (isTransient(error)) {
				this.#failures++;
				this.#set({
					waiting: waitReason(error),
					stalled:
						this.#failures >= STALL_ATTEMPTS
							? error instanceof Error
								? error
								: new Error(String(error))
							: null,
				});
				const wait =
					RETRY_DELAYS_MS[
						Math.min(this.#failures - 1, RETRY_DELAYS_MS.length - 1)
					] ?? 1000;
				this.#timer = setTimeout(() => {
					this.#timer = null;
					this.#kick();
				}, wait);
				return;
			}
			this.#failures = 0;
			this.#set({
				...IDLE,
				refused: {
					repos,
					error: error instanceof Error ? error : new Error(String(error)),
				},
			});
			this.#deps.refused();
			return;
		}
		await this.#deps.stored(answer);
		this.#out = false;
		this.#failures = 0;
		if (version === this.#version) {
			this.#set({ ...IDLE, refused: this.#state.refused });
		} else {
			this.#set({ waiting: null, stalled: null });
			this.#kick();
		}
	}
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
	const [saver] = useState(
		() =>
			new ViewSaver({
				put: putView,
				stored: async (answer) => {
					// A read of the old view still out mustn't land after the answer.
					await client.cancelQueries({ queryKey: homeQuery.queryKey });
					client.setQueryData(homeQuery.queryKey, answer);
				},
				refused: () => {
					void client.invalidateQueries({ queryKey: homeQuery.queryKey });
				},
			}),
	);
	useEffect(() => {
		saver.resume();
		return () => saver.pause();
	}, [saver]);
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
