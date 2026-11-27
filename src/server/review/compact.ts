import { runGit } from "../git.js";
import { tracer } from "../trace.js";
import { isSlug, newEvent } from "./events.js";
import { RefConflictError, RefStore } from "./refStore.js";

/*
 * Compaction (docs/review-data-storage.md, "Compaction"): once a review's PR
 * is merged or closed (GitHub's state, principle 7), each of its event refs
 * is rewritten to one root commit holding every event line of its history,
 * verbatim and in the order readers see them now, plus a `compacted` event.
 * The old commits become unreachable; git drops them only when something
 * prunes (crb never does; same doc). Nothing a reader folds can change: the
 * lines are the same lines in the same order, so every fold (coverage,
 * marks, carries, placements, agent threads) gives the same answer.
 */

/** The refs holding events: meta, and each reviewer's progress and agent threads. Never a patch set's pins. */
const EVENT_REF =
	/^refs\/crb\/reviews\/[0-9a-hjkmnp-tv-z]{26}\/(?:meta|reviewers\/([a-z0-9-]{1,64})\/(?:progress|agent\/threads))$/;
const REVIEW_ID = /^[0-9a-hjkmnp-tv-z]{26}$/;

/** Tries per ref: each lost compare-and-swap race reads the new tip and builds again. */
const MAX_TRIES = 5;

interface CompactedRef {
	ref: string;
	/** The tip before. */
	from: string;
	/** The compacted commit now at the ref. */
	to: string;
	/** Commits folded into it. */
	commits: number;
	/** Event lines carried over (exact duplicates dropped). */
	lines: number;
}

export interface CompactOptions {
	/** Test hook: runs after the compacted commit is built, before the ref is swapped. */
	beforeSwap?: (ref: string) => Promise<void>;
}

export interface CompactResult {
	compacted: CompactedRef[];
	/** Refs left as they were because a write kept racing, or their history couldn't be read. */
	skipped: { ref: string; reason: string }[];
}

/**
 * Compacts review `reviewId`'s event refs that hold more than one commit.
 * `actor` (a slug) authors the meta ref's commit; a reviewer's ref keeps
 * its reviewer as author. Each ref is its own compare-and-swap: a write
 * that lands meanwhile makes it build again on the new tip, so no write is
 * lost; past MAX_TRIES the ref is left uncompacted (skipped), never half
 * done. Its git processes don't grow with the review's events, nor with
 * the other reviews in the clone: one for-each-ref, then per ref a log, a
 * commit-tree and an update-ref.
 */
