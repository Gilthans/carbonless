import {
	type CodeWindow,
	type PrOverview,
	type ReviewThread,
	THREADS_FIRST,
	type ThreadsStage,
	type ThreadsView,
} from "../shared/types.js";
import {
	fetchOverview,
	fetchThreadContents,
	fetchThreadSummaries,
	NODE_ID,
	type PrRef,
} from "./gh.js";
import { mapThreads, withContent } from "./overview.js";
import type { DiffBase, ThreadCodeSource } from "./threadCode.js";

/** What a read reads from, and where its thread code comes from. */
export interface ReadSources {
	ref: PrRef;
	viewer: string;
	/** As-of mode: the cutoff, and the snapshot head whose checks to show. */
	asOf?: { at: string; head: string };
	code: ThreadCodeSource;
	/** The thread code's diff base, once known (a Refresh moves the snapshot). */
	base: () => Promise<DiffBase>;
}

/** Thread code built at once. */
const CODE_CONCURRENCY = 8;

/** A thread GitHub no longer has (deleted since the list was read). */
const GONE = Symbol("gone");

/** The opening comment's GitHub diff hunk in a content node, or "". */
function hunkOf(content: unknown): string {
	const first = (content as { first?: { nodes?: { diffHunk?: unknown }[] } })
		?.first?.nodes?.[0];
	return typeof first?.diffHunk === "string" ? first.diffHunk : "";
}

let sequence = 0;

/**
 * One read of the PR from GitHub, in parts that arrive at their own pace so
 * the page never waits for the slowest: the overview (a few calls at once,
 * well under a second), then the review threads: every thread's summary
 * first (lists, counts and card headers), then the opening comments' text,
 * those listed first (THREADS_FIRST per list) ahead of the rest, and each
 * thread's code from the clone. Everything starts at once; `threads(stage)`
 * waits for a stage and gives all that is in by then.
 */
export class OverviewRead {
	readonly id = `${Date.now().toString(36)}.${++sequence}`;
	readonly started = Date.now();
	/** When the overview part came in; null while it is read. */
	ended: number | null = null;
	readonly overview: Promise<Omit<PrOverview, "servedAt">>;
	readonly #asOf: string | undefined;
	/** Summary nodes, then with their content merged in as it arrives. */
	#nodes: unknown[] = [];
	readonly #contents = new Map<string, unknown>();
	readonly #codes = new Map<string, CodeWindow | null>();
	readonly #stages: Record<ThreadsStage, Promise<void>>;
	/** Stops its gh calls (abort). */
	readonly #stop = new AbortController();
	/** Once every part has come in or failed: nothing of it runs any more. */
	readonly settled: Promise<void>;

