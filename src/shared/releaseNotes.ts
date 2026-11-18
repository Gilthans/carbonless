/**
 * Release notes: the formats the release tooling writes and crb reads
 * (CAR-192, `docs/superpowers/specs/2026-11-16-release-notes-design.md`).
 *
 * - `release-notes/X.Y.Z.json` (committed, one per version):
 *   `ReleaseNotesFile`.
 * - `dist/release-notes.json` (built): `ShippedReleaseNotes[]`, this
 *   version and the earlier releases, newest first.
 * - `crbReleaseNotes` in the packed `package.json` (so in npm's manifest
 *   of each version): the same list capped at `MAX_SHIPPED_VERSIONS`
 *   versions and `MAX_SHIPPED_BYTES` of JSON.
 *
 * Everything read from a file, the registry or Linear is untrusted:
 * `noteTextProblems` is the text rule, `parseShippedReleaseNotes` the
 * lenient reader (drops what fails, counts it) and
 * `parseReleaseNotesFile` the strict one (the tooling refuses).
 */

export const NOTE_KINDS = ["new", "improved", "fixed"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** A note's text: at most this many characters (a sanity bound, not a style limit). */
export const MAX_NOTE_CHARS = 600;
/** A `none` reason: at most this many characters. */
export const MAX_NONE_WHY_CHARS = 120;
/** `crbReleaseNotes` keeps at most this many versions, newest first. */
export const MAX_SHIPPED_VERSIONS = 10;
/** ... and at most this many bytes of JSON (oldest versions dropped first). */
export const MAX_SHIPPED_BYTES = 64 * 1024;

/** One user-facing note: a ticket's (`CAR-183`) or a ticket-less PR's (`#125`). */
export interface ReleaseNote {
	/** `CAR-NNN`, or `#N` for a PR without a ticket. */
	id: string;
	kind: NoteKind;
	/** The PRs that shipped it (ascending). */
	prs: number[];
	/** Plain text, one line; `code` in backticks is the only markup. */
	text: string;
}

/** A ticket or PR that explicitly needs no note, and why. */
export interface ReleaseNoneEntry {
	id: string;
	prs: number[];
	why: string;
}

/** `release-notes/X.Y.Z.json`. */
export interface ReleaseNotesFile {
	/** `X.Y.Z` (never an RC). */
	version: string;
	/** `YYYY-MM-DD`, set by promote's build of the release; null before. */
	date: string | null;
	/** New, then improved, then fixed; within a kind by first PR. */
	notes: ReleaseNote[];
	none: ReleaseNoneEntry[];
}

/** One version's notes as they ship (`dist/release-notes.json`, `crbReleaseNotes`). */
export interface ShippedReleaseNotes {
	version: string;
	date: string | null;
	notes: ReleaseNote[];
	/**
	 * An RC only, for the upcoming version: the release range's PRs with no
	 * note or none in the file yet ("N more changes, no notes yet").
	 * Absent on a release.
	 */
	uncovered?: number[];
}

const VERSION = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_ID = /^(CAR-[1-9]\d*|#[1-9]\d*)$/;

// C0 and C1 controls and DEL (so also newlines and tabs: a note is one
// line), and the bidi marks, embeddings, overrides and isolates.
// biome-ignore lint/suspicious/noControlCharactersInRegex: that's the point
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;
const TICKET_ID = /\bCAR-\d+/i;
// `#12`, and the references GitHub links elsewhere: `repo#12`,
// `owner/repo#12`, `GH-12`, `/pull/12`.
const PR_NUMBER = /#\d|\bGH-\d|\/pull\/\d+/i;
// `@name`: GitHub notifies that user wherever the text is posted.
const MENTION = /(^|[^\w`])@[A-Za-z0-9-]/;

/** `text` with control and bidi characters as `?`: safe to print to a terminal. */
export function printable(text: string): string {
	return text.replace(new RegExp(CONTROL_OR_BIDI.source, "g"), "?");
}

/** The text with every `code` span blanked (same length), or null when a backtick is unpaired. */
function withoutCode(text: string): string | null {
	const parts = text.split("`");
	if (parts.length % 2 === 0) return null;
	return parts
		.map((p, i) => (i % 2 === 1 ? " ".repeat(p.length + 2) : p))
		.join("")
		.slice(0, text.length);
}

/**
 * Why `text` can't be a release note (empty: it can). Plain text, one
 * line, at most `MAX_NOTE_CHARS`, no lowercase first letter, no control or
 * bidi characters, no markup but `code` in backticks, no ticket ids or
 * PR or issue references (the tools add those), no @mentions.
 */
export function noteTextProblems(text: string): string[] {
	const problems: string[] = [];
	if (typeof text !== "string" || text.trim() === "") return ["is empty"];
	if (text !== text.trim()) problems.push("has leading or trailing spaces");
	if ([...text].length > MAX_NOTE_CHARS)
		problems.push(`is over ${MAX_NOTE_CHARS} characters`);
	if (CONTROL_OR_BIDI.test(text))
		problems.push("has a line break, control or bidi character");
	// A capital, or `code` or a digit; never a lowercase letter.
	if (/^\p{Ll}/u.test(text)) problems.push("starts with a lowercase letter");
	const prose = withoutCode(text);
	if (prose === null) {
		problems.push("has an unpaired backtick");
		return problems;
	}
	if (/<[a-zA-Z/!?]/.test(prose))
		problems.push("has HTML (put code in backticks)");
	if (
		/\[[^\]]*\]\([^)]*\)/.test(prose) ||
		/\b(https?|javascript|data):/i.test(prose)
	) {
		problems.push("has a link (crb adds the PR links)");
	}
	if (/\*\*|__|~~|^#{1,6}\s|^>\s|^[-*+]\s/.test(prose))
		problems.push("has markdown (only `code` is allowed)");
	if (TICKET_ID.test(prose))
		problems.push("names a ticket (the tools add the ids)");
	if (PR_NUMBER.test(prose))
		problems.push("names a PR or issue (the tools add the numbers)");
	if (MENTION.test(prose))
		problems.push("mentions someone (@name notifies them on GitHub)");
	return problems;
}

/** Why `why` can't be a `none` reason (empty: it can). */
export function noneWhyProblems(why: string): string[] {
	if (typeof why !== "string" || why.trim() === "")
		return ["is empty (say why no note is needed)"];
	const problems: string[] = [];
	if ([...why].length > MAX_NONE_WHY_CHARS)
		problems.push(`is over ${MAX_NONE_WHY_CHARS} characters`);
	if (CONTROL_OR_BIDI.test(why))
		problems.push("has a line break, control or bidi character");
	if (/[()]/.test(why)) problems.push("has parentheses");
	return problems;
}

/**
 * A note's first sentence: the summary shown before Show more. Ends at
 * the first `.`, `!` or `?` followed by a space or the end, outside
 * `code` spans; the whole text when there is none.
 */
export function noteSummary(text: string): string {
	const prose = withoutCode(text) ?? text;
	const m = /[.!?](?=\s|$)/.exec(prose);
	return m ? text.slice(0, m.index + 1) : text;
}

/** The rank of a kind in a list of notes: new, improved, fixed. */
export function kindRank(kind: NoteKind): number {
	return NOTE_KINDS.indexOf(kind);
}

/** Notes in file order: new, improved, fixed; within a kind by first PR, then id. */
export function sortNotes<
	T extends { kind: NoteKind; prs: number[]; id: string },
>(notes: T[]): T[] {
	return [...notes].sort(
		(a, b) =>
			kindRank(a.kind) - kindRank(b.kind) ||
			(a.prs[0] ?? 0) - (b.prs[0] ?? 0) ||
			a.id.localeCompare(b.id),
	);
}

/** Compares `X.Y.Z` versions (no prerelease). */
export function compareReleaseVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function prsProblem(v: unknown): string | null {
	if (!Array.isArray(v) || v.length > 200)
		return "prs isn't a list of PR numbers";
	if (!v.every((n) => Number.isSafeInteger(n) && n > 0))
		return "prs isn't a list of PR numbers";
	return null;
}

/** Why `v` isn't a valid note (null: it is). */
export function releaseNoteProblem(v: unknown): string | null {
	if (!isRecord(v)) return "isn't an object";
	if (typeof v.id !== "string" || !NOTE_ID.test(v.id))
		return "id isn't CAR-N or #N";
	if (
		typeof v.kind !== "string" ||
		!(NOTE_KINDS as readonly string[]).includes(v.kind)
	) {
		return `${v.id}: kind isn't new, improved or fixed`;
	}
	const prs = prsProblem(v.prs);
	if (prs) return `${v.id}: ${prs}`;
	if (typeof v.text !== "string") return `${v.id}: text isn't a string`;
	const problems = noteTextProblems(v.text);
	if (problems.length > 0) return `${v.id}: text ${problems.join(", ")}`;
	return null;
}

function noneProblem(v: unknown): string | null {
	if (!isRecord(v)) return "isn't an object";
	if (typeof v.id !== "string" || !NOTE_ID.test(v.id))
		return "id isn't CAR-N or #N";
	const prs = prsProblem(v.prs);
	if (prs) return `${v.id}: ${prs}`;
	if (typeof v.why !== "string") return `${v.id}: why isn't a string`;
	const problems = noneWhyProblems(v.why);
	if (problems.length > 0) return `${v.id}: why ${problems.join(", ")}`;
	return null;
}

function toNote(v: Record<string, unknown>): ReleaseNote {
	return {
		id: v.id as string,
		kind: v.kind as NoteKind,
		prs: [...(v.prs as number[])],
		text: v.text as string,
	};
}

/**
 * Reads a `release-notes/X.Y.Z.json` strictly: every problem is listed,
 * and any problem refuses the file (the tooling and CI's check).
 */
export function parseReleaseNotesFile(
	value: unknown,
): { ok: true; file: ReleaseNotesFile } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (!isRecord(value)) return { ok: false, errors: ["isn't a JSON object"] };
	if (typeof value.version !== "string" || !VERSION.test(value.version))
		errors.push("version isn't X.Y.Z");
	if (
		value.date !== null &&
		(typeof value.date !== "string" || !DATE.test(value.date))
	) {
		errors.push("date isn't YYYY-MM-DD or null");
	}
	const notes: ReleaseNote[] = [];
	const none: ReleaseNoneEntry[] = [];
	if (!Array.isArray(value.notes)) errors.push("notes isn't a list");
	else {
		value.notes.forEach((n, i) => {
			const p = releaseNoteProblem(n);
			if (p) errors.push(`notes[${i}] ${p}`);
			else notes.push(toNote(n as Record<string, unknown>));
		});
	}
	if (!Array.isArray(value.none)) errors.push("none isn't a list");
	else {
		value.none.forEach((n, i) => {
			const p = noneProblem(n);
			if (p) errors.push(`none[${i}] ${p}`);
			else {
				const r = n as Record<string, unknown>;
				none.push({
					id: r.id as string,
					prs: [...(r.prs as number[])],
					why: r.why as string,
				});
			}
		});
	}
	const extra = Object.keys(value).filter(
		(k) => !["version", "date", "notes", "none"].includes(k),
	);
	if (extra.length > 0) errors.push(`unknown fields: ${extra.join(", ")}`);
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		file: {
			version: value.version as string,
			date: value.date as string | null,
			notes,
			none,
		},
	};
}

