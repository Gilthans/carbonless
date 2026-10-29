import { GitError, runGit } from "../git.js";
import {
	type CrbEvent,
	isSlug,
	parseEventLines,
	serializeCommitMessage,
	validateForWrite,
} from "./events.js";

/**
 * Retry budget per append; each lost race re-reads the tip (see appendEvent).
 * An append keeps trying while it has made fewer than `minTries` tries or is
 * still inside `budgetMs`, and never more than `maxTries`: a slow, loaded
 * machine gets time, not just a count, and it still ends. Past `minTries`,
 * each backoff sleep is clamped to what's left of the budget, so a failing
 * append gives up after the longer of its first `minTries` tries and
 * `budgetMs` plus one more try.
 */
export interface RetryOptions {
	minTries: number;
	budgetMs: number;
	maxTries: number;
	/** Test hooks: the clock and the backoff sleep. */
	now: () => number;
	sleep: (ms: number) => Promise<void>;
}
const RETRY_DEFAULTS: RetryOptions = {
	minTries: 5,
	budgetMs: 5_000,
	maxTries: 50,
	now: () => performance.now(),
	sleep,
};
/** Backoff stops doubling after this many tries. */
const MAX_BACKOFF_EXPONENT = 6;

/** Parsed event lists kept in memory (see readEvents). */
const MAX_CACHED = 64;

/**
 * Thrown when a ref was not at the expected old value (another writer moved,
 * created or deleted it, or held its lock), as opposed to a real failure.
 */
export class RefConflictError extends GitError {}

/** update-ref's wording (under LC_ALL=C) for a lost compare-and-swap race. */
const LOST_RACE =
	/cannot lock ref '[^']*': (?:is at \S+ but expected|reference already exists|unable to resolve reference|Unable to create '[^']*\.lock': File exists)/;

export interface RefUpdate {
	ref: string;
	newOid: string;
	/** null: the ref must not exist yet. */
	oldOid: string | null;
}

/**
 * Reads and writes crb event refs in one repository (carbonless's private
 * bare clone). Every ref update is compare-and-swap; history stays linear.
 * See docs/review-data-storage.md ("Writing", "Reading").
 */
export class RefStore {
	#emptyTree: Promise<string> | undefined;
	/**
	 * `<ref>@<tip OID>` → the events reachable from that tip. A commit's
	 * history never changes, so an entry stays valid; a moved ref just gets a
	 * new key. Oldest entries go first once MAX_CACHED is reached.
	 */
	#events = new Map<string, readonly CrbEvent[]>();

	readonly #retry: RetryOptions;

	constructor(
		readonly repo: string,
		retry: Partial<RetryOptions> = {},
	) {
		this.#retry = { ...RETRY_DEFAULTS, ...retry };
	}

