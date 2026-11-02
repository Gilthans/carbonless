import {
	type CodeWindow,
	type CommentsView,
	type PrOverview,
	type ReviewThread,
	THREADS_FIRST,
	type ThreadComments,
	type ThreadsStage,
	type ThreadsView,
	type TimelineView,
} from "../shared/types.js";
import { GhError } from "./errors.js";
import {
	fetchOverview,
	fetchThreadContents,
	fetchThreadSummaries,
	fetchTimeline,
	NODE_ID,
	type PrRef,
} from "./gh.js";
import { mapComments, mapThreads, openerOf, withContent } from "./overview.js";
import type { DiffBase, ThreadCodeSource } from "./threadCode.js";
import { buildTimeline } from "./timeline.js";

/** What a read reads from, and where its thread code comes from. */
export interface ReadSources {
	ref: PrRef;
	viewer: string;
	/** As-of mode: the cutoff, and the snapshot head whose checks to show. */
	asOf?: { at: string; head: string };
	/** Whether this session writes to GitHub (PrOverview.writes). */
	writes: PrOverview["writes"];
	code: ThreadCodeSource;
	/** The thread code's diff base, once known (a Refresh moves the snapshot). */
	base: () => Promise<DiffBase>;
}

/** A read's overview: the session adds what isn't GitHub's read (commentLeft). */
export type ReadOverview = Omit<PrOverview, "servedAt" | "commentLeft">;

/** Thread code built at once. */
const CODE_CONCURRENCY = 8;

/** A thread GitHub no longer has (deleted since the list was read). */
const GONE = Symbol("gone");

/** The opening comment's GitHub diff hunk in a content node, or "". */
function hunkOf(content: unknown): string {
	const hunk = openerOf(content).diffHunk;
	return typeof hunk === "string" ? hunk : "";
}

let sequence = 0;

/**
 * One read of the PR from GitHub, in parts that arrive at their own pace so
 * the page never waits for the slowest: the overview (a few calls at once,
 * well under a second), then the review threads: every thread's summary
 * first (lists, counts, card headers and attention sets), then every
 * comment's text, those listed first (THREADS_FIRST per list) ahead of the
 * rest, and each thread's code from the clone. Everything starts at once;
 * `threads(stage)` waits for a stage and gives all that is in by then, and
 * `comments(ids)` gives threads' comments as soon as they are in, reading
 * any not on their way yet at once.
 */
export class OverviewRead {
	readonly id = `${Date.now().toString(36)}.${++sequence}`;
	readonly started = Date.now();
	/** When the overview part came in; null while it is read. */
	ended: number | null = null;
	#overview: Promise<ReadOverview>;
	get overview(): Promise<ReadOverview> {
		return this.#overview;
	}
	/**
	 * The PR's timeline: its own read, at once with the rest, its review
	 * comments tied to their threads once the summaries are in.
	 */
	readonly timeline: Promise<TimelineView>;
	readonly #asOf: string | undefined;
	readonly #viewer: string;
	readonly #writes: boolean;
	/**
	 * Threads as a write left them (its re-read of the thread): they stand
	 * in for this read's own summary and content, whenever those arrive.
	 */
	readonly #written = new Map<
		string,
		{ summary: unknown; content: unknown; seq: number }
	>();
	/**
	 * Threads a write started (addThread), listed from then on even when
	 * this read's own list doesn't have them.
	 */
	readonly #added: string[] = [];
	readonly #sources: ReadSources;
	/**
	 * Threads a write deleted the last comment of (by the re-read's seq):
	 * left out of the lists, their comments "deleted".
	 */
	readonly #dropped = new Map<string, number>();
	/** The PR author (the overview's), once the summary is in. */
	#prAuthor = "";
	/** Summary nodes, then with their content merged in as it arrives. */
	#nodes: unknown[] = [];
	readonly #contents = new Map<string, unknown>();
	/** Content reads under way, by thread id: a request for one joins it. */
	readonly #reading = new Map<string, Promise<void>>();
	/** Reads a thread's content now (`comments`); set once the read starts. */
	readonly #readText: (ids: string[]) => Promise<void>;
	/** Once the background content reads have started (all in `#reading`). */
	readonly #textsStarted: Promise<unknown>;
	readonly #codes = new Map<string, CodeWindow | null>();
	readonly #stages: Record<ThreadsStage, Promise<void>>;
	/** Stops its gh calls (abort). */
	readonly #stop = new AbortController();
	/** Once every part has come in or failed: nothing of it runs any more. */
	readonly settled: Promise<void>;

