import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, type ReactNode, useEffect, useMemo } from "react";
import { highlightLine } from "../files/highlight";
import { Tooltip } from "../Tooltip";
import { showInvisibles } from "../viewSettings";
import { DEFAULT_TAB_WIDTH, type Piece, renderInvisibles } from "./invisibles";

export const INVISIBLES_STORAGE_KEY = showInvisibles.key;

/** The remembered "Show hidden characters" setting: shown unless turned off (or storage is unavailable). */
export const readShowInvisibles = (): boolean => showInvisibles.read();

/** Every code view shares one choice (Settings), remembered for this viewer. */
export const setShowInvisibles = (next: boolean): void =>
	showInvisibles.set(next);

/** Forgets the in-memory choice (tests), so the next read is from storage. */
export const resetShowInvisibles = (): void => showInvisibles.reset();

export const useShowInvisibles = (): boolean => showInvisibles.use();

/**
 * A marker drawn as CSS generated content (never selected, copied or read
 * out), over the original character kept in the DOM at zero size, so a copy
 * gives back exactly the code. The zero-size character is isolated: a bidi
 * control can't reorder the text around it.
 */
const MARK =
	"text-faint before:content-[attr(data-glyph)_/_''] [&>span]:text-[0px] [&>span]:leading-[0] [&>span]:[unicode-bidi:isolate]";
const BIDI = "rounded-sm bg-warn/15 text-warn";

function Marker(props: { piece: Exclude<Piece, { kind: "text" }> }): ReactNode {
	const { piece } = props;
	const raw = piece.raw ? <span>{piece.raw}</span> : null;
	switch (piece.kind) {
		case "space":
			return (
				<span
					data-inv="space"
					data-glyph={"·".repeat(piece.raw.length)}
					className={MARK}
				>
					{raw}
				</span>
			);
		case "tab":
			return (
				<span
					data-inv="tab"
					data-glyph={piece.marker ? "\\t" : ""}
					className={`inline-block ${MARK}`}
					style={{ width: `${piece.columns}ch` }}
				>
					{raw}
				</span>
			);
		case "escape": {
			const name = piece.bidi
				? `${piece.name}: reorders how the code displays`
				: piece.name;
			return (
				<Tooltip content={name} describe={false} lazy>
					{(trigger) => (
						// Focusable without a tab stop, so a tap shows the name.
						<span
							{...trigger}
							role="img"
							aria-label={name}
							tabIndex={-1}
							data-inv={piece.bidi ? "bidi" : "escape"}
							data-glyph={piece.label}
							className={`${MARK} ${piece.bidi ? BIDI : ""} focus-visible:outline-2 focus-visible:outline-accent`}
						>
							{raw}
						</span>
					)}
				</Tooltip>
			);
		}
		case "eol":
			return (
				<span data-inv="eol" data-glyph={piece.label} className={MARK}>
					{raw}
				</span>
			);
	}
}

/** Blanks that a browser's plain-text copy turns into ordinary spaces. */
const BLANK = /(?! )[\p{Zs}\p{Zl}\p{Zp}]/u;

/** Content a browser leaves out of a copy. */
function unselectable(el: Element): boolean {
	if (el.classList.contains("select-none")) return true;
	const style = getComputedStyle(el);
	return (
		style.userSelect === "none" ||
		style.getPropertyValue("-webkit-user-select") === "none" ||
		style.display === "none"
	);
}

/**
 * The text of a range, the way a copy should give it: every character as it
 * is, rows on their own lines, cells apart by a tab, unselectable content
 * left out. Reads the DOM only.
 */
export function rangeText(range: Range): string {
	const root = range.commonAncestorContainer;
	const scope = root.nodeType === Node.TEXT_NODE ? root.parentNode : root;
	if (!scope) return "";
	let out = "";
	let row: Element | null = null;
	let cell: Element | null = null;
	const walker = document.createTreeWalker(
		scope,
		NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
		{
			acceptNode: (node) =>
				node instanceof Element && unselectable(node)
					? NodeFilter.FILTER_REJECT
					: NodeFilter.FILTER_ACCEPT,
		},
	);
	const visit = (node: Node) => {
		if (!(node instanceof Text) || !range.intersectsNode(node)) return;
		let data = node.data;
		if (node === range.endContainer) data = data.slice(0, range.endOffset);
		if (node === range.startContainer) {
			data = data.slice(range.startOffset);
		}
		if (data === "") return;
		const parent = node.parentElement;
		const nextRow = parent?.closest("tr, [role=row]") ?? null;
		const nextCell = parent?.closest("td, th, [role=cell]") ?? null;
		if (out !== "" && nextRow !== row) out += "\n";
		else if (out !== "" && nextCell !== cell) out += "\t";
		row = nextRow;
		cell = nextCell;
		out += data;
	};
	for (let n = walker.nextNode(); n; n = walker.nextNode()) visit(n);
	return out;
}

