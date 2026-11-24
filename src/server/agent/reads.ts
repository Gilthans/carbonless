import { inGitOrder } from "../../shared/diffHunk.js";
import { hunkPairs } from "../../shared/hunkPairs.js";
import type { ThreadPlacement } from "../../shared/rereview/placement.js";
import type {
	DiffLine,
	DiffSide,
	DisplayHunk,
	FileHunks,
	FileStatus,
} from "../../shared/types.js";
import { matchDisplayHunk } from "../../shared/whitespace.js";

/**
 * The agent's reads of the code (CAR-182): `diff` and `file` answers, and
 * where `review` says crb shows each GitHub thread. Read-only: nothing
 * here writes, marks or hides anything (principle 2). The analysis is the
 * page's own (whitespace twins: matchDisplayHunk; line pairs: hunkPairs),
 * never a second implementation.
 */

/** A comparison as the agent's `diff` reads it (Session.agentDiff). */
export interface AgentDiff {
	/** The full diff's merge base, or the since view's earlier patch set head. */
	base: string;
	head: string;
	/** The since view's earlier patch set; null for the full diff. */
	from: number | null;
	/** The compared head's patch set; null for a head that is none yet. */
	to: number | null;
	/** The since view's only: whether the interdiff could be built. */
	interdiff?: "available" | "unavailable";
	/**
	 * `from: "last"` to `"head"` when the PR's head is the reviewer's
	 * newest patch set: nothing was pushed since their last pass (this
	 * patch set); no files are listed.
	 */
	nothingPushed?: number;
	files: {
		index: number;
		path: string;
		oldPath?: string;
		status?: FileStatus;
		binary?: boolean;
		/** File-level changes, as crb labels them (a mode, a binary file, a rename); the since view's: what changed since. */
		changes?: string[];
		/** The since view only: whether the author changed the file since (the engine's interdiff). */
		changed?: boolean;
		/**
		 * The since view only: whether the page's since view shows it at all:
		 * a change since, or lines left unreviewed at that patch set that
		 * nothing carries (CAR-216).
		 */
		shown?: boolean;
	}[];
	/** A file's display hunks, as the page gets them (the since view's: none when unchanged since). */
	hunks(index: number): Promise<FileHunks>;
}

/** A `diff` request the agent made that can't be served as made (the tool's `invalid`). */
export class AgentDiffRequestError extends Error {}

/** A `diff` answer's text budget (characters of diff text, all files together). */
export const MAX_DIFF_CHARS = 200_000;
/** Below this much budget left, `diff` reads no more files: it names them (`omitted`). */
export const MIN_FILE_BUDGET = 1_000;
/** `file` refuses a blob over this many bytes, before reading it. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** A `file` answer's text budget (characters). */
export const MAX_FILE_CHARS = 200_000;

/** Inclusive line ranges on one side. */
export type Ranges = [number, number][];

/** crb's analysis of one file's diff, as the page shows it. */
export interface DiffAnalysis {
	/**
	 * Changed lines whose change is whitespace only (git's `-w`): the
	 * page's `~` rows with "Ignore whitespace" on. LEFT in the old side's
	 * numbering, RIGHT in the new side's.
	 */
	whitespaceOnly: { LEFT: Ranges; RIGHT: Ranges };
	/**
	 * Removed and added lines the page pairs (word highlighting, side by
	 * side; "Ignore whitespace" off, the default): `[old, new]` numbers.
	 */
	pairs: [number, number][];
}

/** One file in a `diff` answer: read (hunks and analysis), or `unread` past the budget. */
export interface DiffFileOut extends Partial<DiffAnalysis> {
	path: string;
	oldPath?: string;
	status?: FileStatus;
	binary?: true;
	/** File-level changes, as crb labels them (a mode, a binary file, a rename); the since view's: what changed since. */
	changes?: string[];
	/** Unified diff text of the hunks given (git's order); "" for none. */
	diff: string;
	/** Hunks in the file (all of them, given or not); absent when it wasn't read. */
	hunks?: number;
	/** Not read: the budget was spent before it (ask for it by path). */
	unread?: true;
	/** The since view: whether the author changed the file since (false: only lines left unreviewed show). */
	changed?: boolean;
	/**
	 * The since view: lines unchanged since that patch set but not reviewed
	 * there (the page's "not reviewed in PSn" boxes, CAR-216); LEFT in the
	 * base's numbering, RIGHT in the head's.
	 */
	notReviewedThen?: { LEFT: Ranges; RIGHT: Ranges };
	/** Past the budget: the first hunk left out; ask again with `fromHunk`. */
	nextHunk?: number;
	/** The file's diff couldn't be read (it is still one of the comparison's). */
	error?: string;
}

