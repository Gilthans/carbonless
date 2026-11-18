import type { ReleaseNote } from "./releaseNotes.js";

/** One version's part of What's new, as crb prepared it for the page. */
export interface NotesSection {
	/** The version shown: a release, or the offered RC for the upcoming release's notes. */
	version: string;
	/** When it was released (`YYYY-MM-DD`); null: not known (an RC, or a release's own build). */
	date: string | null;
	notes: ReleaseNote[];
	/** PRs merged with no note yet (an RC's build); empty for a release. */
	uncovered: number[];
	/** It has a GitHub release to link (a release, not an RC), dated or not. */
	released: boolean;
}

/** `GET /api/update/notes`: what's new between the running crb and the offered one. */
export interface UpdateNotes {
	current: string;
	available: string;
	/** Newest first. */
	sections: NotesSection[];
	/** The offered version's notes don't reach back to the running one. */
	older: boolean;
	/** Notes that couldn't be read (malformed), left out. */
	dropped: number;
}

/** `GET /api/release-notes`: the running crb's own notes (its package's file). */
export interface OwnNotes {
	current: string;
	/** The package has no notes file (a local build): nothing to show. */
	file: boolean;
	/** The running version's notes; null when the file has no entry for it. */
	running: NotesSection | null;
	/** Earlier releases in the file, newest first. */
	earlier: NotesSection[];
	dropped: number;
}

const REPO = "https://github.com/Gilthans/carbonless";

/** Every release on GitHub. */
export const RELEASES_URL = `${REPO}/releases`;

/** PR `n` on GitHub; null unless `n` is a PR number. */
export const prUrl = (n: number): string | null =>
	Number.isInteger(n) && n > 0 && n < 1e7 ? `${REPO}/pull/${n}` : null;

/** GitHub's compare view between two versions' tags. */
export const compareUrl = (from: string, to: string): string =>
	`${REPO}/compare/v${encodeURIComponent(from)}...v${encodeURIComponent(to)}`;

/**
 * A note's first sentence (its summary) and the rest: the first `.`, `!`
 * or `?` followed by a space, outside `code`. `rest` is empty for a note
 * of one sentence.
 */
export function splitNote(text: string): { first: string; rest: string } {
	let inCode = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "`") inCode = !inCode;
		else if (
			!inCode &&
			(c === "." || c === "!" || c === "?") &&
			/\s/.test(text[i + 1] ?? "")
		) {
			const rest = text.slice(i + 1).trim();
			if (rest) return { first: text.slice(0, i + 1), rest };
		}
	}
	return { first: text, rest: "" };
}

/**
 * A note's text in parts: plain text and `code` spans (backticks, the one
 * markup a note has). An unclosed backtick stays as text.
 */
export function noteParts(text: string): { code: boolean; text: string }[] {
	const parts: { code: boolean; text: string }[] = [];
	const pieces = text.split("`");
	// An odd count of backticks: the last one opens nothing.
	const closed = pieces.length % 2 === 1;
	pieces.forEach((piece, i) => {
		const code = i % 2 === 1 && (closed || i < pieces.length - 1);
		const value = code || i % 2 === 0 ? piece : `\`${piece}`;
		if (!value) return;
		const last = parts.at(-1);
		if (last && !last.code && !code) last.text += value;
		else parts.push({ code, text: value });
	});
	return parts;
}
