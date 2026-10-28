import type { DiffLine, DisplayHunk } from "../../shared/types";
import type { SpanRange } from "./spanMarks";

/**
 * A line comment's code as it was written on: every line of its span, and
 * up to CONTEXT lines of its hunk before and after it (GitHub's order).
 */
export interface LineTexts {
	lines: string[];
	before: string[];
	after: string[];
}

/** Context lines kept on each side. */
export const CONTEXT = 3;

export function isLineTexts(v: unknown): v is LineTexts {
	if (typeof v !== "object" || v === null) return false;
	const t = v as Partial<LineTexts>;
	const strings = (a: unknown) =>
		Array.isArray(a) && a.every((s) => typeof s === "string");
	return strings(t.lines) && strings(t.before) && strings(t.after);
}

const numberOn = (l: DiffLine, side: SpanRange["startSide"]) =>
	side === "RIGHT" ? l.newNo : l.oldNo;

/**
 * The span's lines and their context in the hunks shown, or null when an
 * end isn't a hunk's line (expanded context, or not in the diff), or the
 * start comes after the end.
 */
export function spanTexts(
	hunks: readonly DisplayHunk[],
	span: SpanRange,
): LineTexts | null {
	const rows = hunks.flatMap((h, hunk) =>
		h.lines.map((line) => ({ line, hunk })),
	);
	const start = rows.findIndex(
		(r) => numberOn(r.line, span.startSide) === span.startLine,
	);
	const end = rows.findIndex((r) => numberOn(r.line, span.side) === span.line);
	if (start < 0 || end < 0 || start > end) return null;
	const first = rows[start] as (typeof rows)[number];
	const last = rows[end] as (typeof rows)[number];
	const before: string[] = [];
	for (let i = start - 1; i >= 0 && before.length < CONTEXT; i--) {
		const r = rows[i] as (typeof rows)[number];
		if (r.hunk !== first.hunk) break;
		before.unshift(r.line.text);
	}
	const after: string[] = [];
	for (let i = end + 1; i < rows.length && after.length < CONTEXT; i++) {
		const r = rows[i] as (typeof rows)[number];
		if (r.hunk !== last.hunk) break;
		after.push(r.line.text);
	}
	return {
		lines: rows.slice(start, end + 1).map((r) => r.line.text),
		before,
		after,
	};
}

/** Lines that say something on their own (not blank, not a lone `}`). */
const distinctive = (lines: readonly string[]) =>
	lines.some((l) => /[\p{L}\p{N}_]{3,}/u.test(l));

/**
 * Whether a draft written on `stored` may move to lines reading `now` (the
 * same side and numbers on the new head): every line of its span the same,
 * and the context both sides still have the same too; with fewer than two
 * context lines to agree on, only a span that says something on its own
 * (never a blank line or a lone brace, which repeat everywhere).
 */
export function canMove(stored: unknown, now: LineTexts | null): boolean {
	if (!now || !isLineTexts(stored)) return false;
	if (
		stored.lines.length !== now.lines.length ||
		stored.lines.some((l, i) => l !== now.lines[i])
	) {
		return false;
	}
	const kb = Math.min(stored.before.length, now.before.length);
	const ka = Math.min(stored.after.length, now.after.length);
	const beforeSame = stored.before
		.slice(stored.before.length - kb)
		.every((l, i) => l === now.before[now.before.length - kb + i]);
	const afterSame = stored.after
		.slice(0, ka)
		.every((l, i) => l === now.after[i]);
	if (!beforeSame || !afterSame) return false;
	return kb + ka >= 2 || distinctive(stored.lines);
}