/** The given hunks' orphan lines (DiffLine.orphan, CAR-216), within `shown`; null for none. */
export function orphanRanges(
	hunks: readonly DisplayHunk[],
	shown?: ReadonlySet<DiffLine>,
): { LEFT: Ranges; RIGHT: Ranges } | null {
	const left: number[] = [];
	const right: number[] = [];
	for (const h of hunks) {
		for (const l of h.lines) {
			if (!l.orphan || (shown && !shown.has(l))) continue;
			if (l.kind === "del" && typeof l.baseNo === "number") left.push(l.baseNo);
			if (l.kind === "add" && l.newNo !== undefined) right.push(l.newNo);
		}
	}
	return left.length + right.length > 0
		? { LEFT: toRanges(left), RIGHT: toRanges(right) }
		: null;
}

/** Sorted numbers as inclusive ranges. */
export function toRanges(numbers: Iterable<number>): Ranges {
	const sorted = [...new Set(numbers)].sort((a, b) => a - b);
	const out: Ranges = [];
	for (const n of sorted) {
		const last = out.at(-1);
		if (last && n === last[1] + 1) last[1] = n;
		else out.push([n, n]);
	}
	return out;
}

/** A hunk as unified diff text, in git's order, with its heading. */
export function hunkText(hunk: DisplayHunk): string {
	const heading = hunk.heading ? ` ${hunk.heading.replace(/[\r\n]/g, "")}` : "";
	const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${heading}`;
	const sign = { context: " ", add: "+", del: "-" } as const;
	const lines = inGitOrder(hunk.lines).flatMap((l) =>
		l.noNewline
			? [`${sign[l.kind]}${l.text}`, "\\ No newline at end of file"]
			: [`${sign[l.kind]}${l.text}`],
	);
	return [header, ...lines].join("\n");
}

/**
 * The page's analysis of these hunks: whitespace twins and line pairs,
 * computed on the whole hunks as the page does; with `shown`, only the
 * lines in it are reported (a cut hunk's).
 */
export function analyse(
	hunks: readonly DisplayHunk[],
	shown?: ReadonlySet<DiffLine>,
): DiffAnalysis {
	const keep = (l: DiffLine) => !shown || shown.has(l);
	const wsOld: number[] = [];
	const wsNew: number[] = [];
	const pairs: [number, number][] = [];
	for (const hunk of hunks) {
		// The page's `~` rows: the display hunk's one matching.
		for (const line of matchDisplayHunk(hunk.lines).keys()) {
			if (!keep(line)) continue;
			if (line.kind === "del" && line.oldNo !== undefined)
				wsOld.push(line.oldNo);
			if (line.kind === "add" && line.newNo !== undefined)
				wsNew.push(line.newNo);
		}
		// The page's pairs with "Ignore whitespace" off: every line a row.
		const rows = hunk.lines.map((line: DiffLine) => ({
			kind: "line" as const,
			line,
		}));
		for (const [del, add] of hunkPairs(rows)) {
			if (!keep(del) || !keep(add)) continue;
			if (del.oldNo !== undefined && add.newNo !== undefined) {
				pairs.push([del.oldNo, add.newNo]);
			}
		}
	}
	return {
		whitespaceOnly: { LEFT: toRanges(wsOld), RIGHT: toRanges(wsNew) },
		pairs,
	};
}

/**
 * One file's hunks from `fromHunk` on, whole hunks while they fit `budget`
 * characters; with `cutFirst`, a first hunk alone over it is cut at a
 * line (it ends with a marker, `shown` holds the lines given, and
 * `nextHunk` points past it). `since`: the since view's marker (its old
 * side is no commit `file` reads). Returns the text, the hunks given, the
 * characters used and the first hunk left out.
 */
export function fileDiff(
	file: FileHunks,
	fromHunk: number,
	budget: number,
	/** Cut a first hunk that alone is over the budget (else it is left for later). */
	cutFirst = true,
	since = false,
): {
	text: string;
	given: DisplayHunk[];
	used: number;
	nextHunk?: number;
	shown?: Set<DiffLine>;
} {
	const parts: string[] = [];
	const given: DisplayHunk[] = [];
	let used = 0;
	for (let i = fromHunk; i < file.hunks.length; i++) {
		const hunk = file.hunks[i] as DisplayHunk;
		const text = hunkText(hunk);
		const cost = text.length + 1;
		if (used + cost > budget) {
			if (given.length === 0 && cutFirst && budget > 400) {
				// One hunk too big for the whole budget: cut at a line, say so.
				const room = budget - 300;
				let size = hunkText({ ...hunk, lines: [] }).length;
				const shown: DiffLine[] = [];
				for (const l of inGitOrder(hunk.lines)) {
					const n = l.text.length + 2 + (l.noNewline ? 30 : 0);
					if (size + n > room) break;
					shown.push(l);
					size += n;
				}
				const marker = since
					? `[truncated: hunk ${i} is too long; read the rest of its new side with the file tool at the compared head (its old side is the earlier patch set rebased, which no commit holds)]`
					: `[truncated: hunk ${i} is too long; read the rest with the file tool]`;
				parts.push(`${hunkText({ ...hunk, lines: shown })}\n${marker}`);
				given.push(hunk);
				return {
					text: parts.join("\n"),
					given,
					used: budget,
					shown: new Set(shown),
					...(i + 1 < file.hunks.length ? { nextHunk: i + 1 } : {}),
				};
			}
			return { text: parts.join("\n"), given, used, nextHunk: i };
		}
		parts.push(text);
		given.push(hunk);
		used += cost;
	}
	return { text: parts.join("\n"), given, used };
}

/** Where crb shows a GitHub thread on the review's head (`review`'s `atHead`). */
export type AtHead =
	/** On the same lines it was made on (`changed`: on lines that replaced them). */
	| {
			kind: "placed" | "changed";
			path: string;
			side: DiffSide;
			startSide: DiffSide;
			startLine: number;
			line: number;
	  }
	/** A file comment, on its file. */
	| { kind: "file"; path: string }
	/** Under its file: its lines can't be placed (why: `fate`), `near` the closest line above. */
	| {
			kind: "unplaced";
			path: string;
			fate: string;
			near: { side: DiffSide; line: number } | null;
	  }
	/** Its file isn't in the comparison (why: `fate`). */
	| { kind: "outside"; path: string; fate: string }
	/** crb couldn't place it now (why): never a guess. */
	| { kind: "unknown"; why: string };

/** A page placement as the agent reads it (paths sanitised by `s`). */
export function atHead(
	p: ThreadPlacement,
	s: (text: string) => string,
): AtHead {
	switch (p.kind) {
		case "placed":
		case "changed":
			return {
				kind: p.kind,
				path: s(p.anchor.path),
				side: p.anchor.side,
				startSide: p.anchor.startSide,
				startLine: p.anchor.startLine,
				line: p.anchor.line,
			};
		case "file":
			return { kind: "file", path: s(p.path) };
		case "unplaced":
			return {
				kind: "unplaced",
				path: s(p.path),
				fate: p.fate,
				near: p.nearest ? { side: p.nearest.side, line: p.nearest.line } : null,
			};
		case "outside":
			return { kind: "outside", path: s(p.path), fate: p.fate };
		case "pending":
			// Still waiting for GitHub's hunk (CAR-8): never a guessed line.
			return { kind: "unknown", why: "crb is still placing this thread" };
	}
}

/** A path the agent may name: relative, no `..`, no NUL, no leading `-` (never an option). */
export function isReadablePath(path: string): boolean {
	return (
		path.length > 0 &&
		path.length <= 4096 &&
		!path.startsWith("/") &&
		!path.startsWith("-") &&
		!/[\0\r\n]/.test(path) &&
		!path.split(/[/\\]/).includes("..")
	);
}

/** One window of a text file's lines (1-based, inclusive; git's lines, as decodeLines splits them), within MAX_FILE_CHARS. */
export function fileWindow(
	all: readonly string[],
	startLine: number,
	endLine: number | undefined,
	budget = MAX_FILE_CHARS,
): {
	lines: number;
	startLine: number;
	endLine: number;
	text: string;
	nextLine?: number;
} {
	const lines = all.length;
	const from = Math.min(Math.max(1, startLine), Math.max(1, lines));
	const to = Math.min(endLine ?? lines, lines);
	const out: string[] = [];
	let used = 0;
	let last = from - 1;
	for (let n = from; n <= to; n++) {
		let line = all[n - 1] as string;
		if (used + line.length + 1 > budget) {
			if (out.length > 0) break;
			// One line over the whole budget: cut, and say so.
			line = `${line.slice(0, Math.max(0, budget - 100))} [truncated: line ${n} is too long]`;
		}
		out.push(line);
		used += line.length + 1;
		last = n;
	}
	return {
		lines,
		startLine: from,
		endLine: last,
		text: out.join("\n"),
		...(last < to ? { nextLine: last + 1 } : {}),
	};
}
