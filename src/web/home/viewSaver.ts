import type { QueryClient } from "@tanstack/react-query";
import type { HomeView } from "../../shared/home";
import {
	isTransient,
	RETRY_DELAYS_MS,
	STALL_ATTEMPTS,
	waitReason,
} from "../files/stateSync";
import { homeQuery, putView, repoKey } from "./homeApi";

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

	/**
	 * Sends at once: the refused list again, or the waiting one now, its
	 * attempts counted afresh (StateSync.retry): not red, backoff from 1 s.
	 */
	retry = () => {
		const { refused } = this.#state;
		if (refused) return this.save(refused.repos);
		this.#failures = 0;
		this.#set({ stalled: null });
		this.#kick();
	};

	dismiss = () => this.#set({ refused: null });

	#kick() {
		if (this.#out || this.#state.intended === null) return;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		void this.#send(this.#state.intended, this.#version);
	}

	async #send(repos: string[], version: number) {
		this.#out = true;
		try {
			await this.#deps.stored(await this.#deps.put(repos));
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

const savers = new WeakMap<QueryClient, ViewSaver>();

/**
 * The view saver of a query client: one per page, like the review
 * state's (stateSyncFor), so the unsaved guard sees it and no saver
 * outlives Home to send an older list over a newer one.
 */
export function viewSaverFor(client: QueryClient): ViewSaver {
	let saver = savers.get(client);
	if (!saver) {
		saver = new ViewSaver({
			put: putView,
			stored: async (answer) => {
				// A read of the old view still out mustn't land after the answer.
				await client.cancelQueries({ queryKey: homeQuery.queryKey });
				const before = new Set(
					client.getQueryData(homeQuery.queryKey)?.view.repos ?? [],
				);
				// An added repo is read now, even one still cached from before
				// it was removed (its rows show meanwhile): its query starts
				// once the view says it's saved (HomePage).
				for (const name of answer.view.repos) {
					if (!before.has(name)) {
						void client.invalidateQueries(
							{ queryKey: repoKey(name) },
							{ cancelRefetch: false },
						);
					}
				}
				client.setQueryData(homeQuery.queryKey, answer);
			},
			refused: () => {
				void client.invalidateQueries({ queryKey: homeQuery.queryKey });
			},
		});
		savers.set(client, saver);
	}
	return saver;
}