	constructor(sources: ReadSources) {
		this.#asOf = sources.asOf?.at;
		const read = { signal: this.#stop.signal };
		this.overview = fetchOverview(
			sources.ref,
			sources.viewer,
			sources.asOf,
			read,
		).then((fields) => {
			this.ended = Date.now();
			return {
				...fields,
				readId: this.id,
				fetchedAt: new Date(this.ended).toISOString(),
			};
		});
		const summary = fetchThreadSummaries(sources.ref, read).then((nodes) => {
			this.#nodes = nodes;
		});
		// Threads with code, listed-first ones ahead, and which those are.
		const plan = summary.then(() => {
			const threads = this.#map();
			const first = new Set(listedFirst(threads).map((t) => t.id));
			// A thread without a well-formed id can't be read by it (#view).
			const readable = threads.filter((t) => NODE_ID.test(t.id));
			const ids = readable.map((t) => t.id);
			return {
				first: ids.filter((id) => first.has(id)),
				rest: ids.filter((id) => !first.has(id)),
				coded: [
					...readable.filter((t) => t.code && first.has(t.id)),
					...readable.filter((t) => t.code && !first.has(t.id)),
				],
			};
		});
		const readText = (ids: string[]) =>
			fetchThreadContents(ids, read).then((found) => {
				// Not returned, or null: GitHub no longer has the thread.
				for (const id of ids) this.#contents.set(id, found.get(id) ?? GONE);
			});
		const firstText = plan.then((p) => readText(p.first));
		const restText = plan.then((p) => readText(p.rest));
		// Each thread's code, a few at a time, listed-first ones ahead.
		const codes = plan.then((p) => {
			const limit = limiter(CODE_CONCURRENCY);
			const firstIds = new Set(p.first);
			const textOf = (id: string) =>
				(firstIds.has(id) ? firstText : restText).then(() =>
					this.#contents.get(id),
				);
			// The clone's part a few at a time; waiting for the text (GitHub's
			// hunk, to check the code against) holds no slot.
			const tasks = p.coded.map((t) => ({
				first: firstIds.has(t.id),
				done: limit(() => this.#warm(sources, t)).then(() =>
					this.#code(sources, t, textOf),
				),
			}));
			return {
				first: Promise.all(tasks.filter((t) => t.first).map((t) => t.done)),
				all: Promise.all(tasks.map((t) => t.done)),
			};
		});
		const done = () => {};
		this.#stages = {
			summary,
			first: firstText,
			firstCode: Promise.all([firstText, codes.then((c) => c.first)]).then(
				done,
			),
			full: Promise.all([firstText, restText, codes.then((c) => c.all)]).then(
				done,
			),
		};
		// Each is awaited by whoever asks; none may go unhandled.
		for (const stage of Object.values(this.#stages)) stage.catch(() => {});
		this.overview.catch(() => {});
		this.settled = Promise.allSettled([
			this.overview,
			firstText,
			restText,
			codes.then((c) => c.all),
		]).then(done);
	}

	/** Stops its reads of GitHub (the session closing); see `settled`. */
	abort(): void {
		this.#stop.abort();
	}

	/** The threads once `stage` is in, with all that is in by then. */
	async threads(stage: ThreadsStage): Promise<ThreadsView> {
		await this.#stages[stage];
		return this.#view();
	}

	/** Every thread, its content merged in where it has arrived. */
	#map(): ReviewThread[] {
		const nodes = this.#nodes.map((node) => {
			const id = (node as { id?: unknown })?.id;
			const content =
				typeof id === "string" ? this.#contents.get(id) : undefined;
			return content && content !== GONE ? withContent(node, content) : node;
		});
		return mapThreads(nodes, this.#asOf);
	}

	#view(): ThreadsView {
		let complete = true;
		const threads = this.#map().map((t): ReviewThread => {
			// Never coming: said so on the card, not a frame forever.
			if (!NODE_ID.test(t.id)) {
				return { ...t, loaded: true, unavailable: "unreadable", code: null };
			}
			if (this.#contents.get(t.id) === GONE) {
				t = { ...t, loaded: true, unavailable: "deleted" };
			}
			if (!t.loaded) complete = false;
			if (!t.code) return t;
			if (this.#codes.has(t.id))
				return { ...t, code: this.#codes.get(t.id) ?? null };
			complete = false;
			// GitHub's hunk shows only once the clone has said no: no swap.
			return {
				...t,
				code: { anchor: t.code.anchor, rows: [], source: "pending" as const },
			};
		});
		return { threads, complete };
	}

	/**
	 * Builds a thread's code from the clone into the source's caches, so
	 * #code then reads the clone only for a fallback.
	 */
	async #warm(sources: ReadSources, thread: ReviewThread): Promise<void> {
		if (!thread.code) return;
		await sources.code.window(thread.code.anchor, await sources.base());
	}

	/**
	 * A thread's code (ThreadCodeSource.code), checked against GitHub's
	 * hunk from the thread's content (or that hunk, when the clone can't).
	 */
	async #code(
		sources: ReadSources,
		thread: ReviewThread,
		textOf: (id: string) => Promise<unknown>,
	): Promise<void> {
		if (!thread.code) return;
		const code = await sources.code.code(
			thread.code.anchor,
			await sources.base(),
			async () => hunkOf(await textOf(thread.id)),
		);
		this.#codes.set(thread.id, code);
	}
}

/**
 * The threads each list shows first and one "Load more" page: per opener
 * kind (bot or human) and resolution, the first THREADS_FIRST in order.
 */
export function listedFirst(threads: ReviewThread[]): ReviewThread[] {
	const taken = new Map<string, number>();
	return threads.filter((t) => {
		const list = `${t.bot} ${t.resolved}`;
		const n = taken.get(list) ?? 0;
		taken.set(list, n + 1);
		return n < THREADS_FIRST;
	});
}

/** Runs the tasks given to it at most `max` at a time, in the order given. */
export function limiter(max: number) {
	let running = 0;
	const queue: (() => void)[] = [];
	const next = () => {
		if (running >= max) return;
		const start = queue.shift();
		if (start) start();
	};
	return <T>(task: () => Promise<T>): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			queue.push(() => {
				running++;
				task()
					.then(resolve, reject)
					.finally(() => {
						running--;
						next();
					});
			});
			next();
		});
}