	/** The empty tree's OID (SHA-1 or SHA-256, whatever the repo uses). */
	emptyTree(): Promise<string> {
		this.#emptyTree ??= runGit(this.repo, [
			"hash-object",
			"-w",
			"-t",
			"tree",
			"--stdin",
		]).then((out) => out.trim());
		return this.#emptyTree;
	}

	async tip(ref: string): Promise<string | null> {
		checkRef(ref);
		const out = await runGit(
			this.repo,
			["rev-parse", "--verify", "--quiet", "--end-of-options", ref],
			{ allowFailure: true },
		);
		return out.trim() || null;
	}

	/** Every valid event reachable from the ref, oldest commit first. */
	async readEvents(ref: string): Promise<CrbEvent[]> {
		const tip = await this.tip(ref);
		if (!tip) return [];
		const key = `${ref}@${tip}`;
		const cached = this.#events.get(key);
		if (cached) return [...cached];
		const events = await this.#logEvents(tip);
		if (this.#events.size >= MAX_CACHED) {
			const oldest = this.#events.keys().next().value;
			if (oldest !== undefined) this.#events.delete(oldest);
		}
		this.#events.set(key, events);
		return [...events];
	}

	async #logEvents(tip: string): Promise<CrbEvent[]> {
		// Pin everything user config could change about the bytes we read.
		const out = await runGit(this.repo, [
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
		return out.split("\0").flatMap(parseEventLines);
	}

	/** Writes a crb commit (not moving any ref) and returns its OID. */
	async commit(
		parent: string | null,
		summary: string,
		events: CrbEvent[],
		author: string,
	): Promise<string> {
		if (!isSlug(author)) throw new Error(`Invalid author slug: ${author}`);
		for (const e of events) validateForWrite(e);
		const tree = await this.emptyTree();
		const out = await runGit(
			this.repo,
			[
				"-c",
				"i18n.commitEncoding=UTF-8",
				"commit-tree",
				"--no-gpg-sign",
				tree,
				...(parent ? ["-p", parent] : []),
				"-F",
				"-",
			],
			{
				input: serializeCommitMessage(summary, events),
				// Identity from the environment only, never from git config.
				env: {
					GIT_AUTHOR_NAME: author,
					GIT_AUTHOR_EMAIL: `${author}@crb`,
					GIT_COMMITTER_NAME: "crb",
					GIT_COMMITTER_EMAIL: "crb@crb",
				},
			},
		);
		return out.trim();
	}

	/**
	 * Appends one event as a new commit on the ref's tip. If another writer
	 * moved the ref in between, the event is committed again on the new tip.
	 */
	appendEvent(
		ref: string,
		summary: string,
		event: CrbEvent,
		author: string,
	): Promise<string> {
		return this.appendEvents(ref, summary, [event], author);
	}

	/** appendEvent for several events in one commit (all or none land). */
	async appendEvents(
		ref: string,
		summary: string,
		events: CrbEvent[],
		author: string,
	): Promise<string> {
		checkRef(ref);
		let lastError: unknown;
		const { minTries, budgetMs, maxTries, now, sleep: wait } = this.#retry;
		const begun = now();
		let attempt = 0;
		for (;;) {
			attempt++;
			const started = now();
			const tip = await this.tip(ref);
			const oid = await this.commit(tip, summary, events, author);
			try {
				await this.transaction([{ ref, newOid: oid, oldOid: tip }]);
				return oid;
			} catch (error) {
				if (!(error instanceof RefConflictError)) throw error;
				lastError = error;
				const elapsed = now() - begun;
				const inBudget = attempt < minTries || elapsed < budgetMs;
				if (!inBudget || attempt >= maxTries) break;
				// Randomized exponential backoff, scaled to how long a try takes,
				// spreads out writers that keep colliding.
				const tryMs = now() - started;
				const exponent = Math.min(attempt, MAX_BACKOFF_EXPONENT);
				let backoff = Math.random() * tryMs * 2 ** exponent;
				// Past the minimum, never sleep beyond the budget.
				if (attempt >= minTries) {
					backoff = Math.min(backoff, Math.max(0, budgetMs - elapsed));
				}
				await wait(backoff);
			}
		}
		throw new RefConflictError(
			`Could not append to ${ref} after ${attempt} tries: ${String(lastError)}`,
		);
	}

	/** Updates all refs or none; fails if any ref isn't at its old value. */
	async transaction(updates: RefUpdate[]): Promise<void> {
		if (updates.length === 0) return;
		const zero = "0".repeat((await this.emptyTree()).length);
		const lines = updates.map(({ ref, newOid, oldOid }) => {
			checkRef(ref);
			checkOid(newOid);
			if (oldOid !== null) checkOid(oldOid);
			return `update ${ref} ${newOid} ${oldOid ?? zero}\n`;
		});
		try {
			await runGit(this.repo, ["update-ref", "--stdin"], {
				input: `start\n${lines.join("")}commit\n`,
				// English messages, so LOST_RACE can recognize them.
				env: { LC_ALL: "C" },
			});
		} catch (error) {
			if (error instanceof GitError && LOST_RACE.test(error.message)) {
				throw new RefConflictError(error.message);
			}
			throw error;
		}
	}

	async writeBlob(content: string): Promise<string> {
		const out = await runGit(this.repo, ["hash-object", "-w", "--stdin"], {
			input: content,
		});
		return out.trim();
	}
}

/**
 * A crb ref that also passes `git check-ref-format`: a safe character set, no
 * empty component, no component starting with "." or ending in ".lock", no
 * "..", and no trailing ".".
 */
function checkRef(ref: string): void {
	const parts = ref.split("/");
	const valid =
		/^refs\/crb\/[A-Za-z0-9._/-]+$/.test(ref) &&
		!ref.includes("..") &&
		!ref.endsWith(".") &&
		parts.every((p) => p !== "" && !p.startsWith(".") && !p.endsWith(".lock"));
	if (!valid) throw new Error(`Not a valid crb ref: ${ref}`);
}

function checkOid(oid: string): void {
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
		throw new Error(`Not an object ID: ${oid}`);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
