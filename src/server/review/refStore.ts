import { readRef } from "../catFile.js";
import { GitError, runGit } from "../git.js";
import {
	type CrbEvent,
	isSlug,
	parseEventLines,
	serializeCommitMessage,
	validateForWrite,
} from "./events.js";
import { refsChanged } from "./refStamp.js";

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

	/**
	 * The ref's tip, null when it doesn't exist: asked of the clone's shared
	 * `git cat-file --batch` (catFile.ts), so a page's many tip reads start
	 * no process each (CAR-320), and every read goes through git (CAR-326).
	 */
	async tip(ref: string): Promise<string | null> {
		checkRef(ref);
		return (await readRef(this.repo, ref))?.oid ?? null;
	}

	/** Every valid event reachable from the ref, oldest commit first. */
	async readEvents(ref: string): Promise<CrbEvent[]> {
		return (await this.readEventsAt(ref)).events;
	}

	/** The ref's events (as readEvents) and the tip commit they were read from (null: no ref). */
	async readEventsAt(
		ref: string,
	): Promise<{ tip: string | null; events: CrbEvent[] }> {
		const tip = await this.tip(ref);
		if (!tip) return { tip: null, events: [] };
		const key = `${ref}@${tip}`;
		const cached = this.#events.get(key);
		if (cached) return { tip, events: [...cached] };
		const events = await this.#logEvents(tip);
		if (this.#events.size >= MAX_CACHED) {
			const oldest = this.#events.keys().next().value;
			if (oldest !== undefined) this.#events.delete(oldest);
		}
		this.#events.set(key, events);
		return { tip, events: [...events] };
	}

	/**
	 * The tip of every ref matching `patterns` (for-each-ref patterns under
	 * refs/crb/), by ref name: one git call however many refs match, where a
	 * `tip` per ref would start a git each. Empty when git can't list them,
	 * unless `strict` (then a GitError: a caller that keeps the answer).
	 */
	async tips(
		patterns: readonly string[],
		{ strict = false }: { strict?: boolean } = {},
	): Promise<Map<string, string>> {
		for (const p of patterns) {
			if (!p.startsWith("refs/crb/") || p.startsWith("-")) {
				throw new Error(`Not a crb ref pattern: ${p}`);
			}
		}
		// A directory git can't read (not a repo) lists nothing, quietly.
		const out = await runGit(
			this.repo,
			[
				"for-each-ref",
				"--format=%(objectname) %(refname)",
				"--end-of-options",
				...patterns,
			],
			{ allowFailure: !strict },
		);
		const tips = new Map<string, string>();
		for (const line of out.split("\n")) {
			const space = line.indexOf(" ");
			if (space < 0) continue;
			tips.set(line.slice(space + 1), line.slice(0, space));
		}
		return tips;
	}

	/**
	 * The events reachable from each of `tips` (commit OIDs), the same set
	 * readEvents reads for a ref at that tip: all of them in one `git log`,
	 * split by walking each tip's parents, so a caller reading many refs
	 * starts one git, not one per ref. A tip whose history is broken (a
	 * missing parent) is isolated by halving the batch, so it costs only its
	 * own entry, an Error, and a few gits.
	 */
	async eventsOfTips(
		tips: readonly string[],
	): Promise<Map<string, CrbEvent[] | Error>> {
		const wanted = [...new Set(tips)];
		for (const t of wanted) checkOid(t);
		const result = new Map<string, CrbEvent[] | Error>();
		if (wanted.length > 0) await this.#readBatch(wanted, result);
		return result;
	}

	/**
	 * eventsOfTips for `tips`: one git log. When it fails (a tip whose
	 * history is broken), each half is tried again, so k bad tips among n
	 * cost about 2k·log2(n) gits, not n; a lone tip that fails is its Error.
	 */
	async #readBatch(
		tips: readonly string[],
		result: Map<string, CrbEvent[] | Error>,
	): Promise<void> {
		let commits: Map<string, { parents: string[]; body: string }>;
		try {
			commits = await this.#logCommits(tips);
		} catch (error) {
			if (tips.length === 1) {
				result.set(
					tips[0] as string,
					error instanceof Error ? error : new Error(String(error)),
				);
				return;
			}
			const mid = Math.ceil(tips.length / 2);
			await Promise.all([
				this.#readBatch(tips.slice(0, mid), result),
				this.#readBatch(tips.slice(mid), result),
			]);
			return;
		}
		const alone: string[] = [];
		for (const tip of tips) {
			const events = eventsFrom(tip, commits);
			if (events) result.set(tip, events);
			// Not a commit's history git walked (an annotated tag): read as a ref.
			else alone.push(tip);
		}
		await Promise.all(
			alone.map(async (tip) => {
				try {
					result.set(tip, await this.#logEvents(tip));
				} catch (error) {
					result.set(
						tip,
						error instanceof Error ? error : new Error(String(error)),
					);
				}
			}),
		);
	}

	/** Every commit reachable from `tips`, by OID: its parents and message. */
	async #logCommits(
		tips: readonly string[],
	): Promise<Map<string, { parents: string[]; body: string }>> {
		const out = await runGit(
			this.repo,
			[
				"--no-replace-objects",
				"-c",
				"log.showSignature=false",
				"-c",
				"i18n.logOutputEncoding=UTF-8",
				"log",
				"-z",
				"--no-color",
				"--format=%H %P%n%B",
				"--stdin",
			],
			{ input: `${tips.join("\n")}\n` },
		);
		const commits = new Map<string, { parents: string[]; body: string }>();
		for (const record of out.split("\0")) {
			const nl = record.indexOf("\n");
			const head = (nl < 0 ? record : record.slice(0, nl)).trim();
			if (!head) continue;
			const [oid, ...parents] = head.split(" ").filter(Boolean);
			if (!oid) continue;
			commits.set(oid, { parents, body: nl < 0 ? "" : record.slice(nl + 1) });
		}
		return commits;
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
	 * moved the ref in between, the event is committed again on the new tip,
	 * unchanged: only for an event that doesn't depend on what the ref holds.
	 * One stamped or checked against the ref's events uses appendBuilt.
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
	appendEvents(
		ref: string,
		summary: string,
		events: CrbEvent[],
		author: string,
	): Promise<string> {
		return this.#append(ref, author, async () => ({
			tip: await this.tip(ref),
			summary,
			events,
		}));
	}

	/**
	 * Appends the commit `build` makes from the ref's events, as appendEvents.
	 * Each try reads the events again and calls `build` on them, so a writer
	 * whose events depend on what is there (a check, a stamp) never lands
	 * events computed against a tip another writer has since moved. `build`
	 * throws to refuse the write.
	 */
	appendBuilt(
		ref: string,
		author: string,
		build: (existing: CrbEvent[]) => { summary: string; events: CrbEvent[] },
	): Promise<string> {
		return this.#append(ref, author, async () => {
			const { tip, events } = await this.readEventsAt(ref);
			return { tip, ...build(events) };
		});
	}

	async #append(
		ref: string,
		author: string,
		prepare: () => Promise<{
			tip: string | null;
			summary: string;
			events: CrbEvent[];
		}>,
	): Promise<string> {
		checkRef(ref);
		let lastError: unknown;
		const { minTries, budgetMs, maxTries, now, sleep: wait } = this.#retry;
		const begun = now();
		let attempt = 0;
		for (;;) {
			attempt++;
			const started = now();
			const { tip, summary, events } = await prepare();
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
		// Before the update too: crb killed between the update and the
		// stamp after it still leaves a stamp no earlier listing saw.
		await refsChanged(this.repo);
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
		} finally {
			// After the update, applied or not (refStamp.ts): Home's next
			// scan of this clone lists its refs again.
			await refsChanged(this.repo);
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
 * The events of every commit reachable from `tip` in `commits` (OID →
 * parents and message), parents before children. Linear history comes out
 * as `git log --reverse` gives it; a merge's sides need not be in git's date
 * order, which nothing depends on (the fold sorts by ts and id, and the
 * review-created pick is by ts and id too). Null when a commit in its
 * history is missing.
 */
function eventsFrom(
	tip: string,
	commits: ReadonlyMap<string, { parents: string[]; body: string }>,
): CrbEvent[] | null {
	const order: string[] = [];
	const seen = new Set<string>();
	// Iterative post-order: a long history never runs out of stack.
	const stack: { oid: string; next: number }[] = [{ oid: tip, next: 0 }];
	seen.add(tip);
	while (stack.length > 0) {
		const top = stack[stack.length - 1] as { oid: string; next: number };
		const commit = commits.get(top.oid);
		if (!commit) return null;
		const parent = commit.parents[top.next++];
		if (parent === undefined) {
			order.push(top.oid);
			stack.pop();
		} else if (!seen.has(parent)) {
			seen.add(parent);
			stack.push({ oid: parent, next: 0 });
		}
	}
	// parseEventLines skips a message's first line, as `%B` gives it.
	return order.flatMap((oid) => parseEventLines(commits.get(oid)?.body ?? ""));
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
