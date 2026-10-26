/**
 * A comment's body as GitHub renders it, its suggested changes drawn as
 * mini diffs; and the code rows those and the Overview's code pane share.
 */
import { LightBulbIcon } from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { type HunkLine, numberOn } from "../../shared/diffHunk";
import type { ReviewThread } from "../../shared/types";
import { reviewQuery } from "../api";
import { CodeLine } from "../code/Invisibles";
import { languageFor } from "../files/highlight";
import { GithubHtml } from "../GithubHtml";
import { splitSuggestions } from "../overview/suggestions";

type Thread = ReviewThread;

const ROW_BG: Record<HunkLine["kind"], string> = {
	context: "",
	add: "bg-add",
	del: "bg-del",
};
const NUMBER_BG: Record<HunkLine["kind"], string> = {
	context: "text-faint",
	add: "bg-add-gutter text-add-ink",
	del: "bg-del-gutter text-del-ink",
};
const SIGN: Record<HunkLine["kind"], string> = {
	context: " ",
	add: "+",
	del: "−",
};
const SIGN_COLOR: Record<HunkLine["kind"], string> = {
	context: "text-faint",
	add: "text-add-ink",
	del: "text-del-ink",
};

/** The file's tab width (.editorconfig), once the review has loaded. */
function useTabWidth(path: string): number | undefined {
	const review = useQuery(reviewQuery);
	return review.data?.files.find((f) => f.path === path)?.tabWidth;
}

/**
 * Code lines as diff rows, one way for the code pane and suggested changes:
 * a rail (accent and tinted when marked), old and new numbers, the sign,
 * and the text through CodeLine (Shiki, invisibles, the file's tabs).
 */
export function CodeRows(props: {
	lines: (HunkLine & { marked?: boolean })[];
	path: string;
	wrap: boolean;
	testId: string;
}) {
	const lang = languageFor(props.path);
	const tabWidth = useTabWidth(props.path);
	return (
		<tbody>
			{props.lines.map((line, i) => (
				<tr
					// The lines of one block never reorder.
					// biome-ignore lint/suspicious/noArrayIndexKey: see above.
					key={i}
					data-testid={props.testId}
					data-marked={line.marked || undefined}
					className={`${ROW_BG[line.kind]} ${line.marked ? "mark-tint" : ""}`}
				>
					<td
						aria-hidden
						className={`w-1 min-w-1 p-0 ${line.marked ? "bg-accent" : ""}`}
					/>
					<td
						className={`w-px px-1.5 text-right align-top whitespace-nowrap select-none ${NUMBER_BG[line.kind]}`}
					>
						{line.oldNo}
					</td>
					<td
						className={`w-px px-1.5 text-right align-top whitespace-nowrap select-none ${NUMBER_BG[line.kind]}`}
					>
						{line.newNo}
					</td>
					<td
						aria-hidden
						className={`w-px pl-2 align-top select-none ${SIGN_COLOR[line.kind]}`}
					>
						{SIGN[line.kind]}
					</td>
					<td
						className={`pr-2 pl-1.5 ${props.wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"}`}
					>
						<CodeLine
							text={line.text}
							lang={lang}
							tabWidth={tabWidth}
							newline={!line.noNewline}
						/>
					</td>
				</tr>
			))}
		</tbody>
	);
}

/**
 * A suggested change as a mini diff: the commented lines deleted, the
 * suggestion added (none: the lines go). Read-only, no "apply".
 */
function SuggestedChange(props: {
	path: string;
	removed: HunkLine[];
	added: HunkLine[];
	/** Wrapped once the comment is opened, like the code pane. */
	wrap: boolean;
}) {
	const lines = [...props.removed, ...props.added];
	return (
		<figure
			aria-label="Suggested change"
			data-testid="suggestion"
			className="my-2 min-w-0 overflow-hidden rounded-md border border-line bg-code font-mono text-xs leading-5 text-code-ink"
		>
			<figcaption className="flex min-h-8 items-center gap-1.5 border-b border-line bg-band px-2 font-sans text-xs font-medium text-ink-soft">
				<LightBulbIcon size={14} aria-hidden className="text-warn" />
				Suggested change
			</figcaption>
			<div className="overflow-x-auto [scrollbar-width:thin]">
				{lines.length > 0 ? (
					<table className="w-full border-collapse">
						<CodeRows
							lines={lines}
							path={props.path}
							wrap={props.wrap}
							testId="suggestion-line"
						/>
					</table>
				) : null}
			</div>
		</figure>
	);
}

/**
 * The deleted rows of a suggestion: the thread's commented lines on its own
 * side, numbered, when they are the lines GitHub's block replaces; GitHub's
 * own text without numbers when the thread has no code; null when the two
 * disagree (the caller then shows GitHub's HTML).
 */
export function suggestionRemoved(
	code: Thread["code"],
	removed: string[],
): HunkLine[] | null {
	const strip = (t: string) => t.replace(/\r$/, "");
	if (!code || code.rows.length === 0) {
		return removed.map((text) => ({
			kind: "del",
			oldNo: null,
			newNo: null,
			text,
		}));
	}
	const side = code.anchor.side;
	const own = code.rows.filter((l) => l.marked && numberOn(l, side) !== null);
	if (
		own.length !== removed.length ||
		own.some((l, i) => strip(l.text) !== strip(removed[i] ?? ""))
	) {
		return null;
	}
	return own.map((l) => ({
		kind: "del",
		oldNo: numberOn(l, side),
		newNo: null,
		text: l.text,
	}));
}

/**
 * A comment as GitHub renders it, its suggested changes drawn as mini
 * diffs of the thread's commented lines (suggestions.ts), in the opener and
 * in replies alike. Whenever that can't be done exactly, the whole comment
 * is GitHub's HTML, as it was: nothing is dropped.
 */
export function CommentBody(props: {
	html: string;
	body: string;
	/** The thread's code: what its suggestions replace. */
	code: Thread["code"];
	path: string;
	/** Opened: suggestions wrap like the code pane. */
	open: boolean;
}) {
	const { html, body, code } = props;
	const parts = useMemo(() => {
		const split = splitSuggestions(html, body);
		if (!split) return null;
		const out: (
			| { kind: "html"; html: string }
			| { kind: "suggestion"; removed: HunkLine[]; added: HunkLine[] }
		)[] = [];
		for (const part of split) {
			if (part.kind === "html") {
				out.push(part);
				continue;
			}
			const removed = suggestionRemoved(code, part.removed);
			if (!removed) return null;
			const first = removed[0]?.oldNo ?? null;
			out.push({
				kind: "suggestion",
				removed,
				added: part.added.map((text, i) => ({
					kind: "add",
					oldNo: null,
					newNo: first === null ? null : first + i,
					text,
				})),
			});
		}
		return out;
	}, [html, body, code]);
	if (!parts) return <GithubHtml html={html} />;
	return (
		<>
			{parts.map((part, i) =>
				part.kind === "html" ? (
					// Fixed order, never reordered.
					// biome-ignore lint/suspicious/noArrayIndexKey: see above.
					<GithubHtml key={i} html={part.html} />
				) : (
					<SuggestedChange
						// biome-ignore lint/suspicious/noArrayIndexKey: see above.
						key={i}
						path={props.path}
						removed={part.removed}
						added={part.added}
						wrap={props.open}
					/>
				),
			)}
		</>
	);
}