/**
 * Reads shipped notes (`crbReleaseNotes` from npm, or
 * `dist/release-notes.json`) leniently: a bad note is dropped, a bad
 * version entry is dropped whole, and `dropped` counts both, so the UI
 * can say "1 note couldn't be read". Null when `value` isn't a list at
 * all (no notes in this version).
 */
export function parseShippedReleaseNotes(
	value: unknown,
): { entries: ShippedReleaseNotes[]; dropped: number } | null {
	if (!Array.isArray(value)) return null;
	const entries: ShippedReleaseNotes[] = [];
	let dropped = 0;
	for (const e of value.slice(0, 100)) {
		if (
			!isRecord(e) ||
			typeof e.version !== "string" ||
			!VERSION.test(e.version) ||
			(e.date !== null && (typeof e.date !== "string" || !DATE.test(e.date))) ||
			!Array.isArray(e.notes)
		) {
			dropped++;
			continue;
		}
		const notes: ReleaseNote[] = [];
		for (const n of e.notes) {
			if (releaseNoteProblem(n) === null)
				notes.push(toNote(n as Record<string, unknown>));
			else dropped++;
		}
		const entry: ShippedReleaseNotes = {
			version: e.version,
			date: e.date as string | null,
			notes,
		};
		if (e.uncovered !== undefined) {
			if (prsProblem(e.uncovered) === null)
				entry.uncovered = [...(e.uncovered as number[])];
			else dropped++;
		}
		entries.push(entry);
	}
	return { entries, dropped };
}