export async function compactReview(
	store: RefStore,
	reviewId: string,
	actor: string,
	options: CompactOptions = {},
): Promise<CompactResult> {
	if (!REVIEW_ID.test(reviewId)) {
		throw new Error(`Invalid review id: ${reviewId}`);
	}
	if (!isSlug(actor)) throw new Error(`Invalid slug: ${actor}`);
	const traced = tracer();
	const span = traced.enabled
		? traced.start("crb: compact review", { review: reviewId })
		: null;
	const result: CompactResult = { compacted: [], skipped: [] };
	try {
		for (const { ref, tip, parents } of await eventRefs(store, reviewId)) {
			if (parents === 0) continue;
			const author = EVENT_REF.exec(ref)?.[1] ?? actor;
			try {
				const done = await compactRef(store, ref, tip, author, options);
				if (done) result.compacted.push(done);
			} catch (error) {
				result.skipped.push({
					ref,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return result;
	} finally {
		span?.end({
			compacted: result.compacted.length,
			skipped: result.skipped.length,
		});
	}
}

/** The review's event refs, with their tips and how many parents each tip has. */
async function eventRefs(
	store: RefStore,
	reviewId: string,
): Promise<{ ref: string; tip: string; parents: number }[]> {
	const out = await runGit(
		store.repo,
		[
			"for-each-ref",
			"--format=%(objectname) %(refname) %(parent)",
			"--end-of-options",
			`refs/crb/reviews/${reviewId}/`,
		],
		{ allowFailure: true },
	);
	const refs: { ref: string; tip: string; parents: number }[] = [];
	for (const line of out.split("\n")) {
		const [tip, ref, ...parents] = line.split(" ").filter(Boolean);
		if (!tip || !ref || !EVENT_REF.test(ref)) continue;
		refs.push({ ref, tip, parents: parents.length });
	}
	return refs;
}

/** The event lines of `tip`'s history as readers see them: oldest commit first, the summary line skipped. */
async function historyOf(
	store: RefStore,
	tip: string,
): Promise<{ commits: number; lines: string[] }> {
	const out = await runGit(store.repo, [
		"--no-replace-objects",
		"-c",
		"log.showSignature=false",
		"-c",
		"i18n.logOutputEncoding=UTF-8",
		"log",
		"-z",
		"--reverse",
		"--no-color",
		"--format=%B",
		"--end-of-options",
		tip,
	]);
	const records = out.split("\0");
	// `-z` ends the last record with nothing after it.
	if (records[records.length - 1]?.trim() === "") records.pop();
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const body of records) {
		// As parseEventLines reads a message: past the summary, each line that
		// may be an event. Kept whether this version understands it or not.
		for (const raw of body.split(/\r?\n/).slice(1)) {
			const text = raw.trim();
			if (!text.startsWith("{") || seen.has(text)) continue;
			seen.add(text);
			lines.push(text);
		}
	}
	return { commits: records.length, lines };
}

async function compactRef(
	store: RefStore,
	ref: string,
	firstTip: string,
	author: string,
	options: CompactOptions,
): Promise<CompactedRef | null> {
	let tip: string | null = firstTip;
	for (let attempt = 1; ; attempt++) {
		const { commits, lines } = await historyOf(store, tip);
		// Already one commit (another compaction won the race): done.
		if (commits <= 1) return null;
		const marker = newEvent(
			"compacted",
			author,
			{ from: tip, commits },
			"auto",
		);
		const message = `crb: compacted ${commits} commits\n\n${[
			...lines,
			JSON.stringify(marker),
		]
			.map((l) => `${l}\n`)
			.join("")}`;
		const oid = await store.commitMessage(null, message, author);
		await options.beforeSwap?.(ref);
		try {
			await store.transaction([{ ref, newOid: oid, oldOid: tip }]);
			return { ref, from: tip, to: oid, commits, lines: lines.length };
		} catch (error) {
			if (!(error instanceof RefConflictError)) throw error;
			if (attempt >= MAX_TRIES) {
				throw new Error(`${ref} kept moving; left uncompacted`);
			}
			tip = await store.tip(ref);
			// Deleted meanwhile: nothing to compact.
			if (!tip) return null;
		}
	}
}

type RunCompaction = (
	repoDir: string,
	reviewId: string,
	actor: string,
) => Promise<CompactResult>;

/**
 * Home's compactions: a review whose PR Home sees merged or closed is
 * compacted once per process, in the background, one review at a time, off
 * every request's path. reset() (the test hook's) drops what is queued.
 */
export class Compactions {
	readonly #tried = new Set<string>();
	#queue: Promise<void> = Promise.resolve();
	#generation = 0;

	constructor(
		private readonly run: RunCompaction = (repoDir, id, actor) =>
			compactReview(new RefStore(repoDir), id, actor),
	) {}

	/** Queues review `reviewId` of clone `repoDir`, unless tried before. */
	schedule(repoDir: string, reviewId: string, actor: string): void {
		const key = `${repoDir}\0${reviewId}`;
		if (this.#tried.has(key)) return;
		this.#tried.add(key);
		const generation = this.#generation;
		this.#queue = this.#queue.then(async () => {
			if (generation !== this.#generation) return;
			try {
				const result = await this.run(repoDir, reviewId, actor);
				for (const s of result.skipped) {
					console.warn(`crb: not compacted: ${s.ref}: ${s.reason}`);
				}
			} catch (error) {
				console.warn(`crb: compaction failed: ${(error as Error).message}`);
			}
		});
	}

	/** Resolves once nothing queued runs. */
	idle(): Promise<void> {
		return this.#queue;
	}

	/** Drops what is queued and forgets what was tried (a fresh process's state). */
	reset(): void {
		this.#generation++;
		this.#tried.clear();
	}
}