/**
 * Chrome copies a no-break space (and its kin) as a plain space. When a
 * selection holds one inside code, the copied text is read from the DOM
 * instead (without touching it), and the HTML the browser would copy is
 * kept alongside.
 */
export function copyWithOriginals(event: ClipboardEvent): void {
	const selection = document.getSelection();
	if (!selection || selection.rangeCount === 0 || !event.clipboardData) return;
	const ranges = Array.from({ length: selection.rangeCount }, (_, i) =>
		selection.getRangeAt(i),
	);
	const needed = ranges.some((range) => {
		const root = range.commonAncestorContainer;
		const scope = root instanceof Element ? root : root.parentElement;
		const raws = [
			...(scope?.querySelectorAll("[data-inv] > span") ?? []),
			...(scope?.closest("[data-inv] > span") ? [scope] : []),
		];
		return raws.some(
			(span) =>
				BLANK.test(span.textContent ?? "") && range.intersectsNode(span),
		);
	});
	if (!needed) return;
	const html = document.createElement("div");
	for (const range of ranges) html.append(range.cloneContents());
	event.clipboardData.setData("text/plain", ranges.map(rangeText).join("\n"));
	event.clipboardData.setData("text/html", html.innerHTML);
	event.preventDefault();
}

let copyFixInstalled = false;

export type Token = {
	content: string;
	offset: number;
	color?: string;
	fontStyle?: number;
};

const tokenStyle = (token: Token): CSSProperties => ({
	color: token.color,
	fontStyle: token.fontStyle && token.fontStyle & 1 ? "italic" : undefined,
	fontWeight: token.fontStyle && token.fontStyle & 2 ? "bold" : undefined,
});

/** A run of text, and the highlighting token that colors it (if any). */
export type Segment = { text: string; token?: Token };

/**
 * Cuts each text piece by the highlighting tokens it overlaps, walking pieces
 * and tokens once together (both are in line order).
 */
export function colorPieces(pieces: Piece[], tokens: Token[]): Segment[][] {
	const out: Segment[][] = [];
	let t = 0;
	for (const piece of pieces) {
		const segments: Segment[] = [];
		out.push(segments);
		if (piece.kind !== "text") continue;
		const { raw, start } = piece;
		const end = start + raw.length;
		while (
			t < tokens.length &&
			(tokens[t] as Token).offset + (tokens[t] as Token).content.length <= start
		) {
			t++;
		}
		let at = start;
		for (let k = t; k < tokens.length; k++) {
			const token = tokens[k] as Token;
			if (token.offset >= end) break;
			const from = Math.max(at, token.offset);
			const to = Math.min(end, token.offset + token.content.length);
			if (to <= from) continue;
			if (from > at)
				segments.push({ text: raw.slice(at - start, from - start) });
			segments.push({ text: raw.slice(from - start, to - start), token });
			at = to;
		}
		if (at < end) segments.push({ text: raw.slice(at - start) });
	}
	return out;
}

/** A span's characters in a line: UTF-16 offsets, `to` exclusive. */
export type Mark = readonly [from: number, to: number];

/** A find hit over a line's characters; `current` is the one being stepped on. */
export interface FindMark {
	from: number;
	to: number;
	current: boolean;
}

/** How a find paints a stretch of characters: the current hit wins over the rest. */
function findAt(
	finds: readonly FindMark[],
	from: number,
	to: number,
): "mark" | "current" | undefined {
	let found: "mark" | "current" | undefined;
	for (const find of finds) {
		if (find.from < to && find.to > from) {
			if (find.current) return "current";
			found = "mark";
		}
	}
	return found;
}

/**
 * The parts of `text` (starting at offset `start`) inside and outside the
 * marks, cut at the finds' edges too; a part a find covers carries `find`.
 */
export function splitMarks(
	text: string,
	start: number,
	marks: readonly Mark[],
	finds: readonly FindMark[] = [],
): { text: string; marked: boolean; find?: "mark" | "current" }[] {
	const end = start + text.length;
	const cuts = new Set([start, end]);
	const edges = [
		...marks.flat(),
		...finds.flatMap(({ from, to }) => [from, to]),
	];
	for (const at of edges) if (at > start && at < end) cuts.add(at);
	const points = [...cuts].sort((a, b) => a - b);
	const parts: { text: string; marked: boolean; find?: "mark" | "current" }[] =
		[];
	for (let i = 0; i + 1 < points.length; i++) {
		const from = points[i] as number;
		const to = points[i + 1] as number;
		const find = findAt(finds, from, to);
		parts.push({
			text: text.slice(from - start, to - start),
			marked: marks.some(([f, t]) => f <= from && to <= t),
			...(find ? { find } : {}),
		});
	}
	return parts;
}

