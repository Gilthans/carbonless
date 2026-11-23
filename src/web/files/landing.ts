import type { FileView, ReviewThread, SessionInfo } from "../../shared/types";
import type { SinceEarlier, SinceLeft } from "./threadPlacement";

/**
 * Files changed's search params: land on `path`, at `line` on `side` ("LEFT"
 * numbers the old file). `moved`: the line was commented on another commit,
 * so its number may not hold in this diff; the file opens at its top with a
 * hint instead.
 */
export interface FilesSearch {
	path?: string;
	line?: number;
	side?: "LEFT" | "RIGHT";
	moved?: boolean;
	/**
	 * A moved line's commit, the one its number counts on: the since view
	 * finds a line only its compared patch set had there (CAR-233's rows).
	 */
	commit?: string;
	/** The comparison (files/comparison.ts): the viewed patch set… */
	ps?: number;
	/** …or the viewed head (a commit id), and the comparison base. */
	head?: string;
	from?: number | "branch";
	/** An agent conversation to open on arrival (its card), and a message in it to outline. */
	conversation?: string;
	message?: string;
}

const OID = /^[0-9a-f]{40}$/;
/** An agent thread or message id (a lowercase ULID). */
const ULID = /^[0-9a-hjkmnp-tv-z]{26}$/;

/** A positive integer, as the address has it (a string) or as given. */
function positive(raw: unknown): number | undefined {
	const n = typeof raw === "string" ? Number(raw) : raw;
	return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Untrusted URL params to FilesSearch; anything odd is dropped. */
export function parseFilesSearch(raw: Record<string, unknown>): FilesSearch {
	const out: FilesSearch = {};
	if (typeof raw.path === "string" && raw.path) out.path = raw.path;
	const line = positive(raw.line);
	if (line !== undefined) out.line = line;
	if (raw.side === "LEFT" || raw.side === "RIGHT") out.side = raw.side;
	if (raw.moved === true || raw.moved === "true" || raw.moved === 1) {
		out.moved = true;
	}
	if (typeof raw.commit === "string" && OID.test(raw.commit)) {
		out.commit = raw.commit;
	}
	const ps = positive(raw.ps);
	if (ps !== undefined) out.ps = ps;
	if (typeof raw.head === "string" && OID.test(raw.head)) out.head = raw.head;
	const from = positive(raw.from);
	if (from !== undefined) out.from = from;
	else if (raw.from === "branch") out.from = "branch";
	if (typeof raw.conversation === "string" && ULID.test(raw.conversation)) {
		out.conversation = raw.conversation;
		if (typeof raw.message === "string" && ULID.test(raw.message)) {
			out.message = raw.message;
		}
	}
	return out;
}

type Thread = ReviewThread;

/**
 * Where a thread's file:line link lands. The line only counts as this
 * diff's when it was numbered on the snapshot's head: the code's own commit
 * is the head, or GitHub's current line is of the head the snapshot is at
 * (not as of a cutoff, not outdated). Otherwise it's `moved`.
 */
export function threadTarget(
	thread: Thread,
	session:
		| Pick<SessionInfo, "snapshotHead" | "currentHead" | "asOf">
		| undefined,
	line: number | null,
): FilesSearch {
	const { code } = thread;
	const side = code?.anchor.side ?? "RIGHT";
	if (line === null) return { path: thread.path };
	if (code?.anchor.commit && code.anchor.commit === session?.snapshotHead) {
		return { path: thread.path, line, side };
	}
	if (
		session &&
		!session.asOf &&
		!thread.outdated &&
		thread.currentLine !== null &&
		session.currentHead === session.snapshotHead
	) {
		return { path: thread.path, line: thread.currentLine, side };
	}
	const commit = code?.anchor.commit;
	return {
		path: thread.path,
		line,
		side,
		moved: true,
		...(commit && OID.test(commit) ? { commit } : {}),
	};
}

/** The file a landing names: by path, or by its old path for the old side. */
export function landingFile(
	files: FileView[],
	search: FilesSearch,
): FileView | undefined {
	return (
		files.find((f) => f.path === search.path) ??
		files.find((f) => f.oldPath === search.path)
	);
}

/**
 * A landing being shown: where to, the file's index (null: not in this
 * diff) and a sequence number, new for each link followed.
 */
export type Landing = FilesSearch & { index: number | null; seq: number };

/**
 * The row a landing's line is on, by its number on one side as the view
 * numbers its rows (`old`: the old side). A link's LEFT line counts in the
 * base (GitHub's, the Threads tab's, the agent's); the since view (`left`,
 * threadPlacement.ts sinceLeft) numbers its old side in the compared patch
 * set, so it goes where the line's thread shows there: the head line the
 * full diff keeps it as, else the removed row whose base line it is; null
 * when neither (no row of this view is that line). RIGHT lines, and any
 * line in the full diff (no `left`), are as given.
 */
export function landingRow(
	side: "LEFT" | "RIGHT",
	line: number,
	left: SinceLeft | undefined,
): { old: boolean; line: number } | null {
	if (side === "RIGHT" || !left) return { old: side === "LEFT", line };
	const at = left(line);
	return at && { old: at.side === "LEFT", line: at.line };
}

/**
 * A moved landing's row in the since view (`early`, threadPlacement.ts
 * sinceEarlier): a RIGHT line numbered on the compared patch set's head
 * that only it had, on the removed row that shows it (where that
 * patch set's threads show, CAR-233); null otherwise.
 */
export function earlierRow(
	landing: Pick<FilesSearch, "side" | "line" | "commit">,
	early: SinceEarlier | undefined,
): { old: boolean; line: number } | null {
	if (!early || landing.line === undefined) return null;
	if (landing.side === "LEFT" || landing.commit !== early.head) return null;
	const row = early.row(landing.line);
	return row === null ? null : { old: true, line: row };
}
