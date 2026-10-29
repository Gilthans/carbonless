import { cacheDir } from "./paths.js";
import type { HeadSpec } from "./pinnedHead.js";
import { findReviewById } from "./review/reviews.js";
import { Session, SessionClosedError } from "./session.js";

/** What opens a review: today's `crb <pr>` arguments. */
export interface OpenRequest {
	/** A PR URL, `owner/repo#n`, or `n` (resolved against `cwd`). */
	pr: string;
	cwd?: string;
	head?: HeadSpec;
	asOf?: string;
	viewer?: string;
}

/** No clone in the cache has a review by this id (HTTP 404). */
export class UnknownReviewError extends Error {}

interface Entry {
	session: Session;
	lastUsed: number;
	/** The --viewer it was opened with (dev mode). */
	viewer: string | undefined;
}

const IDLE_MS = 30 * 60_000;
const REVIEW_ID = /^[0-9a-hjkmnp-tv-z]{26}$/;

/**
 * The server's open reviews, by review id. A review opens on the first
 * request that needs it (by its PR, or by id from the refs: a bookmark
 * after a restart) and closes after `idleMs` without one. Nothing here is
 * state: the clone and the refs hold it, so closing loses nothing.
 */
export class SessionRegistry {
	readonly #idleMs: number;
	readonly #now: () => number;
	readonly #open = new Map<string, Entry>();
	/** Opens under way, by request. */
	readonly #opening = new Map<
		string,
		Promise<{ id: string; session: Session }>
	>();
	/** Which review each request opened: a repeat needs no read of GitHub. */
	readonly #idOf = new Map<string, string>();
	/** Opens by id under way. */
	readonly #reopening = new Map<string, Promise<Session>>();
	readonly #timer: NodeJS.Timeout;
	#closed = false;

	constructor(options: { idleMs?: number; now?: () => number } = {}) {
		this.#idleMs = options.idleMs ?? IDLE_MS;
		this.#now = options.now ?? Date.now;
		this.#timer = setInterval(
			() => void this.sweep(),
			Math.min(this.#idleMs, 60_000),
		);
		this.#timer.unref();
	}

	/**
	 * The review for `req`, opened unless it already is. `progress` gets the
	 * slow startup steps (cloning, fetching) of an open.
	 */
	open(
		req: OpenRequest,
		progress?: (m: string) => void,
	): Promise<{ id: string; session: Session }> {
		if (this.#closed) {
			return Promise.reject(new SessionClosedError("The server is closing"));
		}
		const key = JSON.stringify([
			req.pr,
			req.cwd ?? null,
			req.head ?? null,
			req.asOf ?? null,
			req.viewer ?? null,
		]);
		const known = this.#idOf.get(key);
		const entry = known === undefined ? undefined : this.#open.get(known);
		if (known !== undefined && entry) {
			entry.lastUsed = this.#now();
			return Promise.resolve({ id: known, session: entry.session });
		}
		const pending = this.#opening.get(key);
		if (pending) return pending;
		const run = (async () => {
			const session = await Session.open(
				req.pr,
				req.cwd ?? process.cwd(),
				progress,
				{ head: req.head, asOf: req.asOf, viewer: req.viewer },
			);
			const kept = this.#keep(session, req.viewer);
			this.#idOf.set(key, kept.id);
			return { id: kept.id, session: kept };
		})();
		this.#opening.set(key, run);
		const forget = () => this.#opening.delete(key);
		run.then(forget, forget);
		return run;
	}

	/**
	 * Keeps `session` as its review's. Another request form of a review
	 * already open (a URL, then owner/repo#n) keeps the one open; another
	 * --viewer (dev mode) replaces it.
	 */
	#keep(session: Session, viewer: string | undefined): Session {
		const existing = this.#open.get(session.id);
		if (this.#closed) {
			void session.close();
			throw new SessionClosedError("The server is closing");
		}
		if (existing && !existing.session.closed && existing.viewer === viewer) {
			void session.close();
			existing.lastUsed = this.#now();
			return existing.session;
		}
		if (existing) void existing.session.close();
		this.#open.set(session.id, { session, lastUsed: this.#now(), viewer });
		return session;
	}

	/**
	 * The review `id`: the open one, or opened from the refs of the cache's
	 * clone that holds it. UnknownReviewError when none does.
	 */
	async get(id: string): Promise<Session> {
		if (this.#closed) throw new SessionClosedError("The server is closing");
		await this.sweep();
		const entry = this.#open.get(id);
		if (entry) {
			entry.lastUsed = this.#now();
			return entry.session;
		}
		if (!REVIEW_ID.test(id)) throw new UnknownReviewError(`No review ${id}`);
		const pending = this.#reopening.get(id);
		if (pending) return pending;
		const run = (async () => {
			const found = await findReviewById(cacheDir(), id);
			if (!found) throw new UnknownReviewError(`No review ${id}`);
			const { pr, head, asOf } = found.review;
			const { session } = await this.open({
				pr: `${pr.owner}/${pr.repo}#${pr.number}`,
				...(head ? { head: { kind: "sha", prefix: head } } : {}),
				...(asOf ? { asOf } : {}),
			});
			if (session.id !== id) {
				throw new UnknownReviewError(
					`Review ${id} is no longer the one of ${pr.owner}/${pr.repo}#${pr.number}`,
				);
			}
			return session;
		})();
		this.#reopening.set(id, run);
		const forget = () => this.#reopening.delete(id);
		run.then(forget, forget);
		return run;
	}

	/** Closes the sessions idle for longer than idleMs. */
	async sweep(): Promise<void> {
		const now = this.#now();
		const idle = [...this.#open].filter(
			([, e]) => now - e.lastUsed > this.#idleMs || e.session.closed,
		);
		for (const [id] of idle) this.#open.delete(id);
		await Promise.all(idle.map(([, e]) => e.session.close()));
	}

	/** Closes every session (shutdown); opens under way close as they finish. */
	async closeAll(): Promise<void> {
		this.#closed = true;
		clearInterval(this.#timer);
		const opening = [...this.#opening.values(), ...this.#reopening.values()];
		await Promise.allSettled(opening);
		const all = [...this.#open.values()];
		this.#open.clear();
		await Promise.all(all.map((e) => e.session.close()));
	}
}
