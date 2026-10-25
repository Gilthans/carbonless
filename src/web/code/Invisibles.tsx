import { useQuery } from "@tanstack/react-query";
import {
	type CSSProperties,
	type ReactNode,
	useEffect,
	useMemo,
	useSyncExternalStore,
} from "react";
import { highlightLine } from "../files/highlight";
import { Tooltip } from "../Tooltip";
import { DEFAULT_TAB_WIDTH, type Piece, renderInvisibles } from "./invisibles";

export const INVISIBLES_STORAGE_KEY = "crb.code.invisibles";

/** The remembered ¶ choice: shown unless turned off (or storage is unavailable). */
export function readShowInvisibles(): boolean {
	try {
		return localStorage.getItem(INVISIBLES_STORAGE_KEY) !== "off";
	} catch {
		return true;
	}
}

let show: boolean | undefined;
const listeners = new Set<() => void>();

/** Every code view shares one ¶ choice, remembered for this viewer. */
export function setShowInvisibles(next: boolean): void {
	show = next;
	try {
		localStorage.setItem(INVISIBLES_STORAGE_KEY, next ? "on" : "off");
	} catch {
		// Storage is a convenience only.
	}
	for (const listener of listeners) listener();
}

/** Forgets the in-memory choice (tests), so the next read is from storage. */
export function resetShowInvisibles(): void {
	show = undefined;
}

export function useShowInvisibles(): boolean {
	return useSyncExternalStore(
		(onChange) => {
			listeners.add(onChange);
			return () => listeners.delete(onChange);
		},
		() => {
			show ??= readShowInvisibles();
			return show;
		},
	);
}

/** The ¶ toggle (Notepad++'s "Show All Characters"). */
export function InvisiblesToggle() {
	const on = useShowInvisibles();
	return (
		<Tooltip content="Show all characters" describe={false}>
			{(trigger) => (
				<button
					type="button"
					{...trigger}
					aria-label="Show all characters"
					aria-pressed={on}
					onClick={() => setShowInvisibles(!on)}
					className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line-strong text-sm font-semibold text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent aria-pressed:bg-accent aria-pressed:text-canvas pointer-coarse:h-10 pointer-coarse:w-10"
				>
					<span aria-hidden>¶</span>
				</button>
			)}
		</Tooltip>
	);
}

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

/** A run of ordinary text, colored by the highlighting tokens it overlaps. */
function TextRun(props: { start: number; segments: Segment[] }) {
	let at = props.start;
	return (
		<>
			{props.segments.map((segment) => {
				const key = at;
				at += segment.text.length;
				return segment.token ? (
					<span key={key} style={tokenStyle(segment.token)}>
						{segment.text}
					</span>
				) : (
					segment.text
				);
			})}
		</>
	);
}

/**
 * One line of code, highlighted (plain until the highlighting arrives), with
 * its invisible characters shown (Notepad++ style, see invisibles.ts).
 * `newline`: a newline follows the line (false before git's "No newline at
 * end of file"). Copying the line copies the original text.
 */
export function CodeLine(props: {
	text: string;
	lang: string | null;
	tabWidth?: number;
	newline?: boolean;
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
	return (
		<>
			{pieces.map((piece, i) =>
				piece.kind === "text" ? (
					tokens.data?.length ? (
						<TextRun
							key={piece.start}
							start={piece.start}
							segments={segments[i] ?? []}
						/>
					) : (
						piece.raw
					)
				) : (
					<Marker key={`${piece.kind}${piece.start}`} piece={piece} />
				),
			)}
		</>
	);
}
