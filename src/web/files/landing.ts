import type { FileView, ReviewThread, SessionInfo } from "../../shared/types";

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
	/** The comparison (files/comparison.ts): the viewed patch set… */
	ps?: number;
	/** …or the viewed head (a commit id), and the comparison base. */
	head?: string;
	from?: number | "branch";
}

const OID = /^[0-9a-f]{40}$/;

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
	const ps = positive(raw.ps);
	if (ps !== undefined) out.ps = ps;
	if (typeof raw.head === "string" && OID.test(raw.head)) out.head = raw.head;
	const from = positive(raw.from);
	if (from !== undefined) out.from = from;
	else if (raw.from === "branch") out.from = "branch";
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
	return { path: thread.path, line, side, moved: true };
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
