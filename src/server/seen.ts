import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomicFile.js";
import { stateDir } from "./paths.js";
import { checkReviewId } from "./review/reviews.js";

/**
 * The PR's head when this crb instance last opened a review, kept as a
 * small JSON file per review under the server's state directory
 * (`$XDG_STATE_HOME/carbonless/seen/<review-id>.json`): UI state, private
 * to this instance, never in git. The toast reads it to say what is new
 * since the reviewer last looked, before any patch set exists.
 */
export interface Seen {
	/** The head's OID. */
	head: string;
	/** Ms since epoch. */
	at: number;
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function seenPath(reviewId: string): string {
	checkReviewId(reviewId);
	return join(stateDir(), "seen", `${reviewId}.json`);
}

/**
 * Notes recorded but maybe not on disk yet, by review: the newest one, and
 * the end of that review's chain of writes.
 */
const writing = new Map<string, { seen: Seen; done: Promise<void> }>();

/** The last-seen head of the review, or null when none or unreadable. */
export async function readSeen(reviewId: string): Promise<Seen | null> {
	const path = seenPath(reviewId);
	const pending = writing.get(reviewId);
	if (pending) return pending.seen;
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const { head, at } = value as Record<string, unknown>;
	if (typeof head !== "string" || !OID.test(head)) return null;
	if (!Number.isSafeInteger(at) || (at as number) < 0) return null;
	return { head, at: at as number };
}

/** Records `head` as the review's last-seen head (at `at`, by default now). */
export async function writeSeen(
	reviewId: string,
	head: string,
	at: number = Date.now(),
): Promise<void> {
	const path = seenPath(reviewId);
	if (!OID.test(head)) throw new Error(`Not an object ID: ${head}`);
	await writeFileAtomic(path, `${JSON.stringify({ head, at })}\n`);
}

/**
 * Records `head` as the review's last-seen head without waiting for the
 * disk: opening a review never waits on this note (on Windows a busy file
 * can hold a save for seconds, CAR-181). readSeen answers it at once; one
 * review's writes go to disk in order, so the newest recorded wins; a
 * failed write only loses the note. A review id or head that isn't one is
 * no note (false).
 */
export function recordSeen(
	reviewId: string,
	head: string,
	at: number = Date.now(),
): boolean {
	try {
		seenPath(reviewId);
	} catch {
		return false;
	}
	if (!OID.test(head)) return false;
	const before = writing.get(reviewId)?.done ?? Promise.resolve();
	const entry = {
		seen: { head, at },
		done: before.then(() => writeSeen(reviewId, head, at)).catch(() => {}),
	};
	writing.set(reviewId, entry);
	void entry.done.then(() => {
		if (writing.get(reviewId) === entry) writing.delete(reviewId);
	});
	return true;
}

/**
 * Resolves once the review's recorded notes are written (or failed); with
 * no review, every review's.
 */
export async function seenSettled(reviewId?: string): Promise<void> {
	const pending =
		reviewId === undefined
			? [...writing.values()]
			: [writing.get(reviewId)].filter((w) => w !== undefined);
	await Promise.all(pending.map((w) => w.done));
}
