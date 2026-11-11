/** How many times a count is tried before its failure is the answer. */
export const COUNT_TRIES = 3;
/** The wait before try n+1 (ms): 5 s, then 30 s. */
const BACKOFF_MS = [5_000, 30_000];

/** A count's answer: the number, null while it runs (or waits), or why it failed. */
export type CountAnswer = number | null | { error: string };

interface Entry {
	value: number | null;
	running: boolean;
	tries: number;
	retryAt: number;
	error: string | null;
}

/**
 * Counts made in the background, once per key, never waited for: `get`
 * starts one on the first ask and answers null until it is in. A failure
 * is tried again after a backoff, and after COUNT_TRIES failures its
 * error is the answer for good (nothing spawns again).
 */
export class BackgroundCounts {
	readonly #entries = new Map<string, Entry>();

	constructor(
		private readonly count: (key: string) => Promise<number>,
		private readonly now: () => number = Date.now,
	) {}

	get(key: string): CountAnswer {
		let e = this.#entries.get(key);
		if (e?.value != null) return e.value;
		if (e?.error !== null && e && e.tries >= COUNT_TRIES) {
			return { error: e.error };
		}
		if (e?.running || (e && this.now() < e.retryAt)) return null;
		if (!e) {
			e = { value: null, running: false, tries: 0, retryAt: 0, error: null };
			this.#entries.set(key, e);
		}
		const entry = e;
		entry.running = true;
		entry.tries += 1;
		this.count(key).then(
			(n) => {
				entry.running = false;
				entry.value = n;
			},
			(error: unknown) => {
				entry.running = false;
				entry.error = error instanceof Error ? error.message : String(error);
				entry.retryAt =
					this.now() + (BACKOFF_MS[entry.tries - 1] ?? BACKOFF_MS.at(-1) ?? 0);
			},
		);
		return null;
	}
}
