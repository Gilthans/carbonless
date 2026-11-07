import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, type ReactNode, useEffect, useMemo } from "react";
import { highlightLine } from "../files/highlight";
import { Tooltip } from "../Tooltip";
import { showInvisibles } from "../viewSettings";
import {
	DEFAULT_TAB_WIDTH,
	type Piece,
	renderInvisibles,
} from "./invisibleChars";

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

/**
 * The parts of `text` (starting at offset `start`) cut at the ranges'
 * edges, each with the index of the range holding it (-1: none). The
 * ranges are sorted and don't overlap.
 */
function cutRanges(
	text: string,
	start: number,
	ranges: readonly Mark[],
): { text: string; at: number }[] {
	const end = start + text.length;
	const parts: { text: string; at: number }[] = [];
	let from = start;
	for (let i = 0; i < ranges.length && from < end; i++) {
		const [f, t] = ranges[i] as Mark;
		if (t <= from) continue;
		if (f >= end) break;
		if (f > from)
			parts.push({ text: text.slice(from - start, f - start), at: -1 });
		const to = Math.min(t, end);
		const at = Math.max(f, from);
		parts.push({ text: text.slice(at - start, to - start), at: i });
		from = to;
	}
	if (from < end) parts.push({ text: text.slice(from - start), at: -1 });
	return parts;
}

/** The parts of `text` (starting at offset `start`) inside and outside the marks. */
export function splitMarks(
	text: string,
	start: number,
	marks: readonly Mark[],
): { text: string; marked: boolean }[] {
	const end = start + text.length;
	const cuts = new Set([start, end]);
	for (const [from, to] of marks) {
		if (from > start && from < end) cuts.add(from);
		if (to > start && to < end) cuts.add(to);
	}
	const points = [...cuts].sort((a, b) => a - b);
	const parts: { text: string; marked: boolean }[] = [];
	for (let i = 0; i + 1 < points.length; i++) {
		const from = points[i] as number;
		const to = points[i + 1] as number;
		parts.push({
			text: text.slice(from - start, to - start),
			marked: marks.some(([f, t]) => f <= from && to <= t),
		});
	}
	return parts;
}

/** A thread's exact span over its characters (`span-mark`, index.css). */
const MARKED = "span-mark";

/**
 * A pair's word marks on a line (wordBlocks.ts): the changed tokens, and the
 * tint they take, by the line's kind and whether its cluster is reviewed.
 */
export interface Words {
	marks: readonly Mark[];
	tone: "add" | "del" | "add-done" | "del-done";
	/**
	 * The change doesn't show while hidden characters are off
	 * (hiddenChange.ts): its code cell warns in the sign's place.
	 */
	hidden?: boolean;
}

/** Each tone's tint (index.css; written out whole, for Tailwind). */
const WORD_BG: Record<Words["tone"], string> = {
	add: "bg-add-word",
	del: "bg-del-word",
	"add-done": "bg-add-word-done",
	"del-done": "bg-del-word-done",
};

/** One rendered run of a line, and the word mark it sits in (-1: none). */
interface Leaf {
	key: string;
	node: ReactNode;
	word: number;
}

const overlaps = (marks: readonly Mark[], from: number, to: number) =>
	marks.some(([f, t]) => f < to && t > from);

/** The word mark (index) a piece of `from`–`to` sits in, else -1. */
const wordAt = (marks: readonly Mark[], from: number, to: number) =>
	marks.findIndex(([f, t]) => f < to && t > from);

/**
 * A text piece's runs: cut by the highlighting tokens (`segments`), a
 * thread's spans and the word marks. A thread's span wins over a word mark
 * where they overlap: that part is the span's alone.
 */
function textLeaves(
	start: number,
	segments: Segment[],
	marks: readonly Mark[],
	words: readonly Mark[],
	out: Leaf[],
): void {
	let at = start;
	for (const segment of segments) {
		const from = at;
		at += segment.text.length;
		const style = segment.token ? tokenStyle(segment.token) : undefined;
		let offset = from;
		for (const part of marks.length
			? cutRanges(segment.text, from, marks)
			: [{ text: segment.text, at: -1 }]) {
			const spanned = part.at >= 0;
			for (const piece of spanned || !words.length
				? [{ text: part.text, at: -1 }]
				: cutRanges(part.text, offset, words)) {
				const key = `t${offset}`;
				offset += piece.text.length;
				out.push({
					key,
					word: piece.at,
					node:
						spanned || style ? (
							<span
								key={key}
								style={style}
								data-span-mark={spanned || undefined}
								className={spanned ? MARKED : undefined}
							>
								{piece.text}
							</span>
						) : (
							piece.text
						),
				});
			}
		}
	}
}