/** A thread's exact span over its characters (`span-mark`, index.css). */
const MARKED = "span-mark";

/** A find hit (`find-mark`) and the current one (`find-current`), index.css; over a span. */
const FIND_CLASS = { mark: "find-mark", current: "find-current" } as const;

/** A run of ordinary text, colored by the highlighting tokens it overlaps. */
function TextRun(props: {
	start: number;
	segments: Segment[];
	marks: readonly Mark[];
	finds: readonly FindMark[];
}) {
	let at = props.start;
	return (
		<>
			{props.segments.flatMap((segment) => {
				const from = at;
				at += segment.text.length;
				const parts =
					props.marks.length || props.finds.length
						? splitMarks(segment.text, from, props.marks, props.finds)
						: [{ text: segment.text, marked: false }];
				let offset = from;
				return parts.map((part) => {
					const key = offset;
					offset += part.text.length;
					const style = segment.token ? tokenStyle(segment.token) : undefined;
					const find = "find" in part ? part.find : undefined;
					const span = part.marked && !find;
					return span || find || style ? (
						<span
							key={key}
							style={style}
							data-span-mark={span || undefined}
							data-find-mark={find === "mark" || undefined}
							data-find-current={find === "current" || undefined}
							className={find ? FIND_CLASS[find] : span ? MARKED : undefined}
						>
							{part.text}
						</span>
					) : (
						part.text
					);
				});
			})}
		</>
	);
}

const NO_MARKS: readonly Mark[] = [];
const NO_FINDS: readonly FindMark[] = [];

/** The wrapper a hidden-character marker takes when a find or a span covers it. */
function wrapped(
	piece: Exclude<Piece, { kind: "text" }>,
	marks: readonly Mark[],
	finds: readonly FindMark[],
): Record<string, string | true> | null {
	const to = piece.start + piece.raw.length;
	const find = findAt(finds, piece.start, to);
	if (find) {
		return find === "current"
			? { "data-find-current": true, className: FIND_CLASS.current }
			: { "data-find-mark": true, className: FIND_CLASS.mark };
	}
	return marks.some(([f, t]) => f < to && t > piece.start)
		? { "data-span-mark": true, className: MARKED }
		: null;
}

/**
 * One line of code, highlighted (plain until the highlighting arrives), with
 * its invisible characters shown (Notepad++ style, see invisibles.ts).
 * `newline`: a newline follows the line (false before git's "No newline at
 * end of file"). Copying the line copies the original text. `marks`: a
 * thread's exact characters, painted; `finds`: search hits, painted over
 * them (the current one apart). The line's text is in one
 * `[data-code]` element holding only its characters (codeSpan.ts reads
 * columns from it).
 */
export function CodeLine(props: {
	text: string;
	lang: string | null;
	tabWidth?: number;
	newline?: boolean;
	marks?: readonly Mark[];
	finds?: readonly FindMark[];
}) {
	const { text, lang, newline = true } = props;
	const show = useShowInvisibles();
	useEffect(() => {
		if (copyFixInstalled) return;
		copyFixInstalled = true;
		document.addEventListener("copy", copyWithOriginals);
	}, []);
	const tokens = useQuery({
		queryKey: ["highlight", lang, text],
		// A CR would start a new line for the highlighter: a space keeps the
		// offsets and the rest of the line.
		queryFn: () => highlightLine(text.replaceAll("\r", " "), lang),
		enabled: lang !== null && text.length > 0,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const tabWidth = props.tabWidth ?? DEFAULT_TAB_WIDTH;
	const pieces = useMemo(
		() => renderInvisibles(text, tabWidth, { newline, show }),
		[text, tabWidth, newline, show],
	);
	const segments = useMemo(
		() => colorPieces(pieces, tokens.data ?? []),
		[pieces, tokens.data],
	);
	const marks = props.marks ?? NO_MARKS;
	const finds = props.finds ?? NO_FINDS;
	return (
		<span data-code="">
			{pieces.map((piece, i) =>
				piece.kind === "text" ? (
					tokens.data?.length || marks.length || finds.length ? (
						<TextRun
							key={piece.start}
							start={piece.start}
							segments={
								tokens.data?.length
									? (segments[i] ?? [])
									: [{ text: piece.raw }]
							}
							marks={marks}
							finds={finds}
						/>
					) : (
						piece.raw
					)
				) : wrapped(piece, marks, finds) ? (
					<span
						key={`${piece.kind}${piece.start}`}
						{...wrapped(piece, marks, finds)}
					>
						<Marker piece={piece} />
					</span>
				) : (
					<Marker key={`${piece.kind}${piece.start}`} piece={piece} />
				),
			)}
		</span>
	);
}