	constructor(sources: ReadSources) {
		this.#sources = sources;
		this.#asOf = sources.asOf?.at;
		this.#viewer = sources.viewer;
		this.#writes = sources.writes === "on";
		const read = { signal: this.#stop.signal };
		this.#overview = fetchOverview(
			sources.ref,
			sources.viewer,
			sources.asOf,
			read,
		).then((fields) => {
			this.ended = Date.now();
			return {
				...fields,
				writes: sources.writes,
				readId: this.id,
				fetchedAt: new Date(this.ended).toISOString(),
			};
		});
		// The attention sets need the PR author: the overview is the faster read.
		const summary = Promise.all([
			fetchThreadSummaries(sources.ref, read),
			this.overview,
		]).then(([nodes, overview]) => {
			this.#nodes = nodes;
			this.#prAuthor = overview.author;
		});
		this.timeline = Promise.all([
			fetchTimeline(sources.ref, read),
			// Without the threads, review comments just aren't tied to them.
			summary.then(
				() => true,
				() => false,
			),
		]).then(([timeline, tied]) =>
			buildTimeline({
				...timeline,
				asOf: this.#asOf,
				threadOf: tied ? threadsByComment(this.#nodes) : undefined,
			}),
		);
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
		const readText = (ids: string[]): Promise<void> => {
			const reading = fetchThreadContents(ids, read).then((found) => {
				// Not returned, or null: GitHub no longer has the thread.
				for (const id of ids) this.#contents.set(id, found.get(id) ?? GONE);
			});
			for (const id of ids) this.#reading.set(id, reading);
			const over = () => {
				for (const id of ids) {
					if (this.#reading.get(id) === reading) this.#reading.delete(id);
				}
			};
			reading.then(over, over);
			return reading;
		};
		this.#readText = readText;
		const texts = plan.then((p) => ({
			first: readText(p.first),
			rest: readText(p.rest),
		}));
		this.#textsStarted = texts;
		const firstText = texts.then((t) => t.first);
		const restText = texts.then((t) => t.rest);
		// Each thread's code, a few at a time, listed-first ones ahead.
		const codes = plan.then((p) => {
			const limit = limiter(CODE_CONCURRENCY);
			const firstIds = new Set(p.first);
			const textOf = (id: string) =>
				(firstIds.has(id) ? firstText : restText).then(() =>
					this.#contents.get(id),
				);
			// Every clone read a few at a time: the build, then (once the text,
			// with GitHub's hunk to check against, is in) the check and any
			// fallback. Waiting for the text holds no slot. A text that fails
			// counts as no hunk (ThreadCodeSource.code).
			const tasks = p.coded.map((t) => ({
				first: firstIds.has(t.id),
				done: limit(() => this.#warm(sources, t))
					.then(() => textOf(t.id).catch(() => {}))
					.then(() => limit(() => this.#code(sources, t, textOf))),
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
		this.timeline.catch(() => {});
		this.settled = Promise.allSettled([
			this.overview,
			this.timeline,
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

	/**
	 * Thread `id` as a write's re-read, started at `startedAt` (ms), found
	 * it. Ignored by a read that started later (its own data is fresher),
	 * and when a later re-read (`seq`) was applied already. Only a thread
	 * this read lists is shown; one it doesn't is kept in case its summary
	 * is still to come.
	 */
	applyWrite(
		id: string,
		nodes: { summary: unknown; content: unknown },
		seq: number,
		startedAt: number,
	): void {
		if (this.started > startedAt) return;
		const prev = this.#written.get(id);
		if (prev && prev.seq > seq) return;
		if ((this.#dropped.get(id) ?? -1) > seq) return;
		this.#dropped.delete(id);
		this.#written.set(id, { ...nodes, seq });
	}

	/**
	 * Thread `id` as a write GitHub just took leaves it, before any re-read:
	 * `edit` of the thread as this read has it now (its content undefined
	 * while not in), by applyWrite's rules (`seq`, `startedAt`). A later
	 * re-read replaces it. Nothing for a thread this read doesn't list.
	 */
	applyKnown(
		id: string,
		edit: (nodes: { summary: unknown; content: unknown }) => {
			summary: unknown;
			content: unknown;
		},
		seq: number,
		startedAt: number,
	): void {
		if (this.started > startedAt) return;
		const prev = this.#written.get(id);
		if (prev && prev.seq > seq) return;
		if (this.#dropped.has(id)) return;
		const summary = this.summaryOf(id);
		if (summary === undefined) return;
		const content = this.#content(id);
		const next = edit({
			summary,
			content: content === GONE ? undefined : content,
		});
		// Undefined content: this read's own, once it comes in.
		this.#written.set(id, { ...next, seq });
	}

	/**
	 * Thread `id`, which a write started, as its re-read found it
	 * (applyWrite's rules): listed from then on, its code built.
	 */
	addThread(
		id: string,
		nodes: { summary: unknown; content: unknown },
		seq: number,
		startedAt: number,
	): void {
		if (this.started > startedAt) return;
		this.applyWrite(id, nodes, seq, startedAt);
		// A later write's re-read of it may stand in already: listed all the same.
		if (!this.#added.includes(id)) this.#added.push(id);
		const code = this.#stages.summary.then(() => {
			const thread = this.#map().find((t) => t.id === id);
			if (!thread?.code) return;
			return this.#code(this.#sources, thread, async () => this.#content(id));
		});
		code.catch(() => {});
	}

	/** Whether a write dropped thread `id` (dropThread). */
	dropped(id: string): boolean {
		return this.#dropped.has(id);
	}

	/**
	 * Thread `id` gone, as a write's re-read (`seq`, started at `startedAt`
	 * ms) found it after deleting its last comment: ignored like
	 * applyWrite's re-reads.
	 */
	dropThread(id: string, seq: number, startedAt: number): void {
		if (this.started > startedAt) return;
		const prev = this.#written.get(id);
		if (prev && prev.seq > seq) return;
		this.#written.delete(id);
		this.#dropped.set(id, seq);
	}

	/**
	 * Thread `id`'s summary and content as this read has them (a write's,
	 * if any); undefined while either isn't in, or GitHub no longer has it.
	 */
	cached(id: string): { summary: unknown; content: unknown } | undefined {
		const summary = this.summaryOf(id);
		const content = this.#content(id);
		if (summary === undefined || content === undefined || content === GONE) {
			return undefined;
		}
		return { summary, content };
	}

	/**
	 * Sets the overview's pendingReview, as a write found it (a 409 turns
	 * it on, a posted reply off), until the next read.
	 */
	setPendingReview(pending: { url: string } | null): void {
		const next = this.#overview.then((o) => ({ ...o, pendingReview: pending }));
		next.catch(() => {});
		this.#overview = next;
	}

	/** Thread `id`'s summary node as this read has it (a write's, if any). */
	summaryOf(id: string): unknown {
		if (this.#dropped.has(id)) return undefined;
		const written = this.#written.get(id);
		if (written) return written.summary;
		return this.#nodes.find((n) => (n as { id?: unknown })?.id === id);
	}

	/** A thread's summary node, a write's in place of this read's. */
	#summary(node: unknown): unknown {
		const id = (node as { id?: unknown })?.id;
		return (typeof id === "string" && this.#written.get(id)?.summary) || node;
	}

	/** A thread's content as in (a write's first), GONE, or undefined. */
	#content(id: string): unknown {
		if (this.#dropped.has(id)) return GONE;
		return this.#written.get(id)?.content ?? this.#contents.get(id);
	}

	/** This read's thread nodes, and those writes started that it lacks. */
	#all(): unknown[] {
		const idOf = (raw: unknown) => (raw as { id?: unknown })?.id;
		const listed = new Set(this.#nodes.map(idOf));
		const added = this.#added
			.filter((id) => !listed.has(id) && !this.#dropped.has(id))
			.map((id) => this.#written.get(id)?.summary)
			.filter((node) => node !== undefined);
		return [...this.#nodes, ...added];
	}

	/** Every thread, its content merged in where it has arrived. */
	#map(): ReviewThread[] {
		const shown = this.#all().filter((raw) => {
			const id = (raw as { id?: unknown })?.id;
			return typeof id !== "string" || !this.#dropped.has(id);
		});
		const nodes = shown.map((raw) => {
			const node = this.#summary(raw);
			const id = (node as { id?: unknown })?.id;
			const content = typeof id === "string" ? this.#content(id) : undefined;
			return content && content !== GONE ? withContent(node, content) : node;
		});
		return mapThreads(nodes, {
			asOf: this.#asOf,
			prAuthor: this.#prAuthor,
			viewer: this.#viewer,
			writes: this.#writes,
		});
	}

	/**
	 * The comments of the threads with these ids, in the order asked: from
	 * the background read when it has them, joining it when it's on its way,
	 * and reading the others at once (CONTENT_BATCH a query, all at once;
	 * never a query per thread). A read that failed is tried again. Fails
	 * (GhError) rather than give a thread fewer comments than it has. An id
	 * this read's summary doesn't list is "unreadable".
	 */
	async comments(ids: string[]): Promise<CommentsView> {
		await this.#stages.summary;
		await this.#textsStarted.catch(() => {});
		const summaries = new Map<string, unknown>();
		for (const raw of this.#all()) {
			const node = this.#summary(raw);
			const id = (node as { id?: unknown })?.id;
			if (typeof id === "string" && NODE_ID.test(id)) summaries.set(id, node);
		}
		const wanted = [...new Set(ids)].filter((id) => summaries.has(id));
		const pending = () =>
			wanted.filter((id) => this.#content(id) === undefined);
		// Waits for the reads of those not in yet that are on their way.
		const join = () =>
			Promise.all(
				[...new Set(pending().map((id) => this.#reading.get(id)))].map((r) =>
					r?.catch(() => {}),
				),
			);
		await join();
		// Neither in nor on its way (or its read failed): read now, unless
		// another request already does.
		const missing = pending().filter((id) => !this.#reading.has(id));
		const now = missing.length > 0 ? this.#readText(missing) : undefined;
		await join();
		await now;
		if (pending().length > 0) {
			throw new GhError("Couldn't read the review threads' comments");
		}
		return {
			threads: ids.map((threadId): ThreadComments => {
				const summary = summaries.get(threadId);
				const content = this.#content(threadId);
				if (summary === undefined) {
					return { threadId, comments: [], unavailable: "unreadable" };
				}
				if (content === GONE || content === undefined) {
					return { threadId, comments: [], unavailable: "deleted" };
				}
				return {
					threadId,
					...mapComments(summary, content, this.#asOf, this.#writes),
				};
			}),
		};
	}

	#view(): ThreadsView {
		let complete = true;
		const threads = this.#map().map((t): ReviewThread => {
			// Never coming: said so on the card, not a frame forever.
			if (!NODE_ID.test(t.id)) {
				return { ...t, loaded: true, unavailable: "unreadable", code: null };
			}
			if (this.#content(t.id) === GONE) {
				t = { ...t, loaded: true, unavailable: "deleted" };
			}
			if (!t.loaded) complete = false;
			if (!t.code) return t;
			if (this.#codes.has(t.id)) {
				const built = this.#codes.get(t.id) ?? null;
				// Built off the summary: the anchor as now (a span's columns
				// come with the opener's text).
				return {
					...t,
					code: built && { ...built, anchor: t.code.anchor },
				};
			}
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

/** A thread summary's comments' ids, each to its thread's id. */
export function threadsByComment(
	nodes: unknown[],
): (commentId: string) => string | null {
	const map = new Map<string, string>();
	const rec = (v: unknown) =>
		(typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
	const list = (v: unknown) => (Array.isArray(v) ? v : []);
	for (const node of nodes) {
		const t = rec(node);
		if (typeof t.id !== "string" || !t.id) continue;
		for (const c of [
			...list(rec(t.first).nodes),
			...list(rec(t.comments).nodes),
		]) {
			const id = rec(c).id;
			if (typeof id === "string" && id) map.set(id, t.id);
		}
	}
	return (id) => map.get(id) ?? null;
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