/** A marker, painted as a thread's span when one covers it. */
function markerLeaf(
	piece: Exclude<Piece, { kind: "text" }>,
	marks: readonly Mark[],
	words: readonly Mark[],
): Leaf {
	const key = `${piece.kind}${piece.start}`;
	const end = piece.start + piece.raw.length;
	const spanned = overlaps(marks, piece.start, end);
	return {
		key,
		word: spanned || !piece.raw ? -1 : wordAt(words, piece.start, end),
		node: spanned ? (
			<span key={key} data-span-mark className={MARKED}>
				<Marker piece={piece} />
			</span>
		) : (
			<Marker key={key} piece={piece} />
		),
	};
}

/** Groups each word mark's runs into one tinted element. */
function paintWords(leaves: Leaf[], tone: Words["tone"]): ReactNode[] {
	const out: ReactNode[] = [];
	for (let i = 0; i < leaves.length; ) {
		const leaf = leaves[i] as Leaf;
		if (leaf.word < 0) {
			out.push(leaf.node);
			i++;
			continue;
		}
		const group: ReactNode[] = [];
		let j = i;
		while (j < leaves.length && (leaves[j] as Leaf).word === leaf.word) {
			group.push((leaves[j] as Leaf).node);
			j++;
		}
		out.push(
			<span key={`w${leaf.key}`} data-word="" className={WORD_BG[tone]}>
				{group}
			</span>,
		);
		i = j;
	}
	return out;
}

const NO_MARKS: readonly Mark[] = [];

/**
 * One line of code, highlighted (plain until the highlighting arrives), with
 * its invisible characters shown (Notepad++ style, see invisibles.ts).
 * `newline`: a newline follows the line (false before git's "No newline at
 * end of file"). Copying the line copies the original text. `marks`: a
 * thread's exact characters, painted. `words`: a pair's changed tokens,
 * tinted (background only, under the syntax colors; invisibles inside a
 * mark are tinted with it, a kept emoji selector or joiner there escaped
 * while they show), painted with the first render. The line's text
 * is in one `[data-code]` element holding only its characters (codeSpan.ts
 * reads columns from it).
 */
export function CodeLine(props: {
	text: string;
	lang: string | null;
	tabWidth?: number;
	newline?: boolean;
	marks?: readonly Mark[];
	words?: Words;
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
	const words = props.words?.marks ?? NO_MARKS;
	// A kept emoji selector or joiner inside a word mark shows as its escape.
	const pieces = useMemo(
		() => renderInvisibles(text, tabWidth, { newline, show, marks: words }),
		[text, tabWidth, newline, show, words],
	);
	const segments = useMemo(
		() => colorPieces(pieces, tokens.data ?? []),
		[pieces, tokens.data],
	);
	const marks = props.marks ?? NO_MARKS;
	const highlighted = Boolean(tokens.data?.length);
	const leaves: Leaf[] = [];
	pieces.forEach((piece, i) => {
		if (piece.kind === "text") {
			if (!highlighted && !marks.length && !words.length) {
				leaves.push({ key: `t${piece.start}`, node: piece.raw, word: -1 });
				return;
			}
			textLeaves(
				piece.start,
				highlighted ? (segments[i] ?? []) : [{ text: piece.raw }],
				marks,
				words,
				leaves,
			);
		} else if (piece.kind === "space" && words.length) {
			// A run of spaces cut at the word marks' edges (a changed indent).
			let at = piece.start;
			for (const part of cutRanges(piece.raw, piece.start, words)) {
				leaves.push(
					markerLeaf(
						{ kind: "space", raw: part.text, start: at },
						marks,
						words,
					),
				);
				at += part.text.length;
			}
		} else {
			leaves.push(markerLeaf(piece, marks, words));
		}
	});
	return (
		<span data-code="">
			{props.words && words.length
				? paintWords(leaves, props.words.tone)
				: leaves.map((leaf) => leaf.node)}
		</span>
	);
}
